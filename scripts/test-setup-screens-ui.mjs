import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Écrans du premier lancement, vus en vrai (Jaris sous Xvfb, thème clair, 1000x760 puis 1920x1080) :
 * - « Configuration de Jaris » : la colonne de l'accueil (440 px) écrasait la carte des modèles — les noms tombaient à
 *   10 px (« q… »), les scores débordaient de la carte et la barre de défilement tombait au milieu de la fenêtre ;
 * - « Installation de Jaris » : la liste des échecs en rose pâle, 1,9:1 sur fond clair, quasi illisible ;
 * - téléchargement des modèles : « … 35% » et un rond qui tourne, sans barre ni taille ;
 * - « Configuration terminée » : la ligne Vidéo manquait au résumé.
 * Les vrais composants (CapacityScan, RuntimeSetup) dans la vraie coque du premier lancement (.app-shell--setup), avec
 * le vrai CSS compilé (out/renderer : `npm run build` avant), en thème clair ET sombre. Playwright n'étant pas une
 * dépendance du projet (absent du runner Windows de la CI), les tests se marquent « ignorés » avec la raison.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-setup-screens-entry.tsx')
const GB = 1024 ** 3

// Des noms longs, réels (étapes 312 à 316) : c'est sur eux que la carte cédait la première.
const MODELS = {
  flash: 'hf.co/IFM/K2-Horizon-3.7B-GGUF:Q4_K_M',
  medium: 'nemotron-3.5-lightning:30b',
  large: 'qwen3.6:35b-a3b',
  vision: 'hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M',
  code: 'qwen2.5-coder:14b'
}
const SHOWN = ['K2-Horizon-3.7B (Q4_K_M)', 'nemotron-3.5-lightning:30b', 'qwen3.6:35b-a3b', 'GLM-4.6V-Flash (Q4_K_M)', 'qwen2.5-coder:14b', 'FLUX.2 klein 4B', 'FastWan 2.2 TI2V 5B · qualité Moyen', 'MAI-UI 8B']

const ENTRY = `
import { createRoot } from 'react-dom/client'
import CapacityScan from './src/components/CapacityScan'
import RuntimeSetup from './src/components/RuntimeSetup'

const models = ${JSON.stringify(MODELS)}
const e = (model, tool, ai, speed, demands = null) => ({ model, vramGb: 8, usedIn: [], toolCalling: tool, demands, intelligence: null, artificialAnalysisIndex: ai, artificialAnalysisSpeed: speed })
const picks = {
  gpuName: 'NVIDIA GeForce RTX 3070', vramGb: 8, ramGb: 31.9,
  flash: e(models.flash, '76/78', 16, 221, '33/48'),
  medium: e(models.medium, '78/78', 13, 264, '40/48'),
  large: e(models.large, '77/78', 18.2, 115, '45/48'),
  vision: e(models.vision, '30/34', 12, 46),
  code: e(models.code, '5/5', 33.7, 46),
  upgrades: {}, installCheck: { notInstalled: [], otherInstalled: [] },
  image: { model: 'FLUX.2 klein 4B', reason: null },
  video: { model: 'FastWan 2.2 TI2V 5B', qualityLabel: 'Moyen', quality: 'q6', reason: null },
  pilot: { model: 'MAI-UI 8B', reason: null }
}
window.jaris = {
  getMyModelPicks: async () => picks,
  onModelBenchmarkLine: (cb) => { window.__line = cb; return () => { window.__line = null } },
  onModelPullProgress: (cb) => { window.__pull = cb; return () => { window.__pull = null } },
  runQuickSetup: () => new Promise((resolve) => { window.__finishSetup = resolve }),
  onRuntimeSetupProgress: (cb) => { window.__emit = cb; return () => {} },
  runRuntimeSetup: () => new Promise((resolve) => { window.__finishRuntime = (ready) => resolve({ ready }) })
}
createRoot(document.getElementById('setup')).render(window.__screen === 'runtime' ? <RuntimeSetup onDone={() => {}} /> : <CapacityScan onDone={() => {}} />)
`

let bundle = null
let css = null

function build() {
  if (bundle) return
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-setup-screens-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, loader: { '.png': 'dataurl' }, outfile: bundlePath, logLevel: 'error' })
  } finally {
    rmSync(entryPath, { force: true })
  }
  bundle = readFileSync(bundlePath, 'utf8')
  css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
}

