import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

/**
 * Léo, Windows passé en thème clair : « règle tous les bugs sur le thème clair, cherche partout les petits problèmes ».
 * Inventaire mesuré écran par écran (contraste WCAG de tout le texte, des icônes et des contrôles, dans les deux
 * thèmes, à 760 et 1200 px) ; chaque défaut corrigé est MESURÉ ici, sur la VRAIE fenêtre de Jaris (App.tsx entier) et
 * le CSS COMPILÉ (out/), avec la vraie police Geist :
 *  - Options collé à gauche (grand vide à droite sur un écran large) alors que Machine, Duel et Classement sont centrés ;
 *  - interrupteur éteint invisible en clair (rail 1,45:1, pastille blanche 1,4:1 sur son rail) ;
 *  - barres des voix (Options → Voix) : en clair, les voix non choisies (#6b6b6b) se lisaient « noires » comme la
 *    voix choisie ;
 *  - bouton « Enregistrer l'image » et triangle de lecture des vidéos : encre noire du thème clair sur un voile sombre ;
 *  - accueil et configuration posés sur le gris de la barre de titre en clair (cartes grises sur gris) ;
 *  - panneau GitHub du mode Code coupé à 1200 px par la colonne étroite à côté de l'aperçu (débordement, deux thèmes) ;
 *  - à 760 px : « Connecté · outils : 2 » débordait sur « En ligne » (Outils MCP), et l'intitulé « Micro utilisé »
 *    tombait sur sept lignes, écrasé par le menu du micro.
 * Le thème sombre ne doit pas changer (mêmes mesures, vérifiées dans les deux thèmes).
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}
const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-light-theme-entry.tsx')

// Une petite image (2x2) : une image dessinée par Jaris dans le Chat, et la vignette d'une vidéo.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR42mNk+M9gAkAAAhIBAP0X1ckAAAAASUVORK5CYII='

const ENTRY = `
import { createRoot } from 'react-dom/client'
import App from './src/App'

// Chaque test choisit ses données (window.__flags, posé avant le chargement de la page).
const flags = window.__flags || {}
const conversations = [{ id: 'a', title: 'Recette de crêpes', createdAt: '', updatedAt: '2026-11-06T10:00:00.000Z', messageCount: 2 }]
const known = {
  getProfile: async () => (flags.onboarding ? { name: null } : { name: 'Léo', capacityScanDone: true, models: {} }),
  getRuntimeSetupStatus: async () => ({ ready: true, missing: [] }),
  getSetupStatus: async () => ({ ready: true, missing: [] }),
  getWindowChrome: async () => ({ titleBar: true }),
  getLanguageState: () => ({ setting: 'fr', language: 'fr' }),
  getWidgetMode: async () => false,
  getNewModels: async () => [],
  getAppVersion: async () => '0.0.0',
  listConversations: async () => ({ conversations, activeId: 'a' }),
  getChatHistory: async () => [{ role: 'user', content: 'dessine un phare' }, { role: 'assistant', content: 'Voici ton phare.', image: '${PNG}' }],
  getGeneratedApps: async () => [],
  loadCodeConversations: () => ({ repos: [], conversations: {} }),
  githubStatus: async () => (flags.github ? { available: true, connected: true, login: 'leo' } : { available: false, connected: false, login: null }),
  githubListRepos: async () => [{ fullName: 'leo/un-depot-au-nom-assez-long', private: false, description: null, defaultBranch: 'main', pushedAt: null }],
  listGeneratedImages: async () => [],
  listGeneratedVideos: async () => [{ fileName: 'la-mer.webm', label: 'La mer', timestamp: Date.now() }],
  getImageStudioStatus: async () => ({ supported: true, capable: true, reason: null, installed: true, downloadLabel: '5 Go' }),
  getVideoStudioStatus: async () => ({ supported: true, capable: true, reason: null, qualities: [{ id: 'q', label: 'Q', installed: true, downloadLabel: '0 o' }] }),
  machineGet: async () => ({ saved: null, connected: false, connecting: false, version: null, error: null, freeDiskGb: null, busy: null }),
  listAudioInputDevices: async () => [{ index: 1, name: 'Microphone (Logitech PRO X Gaming Headset)' }],
  mcpList: async () => (flags.mcp
    ? [
        { id: 'c1', name: 'Canva', enabled: true, status: 'ready', error: null, summary: '', secretNames: [], kind: 'online', catalogId: 'canva', tools: [{ name: 'a', description: '', enabled: true }, { name: 'b', description: '', enabled: true }] },
        { id: 'm1', name: 'Météo', enabled: false, status: 'stopped', error: null, summary: '', secretNames: [], kind: 'local', catalogId: null, tools: [] }
      ]
    : [])
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

function buildPage() {
  if (pagePath) return pagePath
  outDir = mkdtempSync(join(tmpdir(), 'jaris-light-'))
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
async function withPage(colorScheme, width, flags, run) {
  const path = buildPage()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width, height: 760 }, colorScheme })
    await page.addInitScript((f) => { window.__flags = f }, flags)
    await page.goto(pathToFileURL(path).href)
    await page.evaluate(() => document.fonts.ready)
    await page.waitForSelector(flags.onboarding ? '.app__onboarding' : '.app-rail .rail__item')
    await page.evaluate(() => {
      // Contraste WCAG d'une couleur posée sur un fond (transparences comprises), et fond réellement peint sous un élément.
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
      const toCss = (c) => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`
      window.__backdrop = (el) => toCss(backdrop(el))
      /** Contraste de `color` posé sur `background` (une couleur), ou sur le fond peint sous l'élément `background`. */
      window.__contrast = (color, background) => { const bg = typeof background === 'string' ? parse(background) : backdrop(background); return ratio(blend(parse(color), bg), bg) }
      window.__lum = (color) => lum(parse(color))
    })
    await run(page)
  } finally {
    await browser.close()
  }
}

