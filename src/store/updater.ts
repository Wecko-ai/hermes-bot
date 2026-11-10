/** Direct value or function of the current value, like a `useState` setter. */
export type Updater<T> = T | ((current: T) => T)

export function resolveUpdater<T>(value: Updater<T>, current: T): T {
  return typeof value === 'function' ? (value as (current: T) => T)(current) : value
}