// La coque réelle du premier lancement (App.tsx, setupShell) : barre de titre + zone de l'écran.
const pageHtml = (screen) =>
  `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"><div class="app-shell app-shell--titlebar app-shell--setup"><div class="titlebar" style="height:40px"></div><div class="app-shell__setup" id="setup"></div></div></div><script>window.__screen=${JSON.stringify(screen)}</script><script>${bundle}</script></body></html>`

async function withScreen(screen, { width = 1000, height = 760, colorScheme = 'light' } = {}, run) {
  build()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    await page.emulateMedia({ colorScheme })
    await page.setViewportSize({ width, height })
    await page.setContent(pageHtml(screen))
    await page.waitForSelector(screen === 'runtime' ? '.runtime-setup__status' : '.capacity-scan__tier-table')
    await run(page)
  } finally {
    await browser.close()
  }
}

/** Contraste WCAG de chaque texte visible de l'écran, contre son fond réel (fonds translucides composés). */
const lowContrastTexts = (page) =>
  page.evaluate(() => {
    const parse = (c) => {
      const [r, g, b, a = 1] = c.match(/[\d.]+/g).map(Number)
      return { r, g, b, a }
    }
    const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 })
    const lum = ({ r, g, b }) => {
      const f = (v) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
    }
    const out = []
    for (const el of document.querySelectorAll('#setup *')) {
      const text = [...el.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).map((n) => n.textContent.trim()).join(' ')
      const box = el.getBoundingClientRect()
      if (!text || !box.width || !box.height) continue
      const layers = []
      for (let n = el; n; n = n.parentElement) layers.unshift(parse(getComputedStyle(n).backgroundColor))
      let bg = { r: 255, g: 255, b: 255, a: 1 }
      for (const layer of layers) if (layer.a > 0) bg = over(layer, bg)
      const color = parse(getComputedStyle(el).color)
      const fg = color.a < 1 ? over(color, bg) : color
      const [hi, lo] = [lum(fg), lum(bg)].sort((x, y) => y - x)
      const ratio = (hi + 0.05) / (lo + 0.05)
      if (ratio < 4.5) out.push(`${ratio.toFixed(2)}:1 « ${text.slice(0, 40)} » (${el.className || el.tagName})`)
    }
    return out
  })

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

for (const [width, height] of [[1000, 760], [760, 760], [1920, 1080]]) {
  test(`configuration à ${width}x${height} : noms des modèles en entier, tableau dans sa carte, aucun défilement de côté`, options, async () => {
    await withScreen('capacity', { width, height }, async (page) => {
      const layout = await page.evaluate(() => {
        const card = document.querySelector('.capacity-scan__tier').getBoundingClientRect()
        const names = [...document.querySelectorAll('td.capacity-scan__tier-model')].map((td) => {
          const range = document.createRange()
          range.selectNodeContents(td)
          const rects = [...range.getClientRects()]
          return {
            text: td.textContent,
            clipped: td.scrollWidth > td.clientWidth + 1 || getComputedStyle(td).textOverflow === 'ellipsis',
            inside: rects.every((r) => r.left >= card.left - 0.5 && r.right <= card.right + 0.5),
            lines: rects.length,
            width: Math.round(td.getBoundingClientRect().width)
          }
        })
        const outside = [...document.querySelectorAll('.capacity-scan__tier *')]
          .filter((el) => el.getBoundingClientRect().right > card.right + 0.5)
          .map((el) => `${el.className || el.tagName} « ${el.textContent.trim().slice(0, 30)} »`)
        const sideways = [document.documentElement, ...document.querySelectorAll('#root *')]
          .filter((el) => el.scrollWidth > el.clientWidth + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowX))
          .map((el) => el.className)
        const scrollers = [...document.querySelectorAll('#root *')]
          .filter((el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 1)
          .map((el) => ({ cls: el.className, left: el.getBoundingClientRect().left, right: el.getBoundingClientRect().right }))
        // Les deux scores d'un rôle (« Questions », « Demandes ») tiennent côte à côte : la carte a la place d'un vrai tableau.
        const badgesSideBySide = [...document.querySelectorAll('.capacity-scan__tier-scores')]
          .map((td) => [...td.querySelectorAll('.options-menu__badge')].map((b) => Math.round(b.getBoundingClientRect().top)))
          .filter((tops) => tops.length === 2)
          .every(([a, b]) => a === b)
        return { names, outside, sideways, scrollers, badgesSideBySide, docOverflow: document.documentElement.scrollWidth > window.innerWidth, title: document.querySelector('h1').getBoundingClientRect().top }
      })
      assert.equal(layout.badgesSideBySide, true, 'les deux scores d’un rôle côte à côte')
      assert.deepEqual(layout.names.map((n) => n.text), SHOWN)
      for (const name of layout.names) {
        assert.equal(name.clipped, false, `« ${name.text} » coupé (${name.width} px)`)
        assert.ok(name.inside, `« ${name.text} » dépasse de la carte`)
        assert.equal(name.lines, 1, `« ${name.text} » coupé sur ${name.lines} lignes`)
      }
      assert.deepEqual(layout.outside, [], 'rien ne dépasse à droite de la carte (badges compris)')
      assert.deepEqual(layout.sideways, [], 'aucun défilement de côté')
      assert.equal(layout.docOverflow, false)
      // S'il faut défiler, c'est tout l'écran : barre de défilement contre le bord droit de la fenêtre, jamais au milieu.
      for (const scroller of layout.scrollers) {
        assert.equal(Math.round(scroller.right), width, `${scroller.cls} défile avec une barre à ${Math.round(scroller.right)} px`)
      }
      assert.ok(layout.title >= 0, 'le haut de l’écran reste visible')
    })
  })
}

