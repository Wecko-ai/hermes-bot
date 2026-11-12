import { i18n, locale } from '../i18n'

/**
 * Composer attachments: file picker, drag and drop, and paste.
 * Images the model can read go through `image.attach_bytes`, everything else through `file.attach`,
 * whose `@file:` goes into the prompt text. Same path locally and remotely: from
 * another Mac, the file does not exist on the gateway side.
 */

export const MAX_ATTACHMENTS = 10
/** Hermes’s `_ATTACHMENT_MAX_BYTES` is 256 MiB, and base64 adds a third in the WebSocket frame. */
export const MAX_FILE_BYTES = 200 * 1024 * 1024
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const VISION_IMAGE = /^image\/(png|jpeg|gif|webp)$/

export type AttachmentKind = 'image' | 'file'

export interface PendingAttachment {
  id: string
  file: File
  name: string
  size: number
  kind: AttachmentKind
  /** `blob:` thumbnail of images, released on removal or after sending. */
  previewUrl?: string
}

export function attachmentKind(file: Pick<File, 'type' | 'size'>): AttachmentKind {
  return VISION_IMAGE.test(file.type) && file.size <= MAX_IMAGE_BYTES ? 'image' : 'file'
}

export function formatBytes(bytes: number) {
  if (bytes >= 1_000_000) return i18n.t('attachments.megabytes', { value: Number((bytes / 1_000_000).toFixed(1)).toLocaleString(locale()) })
  if (bytes >= 1_000) return i18n.t('attachments.kilobytes', { value: Math.round(bytes / 1_000) })
  return i18n.t('attachments.bytes', { value: bytes })
}

/** Splits what can be sent from what is refused, with the reason to show. */
export function filterAttachments<T extends Pick<File, 'name' | 'size'>>(files: T[], existing: number) {
  const accepted: T[] = []
  const refused: string[] = []
  for (const file of files) {
    if (file.size === 0) refused.push(i18n.t('attachments.empty', { name: file.name }))
    else if (file.size > MAX_FILE_BYTES) refused.push(i18n.t('attachments.tooLarge', { name: file.name }))
    else if (existing + accepted.length >= MAX_ATTACHMENTS) refused.push(i18n.t('attachments.tooMany', { name: file.name, max: MAX_ATTACHMENTS }))
    else accepted.push(file)
  }
  return { accepted, refused }
}

export function toAttachment(file: File): PendingAttachment {
  const kind = attachmentKind(file)
  return {
    id: crypto.randomUUID(), file, name: file.name || i18n.t('attachments.fallbackName'), size: file.size, kind,
    ...(kind === 'image' ? { previewUrl: URL.createObjectURL(file) } : {}),
  }
}

/** The files of a drop. A folder drops as an empty file: it is filtered out here. */
export function droppedFiles(transfer: DataTransfer) {
  const items = Array.from(transfer.items || []).filter((item) => item.kind === 'file')
  if (!items.length) return Array.from(transfer.files || [])
  return items.flatMap((item) => {
    if (item.webkitGetAsEntry?.()?.isDirectory) return []
    const file = item.getAsFile()
    return file ? [file] : []
  })
}

export function readDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error(i18n.t('attachments.readFailed', { name: file.name })))
    reader.readAsDataURL(file)
  })
}

export const attachmentLabel = (attachment: Pick<PendingAttachment, 'name' | 'kind'>) =>
  i18n.t(attachment.kind === 'image' ? 'attachments.labelImage' : 'attachments.labelFile', { name: attachment.name })

export function defaultPrompt(attachments: Pick<PendingAttachment, 'kind'>[]) {
  if (attachments.length === 1 && attachments[0].kind === 'image') return i18n.t('attachments.promptImage')
  return i18n.t(attachments.length === 1 ? 'attachments.promptFile' : 'attachments.promptFiles')
}

// What Hermes puts in a user message sent with images: its vision note (`[The user sent an image~ …
// image_url: /path ~]`), the native `[Image attached at: /path]` hint, or `@image:/path` lines.
const IMAGE_NOTE = /\[The user sent an image[\s\S]*?image_url: (\S+?)(?: ~)?\][ \t]*(?:\n|$)/g
const IMAGE_HINT = /^\[Image attached at: ([^\n\]]+)\][ \t]*$/gm
const IMAGE_REF = /^@image:(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)[ \t]*$/gm

/** The images of a message the user sent, and its text without Hermes's notes about them. */
export function splitUserImages(text: string): { text: string; images: string[] } {
  const images: string[] = []
  const keep = (value: string) => {
    const path = /^[`"']/.test(value) ? value.slice(1, -1) : value.trim()
    if (path && !images.includes(path)) images.push(path)
    return ''
  }
  if (!/sent an image|Image attached at: |@image:/.test(text)) return { text, images }
  const rest = text
    .replace(IMAGE_NOTE, (_m, path: string) => keep(path))
    .replace(IMAGE_HINT, (_m, path: string) => keep(path))
    .replace(IMAGE_REF, (_m, path: string) => keep(path))
  return images.length ? { text: rest.replace(/\n{3,}/g, '\n\n').trim(), images } : { text, images }
}

const FILE_REF = /@file:(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)/g

/** An already-sent `@file:attachments/report.pdf` reads back as an attachment, not as a path. */
export function withoutFileRefs(text: string) {
  return text.replace(FILE_REF, (_match, value: string) => {
    const path = /^[`"']/.test(value) ? value.slice(1, -1) : value
    return i18n.t('attachments.fileRef', { name: path.split('/').filter(Boolean).at(-1) || path })
  })
}