const openMode = (page, label) => page.click(`.app-rail .rail__item:has-text("${label}")`)
const openOptions = async (page, tab) => {
  await openMode(page, 'Options')
  await page.click(`.options-page__navigation button:has-text("${tab}")`)
  await page.waitForTimeout(300)
}

for (const scheme of ['light', 'dark']) {
  test(`${scheme} : Options est centré comme Machine (écran large, 1600 px)`, options, async () => {
    await withPage(scheme, 1600, {}, async (page) => {
      const margins = (selector) =>
        page.$eval(selector, (el) => {
          const box = el.getBoundingClientRect()
          const main = document.querySelector('.app-main').getBoundingClientRect()
          return { left: Math.round(box.left - main.left), right: Math.round(main.right - box.right), width: Math.round(box.width) }
        })
      await openOptions(page, 'Voix')
      const voice = await margins('.options-page__content > .options-menu__section')
      assert.ok(voice.width <= 880, `colonne de réglages de ${voice.width} px`)
      assert.ok(Math.abs(voice.left - voice.right) <= 24, `Options → Voix : ${voice.left} px à gauche, ${voice.right} px à droite`)
      await openMode(page, 'Machine')
      const machine = await margins('.machine-page__inner')
      assert.ok(Math.abs(machine.left - machine.right) <= 24, `Machine : ${machine.left} / ${machine.right}`)
    })
  })

  test(`${scheme} : un interrupteur éteint se voit (rail ou pastille ≥ 3:1 sur la carte, pastille ≥ 3:1 sur son rail)`, options, async () => {
    await withPage(scheme, 1200, { mcp: true }, async (page) => {
      await openOptions(page, 'Outils MCP')
      await page.waitForSelector('.mcp-row .options-menu__switch:not(.options-menu__switch--on)')
      const off = await page.$eval('.mcp-row .options-menu__switch:not(.options-menu__switch--on)', (el) => {
        const track = getComputedStyle(el).backgroundColor
        const knob = getComputedStyle(el.querySelector('.options-menu__switch-knob')).backgroundColor
        const card = window.__backdrop(el.parentElement)
        const trackOnCard = window.__contrast(track, card)
        return { trackOnCard, knobOnCard: window.__contrast(knob, card), knobOnTrack: window.__contrast(knob, window.__backdrop(el)) }
      })
      assert.ok(Math.max(off.trackOnCard, off.knobOnCard) >= 3, `éteint : rail à ${off.trackOnCard.toFixed(2)}:1, pastille à ${off.knobOnCard.toFixed(2)}:1 sur la carte`)
      assert.ok(off.knobOnTrack >= 3, `éteint : pastille à ${off.knobOnTrack.toFixed(2)}:1 sur son rail`)
    })
  })

  test(`${scheme} : barres des voix — les voix non choisies se voient et se distinguent nettement de la voix choisie`, options, async () => {
    await withPage(scheme, 1200, {}, async (page) => {
      await openOptions(page, 'Voix')
      const dots = await page.evaluate(() => {
        const all = [...document.querySelectorAll('.options-menu__dot')]
        const active = all.find((el) => el.classList.contains('options-menu__dot--active'))
        const other = all.find((el) => el !== active)
        const card = window.__backdrop(other.parentElement)
        const off = getComputedStyle(other).backgroundColor
        const on = getComputedStyle(active).backgroundColor
        return { offOnCard: window.__contrast(off, card), offOnActive: window.__contrast(off, on) }
      })
      assert.ok(dots.offOnCard >= 3, `voix non choisie à ${dots.offOnCard.toFixed(2)}:1 sur la carte`)
      // En clair, l'écart (« noir » contre « gris foncé », 3,6:1) ne distinguait pas la voix choisie des autres.
      if (scheme === 'light') assert.ok(dots.offOnActive >= 4.5, `voix choisie / non choisie : ${dots.offOnActive.toFixed(2)}:1`)
    })
  })

  test(`${scheme} : sur une image ou une vidéo, l'icône d'enregistrement et le triangle de lecture restent clairs`, options, async () => {
    await withPage(scheme, 1200, {}, async (page) => {
      await openMode(page, 'Chat')
      await page.waitForSelector('.chat-panel__save-image')
      const save = await page.$eval('.chat-panel__save-image', (el) => {
        const icon = getComputedStyle(el.querySelector('svg path, svg polyline, svg line') || el).stroke
        return { icon, ratio: window.__contrast(icon, getComputedStyle(el).backgroundColor), lum: window.__lum(icon) }
      })
      assert.ok(save.lum > 0.7 && save.ratio >= 4.5, `« Enregistrer l'image » : icône ${save.icon}, ${save.ratio.toFixed(2)}:1 sur son voile`)
      await openMode(page, 'Vidéo')
      await page.waitForSelector('.video-panel__thumb-play')
      const play = await page.$eval('.video-panel__thumb-play', (el) => {
        const triangle = getComputedStyle(el, '::after').borderLeftColor
        return { triangle, lum: window.__lum(triangle), ratio: window.__contrast(triangle, getComputedStyle(el).backgroundColor) }
      })
      assert.ok(play.lum > 0.7, `triangle de lecture ${play.triangle} : encre sombre sur le voile sombre de la vignette`)
    })
  })

  test(`${scheme} : l'accueil est posé sur le fond des pages, pas sur le gris de la barre de titre`, options, async () => {
    await withPage(scheme, 1200, { onboarding: true }, async (page) => {
      const look = await page.evaluate(() => {
        const probe = document.createElement('div')
        probe.style.background = 'var(--hud-bg)'
        document.body.appendChild(probe)
        const pageBg = getComputedStyle(probe).backgroundColor
        probe.remove()
        // Le fondu sous « Continuer » (écran de configuration) finit sur ce même fond, pas sur une bande grise.
        const footer = document.createElement('div')
        footer.className = 'capacity-scan__footer'
        document.querySelector('.app-shell__setup').appendChild(footer)
        const fade = getComputedStyle(footer).backgroundImage
        footer.remove()
        return { setup: window.__backdrop(document.querySelector('.app__onboarding')), pageBg, fade }
      })
      assert.equal(look.setup, look.pageBg)
      assert.ok(look.fade.includes(look.pageBg), `fondu de « Continuer » : ${look.fade}, fond des pages ${look.pageBg}`)
    })
  })

  test(`${scheme} : à 1200 px, le panneau GitHub du mode Code n'est plus coupé par la colonne à côté de l'aperçu`, options, async () => {
    await withPage(scheme, 1200, { github: true }, async (page) => {
      await openMode(page, 'Code')
      await page.click('.code-panel .github-picker__trigger')
      await page.waitForSelector('.github-picker__panel input')
      await page.waitForTimeout(200)
      const fit = await page.evaluate(() => {
        const panel = document.querySelector('.github-picker__panel').getBoundingClientRect()
        let left = 0
        let right = innerWidth
        for (let el = document.querySelector('.github-picker').parentElement; el && el !== document.body; el = el.parentElement) {
          if (getComputedStyle(el).overflowX === 'visible') continue
          const box = el.getBoundingClientRect()
          left = Math.max(left, box.left)
          right = Math.min(right, box.right)
        }
        return { panelLeft: Math.round(panel.left), panelRight: Math.round(panel.right), left: Math.round(left), right: Math.round(right) }
      })
      assert.ok(fit.panelLeft >= fit.left && fit.panelRight <= fit.right, `panneau de ${fit.panelLeft} à ${fit.panelRight} px, zone visible de ${fit.left} à ${fit.right} px`)
    })
  })

  test(`${scheme} : à 760 px, « Connecté · outils : 2 » tient sur une ligne sans déborder sur « En ligne » (Outils MCP)`, options, async () => {
    await withPage(scheme, 760, { mcp: true }, async (page) => {
      await openOptions(page, 'Outils MCP')
      await page.waitForSelector('.mcp-row .mcp-status--ready')
      const box = await page.$eval('.mcp-row .mcp-status--ready', (el) => {
        const row = el.closest('.mcp-row__main')
        const r = (sel) => row.querySelector(sel).getBoundingClientRect()
        const range = document.createRange()
        range.selectNodeContents(el)
        const lines = new Set([...range.getClientRects()].map((x) => Math.round(x.top))).size
        return { status: Math.round(el.getBoundingClientRect().right), chevron: Math.round(r('.mcp-row__chevron').left), type: Math.round(r('.mcp-row__type').left), lines }
      })
      assert.ok(box.status <= box.chevron && box.status <= box.type, `badge jusqu'à ${box.status} px, flèche à ${box.chevron}, « En ligne » à ${box.type}`)
      // Un badge coupé au milieu d'un mot (« Conne / cté ») ne serait pas une solution.
      assert.equal(box.lines, 1, `badge sur ${box.lines} lignes`)
    })
  })

  test(`${scheme} : à 760 px, l'intitulé « Micro utilisé » n'est plus écrasé par le menu du micro`, options, async () => {
    await withPage(scheme, 760, {}, async (page) => {
      await openOptions(page, 'Voix')
      await page.waitForSelector('.options-menu__select option:nth-child(2)', { state: 'attached' })
      const lines = await page.evaluate(() => {
        const row = [...document.querySelectorAll('.options-menu__row')].find((el) => el.querySelector('select'))
        const count = (el) => { const r = document.createRange(); r.selectNodeContents(el); return new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size }
        const select = row.querySelector('select').getBoundingClientRect()
        return { label: count(row.querySelector('.options-menu__row-label')), description: count(row.querySelector('.options-menu__row-description')), selectRight: Math.round(select.right), rowRight: Math.round(row.getBoundingClientRect().right) }
      })
      assert.equal(lines.label, 1, `« Micro utilisé » sur ${lines.label} lignes`)
      assert.ok(lines.description <= 3, `description sur ${lines.description} lignes`)
      assert.ok(lines.selectRight <= lines.rowRight, 'le menu reste dans la ligne')
    })
  })
}

