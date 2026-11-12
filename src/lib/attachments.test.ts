import { describe, expect, it } from 'vitest'
import { attachmentKind, attachmentLabel, defaultPrompt, filterAttachments, formatBytes, MAX_ATTACHMENTS, MAX_FILE_BYTES, splitUserImages, withoutFileRefs } from './attachments'

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

  it('sort les images envoyées des notes que Hermes ajoute au message', () => {
    const note = "[The user sent an image~ Here's what I can see:\n# Écran\n\nUn bouton [Send].]\n[If you need a closer look, use vision_analyze with image_url: /h/cache/upload_a.png ~]\n\nje veux ça"
    expect(splitUserImages(note)).toEqual({ text: 'je veux ça', images: ['/h/cache/upload_a.png'] })
    const failed = '[The user sent an image but I couldn\'t quite see it this time (>_<) You can try looking at it yourself with vision_analyze using image_url: /h/b.jpg]\n\nregarde'
    expect(splitUserImages(failed)).toEqual({ text: 'regarde', images: ['/h/b.jpg'] })
    expect(splitUserImages('Vois\n\n@image:/h/c.png\n@image:`/h/mon d.png`')).toEqual({ text: 'Vois', images: ['/h/c.png', '/h/mon d.png'] })
    expect(splitUserImages('Vois\n\n[Image attached at: /h/e.webp]')).toEqual({ text: 'Vois', images: ['/h/e.webp'] })
    expect(splitUserImages('écris @image:/x.png dans le texte')).toEqual({ text: 'écris @image:/x.png dans le texte', images: [] })
  })
})
