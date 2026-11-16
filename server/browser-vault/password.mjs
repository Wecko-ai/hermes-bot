import { randomInt } from 'node:crypto'

const LOWER = 'abcdefghijklmnopqrstuvwxyz'
const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DIGITS = '0123456789'
// No quote, backslash or space: they break some sign-up forms and need escaping everywhere.
const SYMBOLS = '!#$%&*+-=?@^_'

export const PASSWORD_CLASSES = [LOWER, UPPER, DIGITS, SYMBOLS]
export const PASSWORD_ALPHABET = PASSWORD_CLASSES.join('')

/**
 * Strong password for an account a bot creates. Drawn with `node:crypto` only; it never leaves the
 * vault except into the keychain and the page's password fields.
 */
export function generatePassword(length = 20) {
  if (!Number.isInteger(length) || length < PASSWORD_CLASSES.length || length > 128) throw new RangeError('invalid_length')
  const pick = (chars) => chars[randomInt(chars.length)]
  // One character of each class, then the rest from the whole alphabet, then a Fisher-Yates shuffle.
  const chars = PASSWORD_CLASSES.map(pick)
  while (chars.length < length) chars.push(pick(PASSWORD_ALPHABET))
  for (let index = chars.length - 1; index > 0; index -= 1) {
    const other = randomInt(index + 1)
    ;[chars[index], chars[other]] = [chars[other], chars[index]]
  }
  return chars.join('')
}
