import type { Bot, ChatMessage, Routine } from '../types'
import type { WorkSummary } from './work-summary'

// Fictional data for the visual demo (`?demo=1`). It follows the interface language; English is the reference.
export type DemoLanguage = 'en' | 'fr'

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const TEXTS = {
  en: {
    sections: { workshop: 'Build', home: 'Home', reading: 'Reading', travel: 'Travel' },
    bots: {
      orion: ['Writes the code', 'Preparing the next release.'],
      iris: ['Runs the tests', 'All tests pass.'],
      nova: ['Runs the day-to-day', 'The week is ready.'],
      sage: ['Tracks the budget', 'Two invoices are due soon.'],
      juno: ['Keeps the calendar', 'Appointment moved to Thursday.'],
      lyra: ['Summarizes articles', 'The study summary is ready.'],
      vega: ['Takes reading notes', 'Three chapters annotated.'],
      milo: ['Translates texts', 'Translation done.'],
      atlas: ['Plans the routes', 'Three routes compared.'],
      echo: ['Watches prices', 'The flight dropped by $40.'],
    },
    messages: [
      'Give me a quick update. What needs my attention?',
      'Here is what matters.\n\n**Three things need your attention:**\n\n1. **Build** — the next release is ready to test.\n2. **Reading** — Lyra is waiting for your review of the summary.\n3. **Travel** — the flight got cheaper, book it before Friday.\n\nEverything else is on track. I have not booked anything.',
      'Great. Let me know when the tests are done.',
      'Noted. I will only bring you what needs a decision.',
    ],
    routines: [
      ['Morning briefing', 'Every day at 8:00 AM'],
      ['Invoice reminder', 'Mondays at 10:00 AM'],
      ['Weekly review', 'Fridays at 6:00 PM'],
    ],
    work: { task: 'Fix the reconnection bug', note: 'Unit tests pass, starting the full run.', step: 'Runs a command' },
    context: { messages: 'Conversation', system: 'Instructions', tools: 'Tools' },
  },
  fr: {
    sections: { workshop: 'Atelier', home: 'Maison', reading: 'Lecture', travel: 'Voyage' },
    bots: {
      orion: ['Écrit le code', 'Je prépare la prochaine version.'],
      iris: ['Lance les tests', 'Tous les tests passent.'],
      nova: ['Organise le quotidien', 'La semaine est prête.'],
      sage: ['Suit le budget', 'Deux factures arrivent à échéance.'],
      juno: ['Tient l’agenda', 'Rendez-vous déplacé à jeudi.'],
      lyra: ['Résume des articles', 'Le résumé de l’étude est prêt.'],
      vega: ['Prend des notes de lecture', 'Trois chapitres annotés.'],
      milo: ['Traduit les textes', 'Traduction terminée.'],
      atlas: ['Prépare les itinéraires', 'Trois trajets comparés.'],
      echo: ['Surveille les prix', 'Le vol a baissé de 40 €.'],
    },
    messages: [
      'Fais-moi un point simple. Qu’est-ce qui demande mon attention ?',
      'Voici l’essentiel.\n\n**Trois sujets méritent ton attention :**\n\n1. **Atelier** — la prochaine version est prête à tester.\n2. **Lecture** — Lyra attend ta relecture du résumé.\n3. **Voyage** — le vol a baissé, à réserver avant vendredi.\n\nLe reste avance normalement. Je n’ai rien réservé.',
      'Parfait. Préviens-moi quand les tests sont terminés.',
      'C’est noté. Je te remonterai seulement ce qui nécessite une décision.',
    ],
    routines: [
      ['Point du matin', 'Tous les jours à 8h00'],
      ['Rappel des factures', 'Le lundi à 10h00'],
      ['Bilan de la semaine', 'Le vendredi à 18h00'],
    ],
    work: { task: 'Corriger le bug de reconnexion', note: 'Les tests unitaires passent, je lance le parcours complet.', step: 'Lance une commande' },
    context: { messages: 'Conversation', system: 'Instructions', tools: 'Outils' },
  },
} as const

type SectionId = keyof (typeof TEXTS)['en']['sections']
type BotSlug = keyof (typeof TEXTS)['en']['bots']