test('configuration : le bouton « Continuer » est atteignable en faisant défiler, même dans une fenêtre basse', options, async () => {
  await withScreen('capacity', { width: 760, height: 600 }, async (page) => {
    const button = page.locator('.capacity-scan > button')
    await button.scrollIntoViewIfNeeded()
    const box = await button.boundingBox()
    assert.ok(box && box.y >= 0 && box.y + box.height <= 600, `bouton à ${JSON.stringify(box)}`)
  })
})

for (const colorScheme of ['light', 'dark']) {
  test(`installation (${colorScheme === 'light' ? 'thème clair' : 'thème sombre'}) : la liste des échecs se lit, au moins 4,5:1`, options, async () => {
    await withScreen('runtime', { colorScheme }, async (page) => {
      await page.evaluate(() => {
        window.__emit({ message: "L'installation de Python a échoué : GitHub limite le nombre de téléchargements", failed: true })
        window.__finishRuntime(false)
      })
      await page.waitForSelector('.runtime-setup__actions')
      const low = await lowContrastTexts(page)
      assert.deepEqual(low, [])
      assert.ok(await page.isVisible('.runtime-setup__failures li'))
    })
  })

  test(`configuration (${colorScheme === 'light' ? 'thème clair' : 'thème sombre'}) : aucun texte sous 4,5:1, des modèles au résumé`, options, async () => {
    await withScreen('capacity', { colorScheme }, async (page) => {
      assert.deepEqual(await lowContrastTexts(page), [], 'carte des modèles (badges compris)')
      await page.click('.capacity-scan > button')
      await page.evaluate(() => window.__pull({ model: 'qwen3.5:4b', completed: 1.2 * 1024 ** 3, total: 3.4 * 1024 ** 3 }))
      await page.waitForSelector('[role="progressbar"][aria-valuenow]')
      assert.deepEqual(await lowContrastTexts(page), [], 'téléchargement')
      await page.evaluate(() =>
        window.__finishSetup({
          gpuName: 'NVIDIA GeForce RTX 3070', vramGb: 8,
          models: { flash: 'ministral-3:3b', medium: 'granite4.2:8b', large: 'qwen3.8:27b' }, visionModel: 'qwen3.8:27b', codeModel: 'qwen3.8:27b',
          skippedModels: [{ model: 'qwen3.6:35b-a3b', reason: 'trop gros pour ce PC' }],
          image: { model: 'FLUX.2 klein 4B', reason: null, installed: false, error: 'connexion coupée' },
          video: { model: 'FastWan 2.2 TI2V 5B', qualityLabel: 'Moyen', quality: 'q6', reason: null, installed: false },
          pilot: { model: 'MAI-UI 8B', reason: null, installed: true }
        })
      )
      await page.waitForSelector('.capacity-scan__models')
      assert.deepEqual(await lowContrastTexts(page), [], 'résumé (avertissements compris)')
    })
  })
}

