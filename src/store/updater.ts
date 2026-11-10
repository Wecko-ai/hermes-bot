/** Valeur directe ou fonction de la valeur courante, comme le setter d’un `useState`. */
export type Updater<T> = T | ((current: T) => T)

export function resolveUpdater<T>(value: Updater<T>, current: T): T {
  return typeof value === 'function' ? (value as (current: T) => T)(current) : value
}
