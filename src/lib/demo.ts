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
      lyra: ['Summarizes articles', 'Two questions about the summary.'],
      vega: ['Takes reading notes', 'Three chapters annotated.'],
      milo: ['Translates texts', 'Translation done.'],
      atlas: ['Plans the routes', 'Three routes compared.'],
      echo: ['Watches prices', 'The flight dropped by $40.'],
    },
    messages: [
      'Give me a quick update. What needs my attention?',
      'Here is what matters.\n\n**Three things need your attention:**\n\n1. **Build** — the next release is ready to test.\n2. **Reading** — Lyra needs two answers to write the summary.\n3. **Travel** — the flight got cheaper, book it before Friday.\n\nEverything else is on track. I have not booked anything.',
      'Great. Let me know when the tests are done.',
      'Noted. I will only bring you what needs a decision.',
    ],
    routines: [
      ['Morning briefing', 'Every day at 8:00 AM'],
      ['Invoice reminder', 'Mondays at 10:00 AM'],
      ['Weekly review', 'Fridays at 6:00 PM'],
    ],
    chats: {
      orion: [
        'Did the nightly build pass?',
        'Yes, everything is green. One warning about a deprecated option, nothing urgent.',
        'The app loses its connection after the Mac wakes from sleep. Please fix it.',
        'When you are done, add a line to the changelog.',
        'Keep the old setting name: people already use it.',
      ],
      sage: [
        'The print shop invoice is due Friday. Draft a reply saying we will pay it on Thursday.',
        'Here is a draft reply. Edit it if you need to, then send it from the card.',
      ],
      lyra: [
        'Summarize the study on sleep and memory I sent you this morning.',
        'I read the study (42 pages). Two choices before I write the summary.\n\n**Open questions:**\n\n1. Which length do you want: short (5 lines), one page, or detailed (three pages)?\n2. Should I keep the methods and the figures, or only the results?',
      ],
    },
    mail: { subject: 'Re: Invoice 2026-118', replyLabel: 'Invoice 2026-118 from the print shop', body: 'Hello,\n\nThank you for invoice 2026-118. We will pay it on Thursday, ahead of the due date.\n\nBest regards' },
    local: {
      messages: [
        'Explain in two sentences what a vector database is.',
        'A vector database stores data as lists of numbers, called embeddings, that capture its meaning. It returns the items closest to a query, so a search can match an idea and not only the exact words.',
        'Give me an example.',
        'Search your notes for “cheap flights”: you also find a note called “low-cost airfare”, because their embeddings are close.',
      ],
      answer: 'Visual demo mode: outside the demo, this chat talks to a model installed in Ollama.',
    },
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
      lyra: ['Résume des articles', 'Deux questions sur le résumé.'],
      vega: ['Prend des notes de lecture', 'Trois chapitres annotés.'],
      milo: ['Traduit les textes', 'Traduction terminée.'],
      atlas: ['Prépare les itinéraires', 'Trois trajets comparés.'],
      echo: ['Surveille les prix', 'Le vol a baissé de 40 €.'],
    },
    messages: [
      'Fais-moi un point simple. Qu’est-ce qui demande mon attention ?',
      'Voici l’essentiel.\n\n**Trois sujets méritent ton attention :**\n\n1. **Atelier** — la prochaine version est prête à tester.\n2. **Lecture** — Lyra attend deux réponses pour écrire le résumé.\n3. **Voyage** — le vol a baissé, à réserver avant vendredi.\n\nLe reste avance normalement. Je n’ai rien réservé.',
      'Parfait. Préviens-moi quand les tests sont terminés.',
      'C’est noté. Je te remonterai seulement ce qui nécessite une décision.',
    ],
    routines: [
      ['Point du matin', 'Tous les jours à 8h00'],
      ['Rappel des factures', 'Le lundi à 10h00'],
      ['Bilan de la semaine', 'Le vendredi à 18h00'],
    ],
    chats: {
      orion: [
        'Le build de cette nuit est passé ?',
        'Oui, tout est vert. Un avertissement sur une option dépréciée, rien d’urgent.',
        'L’app perd la connexion quand le Mac sort de veille. Corrige ça, s’il te plaît.',
        'Quand tu as fini, ajoute une ligne au journal des modifications.',
        'Garde l’ancien nom du réglage : des gens l’utilisent déjà.',
      ],
      sage: [
        'La facture de l’imprimerie arrive à échéance vendredi. Prépare une réponse : on la paie jeudi.',
        'Voici un brouillon de réponse. Modifie-le si besoin, puis envoie-le depuis la carte.',
      ],
      lyra: [
        'Résume l’étude sur le sommeil et la mémoire que je t’ai envoyée ce matin.',
        'J’ai lu l’étude (42 pages). Deux choix avant d’écrire le résumé.\n\n**Questions ouvertes :**\n\n1. Quelle longueur veux-tu : court (5 lignes), une page, ou détaillé (trois pages) ?\n2. Je garde la méthode et les figures, ou seulement les résultats ?',
      ],
    },
    mail: { subject: 'Re : Facture 2026-118', replyLabel: 'Facture 2026-118 de l’imprimerie', body: 'Bonjour,\n\nMerci pour la facture 2026-118. Nous la réglerons jeudi, avant l’échéance.\n\nBien cordialement' },
    local: {
      messages: [
        'Explique en deux phrases ce qu’est une base de données vectorielle.',
        'Une base de données vectorielle stocke les données sous forme de listes de nombres, appelées embeddings, qui en captent le sens. Elle renvoie les éléments les plus proches d’une requête : une recherche trouve ainsi une idée, pas seulement les mots exacts.',
        'Donne-moi un exemple.',
        'Cherche « vols pas chers » dans tes notes : tu trouves aussi une note intitulée « billets d’avion à petit prix », car leurs embeddings sont proches.',
      ],
      answer: 'Mode démo visuelle : hors démo, ce chat parle à un modèle installé dans Ollama.',
    },
    work: { task: 'Corriger le bug de reconnexion', note: 'Les tests unitaires passent, je lance le parcours complet.', step: 'Lance une commande' },
    context: { messages: 'Conversation', system: 'Instructions', tools: 'Outils' },
  },
} as const

