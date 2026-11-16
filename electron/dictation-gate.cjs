// Who may turn the microphone on for dictation.
//
// The main process decides, never the page:
// - a session follows one deliberate gesture in this window, as the system reports it (a page cannot
//   fake it): a mouse press, or Enter pressed once (it also activates a focused button). Ordinary
//   typing never counts, Space included: it is typed between every two words;
// - that gesture authorizes exactly one `prepare`, and only within GESTURE_MS. `mayPrepare` consumes
//   it and returns a token. A blur, hide, or minimize (`disarm`) invalidates a prepare still in
//   flight. `armStart` succeeds only while that token's generation is still current;
// - `start` is only the follow-up of one armed `prepare`, once, within START_WINDOW_MS, and only
//   while the window is focused and visible (main.cjs);
// - a session lasts at most two minutes;
// - while the microphone is open the main process shows a mark on the app's Dock icon, which the
//   page cannot hide (dictation.cjs `onMicrophone`, main.cjs). macOS's own indicator is the other sign.
const GESTURE_MS = 2_000
const START_WINDOW_MS = 10_000
const MAX_LISTEN_MS = 120_000

/** A mouse press, or Enter pressed once (not held), as `before-mouse-event` and `before-input-event` give them. */
function isGesture(input) {
  if (!input || typeof input !== 'object') return false
  if (input.type === 'mouseDown') return true
  return input.type === 'keyDown' && input.isAutoRepeat !== true && input.key === 'Enter'
}

function createDictationGate({ now = Date.now } = {}) {
  let generation = 0
  // Generation of the gesture `mayPrepare` has consumed and `armStart` may still use. 0: none.
  let issuedGeneration = 0
  let gesture = null
  let startUntil = 0

  return {
    /** Input of the window, from the system. Only a deliberate gesture counts, and it replaces the last one. */
    noteInput(input) {
      if (!isGesture(input)) return
      generation += 1
      issuedGeneration = 0
      gesture = { at: now(), generation }
    },
    /**
     * Consume the current gesture. Returns a token for this prepare, or null when there is no
     * fresh gesture. A second call needs a new gesture.
     */
    mayPrepare() {
      if (!gesture || gesture.generation !== generation) return null
      if (now() - gesture.at > GESTURE_MS) {
        gesture = null
        return null
      }
      const token = Object.freeze({ generation })
      gesture = null
      issuedGeneration = generation
      startUntil = 0
      return token
    },
    /**
     * After a `prepare` that ended with access granted, and only if `token` is still the one
     * `mayPrepare` issued. One `start` may follow, shortly.
     */
    armStart(token) {
      if (!token || token.generation !== generation || token.generation !== issuedGeneration) return false
      issuedGeneration = 0
      startUntil = now() + START_WINDOW_MS
      return true
    },
    /** The window left the foreground, or the page went away: a prepare in flight must not arm. */
    disarm() {
      generation += 1
      gesture = null
      issuedGeneration = 0
      startUntil = 0
    },
    /** Whether this `start` follows an armed `prepare`, window in front. Uses up the right. */
    takeStart({ focused, visible }) {
      const time = now()
      const allowed = startUntil > 0 && time <= startUntil && focused === true && visible === true
      startUntil = 0
      return allowed
    },
    /** The longest session, whatever the page asks. */
    maxListenMs() { return MAX_LISTEN_MS },
  }
}

module.exports = { createDictationGate, isGesture, GESTURE_MS, START_WINDOW_MS, MAX_LISTEN_MS }
