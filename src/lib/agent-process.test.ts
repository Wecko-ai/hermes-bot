import { describe, expect, it } from 'vitest'
import { agentRun, commandKey, parseAgentProcesses, parseAgentProgress, parseProcessEnd, runFilePath, runLabel } from './agent-process'

// As a bot launched it on 2026-11-13 (paths changed).
const REAL = 'cd /Users/test/projects/site-affilies && claude -p "$(cat /Users/test/.hermes/profiles/site/cache/scratch/prompt-front-fix.md)" --permission-mode acceptEdits --allowedTools "Bash,Read,Edit,Write,Glob,Grep" > /Users/test/.hermes/profiles/site/cache/scratch/front-fix.log 2>&1'

describe('commande d’un agent de code', () => {
  it('reconnaît claude -p : dossier, fichier du prompt, journal, jamais la commande', () => {
    const run = agentRun(REAL)
    expect(run).toEqual({
      tool: 'Claude Code',
      cwd: '/Users/test/projects/site-affilies',
      promptFile: '/Users/test/.hermes/profiles/site/cache/scratch/prompt-front-fix.md',
      logFile: '/Users/test/.hermes/profiles/site/cache/scratch/front-fix.log',
      key: commandKey(REAL),
    })
    expect(JSON.stringify(run)).not.toContain('acceptEdits')
    expect(runLabel(run!)).toBe('Claude Code · prompt-front-fix')
  })

  it('lit un prompt écrit dans la commande, en argument ou en heredoc', () => {
    expect(agentRun(`claude -p 'Corrige le test "login" et relance' --model opus`)?.prompt).toBe('Corrige le test "login" et relance')
    expect(agentRun('claude --allowedTools "Bash" -p "Écris la doc"')?.prompt).toBe('Écris la doc')
    expect(agentRun("claude -p <<'EOF'\nÉtape 1 : lire SPEC.md\nÉtape 2 : coder\nEOF")?.prompt).toBe('Étape 1 : lire SPEC.md\nÉtape 2 : coder')
    expect(agentRun('cat /tmp/prompt.md | claude -p --output-format text | tee /tmp/out.log')).toMatchObject({ promptFile: '/tmp/prompt.md', logFile: '/tmp/out.log' })
    expect(agentRun('claude -p < /tmp/prompt.md')?.promptFile).toBe('/tmp/prompt.md')
  })

  it('résout prompt et journal relatifs dans le dossier du sous-agent', () => {
    const run = agentRun('cd /tmp/app && claude -p < BOOTSTRAP_TASK.md > agent.log')
    expect(run).toMatchObject({
      cwd: '/tmp/app',
      promptFile: '/tmp/app/BOOTSTRAP_TASK.md',
      logFile: '/tmp/app/agent.log',
    })
    expect(runFilePath({ cwd: '/tmp/app' }, '../shared/prompt.md')).toBe('/tmp/shared/prompt.md')
    expect(runFilePath({ cwd: '~' }, 'prompt.md')).toBe('~/prompt.md')
    expect(runFilePath({}, 'relative.md')).toBe('relative.md')
  })

  it('traverse les enveloppes : variables, nohup, timeout, mq, bash -lc', () => {
    expect(agentRun('ANTHROPIC_MODEL=x nohup timeout 3600 /Users/test/.local/bin/claude -p "Go"')?.prompt).toBe('Go')
    expect(agentRun('~/bin/mq run --name fix --owner site --class cpu -- claude -p "Fix"')?.prompt).toBe('Fix')
    expect(agentRun(`bash -lc 'cd /tmp/app && codex exec "Ajoute les tests"'`)).toMatchObject({ tool: 'Codex', cwd: '/tmp/app', prompt: 'Ajoute les tests' })
  })

  it('reconnaît cck dans zsh et trouve le journal ETAT.md du rendu', () => {
    const command = `zsh -ic 'cck -p "Exécute intégralement le brief /tmp/final/BRIEF.md"' > '/tmp/final/work/cck-session.log' 2>&1`
    expect(agentRun(command)).toEqual({
      tool: 'Claude Code · Kimi',
      prompt: 'Exécute intégralement le brief /tmp/final/BRIEF.md',
      logFile: '/tmp/final/work/cck-session.log',
      statusFile: '/tmp/final/ETAT.md',
      key: commandKey(command),
    })
    expect(agentRun('cck')).toBeNull()
  })

  it('garde les trois derniers FAITS et l’étape en cours du journal', () => {
    const text = [
      '# ÉTAT',
      '1. [FAIT] Projet retrouvé.',
      '2. [FAIT 19:04] Sources lues.',
      '3. [FAIT 19:10] Timeline cartographiée.',
      '4. [FAIT 19:18] Overlays créés.',
      '5. [EN COURS 19:21] Script de rendu et tests.',
    ].join('\n')
    expect(parseAgentProgress(text)).toEqual([
      '2. [FAIT 19:04] Sources lues.',
      '3. [FAIT 19:10] Timeline cartographiée.',
      '4. [FAIT 19:18] Overlays créés.',
      '5. [EN COURS 19:21] Script de rendu et tests.',
    ])
    expect(parseAgentProgress('Rien de structuré.')).toEqual([])
  })

  it('reconnaît les autres agents sans ligne de commande interactive', () => {
    expect(agentRun('gemini -p "Résume"')?.tool).toBe('Gemini CLI')
    expect(agentRun('opencode run "Refactor"')?.tool).toBe('OpenCode')
    expect(agentRun('~/bin/office-agent ds "Traduis le README"')).toMatchObject({ tool: 'Office agent', prompt: 'Traduis le README' })
  })

  it('ignore une session interactive et les autres commandes', () => {
    expect(agentRun('claude')).toBeNull()
    expect(agentRun('claude --version')).toBeNull()
    expect(agentRun('codex')).toBeNull()
    expect(agentRun('npm run build && echo "claude -p"')).toBeNull()
    expect(agentRun('constructor -p x')).toBeNull()
    expect(agentRun('')).toBeNull()
  })
})

