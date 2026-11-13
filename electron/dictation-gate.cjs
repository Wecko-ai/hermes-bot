// Who may turn the microphone on for dictation.
//
// Threat model: the window shows whatever page http://127.0.0.1:4330 serves. When this process started that
// server, the page is ours. In client mode it is not: another process holds the port (on a shared Mac, a copy of
// the app under another macOS account, such as the one the bots run under), and anything running under that
// account could serve its own page there. Such a page must never be able to listen to the room. So the main
// process decides, never the page:
// - a session follows a real gesture of the user in this window (a mouse or key press that the main process sees
//   come from the system, which a page cannot fake), through `prepare` within GESTURE_MS of it;
// - `start` is only the follow-up of one accepted `prepare`, once, within START_WINDOW_MS after it resolved;
// - the window must be focused and visible to start, and the microphone closes when it no longer is (main.cjs);
// - in client mode, the user agrees once, in a native dialog of this process, that the window may use the
//   microphone; the agreement is kept in this process's own data folder, out of the other account's reach.
const GESTURE_MS = 2_000
const START_WINDOW_MS = 10_000

/**
 * - clientMode: the page comes from a server this process did not start.
 * - consent: 'granted' when the user already agreed (read from this process's data folder), else undefined.
 */
function createDictationGate({ clientMode = false, consent: initialConsent, now = Date.now } = {}) {
  let lastGesture = Number.NEGATIVE_INFINITY
  let startUntil = 0
  // 'granted' (kept on disk), 'denied' (this launch only), or undefined (not asked yet).
  let consent = initialConsent === 'granted' ? 'granted' : undefined

  return {
    /** A mouse or key press from the system in this window. */
    noteGesture() { lastGesture = now() },
    /** A `prepare` may go on: it follows a gesture closely enough. */
    mayPrepare() { return now() - lastGesture <= GESTURE_MS },
    /** Client mode, and the user was not asked yet. */
    needsConsent() { return clientMode && consent === undefined },
    /** Client mode, and the user refused during this launch. */
    refused() { return clientMode && consent === 'denied' },
    setConsent(value) { consent = value === 'granted' ? 'granted' : 'denied' },
    /** After a `prepare` that ended with access granted: one `start` may follow, shortly. */
    armStart() { startUntil = now() + START_WINDOW_MS },
    disarm() { startUntil = 0 },
    /** Whether this `start` follows an accepted `prepare`, window in front. Uses up the right either way. */
    takeStart({ focused, visible }) {
      const allowed = startUntil > 0 && now() <= startUntil && focused === true && visible === true
      startUntil = 0
      return allowed
    },
  }
}

module.exports = { createDictationGate, GESTURE_MS, START_WINDOW_MS }
