import type { SubagentState } from './subagents'

/**
 * A coding agent a bot started from its terminal, headless (`claude -p`, `codex exec`, `gemini -p`…): shown
 * with the subagents. Only what is needed to recognise it is kept: the tool, the folder, the prompt and where
 * it comes from, where the output goes. Never the command itself, which may hold a secret (an environment
 * variable, a token in a flag).
 */
export interface AgentRun {
  tool: string
  /** Folder of a `cd <folder> &&` before it. */
  cwd?: string
  /** Prompt written in the command (quoted argument or heredoc). */
  prompt?: string
  /** File the prompt is read from (`"$(cat file)"`, `< file`, `cat file |`), resolved against `cwd`. */
  promptFile?: string
  /** File the output is written to (`> file`, `| tee file`), resolved against `cwd`. */
  logFile?: string
  /** Optional task journal beside a `work/` log (`ETAT.md` in the video workflow). */
  statusFile?: string
  /** Fingerprint of the command: ties the call, its end and the live process together. */
  key: string
}

type Token = { kind: 'word'; value: string; quoted: boolean } | { kind: 'op'; value: string }

const OPERATORS = ['&&', '||', '>>', '&>', '2>&1', '1>&2', '2>', '<<', '|&', '|', ';', '>', '<', '&', '\n']

/** Shell words and operators, quotes and `$( … )` kept whole. Enough for one command line, not a shell. */
function tokenize(command: string): Token[] {
  const tokens: Token[] = []
  let index = 0
  while (index < command.length) {
    const char = command[index]
    if (char === ' ' || char === '\t' || char === '\\' && command[index + 1] === '\n') { index += char === '\\' ? 2 : 1; continue }
    const operator = OPERATORS.find((op) => command.startsWith(op, index))
    if (operator) { tokens.push({ kind: 'op', value: operator }); index += operator.length; continue }
    let value = ''
    let quoted = false
    while (index < command.length) {
      const c = command[index]
      if (c === ' ' || c === '\t' || c === '\n' || c === ';' || c === '|' || c === '&' || c === '<' || c === '>') break
      if (c === "'") {
        const end = command.indexOf("'", index + 1)
        value += command.slice(index + 1, end < 0 ? command.length : end)
        index = end < 0 ? command.length : end + 1
        quoted = true
        continue
      }
      if (c === '"') {
        index += 1
        quoted = true
        let depth = 0
        while (index < command.length && (command[index] !== '"' || depth > 0)) {
          if (command[index] === '\\' && index + 1 < command.length) { value += command[index + 1]; index += 2; continue }
          if (command.startsWith('$(', index)) depth += 1
          else if (command[index] === ')' && depth > 0) depth -= 1
          value += command[index]
          index += 1
        }
        index += 1
        continue
      }
      if (command.startsWith('$(', index)) {
        let depth = 0
        const start = index
        while (index < command.length) {
          if (command.startsWith('$(', index)) { depth += 1; index += 2; continue }
          if (command[index] === ')') { depth -= 1; index += 1; if (depth === 0) break; continue }
          index += 1
        }
        value += command.slice(start, index)
        continue
      }
      if (c === '\\' && index + 1 < command.length) { value += command[index + 1]; index += 2; continue }
      value += c
      index += 1
    }
    tokens.push({ kind: 'word', value, quoted })
  }
  return tokens
}

/** FNV-1a, 32 bits: a fingerprint, not a secret. */
export function commandKey(command: string) {
  let hash = 0x811c9dc5
  const text = command.trim()
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}


/** `dsh headless` or `dsh --profile headless`, flags allowed before the word. */
function isDshHeadless(words: string[]) {
  const profileAt = words.indexOf('--profile')
  if (profileAt >= 0) return words[profileAt + 1] === 'headless'
  const headlessAt = words.indexOf('headless')
  return headlessAt >= 0 && words.slice(0, headlessAt).every((word) => word.startsWith('-'))
}
const CLAUDE = 'Claude Code'
export const DSH_TOOL = 'DeepSeek Harness'
export const AGY_TOOL = 'Antigravity CLI'
export const AGY_DELEGATE_TOOL = 'Antigravity CLI · Delegate'
export const isAgyTool = (tool: string | undefined) => tool === AGY_TOOL || tool === AGY_DELEGATE_TOOL
export const isStructuredStreamTool = (tool: string | undefined) => tool === DSH_TOOL || isAgyTool(tool)

