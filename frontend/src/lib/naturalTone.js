/**
 * Whether the person asked for the natural voice ("Naturalise tone"). One shared switch, because the Ask box and every step's
 * Listen button have their own speech controller and must all sound the same.
 *
 * Only the on/off choice is remembered, not a voice name: voices differ between browsers and computers, so each time the page
 * loads the voice is looked up again, and if this browser has none the page just stays on the standard voice.
 */
const KEY = 'vb.naturalTone';
const listeners = new Set();

function read() {
  try {
    return localStorage.getItem(KEY) === 'on';
  } catch {
    return false; // storage can be missing or blocked (private window): the choice is then simply not remembered
  }
}

let on = read();

export const naturalTone = {
  get: () => on,
  set(next) {
    if (next === on) return;
    on = next;
    try {
      localStorage.setItem(KEY, next ? 'on' : 'off');
    } catch {
      /* a blocked store only means the choice is not remembered */
    }
    listeners.forEach((l) => l());
  },
  subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