// Étape 444 (Léo, en clair : « en haut à gauche tu ne vois pas un truc qui cloche ? le logo ») : le disque noir posé
// derrière le logo en clair faisait tache. Plus de disque ; l'orbe garde son cyan d'origine dans les deux thèmes (une
// version assombrie en clair a été refusée : « trop sombre, pas comme avant »).
for (const scheme of ['light', 'dark']) {
  test(`${scheme} : logo de la barre de titre sans disque, orbe de son cyan d'origine`, options, async () => {
    await withPage(scheme, 1200, {}, async (page) => {
      await page.waitForSelector('.titlebar__logo canvas')
      await page.waitForTimeout(400)
      const logo = await page.$eval('.titlebar__logo', (el) => {
        const cs = getComputedStyle(el)
        const canvas = el.querySelector('canvas')
        const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
        // Le pixel le plus couvrant du dessin : la couleur du trait de l'orbe.
        let best = null
        for (let i = 0; i < data.length; i += 4) if (!best || data[i + 3] > best[3]) best = [data[i], data[i + 1], data[i + 2], data[i + 3]]
        return { background: cs.backgroundColor, shadow: cs.boxShadow, stroke: best.slice(0, 3) }
      })
      assert.equal(logo.background, 'rgba(0, 0, 0, 0)', 'plus de disque derrière le logo')
      assert.equal(logo.shadow, 'none')
      // #33e6c8 (éclairci par son halo) : cyan vif, pas une teinte assombrie.
      const [r, g, b] = logo.stroke
      assert.ok(r < 90 && g >= 220 && b >= 190, `cyan vif attendu, trouvé rgb(${logo.stroke.join(', ')})`)
    })
  })
}