const isAgyHeadless = (words: string[]) => words.some((word) => word === '-p' || word === '--print' || word === '--prompt')

/** Program name to tool, and what makes it headless (otherwise it would be an interactive session). */
const AGENTS: Record<string, { tool: string; headless: (words: string[]) => boolean; promptFlags?: string[] }> = {
  claude: { tool: CLAUDE, headless: (words) => words.some((word) => word === '-p' || word === '--print'), promptFlags: ['-p', '--print'] },
  'claude-code': { tool: CLAUDE, headless: (words) => words.some((word) => word === '-p' || word === '--print'), promptFlags: ['-p', '--print'] },
  cck: { tool: 'Claude Code · Kimi', headless: (words) => words.some((word) => word === '-p' || word === '--print'), promptFlags: ['-p', '--print'] },
  codex: { tool: 'Codex', headless: (words) => words[0] === 'exec' || words[0] === 'e' },
  gemini: { tool: 'Gemini CLI', headless: (words) => words.some((word) => word === '-p' || word === '--prompt'), promptFlags: ['-p', '--prompt'] },
  qwen: { tool: 'Qwen Code', headless: (words) => words.some((word) => word === '-p' || word === '--prompt'), promptFlags: ['-p', '--prompt'] },
  'cursor-agent': { tool: 'Cursor Agent', headless: (words) => words.some((word) => word === '-p' || word === '--print'), promptFlags: ['-p', '--print'] },
  opencode: { tool: 'OpenCode', headless: (words) => words[0] === 'run' },
  aider: { tool: 'Aider', headless: (words) => words.some((word) => word === '-m' || word === '--message'), promptFlags: ['-m', '--message'] },
  kimi: { tool: 'Kimi CLI', headless: (words) => words.some((word) => word === '-p' || word === '--print' || word === '-c' || word === '--command'), promptFlags: ['-p', '--print', '-c', '--command'] },
  'office-agent': { tool: 'Office agent', headless: () => true },
  dsh: { tool: DSH_TOOL, headless: isDshHeadless },
  /** Headless dsh sub-agent launcher, always headless (`--cwd DIR`, `-p` compat). */
  'dsh-sub': { tool: DSH_TOOL, headless: () => true, promptFlags: ['-p', '--print'] },
  agy: { tool: AGY_TOOL, headless: isAgyHeadless, promptFlags: ['-p', '--print', '--prompt'] },
  'agy-delegate': { tool: AGY_DELEGATE_TOOL, headless: isAgyHeadless, promptFlags: ['-p', '--print', '--prompt'] },
  /** Headless Antigravity CLI sub-agent launcher, always headless (`--cwd DIR`, `--delegate`). */
  'agy-sub': { tool: AGY_TOOL, headless: () => true, promptFlags: ['-p', '--print', '--prompt'] },
}

/** Wrappers that run the command after them. `mq run … -- cmd` is the shared queue of the machine. */
const WRAPPERS = new Set(['env', 'nohup', 'exec', 'time', 'command', 'caffeinate', 'timeout', 'gtimeout', 'stdbuf', 'unbuffer', 'nice'])
const SHELLS = new Set(['bash', 'zsh', 'sh'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

const basename = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path
const DSH_FLAGS_WITH_VALUE = new Set(['--profile', '--permission-mode', '--approval-policy', '--session-id', '--add-dir', '--patch'])
const AGY_SUB_FLAGS_WITH_VALUE = new Set(['--effort', '--model', '-m', '--cwd', '-C', '--add-dir', '--timeout', '--owner', '--resume', '-r', '--conversation', '--output-format'])

/** Bare task words of `dsh headless`, flags and their values skipped. */
function dshTask(args: Token[]) {
  const parts: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token.kind !== 'word') continue
    if (token.value === 'headless' || token.value === '--json' || token.value === '-') continue
    if (DSH_FLAGS_WITH_VALUE.has(token.value)) { index += 1; continue }
    if (token.value.startsWith('-')) continue
    parts.push(token.value)
  }
  const task = parts.join(' ').trim()
  return task || undefined
}

