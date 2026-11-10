import { i18n } from '../i18n'

/**
 * Media sent by Hermes bots with the `MEDIA:/absolute/path` convention.
 *
 * Same rules as Hermes Desktop (`apps/desktop/src/lib/chat-messages/parts.ts`): known delivery
 * extensions, paths with spaces, quotes, end-of-sentence punctuation. Tags are looked for in the
 * Markdown text nodes (remark plugin): never in a code block, inline code, a link or HTML, whatever the
 * indentation, lists and quotes included.
 * The files live on the gateway’s machine: the UI never reads them as `file://`, it goes through the local
 * server’s `/api/media`, which relays to the gateway with the server-side session.
 */

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'file' | 'link'

export interface MediaRef {
  /** Path as the bot wrote it, without quotes. */
  path: string
  name: string
  kind: MediaKind
}

export interface MediaTag {
  start: number
  end: number
  ref: MediaRef
  /** Sentence punctuation caught in the capture, to put back after the media. */
  punctuation: string
}

/** `MEDIA_DELIVERY_EXTS` de Hermes (`gateway/platforms/base.py`). */
const DELIVERY_EXTENSIONS = [
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tiff', 'svg', 'mp4', 'mov', 'avi', 'mkv', 'webm', '3gp',
  'mp3', 'm2a', 'wav', 'ogg', 'opus', 'm4a', 'flac', 'pdf', 'docx', 'doc', 'odt', 'rtf', 'txt', 'md',
  'epub', 'xlsx', 'xls', 'ods', 'csv', 'tsv', 'json', 'xml', 'yaml', 'yml', 'kmz', 'kml', 'geojson', 'gpx',
  'pptx', 'ppt', 'odp', 'key', 'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'apk', 'ipa', 'html', 'htm',
]

/**
 * What the app displays. Must stay identical to `MEDIA_TYPES` in `server/index.mjs`.
 * No SVG (scripts possible), nor formats Chromium cannot play (tiff, avi, mkv, 3gp).
 */
const PLAYABLE: Record<string, MediaKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  mp4: 'video', mov: 'video', webm: 'video',
  mp3: 'audio', m4a: 'audio', wav: 'audio', ogg: 'audio', opus: 'audio', flac: 'audio',
  // Opened in a tab beside the chat, through `/api/document`. Must stay identical to the server’s DOCUMENT_TYPES.
  pdf: 'document', html: 'document', htm: 'document', md: 'document', markdown: 'document',
}

export type DocumentFormat = 'pdf' | 'html' | 'markdown'

export function documentFormat(path: string): DocumentFormat {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() || ''
  if (extension === 'pdf') return 'pdf'
  return extension === 'html' || extension === 'htm' ? 'html' : 'markdown'
}

/** `revision` forces a fresh read when a bot has rewritten the file. */
export function documentUrl(profile: string, path: string, revision = 0) {
  return `/api/document?${new URLSearchParams({ profile, path, r: String(revision) })}`
}