type SectionId = keyof (typeof TEXTS)['en']['sections']
type BotSlug = keyof (typeof TEXTS)['en']['bots']

// Slug, name, section, minutes since the last activity, and what differs from an idle bot.
const ROSTER: [BotSlug, string, SectionId, number, Partial<Bot>][] = [
  ['orion', 'Orion', 'workshop', 1, { status: 'working', unread: 1 }],
  ['iris', 'Iris', 'workshop', 37, { background: { subagents: 2, processes: 1 } }],
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
  /** The shared conversation: the open bot's when it has none of its own. */
  messages: ChatMessage[]
  /** The bots with a conversation of their own. */
  chats: Partial<Record<string, ChatMessage[]>>
  routines: Routine[]
  work: Record<string, WorkSummary>
  usageDetails: ReturnType<typeof usageDetails>
  /** The local model chat: a fictional model, never called. */
  local: { model: string; messages: ChatMessage[]; answer: string }
}

/** The model shown by the local chat of the demo. */
export const DEMO_LOCAL_MODEL = 'qwen3.8:27b'

/** A draft in the format the mail card reads (`hermes-mail` block): it waits for approval, nothing is sent. */
const mailBlock = (draft: { subject: string; replyLabel: string; body: string }) => [
  '```hermes-mail',
  'Id: demo-mail-invoice',
  'From: you@example.com',
  'To: billing@printshop.example',
  'Cc:',
  `Subject: ${draft.subject}`,
  `Reply-Label: ${draft.replyLabel}`,
  '',
  draft.body,
  '```',
].join('\n')

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
  const { orion, sage, lyra } = texts.chats
  const chats: DemoData['chats'] = {
    // A turn runs (Orion is at work): two messages sent meanwhile, one queued, one priority.
    orion: [
      { id: 'demo-orion-1', role: 'user', content: orion[0], createdAt: ago(52) },
      { id: 'demo-orion-2', role: 'assistant', content: orion[1], createdAt: ago(51) },
      { id: 'demo-orion-3', role: 'user', content: orion[2], createdAt: ago(9) },
      { id: 'demo-orion-4', role: 'user', content: orion[3], createdAt: ago(4), delivery: 'queue' },
      { id: 'demo-orion-5', role: 'user', content: orion[4], createdAt: ago(2), delivery: 'priority' },
    ],
    sage: [
      { id: 'demo-sage-1', role: 'user', content: sage[0], createdAt: ago(21) },
      { id: 'demo-sage-2', role: 'assistant', content: `${sage[1]}\n\n${mailBlock(texts.mail)}`, createdAt: ago(18) },
    ],
    // An "open questions" list at the end of the latest reply: the questions card.
    lyra: [
      { id: 'demo-lyra-1', role: 'user', content: lyra[0], createdAt: ago(11) },
      { id: 'demo-lyra-2', role: 'assistant', content: lyra[1], createdAt: ago(8) },
    ],
  }
  const local = texts.local.messages.map((content, index): ChatMessage => ({
    id: `demo-local-${index + 1}`, role: index % 2 ? 'assistant' : 'user', content, createdAt: ago(6 - index),
  }))
  return {
    bots,
    messages,
    chats,
    routines,
    work: { orion: { task: texts.work.task, done: 2, total: 5, note: texts.work.note, step: texts.work.step } },
    usageDetails: usageDetails(texts.context),
    local: { model: DEMO_LOCAL_MODEL, messages: local, answer: texts.local.answer },
  }
}

/** The conversation a bot shows in the demo: its own, else the shared one. */
export const demoChat = (demo: DemoData, slug: string) => demo.chats[slug] ?? demo.messages

/** The first message of a bot created in the demo: it introduces itself and asks for its role. */
export function demoIntroduction(name: string, language: DemoLanguage) {
  return language === 'fr'
    ? `Bonjour, je suis ${name}, ton nouveau bot. Je garde ma mémoire d’une conversation à l’autre et je peux travailler avec les autres bots.\n\nQuel rôle veux-tu me confier ? Dis-moi ce dont je dois m’occuper pour toi.`
    : `Hi, I’m ${name}, your new bot. I keep my memory from one conversation to the next and can work with the other bots.\n\nWhat role would you like me to take? Tell me what I should take care of for you.`
}