/** Bare task words of `agy-sub`, flags and their values skipped. */
function agySubTask(args: Token[]) {
  const parts: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (token.kind !== 'word') continue
    if (token.value === '-' || token.value === '--') continue
    if (AGY_SUB_FLAGS_WITH_VALUE.has(token.value)) { index += 1; continue }
    if (token.value.startsWith('-')) continue
    parts.push(token.value)
  }
  const task = parts.join(' ').trim()
  return task || undefined
}

/** `$(cat file)`, `$(< file)`: the file a prompt is read from. */
function catFile(value: string) {
  return /^\$\(\s*(?:cat\s+|<\s*)(['"]?)([^'")]+)\1\s*\)$/.exec(value.trim())?.[2]
}

/** A prompt or log path as the gateway can serve it: absolute, with dot segments resolved. */
export function runFilePath(run: Pick<AgentRun, 'cwd'>, file: string) {
  const relative = !file.startsWith('/') && !file.startsWith('~/')
  const cwd = run.cwd?.replace(/\/+$/, '') ?? ''
  const raw = relative && cwd ? `${cwd}/${file}` : file
  const prefix = raw.startsWith('~/') ? '~/' : raw.startsWith('/') ? '/' : ''
  const parts: string[] = []
  for (const part of raw.slice(prefix.length).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (parts.length && parts.at(-1) !== '..') parts.pop()
      else if (!prefix) parts.push(part)
    } else parts.push(part)
  }
  return `${prefix}${parts.join('/')}`
}

/** Heredoc bodies of a command, in order: `<<'EOF' … EOF`. */
function heredocs(command: string) {
  const bodies: string[] = []
  const marker = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1[^\n]*\n/g
  let match: RegExpExecArray | null
  while ((match = marker.exec(command))) {
    const start = match.index + match[0].length
    const end = command.slice(start).search(new RegExp(`^\\s*${match[2]}\\s*$`, 'm'))
    bodies.push((end < 0 ? command.slice(start) : command.slice(start, start + end)).trim())
  }
  return bodies
}

/** Resolve paths after shell unwrapping too: `zsh -ic 'cck …' > work/log` redirects outside the quotes. */
function resolveRunFiles(run: AgentRun): AgentRun {
  if (run.promptFile) run.promptFile = runFilePath(run, run.promptFile)
  if (run.logFile) {
    run.logFile = runFilePath(run, run.logFile)
    const work = /^(.*\/)?work\/[^/]+$/.exec(run.logFile)
    if (work) run.statusFile = `${work[1] ?? ''}ETAT.md`
  }
  return run
}

/** The coding agent this command starts headless, if any. */
export function agentRun(command: string, depth = 0): AgentRun | null {
  if (!command.trim() || depth > 2) return null
  const bodies = heredocs(command)
  // Heredoc bodies are not words of the command line.
  const line = command.replace(/(<<-?\s*(['"]?)([A-Za-z_][\w-]*)\2[^\n]*\n)[\s\S]*?^\s*\3\s*$/gm, '$1')
  const tokens = tokenize(line)
  // Simple commands, with what links them (`|` pipes the previous one into this one).
  const commands: Array<{ words: Token[]; pipedFrom?: Token[] }> = []
  let current: Token[] = []
  let piped = false
  for (const token of tokens) {
    if (token.kind === 'op' && ['&&', '||', ';', '\n', '|', '|&', '&'].includes(token.value)) {
      if (current.length) commands.push({ words: current, pipedFrom: piped ? commands.at(-1)?.words : undefined })
      piped = token.value === '|' || token.value === '|&'
      current = []
      continue
    }
    current.push(token)
  }
  if (current.length) commands.push({ words: current, pipedFrom: piped ? commands.at(-1)?.words : undefined })

  let cwd: string | undefined
  for (const [position, { words, pipedFrom }] of commands.entries()) {
    const plain = words.map((token) => token.value)
    if (plain[0] === 'cd' && words[1]?.kind === 'word') { cwd = words[1].value; continue }
    // Skip assignments and wrappers to the program itself.
    let start = 0
    while (start < words.length) {
      const word = words[start]
      if (word.kind !== 'word') break
      const name = basename(word.value)
      if (ASSIGNMENT.test(word.value)) { start += 1; continue }
      if (name === 'mq' && plain.includes('--')) { start = plain.indexOf('--') + 1; continue }
      if (WRAPPERS.has(name)) {
        start += 1
        // Their own options and values (`timeout 600`, `caffeinate -i`, `nice -n 10`).
        while (start < words.length && words[start].kind === 'word' && (/^-/.test(words[start].value) || /^\d+[smhd]?$/.test(words[start].value))) start += 1
        continue
      }
      break
    }
    const program = words[start]
    if (!program || program.kind !== 'word') continue
    const name = basename(program.value)
    // `bash -lc '…'`: the agent may be inside.
    if (SHELLS.has(name)) {
      const script = words.slice(start + 1).find((token, index, rest) => token.kind === 'word' && index > 0 && rest[index - 1].kind === 'word' && /^-\w*c$/.test(rest[index - 1].value))
      const inner = script?.kind === 'word' ? agentRun(script.value, depth + 1) : null
      if (inner) {
        const wrapped = { ...inner, key: commandKey(command) }
        if (cwd) wrapped.cwd = inner.cwd ?? cwd
        const shellArgs = words.slice(start + 1)
        for (let index = 0; index < shellArgs.length; index += 1) {
          const token = shellArgs[index]
          const next = shellArgs[index + 1]
          if (token.kind !== 'op' || next?.kind !== 'word') continue
          if (token.value === '<' && !wrapped.promptFile) wrapped.promptFile = next.value
          if (token.value === '>' || token.value === '>>' || token.value === '&>') wrapped.logFile = next.value
        }
        return resolveRunFiles(wrapped)
      }
      continue
    }
    if (!Object.hasOwn(AGENTS, name)) continue
    const agent = AGENTS[name]
    const args = words.slice(start + 1)
    const argWords = args.filter((token): token is Extract<Token, { kind: 'word' }> => token.kind === 'word')
    if (!agent.headless(argWords.map((token) => token.value)) && !args.some((token) => token.kind === 'op' && (token.value === '<' || token.value === '<<')) && !pipedFrom) continue

    const run: AgentRun = { tool: agent.tool, key: commandKey(command), ...(cwd ? { cwd } : {}) }
    if (name === 'dsh-sub' || name === 'agy-sub') {
      const at = argWords.findIndex((token) => token.value === '--cwd' || token.value === '-C')
      if (at >= 0 && argWords[at + 1]) run.cwd = argWords[at + 1].value
    }
    if (name === 'agy-sub' && argWords.some((token) => token.value === '--delegate')) {
      run.tool = AGY_DELEGATE_TOOL
    }
    // Redirections: stdin is the prompt, stdout the log.
    for (let index = 0; index < args.length; index += 1) {
      const token = args[index]
      const next = args[index + 1]
      if (token.kind !== 'op' || next?.kind !== 'word') continue
      if (token.value === '<') run.promptFile = next.value
      if (token.value === '>' || token.value === '>>' || token.value === '&>') run.logFile = next.value
    }
    if (args.some((token) => token.kind === 'op' && token.value === '<<') && bodies.length) run.prompt = bodies[0]
    const after = commands[position + 1]
    if (after?.pipedFrom === words && basename(after.words[0]?.value ?? '') === 'tee') {
      const file = after.words.slice(1).find((token) => token.kind === 'word' && !token.value.startsWith('-'))
      if (file?.kind === 'word') run.logFile = file.value
    }
    if (pipedFrom && !run.prompt && !run.promptFile) {
      const source = pipedFrom.map((token) => token.value)
      if (source[0] === 'cat' && source[1]) run.promptFile = source[1]
      else if ((source[0] === 'echo' || source[0] === 'printf') && source[1]) run.prompt = source.slice(1).filter((word) => !/^-\w$/.test(word)).join(' ')
    }
    // The prompt argument: right after its flag, or the last bare word.
    const redirected = new Set<number>()
    args.forEach((token, index) => { if (token.kind === 'op') redirected.add(index + 1) })
    const flagAt = agent.promptFlags ? args.findIndex((token) => token.kind === 'word' && agent.promptFlags!.includes(token.value)) : -1
    const candidate = flagAt >= 0 && args[flagAt + 1]?.kind === 'word' && !args[flagAt + 1].value.startsWith('-') && !redirected.has(flagAt + 1)
      ? args[flagAt + 1]
      : [...args].reverse().find((token, reversed) => token.kind === 'word' && token.quoted && !redirected.has(args.length - 1 - reversed))
    if (candidate?.kind === 'word' && !run.prompt && !run.promptFile) {
      const file = catFile(candidate.value)
      if (file) run.promptFile = file
      else if (candidate.value.trim() && !candidate.value.startsWith('-')) run.prompt = candidate.value.trim()
    }
    if (name === 'dsh' && !run.prompt && !run.promptFile) {
      const task = dshTask(args)
      const file = task ? catFile(task) : undefined
      if (file) run.promptFile = file
      else if (task) run.prompt = task
    }
    if (name === 'agy-sub' && !run.prompt && !run.promptFile) {
      const task = agySubTask(args)
      const file = task ? catFile(task) : undefined
      if (file) run.promptFile = file
      else if (task) run.prompt = task
    }
    return resolveRunFiles(run)
  }
  return null
}

/** What a run without a written prompt is about: its prompt file, else its folder. */
export function runSubject(run: Pick<AgentRun, 'promptFile' | 'cwd'>) {
  if (run.promptFile) return basename(run.promptFile).replace(/\.(md|markdown|txt)$/i, '')
  return run.cwd ? basename(run.cwd) : ''
}

/** A short name for a run without a written prompt: its tool and prompt file, else its folder. */
export function runLabel(run: Pick<AgentRun, 'tool' | 'promptFile' | 'cwd'>) {
  return [run.tool, runSubject(run)].filter(Boolean).join(' · ')
}

// ── Task journals written by the agent ──────────────────────────────────────────────────────────────────────

const PROGRESS_STEP = /^\s*\d+[.)]\s*\[(?:FAIT|DONE|EN COURS|IN PROGRESS|BLOQUÉ|BLOCKED)(?:\s+[^\]]+)?\]/i
const PROGRESS_CURRENT = /^\s*\d+[.)]\s*\[(?:EN COURS|IN PROGRESS|BLOQUÉ|BLOCKED)(?:\s+[^\]]+)?\]/i

/** Last three completed steps and the current one, verbatim: no model call and no invented status. */
export function parseAgentProgress(text: string): string[] {
  const steps = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => PROGRESS_STEP.test(line))
  const current = [...steps].reverse().find((line) => PROGRESS_CURRENT.test(line))
  if (!current) return steps.slice(-4)
  return [...steps.filter((line) => !PROGRESS_CURRENT.test(line)).slice(-3), current]
}

export function currentAgentProgress(lines: string[]): string | undefined {
  return [...lines].reverse().find((line) => PROGRESS_CURRENT.test(line))
}

const DSH_HINT_KEYS = ['command', 'CommandLine', 'path', 'Path', 'file', 'query', 'pattern', 'url', 'goal']

function dshHint(input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return ''
  const record = input as Record<string, unknown>
  for (const key of DSH_HINT_KEYS) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim().replace(/\s+/g, ' ').slice(0, 80)
  }
  return ''
}

