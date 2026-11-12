import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

/**
 * Défauts visuels de l'audit des deux thèmes (sombre ET clair), sur la VRAIE fenêtre de Jaris (App.tsx entier) et le
 * CSS COMPILÉ (out/), avec la vraie police Geist (les retours à la ligne en dépendent). Chaque point est MESURÉ :
 *  - la recherche du Classement était codée pour le sombre (texte à 2,4:1 en clair) ;
 *  - le champ de saisie du Chat n'avait ni le fond, ni le trait, ni l'arrondi de Code/Image/Vidéo, et son contour de
 *    focus, blanc codé en dur, disparaissait en clair (1:1) ;
 *  - la roue d'attente gris foncé fixe était invisible sur le micro en sombre et sur l'envoi en clair ;
 *  - l'envoi occupé paraissait désactivé (opacité 0,3 : sa règle était écrasée plus bas) ;
 *  - Code à 760 px : le texte d'aide passait à la ligne dans un champ d'une ligne (coupé à mi-hauteur) ;
 *  - Classement à 760 px : deux colonnes cachées (tableau de 716 px dans 627) ;
 *  - « … » de la barre d'icônes plus pâle que ses voisines, sans état visible quand son menu est ouvert.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}
const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-visual-consistency-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import App from './src/App'

const conversations = [
  { id: 'a', title: 'Recette de crêpes', createdAt: '', updatedAt: '2026-11-06T10:00:00.000Z', messageCount: 2 },
  { id: 'b', title: 'Relance facture', createdAt: '', updatedAt: '2026-11-05T10:00:00.000Z', messageCount: 2 }
]
const known = {
  getProfile: async () => ({ name: 'Léo', capacityScanDone: true, models: {} }),
  getRuntimeSetupStatus: async () => ({ ready: true, missing: [] }),
  getSetupStatus: async () => ({ ready: true, missing: [] }),
  getWindowChrome: async () => ({ titleBar: true }),
  getLanguageState: () => ({ setting: 'fr', language: 'fr' }),
  getWidgetMode: async () => false,
  getNewModels: async () => [],
  getAppVersion: async () => '0.0.0',
  listConversations: async () => ({ conversations, activeId: 'a' }),
  getChatHistory: async () => [{ role: 'user', content: 'salut' }, { role: 'assistant', content: 'Salut Léo !' }],
  getGeneratedApps: async () => [],
  loadCodeConversations: () => ({ repos: [], conversations: {} }),
  githubStatus: async () => ({ available: false, connected: false, login: null }),
  listGeneratedImages: async () => [],
  listGeneratedVideos: async () => [],
  getImageStudioStatus: async () => ({ supported: true, capable: true, reason: null, installed: true, downloadLabel: '5 Go' }),
  getVideoStudioStatus: async () => ({ supported: true, capable: true, reason: null, qualities: [{ id: 'q', label: 'Q', installed: true, downloadLabel: '0 o' }] }),
  getMemoryGraph: async () => ({ nodes: [{ id: 'Léo', isCenter: true }, { id: 'Travail' }], links: [{ source: 'Léo', target: 'Travail' }] }),
  machineGet: async () => ({ saved: null, connected: false, connecting: false, version: null, error: null, freeDiskGb: null, busy: null }),
  // Le Classement : les dix colonnes, avec des points de duel (et leur nombre de duels) dans les trois catégories.
  getModelOverview: async () => ({ vramGb: 8, codeModel: 'qwen2.5-coder:7b', entries: [
    { model: 'ministral-3:3b', vramGb: 3, category: 'Rapide', readsImages: true, usedIn: ['Rapide', 'Médium'], toolCalling: '6/6', demands: '33/48', omniscience: -64, duels: { code: { points: 120.4, duels: 3 }, conversation: { points: 0, duels: 2 } } },
    { model: 'qwen3:1.7b', vramGb: 2, category: 'Rapide', readsImages: false, usedIn: [], toolCalling: null, omniscience: -77.5, duels: { voice: { points: -10, duels: 10 } } },
    { model: 'gemma4:31b', vramGb: 20, category: 'Puissant', readsImages: true, usedIn: ['Vision'], toolCalling: null, omniscience: -47.9, duels: { voice: { points: 64, duels: 25 } } }
  ] })
}
window.jaris = new Proxy(known, {
  get(target, key) {
    if (key in target) return target[key]
    if (String(key).startsWith('on')) return () => () => {}
    if (key === 'then') return undefined
    return async () => null
  }
})
createRoot(document.getElementById('root')).render(<App />)
`

let pagePath = null
let outDir = null

/** La page est écrite dans un dossier temporaire, et les polices pointent vers out/ : la vraie Geist, pas une police
 *  de secours plus large qui ferait déborder le tableau (ou tenir un texte d'aide) pour de mauvaises raisons. */
