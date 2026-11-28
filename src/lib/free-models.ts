import type { ModelOption } from '../types'
import { providerBrand } from './providers'

// Gemini API free tier (a key from a project without billing): Flash, Flash-Lite and Hydrogen answer.
// Pro, Carbon, Argon and Omni have no free quota: the API refuses them with a quota error.
const GEMINI_FREE = /flash|hydrogen/
const GEMINI_PAID = /pro|carbon|argon|omni|ultra/

type CostedOption = Pick<ModelOption, 'provider' | 'model' | 'providerName' | 'free'>

/**
 * Models that cost nothing to call. A paid key at one of these providers is not told apart:
 * the free mode trusts that the Gemini key has no billing.
 */
export function isFreeModel(option: CostedOption): boolean {
  if (option.free) return true
  const provider = option.provider.toLowerCase()
  const model = option.model.toLowerCase()
  // OpenRouter's free variants and its free router; other gateways use the same suffix.
  if (model.endsWith(':free') || model === 'openrouter/free') return true
  // The NVIDIA API catalog (build.nvidia.com) serves every model on its free developer key.
  if (provider === 'nvidia' || provider === 'sambanova' || provider === 'custom:sambanova') return true
  // Cloudflare Workers AI. Model ids look like `@cf/meta/llama-3.1-8b-instruct-fp8-fast`.
  if (provider === 'cloudflare' || provider === 'custom:cloudflare' || provider === 'workers-ai' || provider === 'workersai') return true
  if (model.startsWith('@cf/') || model.startsWith('cloudflare/@cf/')) return true
  if (provider === 'gemini') return GEMINI_FREE.test(model) && !GEMINI_PAID.test(model)
  // Servers running on this Mac.
  return providerBrand(option.provider, option.providerName).local
}

/**
 * Paid models that stay available only as a deliberate choice, next to the zero-spend default.
 * They are never part of Auto, fallbacks or the free-mode filter, and always wear the "Paid" tag.
 * The zero-spend plugin opens the same single route (OpenRouter `tencent/hy4-flash`, key
 * `OPENROUTER_HERMESBOT_KEY` on the dedicated provider `custom:openrouter-hermesbot`).
 */
const PAID_OPT_IN = new Set(['custom:openrouter-hermesbot|tencent/hy4-flash', 'openrouter-hermesbot|tencent/hy4-flash'])

export function isPaidOptIn(option: Pick<ModelOption, 'provider' | 'model'>): boolean {
  return PAID_OPT_IN.has(`${option.provider.toLowerCase()}|${option.model.toLowerCase()}`)
}

export type ModelCost = 'free' | 'subscription' | 'paid'

/**
 * What one more call costs. `subscriptions`: the providers paid by a flat subscription
 * (`ui.subscriptionProviders`), whose models cost nothing more. The free mode keeps both.
 */
export function modelCost(option: CostedOption, subscriptions: readonly string[]): ModelCost {
  if (isFreeModel(option)) return 'free'
  return subscriptions.includes(option.provider) ? 'subscription' : 'paid'
}