/** `dsh headless --json` events, as the same numbered steps a task journal uses. */
export function parseDshProgress(text: string): string[] {
  const done: string[] = []
  let pending = ''
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    let event: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      event = parsed as Record<string, unknown>
    } catch { continue }
    const type = event.type
    if (type === 'tool_call' && typeof event.tool === 'string') {
      const hint = dshHint(event.input)
      pending = `[EN COURS] ${event.tool}${hint ? ` — ${hint}` : ''}`
    } else if (type === 'tool_result') {
      const mark = event.status === 'error' ? 'BLOQUÉ' : 'FAIT'
      const tool = pending.replace(/^\[(?:EN COURS|BLOQUÉ)\]\s*/, '').split(' — ')[0] || 'outil'
      pending = ''
      done.push(`[${mark}] ${tool}`)
    } else if ((type === 'text' || type === 'final') && typeof event.text === 'string' && event.text.trim()) {
      done.push(`[FAIT] ${event.text.trim().replace(/\s+/g, ' ').slice(0, 160)}`)
    }
  }
  const steps = pending ? [...done, pending] : done
  return parseAgentProgress(steps.map((step, index) => `${index + 1}. ${step}`).join('\n'))
}

/** `agy --output-format stream-json` NDJSON events, normalized to the same numbered step format. */
export function parseAgyProgress(text: string): string[] {
  const done: string[] = []
  let pending = ''
  const pushTool = (name: string, input: unknown) => {
    const hint = dshHint(input)
    pending = `[EN COURS] ${name}${hint ? ` — ${hint}` : ''}`
  }
  const finishTool = (isError: boolean, fallbackName?: string) => {
    const mark = isError ? 'BLOQUÉ' : 'FAIT'
    const tool = pending.replace(/^\[(?:EN COURS|BLOQUÉ)\]\s*/, '').split(' — ')[0] || fallbackName || 'outil'
    pending = ''
    done.push(`[${mark}] ${tool}`)
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    let event: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(line)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
      event = parsed as Record<string, unknown>
    } catch { continue }
    const type = event.type
    if ((type === 'tool_call' || type === 'tool_use') && (typeof event.tool === 'string' || typeof event.name === 'string')) {
      pushTool(String(event.tool ?? event.name), event.input ?? event.args)
    } else if (type === 'tool_result') {
      const isError = event.is_error === true || event.isError === true || event.status === 'error'
      finishTool(isError, typeof event.tool === 'string' ? event.tool : typeof event.name === 'string' ? event.name : undefined)
    } else if (type === 'assistant' && event.message && typeof event.message === 'object') {
      const content = (event.message as Record<string, unknown>).content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue
          const b = block as Record<string, unknown>
          if (b.type === 'tool_use' && typeof b.name === 'string') pushTool(b.name, b.input)
          else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            done.push(`[FAIT] ${b.text.trim().replace(/\s+/g, ' ').slice(0, 160)}`)
          }
        }
      }
    } else if (type === 'user' && event.message && typeof event.message === 'object') {
      const content = (event.message as Record<string, unknown>).content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!block || typeof block !== 'object') continue
          const b = block as Record<string, unknown>
          if (b.type === 'tool_result') finishTool(b.is_error === true)
        }
      }
    } else if ((type === 'result' || type === 'final' || type === 'text')) {
      const body = typeof event.result === 'string' ? event.result : typeof event.text === 'string' ? event.text : ''
      if (body.trim()) done.push(`[FAIT] ${body.trim().replace(/\s+/g, ' ').slice(0, 160)}`)
    }
  }
  const steps = pending ? [...done, pending] : done
  return parseAgentProgress(steps.map((step, index) => `${index + 1}. ${step}`).join('\n'))
}

