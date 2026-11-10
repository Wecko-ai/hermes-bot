import { describe, expect, it } from 'vitest'
import { attachmentKind, attachmentLabel, defaultPrompt, filterAttachments, formatBytes, MAX_ATTACHMENTS, MAX_FILE_BYTES, withoutFileRefs } from './attachments'

describe('pièces jointes', () => {
  it('garde les images lisibles par le modèle, envoie le reste en fichier', () => {
    expect(attachmentKind({ type: 'image/png', size: 1000 })).toBe('image')
    expect(attachmentKind({ type: 'image/heic', size: 1000 })).toBe('file')
    expect(attachmentKind({ type: 'image/png', size: 17 * 1024 * 1024 })).toBe('file')
    expect(attachmentKind({ type: 'video/mp4', size: 1000 })).toBe('file')
    expect(attachmentKind({ type: 'application/pdf', size: 1000 })).toBe('file')
  })

  it('refuse les fichiers vides, trop gros et au-delà du maximum, en disant pourquoi', () => {
    const { accepted, refused } = filterAttachments([
      { name: 'ok.mp4', size: 10 },
      { name: 'vide.txt', size: 0 },
      { name: 'enorme.mov', size: MAX_FILE_BYTES + 1 },
    ], 0)
    expect(accepted.map((file) => file.name)).toEqual(['ok.mp4'])
    expect(refused).toEqual(['vide.txt est vide', 'enorme.mov dépasse 200 Mo'])
    expect(filterAttachments([{ name: 'trop.png', size: 1 }], MAX_ATTACHMENTS).refused).toEqual(['trop.png : 10 fichiers maximum'])
  })

  it('formate tailles et libellés', () => {
    expect(formatBytes(512)).toBe('512 o')
    expect(formatBytes(12_400)).toBe('12 ko')
    expect(formatBytes(3_250_000)).toBe('3,3 Mo')
    expect(attachmentLabel({ name: 'a.pdf', kind: 'file' })).toBe('[Fichier : a.pdf]')
    expect(defaultPrompt([{ kind: 'image' }])).toBe('Analyse cette image.')
    expect(defaultPrompt([{ kind: 'file' }, { kind: 'image' }])).toBe('Regarde ces fichiers.')
  })

  it('relit les @file: comme des pièces jointes', () => {
    expect(withoutFileRefs('Vois\n\n@file:attachments/rapport.pdf')).toBe('Vois\n\n[Fichier : rapport.pdf]')
    expect(withoutFileRefs('@file:`attachments/mon film.mp4`')).toBe('[Fichier : mon film.mp4]')
    expect(withoutFileRefs('rien ici')).toBe('rien ici')
  })
})
