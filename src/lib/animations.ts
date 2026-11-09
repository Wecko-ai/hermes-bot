// Bots qui ont public/animations/<slug>-working.webp et <slug>-done.webp. Facultatif : voir le README.
export const ANIMATED_BOTS: ReadonlySet<string> = new Set<string>([])

export const hasAnimation = (slug: string) => ANIMATED_BOTS.has(slug)
