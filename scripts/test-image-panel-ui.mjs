import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Mode Image (étape 200, Léo : « enlève Montage, on le remplace par Image comme ChatGPT »), sur le VRAI
 * composant et le vrai CSS compilé : accueil avec vignettes, dessin avec avancement et arrêt, image affichée,
 * enregistrement, suppression, et écran d'installation quand le modèle de dessin manque.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-image-panel-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import ImagePanel from './src/components/ImagePanel'

// Un vrai petit PNG (1x1), pour que <img> ait quelque chose à afficher.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqPn/HwAFAAJ/wlZ9CwAAAABJRU5ErkJggg=='
window.__calls = []
// Étape 494 : les niveaux de Z-Image que la machine fait tourner (ici une carte 8 Go : Q4 téléchargé, Q6 pas encore).
window.__status = window.__status || { supported: true, capable: true, reason: null, installed: true, qualities: [
  { id: 'q2', label: 'Q2', installed: false, downloadLabel: '2,4 Go' },
  { id: 'q4', label: 'Q4', installed: true, downloadLabel: '0 o' },
  { id: 'q6', label: 'Q6', installed: false, downloadLabel: '4,9 Go' }
] }
window.__images = window.__images || [
  { fileName: '2026-09-28T17-22-15-un-chat-sur-la-lune.png', label: 'Un chat sur la lune', timestamp: Date.now() - 60000 },
  { fileName: '2026-09-27T10-00-00-une-foret.png', label: 'Une forêt', timestamp: Date.now() - 86400000 }
]

window.jaris = {
  // __statusFails / __listFails : lectures impossibles (le test dit quand ça repasse).
  getImageStudioStatus: async () => {
    if (window.__statusFails) throw new Error("Error invoking remote method 'jaris:get-image-studio-status': Error: Le dossier du moteur d'images est verrouillé.")
    return window.__status
  },
  installImageStudio: (quality) => {
    window.__calls.push(['install', quality])
    return new Promise((resolve) => {
      window.__finishInstall = () => {
        window.__status = { ...window.__status, installed: true, qualities: window.__status.qualities.map((q) => (q.id === quality ? { ...q, installed: true } : q)) }
        resolve()
      }
    })
  },
  onImageStudioLog: (cb) => { window.__log = cb; return () => {} },
  generateStudioImage: (prompt, quality) => {
    window.__calls.push(['generate', prompt])
    window.__quality = quality
    return new Promise((resolve, reject) => {
      window.__finishGen = () => {
        const image = { fileName: '2026-09-28T18-00-00-un-phare.png', label: 'Un phare', timestamp: Date.now() }
        window.__images = [image, ...window.__images]
        resolve(image)
      }
      window.__failGen = (message) => reject(new Error(message))
    })
  },
  cancelStudioImage: () => { window.__calls.push('cancel'); window.__failGen('Dessin annulé.') },
  listGeneratedImages: async () => {
    if (window.__listFails) throw new Error("Error invoking remote method 'jaris:list-generated-images': Error: Le dossier des images est inaccessible.")
    return window.__images
  },
  readGeneratedImage: async (fileName) => { window.__calls.push(['read', fileName]); return PNG },
  deleteGeneratedImage: async (fileName) => { window.__calls.push(['delete', fileName]); window.__images = window.__images.filter((i) => i.fileName !== fileName) },
  openGeneratedImages: async (fileName) => { window.__calls.push(['open', fileName]) },
  saveGeneratedImage: async (dataUrl) => { window.__calls.push(['save', dataUrl.slice(0, 22)]); return { saved: true } },
  getProfile: async () => null
}

