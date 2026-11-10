import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'
import { findMediaTags, isServablePath, mediaIndex, mediaPreviewText, mediaRef, mediaUrl, referencedFiles, remarkMedia, withoutUnfinishedTag, type MediaSink, conversationMedia } from './media'

/** Rendu Markdown réel (react-markdown + GFM + plugin) : HTML produit et médias reconnus. */
function render(text: string) {
  const sink: MediaSink = { media: [] }
  const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm, [remarkMedia, sink]] }, text))
  return { html, media: sink.media }
}

const carousel = [
  'Voici les images à valider :',
  '',
  'MEDIA:/Users/test/images/slides/01.jpg',
  'MEDIA:/Users/test/images/slides/02.jpg',
  '',
  'La v3 est prête :',
  '',
  'MEDIA:/Users/test/videos/demo.mp4',
].join('\n')

describe('médias de la conversation', () => {
  it('liste les médias du bot, du plus récent au plus ancien, sans code ni doublon', () => {
    const items = conversationMedia([
      { id: '1', role: 'assistant', content: 'MEDIA:/a/vieux.png\n\nMEDIA:/a/rapport.pdf' },
      { id: '2', role: 'user', content: 'MEDIA:/a/moi.png' },
      { id: '3', role: 'assistant', content: '```\nMEDIA:/a/exemple.png\n```\n\nMEDIA:/a/vieux.png\n\nMEDIA:/a/film.mp4\n\nMEDIA:/a/archive.zip' },
    ])
    expect(items.map((item) => item.ref.name)).toEqual(['film.mp4', 'vieux.png', 'rapport.pdf'])
    expect(items[1].version).toBe('3')
  })
})

describe('fichiers cités sans MEDIA:', () => {
  // Calqué sur un vrai rendu de bot : chemins en code, noms seuls, série abrégée, deux dossiers.
  const delivery = [
    'Orion, la v2 est prête. Je n’ai rien publié.',
    '',
    '**Fichiers** (dossier `/Users/test/essais/essai-v2/`)',
    '- Vidéo : `/Users/test/essais/essai-v2/final-v2.mp4`, md5 `8e57`. 1080x1920, 57 s.',
    '- Cover : `/Users/test/essais/essai-v2/cover-v2.jpg`.',
    '- Planches avant/après : `planche-1.jpg`, `-2.jpg` et `-3.jpg` dans le même dossier. Les md5 sont dans `md5.txt`.',
    '- À côté : `legende.txt` et `README.md`.',
    '- Originaux intacts : `final.mp4` et `cover.jpg` dans `/Users/test/archives/essai/`.',
    '',
    'Contrôle aussi /Users/test/rendus/apercu.png, et le son /Users/test/rendus/voix.m4a.',
    '',
    '```',
    'ls /Users/test/essais/essai-v2/exemple.png',
    '```',
  ].join('\n')

  it('trouve les vidéos et images à valider, dans l’ordre du message', () => {
    expect(referencedFiles(delivery).map((file) => [file.path, file.kind])).toEqual([
      ['/Users/test/essais/essai-v2/final-v2.mp4', 'video'],
      ['/Users/test/essais/essai-v2/cover-v2.jpg', 'image'],
      ['/Users/test/essais/essai-v2/planche-1.jpg', 'image'],
      ['/Users/test/essais/essai-v2/planche-2.jpg', 'image'],
      ['/Users/test/essais/essai-v2/planche-3.jpg', 'image'],
      ['/Users/test/archives/essai/final.mp4', 'video'],
      ['/Users/test/archives/essai/cover.jpg', 'image'],
      ['/Users/test/rendus/apercu.png', 'image'],
      ['/Users/test/rendus/voix.m4a', 'audio'],
    ])
  })

  it('ne devine pas un dossier ambigu, et laisse MEDIA:, le code et les notes de côté', () => {
    expect(referencedFiles('Deux dossiers `/a/un/` et `/a/deux/`.\n\nLa cover : `cover.jpg`.')).toEqual([])
    expect(referencedFiles('Un seul dossier `/a/un/`.\n\nLa cover : `cover.jpg`.').map((file) => file.path)).toEqual(['/a/un/cover.jpg'])
    expect(referencedFiles('MEDIA:/a/b.png\n\nMis à jour `/a/SOUL.md` et `/a/page.html`, `/a/../x.png`, `relatif/x.png`.')).toEqual([])
    expect(referencedFiles('Rapport : `/a/b c/rapport final.PDF`').map((file) => [file.path, file.kind])).toEqual([['/a/b c/rapport final.PDF', 'document']])
    expect(referencedFiles('Rien ici : https://exemple.com/a.png et ~/b.png').map((file) => file.path)).toEqual(['~/b.png'])
    expect(referencedFiles('MEDIA:/a/Mon Projet/dossier /thumbs/G1.jpg\n\n`MEDIA:/a/b.png`')).toEqual([])
    const sameFolder = '`/a/masters/film_v3b.mp4`\n\n- **À côté :** dans le même dossier, la v2 (`film_v2.mp4` et `…_v1.mp4`).\n\nLe reste est dans `/a/livrables/`.'
    expect(referencedFiles(sameFolder).map((file) => file.path)).toEqual(['/a/masters/film_v3b.mp4', '/a/masters/film_v2.mp4'])
  })

  it('les ajoute aux médias de la conversation, messages entre bots compris', () => {
    const items = conversationMedia([
      { id: '1', role: 'assistant', content: 'Vidéo : `/a/v.mp4`' },
      { id: '2', role: 'system', content: 'Cover : `/a/c.jpg`', agent: { kind: 'reply' } },
      { id: '3', role: 'user', content: '`/a/moi.png`' },
    ])
    expect(items.map((item) => [item.ref.name, item.version])).toEqual([['c.jpg', '2'], ['v.mp4', '1']])
  })
})

