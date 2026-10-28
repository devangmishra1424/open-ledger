import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Mic, Send, Sparkles, Square, Volume2 } from 'lucide-react';
import { api } from '../../services/api';
import { Banner, Spinner } from '../ui';
import Narrative from './Narrative';
import { useSpeech } from '../../lib/useSpeech';
import { buildSpokenAnswer } from '../../lib/speech';
import { groundingNote } from '../../lib/labels';

const PREF_KEY = 'vb.readAnswersAloud';
const MAX_QUESTION = 300;
const ANSWER_ID = 'ask-answer';
const TONE_SAMPLE_ID = 'tone-sample';
const NO_NATURAL_VOICE = 'Sorry, not available: this browser has no natural-sounding voice. Microsoft Edge usually has them.';
// Questions the recorded decisions can actually answer for each kind of invoice (each was tried against real invoices).
const APPROVED_EXAMPLES = ['Why was this approved?', 'Was anything flagged along the way?', 'Which checks did it pass?'];
const EXAMPLES = {
  needs_attention: ['Why is this invoice held?', 'Which step flagged the problem?', 'What would make it clear on its own?'],
  approved: APPROVED_EXAMPLES,
  paid: APPROVED_EXAMPLES,
  rejected: ['Why was this rejected?', 'Which step flagged the problem?'],
};
const DEFAULT_EXAMPLES = ['Why is this invoice in its current state?', 'Which step flagged the problem?'];

// Browser storage can be missing or blocked (private windows, site data off). The switch then simply is not remembered.
function readPref() {
  try {
    return localStorage.getItem(PREF_KEY) === 'on';
  } catch {
    return false;
  }
}
function writePref(on) {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch {
    /* a blocked store only means the choice is not remembered */
  }
}

/** Read an answer aloud, or stop reading it. Shown only where the browser can speak. */
export function ListenButton({ speech, id, text }) {
  if (!speech.supportsSpeaking) return null;
  const playing = speech.speakingId === id;
  return (
    <button type="button" className="vb-btn vb-btn-sm" aria-pressed={playing} onClick={() => (playing ? speech.stopSpeaking() : speech.speak(id, text))}>
      {playing ? <><Square size={13} aria-hidden="true" /> Stop</> : <><Volume2 size={14} aria-hidden="true" /> Listen</>}
    </button>
  );
}

/**
 * Ask a question about this invoice by typing or by voice, and hear the answer. It uses the existing explain endpoint, so the
 * answer comes from the same recorded decisions as the "Why did it conclude this?" buttons, with the same grounding note.
 * Voice only reads: nothing here can approve, reject, pay or change anything. See lib/speech.ts for how listening and speaking
 * are handled, including what happens when the browser cannot do either.
 */