createRoot(document.getElementById('root')).render(<ImagePanel />)
`

let pageHtml = null

function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-image-ui-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, loader: { '.png': 'dataurl' }, outfile: bundlePath })
  } finally {
    rmSync(entryPath, { force: true })
  }
  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><style>
    html,body{margin:0;height:100%;background:#05070c;}
    #root{height:100%;display:flex;}
    ${css}
  </style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

async function withPage(run, init = '') {
  const html = buildPage()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1280, height: 860 })
    await page.setContent(init ? html.replace('<body>', `<body><script>${init}</script>`) : html)
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }
const FAKE_STORAGE = "window.__store = {}; Object.defineProperty(window, 'localStorage', { value: { getItem: (k) => (k in window.__store ? window.__store[k] : null), setItem: (k, v) => { window.__store[k] = String(v) } } });"

test('accueil : les dernières images en vignettes, la liste à gauche, le champ en bas', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.image-panel__thumb img')
    assert.equal(await page.locator('.image-panel__thumb').count(), 2)
    assert.match(await page.textContent('.workspace__new'), /Nouvelle image/i)
    assert.match(await page.textContent('.workspace__rail'), /Un chat sur la lune.*Une forêt/s)
    const composer = await page.$eval('.image-panel > .composer', (el) => el === el.parentElement.lastElementChild)
    assert.equal(composer, true, 'le champ est le dernier élément, en bas')
    assert.equal(await page.locator('.composer__plus').count(), 0, 'pas de « + » : le mode Image dessine, il ne lit rien')
  })
})

test('accueil : les créations récentes forment UNE rangée titrée, juste sous le champ, centrée (étapes 268, 427)', options, async () => {
  // Étape 268 (Léo : « c'est mal fait les vidéos créées et images ») : la galerie était repoussée tout en bas
  // de l'écran, collée à gauche, avec une image orpheline sur la dernière ligne.
  await withPage(async (page) => {
    await page.waitForSelector('.image-panel__thumb img')
    assert.match(await page.textContent('.image-panel__recent-title'), /Tes dernières images/)
    const layout = await page.evaluate(() => {
      const rect = (s) => document.querySelector(s).getBoundingClientRect()
      const visible = [...document.querySelectorAll('.image-panel__gallery li')].filter((li) => li.getBoundingClientRect().height > 0)
      const tops = new Set(visible.map((li) => Math.round(li.getBoundingClientRect().top)))
      const recent = rect('.image-panel__recent')
      // Étape 427 (comme le Chat) : la phrase, le champ, puis les créations récentes juste en dessous.
      const composer = rect('.composer')
      return {
        rows: tops.size,
        visible: visible.length,
        order: rect('.empty-state').bottom <= composer.top && composer.bottom <= recent.top,
        gap: recent.top - composer.bottom,
        offCenter: Math.abs((recent.left + recent.right) / 2 - (composer.left + composer.right) / 2)
      }
    })
    assert.equal(layout.rows, 1, 'une seule rangée')
    assert.ok(layout.visible <= 4, `au plus 4 vignettes : ${layout.visible}`)
    assert.ok(layout.order, 'la phrase, puis le champ, puis la galerie')
    assert.ok(layout.gap < 60, `trou entre le champ et la galerie : ${layout.gap}px`)
    assert.ok(layout.offCenter < 4, `galerie décentrée de ${layout.offCenter}px`)
  }, "window.__images = Array.from({ length: 7 }, (_, i) => ({ fileName: i + '.png', label: 'Image ' + i, timestamp: Date.now() - i * 1000 }))")
})

test('dessiner : avancement avec barre, puis l’image s’affiche et rejoint la liste', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.composer__input')
    await page.fill('.composer__input', 'un phare sous la tempête')
    await page.click('.composer__send')
    assert.deepEqual((await page.evaluate(() => window.__calls)).find((c) => Array.isArray(c) && c[0] === 'generate'), ['generate', 'un phare sous la tempête'])
    await page.evaluate(() => window.__log('Dessin : étape 2 sur 4'))
    await page.waitForFunction(() => /Étape 2 sur 4/.test(document.querySelector('.media-pending').textContent))
    assert.equal(await page.$eval('.media-pending__bar-fill', (el) => el.style.width), '50%')

    await page.evaluate(() => window.__finishGen())
    await page.waitForSelector('.image-panel__image')
    // L'image prend la place du cadre d'attente : plus de bandeau vert « Terminé… ».
    assert.equal(await page.locator('.code-panel__done').count(), 0)
    assert.equal(await page.locator('.media-pending').count(), 0)
    // Étape 271 : plus de titre répété au-dessus de l'image (l'en-tête de la fenêtre le donne).
    assert.match(await page.textContent('.workspace__item--active'), /Un phare/)
    assert.equal(await page.locator('.image-panel__title').count(), 0)
    assert.match(await page.textContent('.workspace__rail'), /Un phare/)
    // Mesure une fois l'image décodée ET mise à sa taille finale : sous charge (suite complète), la mesure tombait
    // parfois entre les deux, à 1x1. Si elle n'atteint jamais sa taille, l'attente échoue : le test garde son mordant.
    await page.waitForFunction(() => {
      const el = document.querySelector('.image-panel__image')
      return el && el.complete && el.naturalWidth > 0 && el.getBoundingClientRect().width > 200
    })
    const image = await page.$eval('.image-panel__image', (el) => { const r = el.getBoundingClientRect(); return { w: r.width, h: r.height, fit: getComputedStyle(el).objectFit } })
    assert.equal(image.fit, 'contain', 'image entière, jamais rognée')
    // Étape 271 : agrandie à toute la place disponible (l'image de test fait 1 px), sans être déformée.
    assert.ok(image.w > 200 && Math.abs(image.w - image.h) < 2, `image affichée en ${Math.round(image.w)}x${Math.round(image.h)}`)
  })
})

test('pendant le dessin : l’attente au CENTRE, le champ en BAS — plus rien de collé en haut (étape 291)', options, async () => {
  // Léo, capture à l'appui : « image c'est une catastrophe le design, pourquoi c'est tout en haut » — le bandeau
  // « Préparation du dessin… [Arrêter] » en haut, le champ juste dessous, et tout le reste de l'écran vide.
  await withPage(async (page) => {
    await page.waitForSelector('.composer__input')
    await page.fill('.composer__input', 'un chat')
    await page.click('.composer__send')
    await page.waitForSelector('.media-pending')
    assert.equal(await page.locator('.code-panel__live').count(), 0, 'le bandeau en haut est revenu')
    // Comme ChatGPT : le champ est vidé, la demande rappelée au-dessus du cadre.
    assert.equal(await page.inputValue('.composer__input'), '')
    assert.equal(await page.textContent('.media-pending__prompt'), 'un chat')
    assert.match(await page.textContent('.media-pending'), /Création de l'image…/)
    const layout = await page.evaluate(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect()
      const panel = box('.image-panel')
      const frame = box('.media-pending__frame')
      const composer = box('.image-panel > .composer')
      return {
        composerAtBottom: Math.abs(panel.bottom - composer.bottom) < 24,
        frameAboveComposer: frame.bottom <= composer.top,
        // Le cadre est centré dans la place au-dessus du champ (au pixel près, à 40 px près).
        frameCentered: Math.abs((frame.top + frame.bottom) / 2 - (panel.top + composer.top) / 2) < 40,
        frameIsSquare: Math.abs(frame.width - frame.height) < 2 && frame.width > 200
      }
    })
    assert.deepEqual(layout, { composerAtBottom: true, frameAboveComposer: true, frameCentered: true, frameIsSquare: true })
  })
})

test('on arrête par le bouton du champ, comme dans le Chat : c’est dit sans erreur rouge, et la demande revient', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.composer__input')
    await page.fill('.composer__input', 'un dragon')
    await page.click('.composer__send')
    await page.waitForSelector('.media-pending')
    assert.equal(await page.locator('.code-panel__live-stop').count(), 0, 'le bouton « Arrêter » à part est revenu')
    await page.click('.composer__send--stop')
    await page.waitForSelector('.media-note')
    assert.match(await page.textContent('.media-note'), /^Dessin arrêté après \d+ s\.$/)
    assert.equal(await page.locator('.code-panel__error').count(), 0)
    assert.equal(await page.inputValue('.composer__input'), 'un dragon')
  })
})

test('ouvrir une image : Enregistrer (habillé par le CSS) et Ouvrir le dossier ; supprimer demande confirmation', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.image-panel__thumb img')
    await page.click('.image-panel__thumb >> nth=0')
    await page.waitForSelector('.image-panel__image')
    const save = await page.$eval('.image-panel__save', (el) => getComputedStyle(el).borderTopLeftRadius)
    assert.equal(save, '9999px', 'bouton de la famille de Jaris (pilule, style ChatGPT, étape 266)')
    await page.click('.image-panel__save')
    await page.waitForFunction(() => /Enregistrée/.test(document.querySelector('.image-panel__save').textContent))
    await page.click('text=Ouvrir le dossier')
    assert.deepEqual((await page.evaluate(() => window.__calls)).at(-1), ['open', '2026-09-28T17-22-15-un-chat-sur-la-lune.png'])

    await page.hover('.workspace__item >> nth=0')
    await page.click('.workspace__delete >> nth=0')
    assert.equal((await page.evaluate(() => window.__calls)).some((c) => Array.isArray(c) && c[0] === 'delete'), false, 'rien de supprimé sans confirmation')
    await page.click('.workspace__confirm-yes')
    await page.waitForFunction(() => !/Un chat sur la lune/.test(document.querySelector('.workspace__rail').textContent))
    assert.equal(await page.locator('.image-panel__image').count(), 0, 'l’image supprimée ne reste pas affichée')
  })
})

const NOTHING_INSTALLED =
  "window.__status = { supported: true, capable: true, reason: null, installed: false, qualities: [{ id: 'q2', label: 'Q2', installed: false, downloadLabel: '5,3 Go' }, { id: 'q4', label: 'Q4', installed: false, downloadLabel: '6,6 Go' }, { id: 'q6', label: 'Q6', installed: false, downloadLabel: '8 Go' }] }"

test('modèle de dessin absent : on choisit le niveau AVANT de télécharger, la taille suit, rien sans clic (étape 494)', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.image-install__card')
    // Par défaut le plus fidèle que la machine fait tourner (ici Q6).
    assert.match(await page.textContent('.image-install__card'), /8 Go à télécharger/)
    assert.match(await page.textContent('.image-install__button'), /Installer la qualité Q6/)
    assert.deepEqual(await page.evaluate(() => window.__calls), [])
    await page.click('.image-install__card .quality-picker .effort-picker__trigger')
    assert.equal(await page.locator('.quality-picker .effort-picker__step').count(), 3, 'Q2, Q4, Q6 : les niveaux de cette machine')
    assert.equal(await page.getAttribute('.effort-picker__panel', 'aria-label'), "Qualité de l'image", 'pas « Qualité de la vidéo »')
    assert.equal(await page.locator('.quality-picker__download').count(), 0, 'l’écran d’installation a déjà son bouton')
    await page.click('.quality-picker .effort-picker__step >> nth=1')
    assert.match(await page.textContent('.image-install__card'), /6,6 Go à télécharger/)
    await page.click('.image-install__button')
    assert.deepEqual((await page.evaluate(() => window.__calls)).find((c) => c[0] === 'install'), ['install', 'q4'])
    await page.evaluate(() => window.__log('Téléchargement de le modèle de dessin (Z-Image-Turbo) : 40 %'))
    await page.waitForFunction(() => /40 %/.test(document.body.textContent))
    await page.evaluate(() => window.__finishInstall())
    await page.waitForSelector('.image-panel > .composer')
  }, NOTHING_INSTALLED)
})

test('niveau (étape 494) : le plus fidèle déjà téléchargé par défaut, envoyé avec la demande', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.quality-picker .effort-picker__trigger')
    assert.match(await page.textContent('.quality-picker .effort-picker__trigger'), /Q4/, 'Q6 n’est pas téléchargé : Q4 par défaut')
    await page.fill('.composer__input', 'un phare')
    await page.click('.composer__send')
    await page.waitForFunction(() => window.__quality !== undefined)
    assert.equal(await page.evaluate(() => window.__quality), 'q4')
  })
})

test('niveau : un niveau absent se télécharge depuis son bouton ; sans lui, aucun dessin n’est lancé', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.quality-picker .effort-picker__trigger')
    await page.click('.quality-picker .effort-picker__trigger')
    assert.equal(await page.locator('.quality-picker .effort-picker__step').count(), 3)
    assert.equal(await page.locator('.quality-picker__download').count(), 0, 'Q4 est déjà là')
    await page.click('.quality-picker .effort-picker__step >> nth=2')
    assert.match(await page.textContent('.quality-picker .effort-picker__current'), /Qualité Q6/)
    assert.match(await page.textContent('.quality-picker__download'), /Télécharger \(4,9 Go\)/)

    await page.keyboard.press('Escape')
    await page.fill('.composer__input', 'la mer')
    await page.click('.composer__send')
    await page.waitForSelector('.code-panel__error')
    assert.match(await page.textContent('.code-panel__error'), /qualité Q6 n'est pas encore téléchargée/)
    assert.equal((await page.evaluate(() => window.__calls)).some((c) => c[0] === 'generate'), false)

    await page.click('.quality-picker .effort-picker__trigger')
    await page.click('.quality-picker__download')
    assert.deepEqual((await page.evaluate(() => window.__calls)).find((c) => c[0] === 'install'), ['install', 'q6'])
    await page.waitForFunction(() => /Téléchargement de la qualité Q6/.test(document.querySelector('.media-pending')?.textContent ?? ''))
    assert.equal(await page.locator('.image-panel__recent').count(), 0, 'pendant le téléchargement, l’attente seule au centre')
    await page.evaluate(() => window.__finishInstall())
    await page.waitForFunction(() => !document.querySelector('.media-pending'))
    await page.click('.composer__send')
    await page.waitForFunction(() => window.__quality !== undefined)
    assert.equal(await page.evaluate(() => window.__quality), 'q6')
    assert.equal(await page.evaluate(() => window.__store['jaris.imageQuality']), 'q6', 'retrouvé à la prochaine ouverture')
  }, FAKE_STORAGE)
})

test('niveau : un choix gardé que la machine ne propose plus est ignoré', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.quality-picker .effort-picker__trigger')
    assert.match(await page.textContent('.quality-picker .effort-picker__trigger'), /Q4/)
  }, FAKE_STORAGE + "window.__store['jaris.imageQuality'] = 'q8'")
})

test('niveau : le champ et son bouton tiennent dans une fenêtre de 760 px, sans débordement', options, async () => {
  await withPage(async (page) => {
    await page.setViewportSize({ width: 760, height: 700 })
    await page.waitForSelector('.quality-picker .effort-picker__trigger')
    const box = await page.evaluate(() => {
      const composer = document.querySelector('.image-panel > .composer').getBoundingClientRect()
      const trigger = document.querySelector('.quality-picker .effort-picker__trigger').getBoundingClientRect()
      return { overflow: document.documentElement.scrollWidth - innerWidth, inside: trigger.left >= composer.left && trigger.right <= composer.right, height: trigger.height }
    })
    assert.ok(box.overflow <= 0, `la page déborde de ${box.overflow}px`)
    assert.ok(box.inside, 'le bouton de niveau sort du champ')
    assert.ok(box.height > 0)
  })
})

test('PC pas assez puissant : la raison, et aucun bouton d’installation', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.image-install__card')
    assert.match(await page.textContent('.image-install__card'), /pas assez de puissance.*carte graphique trop petite/)
    assert.equal(await page.locator('.image-install__button').count(), 0)
  }, "window.__status = { supported: true, capable: false, reason: 'carte graphique trop petite (3 Go de VRAM, il en faut 4 ou plus)', installed: false, qualities: [] }")
})

// Étape 354 (design) : depuis l'étape 282 (.code-panel { padding: 0 } pour le mode Code), le champ de saisie des
// écrans Image et Vidéo touchait le bas de la fenêtre, coins arrondis coupés.
test('le champ de saisie garde sa marge en bas de l’écran (étape 354)', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.image-panel > .composer')
    const gap = await page.evaluate(() => innerHeight - document.querySelector('.image-panel > .composer').getBoundingClientRect().bottom)
    assert.ok(gap >= 12, `le champ est à ${gap}px du bas de la fenêtre`)
  })
})

// Jusqu'à la version 0.49.1, ces lectures n'avaient pas de « catch » : un échec laissait le mode Image vide pour toujours.
test('état du mode Image illisible : le vrai message et « Réessayer », jamais un écran vide', options, async () => {
  await withPage(async (page) => {
    const alert = page.locator('.image-panel [role="alert"]')
    await alert.waitFor()
    assert.equal(await alert.textContent(), "Le dossier du moteur d'images est verrouillé.")
    await page.evaluate(() => (window.__statusFails = false))
    await page.getByRole('button', { name: 'Réessayer' }).click()
    await page.waitForSelector('.image-panel__thumb img')
  }, 'window.__statusFails = true')
})

test('galerie d’images illisible : le vrai message s’affiche au lieu d’une galerie vide en silence', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.composer')
    await page.waitForFunction(() => /Le dossier des images est inaccessible\./.test(document.querySelector('.image-panel')?.textContent ?? ''))
  }, 'window.__listFails = true')
})