/** Structured stream progress parser for supported coding agents. */
export function parseStreamProgress(tool: string | undefined, text: string): string[] {
  if (tool === DSH_TOOL) return parseDshProgress(text)
  if (isAgyTool(tool)) return parseAgyProgress(text)
  return []
}

/** A run's printable result: the final answer of a JSON stream, never its raw events. */
export function agentResult(run: Pick<AgentRun, 'tool'>, output: string | undefined): string | undefined {
  if (!output?.trim()) return undefined
  if (!isStructuredStreamTool(run.tool)) return output
  let final = ''
  let text = ''
  let error = ''
  let jsonLines = 0
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line.startsWith('{')) continue
    try {
      const event: unknown = JSON.parse(line)
      if (!event || typeof event !== 'object' || Array.isArray(event)) continue
      jsonLines += 1
      const record = event as Record<string, unknown>
      if (record.type === 'final' && typeof record.text === 'string' && record.text.trim()) final = record.text
      else if (record.type === 'result' && typeof record.result === 'string' && record.result.trim()) final = record.result
      else if (record.type === 'text' && typeof record.text === 'string' && record.text.trim()) text = record.text
      else if (record.type === 'assistant' && record.message && typeof record.message === 'object') {
        const content = (record.message as Record<string, unknown>).content
        if (Array.isArray(content)) {
          const joined = content
            .filter((b): b is Record<string, unknown> => Boolean(b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text' && typeof (b as Record<string, unknown>).text === 'string'))
            .map((b) => String(b.text).trim())
            .filter(Boolean)
            .join('\n')
          if (joined) text = joined
        }
      } else if (record.type === 'error' && typeof record.message === 'string' && record.message.trim()) error = record.message
    } catch { continue }
  }
  if (jsonLines === 0 && isAgyTool(run.tool)) return output
  return final || text || error || undefined
}

