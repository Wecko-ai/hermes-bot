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
// - voice mode, hands-free (a bounded exception, 2026-11-18): one gesture may instead
//   open a conversation (`openConversation`). For CONVERSATION_MS after it, the microphone may be armed
//   again without a new gesture (`mayRelisten`), one listen at a time, only while the window is focused
//   and visible. Any blur, hide, minimize or navigation (`disarm`) ends the conversation, and so does
//   `closeConversation`. A new gesture opens a fresh one. The page cannot loop the microphone on its own:
//   after the first listen, each new one needs a reply spoken by the native voice in between
//   (`noteSpeechEnd`, from speech.cjs), at most MAX_RELISTENS per conversation, never while a listen
//   runs, and each lasts RELISTEN_MAX_LISTEN_MS at most;
// - while the microphone is open the main process shows a mark on the app's Dock icon, which the
//   page cannot hide (dictation.cjs `onMicrophone`, main.cjs). macOS's own indicator is the other sign.
const GESTURE_MS = 2_000
const START_WINDOW_MS = 10_000
const MAX_LISTEN_MS = 120_000
const CONVERSATION_MS = 10 * 60_000
const RELISTEN_MAX_LISTEN_MS = 30_000
const MAX_RELISTENS = 30

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
  // Hands-free voice conversation: until when the microphone may be armed again without a gesture,
  // whether a reply was spoken since the last listen, and how many listens it gave.
  let conversationUntil = 0
  let speechCredit = false
  let relistens = 0
  // Longest listen for the start that `armStart` armed, then for the one `takeStart` let through.
  let armedLimit = MAX_LISTEN_MS
  let startLimit = MAX_LISTEN_MS

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
      armedLimit = token.relisten === true ? RELISTEN_MAX_LISTEN_MS : MAX_LISTEN_MS
      return true
    },
    /**
     * Consume the current gesture to open a hands-free conversation (voice mode). Returns its end time,
     * or 0 when there is no fresh gesture. The gesture can no longer authorize a `prepare`.
     */
    openConversation() {
      if (!gesture || gesture.generation !== generation) return 0
      if (now() - gesture.at > GESTURE_MS) {
        gesture = null
        return 0
      }
      gesture = null
      conversationUntil = now() + CONVERSATION_MS
      // The first listen of a conversation follows the click itself.
      speechCredit = true
      relistens = 0
      return conversationUntil
    },
    closeConversation() {
      conversationUntil = 0
      speechCredit = false
    },
    /** The native voice finished (or failed) an utterance: the next hands-free listen may follow. */
    noteSpeechEnd() {
      if (conversationUntil) speechCredit = true
    },
    /**
     * In an open conversation, window in front: a token for one `prepare` without a gesture, armed by
     * `armStart` like the gesture's. Null when the conversation is over or the window is not in front.
     */
    mayRelisten({ focused, visible, listening = false }) {
      if (!conversationUntil) return null
      if (now() > conversationUntil) {
        conversationUntil = 0
        return null
      }
      if (focused !== true || visible !== true || listening) return null
      if (!speechCredit || relistens >= MAX_RELISTENS) return null
      speechCredit = false
      relistens += 1
      issuedGeneration = generation
      startUntil = 0
      return Object.freeze({ generation, relisten: true })
    },
    /** The window left the foreground, or the page went away: a prepare in flight must not arm. */
    disarm() {
      generation += 1
      gesture = null
      issuedGeneration = 0
      startUntil = 0
      conversationUntil = 0
      speechCredit = false
    },
    /** Whether this `start` follows an armed `prepare`, window in front. Uses up the right. */
    takeStart({ focused, visible }) {
      const time = now()
      const allowed = startUntil > 0 && time <= startUntil && focused === true && visible === true
      startUntil = 0
      startLimit = allowed ? armedLimit : MAX_LISTEN_MS
      armedLimit = MAX_LISTEN_MS
      return allowed
    },
    /** The longest session for the start `takeStart` just allowed, whatever the page asks. */
    maxListenMs() { return startLimit },
  }
}

module.exports = { createDictationGate, isGesture, GESTURE_MS, START_WINDOW_MS, MAX_LISTEN_MS, CONVERSATION_MS, RELISTEN_MAX_LISTEN_MS, MAX_RELISTENS }
