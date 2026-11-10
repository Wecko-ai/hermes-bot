/**
 * Composer `@bot` mentions. Same contract as Hermes Desktop’s Bot Mode
 * (`plugins/hermes-bots/plugin.tsx`): the app never relays anything itself. It adds to the prompt a
 * note saying which bot the tag refers to, and the bot writes to the other one itself with its `message_agent` tool.
 */
import type { Bot } from '../types'
import { locale } from '../i18n'

export interface MentionToken {
  /** Index of the `@`. */
  start: number
  query: string
}

export interface MentionOption {
  bot: Bot
  tag: string
}

const RESERVED = new Set(['all', 'everyone', 'user', 'default', 'hermes'])
const NOTE_START = '[@mentions resolved from the Bot Mode roster'

/** Forms of a name: `“Dr. Foo”` gives `dr-foo` (what autocomplete inserts) and `drfoo`. */
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

/** The `@word` under the caret, or `null` if the caret is not in a mention. */
export function mentionTokenAt(text: string, caret: number): MentionToken | null {
  const match = /(^|\s)@([a-z0-9._-]*)$/i.exec(text.slice(0, caret))
  return match ? { start: match.index + match[1].length, query: match[2].toLowerCase() } : null
}

/** Suggested bots: never the conversation’s own bot, nor a hidden one. Name prefix matches first. */
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
    .sort((a, b) => a.score - b.score || a.option.bot.name.localeCompare(b.option.bot.name, locale()))
    .slice(0, limit)
    .map(({ option }) => option)
}

/** Mention form to bot. A form shared by two bots designates nobody. */
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

/** Bots actually mentioned, outside code. `nova@example.com` is not a mention. */
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

/** The text sent to the bot: the note only identifies the tagged bots, it contacts nobody. */
export function withMentionNote(text: string, bots: Bot[], currentSlug: string) {
  const mentioned = resolveMentions(text, bots, currentSlug)
  if (!mentioned.length) return text
  const lines = mentioned.map((bot) => {
    const tag = botMentionTag(bot)
    return `@${tag} = agent profile "${bot.slug}" ("${bot.name}")${tag === bot.slug ? '' : ` (message_agent target: "${bot.slug}")`}`
  })
  return `${text}\n\n${NOTE_START} — the user is referring to: ${lines.join('; ')}. If they want one of these agents contacted, compose your own message and send it with your message_agent tool; never forward the user’s text verbatim. If this session has no message_agent tool, agent messaging is unavailable here — say so.]`
}

/** The note is for the bot only: the user sees just what they wrote, on screen and after a reload. */
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

/** Remark plugin: a known `@bot` becomes a `#bot:<profile>` link, outside code and links. */
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
