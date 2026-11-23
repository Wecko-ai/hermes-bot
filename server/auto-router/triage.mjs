/** Hybrid local-LLM triage for low-confidence Auto classifications. */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CATEGORIES, classifyPromptWithConfidence, estimateTokens } from './classifier.mjs'

export const DEFAULT_TRIAGE_CONFIG = Object.freeze({
  mode: 'off',
  enabledBots: [],
  endpoint: 'http://127.0.0.1:8000/v1/chat/completions',
  modelsUrl: 'http://127.0.0.1:8000/admin/api/models',
  model: 'mlx-community--Qwen3.5-9B-4bit',
  timeoutMs: 1500,
  availableTimeoutMs: 300,
  maxInputTokens: 2000,
  confidenceThreshold: 0.7,
  maxTokens: 64,
})

export const DIFFICULTIES = ['easy', 'medium', 'hard']

function expandHome(value) {
  if (typeof value !== 'string' || !value) return value
  return value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function asStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item.trim()) : []
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/** Merge app config + ~/.hermes/hermesbot-settings.json, settings win. */
export function loadTriageConfig(overrides = {}) {
  const settings = readJson(expandHome('~/.hermes/hermesbot-settings.json')) || {}
  const appConfig = readJson(expandHome('~/Library/Application Support/HermesBot/config.json')) || {}
  const raw = {
    ...asObject(appConfig.autoRouter?.triage),
    ...asObject(settings.autoRouter?.triage),
    ...asObject(overrides),
  }
  const mode = raw.mode === 'live' || raw.mode === 'shadow' || raw.mode === 'off' ? raw.mode : DEFAULT_TRIAGE_CONFIG.mode
  return {
    mode,
    enabledBots: asStringArray(raw.enabledBots).map((item) => item.trim().toLowerCase()),
    endpoint: typeof raw.endpoint === 'string' && raw.endpoint.startsWith('http') ? raw.endpoint : DEFAULT_TRIAGE_CONFIG.endpoint,
    modelsUrl: typeof raw.modelsUrl === 'string' && raw.modelsUrl.startsWith('http') ? raw.modelsUrl : DEFAULT_TRIAGE_CONFIG.modelsUrl,
    model: typeof raw.model === 'string' && raw.model.trim() ? raw.model.trim() : DEFAULT_TRIAGE_CONFIG.model,
    timeoutMs: clampNumber(raw.timeoutMs, DEFAULT_TRIAGE_CONFIG.timeoutMs, 200, 8_000),
    availableTimeoutMs: clampNumber(raw.availableTimeoutMs, DEFAULT_TRIAGE_CONFIG.availableTimeoutMs, 50, 1_000),
    maxInputTokens: clampNumber(raw.maxInputTokens, DEFAULT_TRIAGE_CONFIG.maxInputTokens, 256, 4_000),
    confidenceThreshold: clampNumber(raw.confidenceThreshold, DEFAULT_TRIAGE_CONFIG.confidenceThreshold, 0, 1),
    maxTokens: clampNumber(raw.maxTokens, DEFAULT_TRIAGE_CONFIG.maxTokens, 16, 256),
  }
}

export function botEnabled(bot, config) {
  const name = String(bot || '').trim().toLowerCase()
  if (!name) return false
  const allowed = config?.enabledBots || []
  return allowed.includes(name)
}

export function clipTokens(text, maxTokens) {
  const value = String(text || '')
  if (maxTokens <= 0 || !value) return ''
  const budget = Math.max(1, Math.floor(maxTokens) * 4)
  if (value.length <= budget) return value
  const head = Math.min(Math.floor(budget * 0.35), 800)
  const tail = budget - head - 5
  if (tail <= 0) return value.slice(0, budget)
  return `${value.slice(0, head)}\n…\n${value.slice(-tail)}`
}

export function clipForTriage(text, summary = '', maxInputTokens = 2000) {
  const reserve = 280
  const budget = Math.max(200, (Number(maxInputTokens) || 2000) - reserve)
  const sumBudget = Math.min(Math.floor(budget * 0.25), 200)
  const clippedSummary = clipTokens(summary, sumBudget)
  const used = estimateTokens(clippedSummary)
  return {
    text: clipTokens(text, Math.max(80, budget - used)),
    summary: clippedSummary,
  }
}

export function parseTriageResponse(text) {
  const cleaned = String(text || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const match = cleaned.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const data = JSON.parse(match[0])
    const category = String(data.category || '').trim().toLowerCase()
    if (!CATEGORIES.includes(category)) return null
    const difficultyRaw = String(data.difficulty || 'medium').trim().toLowerCase()
    const difficulty = DIFFICULTIES.includes(difficultyRaw) ? difficultyRaw : 'medium'
    return { category, difficulty }
  } catch {
    return null
  }
}

function systemPrompt() {
  return [
    'You classify one chat turn for a model router. Reply with JSON only, no markdown, no prose.',
    '{"category":"coding|research|quick|long_context|vision|writing|other","difficulty":"easy|medium|hard"}',
    'coding: software, patches, debugging, repos, APIs.',
    'research: look up, compare, investigate, sources.',
    'quick: short chitchat or a one-line courtesy reply.',
    'long_context: needs a very large window (long docs or a huge thread).',
    'vision: the answer needs to see an attached image.',
    'writing: draft prose, email, article, rewrite.',
    'other: none of the above.',
    'difficulty: easy (short, routine), medium, hard (multi-step, high stakes, long reasoning).',
  ].join('\n')
}

