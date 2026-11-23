import { describe, expect, it } from 'vitest'
import { classifyPrompt, classifyPromptWithConfidence, estimateTokens } from './classifier.mjs'

describe('auto-router classifier', () => {
  it('detects vision when images are attached', () => {
    expect(classifyPrompt({ text: 'What is this?', imageCount: 1 })).toBe('vision')
  })

  it('detects long context from token estimate (EN)', () => {
    const text = 'x'.repeat(130_000)
    expect(classifyPrompt({ text, contextUsed: 0, contextMax: 200_000 })).toBe('long_context')
  })

  it('detects long context from session fill (FR)', () => {
    expect(classifyPrompt({ text: 'résume', contextUsed: 180_000, contextMax: 200_000 })).toBe('long_context')
  })

  it('classifies coding EN and FR', () => {
    expect(classifyPrompt({ text: 'Fix the TypeScript bug in model.ts' })).toBe('coding')
    expect(classifyPrompt({ text: 'Implémente la route /api/health' })).toBe('coding')
  })

  it('classifies research', () => {
    expect(classifyPrompt({ text: 'Research competitors and compare pricing' })).toBe('research')
    expect(classifyPrompt({ text: 'Trouve des sources sur le routage de modèles' })).toBe('research')
  })

  it('classifies writing', () => {
    expect(classifyPrompt({ text: 'Draft a short blog post about voice mode' })).toBe('writing')
    expect(classifyPrompt({ text: 'Rédige un courriel de suivi' })).toBe('writing')
  })

  it('classifies quick short prompts', () => {
    expect(classifyPrompt({ text: 'Thanks!' })).toBe('quick')
    expect(classifyPrompt({ text: 'Merci.' })).toBe('quick')
  })

  it('falls back to other', () => {
    expect(classifyPrompt({ text: 'The quarterly report attachments are in the shared drive folder marked Q3 — please reconcile the ledger with finance before the board packet ships next month.' })).toBe('other')
  })

  it('estimates tokens', () => {
    expect(estimateTokens('abcd', 10)).toBe(11)
  })
})
describe('classifyPromptWithConfidence', () => {
  it('is certain for vision and long context', () => {
    expect(classifyPromptWithConfidence({ text: 'What is this?', imageCount: 1 }).confidence).toBe(1)
    expect(classifyPromptWithConfidence({ text: 'x'.repeat(130_000) }).confidence).toBeGreaterThanOrEqual(0.9)
  })

  it('is high for fenced or strong coding, low for a weak overlap', () => {
    expect(classifyPromptWithConfidence({ text: '```ts\nconst x = 1\n```' }).confidence).toBeGreaterThanOrEqual(0.9)
    expect(classifyPromptWithConfidence({ text: 'Fix the TypeScript bug in model.ts' }).confidence).toBeGreaterThanOrEqual(0.8)
    const weak = classifyPromptWithConfidence({ text: 'Can you find the API class notes and write a short compare?' })
    expect(weak.category).toBe('coding')
    expect(weak.confidence).toBeLessThan(0.7)
  })

  it('is low for unmatched other and weak research', () => {
    expect(classifyPromptWithConfidence({ text: 'The quarterly report attachments are in the shared drive folder marked Q3 — please reconcile the ledger with finance before the board packet ships next month.' }).confidence).toBeLessThan(0.5)
    expect(classifyPromptWithConfidence({ text: 'Compare these two cafes near Namba' }).confidence).toBeLessThan(0.7)
  })

  it('is high for short courtesy', () => {
    expect(classifyPromptWithConfidence({ text: 'Thanks!' }).confidence).toBeGreaterThanOrEqual(0.85)
  })

  it('keeps short real tasks at low confidence so they can be triaged', () => {
    const news = classifyPromptWithConfidence({ text: 'prepare la newsletter' })
    expect(news.category).toBe('quick')
    expect(news.confidence).toBeLessThan(0.7)
    const mail = classifyPromptWithConfidence({ text: 'je ne me rappel plus quel mail est lié a mon compte ibkr' })
    expect(mail.category).toBe('writing')
    expect(mail.confidence).toBeLessThan(0.7)
  })
})
