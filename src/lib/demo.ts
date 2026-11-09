import type { Bot, ChatMessage, Routine } from '../types'
import type { WorkSummary } from './work-summary'

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const bot = (
  slug: string,
  name: string,
  role: string,
  section: string,
  preview: string,
  minutes: number,
  extra: Partial<Bot> = {},
): Bot => ({
  slug,
  name,
  role,
  section,
  sectionId: `section-${section.toLowerCase().replaceAll(' ', '-')}`,
  model: 'claude-opus-5-5',
  status: 'idle',
  preview,
  timestamp: ago(minutes),
  unread: 0,
  hidden: false,
  ...extra,
})

export const demoBots: Bot[] = [
  bot('orion', 'Orion', 'Écrit le code', 'Atelier', 'Je prépare la prochaine version.', 1, { status: 'working', unread: 1 }),
  bot('iris', 'Iris', 'Lance les tests', 'Atelier', 'Tous les tests passent.', 37),
  bot('nova', 'Nova', 'Organise le quotidien', 'Maison', 'La semaine est prête.', 4, { status: 'done', unread: 2 }),
  bot('sage', 'Sage', 'Suit le budget', 'Maison', 'Deux factures arrivent à échéance.', 18),
  bot('juno', 'Juno', 'Tient l’agenda', 'Maison', 'Rendez-vous déplacé à jeudi.', 23),
  bot('lyra', 'Lyra', 'Résume des articles', 'Lecture', 'Le résumé de l’étude est prêt.', 8, { status: 'waiting', unread: 2 }),
  bot('vega', 'Vega', 'Prend des notes de lecture', 'Lecture', 'Trois chapitres annotés.', 52),
  bot('milo', 'Milo', 'Traduit les textes', 'Lecture', 'Traduction terminée.', 12, { status: 'done' }),
  bot('atlas', 'Atlas', 'Prépare les itinéraires', 'Voyage', 'Trois trajets comparés.', 61),
  bot('echo', 'Echo', 'Surveille les prix', 'Voyage', 'Le vol a baissé de 40 €.', 33),
]

export const demoMessages: ChatMessage[] = [
  { id: 'demo-1', role: 'user', content: 'Fais-moi un point simple. Qu’est-ce qui demande mon attention ?', createdAt: ago(14) },
  {
    id: 'demo-2',
    role: 'assistant',
    content: 'Voici l’essentiel.\n\n**Trois sujets méritent ton attention :**\n\n1. **Atelier** — la prochaine version est prête à tester.\n2. **Lecture** — Lyra attend ta relecture du résumé.\n3. **Voyage** — le vol a baissé, à réserver avant vendredi.\n\nLe reste avance normalement. Je n’ai rien réservé.',
    createdAt: ago(13),
  },
  { id: 'demo-3', role: 'user', content: 'Parfait. Préviens-moi quand les tests sont terminés.', createdAt: ago(5) },
  { id: 'demo-4', role: 'assistant', content: 'C’est noté. Je te remonterai seulement ce qui nécessite une décision.', createdAt: ago(4) },
]

export const demoRoutines: Routine[] = [
  { id: 'demo-r1', name: 'Point du matin', schedule: '0 8 * * *', scheduleText: 'Tous les jours à 8h00', enabled: true, nextRunAt: ago(-240), lastRunAt: ago(240) },
  { id: 'demo-r2', name: 'Rappel des factures', schedule: '0 10 * * 1', scheduleText: 'Le lundi à 10h00', enabled: true, nextRunAt: ago(-600), lastRunAt: ago(360) },
  { id: 'demo-r3', name: 'Bilan de la semaine', schedule: '0 18 * * 5', scheduleText: 'Le vendredi à 18h00', enabled: false, nextRunAt: null, lastRunAt: ago(1400) },
]

export const demoWork: Record<string, WorkSummary> = {
  orion: { task: 'Corriger le bug de reconnexion', done: 2, total: 5, note: 'Les tests unitaires passent, je lance le parcours complet.', step: 'Lance une commande' },
}
