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

const CLAUDE = 'Claude Code'
/** Program name to tool, and what makes it headless (otherwise it would be an interactive session). */
const AGENTS: Record<string, { tool: string; headless: (words: string[]) => boolean; promptFlags?: string[] }> = {
  claude: { tool: CLAUDE, headless: (words) => words.some((word) => word === '-p' || word === '--print'), promptFlags: ['-p', '--print'] },
  'claude-code': { tool: CLAUDE, headless: (words) => words.some((word) => word === '-p' || word === '--print'), promptFlags: ['-p', '--print'] },
  codex: { tool: 'Codex', headless: (words) => words[0] === 'exec' || words[0] === 'e' },
  gemini: { tool: 'Gemini CLI', headless: (words) => words.some((word) => word === '-p' || word === '--prompt'), promptFlags: ['-p', '--prompt'] },
  qwen: { tool: 'Qwen Code', headless: (words) => words.some((word) => word === '-p' || word === '--prompt'), promptFlags: ['-p', '--prompt'] },
  'cursor-agent': { tool: 'Cursor Agent', headless: (words) => words.some((word) => word === '-p' || word === '--print'), promptFlags: ['-p', '--print'] },
  opencode: { tool: 'OpenCode', headless: (words) => words[0] === 'run' },
  aider: { tool: 'Aider', headless: (words) => words.some((word) => word === '-m' || word === '--message'), promptFlags: ['-m', '--message'] },
  kimi: { tool: 'Kimi CLI', headless: (words) => words.some((word) => word === '-p' || word === '--print' || word === '-c' || word === '--command'), promptFlags: ['-p', '--print', '-c', '--command'] },
  'office-agent': { tool: 'Office agent', headless: () => true },
}

/** Wrappers that run the command after them. `mq run … -- cmd` is the shared queue of the machine. */
const WRAPPERS = new Set(['env', 'nohup', 'exec', 'time', 'command', 'caffeinate', 'timeout', 'gtimeout', 'stdbuf', 'unbuffer', 'nice'])
const SHELLS = new Set(['bash', 'zsh', 'sh'])
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

const basename = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path

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
      if (inner) return { ...inner, cwd: inner.cwd ?? cwd, key: commandKey(command) }
      continue
    }
    if (!Object.hasOwn(AGENTS, name)) continue
    const agent = AGENTS[name]
    const args = words.slice(start + 1)
    const argWords = args.filter((token): token is Extract<Token, { kind: 'word' }> => token.kind === 'word')
    if (!agent.headless(argWords.map((token) => token.value)) && !args.some((token) => token.kind === 'op' && (token.value === '<' || token.value === '<<')) && !pipedFrom) continue

    const run: AgentRun = { tool: agent.tool, key: commandKey(command), ...(cwd ? { cwd } : {}) }
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
    if (run.promptFile) run.promptFile = runFilePath(run, run.promptFile)
    if (run.logFile) run.logFile = runFilePath(run, run.logFile)
    return run
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
