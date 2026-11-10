/**
 * Mentions `@bot` du composer. Même contrat que le Bot Mode de Hermes Desktop
 * (`plugins/hermes-bots/plugin.tsx`) : l’app ne relaie jamais rien elle-même. Elle ajoute au prompt une
 * note qui dit à qui renvoie le tag, et le bot écrit lui-même à l’autre avec son outil `message_agent`.
 */
import type { Bot } from '../types'

export interface MentionToken {
  /** Index du `@`. */
  start: number
  query: string
}

export interface MentionOption {
  bot: Bot
  tag: string
}

const RESERVED = new Set(['all', 'everyone', 'user', 'default', 'hermes'])
const NOTE_START = '[@mentions resolved from the Bot Mode roster'

/** Formes d’un nom : `« Dr. Foo »` donne `dr-foo` (ce que l’autocomplétion insère) et `drfoo`. */
export function mentionNameForms(value: string) {
  const name = value.trim().toLowerCase()
  if (!name) return []
  const slug = name.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  const collapsed = name.replace(/[^a-z0-9_-]+/g, '')
  return [...new Set([slug, collapsed])].filter((form) => /^[a-z0-9][a-z0-9_-]*$/.test(form) && !RESERVED.has(form))
}

export function botMentionTag(bot: Pick<Bot, 'slug' | 'name'>) {
  return mentionNameForms(bot.name)[0] || bot.slug
}

/** Le `@mot` sous le curseur, ou `null` si le curseur n’est pas dans une mention. */
export function mentionTokenAt(text: string, caret: number): MentionToken | null {
  const match = /(^|\s)@([a-z0-9._-]*)$/i.exec(text.slice(0, caret))
  return match ? { start: match.index + match[1].length, query: match[2].toLowerCase() } : null
}

/** Bots proposés : jamais le bot de la conversation, ni un bot masqué. Début de nom d’abord. */
export function mentionOptions(query: string, bots: Bot[], currentSlug: string, limit = 8): MentionOption[] {
  const rank = (option: MentionOption) => {
    const fields = [option.tag, option.bot.slug.toLowerCase(), option.bot.name.toLowerCase()]
    if (fields.some((field) => field.startsWith(query))) return 0
    return fields.some((field) => field.includes(query)) ? 1 : -1
  }
  return bots
    .filter((bot) => bot.slug !== currentSlug && !bot.hidden)
    .map((bot) => ({ bot, tag: botMentionTag(bot) }))
    .map((option) => ({ option, score: rank(option) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => a.score - b.score || a.option.bot.name.localeCompare(b.option.bot.name, 'fr'))
    .slice(0, limit)
    .map(({ option }) => option)
}

/** Forme de mention vers bot. Une forme portée par deux bots ne désigne personne. */
export function mentionIndex(bots: Pick<Bot, 'slug' | 'name'>[]) {
  const index = new Map<string, string | null>()
  for (const bot of bots) {
    for (const form of new Set([bot.slug.toLowerCase(), ...mentionNameForms(bot.name)])) {
      index.set(form, index.has(form) && index.get(form) !== bot.slug ? null : bot.slug)
    }
  }
  return index
}

const MENTION = /(^|[\s(])@([a-z0-9][a-z0-9_-]*)/gi

/** Bots réellement mentionnés, hors code. `nova@exemple.com` n’est pas une mention. */
export function resolveMentions(text: string, bots: Bot[], currentSlug: string) {
  const prose = text.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ')
  const index = mentionIndex(bots)
  const found = new Set<string>()
  for (const match of prose.matchAll(MENTION)) {
    const slug = index.get(match[2].toLowerCase())
    if (slug && slug !== currentSlug) found.add(slug)
  }
  return bots.filter((bot) => found.has(bot.slug))
}

/** Le texte envoyé au bot : la note n’identifie que les bots tagués, elle ne contacte personne. */
export function withMentionNote(text: string, bots: Bot[], currentSlug: string) {
  const mentioned = resolveMentions(text, bots, currentSlug)
  if (!mentioned.length) return text
  const lines = mentioned.map((bot) => {
    const tag = botMentionTag(bot)
    return `@${tag} = agent profile "${bot.slug}" ("${bot.name}")${tag === bot.slug ? '' : ` (message_agent target: "${bot.slug}")`}`
  })
  return `${text}\n\n${NOTE_START} — the user is referring to: ${lines.join('; ')}. If they want one of these agents contacted, compose your own message and send it with your message_agent tool; never forward the user’s text verbatim. If this session has no message_agent tool, agent messaging is unavailable here — say so.]`
}

/** La note reste pour le bot : l’utilisateur ne voit que ce qu’il a écrit, à l’écran comme au rechargement. */
export function withoutMentionNote(text: string) {
  const at = text.lastIndexOf(`\n\n${NOTE_START}`)
  return at >= 0 && text.trimEnd().endsWith(']') ? text.slice(0, at) : text
}

export interface MentionSink {
  index: Map<string, string | null>
}

interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

const SKIPPED = new Set(['code', 'inlineCode', 'html', 'link', 'linkReference', 'definition'])

export function mentionedSlug(href: string | undefined) {
  const match = /^#bot:(.+)$/.exec(href || '')
  return match ? match[1] : ''
}

/** Plugin remark : un `@bot` connu devient un lien `#bot:<profil>`, hors code et hors liens. */
export function remarkMentions(sink: MentionSink) {
  return (tree: MdNode) => {
    const visit = (node: MdNode) => {
      if (!node.children) return
      node.children = node.children.flatMap((child) => {
        if (child.type !== 'text' || !child.value) {
          if (!SKIPPED.has(child.type)) visit(child)
          return [child]
        }
        const value = child.value
        const parts: MdNode[] = []
        let last = 0
        for (const match of value.matchAll(MENTION)) {
          const slug = sink.index.get(match[2].toLowerCase())
          if (!slug) continue
          const start = (match.index ?? 0) + match[1].length
          if (start > last) parts.push({ type: 'text', value: value.slice(last, start) })
          parts.push({ type: 'link', url: `#bot:${slug}`, children: [{ type: 'text', value: `@${match[2]}` }] })
          last = start + match[2].length + 1
        }
        if (!parts.length) return [child]
        if (last < value.length) parts.push({ type: 'text', value: value.slice(last) })
        return parts
      })
    }
    visit(tree)
  }
}