// ── Background processes: the gateway's end message and `process.list` ──────────────────────────────────────

export interface ProcessEnd {
  processId: string
  status: SubagentState
  exitCode?: number
  key: string
  run: AgentRun | null
  /** What the process printed, when it was not sent to a file. */
  output?: string
}

const PROCESS_END = /^\[IMPORTANT: Background process (\S+) (completed normally|exited|terminated by [^(]+|[a-z][^(]*?) \(exit code (-?\d+|\?)(?:, SIGTERM)?\)\.\n(?:[^\n]*\n)?Command: ([^\n]*(?:\n(?!Output:\n)[^\n]*)*)\nOutput:\n([\s\S]*)\]$/
const GATEWAY_FOOTER = /\s*\[INTERNAL NOTIFICATION — generated by the Hermes gateway[\s\S]*$/

/** `[IMPORTANT: Background process proc_1 completed normally (exit code 0).` … of the gateway. */
export function parseProcessEnd(content: string): ProcessEnd | null {
  const match = PROCESS_END.exec(content.replace(GATEWAY_FOOTER, '').trim())
  if (!match) return null
  const exit = match[3] === '?' ? undefined : Number(match[3])
  const status: SubagentState = match[2].startsWith('terminated') ? 'interrupted' : exit === 0 ? 'completed' : exit === undefined ? 'ended' : 'failed'
  const output = match[5].trim()
  return { processId: match[1], status, ...(exit !== undefined ? { exitCode: exit } : {}), key: commandKey(match[4]), run: agentRun(match[4]), ...(output ? { output } : {}) }
}

/** One background process of the open conversation that runs a coding agent. */
export interface AgentProcess {
  id: string
  run: AgentRun
  status: SubagentState
  exitCode?: number
  /** Milliseconds. */
  startedAt?: number
  /** End of what it printed so far (`output_tail`), when it is not sent to a file. */
  outputTail?: string
  /** Milliseconds: when this window saw it end. */
  finishedAt?: number
}

const ended = (status: SubagentState) => status !== 'running' && status !== 'queued'

/**
 * A new `process.list` read over the known rows: an end is dated when first seen, and a row the list no
 * longer gives while it ran ended without a word (kept, so the panel can still show it).
 */
export function mergeAgentProcesses(current: AgentProcess[], next: AgentProcess[], now = Date.now()): AgentProcess[] {
  const known = new Map(current.map((row) => [row.id, row]))
  const merged = next.map((row) => {
    const before = known.get(row.id)
    known.delete(row.id)
    return ended(row.status) ? { ...row, finishedAt: before?.finishedAt ?? now } : row
  })
  const gone = [...known.values()].map((row) => ended(row.status) ? row : { ...row, status: 'ended' as const, finishedAt: now })
  return [...gone, ...merged].slice(-30)
}

const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})

/** Rows of `process.list` that run a coding agent. Other processes stay a count. */
export function parseAgentProcesses(result: unknown): AgentProcess[] {
  const rows = asObject(result).processes
  if (!Array.isArray(rows)) return []
  return rows.map(asObject).flatMap((row) => {
    const id = typeof row.session_id === 'string' ? row.session_id : ''
    const command = typeof row.command === 'string' ? row.command : ''
    const run = id && command ? agentRun(command) : null
    if (!run) return []
    const exit = typeof row.exit_code === 'number' ? row.exit_code : undefined
    const running = row.status === undefined || row.status === 'running'
    const started = typeof row.started_epoch === 'number' ? row.started_epoch * 1000
      : typeof row.started_at === 'string' ? Date.parse(row.started_at)
        : typeof row.uptime_seconds === 'number' ? Date.now() - row.uptime_seconds * 1000 : Number.NaN
    const tail = typeof row.output_tail === 'string' ? row.output_tail : typeof row.output_preview === 'string' ? row.output_preview : ''
    return [{
      id,
      run,
      status: running ? 'running' : exit === 0 ? 'completed' : exit === undefined ? 'ended' : 'failed',
      ...(exit !== undefined ? { exitCode: exit } : {}),
      ...(Number.isFinite(started) ? { startedAt: started } : {}),
      ...(tail.trim() ? { outputTail: tail } : {}),
    } satisfies AgentProcess]
  })
}