describe('médias MEDIA:', () => {
  it('transforme les lignes d’un bot en liens ordonnés, les lignes consécutives restent groupées', () => {
    const { html, media } = render(carousel)
    expect(media.map((item) => [item.name, item.kind])).toEqual([
      ['01.jpg', 'image'],
      ['02.jpg', 'image'],
      ['demo.mp4', 'video'],
    ])
    expect(html).not.toContain('MEDIA:')
    expect(html).toContain('<p><a href="#media:0">01.jpg</a>\n<a href="#media:1">02.jpg</a></p>')
    expect(html).toContain('<p><a href="#media:2">demo.mp4</a></p>')
  })

  it('garde les espaces, les majuscules et la ponctuation hors du chemin', () => {
    expect(findMediaTags('Voir MEDIA:/Users/x/slide 01.jpg. Puis valide.')[0]).toMatchObject({ ref: { path: '/Users/x/slide 01.jpg' }, punctuation: '' })
    expect(render('Voir MEDIA:/Users/x/slide 01.jpg. Puis valide.').html).toContain('<a href="#media:0">slide 01.jpg</a>. Puis valide.')
    expect(findMediaTags('MEDIA:/Users/x/Photo 1.JPG')[0].ref).toMatchObject({ path: '/Users/x/Photo 1.JPG', kind: 'image' })
    expect(render('Regarde MEDIA:/tmp/a.png, puis réponds.').html).toContain('<a href="#media:0">a.png</a>, puis réponds.')
  })

  it('accepte les guillemets autour du chemin ou de toute la balise', () => {
    expect(findMediaTags('MEDIA:"/a/b c.mp4"')[0].ref).toMatchObject({ path: '/a/b c.mp4', kind: 'video' })
    // Toute la balise, guillemets compris (16 caractères).
    expect(findMediaTags("'MEDIA:/a/b.png'")[0]).toMatchObject({ start: 0, end: 16, ref: { path: '/a/b.png' } })
    expect(render('`MEDIA:/tmp/a.png`').media.map((item) => item.path)).toEqual(['/tmp/a.png'])
  })

  it('n’avale jamais un guillemet ou un backtick qui n’a pas été ouvert', () => {
    const { html, media } = render('Lance `py MEDIA:/tmp/a.png` puis `ls`')
    expect(media).toEqual([])
    expect(html).toContain('<code>py MEDIA:/tmp/a.png</code> puis <code>ls</code>')
    expect(findMediaTags('cp MEDIA:/tmp/a.png` fin')[0].end).toBe('cp MEDIA:/tmp/a.png'.length)
  })

  it('ne touche ni au code, ni aux liens, même dans une liste ou indenté', () => {
    const text = [
      'Syntaxe :',
      '',
      '```',
      'MEDIA:/tmp/clos.png',
      '```',
      '',
      '- Exemple :',
      '',
      '      MEDIA:/tmp/indente.png',
      '',
      '[MEDIA:/tmp/lien.png](https://exemple.fr)',
      '',
      'MEDIA:/tmp/vrai.png',
    ].join('\n')
    const { html, media } = render(text)
    expect(media.map((item) => item.name)).toEqual(['vrai.png'])
    expect(html).toContain('MEDIA:/tmp/clos.png')
    expect(html).toContain('MEDIA:/tmp/indente.png')
  })

  it('rend les médias d’une citation et ne fabrique pas une image Markdown avec `!`', () => {
    expect(render('> MEDIA:/tmp/cite.png').html).toContain('<blockquote>\n<p><a href="#media:0">cite.png</a></p>\n</blockquote>')
    const bang = render('Attention !MEDIA:/tmp/a.png')
    expect(bang.media.map((item) => item.name)).toEqual(['a.png'])
    expect(bang.html).toContain('Attention !<a href="#media:0">a.png</a>')
  })

  it('reste sur la ligne de la balise et attend la fin de ligne pendant le streaming', () => {
    expect(findMediaTags('Voici MEDIA:\n/Users/x/a.png')).toEqual([])
    expect(withoutUnfinishedTag('Voici :\nMEDIA:/Users/test/pro')).toBe('Voici :\n')
    expect(withoutUnfinishedTag('Voici :\nMEDIA:/a/b.jpg\nSuite')).toBe('Voici :\nMEDIA:/a/b.jpg\nSuite')
  })

  it('ignore la prose qui ne nomme pas un fichier', () => {
    expect(findMediaTags('MEDIA: bonjour')).toEqual([])
    expect(findMediaTags('Les social media: Instagram')).toEqual([])
  })

  it('classe les fichiers selon ce que l’app sait lire', () => {
    expect(mediaRef('/a/voix.m4a').kind).toBe('audio')
    expect(mediaRef('/a/logo.svg').kind).toBe('file')
    expect(mediaRef('/a/rapport.pdf').kind).toBe('document')
    expect(mediaRef('/a/page.HTML').kind).toBe('document')
    expect(mediaRef('/a/note.md').kind).toBe('document')
    expect(mediaRef('/a/archive.zip').kind).toBe('file')
    expect(mediaRef('https://cdn.example/x.png').kind).toBe('link')
    expect(mediaRef('file:///Users/test/a%20b.jpg').path).toBe('/Users/test/a b.jpg')
  })

  it('construit une URL locale versionnée et lit les index', () => {
    expect(mediaUrl('orion', '/a/slide 01.jpg', 'm-42')).toBe('/api/media?profile=orion&path=%2Fa%2Fslide+01.jpg&v=m-42')
    expect(mediaUrl('orion', '/a/b.png')).toBe('/api/media?profile=orion&path=%2Fa%2Fb.png')
    expect(mediaIndex('#media:12')).toBe(12)
    expect(mediaIndex('https://exemple.fr')).toBe(-1)
    expect(isServablePath('~/a.png')).toBe(true)
    expect(isServablePath('a.png')).toBe(false)
  })

  it('résume les médias dans l’aperçu du roster', () => {
    expect(mediaPreviewText(carousel)).toContain('Image 01.jpg\nImage 02.jpg')
    expect(mediaPreviewText(carousel)).toContain('Vidéo demo.mp4')
    expect(mediaPreviewText('Voir MEDIA:/tmp/a.png.')).toBe('Voir Image a.png.')
  })
})
