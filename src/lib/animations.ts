import { getAppConfig } from './app-config'

// Optional bot animations: `<slug>-working.webp` and `<slug>-done.webp` in the `animationsDir` folder (see the README).
// The server lists the bots that have both files in /api/app-config.
export const hasAnimation = (slug: string) => getAppConfig().animatedBots.includes(slug)