function buildPage() {
  if (pagePath) return pagePath
  outDir = mkdtempSync(join(tmpdir(), 'jaris-visual-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({
      entryPoints: [entryPath],
      bundle: true,
      format: 'iife',
      jsx: 'automatic',
      alias: { '@': join(projectRoot, 'src') },
      loader: { '.png': 'dataurl', '.svg': 'dataurl', '.webp': 'dataurl' },
      define: { 'process.env.NODE_ENV': '"production"' },
      outfile: bundlePath,
      logLevel: 'silent'
    })
  } finally {
    rmSync(entryPath, { force: true })
  }
  const assets = join(projectRoot, 'out', 'renderer', 'assets')
  const css = readFileSync(globSync(join(assets, 'index-*.css'))[0], 'utf8').replace(
    /url\(\.\/([^)]+\.woff2?)\)/g,
    (_, file) => `url(${pathToFileURL(join(assets, file)).href})`
  )
  pagePath = join(outDir, 'page.html')
  writeFileSync(pagePath, `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`)
  return pagePath
}

test.after(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})

/** try/finally : une assertion qui échoue ne doit pas laisser Chromium ouvert (node --test ne finirait pas). */
async function withPage(colorScheme, width, run) {
  const path = buildPage()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width, height: 760 }, colorScheme })
    await page.goto(pathToFileURL(path).href)
    await page.evaluate(() => document.fonts.ready)
    await page.waitForSelector('.app-rail .rail__item')
    await page.evaluate(() => {
      // Contraste WCAG d'une couleur posée sur le fond réellement peint derrière l'élément (transparences comprises).
      const parse = (c) => { const p = String(c).match(/rgba?\(([^)]+)\)/)[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 } }
      const lum = ({ r, g, b }) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i], 0)
      const blend = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 })
      const backdrop = (el) => {
        const layers = []
        for (let e = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c.a > 0) layers.push(c); if (c.a === 1) break }
        let base = { r: 255, g: 255, b: 255, a: 1 }
        for (const c of layers.reverse()) base = blend(c, base)
        return base
      }
      const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05) }
      window.__contrast = (color, el) => { const bg = backdrop(el); return ratio(blend(parse(color), bg), bg) }
    })
    await run(page)
  } finally {
    await browser.close()
  }
}

const openMode = (page, label) => page.click(`.app-rail .rail__item:has-text("${label}")`)
const openRanking = async (page) => {
  await page.click('.app-rail .rail__item[aria-haspopup="menu"]')
  await page.click('.rail__menu-item:has-text("Classement")')
  await page.waitForSelector('.options-menu__model-overview tbody tr')
}

