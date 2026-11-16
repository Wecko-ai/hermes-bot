/**
 * The screen still shows the bot that owns this send. Screen writes
 * (`setActiveChat`, `setMessages`, `setRunning`) are allowed only then.
 */
export function stillOnProfile(selected: string | null | undefined, profile: string) {
  return Boolean(profile) && selected === profile
}

/** Claims a profile before the first await. A second send for that profile is refused. */
export function claimSend(inFlight: Set<string>, profile: string) {
  if (!profile || inFlight.has(profile)) return false
  inFlight.add(profile)
  return true
}

export function releaseSend(inFlight: Set<string>, profile: string) {
  inFlight.delete(profile)
}

/** A live turn blocks a normal send. Queue and priority still go through. */
export function sendBlockedWhileRunning(running: boolean, delivery?: string) {
  return running && delivery !== 'queue' && delivery !== 'priority'
}

/** A model-list response applies only to the request that is still the latest for the bot on screen. */
export function modelRefreshApplies(ticket: number, latest: number, profile: string, selected: string | null | undefined) {
  return ticket === latest && profile === selected
}