// `.JPG` like `.jpg`: each letter accepts both cases.
const caseless = (word: string) => word.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`)
const EXTENSIONS = [...DELIVERY_EXTENSIONS].sort((a, b) => b.length - a.length).map(caseless).join('|')
// After the extension: optional sentence punctuation, then a real boundary.
const PATH_END = `(?=[.,;:!?]*(?:[\\s\`"'*_)\\]}]|MEDIA:|$))`
// Unquoted path: start anchor, inner spaces allowed, ends on a known extension.
const PATH_ANCHORED = `(?:~/|/|[A-Za-z]:[/\\\\])\\S+?(?:[^\\S\\n]+\\S+?)*?\\.(?:${EXTENSIONS})${PATH_END}`
// Fallback: a word without spaces (relative path, unknown extension).
const PATH_BARE = '[^\\s`"]+'
// Optional opening quote, then the same one to close: a quote from another sentence is never swallowed.
// Spaces after `MEDIA:` stay on the same line.
const TAG_SOURCE = `(?<open>["']?)MEDIA:[\\t ]*(?<value>\`[^\`\\n]+\`|"[^"\\n]+"|'[^'\\n]+'|${PATH_ANCHORED}|${PATH_BARE})\\k<open>`
const TRAILING_PUNCTUATION = '.,;:!?'

const plausiblePath = (path: string) => path.includes('/') || path.includes('\\') || /\.[^.]/.test(path)

/** Path and sentence punctuation stuck behind it (`MEDIA:/tmp/a.png.`). Quotes protect everything. */
function parseValue(raw: string): { path: string; punctuation: string } | null {
  const text = raw.trim()
  const quote = text[0]
  if (text.length > 1 && quote === text.at(-1) && (quote === '"' || quote === "'" || quote === '`')) {
    const path = text.slice(1, -1).trim()
    return plausiblePath(path) ? { path, punctuation: '' } : null
  }
  let end = text.length
  while (end > 0 && TRAILING_PUNCTUATION.includes(text[end - 1]) && plausiblePath(text.slice(0, end - 1))) end -= 1
  const path = text.slice(0, end)
  return plausiblePath(path) ? { path, punctuation: text.slice(end) } : null
}

function fileUrlPath(path: string) {
  if (!/^file:\/\//i.test(path)) return path
  try { return decodeURIComponent(new URL(path).pathname) } catch { return path }
}

export function mediaRef(rawPath: string): MediaRef {
  const path = fileUrlPath(rawPath.trim())
  const name = path.split(/[\\/]/).filter(Boolean).at(-1) || path
  if (/^https?:\/\//i.test(path)) return { path, name, kind: 'link' }
  const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() || ''
  return { path, name, kind: PLAYABLE[extension] || 'file' }
}

/** All the `MEDIA:` tags of a plain text, in order. */
export function findMediaTags(text: string): MediaTag[] {
  if (!text.includes('MEDIA:')) return []
  const tags: MediaTag[] = []
  for (const match of text.matchAll(new RegExp(TAG_SOURCE, 'g'))) {
    const parsed = parseValue(match.groups?.value ?? '')
    if (!parsed) continue
    const start = match.index ?? 0
    tags.push({ start, end: start + match[0].length, ref: mediaRef(parsed.path), punctuation: parsed.punctuation })
  }
  return tags
}

/** Only absolute paths on the gateway’s machine go through the proxy. */
export const isServablePath = (path: string) => path.startsWith('/') || path.startsWith('~/')

/** `version` (the message id) gives a fresh URL when a bot rewrites a file under the same name. */
export function mediaUrl(profile: string, path: string, version?: string) {
  return `/api/media?${new URLSearchParams({ profile, path, ...(version ? { v: version } : {}) })}`
}

export function mediaIndex(href: string | undefined) {
  const match = /^#media:(\d+)$/.exec(href || '')
  return match ? Number(match[1]) : -1
}

/**
 * The bots’ media in this conversation, newest to oldest, without duplicates: `MEDIA:` tags
 * and cited files, in the bot’s replies and in messages between bots.
 */
export function conversationMedia(messages: { id: string; role: string; content: string; agent?: unknown }[]) {
  const seen = new Set<string>()
  const items: { ref: MediaRef; version: string }[] = []
  for (const message of [...messages].reverse()) {
    if (message.role !== 'assistant' && !message.agent) continue
    const prose = withoutFences(message.content)
    const tagged = findMediaTags(prose).map((tag) => tag.ref)
    for (const ref of [...tagged, ...referencedFiles(message.content)].reverse()) {
      if (ref.kind === 'link' || ref.kind === 'file' || !isServablePath(ref.path) || seen.has(ref.path)) continue
      seen.add(ref.path)
      items.push({ ref, version: message.id })
    }
  }
  return items
}

const withoutFences = (text: string) => text.replace(/(`{3,}|~{3,})[\s\S]*?(?:\1|$)/g, '\n')

// Files cited without `MEDIA:`: what we look at to approve. `.md` files and HTML pages, cited all
// the time (SOUL.md, notes, dashboards), stay text.
const CITED_KINDS: Record<string, MediaKind> = Object.fromEntries(Object.entries(PLAYABLE)
  .filter(([extension, kind]) => kind === 'image' || kind === 'video' || kind === 'audio' || extension === 'pdf'))
const CITED_EXTENSIONS = Object.keys(CITED_KINDS).map(caseless).join('|')
const CITED_ABSOLUTE = new RegExp(`^(?:~/|/)[^\\n\`"'<>|]*?\\.(?:${CITED_EXTENSIONS})$`)
const CITED_DIRECTORY = /^(?:~\/|\/)[^`"'<>|\n]*\/$/
const CITED_NAME = new RegExp(`^[A-Za-z0-9][^/\\\\\\s]*\\.(?:${CITED_EXTENSIONS})$`)
// `-2.jpg` after `board-1.jpg`: the same series, abbreviated by the bot.
const CITED_SUFFIX = new RegExp(`^-[A-Za-z0-9][^/\\\\\\s]*\\.(?:${CITED_EXTENSIONS})$`)
// Absolute path written plainly in a sentence, without spaces.
const BARE_PATH = new RegExp(`(?<=^|[\\s(«"'])(?:~/|/)(?:[^\\s\`"'<>()|]+/)*[^\\s\`"'<>()|/]+?\\.(?:${CITED_EXTENSIONS})(?=[.,;:!?)»"']*(?:\\s|$))`, 'g')
const BARE_DIRECTORY = /(?<=^|[\s(«"'])(?:~\/|\/)(?:[^\s`"'<>()|]+\/)+(?=[.,;:!?)»"']*(?:\s|$))/g
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/
const CITED_LIMIT = 24

/** Message blocks: paragraphs and list items, with their continuation lines. */
function textBlocks(text: string) {
  const blocks: { item: boolean; text: string }[] = []
  let open = false
  for (const line of text.split('\n')) {
    if (!line.trim()) {
      open = false
      continue
    }
    const last = blocks.at(-1)
    const heading = /^\s{0,3}#/.test(line)
    if (heading || LIST_ITEM.test(line)) blocks.push({ item: !heading, text: line })
    else if (last && (open || (last.item && /^\s/.test(line)))) last.text += `\n${line}`
    else blocks.push({ item: false, text: line })
    open = !heading
  }
  return blocks
}

/** Paths of the block, in order: inline code read as is first, then absolute paths written plainly. */
function blockTokens(text: string) {
  const tokens: { at: number; value: string }[] = []
  for (const match of text.matchAll(/`([^`\n]+)`/g)) if (!/^["']?MEDIA:/.test(match[1].trim())) tokens.push({ at: match.index ?? 0, value: match[1].trim() })
  // A `MEDIA:` tag is already displayed in place, even with spaces in its path.
  let prose = text
  for (const tag of findMediaTags(text)) prose = `${prose.slice(0, tag.start)}${' '.repeat(tag.end - tag.start)}${prose.slice(tag.end)}`
  prose = prose.replace(/`[^`\n]*`/g, (code) => ' '.repeat(code.length))
  for (const match of prose.matchAll(BARE_PATH)) tokens.push({ at: match.index ?? 0, value: match[0] })
  for (const match of prose.matchAll(BARE_DIRECTORY)) tokens.push({ at: match.index ?? 0, value: match[0] })
  return tokens.sort((a, b) => a.at - b.at).map((token) => token.value)
}

/** Directories of a block: those written as is, and those of files cited by full path. */
function blockDirectories(tokens: string[]) {
  return [...new Set(tokens.flatMap((token) => CITED_DIRECTORY.test(token) ? [token]
    : CITED_ABSOLUTE.test(token) ? [token.slice(0, token.lastIndexOf('/') + 1)] : []))]
}

/**
 * Images, videos, sounds and PDFs a bot cites by path, without a `MEDIA:` tag (“Video:
 * `/…/final-v2.mp4`”). A bare name (`cover.jpg`) takes the directory cited in the same list item;
 * otherwise that of the preceding paragraph (“in the same folder”); otherwise the message’s only directory.
 * An ambiguous directory yields nothing. Never inside a code block.
 */
export function referencedFiles(text: string): MediaRef[] {
  const prose = withoutFences(text)
  const tagged = new Set(findMediaTags(prose).map((tag) => tag.ref.path))
  const blocks = textBlocks(prose).map((block) => ({ ...block, tokens: blockTokens(block.text) }))
  const allDirectories = new Set(blocks.flatMap((block) => block.tokens.filter((token) => CITED_DIRECTORY.test(token))))
  const found: string[] = []
  const add = (file: string) => { if (!tagged.has(file) && !found.includes(file)) found.push(file) }
  let introDirectory = ''
  for (const block of blocks) {
    const directories = blockDirectories(block.tokens)
    const directory = directories.length === 1 ? directories[0]
      : directories.length === 0 && introDirectory ? introDirectory
        : directories.length === 0 && allDirectories.size === 1 ? [...allDirectories][0] : ''
    let previous = ''
    for (const token of block.tokens) {
      let file = ''
      if (CITED_ABSOLUTE.test(token)) file = token
      else if (directory && CITED_NAME.test(token)) file = `${directory}${token}`
      else if (previous.lastIndexOf('-') > previous.lastIndexOf('/') && CITED_SUFFIX.test(token)) file = `${previous.slice(0, previous.lastIndexOf('-'))}${token}`
      if (!file || file.split('/').some((part) => part === '.' || part === '..')) continue
      previous = file
      add(file)
    }
    if (!block.item) introDirectory = directories.length === 1 ? directories[0] : directories.length > 1 ? '' : introDirectory
  }
  return found.slice(0, CITED_LIMIT).map(mediaRef)
}

/** While streaming, a tag on the last line can be cut off: it is shown once the line is complete. */
export function withoutUnfinishedTag(text: string) {
  const lineStart = text.lastIndexOf('\n') + 1
  const at = text.slice(lineStart).search(/["'`]?MEDIA:/)
  return at < 0 ? text : text.slice(0, lineStart + at)
}

/** mdast node, reduced to what the plugin reads and writes. */
export interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

/** The plugin fills `media` on every pass; the `#media:<index>` links point back to it. */
export interface MediaSink {
  media: MediaRef[]
}

const SKIPPED = new Set(['code', 'inlineCode', 'html', 'link', 'linkReference', 'definition'])

/**
 * Remark plugin: replaces the tags in text nodes with `#media:<index>` links.
 * Inline code that contains only the tag (`` `MEDIA:/a.png` ``) counts too.
 */
export function remarkMedia(sink: MediaSink) {
  return (tree: MdNode) => {
    sink.media = []
    const link = (ref: MediaRef): MdNode => ({ type: 'link', url: `#media:${sink.media.push(ref) - 1}`, children: [{ type: 'text', value: ref.name }] })
    const visit = (node: MdNode) => {
      if (!node.children) return
      node.children = node.children.flatMap((child) => {
        if (child.type === 'text' && child.value) {
          const tags = findMediaTags(child.value)
          if (!tags.length) return [child]
          const value = child.value
          const parts: MdNode[] = []
          let last = 0
          for (const tag of tags) {
            if (tag.start > last) parts.push({ type: 'text', value: value.slice(last, tag.start) })
            parts.push(link(tag.ref))
            if (tag.punctuation) parts.push({ type: 'text', value: tag.punctuation })
            last = tag.end
          }
          if (last < value.length) parts.push({ type: 'text', value: value.slice(last) })
          return parts
        }
        if (child.type === 'inlineCode' && child.value) {
          const code = child.value.trim()
          const [tag] = findMediaTags(code)
          return tag && tag.start === 0 && tag.end === code.length && !tag.punctuation ? [link(tag.ref)] : [child]
        }
        if (!SKIPPED.has(child.type)) visit(child)
        return [child]
      })
    }
    visit(tree)
  }
}

/** Roster preview: “Video demo.mp4” rather than a full path. */
export function mediaPreviewText(text: string) {
  let output = ''
  let last = 0
  for (const tag of findMediaTags(text)) {
    output += `${text.slice(last, tag.start)}${i18n.t(`media.preview.${tag.ref.kind}`)} ${tag.ref.name}${tag.punctuation}`
    last = tag.end
  }
  return output + text.slice(last)
}