test('téléchargement : une vraie barre qui suit le pourcentage, avec la taille, puis un va-et-vient entre deux modèles', options, async () => {
  await withScreen('capacity', {}, async (page) => {
    await page.click('.capacity-scan > button')
    await page.waitForFunction(() => typeof window.__pull === 'function')
    const fillRatio = () =>
      page.evaluate(() => {
        const bar = document.querySelector('[role="progressbar"]')
        return bar.firstElementChild.getBoundingClientRect().width / bar.getBoundingClientRect().width
      })

    await page.evaluate(() => window.__pull({ model: 'qwen3.5:4b', completed: 0.35 * 5.4 * 1024 ** 3, total: 5.4 * 1024 ** 3 }))
    await page.waitForFunction(() => document.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') === '35')
    await page.waitForTimeout(400) // la largeur de la barre est animée (0,3 s)
    assert.ok(Math.abs((await fillRatio()) - 0.35) < 0.02, `barre à ${await fillRatio()}`)
    const bar = await page.$eval('[role="progressbar"]', (el) => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }))
    assert.ok(bar.width >= 200 && bar.height >= 4, `une vraie barre, pas un trait : ${JSON.stringify(bar)}`)
    assert.match(await page.textContent('.capacity-scan__progress'), /Téléchargement du modèle qwen3\.5:4b… 35%/)
    assert.equal((await page.textContent('.capacity-scan__progress-size')).trim(), '1,9 Go sur 5,4 Go')
    assert.equal(await page.$('.capacity-scan__spinner'), null, 'plus de rond qui tourne')

    await page.evaluate(() => window.__pull({ model: 'qwen3.5:4b', completed: 0.8 * 5.4 * 1024 ** 3, total: 5.4 * 1024 ** 3 }))
    await page.waitForTimeout(400)
    assert.ok(Math.abs((await fillRatio()) - 0.8) < 0.02, `barre à ${await fillRatio()}`)
    assert.equal((await page.textContent('.capacity-scan__progress-size')).trim(), '4,3 Go sur 5,4 Go')

    // Fin de ce téléchargement : plus de pourcentage ni de taille, la barre fait un va-et-vient pendant la suite.
    await page.evaluate(() => {
      window.__pull(null)
      window.__line('Installation du modèle de dessin…')
    })
    await page.waitForFunction(() => !document.querySelector('[role="progressbar"]').hasAttribute('aria-valuenow'))
    assert.equal(await page.$('.capacity-scan__progress-size'), null)
    assert.match(await page.textContent('.capacity-scan__progress'), /Installation du modèle de dessin/)
    assert.ok(await page.$eval('[role="progressbar"] > div', (el) => el.classList.contains('runtime-setup__bar-fill--pulse')))
  })
})

test('« Configuration terminée » : la ligne Vidéo, après Image, avec la même décision que la carte des modèles', options, async () => {
  const finish = (video) => (page) =>
    page.evaluate((v) => {
      window.__finishSetup({
        gpuName: 'GPU', vramGb: 8,
        models: { flash: 'ministral-3:3b', medium: 'granite4.2:8b', large: 'qwen3.8:27b' }, visionModel: 'qwen3.8:27b', codeModel: 'qwen3.8:27b',
        image: { model: 'FLUX.2 klein 4B', reason: null, installed: true },
        video: v,
        pilot: { model: 'MAI-UI 8B', reason: null, installed: true }
      })
    }, video)
  const lines = async (page) => {
    await page.waitForSelector('.capacity-scan__models')
    return page.$$eval('.capacity-scan__models li', (lis) => lis.map((li) => li.textContent))
  }
  for (const [video, expected] of [
    [{ model: 'FastWan 2.2 TI2V 5B', qualityLabel: 'Moyen', quality: 'q6', reason: null, installed: false }, 'Vidéo : FastWan 2.2 TI2V 5B · qualité Moyen, à télécharger depuis le mode Vidéo'],
    [{ model: 'FastWan 2.2 TI2V 5B', qualityLabel: 'Élevé', quality: 'q8', reason: null, installed: true }, 'Vidéo : FastWan 2.2 TI2V 5B · qualité Élevé'],
    [{ model: null, qualityLabel: null, quality: null, reason: 'carte graphique trop petite' }, 'Vidéo : aucun modèle (pas assez de puissance)']
  ]) {
    await withScreen('capacity', {}, async (page) => {
      await page.click('.capacity-scan > button')
      await finish(video)(page)
      const items = await lines(page)
      const at = items.indexOf(expected)
      assert.ok(at > 0, `ligne attendue « ${expected} » dans ${JSON.stringify(items)}`)
      assert.match(items[at - 1], /^Image : /)
      assert.match(items[at + 1], /^Pilotage d'écran : /)
    })
  }
})
