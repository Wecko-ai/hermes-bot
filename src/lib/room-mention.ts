export interface MentionKeyInput {
  key: string
  /** `KeyboardEvent.keyCode`. 229 is an IME composition and must not pick or send. */
  keyCode: number
  composing: boolean
  shiftKey: boolean
  menuOpen: boolean
  optionCount: number
  activeIndex: number
}

export type MentionKeyResult =
  | { type: 'none' }
  | { type: 'close' }
  | { type: 'submit' }
  | { type: 'move'; index: number }
  | { type: 'pick'; index: number }

/** Keyboard for the room `@` list. Same decisions as the chat composer's mention menu. */
export function mentionKeyAction(input: MentionKeyInput): MentionKeyResult {
  if (input.composing || input.keyCode === 229) return { type: 'none' }
  const count = input.optionCount
  const active = count > 0 ? Math.min(Math.max(0, input.activeIndex), count - 1) : 0
  if (input.menuOpen && count > 0) {
    if (input.key === 'ArrowDown' || input.key === 'ArrowUp') {
      const step = input.key === 'ArrowDown' ? 1 : -1
      return { type: 'move', index: (active + step + count) % count }
    }
    if (input.key === 'Enter' || input.key === 'Tab') return { type: 'pick', index: active }
    if (input.key === 'Escape') return { type: 'close' }
  }
  if (input.key === 'Enter' && !input.shiftKey) return { type: 'submit' }
  return { type: 'none' }
}