export default function AskVoice({ invoice }) {
  const speech = useSpeech();
  const reasonNames = useMemo(() => invoice.reasonNames ?? {}, [invoice.reasonNames]);
  const [question, setQuestion] = useState('');
  const [asked, setAsked] = useState(null);
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState(null);
  const [readAll, setReadAll] = useState(readPref);
  const [toneChecking, setToneChecking] = useState(false);
  const [toneUnavailable, setToneUnavailable] = useState(false);
  const busyRef = useRef(false);
  const seq = useRef(0);
  const alive = useRef(true);
  const { speak, stopSpeaking, supportsSpeaking } = speech;

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const run = useCallback(async (text, viaVoice) => {
    const q = text.trim().slice(0, MAX_QUESTION);
    if (!q || busyRef.current) return;
    busyRef.current = true;
    const mine = ++seq.current;
    stopSpeaking();
    setBusy(true);
    setRequestError(null);
    setQuestion(q);
    try {
      const res = await api.explainInvoice(invoice.id, q);
      if (!alive.current || mine !== seq.current) return;
      const answer = { question: q, viaVoice, answer: res.answer || '', grounded: Boolean(res.grounded), citedDecisionIds: res.citedDecisionIds ?? [] };
      setAsked(answer);
      if ((viaVoice || readAll) && supportsSpeaking) speak(ANSWER_ID, buildSpokenAnswer(answer, { reasonNames }));
    } catch (e) {
      if (!alive.current || mine !== seq.current) return;
      setRequestError(e.message);
      // someone using only their voice must not be left waiting in silence
      if (viaVoice && supportsSpeaking) speak(ANSWER_ID, 'Sorry, I could not get an answer just now. The reason is on the screen.');
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy(false);
    }
  }, [invoice.id, readAll, reasonNames, speak, stopSpeaking, supportsSpeaking]);

  const onMic = () => {
    if (speech.listening) speech.stopListening();
    else if (!busy) speech.startListening((text) => run(text, true));
  };

  const onSubmit = (e) => {
    e.preventDefault();
    if (speech.listening) return;
    run(question, false);
  };

  // "Naturalise tone": look for a natural voice in this browser; if there is one, switch to it and say a short sample, else say so.
  const onNaturalise = async () => {
    setToneChecking(true);
    setToneUnavailable(false);
    const result = await speech.naturalise();
    if (!alive.current) return;
    setToneChecking(false);
    if (result.ok) speak(TONE_SAMPLE_ID, 'This is the natural tone.');
    else setToneUnavailable(true);
  };

  const onStandardTone = () => {
    setToneUnavailable(false);
    speech.standardise();
  };

  const toggleReadAll = (on) => {
    setReadAll(on);
    writePref(on);
  };

  const shown = speech.listening ? speech.interim : question;
  // By recording (browsers without their own speech recognition) nothing can tell when the person stops, so they press stop.
  const listeningStatus = speech.listensByRecording
    ? (speech.interim ? 'Sending the recording to be turned into text…' : 'Recording… speak your question, then press the stop button.')
    : 'Listening… speak your question, then pause.';
  const status = speech.listening ? listeningStatus
    : busy ? 'Looking through the recorded decisions…'
      : speech.speakingId === ANSWER_ID ? 'Reading the answer aloud.'
        : '';

  return (
    <div className="vb-ask">
      <form className="vb-ask-row" onSubmit={onSubmit}>
        {speech.supportsListening && (
          <button
            type="button"
            className={`vb-btn vb-ask-mic${speech.listening ? ' vb-ask-mic-on' : ''}`}
            onClick={onMic}
            disabled={busy && !speech.listening}
            aria-pressed={speech.listening}
            aria-label={speech.listening ? 'Stop listening' : 'Ask by voice'}
            title={speech.listening ? 'Stop listening' : 'Ask by voice'}
          >
            {speech.listening ? <Square size={16} aria-hidden="true" /> : <Mic size={18} aria-hidden="true" />}
          </button>
        )}
        <input
          className="vb-input vb-ask-input"
          type="text"
          value={shown}
          onChange={(e) => setQuestion(e.target.value)}
          readOnly={speech.listening}
          maxLength={MAX_QUESTION}
          placeholder={speech.listening ? 'Listening…' : 'Ask anything about this invoice'}
          aria-label="Your question about this invoice"
          autoComplete="off"
        />
        <button type="submit" className="vb-btn vb-btn-primary" disabled={busy || speech.listening || !question.trim()}>
          <Send size={14} aria-hidden="true" /> Ask
        </button>
      </form>

      <div className="vb-ask-chips" aria-label="Example questions">
        {(EXAMPLES[invoice.state] ?? DEFAULT_EXAMPLES).map((ex) => (
          <button key={ex} type="button" className="vb-ask-chip" disabled={busy || speech.listening} onClick={() => run(ex, false)}>{ex}</button>
        ))}
      </div>

      <div className="vb-ask-status" role="status" aria-live="polite">
        {busy ? <Spinner label={status} /> : status}
      </div>
      {speech.error && <p className="vb-ask-err" role="alert">{speech.error}</p>}
      {requestError && (
        <Banner kind="error">Could not get an answer: {requestError}</Banner>
      )}

      {asked && (
        <div className="vb-explain vb-ask-answer" role="note" aria-label="Answer">
          <div className="vb-explain-label">{asked.viaVoice ? 'You asked (as heard)' : 'You asked'}</div>
          <p className="vb-ask-q">{asked.question}</p>
          <div className="vb-explain-label">Answer</div>
          <Narrative text={asked.answer || 'No explanation was returned.'} reasonNames={reasonNames} />
          <div className="vb-dim vb-small" style={{ marginTop: 6 }}>{groundingNote(asked)}</div>
          <div className="vb-ask-actions">
            <ListenButton speech={speech} id={ANSWER_ID} text={buildSpokenAnswer(asked, { reasonNames })} />
          </div>
        </div>
      )}

      <div className="vb-ask-foot">
        {speech.supportsSpeaking && (
          <div className="vb-ask-tone">
            <button type="button" className="vb-btn vb-btn-sm" onClick={speech.naturalOn ? onStandardTone : onNaturalise} disabled={toneChecking}>
              <Sparkles size={14} aria-hidden="true" /> {toneChecking ? 'Checking…' : speech.naturalOn ? 'Back to standard tone' : 'Naturalise tone'}
            </button>
            <span className="vb-ask-tone-note" role="status" aria-live="polite">
              {toneUnavailable ? NO_NATURAL_VOICE : speech.naturalOn ? `Natural tone on${speech.voiceName ? `: ${speech.voiceName}` : ''}.` : ''}
            </span>
          </div>
        )}
        {speech.supportsSpeaking && (
          <label className="vb-ask-toggle">
            <input type="checkbox" checked={readAll} onChange={(e) => toggleReadAll(e.target.checked)} />
            Read every answer aloud (answers to spoken questions are always read)
          </label>
        )}
        <p className="vb-field-hint">
          {speech.supportsListening
            ? "Voice input: your browser sends the recording to its own speech service to turn it into text (Chrome and Edge do this). Voice only asks and reads; it can't approve, reject or pay anything."
            : "Voice input isn't available in this browser; it works in Chrome or Edge over https or localhost. Typing works everywhere."}
          {!speech.supportsSpeaking && ' This browser also has no voice to read answers aloud.'}
        </p>
      </div>
    </div>
  );
}
