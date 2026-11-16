/** Enter that confirms an IME composition (marked text), not a command. `229` is the composition key code. */
export function isImeComposition(event: { keyCode?: number; nativeEvent?: { isComposing?: boolean; keyCode?: number } }): boolean {
  const native = event.nativeEvent
  return Boolean(native?.isComposing) || event.keyCode === 229 || native?.keyCode === 229
}