// Slug, name, section, minutes since the last activity, and what differs from an idle bot.
const ROSTER: [BotSlug, string, SectionId, number, Partial<Bot>][] = [
  ['orion', 'Orion', 'workshop', 1, { status: 'working', unread: 1 }],
  ['iris', 'Iris', 'workshop', 37, {}],
  ['nova', 'Nova', 'home', 4, { status: 'done', unread: 2 }],
  ['sage', 'Sage', 'home', 18, {}],
  ['juno', 'Juno', 'home', 23, {}],
  ['lyra', 'Lyra', 'reading', 8, { status: 'waiting', unread: 2 }],
  ['vega', 'Vega', 'reading', 52, {}],
  ['milo', 'Milo', 'reading', 12, { status: 'done' }],
  ['atlas', 'Atlas', 'travel', 61, {}],
  ['echo', 'Echo', 'travel', 33, {}],
]

export interface DemoData {
  bots: Bot[]
  messages: ChatMessage[]
  routines: Routine[]
  work: Record<string, WorkSummary>
  usageDetails: ReturnType<typeof usageDetails>
}

const usageDetails = (labels: Record<'messages' | 'system' | 'tools', string>) => ({
  usage: { contextUsed: 214_000, contextMax: 1_000_000, contextPercent: 21.4, averageTps: 62, inputTokens: 1_840_000, outputTokens: 92_400, totalTokens: 1_932_400, cacheReadTokens: 1_610_000, cacheWriteTokens: 88_000, reasoningTokens: 12_800, apiCalls: 148, compressions: 2, cacheHitPercent: 87, averageLatency: 3.4, activeSubagents: 0 },
  context: {
    used: 214_000, max: 1_000_000, estimated: true,
    categories: [{ id: 'messages', label: labels.messages, tokens: 151_000 }, { id: 'system', label: labels.system, tokens: 38_000 }, { id: 'tools', label: labels.tools, tokens: 25_000 }],
    files: [{ label: 'SOUL.md', tokens: 2_100, loaded: true }],
  },
  history: {
    days: 30, inputTokens: 18_400_000, outputTokens: 910_000, cacheReadTokens: 15_200_000, reasoningTokens: 120_000, costUsd: 0, sessions: 64, apiCalls: 2_140,
    daily: Array.from({ length: 30 }, (_, index) => {
      const date = new Date(Date.now() - (29 - index) * 86_400_000)
      return { day: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`, tokens: index % 7 === 3 ? 0 : 280_000 + ((index * 53) % 17) * 54_000, costUsd: 0 }
    }),
    models: [{ model: 'claude-opus-5-5', tokens: 16_900_000, costUsd: 0 }, { model: 'k3.1-pro', tokens: 2_410_000, costUsd: 0 }],
  },
})

/** The demo dataset in one language. Section ids stay the same in every language, so a kept preference still applies. */
export function demoData(language: DemoLanguage): DemoData {
  const texts = TEXTS[language] ?? TEXTS.en
  const bots = ROSTER.map(([slug, name, section, minutes, extra]): Bot => ({
    slug,
    name,
    role: texts.bots[slug][0],
    section: texts.sections[section],
    sectionId: `section-${section}`,
    model: 'claude-opus-5-5',
    status: 'idle',
    preview: texts.bots[slug][1],
    timestamp: ago(minutes),
    unread: 0,
    hidden: false,
    ...extra,
  }))
  const messages: ChatMessage[] = [
    { id: 'demo-1', role: 'user', content: texts.messages[0], createdAt: ago(14) },
    { id: 'demo-2', role: 'assistant', content: texts.messages[1], createdAt: ago(13) },
    { id: 'demo-3', role: 'user', content: texts.messages[2], createdAt: ago(5) },
    { id: 'demo-4', role: 'assistant', content: texts.messages[3], createdAt: ago(4) },
  ]
  const routines: Routine[] = [
    { id: 'demo-r1', name: texts.routines[0][0], schedule: '0 8 * * *', scheduleText: texts.routines[0][1], enabled: true, nextRunAt: ago(-240), lastRunAt: ago(240) },
    { id: 'demo-r2', name: texts.routines[1][0], schedule: '0 10 * * 1', scheduleText: texts.routines[1][1], enabled: true, nextRunAt: ago(-600), lastRunAt: ago(360) },
    { id: 'demo-r3', name: texts.routines[2][0], schedule: '0 18 * * 5', scheduleText: texts.routines[2][1], enabled: false, nextRunAt: null, lastRunAt: ago(1400) },
  ]
  return {
    bots,
    messages,
    routines,
    work: { orion: { task: texts.work.task, done: 2, total: 5, note: texts.work.note, step: texts.work.step } },
    usageDetails: usageDetails(texts.context),
  }
}
