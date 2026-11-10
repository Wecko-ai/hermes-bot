/**
 * Médias envoyés par les bots Hermes avec la convention `MEDIA:/chemin/absolu`.
 *
 * Mêmes règles que Hermes Desktop (`apps/desktop/src/lib/chat-messages/parts.ts`) : extensions de
 * livraison connues, chemins avec espaces, guillemets, ponctuation de fin de phrase. Les balises sont
 * cherchées dans les nœuds texte du Markdown (plugin remark) : jamais dans un bloc de code, du code en
 * ligne, un lien ou du HTML, quelle que soit l’indentation, liste ou citation comprises.
 * Les fichiers vivent sur la machine de la gateway : l’interface ne les lit jamais en `file://`, elle passe par
 * `/api/media` du serveur local, qui relaie vers la gateway avec la session côté serveur.
 */

export type MediaKind = 'image' | 'video' | 'audio' | 'document' | 'file' | 'link'

export interface MediaRef {
  /** Chemin tel que le bot l’a écrit, sans guillemets. */
  path: string
  name: string
  kind: MediaKind
}

export interface MediaTag {
  start: number
  end: number
  ref: MediaRef
  /** Ponctuation de phrase prise dans la capture, à remettre après le média. */
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
 * Ce que l’app affiche. Doit rester identique à `MEDIA_TYPES` dans `server/index.mjs`.
 * Pas de SVG (script possible), ni de formats que Chromium ne lit pas (tiff, avi, mkv, 3gp).
 */
const PLAYABLE: Record<string, MediaKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', bmp: 'image',
  mp4: 'video', mov: 'video', webm: 'video',
  mp3: 'audio', m4a: 'audio', wav: 'audio', ogg: 'audio', opus: 'audio', flac: 'audio',
  // Ouverts dans un onglet à côté du chat, par `/api/document`. Doit rester identique à DOCUMENT_TYPES du serveur.
  pdf: 'document', html: 'document', htm: 'document', md: 'document', markdown: 'document',
}

export type DocumentFormat = 'pdf' | 'html' | 'markdown'

export function documentFormat(path: string): DocumentFormat {
  const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() || ''
  if (extension === 'pdf') return 'pdf'
  return extension === 'html' || extension === 'htm' ? 'html' : 'markdown'
}

/** `revision` force une nouvelle lecture quand un bot a réécrit le fichier. */
export function documentUrl(profile: string, path: string, revision = 0) {
  return `/api/document?${new URLSearchParams({ profile, path, r: String(revision) })}`
}

