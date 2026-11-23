import type { ChatMessage } from '../types'
import { i18n } from '../i18n'

/**
 * Tool text that landed in an assistant message instead of a tool row.
 *
 * Two producers:
 * - A model writes the exchange into its reply (`[Tool call] Shell` / `[Tool result] Shell`),
 *   including a heredoc command and a multi-line result. Rush's session stored one of these
 *   as a normal assistant row (`finish_reason` stop, empty `tool_calls`).
 * - A tools-free gateway request rewrites history as text (`agent/tool_history_as_text.py`):
 *   `[Tool calls:` … `]` and `[Tool result <id>]:`.
 *
 * Both become short progress steps. The answer keeps none of the markers, including a marker
 * that is still arriving at the end of a stream.
 */

export type ToolStepKind = 'shell' | 'read' | 'write' | 'search' | 'generic'

export interface ToolStep {
  kind: ToolStepKind
  /** Tool title as written, for a step we have no curated sentence for. */
  title: string
  /** Short argument: a description, a command, a file name, a query. Already clipped. */
  detail: string
}

export interface ToolTranscript {
  /** Answer text. Markers, arguments and result dumps are gone. */
  visible: string
  steps: ToolStep[]
  /** The buffer ends inside a tool block, or on a marker that is still incomplete. */
  open: boolean
}

const DETAIL_MAX = 72

const CALL_RE = /^\[Tool call\]\s*(.*)$/i
const RESULT_RE = /^\[Tool result\]\s*(.*)$/i
const GATEWAY_CALLS_RE = /^\[Tool calls:\s*(.*)$/i
const GATEWAY_RESULT_RE = /^\[Tool result\s+[^\]]+\]:\s*(.*)$/i
const KEY_RE = /^ {2}([A-Za-z_][\w]*)\s*:\s*(.*)$/
const INLINE_RE = /^(.*?)\s+(command|path|file|filepath|query|url|pattern|prompt|code|description)\s*:\s*([\s\S]*)$/i

function clip(text: string) {
  const one = text.replace(/\s+/g, ' ').trim()
  if (one.length <= DETAIL_MAX) return one
  return `${one.slice(0, DETAIL_MAX - 1).trimEnd()}…`
}

function baseName(path: string) {
  const name = path.trim().replace(/\\/g, '/').split('/').filter(Boolean).pop() || path.trim()
  return clip(name)
}

function heredocTerm(value: string) {
  return /^[\s\S]*<<-?\s*['"]?(\w+)['"]?\s*$/.exec(value)?.[1] ?? null
}

function normalize(text: string) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\]\[Tool\b/gi, '\n[Tool')
    .replace(/([^\n])(\[Tool (?:call\]|result\b|calls:))/gi, '$1\n$2')
}

function isCall(line: string) {
  return CALL_RE.test(line.trim())
}
function isResult(line: string) {
  return RESULT_RE.test(line.trim())
}
function isGatewayCalls(line: string) {
  return GATEWAY_CALLS_RE.test(line.trim())
}
function isGatewayResult(line: string) {
  return GATEWAY_RESULT_RE.test(line.trim())
}
function isMarker(line: string) {
  return isCall(line) || isResult(line) || isGatewayCalls(line) || isGatewayResult(line)
}

