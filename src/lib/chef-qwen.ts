import type { ModelOption } from '../types'

/** « Chef Qwen »: the gateway runs the session with a Grok 4.7 chef (fallback grok-4.6 only) that only
 *  delegates, and Qwen 27B local does the tool work (plugin chef-worker). A real session model, kept by
 *  the gateway: picking Auto or another model turns it off on the next turn. */
export const CHEF_QWEN_MODEL_SENTINEL = 'hermesbot:chef-qwen'
/** The chef the gateway uses for this mode (shown next to « Chef Qwen » until a turn names another). */
export const CHEF_QWEN_DEFAULT_CHEF = 'cursor/grok-4.7'

export function isChefQwenModel(model: string | undefined | null) {
  const value = (model || '').trim().toLowerCase()
  return value === CHEF_QWEN_MODEL_SENTINEL || value === 'hermesbot/chef-qwen'
}

export const CHEF_QWEN_PICKER_OPTION: ModelOption = {
  model: CHEF_QWEN_MODEL_SENTINEL,
  provider: 'hermesbot',
  providerName: 'HermesBot',
}

/** « Chef Qwen · Grok 4.7 · Cursor »: the mode, then the chef model that answers (or the default chef). */
export function chefQwenChip(label: string, chefModelLabel: string) {
  return chefModelLabel ? `${label} · ${chefModelLabel}` : label
}
