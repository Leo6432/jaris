import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Étape 265 (Léo, capture à l'appui : « il y a plein de petits bugs ») : la VRAIE fenêtre de Jaris (App.tsx
 * entier, CSS compilé), avec la barre de titre façon Windows 11 active — celle où Windows pose ses propres
 * boutons réduire/agrandir/fermer par-dessus, en haut à droite (titleBarOverlay, 3 x 46 px sur 40 px).
 *
 * Défauts couverts, tous trouvés en photographiant chaque écran puis en MESURANT :
 *  - le Cerveau s'ouvrait en calque plein écran : « Ouvrir le dossier » et « Fermer » passaient sous ces
 *    boutons de Windows ;
 *  - les écrans du premier lancement n'avaient aucune barre de titre (fenêtre impossible à déplacer) ;
 *  - sur une fenêtre étroite, la liste écrasait le contenu à 160 px de large ;
 *  - des textes à 8,7-11 px, sous le minimum de Windows 11 (12 px).
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-window-chrome-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import App from './src/App'

const flags = window.__flags || {}
const conv = [
  { id: 'b', title: 'Relance facture client', createdAt: '2026-10-08T09:00:00Z', updatedAt: '2026-10-08T09:00:00Z' },
  { id: 'a', title: 'Recette de crêpes', createdAt: '2026-10-07T09:00:00Z', updatedAt: '2026-10-07T09:00:00Z' }
]
const known = {
  getProfile: async () => (flags.noProfile ? null : { name: 'Léo', capacityScanDone: !flags.scan, models: {} }),
  getRuntimeSetupStatus: async () => (flags.runtime ? { ready: false, missing: ['Python'] } : { ready: true, missing: [] }),
  getSetupStatus: async () => ({ ready: true, missing: [] }),
  getWindowChrome: async () => ({ titleBar: true }),
  getWidgetMode: async () => 'voice',
  getNewModels: async () => [],
  getAppVersion: async () => '0.0.0',
  listConversations: async () => ({ conversations: conv, activeId: 'b' }),
  getChatHistory: async () => [{ role: 'user', content: 'Bonjour' }, { role: 'assistant', content: 'Bonjour Léo !' }],
  getGeneratedApps: async () => [{ path: '/a', label: 'Minuteur de cuisine', timestamp: Date.now() }],
  listGeneratedImages: async () => [],
  listGeneratedVideos: async () => [],
  getImageStudioStatus: async () => ({ supported: true, capable: true, reason: null, installed: false, downloadLabel: '5 Go' }),
  getVideoStudioStatus: async () => ({ supported: true, capable: true, reason: null, qualities: [{ id: 'light', label: 'Légère', installed: false, downloadLabel: '12 Go' }] }),
  getConversationHistory: async () => [],
  getMemoryGraph: async () => ({ nodes: [{ id: 'Léo', isCenter: true }, { id: 'Travail' }], links: [{ source: 'Léo', target: 'Travail' }] })
}
window.jaris = new Proxy(known, {
  get(target, key) {
    if (key in target) return target[key]
    if (String(key).startsWith('on')) return () => () => {}
    return async () => null
  }
})
createRoot(document.getElementById('root')).render(<App />)
`

let pageHtml = null
let outDir = null

function buildPage() {
  if (pageHtml) return pageHtml
  outDir = mkdtempSync(join(tmpdir(), 'jaris-window-chrome-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({
      entryPoints: [entryPath],
      bundle: true,
      format: 'iife',
      jsx: 'automatic',
      alias: { '@': join(projectRoot, 'src') },
      loader: { '.png': 'dataurl', '.svg': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"' },
      outfile: bundlePath,
      logLevel: 'silent'
    })
  } finally {
    rmSync(entryPath, { force: true })
  }
  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

/** try/finally : une assertion qui échoue ne doit pas laisser Chromium ouvert (node --test ne finirait pas). */
async function withPage(run, { width = 1000, height = 760, flags = {} } = {}) {
  const html = buildPage()
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage({ viewport: { width, height } })
    // Dans la page elle-même, avant le bundle : `addInitScript` ne s'applique pas à `setContent` (aucune
    // navigation), et les écrans du premier lancement n'auraient alors jamais été affichés — le test
    // passait sans rien vérifier, repéré en remettant le défaut exprès.
    await page.setContent(html.replace('<div id="root"></div>', `<div id="root"></div><script>window.__flags = ${JSON.stringify(flags)}</script>`))
    await run(page)
  } finally {
    await browser.close()
  }
}

/** Ce qui, de visible et d'interactif (ou de lisible), tombe sous les boutons de Windows. */
async function underWindowButtons(page) {
  return page.evaluate(() => {
    const W = innerWidth
    const hits = []
    for (const el of document.querySelectorAll('button, a, input, select, textarea, h1, h2, h3, p')) {
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1 || r.top >= 40 || r.bottom <= 0 || r.right <= W - 138) continue
      if (getComputedStyle(el).visibility === 'hidden') continue
      hits.push(`${el.tagName.toLowerCase()} « ${(el.textContent || '').trim().slice(0, 30)} »`)
    }
    return hits
  })
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('aucun écran du rail ne met un bouton sous réduire/agrandir/fermer de Windows (Cerveau compris)', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.rail__item')
    for (const label of ['Chat', 'Vocal', 'Code', 'Image', 'Vidéo', 'Options', 'Cerveau']) {
      await page.click(`.rail__item:has-text("${label}")`)
      await page.waitForTimeout(300)
      assert.deepEqual(await underWindowButtons(page), [], `écran ${label}`)
    }
    // Le Cerveau s'affiche dans la zone principale, sous la barre de titre, avec son bouton de dossier.
    const folder = await page.locator('.memory-brain__actions button:has-text("Ouvrir le dossier")').boundingBox()
    assert.ok(folder && folder.y >= 40, `« Ouvrir le dossier » à ${folder?.y}px du haut`)
  })
})

for (const [name, flags, screen] of [
  ['bienvenue', { noProfile: true }, '.app__onboarding'],
  ['installation', { runtime: true }, '.runtime-setup'],
  ['configuration', { scan: true }, '.capacity-scan']
]) {
  test(`premier lancement (${name}) : la fenêtre garde une barre de titre pour être déplacée`, options, async () => {
    await withPage(
      async (page) => {
        await page.waitForSelector(screen)
        await page.waitForSelector('.titlebar', { timeout: 3000 })
        const drag = await page.evaluate(() => getComputedStyle(document.querySelector('.titlebar')).webkitAppRegion)
        assert.equal(drag, 'drag')
        assert.deepEqual(await underWindowButtons(page), [])
      },
      { flags }
    )
  })
}

test('fenêtre étroite : la liste se pose par-dessus au lieu d’écraser la conversation, et se referme au choix', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForSelector('.rail__item')
      await page.click('.rail__item:has-text("Chat")')
      await page.click('.app-header .panel__icon-button')
      await page.waitForSelector('.app-sidebar__workspace:not([hidden]) .workspace__item')
      const mainWidth = await page.evaluate(() => document.querySelector('.app-main').getBoundingClientRect().width)
      assert.ok(mainWidth > 380, `zone principale écrasée à ${Math.round(mainWidth)} px`)
      await page.click('.app-sidebar__workspace .workspace__item:has-text("Recette")')
      await page.waitForTimeout(200)
      assert.equal(await page.locator('.app-sidebar--expanded').count(), 0, 'la liste reste ouverte par-dessus la conversation choisie')
    },
    { width: 480, height: 600 }
  )
})

test('aucun texte sous 12 px (minimum de Windows 11) dans le Chat, l’Agent vocal et les Options', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.rail__item')
    const tiny = []
    for (const label of ['Chat', 'Vocal', 'Options']) {
      await page.click(`.rail__item:has-text("${label}")`)
      await page.waitForTimeout(300)
      const found = await page.evaluate(() => {
        const out = []
        for (const el of document.querySelectorAll('body *')) {
          const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 1)
          if (!own) continue
          const r = el.getBoundingClientRect()
          if (r.width < 1 || r.height < 1) continue
          const size = parseFloat(getComputedStyle(el).fontSize)
          if (size < 11.9) out.push(`${el.className} (${size}px) « ${el.textContent.trim().slice(0, 25)} »`)
        }
        return out
      })
      tiny.push(...found.map((f) => `${label} : ${f}`))
    }
    assert.deepEqual(tiny, [])
  })
})

test('style ChatGPT : aucune couleur vive dans la fenêtre (plus de violet ni de bleu repris de Windows)', options, async () => {
  // Étape 266 (Léo : « ça fait trop application Windows avec la couleur violet ») : Jaris recopiait la couleur
  // d'accent de Windows — violette chez Léo — dans le rail, les boutons, la barre de saisie. Tout ce qui
  // habille la fenêtre doit maintenant être gris. Seules exceptions voulues : le logo (une image) et le
  // point vert « Local » de la colonne, qui veut dire « ça marche ».
  for (const scheme of ['dark', 'light']) {
    await withPage(async (page) => {
      await page.emulateMedia({ colorScheme: scheme })
      await page.waitForSelector('.rail__item')
      const colored = []
      for (const label of ['Chat', 'Vocal', 'Options']) {
        await page.click(`.rail__item:has-text("${label}")`)
        await page.waitForTimeout(300)
        colored.push(...(await page.evaluate(() => {
          const out = []
          const vivid = (c) => {
            const m = c.match(/rgba?\(([^)]+)\)/)
            if (!m) return false
            const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number)
            return a > 0.05 && Math.max(r, g, b) - Math.min(r, g, b) > 24
          }
          for (const el of document.querySelectorAll('.app-shell *')) {
            if (el.closest('.panel__status-dot, svg, img, canvas, .options-menu__voice-picker')) continue
            const r = el.getBoundingClientRect()
            if (r.width < 1 || r.height < 1) continue
            const cs = getComputedStyle(el)
            for (const prop of ['backgroundColor', 'color', 'borderTopColor']) {
              if (vivid(cs[prop])) out.push(`${el.className} ${prop} ${cs[prop]}`)
            }
          }
          return out
        })).map((c) => `${label} : ${c}`))
      }
      assert.deepEqual([...new Set(colored)], [], `thème ${scheme}`)
    })
  }
})

test("Agent vocal : l'orbe animé du logo de Jaris, seul, sans rond ni bouton autour", options, async () => {
  // Étape 267 (Léo : « utilise l'orbe classique, pourquoi changer avec un cercle, l'orbe du logo de
  // l'application ») : ni le logo posé dans un bouton rond à anneaux (design v2), ni une autre sphère.
  await withPage(async (page) => {
    await page.waitForSelector('.rail__item')
    await page.click('.rail__item:has-text("Vocal")')
    await page.waitForSelector('.voice-screen .jaris-orb canvas')
    assert.equal(await page.locator('.voice-screen__button, .voice-orb').count(), 0, 'un cadre rond est revenu autour de l’orbe')
    const box = await page.locator('.voice-screen .jaris-orb').boundingBox()
    assert.ok(box.width >= 200, `orbe trop petit sur une fenêtre normale : ${box.width}px`)
  })
})

test.after(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})