function userPrompt(input) {
  const bits = [`User message:\n${input.text || '(empty)'}`]
  if (input.summary) bits.push(`Conversation summary:\n${input.summary}`)
  bits.push(`Images attached: ${Number(input.imageCount) || 0}`)
  if (input.contextUsed) bits.push(`Approximate tokens already in context: ${Number(input.contextUsed) || 0}`)
  return bits.join('\n\n')
}

export function weightsForDifficulty(difficulty) {
  if (difficulty === 'hard') return { quality: 1.25, cost: 0.15, latency: 0.08 }
  if (difficulty === 'easy') return { quality: 0.75, cost: 0.35, latency: 0.3 }
  return {}
}

export function publicTriage(result) {
  if (!result) return null
  return {
    source: result.source,
    category: result.category,
    rulesCategory: result.rulesCategory,
    localCategory: result.localCategory || null,
    confidence: result.confidence,
    difficulty: result.difficulty,
    latencyMs: result.latencyMs,
    skipReason: result.skipReason || null,
  }
}

async function fetchWithTimeout(url, options, timeoutMs, fetchImpl) {
  const fetchFn = fetchImpl || globalThis.fetch
  const signal = options?.signal || AbortSignal.timeout(timeoutMs)
  return fetchFn(url, { ...options, signal })
}

/** Skip local triage when another model already occupies the GPU and 9B is not loaded. */
export async function checkLocalAvailable(config, fetchImpl = globalThis.fetch) {
  try {
    const response = await fetchWithTimeout(config.modelsUrl, { method: 'GET' }, config.availableTimeoutMs, fetchImpl)
    if (!response.ok) return { ok: true, reason: null, loaded: false }
    const body = await response.json()
    const models = Array.isArray(body?.models) ? body.models : []
    const wanted = String(config.model || '')
    const qwen = models.find((row) => row && (row.id === wanted || row.display_name === wanted))
    const qwenLoaded = !!(qwen && (qwen.loaded === true || qwen.is_loading === true))
    const otherLoaded = models.some((row) => row && (row.loaded === true || row.is_loading === true) && row.id !== wanted && row.display_name !== wanted)
    if (otherLoaded && !qwenLoaded) return { ok: false, reason: 'gpu_busy', loaded: false }
    return { ok: true, reason: null, loaded: qwenLoaded }
  } catch {
    // Health check failed: still try the completion, the 1.5s timeout is the backstop.
    return { ok: true, reason: null, loaded: false }
  }
}

export async function callLocalTriage(input, config, fetchImpl = globalThis.fetch) {
  const clipped = clipForTriage(input.text, input.summary, config.maxInputTokens)
  const started = Date.now()
  try {
    const response = await fetchWithTimeout(config.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: systemPrompt() },
          { role: 'user', content: userPrompt({ ...input, ...clipped }) },
        ],
        temperature: 0,
        max_tokens: config.maxTokens,
        enable_thinking: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
    }, config.timeoutMs, fetchImpl)
    const latencyMs = Date.now() - started
    if (!response.ok) return { ok: false, reason: `http_${response.status}`, latencyMs }
    const body = await response.json()
    const text = body?.choices?.[0]?.message?.content
    const parsed = parseTriageResponse(typeof text === 'string' ? text : '')
    if (!parsed) return { ok: false, reason: 'invalid_json', latencyMs }
    return { ok: true, ...parsed, latencyMs }
  } catch (error) {
    const latencyMs = Date.now() - started
    const name = error && typeof error === 'object' ? error.name : ''
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'error'
    return { ok: false, reason, latencyMs }
  }
}

/**
 * Rules first. Local Qwen only when the bot is enabled, mode is on, and confidence is low.
 * `shadow` still logs the local label but keeps the rules category for the pick.
 */
export async function resolveCategory(input, config, deps = {}) {
  const rules = classifyPromptWithConfidence(input)
  const started = Date.now()
  const base = {
    category: rules.category,
    rulesCategory: rules.category,
    localCategory: null,
    confidence: rules.confidence,
    difficulty: 'medium',
    source: 'rules',
    latencyMs: 0,
    skipReason: null,
    reason: rules.reason,
  }
  const mode = config?.mode || 'off'
  const enabled = botEnabled(input.bot, config)
  const low = rules.confidence < (config?.confidenceThreshold ?? DEFAULT_TRIAGE_CONFIG.confidenceThreshold)
  const forceLocal = input.forceLocal === true
  if (mode === 'off' || (!enabled && !forceLocal) || (!low && !forceLocal)) {
    if (mode !== 'off' && enabled && !low) base.skipReason = 'high_confidence'
    else if (mode !== 'off' && !enabled) base.skipReason = 'bot_disabled'
    return base
  }

  const check = deps.checkAvailable || checkLocalAvailable
  const call = deps.callLocal || callLocalTriage
  const fetchImpl = deps.fetch
  const available = await check(config, fetchImpl)
  if (!available.ok) {
    return { ...base, skipReason: available.reason || 'unavailable', latencyMs: Date.now() - started }
  }
  const result = await call({ text: input.text, summary: input.summary, imageCount: input.imageCount, contextUsed: input.contextUsed }, config, fetchImpl)
  const latencyMs = typeof result.latencyMs === 'number' ? result.latencyMs : Date.now() - started
  if (!result.ok) {
    const source = result.reason === 'timeout' ? 'local-timeout' : 'local-error'
    return { ...base, source, skipReason: result.reason || 'error', latencyMs }
  }
  if (mode === 'shadow' && !forceLocal) {
    return {
      ...base,
      localCategory: result.category,
      difficulty: result.difficulty,
      source: 'local-shadow',
      latencyMs,
    }
  }
  return {
    ...base,
    category: result.category,
    localCategory: result.category,
    difficulty: result.difficulty,
    source: 'local',
    latencyMs,
  }
}