for (const scheme of ['dark', 'light']) {
  test(`${scheme} : la recherche du Classement se lit (texte et texte d'aide ≥ 4,5:1)`, options, async () => {
    await withPage(scheme, 1200, async (page) => {
      await openRanking(page)
      const search = await page.$eval('.options-menu__model-search', (el) => {
        el.value = 'gemma'
        return { text: window.__contrast(getComputedStyle(el).color, el), hint: window.__contrast(getComputedStyle(el, '::placeholder').color, el) }
      })
      assert.ok(search.text >= 4.5, `texte tapé à ${search.text.toFixed(2)}:1`)
      assert.ok(search.hint >= 4.5, `texte d'aide à ${search.hint.toFixed(2)}:1`)
    })
  })

  test(`${scheme} : un seul champ de saisie (Chat = Image), et le même contour de focus, visible`, options, async () => {
    await withPage(scheme, 1200, async (page) => {
      // Rayon lu dans les deux états du champ (une ligne, puis agrandi) : Image et Chat ne sont pas forcément dans le même.
      // Les écrans déjà ouverts restent montés (cachés) : le champ est cherché DANS l'écran affiché.
      const look = (panel) =>
        page.$eval(`${panel} .composer`, (el) => {
          const s = getComputedStyle(el)
          const expanded = el.classList.contains('composer--expanded')
          el.classList.toggle('composer--expanded', !expanded)
          const other = getComputedStyle(el).borderTopLeftRadius
          el.classList.toggle('composer--expanded', expanded)
          const radius = expanded ? `${other} / ${s.borderTopLeftRadius}` : `${s.borderTopLeftRadius} / ${other}`
          return { bg: s.backgroundColor, border: s.borderTopColor, width: s.borderTopWidth, radius, focusContrast: window.__contrast(s.borderTopColor, el.parentElement) }
        })
      // Le contour suit une transition de 0,18 s : chaque état est lu une fois la transition finie.
      await openMode(page, 'Chat')
      await page.waitForSelector('.chat-panel .composer')
      await page.waitForTimeout(400)
      const chat = await look('.chat-panel')
      await page.click('.chat-panel .composer textarea')
      await page.waitForTimeout(400)
      const chatFocus = await look('.chat-panel')
      await openMode(page, 'Image')
      await page.waitForSelector('.image-panel .composer')
      await page.waitForTimeout(400)
      const image = await look('.image-panel')
      await page.click('.image-panel .composer textarea')
      await page.waitForTimeout(400)
      const imageFocus = await look('.image-panel')
      for (const key of ['bg', 'border', 'width', 'radius']) assert.equal(chat[key], image[key], `${key} : Chat ${chat[key]}, Image ${image[key]}`)
      assert.equal(chatFocus.border, imageFocus.border, 'même contour au focus partout')
      assert.notEqual(chatFocus.border, chat.border, 'le focus se voit sur le contour')
      assert.ok(chatFocus.focusContrast >= 1.5, `contour de focus à ${chatFocus.focusContrast.toFixed(2)}:1 du fond`)
    })
  })

  test(`${scheme} : la roue d'attente se voit sur l'envoi et sur le micro ; l'envoi occupé ne paraît pas éteint`, options, async () => {
    await withPage(scheme, 1200, async (page) => {
      await openMode(page, 'Chat')
      await page.waitForSelector('.chat-panel .composer__send')
      // L'opacité de l'envoi suit une transition de 0,15 s : chaque état est lu une fois la transition finie.
      const result = await page.evaluate(async (delay) => {
        const wait = () => new Promise((resolve) => setTimeout(resolve, delay))
        const out = {}
        for (const selector of ['.composer__send', '.composer__mic']) {
          const button = document.querySelector(`.chat-panel ${selector}`)
          const spinner = document.createElement('span')
          spinner.className = 'composer__spinner'
          button.replaceChildren(spinner)
          out[selector] = window.__contrast(getComputedStyle(spinner).borderTopColor, button)
        }
        const send = document.querySelector('.chat-panel .composer__send')
        send.disabled = true
        await wait()
        out.disabled = Number(getComputedStyle(send).opacity)
        send.classList.add('composer__send--busy')
        await wait()
        out.busy = Number(getComputedStyle(send).opacity)
        return out
      }, 400)
      assert.ok(result['.composer__send'] >= 3, `roue sur l'envoi à ${result['.composer__send'].toFixed(2)}:1`)
      assert.ok(result['.composer__mic'] >= 3, `roue sur le micro à ${result['.composer__mic'].toFixed(2)}:1`)
      assert.ok(result.busy >= 0.8, `envoi occupé à l'opacité ${result.busy}`)
      assert.ok(result.disabled < result.busy, 'un envoi simplement désactivé reste plus discret')
    })
  })

  test(`${scheme} : à 760 px, le texte d'aide du mode Code tient en entier (le champ passe sur deux rangées)`, options, async () => {
    await withPage(scheme, 760, async (page) => {
      await openMode(page, 'Code')
      await page.waitForSelector('.code-panel .composer textarea')
      await page.waitForTimeout(200)
      const field = await page.$eval('.code-panel .composer textarea', (ta) => {
        const s = getComputedStyle(ta)
        const context = document.createElement('canvas').getContext('2d')
        context.font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`
        return { needed: Math.ceil(context.measureText(ta.placeholder).width), room: ta.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight), placeholder: ta.placeholder }
      })
      assert.ok(field.placeholder.length > 0)
      assert.ok(field.needed <= field.room, `« ${field.placeholder} » demande ${field.needed} px, le champ en offre ${field.room}`)
    })
  })

  // Étape 475 : onze colonnes, avec « Duels Vision ».
  test(`${scheme} : à 760 px, les onze colonnes du Classement sont visibles, « Duels : 3 » d'un seul tenant`, options, async () => {
    await withPage(scheme, 760, async (page) => {
      await openRanking(page)
      const table = await page.evaluate(() => {
        const t = document.querySelector('.options-menu__model-overview')
        const box = t.parentElement.getBoundingClientRect()
        const lines = (el) => { const r = document.createRange(); r.selectNodeContents(el); return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size }
        return {
          columns: t.querySelectorAll('thead th').length,
          hidden: [...t.querySelectorAll('thead th')].filter((th) => th.getBoundingClientRect().right > box.right + 1).map((th) => th.textContent.trim()),
          counts: [...document.querySelectorAll('.options-menu__duel-count')].map(lines)
        }
      })
      assert.equal(table.columns, 11)
      assert.deepEqual(table.hidden, [], `colonnes cachées : ${table.hidden.join(', ')}`)
      assert.ok(table.counts.length >= 4 && table.counts.every((n) => n === 1), `« Duels : n » sur ${table.counts.join(', ')} lignes`)
    })
  })

  test(`${scheme} : « … » a l'intensité des autres icônes, et un état visible quand son menu est ouvert`, options, async () => {
    await withPage(scheme, 1200, async (page) => {
      // Encre réellement dessinée par chaque icône (somme de l'opacité de ses pixels), sur un canvas : des points de
      // 1,3 px paraissaient plus pâles que les traits des autres icônes, à la même couleur.
      const ink = await page.evaluate(async () => {
        const measure = async (svg) => {
          const clone = svg.cloneNode(true)
          clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
          clone.setAttribute('stroke', '#000')
          const image = new Image()
          image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(clone.outerHTML)}`
          await image.decode()
          const canvas = document.createElement('canvas')
          canvas.width = 20
          canvas.height = 20
          const context = canvas.getContext('2d')
          context.drawImage(image, 0, 0, 20, 20)
          const data = context.getImageData(0, 0, 20, 20).data
          let sum = 0
          for (let i = 3; i < data.length; i += 4) sum += data[i] / 255
          return sum
        }
        const items = [...document.querySelectorAll('.app-rail .rail__item')]
        const more = items.find((el) => el.getAttribute('aria-haspopup'))
        const others = items.filter((el) => el !== more).slice(0, 5)
        const values = await Promise.all(others.map((el) => measure(el.querySelector('svg'))))
        return { more: await measure(more.querySelector('svg')), others: values }
      })
      const average = ink.others.reduce((s, v) => s + v, 0) / ink.others.length
      assert.ok(ink.more >= average * 0.25, `« … » : ${ink.more.toFixed(1)} px d'encre, contre ${average.toFixed(1)} en moyenne pour les autres icônes`)

      const background = (selector) => page.$eval(selector, (el) => getComputedStyle(el).backgroundColor)
      const active = await background('.app-rail .rail__item--active')
      assert.notEqual(await background('.app-rail .rail__item[aria-haspopup="menu"]'), active, 'fermé : pas d’état actif')
      await page.click('.app-rail .rail__item[aria-haspopup="menu"]')
      await page.waitForSelector('.rail__menu')
      await page.mouse.move(600, 400)
      assert.equal(await page.getAttribute('.app-rail .rail__item[aria-haspopup="menu"]', 'aria-expanded'), 'true')
      assert.equal(await background('.app-rail .rail__item[aria-haspopup="menu"]'), active, 'menu ouvert : même état visible que le mode actif')
    })
  })
}