/** A last line that is the start of a marker and not yet the whole marker. */
function isPartial(line: string) {
  const text = line.trim()
  if (!text.startsWith('[') || isMarker(text)) return false
  const lower = text.toLowerCase()
  const heads = ['[tool call]', '[tool result]', '[tool calls:']
  if (heads.some((head) => head.startsWith(lower) && lower.length < head.length)) return true
  return /^\[tool result\b/i.test(text) && !text.includes(']:')
}

function isProse(line: string) {
  if (/^\s/.test(line)) return false
  const text = line.trim()
  if (!/^[\p{L}]/u.test(text)) return false
  if (/^[A-Za-z_][\w.-]*\s*:\s+\S/.test(text) && !/[.!?…]\s+\p{L}/u.test(text)) return false
  const words = text.split(/\s+/)
  if (/[.!?…]$/.test(text)) return true
  return words.length >= 4
}

function classify(title: string, fields: Map<string, string>): ToolStepKind {
  const name = title.toLowerCase()
  if (/\b(shell|terminal|bash|execut)/.test(name)) return 'shell'
  if (/\bread/.test(name)) return 'read'
  if (/\b(write|patch|edit|strreplace)/.test(name)) return 'write'
  if (/\b(search|grep|find|rg)\b/.test(name)) return 'search'
  if (fields.has('command')) return 'shell'
  if (fields.has('query') || fields.has('pattern')) return 'search'
  if (fields.has('path') || fields.has('file') || fields.has('filepath')) return 'read'
  return 'generic'
}

function detailFor(kind: ToolStepKind, fields: Map<string, string>) {
  const described = fields.get('description')
  if (described) return clip(described)
  if (kind === 'shell') return clip(fields.get('command') || '')
  if (kind === 'read' || kind === 'write') return baseName(fields.get('path') || fields.get('file') || fields.get('filepath') || '')
  if (kind === 'search') return clip(fields.get('query') || fields.get('pattern') || fields.get('prompt') || '')
  return clip(fields.get('prompt') || fields.get('query') || fields.get('command') || '')
}

function stepFrom(title: string, fields: Map<string, string>): ToolStep {
  const kind = classify(title, fields)
  return { kind, title: title || 'Tool', detail: detailFor(kind, fields) }
}

function parseFields(body: string[]) {
  const fields = new Map<string, string>()
  for (let index = 0; index < body.length; index += 1) {
    const key = KEY_RE.exec(body[index])
    if (!key) continue
    const name = key[1].toLowerCase()
    let value = key[2].trim()
    const term = heredocTerm(value)
    if (term) {
      const head = value.replace(/\s*<<-?\s*['"]?\w+['"]?\s*$/, '').trim()
      value = head || 'script'
    }
    fields.set(name, value)
  }
  return fields
}

function callStep(header: string, body: string[]) {
  const fields = parseFields(body)
  const inline = INLINE_RE.exec(header.trim())
  let title = header.trim()
  if (inline) {
    title = inline[1].trim()
    const key = inline[2].toLowerCase()
    if (!fields.has(key)) fields.set(key, inline[3].trim().replace(/\s*<<-?\s*['"]?\w+['"]?\s*$/, '').trim() || 'script')
  }
  title = title.split('\n')[0].trim() || 'Tool'
  return stepFrom(title, fields)
}

function gatewaySteps(body: string[]) {
  const steps: ToolStep[] = []
  for (const line of body) {
    const call = /^\s*([\w.-]+)\((.*)\)\s*$/.exec(line)
    if (!call) continue
    const fields = new Map<string, string>()
    try {
      const parsed: unknown = JSON.parse(call[2])
      if (parsed && typeof parsed === 'object') {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string') fields.set(key.toLowerCase(), value)
        }
      }
    } catch {
      fields.set('command', call[2])
    }
    steps.push(stepFrom(call[1], fields))
  }
  return steps
}

function fenceLine(line: string) {
  return line.trim().startsWith('```')
}

/**
 * Lines that belong to the call: yaml keys, a heredoc, the shell lines after it,
 * a fenced body. A reply sentence ends the call.
 */
function consumeCall(lines: string[], start: number, header: string) {
  const inline = INLINE_RE.exec(header.trim())
  let heredoc = inline ? heredocTerm(inline[3]) : null
  let fence = false
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (!fence && isMarker(line)) break
    if (fenceLine(line)) {
      fence = !fence
      index += 1
      continue
    }
    if (fence) {
      index += 1
      continue
    }
    if (heredoc) {
      if (line.trim() === heredoc) heredoc = null
      index += 1
      continue
    }
    const key = KEY_RE.exec(line)
    if (key) {
      heredoc = heredocTerm(key[2])
      index += 1
      continue
    }
    if (line.trim() === '') {
      let look = index + 1
      while (look < lines.length && lines[look].trim() === '') look += 1
      if (look >= lines.length || isMarker(lines[look]) || !isProse(lines[look])) {
        index += 1
        continue
      }
      break
    }
    if (isProse(line)) break
    index += 1
  }
  return index
}

/** Result dump until the next marker, or a blank line and then the reply. Fences stay inside. */
function consumeResult(lines: string[], start: number) {
  let fence = false
  let index = start
  while (index < lines.length) {
    const line = lines[index]
    if (!fence && isMarker(line)) break
    if (fenceLine(line)) {
      fence = !fence
      index += 1
      continue
    }
    if (!fence && line.trim() === '') {
      let look = index + 1
      while (look < lines.length && lines[look].trim() === '') look += 1
      if (look < lines.length && !isMarker(lines[look]) && isProse(lines[look])) break
    }
    index += 1
  }
  return index
}

export function parseToolTranscript(text: string): ToolTranscript {
  const source = normalize(text)
  const tail = source.split('\n').pop()?.trim() ?? ''
  if (!/\[Tool\b/i.test(source) && !isPartial(tail)) return { visible: text.trim(), steps: [], open: false }
  const lines = source.split('\n')
  const visible: string[] = []
  const steps: ToolStep[] = []
  let open = false
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (index === lines.length - 1 && isPartial(line)) {
      open = true
      break
    }
    if (isGatewayCalls(line)) {
      let end = index + 1
      while (end < lines.length && lines[end].trim() !== ']') end += 1
      steps.push(...gatewaySteps(lines.slice(index + 1, end)))
      if (end >= lines.length) open = true
      index = end >= lines.length ? end : end + 1
      continue
    }
    const call = CALL_RE.exec(line.trim())
    if (call) {
      const end = consumeCall(lines, index + 1, call[1])
      steps.push(callStep(call[1], lines.slice(index + 1, end)))
      if (end >= lines.length) open = true
      index = end
      continue
    }
    if (isResult(line) || isGatewayResult(line)) {
      const end = consumeResult(lines, index + 1)
      if (end >= lines.length) open = true
      index = end
      continue
    }
    visible.push(line)
    index += 1
  }
  return {
    visible: visible.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    steps,
    open,
  }
}

function prettyTitle(title: string) {
  const words = title.replace(/[_-]+/g, ' ').trim()
  if (!words) return 'Tool'
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** One short line for the progress list. Never the command dump. */
export function transcriptStepLabel(step: ToolStep) {
  const what = step.detail
  switch (step.kind) {
    case 'shell':
      return what ? i18n.t('progress.ranShell', { what }) : i18n.t('progress.ranShellBare')
    case 'read':
      return what ? i18n.t('progress.readFile', { name: what }) : i18n.t('progress.readFileBare')
    case 'write':
      return what ? i18n.t('progress.wroteFile', { name: what }) : i18n.t('progress.wroteFileBare')
    case 'search':
      return what ? i18n.t('progress.searched', { what }) : i18n.t('progress.searchedBare')
    default:
      return what ? `${prettyTitle(step.title)}: ${what}` : prettyTitle(step.title)
  }
}

/**
 * One assistant row, with any tool transcript lifted into progress steps ahead of the reply.
 * A row that is already a step stays a step. Text without a marker is returned unchanged.
 */
export function expandToolMessage(message: ChatMessage): ChatMessage[] {
  if (message.role !== 'assistant' || message.agent || message.technical) return [message]
  if (!/\[Tool\b/i.test(message.content) && !isPartial(message.content.split('\n').pop() ?? '')) return [message]
  const parsed = parseToolTranscript(message.content)
  const steps: ChatMessage[] = parsed.steps.map((step, index) => ({
    ...message,
    id: `${message.id}:tool:${index}`,
    content: transcriptStepLabel(step),
    progress: true,
    streaming: false,
  }))
  if (!parsed.steps.length) {
    if (parsed.visible === message.content.trim()) return [message]
    if (!parsed.visible) return []
    return [{ ...message, content: parsed.visible }]
  }
  if (message.progress || !parsed.visible) return steps
  return [...steps, { ...message, content: parsed.visible }]
}

/** Roster line and spoken reply: the answer, or the last step when the turn was only tools. */
export function toolTranscriptPreview(text: string) {
  const parsed = parseToolTranscript(text)
  if (!parsed.steps.length && !parsed.open) return text
  if (parsed.visible) return parsed.visible
  const last = parsed.steps.at(-1)
  return last ? transcriptStepLabel(last) : ''
}
