// Turns a bot reply (markdown) into what a voice can read aloud, and understands short spoken answers.
// Pure functions, no DOM. Code, tables, links and media stay on screen: the voice only says a short pointer to them.

import { isSilentMessage, withoutSilentMarkers } from './hermes'

export type SpokenLanguage = 'fr' | 'en'

export interface SpokenText {
  text: string
  sentences: string[]
  truncated: boolean
}

const CODE_PHRASE: Record<SpokenLanguage, string> = { fr: "(code à l'écran)", en: '(code on screen)' }
const TABLE_PHRASE: Record<SpokenLanguage, string> = { fr: '(tableau à l\'écran)', en: '(table on screen)' }
const REST_PHRASE: Record<SpokenLanguage, string> = { fr: 'Le reste est à l\'écran.', en: 'The rest is on screen.' }

const MAX_SENTENCE = 280
const MIN_SENTENCE = 12
const INLINE_CODE_MAX = 40

// ---------------------------------------------------------------------------------------------------------------------
// Sentence splitting

// Words (lowercase, without the final period) after which a period does not end a sentence.
const ABBREVIATIONS = new Set([
  'm', 'mm', 'mme', 'mmes', 'mlle', 'mlles', 'dr', 'pr', 'prof', 'mr', 'mrs', 'ms', 'st', 'sr', 'jr', 'etc', 'e.g', 'i.e', 'cf', 'vs', 'env', 'approx', 'no', 'fig', 'ex', 'p. ex', 'c.-à-d', 'c-à-d',
])

/** True when the period that ends `before` belongs to an abbreviation or an initial. */
function isAbbreviation(before: string) {
  const match = /([\p{L}][\p{L}.\-]*)$/u.exec(before)
  if (!match) return false
  const word = match[1].toLowerCase()
  if (ABBREVIATIONS.has(word)) return true
  // A single letter (initial, "p." of "p. ex.") or dotted letters ("U.S").
  if (/^\p{L}$/u.test(word)) return true
  if (/^(?:\p{L}\.)+\p{L}$/u.test(word)) return true
  return false
}

