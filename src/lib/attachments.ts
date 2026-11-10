/**
 * Pièces jointes du composer : choix du fichier, glisser-déposer et collage.
 * Les images lisibles par le modèle passent par `image.attach_bytes`, tout le reste par `file.attach`,
 * dont le `@file:` part dans le texte du prompt. Même chemin en local et à distance : depuis
 * un autre Mac, le fichier n’existe pas côté gateway.
 */

export const MAX_ATTACHMENTS = 10
/** `_ATTACHMENT_MAX_BYTES` de Hermes vaut 256 Mio, et le base64 ajoute un tiers dans la trame WebSocket. */
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
  /** Vignette `blob:` des images, libérée au retrait ou après l’envoi. */
  previewUrl?: string
}

export function attachmentKind(file: Pick<File, 'type' | 'size'>): AttachmentKind {
  return VISION_IMAGE.test(file.type) && file.size <= MAX_IMAGE_BYTES ? 'image' : 'file'
}

export function formatBytes(bytes: number) {
  if (bytes >= 1_000_000) return `${Number((bytes / 1_000_000).toFixed(1)).toLocaleString('fr-FR')} Mo`
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} ko`
  return `${bytes} o`
}

/** Sépare ce qui peut partir de ce qui est refusé, avec la raison à montrer. */
export function filterAttachments<T extends Pick<File, 'name' | 'size'>>(files: T[], existing: number) {
  const accepted: T[] = []
  const refused: string[] = []
  for (const file of files) {
    if (file.size === 0) refused.push(`${file.name} est vide`)
    else if (file.size > MAX_FILE_BYTES) refused.push(`${file.name} dépasse 200 Mo`)
    else if (existing + accepted.length >= MAX_ATTACHMENTS) refused.push(`${file.name} : ${MAX_ATTACHMENTS} fichiers maximum`)
    else accepted.push(file)
  }
  return { accepted, refused }
}

export function toAttachment(file: File): PendingAttachment {
  const kind = attachmentKind(file)
  return {
    id: crypto.randomUUID(), file, name: file.name || 'fichier', size: file.size, kind,
    ...(kind === 'image' ? { previewUrl: URL.createObjectURL(file) } : {}),
  }
}

/** Les fichiers d’un dépôt. Un dossier se dépose comme un fichier vide : il est écarté ici. */
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
    reader.onerror = () => reject(new Error(`Lecture impossible : ${file.name}`))
    reader.readAsDataURL(file)
  })
}

export const attachmentLabel = (attachment: Pick<PendingAttachment, 'name' | 'kind'>) =>
  `[${attachment.kind === 'image' ? 'Image' : 'Fichier'} : ${attachment.name}]`

export function defaultPrompt(attachments: Pick<PendingAttachment, 'kind'>[]) {
  if (attachments.length === 1 && attachments[0].kind === 'image') return 'Analyse cette image.'
  return attachments.length === 1 ? 'Regarde ce fichier.' : 'Regarde ces fichiers.'
}

const FILE_REF = /@file:(`[^`\n]+`|"[^"\n]+"|'[^'\n]+'|\S+)/g

/** Un `@file:attachments/rapport.pdf` déjà envoyé se relit comme une pièce jointe, pas comme un chemin. */
export function withoutFileRefs(text: string) {
  return text.replace(FILE_REF, (_match, value: string) => {
    const path = /^[`"']/.test(value) ? value.slice(1, -1) : value
    return `[Fichier : ${path.split('/').filter(Boolean).at(-1) || path}]`
  })
}
