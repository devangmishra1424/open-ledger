import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createSpeechController, pickNaturalVoice } from './speech';
import { createRecordedRecognition } from './recordedRecognition';
import { naturalTone } from './naturalTone';
import { api } from '../services/api';

/** What this browser provides. Read once, when the hook first runs; the page is client-only so `window` always exists. */
function detectEnvironment() {
  const w = window;
  // Recognition needs a secure page (https or localhost); on plain http Chrome would only report a misleading "blocked".
  const recognitionCtor = w.isSecureContext === false ? null : (w.SpeechRecognition || w.webkitSpeechRecognition || null);
  return {
    recognitionCtor,
    synth: w.speechSynthesis || null,
    utteranceCtor: w.SpeechSynthesisUtterance || null,
  };
}

const PREFERRED_LANG = 'en-IN';

/** Can this browser record the microphone? (Needs a secure page, like recognition does.) */
function canRecord() {
  return window.isSecureContext !== false && typeof window.MediaRecorder === 'function' && Boolean(navigator.mediaDevices?.getUserMedia);
}

/** The recorded-audio recogniser (recordedRecognition.ts) wired to this browser and to the server's transcription. */
function recordedRecognitionCtor() {
  return createRecordedRecognition({
    getUserMedia: () => navigator.mediaDevices.getUserMedia({ audio: true }),
    createRecorder: (stream) => new window.MediaRecorder(stream),
    makeBlob: (parts, type) => new Blob(parts, { type }),
    transcribe: (recording) => api.transcribeRecording(recording),
  });
}

/**
 * The browser's speech objects, wired to React state. All the behaviour (and its failure handling) lives in speech.ts, which is
 * tested with fakes; this file only hands it the real `window` objects and mirrors its state into the page.
 *
 * The controller is created in an effect and destroyed in its cleanup, so leaving the page (or React's double-mount in
 * development) cancels any speech and releases the microphone.
 */
export function useSpeech() {
  const [native] = useState(detectEnvironment);
  // A browser with no speech recognition of its own (Firefox, most of Safari) can still listen by recording, when the server
  // has a voice service to turn the recording into text. The page asks once; on any failure the microphone is simply not
  // offered and typing works as before.
  const [recorded, setRecorded] = useState(null);
  useEffect(() => {
    if (native.recognitionCtor || !canRecord()) return undefined;
    let cancelled = false;
    api.voiceStatus().then(
      (status) => { if (!cancelled && status?.enabled) setRecorded(() => recordedRecognitionCtor()); },
      (e) => console.warn(`voice: could not ask the server whether recording is available (${e.message}); typing only`),
    );
    return () => { cancelled = true; };
  }, [native]);
  const env = useMemo(() => ({ ...native, recognitionCtor: native.recognitionCtor || recorded }), [native, recorded]);
  const controllerRef = useRef(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [speakingId, setSpeakingId] = useState(null);
  const [error, setError] = useState(null);
  const naturalOn = useSyncExternalStore(naturalTone.subscribe, naturalTone.get);
  const [voiceName, setVoiceName] = useState(null);

  useEffect(() => {
    const controller = createSpeechController(env);
    controllerRef.current = controller;
    return () => {
      controller.destroy();
      controllerRef.current = null;
    };
  }, [env]);

  // Keep this controller's voice in step with the shared switch. When it is on, the voice is looked up again here: a remembered
  // "on" from another browser or computer may have no natural voice to use, and then this quietly stays on the standard voice.
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return undefined;
    if (!naturalOn) {
      controller.setVoice(null);
      return undefined;
    }
    let cancelled = false;
    controller.loadVoices().then((voices) => {
      if (cancelled) return;
      const voice = pickNaturalVoice(voices, PREFERRED_LANG);
      controller.setVoice(voice);
      setVoiceName(voice ? voice.name : null);
      if (!voice) naturalTone.set(false);
    });
    return () => { cancelled = true; };
  }, [naturalOn, env]);

  /** Listen for one question. `onQuestion(text)` is called once with what was heard. */
  const startListening = useCallback((onQuestion) => {
    const c = controllerRef.current;
    if (!c || c.isListening()) return false; // a second press must not disturb the session that is already listening
    setError(null);
    setInterim('');
    setListening(true);
    const started = c.listen({
      onInterim: setInterim,
      onFinal: (text) => onQuestion?.(text),
      onError: (e) => setError(e.message),
      onEnd: () => { setListening(false); setInterim(''); },
    });
    if (!started) setListening(c.isListening());
    return started;
  }, []);

  const stopListening = useCallback(() => controllerRef.current?.stopListening(), []);

  /** Read `text` aloud, marking `id` as the thing being read until it ends, is stopped, or fails. */
  const speak = useCallback((id, text) => {
    const c = controllerRef.current;
    if (!c) return false;
    setError(null);
    setSpeakingId(id);
    return c.speak(text, {
      onError: (e) => setError(e.message),
      // the natural voice never started: the standard voice carries on, and the switch goes back off so nothing is left claiming otherwise
      onVoiceFallback: () => {
        naturalTone.set(false);
        setError('The natural voice did not start, so the standard voice was used.');
      },
      // functional update: a superseded request finishing late must not clear a newer one's marker
      onEnd: () => setSpeakingId((current) => (current === id ? null : current)),
    });
  }, []);

  const stopSpeaking = useCallback(() => controllerRef.current?.stopSpeaking(), []);

  /**
   * "Naturalise tone": look for a natural voice in this browser. Resolves { ok: true, voiceName } after switching to it, or
   * { ok: false, reason } ('unsupported' when the browser cannot speak at all, 'none' when it has no natural voice).
   */
  const naturalise = useCallback(async () => {
    const c = controllerRef.current;
    if (!c || !c.supportsSpeaking) return { ok: false, reason: 'unsupported' };
    const voice = pickNaturalVoice(await c.loadVoices(), PREFERRED_LANG);
    if (!voice) return { ok: false, reason: 'none' };
    c.setVoice(voice);
    setVoiceName(voice.name);
    naturalTone.set(true);
    return { ok: true, voiceName: voice.name };
  }, []);

  /** Back to the browser's standard voice. */
  const standardise = useCallback(() => naturalTone.set(false), []);

  return {
    supportsListening: typeof env.recognitionCtor === 'function',
    /** True when listening is by recording (the person presses the microphone again to finish), not by the browser. */
    listensByRecording: !native.recognitionCtor && typeof recorded === 'function',
    supportsSpeaking: Boolean(env.synth) && typeof env.utteranceCtor === 'function',
    listening,
    interim,
    speakingId,
    error,
    naturalOn,
    voiceName: naturalOn ? voiceName : null,
    startListening,
    stopListening,
    speak,
    stopSpeaking,
    naturalise,
    standardise,
  };
}