function splitLine(line: string): string[] {
  const pieces: string[] = []
  const terminators = /([.!?…]+)(["'”’»)\]]*)(?=\s|$)/gu
  let start = 0
  let match: RegExpExecArray | null
  while ((match = terminators.exec(line))) {
    const end = match.index + match[0].length
    const rest = line.slice(end)
    const next = rest.trimStart()
    if (next && !/^[\p{Lu}"'“«¿¡(\d]/u.test(next)) continue
    if (match[1] === '.' && isAbbreviation(line.slice(start, match.index))) continue
    pieces.push(line.slice(start, end))
    start = end
  }
  pieces.push(line.slice(start))
  return pieces.map((piece) => piece.trim()).filter(Boolean)
}

/** Cuts a sentence longer than MAX_SENTENCE at the last `;`, `,` or ` — ` before the limit (else at a space). */
function cutLong(sentence: string): string[] {
  const out: string[] = []
  let rest = sentence
  while (rest.length > MAX_SENTENCE) {
    const window = rest.slice(0, MAX_SENTENCE)
    const cuts = [window.lastIndexOf(';') + 1, window.lastIndexOf(',') + 1, window.lastIndexOf(' — ') + 2]
    let at = Math.max(...cuts)
    if (at < MIN_SENTENCE) at = window.lastIndexOf(' ') + 1
    if (at < MIN_SENTENCE) at = MAX_SENTENCE
    out.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) out.push(rest)
  return out
}

export function splitSentences(text: string): string[] {
  const raw = text.split(/\r?\n/).flatMap((line) => splitLine(line.replace(/[ \t]+/g, ' ').trim()))
  // Fragments that are too short ("Oui.") join the next sentence; a short last one joins the previous.
  const merged: string[] = []
  let carry = ''
  for (const piece of raw) {
    const current = carry ? `${carry} ${piece}` : piece
    if (current.length < MIN_SENTENCE) carry = current
    else {
      merged.push(current)
      carry = ''
    }
  }
  if (carry) {
    if (merged.length) merged[merged.length - 1] = `${merged[merged.length - 1]} ${carry}`
    else merged.push(carry)
  }
  return merged.flatMap(cutLong)
}

// ---------------------------------------------------------------------------------------------------------------------
// Markdown to speech

const FENCE = /^\s*(```|~~~)/
const TABLE_ROW = /^\s*\|.*\|\s*$|^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/
const LIST_ITEM = /^\s*(?:[-*+•]|\d{1,3}[.)])\s+/
const HEADING = /^\s{0,3}#{1,6}\s+/

function cleanInline(text: string): string {
  let out = text
  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  out = out.replace(/<[^>\n]+>/g, ' ')
  out = out.replace(/\bMEDIA:\S+/g, ' ')
  out = out.replace(/\bmailto:\S+/gi, ' ')
  out = out.replace(/\b(?:https?|ftp):\/\/\S+|\bwww\.\S+/gi, ' ')
  out = out.replace(/`([^`\n]*)`/g, (_all, code: string) => (code.trim().length <= INLINE_CODE_MAX ? code.trim() : ' '))
  out = out.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1')
  out = out.replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, '$1$2').replace(/(^|[^\w])_([^_\n]+)_(?![\w])/g, '$1$2')
  out = out.replace(/~~([^~]+)~~/g, '$1')
  out = out.replace(/[\p{Extended_Pictographic}︎️‍]/gu, '')
  return out.replace(/\s+/g, ' ').trim()
}

const withPeriod = (text: string) => (/[.!?…:;]["'”»)]*$/u.test(text) ? text : `${text}.`)

export function toSpokenText(markdown: string, options: { language: SpokenLanguage; maxSentences?: number }): SpokenText {
  const { language, maxSentences = 6 } = options
  const empty: SpokenText = { text: '', sentences: [], truncated: false }
  if (isSilentMessage(markdown)) return empty
  // A model's visible reasoning is never read aloud.
  const source = withoutSilentMarkers(markdown.replace(/<(think|thinking|reasoning)>[\s\S]*?(?:<\/\1>|$)/gi, ' '))
  if (!source || isSilentMessage(source)) return empty

  const blocks: string[] = []
  let paragraph: string[] = []
  const flush = () => {
    if (paragraph.length) blocks.push(cleanInline(paragraph.join(' ')))
    paragraph = []
  }

  const lines = source.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const fence = FENCE.exec(line)
    if (fence) {
      flush()
      index += 1
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) index += 1
      blocks.push(CODE_PHRASE[language])
      continue
    }
    if (TABLE_ROW.test(line)) {
      flush()
      while (index + 1 < lines.length && TABLE_ROW.test(lines[index + 1])) index += 1
      blocks.push(TABLE_PHRASE[language])
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    if (/^\s*MEDIA:\S+\s*$/.test(line) || /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush()
      continue
    }
    const unquoted = line.replace(/^\s*(?:>\s?)+/, '')
    if (HEADING.test(unquoted) || LIST_ITEM.test(unquoted)) {
      flush()
      const item = cleanInline(unquoted.replace(HEADING, '').replace(LIST_ITEM, '').replace(/^\[[ xX]\]\s+/, '').replace(/\s+#+\s*$/, ''))
      if (item) blocks.push(withPeriod(item))
      continue
    }
    paragraph.push(unquoted.trim())
  }
  flush()

  // Consecutive code or table pointers say the same thing once.
  const deduped = blocks.filter((block, i) => block && !(i > 0 && block === blocks[i - 1] && (block === CODE_PHRASE[language] || block === TABLE_PHRASE[language])))
  let sentences = splitSentences(deduped.join('\n'))
  let truncated = false
  if (sentences.length > maxSentences) {
    sentences = [...sentences.slice(0, Math.max(0, maxSentences)), REST_PHRASE[language]]
    truncated = true
  }
  return { text: sentences.join(' '), sentences, truncated }
}

// ---------------------------------------------------------------------------------------------------------------------
// Language guess

const FR_WORDS = new Set(
  'le la les un une des du de et est sont pas pour dans que qui avec sur ce cette ces il elle ils nous vous je tu mais ou où donc aussi plus très être avoir fait peut bien comme au aux en ne se sa son ses mon ma mes ton ta oui non merci bonjour salut'.split(' '),
)
const EN_WORDS = new Set(
  'the is are was were and of to in that it for with on this these those he she they we you i but or so also more very be have has do does can not no yes as at by from an his her its our your my me what which who how thanks hello hi'.split(' '),
)
const FR_ACCENTS = /[àâçéèêëîïôûùüœÿ]/giu

export function guessLanguage(text: string, fallback: SpokenLanguage): SpokenLanguage {
  const words = text.toLowerCase().match(/[\p{L}]+/gu) ?? []
  if (words.length < 3) return fallback
  let fr = 0
  let en = 0
  for (const word of words) {
    if (FR_WORDS.has(word)) fr += 1
    if (EN_WORDS.has(word)) en += 1
  }
  fr += (text.match(FR_ACCENTS)?.length ?? 0) * 0.25
  if (fr === en) return fallback
  return fr > en ? 'fr' : 'en'
}

// ---------------------------------------------------------------------------------------------------------------------
// Voice commands and choices

/** Lowercase, no accents, punctuation turned into spaces, single spaces. */
const normalize = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()

const END_COMMANDS = new Set(['stop', 'arrete', 'fin', 'termine', 'au revoir', 'goodbye', 'bye', 'end'])
const CANCEL_COMMANDS = new Set(['annule', 'annuler', 'cancel', 'laisse tomber', 'never mind', 'nevermind', 'oublie'])

/** A command only when the whole utterance is the command: "stop the video" is not one. */
export function voiceCommand(transcript: string): 'end' | 'cancel' | null {
  const said = normalize(transcript)
  if (END_COMMANDS.has(said)) return 'end'
  if (CANCEL_COMMANDS.has(said)) return 'cancel'
  return null
}

const NUMBER_WORDS: Record<string, number> = {
  un: 1, une: 1, premier: 1, premiere: 1, one: 1, first: 1,
  deux: 2, deuxieme: 2, second: 2, seconde: 2, two: 2,
  trois: 3, troisieme: 3, three: 3, third: 3,
  quatre: 4, quatrieme: 4, four: 4, fourth: 4,
  cinq: 5, cinquieme: 5, five: 5, fifth: 5,
  six: 6, sixieme: 6, sixth: 6,
}
const NUMBER_PREFIXES = new Set(['le', 'la', 'l', 'option', 'choix', 'the', 'number', 'numero', 'choice'])

/** Index of the choice the user meant, or null when it is unclear. */
export function matchChoice(transcript: string, choices: string[]): number | null {
  const said = normalize(transcript)
  if (!said || !choices.length) return null

  const tokens = said.split(' ')
  let first = 0
  while (first < tokens.length - 1 && NUMBER_PREFIXES.has(tokens[first])) first += 1
  const rest = tokens.slice(first)
  if (rest.length === 1) {
    const token = rest[0]
    const number = /^\d{1,3}$/.test(token) ? Number(token) : NUMBER_WORDS[token]
    if (number !== undefined) return number >= 1 && number <= choices.length ? number - 1 : null
  }

  const labels = choices.map(normalize)
  const padded = ` ${said} `
  const exact = labels.flatMap((label, index) => (label && label === said ? [index] : []))
  if (exact.length === 1) return exact[0]
  if (exact.length > 1) return null
  const fuzzy = labels.flatMap((label, index) => {
    if (!label) return []
    if (padded.includes(` ${label} `)) return [index]
    if (label.length >= 4 && ` ${label} `.includes(padded)) return [index]
    return []
  })
  return fuzzy.length === 1 ? fuzzy[0] : null
}

// ---------------------------------------------------------------------------------------------------------------------
// Echo of the bot's own voice

const ECHO_THRESHOLD = 0.6
const ECHO_MIN_CHARS = 10

const bigrams = (text: string) => {
  const grams = new Map<string, number>()
  for (let i = 0; i < text.length - 1; i += 1) {
    const gram = text.slice(i, i + 2)
    grams.set(gram, (grams.get(gram) ?? 0) + 1)
  }
  return grams
}

/** Dice coefficient of the character bigrams: 1 for the same text, near 0 for unrelated ones. */
export function similarity(a: string, b: string): number {
  if (a === b) return a ? 1 : 0
  if (a.length < 2 || b.length < 2) return 0
  const left = bigrams(a)
  const right = bigrams(b)
  let shared = 0
  for (const [gram, count] of left) shared += Math.min(count, right.get(gram) ?? 0)
  return (2 * shared) / (a.length - 1 + b.length - 1)
}

/**
 * Over speakers, the end of the bot's own reply can reach the microphone and come back as words nobody
 * said. A transcript is taken for an echo when it is close to what was just spoken, compared with each
 * sentence and with windows of the same length in the whole spoken text. Short answers ("oui", "deux")
 * are never taken for an echo.
 */
export function isEcho(transcript: string, spoken: string[]): boolean {
  const heard = normalize(transcript)
  if (heard.length < ECHO_MIN_CHARS || !spoken.length) return false
  const sentences = spoken.map(normalize).filter(Boolean)
  if (sentences.some((sentence) => similarity(heard, sentence) >= ECHO_THRESHOLD)) return true
  const all = sentences.join(' ')
  const words = all.split(' ')
  const size = heard.split(' ').length
  for (let start = 0; start + size <= words.length; start += 1) {
    if (similarity(heard, words.slice(start, start + size).join(' ')) >= ECHO_THRESHOLD) return true
  }
  return false
}
