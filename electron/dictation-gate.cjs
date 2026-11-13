// Who may turn the microphone on for dictation.
//
// Threat model: the window shows whatever page http://127.0.0.1:4330 serves. When this process started that
// server, the page is ours. In client mode it is not: another process holds the port (on a shared Mac, a copy of
// the app under another macOS account, such as the one the bots run under), and anything running under that
// account could serve its own page there. Who serves the port cannot be proven from here, so such a page must
// never be able to listen to the room on its own, and never for long. The main process decides, never the page:
// - a session follows a deliberate gesture of the user in this window, as the system reports it (a page cannot
//   fake it): a mouse press, or Enter pressed once (it also activates a focused button). Ordinary typing never
//   counts, Space included: it is typed between every two words;
// - `prepare` must come within GESTURE_MS of that gesture, and `start` is only the follow-up of one accepted
//   `prepare`, once, within START_WINDOW_MS after it resolved;
// - the window must be focused and visible to start, and the microphone closes when it no longer is (main.cjs);
// - client mode: the user agrees in a native dialog of this process, for this launch only (nothing is kept on
//   disk); at most one start every CLIENT_START_INTERVAL_MS, and sessions of CLIENT_MAX_LISTEN_MS at most;
// - in every mode, while the microphone is open the main process shows a mark on the app's Dock icon, which the
//   page cannot hide (dictation.cjs `onMicrophone`, main.cjs); macOS's own microphone indicator is the other sign.
const GESTURE_MS = 2_000
const START_WINDOW_MS = 10_000
const MAX_LISTEN_MS = 120_000
const CLIENT_MAX_LISTEN_MS = 60_000
const CLIENT_START_INTERVAL_MS = 5_000

/** A mouse press, or Enter pressed once (not held), as `before-mouse-event` and `before-input-event` give them. */
function isGesture(input) {
  if (!input || typeof input !== 'object') return false
  if (input.type === 'mouseDown') return true
  return input.type === 'keyDown' && input.isAutoRepeat !== true && input.key === 'Enter'
}

/** - clientMode: the page comes from a server this process did not start. */
function createDictationGate({ clientMode = false, now = Date.now } = {}) {
  let lastGesture = Number.NEGATIVE_INFINITY
  let lastStart = Number.NEGATIVE_INFINITY
  let startUntil = 0
  // Client mode: 'granted' or 'denied' once asked, for this launch only.
  let consent

  return {
    /** Input of the window, from the system. Only a deliberate gesture counts. */
    noteInput(input) { if (isGesture(input)) lastGesture = now() },
    /** A `prepare` may go on: it follows a gesture closely enough. */
    mayPrepare() { return now() - lastGesture <= GESTURE_MS },
    /** Client mode, and the user was not asked yet in this launch. */
    needsConsent() { return clientMode && consent === undefined },
    /** Client mode, and the user refused in this launch. */
    refused() { return clientMode && consent === 'denied' },
    setConsent(value) { consent = value === 'granted' ? 'granted' : 'denied' },
    /** After a `prepare` that ended with access granted: one `start` may follow, shortly. */
    armStart() { startUntil = now() + START_WINDOW_MS },
    disarm() { startUntil = 0 },
    /** Whether this `start` follows an accepted `prepare`, window in front, not too soon. Uses up the right. */
    takeStart({ focused, visible }) {
      const time = now()
      const paced = !clientMode || time - lastStart >= CLIENT_START_INTERVAL_MS
      const allowed = startUntil > 0 && time <= startUntil && focused === true && visible === true && paced
      startUntil = 0
      if (allowed) lastStart = time
      return allowed
    },
    /** The longest session this mode allows, whatever the page asks. */
    maxListenMs() { return clientMode ? CLIENT_MAX_LISTEN_MS : MAX_LISTEN_MS },
  }
}

module.exports = { createDictationGate, isGesture, GESTURE_MS, START_WINDOW_MS, MAX_LISTEN_MS, CLIENT_MAX_LISTEN_MS, CLIENT_START_INTERVAL_MS }
