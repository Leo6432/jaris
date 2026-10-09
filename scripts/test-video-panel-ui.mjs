import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Mode Vidéo (étape 203, Wan 2.2 TI2V 5B), sur le VRAI composant et le vrai CSS compilé : même présentation que le
 * mode Image, création avec avancement et arrêt, lecteur vidéo, image jointe à animer, et écran d'installation
 * (le modèle, 10,3 Go en Q6, ne s'installe qu'à la demande), et qualité Q6/Q8 limitée à ce que la machine peut faire
 * tourner (étape 205).
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-video-panel-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import VideoPanel from './src/components/VideoPanel'

window.__calls = []
const Q = (id, installed, downloadLabel) => ({ id, label: id.toUpperCase(), installed, downloadLabel })
window.__Q = Q
// Par défaut : une carte de 12 Go avec 32 Go de RAM — Q6 installée, Q8 possible mais pas encore téléchargée.
window.__status = window.__status || { supported: true, capable: true, reason: null, qualities: [Q('q6', true, '0 o'), Q('q8', false, '11,5 Go')] }
window.__videos = window.__videos || [
  { fileName: '2026-09-28T17-22-15-la-mer.webm', label: 'La mer', timestamp: Date.now() - 60000 }
]

window.jaris = {
  getVideoStudioStatus: async () => window.__status,
  installVideoStudio: (quality) => {
    window.__calls.push(['install', quality])
    return new Promise((resolve) => {
      window.__finishInstall = () => {
        window.__status = { ...window.__status, qualities: window.__status.qualities.map((q) => (q.id === quality ? { ...q, installed: true } : q)) }
        resolve()
      }
    })
  },
  onVideoStudioLog: (cb) => { window.__log = cb; return () => {} },
  generateStudioVideo: (prompt, image, seconds, quality) => {
    window.__calls.push(['generate', prompt, image ? image.mimeType : null])
    window.__seconds = seconds
    window.__quality = quality
    return new Promise((resolve, reject) => {
      window.__finishGen = () => {
        const video = { fileName: '2026-09-28T18-00-00-un-chat.webm', label: 'Un chat', timestamp: Date.now() }
        window.__videos = [video, ...window.__videos]
        resolve(video)
      }
      window.__failGen = (message) => reject(new Error(message))
    })
  },
  cancelStudioVideo: () => { window.__calls.push('cancel'); window.__failGen('Vidéo annulée.') },
  listGeneratedVideos: async () => window.__videos,
  readGeneratedVideo: async (fileName) => { window.__calls.push(['read', fileName]); return window.__realVideo || new Uint8Array([26, 69, 223, 163]) },
  deleteGeneratedVideo: async (fileName) => { window.__calls.push(['delete', fileName]); window.__videos = window.__videos.filter((v) => v.fileName !== fileName) },
  openGeneratedVideos: async (fileName) => { window.__calls.push(['open', fileName]) },
  saveGeneratedVideo: async (fileName) => { window.__calls.push(['save', fileName]); return { saved: true } },
  // Un vrai petit PNG (1x1) « choisi » dans le sélecteur natif.
  pickImageFile: async () => ({ name: 'chat.png', type: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkqPn/HwAFAAJ/wlZ9CwAAAABJRU5ErkJggg==' }),
  getProfile: async () => null
}

createRoot(document.getElementById('root')).render(<VideoPanel />)
`

let pageHtml = null

function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-video-ui-'))
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

// La page de test (about:blank) interdit localStorage : les autres tests prouvent déjà que l'écran s'en passe.
const FAKE_STORAGE = "window.__store = {}; Object.defineProperty(window, 'localStorage', { value: { getItem: (k) => (k in window.__store ? window.__store[k] : null), setItem: (k, v) => { window.__store[k] = String(v) } } });"

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('accueil : même présentation que le mode Image (liste à gauche, champ en bas, « + » pour joindre une image)', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.composer__input')
    assert.match(await page.textContent('.workspace__new'), /Nouvelle vidéo/i)
    assert.match(await page.textContent('.workspace__rail'), /La mer/)
    const last = await page.$eval('.video-panel > .composer', (el) => el === el.parentElement.lastElementChild)
    assert.equal(last, true, 'le champ est en bas')
    assert.equal(await page.locator('.composer__plus').count(), 1, 'une image peut être jointe pour l’animer')
  })
})

test('accueil (étape 213) : les dernières vidéos en vignettes, comme les images ; un clic ouvre, supprimer retire la vignette', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.video-panel__thumb video')
    const count = await page.evaluate(() => window.__videos.length)
    assert.ok(count >= 1)
    assert.equal(await page.locator('.video-panel__thumb').count(), count, 'une vignette par vidéo')
    assert.match(await page.$eval('.video-panel__thumb video', (v) => v.src), /^blob:/, 'la vraie vidéo, chargée localement')
    assert.equal(await page.$eval('.video-panel__thumb video', (v) => v.muted), true, 'jamais de son en survolant la galerie')
    // Habillée par le CSS compilé (format vidéo, pas le carré des images) et avec son symbole « lecture ».
    const box = await page.$eval('.video-panel__thumb', (el) => el.getBoundingClientRect())
    assert.ok(box.width > box.height * 1.5, `vignette au format vidéo (${box.width}x${box.height})`)
    assert.equal(await page.locator('.video-panel__thumb-play').count(), count)

    const first = await page.evaluate(() => window.__videos[0])
    await page.click('.video-panel__thumb')
    await page.waitForSelector('.image-panel__result')
    // Étape 271 : le titre n'est plus répété au-dessus de la vidéo (l'en-tête de la fenêtre le donne) ;
    // la vidéo ouverte est la ligne active de la liste.
    assert.equal((await page.textContent('.workspace__item--active .workspace__item-title')).trim(), first.label, 'le clic ouvre cette vidéo')
    assert.equal(await page.locator('.image-panel__title').count(), 0, 'titre répété au-dessus de la vidéo')

    await page.click('.workspace__new')
    await page.waitForSelector('.video-panel__thumb')
    await page.click('.workspace__delete >> nth=0')
    await page.click('.workspace__confirm-yes')
    await page.waitForFunction((n) => document.querySelectorAll('.video-panel__thumb').length === n - 1, count)
    assert.deepEqual((await page.evaluate(() => window.__calls)).find((c) => Array.isArray(c) && c[0] === 'delete'), ['delete', first.fileName])
  })
})

test('créer : avancement avec barre, puis la vidéo se lit et rejoint la liste', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.composer__input')
    await page.fill('.composer__input', 'un chat roux marche dans la neige')
    await page.click('.composer__send')
    assert.deepEqual((await page.evaluate(() => window.__calls)).find((c) => Array.isArray(c) && c[0] === 'generate'), ['generate', 'un chat roux marche dans la neige', null])
    await page.evaluate(() => window.__log('Vidéo : étape 5 sur 20'))
    await page.waitForFunction(() => /Vidéo : étape 5 sur 20/.test(document.querySelector('.code-panel__live').textContent))
    assert.equal(await page.$eval('.image-panel__progress .options-menu__progress-bar-fill', (el) => el.style.width), '25%')

    await page.evaluate(() => window.__finishGen())
    await page.waitForSelector('video.video-panel__video')
    assert.match(await page.textContent('.code-panel__done'), /ta vidéo est prête/)
    assert.match(await page.textContent('.workspace__rail'), /Un chat/)
    const video = await page.$eval('video.video-panel__video', (el) => ({ src: el.src, controls: el.controls, loop: el.loop, fit: getComputedStyle(el).objectFit }))
    assert.match(video.src, /^blob:/, 'lue depuis des octets locaux, jamais un chemin de fichier')
    assert.equal(video.controls, true)
    assert.equal(video.fit, 'contain')

    await page.click('.image-panel__save')
    await page.waitForFunction(() => /Enregistrée/.test(document.querySelector('.image-panel__save').textContent))
    assert.ok((await page.evaluate(() => window.__calls)).some((c) => Array.isArray(c) && c[0] === 'save' && c[1] === '2026-09-28T18-00-00-un-chat.webm'))
  })
})

test('lecteur : la vidéo prend toute la place à ses proportions, sans cadre autour', options, async () => {
  // Étape 271 (Léo : « c'est mal présenté les vidéos ») : elle restait à sa taille d'origine au milieu d'un grand
  // cadre vide. Une vraie petite vidéo (320x180, fabriquée ici) est lue pour mesurer sa taille affichée.
  await withPage(async (page) => {
    await page.waitForSelector('.video-panel__thumb')
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 180
      const g = canvas.getContext('2d')
      const timer = setInterval(() => { g.fillStyle = `hsl(${Math.random() * 360} 60% 50%)`; g.fillRect(0, 0, 320, 180) }, 50)
      const recorder = new MediaRecorder(canvas.captureStream(15), { mimeType: 'video/webm' })
      const chunks = []
      recorder.ondataavailable = (e) => chunks.push(e.data)
      const stopped = new Promise((r) => (recorder.onstop = r))
      recorder.start()
      await new Promise((r) => setTimeout(r, 800))
      recorder.stop()
      await stopped
      clearInterval(timer)
      window.__realVideo = new Uint8Array(await new Blob(chunks).arrayBuffer())
    })
    await page.click('.video-panel__thumb')
    await page.waitForFunction(() => document.querySelector('video.video-panel__video')?.videoWidth > 0)
    await page.waitForTimeout(100)
    const m = await page.evaluate(() => {
      const v = document.querySelector('video.video-panel__video').getBoundingClientRect()
      const stage = document.querySelector('.image-panel__stage').getBoundingClientRect()
      const frame = getComputedStyle(document.querySelector('.image-panel__result'))
      return { w: v.width, h: v.height, stageW: stage.width, stageH: stage.height, inside: v.left >= stage.left - 1 && v.right <= stage.right + 1 && v.top >= stage.top - 1 && v.bottom <= stage.bottom + 1, frameBorder: frame.borderTopWidth, frameBg: frame.backgroundColor }
    })
    assert.ok(m.w > 320 * 1.5, `vidéo restée petite : ${Math.round(m.w)} px de large`)
    assert.ok(Math.abs(m.w / m.h - 16 / 9) < 0.03, `proportions déformées : ${Math.round(m.w)}x${Math.round(m.h)}`)
    assert.ok(m.inside, 'la vidéo dépasse de sa place')
    assert.ok(m.w >= m.stageW - 2 || m.h >= m.stageH - 2, 'la vidéo ne remplit ni la largeur ni la hauteur disponibles')
    assert.equal(m.frameBorder, '0px', 'cadre autour de la vidéo')
    assert.match(m.frameBg, /rgba\(0, 0, 0, 0\)|transparent/, 'fond de cadre autour de la vidéo')
  })
})

test('image jointe : envoyée avec la description pour être animée', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.composer__plus')
    await page.click('.composer__plus')
    await page.getByText('Joindre une image').click()
    await page.waitForFunction(() => /mouvement/.test(document.querySelector('.composer__input').placeholder))
    await page.fill('.composer__input', 'le chat se met à marcher')
    await page.click('.composer__send')
    const call = (await page.evaluate(() => window.__calls)).find((c) => Array.isArray(c) && c[0] === 'generate')
    assert.equal(call[1], 'le chat se met à marcher')
    assert.match(call[2], /^image\//, 'le type de l’image jointe est transmis')
  })
})

test('« Arrêter » interrompt la vidéo et le dit, sans erreur rouge', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.composer__input')
    await page.fill('.composer__input', 'un dragon')
    await page.click('.composer__send')
    await page.click('.code-panel__live-stop')
    await page.waitForSelector('.code-panel__done--stopped')
    assert.match(await page.textContent('.code-panel__done'), /Vidéo arrêtée/)
    assert.equal(await page.locator('.code-panel__error').count(), 0)
  })
})

test('modèle absent : on choisit la qualité AVANT de télécharger, la taille suit le choix, puis la création s’ouvre', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForSelector('.image-install__button')
      // Par défaut la plus fidèle que la machine peut faire tourner (ici Q8).
      assert.match(await page.textContent('.image-install__button'), /Installer la qualité Q8/)
      assert.match(await page.textContent('.image-install__card'), /12,9 Go à télécharger.*plusieurs minutes\s+par vidéo/s)
      assert.equal(await page.locator('.composer').count(), 0)
      await page.click('.image-install__card .quality-picker .effort-picker__trigger')
      assert.equal(await page.locator('.quality-picker .effort-picker__step').count(), 2, 'Q6 et Q8 : les deux crans de cette machine')
      assert.equal(await page.locator('.quality-picker__download').count(), 0, 'l’écran d’installation a déjà son bouton')
      await page.click('.quality-picker .effort-picker__step >> nth=0')
      assert.match(await page.textContent('.image-install__card'), /10,3 Go à télécharger/)
      await page.click('.image-install__button')
      assert.deepEqual((await page.evaluate(() => window.__calls)).find((c) => c[0] === 'install'), ['install', 'q6'])
      await page.evaluate(() => window.__finishInstall())
      await page.waitForSelector('.composer__input')
    },
    "window.__status = { supported: true, capable: true, reason: null, qualities: [{ id: 'q6', label: 'Q6', installed: false, downloadLabel: '10,3 Go' }, { id: 'q8', label: 'Q8', installed: false, downloadLabel: '12,9 Go' }] }"
  )
})

test('qualité (étape 205) : barre limitée à la machine, une qualité absente se télécharge depuis son panneau', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.quality-picker .effort-picker__trigger')
    assert.match(await page.textContent('.quality-picker .effort-picker__trigger'), /Q6/, 'la qualité déjà téléchargée par défaut')
    await page.click('.quality-picker .effort-picker__trigger')
    assert.equal(await page.locator('.quality-picker .effort-picker__step').count(), 2)
    assert.equal(await page.locator('.quality-picker__download').count(), 0, 'Q6 est déjà là')
    await page.click('.quality-picker .effort-picker__step >> nth=1')
    assert.match(await page.textContent('.quality-picker .effort-picker__current'), /Qualité Q8/)
    // Le bouton de téléchargement est habillé par la famille « Installer », pas laissé au style du navigateur.
    const button = await page.$eval('.quality-picker__download', (el) => ({ text: el.textContent, radius: getComputedStyle(el).borderTopLeftRadius, color: getComputedStyle(el).color }))
    assert.match(button.text, /Télécharger \(11,5 Go\)/)
    assert.equal(button.radius, '9999px', 'pilule de la famille de boutons (style ChatGPT, étape 266)')
    assert.notEqual(button.color, 'rgb(0, 0, 0)')

    // Envoyer avec une qualité pas encore téléchargée : message clair, aucune génération lancée.
    await page.keyboard.press('Escape')
    await page.fill('.composer__input', 'la mer')
    await page.click('.composer__send')
    await page.waitForSelector('.code-panel__error')
    assert.match(await page.textContent('.code-panel__error'), /qualité Élevé n'est pas encore téléchargée/)
    assert.equal((await page.evaluate(() => window.__calls)).some((c) => c[0] === 'generate'), false)

    await page.click('.quality-picker .effort-picker__trigger')
    await page.click('.quality-picker__download')
    assert.deepEqual((await page.evaluate(() => window.__calls)).find((c) => c[0] === 'install'), ['install', 'q8'])
    await page.waitForFunction(() => /Téléchargement de la qualité Q8/.test(document.querySelector('.code-panel__live')?.textContent ?? ''))
    await page.evaluate(() => window.__finishInstall())
    await page.waitForFunction(() => !document.querySelector('.code-panel__live'))
    await page.click('.composer__send')
    await page.waitForFunction(() => window.__quality !== undefined, null, { timeout: 5000 }).catch(() => assert.fail('aucune qualité envoyée'))
    assert.equal(await page.evaluate(() => window.__quality), 'q8')
    assert.equal(await page.evaluate(() => window.__store['jaris.videoQuality']), 'q8', 'retrouvée à la prochaine ouverture')
  }, FAKE_STORAGE)
})

test('qualité : une machine qui ne peut que Q6 n’a qu’un cran, et un choix gardé qui n’est plus possible est ignoré', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForSelector('.quality-picker .effort-picker__trigger')
      assert.match(await page.textContent('.quality-picker .effort-picker__trigger'), /Q6/)
      await page.click('.quality-picker .effort-picker__trigger')
      assert.equal(await page.locator('.quality-picker .effort-picker__step').count(), 1)
    },
    FAKE_STORAGE + "window.__store['jaris.videoQuality'] = 'q8'; window.__status = { supported: true, capable: true, reason: null, qualities: [{ id: 'q6', label: 'Q6', installed: true, downloadLabel: '0 o' }] }"
  )
})

test('PC trop faible : la raison est affichée, aucun bouton d’installation', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForSelector('.image-install__card')
      assert.match(await page.textContent('.image-install__card'), /carte graphique trop petite/)
      assert.equal(await page.locator('.image-install__button').count(), 0)
    },
    "window.__status = { supported: true, capable: false, reason: 'carte graphique trop petite (6 Go de VRAM, il en faut 8 ou plus)', qualities: [] }"
  )
})

test('durée (étape 204) : 2 s par défaut, choisie sur la barre comme l’effort, envoyée avec la vidéo et gardée', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.duration-picker .effort-picker__trigger')
    assert.match(await page.textContent('.duration-picker .effort-picker__trigger'), /2 s/)
    await page.click('.duration-picker .effort-picker__trigger')
    await page.waitForSelector('.duration-picker .effort-picker__panel')
    assert.equal(await page.locator('.duration-picker .effort-picker__step').count(), 5, 'un cran par seconde, de 1 à 5')
    assert.equal(await page.locator('.duration-picker .effort-picker__step--filled').count(), 1, 'barre remplie jusqu’à 2 s')
    await page.click('.duration-picker .effort-picker__step >> nth=4')
    assert.match(await page.textContent('.duration-picker .effort-picker__current'), /5 secondes/)
    assert.equal(await page.locator('.duration-picker .effort-picker__step--filled').count(), 4)
    // Le panneau est habillé par le CSS partagé (pas le style par défaut du navigateur) et tient dans la fenêtre.
    const panel = await page.$eval('.duration-picker .effort-picker__panel', (el) => {
      const r = el.getBoundingClientRect()
      return { left: r.left, right: r.right, top: r.top, position: getComputedStyle(el).position }
    })
    assert.equal(panel.position, 'absolute')
    assert.ok(panel.left >= 0 && panel.right <= 1280 && panel.top >= 0, JSON.stringify(panel))
    await page.keyboard.press('Escape')
    assert.equal(await page.locator('.duration-picker .effort-picker__panel').count(), 0, 'Échap ferme le panneau')

    await page.fill('.composer__input', 'la mer au lever du soleil')
    await page.click('.composer__send')
    await page.waitForFunction(() => window.__seconds !== undefined, null, { timeout: 5000 }).catch(() => assert.fail('aucune durée envoyée avec la vidéo'))
    assert.equal(await page.evaluate(() => window.__seconds), 5)
    assert.equal(await page.evaluate(() => window.__store['jaris.videoSeconds']), '5', 'retrouvée à la prochaine ouverture')
  }, FAKE_STORAGE)
})

test('durée : une durée gardée d’une fois précédente est reprise ; une valeur abîmée retombe sur 2 s', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.duration-picker .effort-picker__trigger')
    assert.match(await page.textContent('.duration-picker .effort-picker__trigger'), /4 s/)
  }, FAKE_STORAGE + "window.__store['jaris.videoSeconds'] = '4';")
  await withPage(async (page) => {
    await page.waitForSelector('.duration-picker .effort-picker__trigger')
    assert.match(await page.textContent('.duration-picker .effort-picker__trigger'), /2 s/)
  }, FAKE_STORAGE + "window.__store['jaris.videoSeconds'] = '37';")
})

test('qualité (étape 207) : une grosse machine a trois crans, jusqu’à « Original »', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForSelector('.quality-picker .effort-picker__trigger')
      await page.click('.quality-picker .effort-picker__trigger')
      assert.equal(await page.locator('.quality-picker .effort-picker__step').count(), 3)
      assert.match(await page.textContent('.quality-picker .effort-picker__scale'), /Q6\s*Original/)
      await page.click('.quality-picker .effort-picker__step >> nth=2')
      assert.match(await page.textContent('.quality-picker .effort-picker__current'), /Qualité Original/)
      assert.match(await page.textContent('.quality-picker__download'), /Télécharger \(21,4 Go\)/)
    },
    "window.__status = { supported: true, capable: true, reason: null, qualities: [{ id: 'q6', label: 'Q6', installed: true, downloadLabel: '0 o' }, { id: 'q8', label: 'Q8', installed: false, downloadLabel: '11,5 Go' }, { id: 'original', label: 'Original', installed: false, downloadLabel: '21,4 Go' }] }"
  )
})