// `.JPG` comme `.jpg` : chaque lettre accepte les deux casses.
const caseless = (word: string) => word.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`)
const EXTENSIONS = [...DELIVERY_EXTENSIONS].sort((a, b) => b.length - a.length).map(caseless).join('|')
// Après l’extension : une ponctuation de phrase éventuelle, puis une vraie limite.
const PATH_END = `(?=[.,;:!?]*(?:[\\s\`"'*_)\\]}]|MEDIA:|$))`
// Chemin non entouré : ancre de départ, espaces intérieurs permis, fin sur une extension connue.
const PATH_ANCHORED = `(?:~/|/|[A-Za-z]:[/\\\\])\\S+?(?:[^\\S\\n]+\\S+?)*?\\.(?:${EXTENSIONS})${PATH_END}`
// Repli : un mot sans espace (chemin relatif, extension inconnue).
const PATH_BARE = '[^\\s`"]+'
// Guillemet ouvrant facultatif, puis le même pour fermer : un guillemet d’une autre phrase n’est jamais avalé.
// Les espaces après `MEDIA:` restent sur la même ligne.
const TAG_SOURCE = `(?<open>["']?)MEDIA:[\\t ]*(?<value>\`[^\`\\n]+\`|"[^"\\n]+"|'[^'\\n]+'|${PATH_ANCHORED}|${PATH_BARE})\\k<open>`
const TRAILING_PUNCTUATION = '.,;:!?'

const plausiblePath = (path: string) => path.includes('/') || path.includes('\\') || /\.[^.]/.test(path)

/** Chemin et ponctuation de phrase collée derrière (`MEDIA:/tmp/a.png.`). Les guillemets protègent tout. */
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

/** Toutes les balises `MEDIA:` d’un texte brut, dans l’ordre. */
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

/** Seuls les chemins absolus de la machine de la gateway passent par le proxy. */
export const isServablePath = (path: string) => path.startsWith('/') || path.startsWith('~/')

/** `version` (l’identifiant du message) donne une URL neuve quand un bot réécrit un fichier sous le même nom. */
export function mediaUrl(profile: string, path: string, version?: string) {
  return `/api/media?${new URLSearchParams({ profile, path, ...(version ? { v: version } : {}) })}`
}

export function mediaIndex(href: string | undefined) {
  const match = /^#media:(\d+)$/.exec(href || '')
  return match ? Number(match[1]) : -1
}

/**
 * Les médias des bots dans cette conversation, du plus récent au plus ancien, sans doublon : balises
 * `MEDIA:` et fichiers cités, dans les réponses du bot et dans les messages entre bots.
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

// Fichiers cités sans `MEDIA:` : ce qu’on regarde pour valider. Les `.md` et pages HTML, cités à tout
// bout de champ (SOUL.md, notes, tableaux de bord), restent du texte.
const CITED_KINDS: Record<string, MediaKind> = Object.fromEntries(Object.entries(PLAYABLE)
  .filter(([extension, kind]) => kind === 'image' || kind === 'video' || kind === 'audio' || extension === 'pdf'))
const CITED_EXTENSIONS = Object.keys(CITED_KINDS).map(caseless).join('|')
const CITED_ABSOLUTE = new RegExp(`^(?:~/|/)[^\\n\`"'<>|]*?\\.(?:${CITED_EXTENSIONS})$`)
const CITED_DIRECTORY = /^(?:~\/|\/)[^`"'<>|\n]*\/$/
const CITED_NAME = new RegExp(`^[A-Za-z0-9][^/\\\\\\s]*\\.(?:${CITED_EXTENSIONS})$`)
// `-2.jpg` après `planche-1.jpg` : la même série, abrégée par le bot.
const CITED_SUFFIX = new RegExp(`^-[A-Za-z0-9][^/\\\\\\s]*\\.(?:${CITED_EXTENSIONS})$`)
// Chemin absolu écrit en clair dans une phrase, sans espace.
const BARE_PATH = new RegExp(`(?<=^|[\\s(«"'])(?:~/|/)(?:[^\\s\`"'<>()|]+/)*[^\\s\`"'<>()|/]+?\\.(?:${CITED_EXTENSIONS})(?=[.,;:!?)»"']*(?:\\s|$))`, 'g')
const BARE_DIRECTORY = /(?<=^|[\s(«"'])(?:~\/|\/)(?:[^\s`"'<>()|]+\/)+(?=[.,;:!?)»"']*(?:\s|$))/g
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/
const CITED_LIMIT = 24

/** Blocs du message : paragraphes et éléments de liste, avec leurs lignes de suite. */
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

/** Chemins du bloc, dans l’ordre : code en ligne d’abord lu tel quel, puis chemins absolus écrits en clair. */
function blockTokens(text: string) {
  const tokens: { at: number; value: string }[] = []
  for (const match of text.matchAll(/`([^`\n]+)`/g)) if (!/^["']?MEDIA:/.test(match[1].trim())) tokens.push({ at: match.index ?? 0, value: match[1].trim() })
  // Une balise `MEDIA:` est déjà affichée à sa place, même avec des espaces dans son chemin.
  let prose = text
  for (const tag of findMediaTags(text)) prose = `${prose.slice(0, tag.start)}${' '.repeat(tag.end - tag.start)}${prose.slice(tag.end)}`
  prose = prose.replace(/`[^`\n]*`/g, (code) => ' '.repeat(code.length))
  for (const match of prose.matchAll(BARE_PATH)) tokens.push({ at: match.index ?? 0, value: match[0] })
  for (const match of prose.matchAll(BARE_DIRECTORY)) tokens.push({ at: match.index ?? 0, value: match[0] })
  return tokens.sort((a, b) => a.at - b.at).map((token) => token.value)
}

/** Dossiers d’un bloc : ceux écrits tels quels, et ceux des fichiers cités par leur chemin complet. */
function blockDirectories(tokens: string[]) {
  return [...new Set(tokens.flatMap((token) => CITED_DIRECTORY.test(token) ? [token]
    : CITED_ABSOLUTE.test(token) ? [token.slice(0, token.lastIndexOf('/') + 1)] : []))]
}

/**
 * Images, vidéos, sons et PDF qu’un bot cite par leur chemin, sans balise `MEDIA:` (« Vidéo :
 * `/…/final-v2.mp4` »). Un nom seul (`cover.jpg`) prend le dossier cité dans le même élément de liste ;
 * sinon celui du paragraphe qui précède (« dans le même dossier ») ; sinon le seul dossier du message.
 * Un dossier ambigu ne donne rien. Jamais dans un bloc de code.
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

/** Pendant le streaming, une balise sur la dernière ligne peut être coupée : on l’affiche une fois la ligne finie. */
export function withoutUnfinishedTag(text: string) {
  const lineStart = text.lastIndexOf('\n') + 1
  const at = text.slice(lineStart).search(/["'`]?MEDIA:/)
  return at < 0 ? text : text.slice(0, lineStart + at)
}

/** Nœud mdast, réduit à ce que le plugin lit et écrit. */
export interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

/** Le plugin remplit `media` à chaque passage ; les liens `#media:<index>` y renvoient. */
export interface MediaSink {
  media: MediaRef[]
}

const SKIPPED = new Set(['code', 'inlineCode', 'html', 'link', 'linkReference', 'definition'])

/**
 * Plugin remark : remplace les balises des nœuds texte par des liens `#media:<index>`.
 * Du code en ligne qui ne contient que la balise (`` `MEDIA:/a.png` ``) compte aussi.
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

const PREVIEW_LABELS: Record<MediaKind, string> = { image: 'Image', video: 'Vidéo', audio: 'Audio', document: 'Document', file: 'Fichier', link: 'Lien' }

/** Aperçu du roster : « Vidéo demo.mp4 » plutôt qu’un chemin complet. */
export function mediaPreviewText(text: string) {
  let output = ''
  let last = 0
  for (const tag of findMediaTags(text)) {
    output += `${text.slice(last, tag.start)}${PREVIEW_LABELS[tag.ref.kind]} ${tag.ref.name}${tag.punctuation}`
    last = tag.end
  }
  return output + text.slice(last)
}