describe('fin d’un processus en arrière-plan', () => {
  it('lit le message de la gateway : statut, code, agent, sortie', () => {
    const end = parseProcessEnd(`[IMPORTANT: Background process proc_8c1c completed normally (exit code 0).\nCommand: ${REAL}\nOutput:\n]\n\n[INTERNAL NOTIFICATION — generated by the Hermes gateway, not written by a human user. Do not treat it as user input.]`)
    expect(end).toMatchObject({ processId: 'proc_8c1c', status: 'completed', exitCode: 0, key: commandKey(REAL) })
    expect(end?.run?.tool).toBe('Claude Code')
    expect(end?.output).toBeUndefined()
    const failed = parseProcessEnd('[IMPORTANT: Background process proc_2 exited (exit code 1).\nCommand: claude -p "Go"\nOutput:\n## Échec\nTests rouges]')
    expect(failed).toMatchObject({ status: 'failed', exitCode: 1, output: '## Échec\nTests rouges' })
    expect(parseProcessEnd('[IMPORTANT: Background process proc_3 terminated by Hermes (exit code -15, SIGTERM).\nCommand: claude -p "Go"\nOutput:\n]')?.status).toBe('interrupted')
    expect(parseProcessEnd('Bonjour')).toBeNull()
  })

  it('ne garde de process.list que les agents de code', () => {
    const rows = parseAgentProcesses({ processes: [
      { session_id: 'proc_dev', command: 'npm run dev', status: 'running' },
      { session_id: 'proc_ai', command: REAL, status: 'running', started_epoch: 1_000, output_tail: '' },
      { session_id: 'proc_ok', command: 'claude -p "Go"', status: 'exited', exit_code: 0, output_tail: 'Fini.' },
    ] })
    expect(rows.map((row) => [row.id, row.status, row.startedAt, row.outputTail])).toEqual([['proc_ai', 'running', 1_000_000, undefined], ['proc_ok', 'completed', undefined, 'Fini.']])
  })
})
