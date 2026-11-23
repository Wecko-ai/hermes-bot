/**
 * Optional per-turn instructions the app reads with the user message (`api_text`), never written
 * into bot profiles. Composed with work modes and caveman / voice notes.
 */

export const BACKGROUND_TASK_NOTE = `[HermesBot turn style: background task. For this turn only, give the user the feeling of a background job: reply once right away in a single short sentence that acknowledges the request and says you are on it (warm, concise, in the user's language). Then, at meaningful milestones while you work, add brief progress updates in the chat (one short sentence each: what you are doing now or what just finished). Finish with the full result when the work is done. Progress lines stay short; the final answer can be as complete as needed. Do not repeat the initial acknowledgement in the final message.]`

export const TONE_CHARTER_NOTE = `[HermesBot tone: warm and concise. For this turn only, keep a friendly, respectful tone: clear and direct, no filler, no performative enthusiasm. Match the user's language. Only your chat replies change; files, code, emails, posts and messages to others stay normal.]`

export interface TurnStyleOptions {
  backgroundTask: boolean
  toneCharter: boolean
}

/** Appends enabled style notes after the mode / caveman / voice text. */
export function turnStyleNotes(modeText: string | undefined, baseText: string, options: TurnStyleOptions) {
  let text = modeText ?? baseText
  if (options.backgroundTask) text = `${text}\n\n${BACKGROUND_TASK_NOTE}`
  if (options.toneCharter) text = `${text}\n\n${TONE_CHARTER_NOTE}`
  return text
}