import type { AgentMessage, Bot, ChatMessage } from '../types'
import { agentMessagesFromRow } from './inter-agent'

export interface TeamExchange {
  id: string
  from: string
  to: string
  fromName?: string
  kind: AgentMessage['kind']
  text: string
  at: string | null
}

export function exchangesFromMessages(profile: string, messages: ChatMessage[]): TeamExchange[] {
  const out: TeamExchange[] = []
  for (const message of messages) {
    if (message.agent) {
      out.push({
        id: `${profile}:${message.id}`,
        from: message.agent.from,
        to: message.agent.to,
        fromName: message.agent.fromName,
        kind: message.agent.kind,
        text: message.agent.text,
        at: message.createdAt,
      })
      continue
    }
    const agents = agentMessagesFromRow({ role: message.role, text: message.content, content: message.content }, profile)
    for (const [index, agent] of agents.entries()) {
      out.push({
        id: `${profile}:${message.id}:${index}`,
        from: agent.from,
        to: agent.to,
        fromName: agent.fromName,
        kind: agent.kind,
        text: agent.text,
        at: message.createdAt,
      })
    }
  }
  return out
}

/** Recent inter-bot exchanges from chats already loaded in memory (newest first). */
export function teamFeedFromCaches(caches: Record<string, ChatMessage[]>, bots: Bot[], limit = 80): TeamExchange[] {
  const names = new Map(bots.map((bot) => [bot.slug, bot.name]))
  const merged = Object.entries(caches).flatMap(([profile, messages]) => exchangesFromMessages(profile, messages))
  merged.sort((a, b) => (b.at || '').localeCompare(a.at || ''))
  const seen = new Set<string>()
  const items: TeamExchange[] = []
  for (const item of merged) {
    const key = `${item.from}\0${item.to}\0${item.text.slice(0, 120)}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ ...item, fromName: item.fromName || names.get(item.from) })
    if (items.length >= limit) break
  }
  return items
}