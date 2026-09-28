import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, globSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Sélecteur de modèle (étape 141) devenu « modèle + effort » façon ChatGPT (étape 191, Léo : « même présentation
 * que ChatGPT… ajoute effort et modèle »), sur le VRAI ChatPanel et le vrai CSS compilé : le champ a le texte en
 * haut, « + » à gauche, modèle/effort puis envoi rond à droite ; le panneau propose un curseur à cinq crans et
 * la liste des modèles, et chaque choix part au main process sous son vrai identifiant. Playwright absent :
 * tests ignorés, jamais verts en silence.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-model-picker-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import Panel from './src/components/ChatPanel'
import ModelEffortPicker from './src/components/ModelEffortPicker'

const INSTALLED = ['gemma4:12b', 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF:latest', 'qwen3.5:4b']
window.__choices = { code: null, chat: null }
window.__efforts = { code: null, chat: null }
window.__calls = []

window.jaris = {
  getChatHistory: () => Promise.resolve([]),
  listConversations: () => Promise.resolve({ activeId: 'a', conversations: [{ id: 'a', title: 'Nouvelle conversation', createdAt: '', updatedAt: '2026-09-14T10:00:00.000Z', messageCount: 0 }] }),
  selectConversation: () => Promise.resolve({ activeId: 'a', conversations: [] }),
  createConversation: () => Promise.resolve({ activeId: 'a', conversations: [] }),
  deleteConversation: () => Promise.resolve({ activeId: 'a', conversations: [] }),
  onLog: () => () => {},
  onChatStreamToken: () => () => {},
  getProfile: () => Promise.resolve({ soundEffectsEnabled: false }),
  pickImageFile: () => Promise.resolve(null),
  sendChatMessage: () => Promise.resolve({ role: 'assistant', content: 'ok' }),
  getModelChoice: (mode) => Promise.resolve({
    selected: window.__choices[mode] ?? null,
    installed: INSTALLED,
    autoModel: mode === 'code' ? 'qwen2.5-coder:7b' : null,
    effort: window.__efforts[mode] ?? null,
    effortModel: mode === 'code' ? (window.__codeModel ?? 'qwen3.8:27b') : null,
    effortLevels: mode === 'code' ? (window.__codeLevels ?? 'off · low · medium · xhigh') : null,
    effortApplied: mode === 'code' ? ({ none: 'sans réflexion', low: 'low', medium: 'medium', high: 'xhigh', max: 'xhigh' }[window.__efforts.code] ?? 'automatique') : null,
    roles: [
      { value: 'role:flash', label: 'Rapide', model: 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF:latest', installed: true },
      { value: 'role:medium', label: 'Médium', model: 'gemma4:12b', installed: true },
      { value: 'role:large', label: 'Puissant', model: 'qwen3.5:4b', installed: true },
      { value: 'role:vision', label: 'Vision', model: 'gemma4:12b', installed: true },
      { value: 'role:code', label: 'Code', model: 'qwen2.5-coder:7b', installed: false }
    ]
  }),
  setEffortChoice: (mode, effort) => {
    window.__calls.push(['effort', mode, effort])
    window.__efforts[mode] = effort
    return Promise.resolve()
  },
  setModelChoice: (mode, model) => {
    window.__calls.push([mode, model])
    window.__choices[mode] = model
    return Promise.resolve()
  }
}

createRoot(document.getElementById('root')).render(<Panel />)
createRoot(document.getElementById('code-picker')).render(<ModelEffortPicker mode="code" />)
`

let pageHtml = null
let outDir = null

function buildPage() {
  if (pageHtml) return pageHtml
  outDir = mkdtempSync(join(tmpdir(), 'jaris-model-picker-ui-'))
  const bundlePath = join(outDir, 'bundle.js')

  writeFileSync(entryPath, ENTRY)
  try {
    execFileSync(
      'npx',
      [
        'esbuild',
        entryPath,
        '--bundle',
        '--format=iife',
        '--loader:.tsx=tsx',
        '--jsx=automatic',
        `--alias:@=${join(projectRoot, 'src')}`,
        `--outfile=${bundlePath}`
      ],
      { cwd: projectRoot, stdio: 'pipe' }
    )
  } finally {
    rmSync(entryPath, { force: true })
  }

  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><style>
    html,body{margin:0;height:100%;background:#05070c;}
    #root{height:90%;display:flex;}
    ${css}
    #code-picker{position:fixed;left:40px;bottom:40px;}
  </style></head><body><div id="root"></div><div id="code-picker"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

/** try/finally : sinon une assertion qui échoue laisse Chromium ouvert et `node --test` ne se termine jamais. */
async function withPage(run, init = '') {
  const html = buildPage()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.setContent(init ? html.replace('<body>', `<body><script>${init}</script>`) : html)
    await page.waitForSelector('#root .effort-picker__trigger')
    await run(page)
  } finally {
    await browser.close()
  }
}


const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('le champ du Chat : texte en haut, « + » à gauche, modèle/effort puis envoi rond à droite', options, async () => {
  await withPage(async (page) => {
    const box = async (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
    const input = await box('#root .composer__input')
    const plus = await box('#root .composer__plus')
    const picker = await box('#root .effort-picker__trigger')
    const send = await box('#root .composer__send')
    assert.ok(input.y + input.h <= plus.y + 1, 'le texte est au-dessus de la rangée de boutons')
    assert.ok(plus.x < picker.x && picker.x < send.x, '« + » à gauche, puis modèle/effort, puis envoi')
    assert.ok(send.x + send.w > input.x + input.w - 30, 'envoi tout à droite')
    const sendStyle = await page.$eval('#root .composer__send', (el) => ({ radius: getComputedStyle(el).borderRadius, clip: getComputedStyle(el).clipPath, bg: getComputedStyle(el).backgroundColor }))
    assert.equal(sendStyle.clip, 'none', 'plus de coins coupés : un bouton rond')
    assert.ok(parseFloat(sendStyle.radius) >= 18, `envoi rond (rayon ${sendStyle.radius})`)
    assert.notEqual(sendStyle.bg, 'rgba(0, 0, 0, 0)', 'envoi rempli')
    assert.match(await page.textContent('#root .effort-picker__trigger'), /Auto\s*Auto/)
  })
})

test('« + » ouvre le menu Ajouter, avec l’image et le rappel Ctrl+V ; un clic ailleurs le ferme', options, async () => {
  await withPage(async (page) => {
    await page.click('#root .composer__plus')
    await page.waitForSelector('#root .composer__menu')
    assert.match(await page.textContent('#root .composer__menu'), /Ajouter.*Joindre une image.*Ctrl\+V/s)
    const menu = await page.$eval('#root .composer__menu', (el) => el.getBoundingClientRect().bottom)
    const plus = await page.$eval('#root .composer__plus', (el) => el.getBoundingClientRect().top)
    assert.ok(menu <= plus, 'le menu s’ouvre AU-DESSUS du champ (le champ est en bas de l’écran)')
    await page.mouse.click(600, 100)
    await page.waitForSelector('#root .composer__menu', { state: 'detached' })
  })
})

test('effort : cinq crans ; choisir « Moyenne » l’enregistre, ↻ revient à Auto', options, async () => {
  await withPage(async (page) => {
    await page.click('#root .effort-picker__trigger')
    await page.waitForSelector('#root .effort-picker__panel')
    assert.equal(await page.locator('#root .effort-picker__step').count(), 5)
    const panel = await page.$eval('#root .effort-picker__panel', (el) => el.getBoundingClientRect().bottom)
    const trigger = await page.$eval('#root .effort-picker__trigger', (el) => el.getBoundingClientRect().top)
    assert.ok(panel <= trigger, 'le panneau s’ouvre au-dessus')
    await page.click('#root .effort-picker__step[aria-label="Moyenne"]')
    await page.waitForFunction(() => document.querySelector('#root .effort-picker__current')?.textContent === 'Moyenne')
    assert.match(await page.textContent('#root .effort-picker__trigger'), /Auto\s*Moyenne/)
    // Le cran s'allume en 0,15 s (transition) : on attend la fin plutôt que de lire la toute première image.
    await page.waitForFunction(() => {
      const el = document.querySelector('#root .effort-picker__step--active')
      return el && getComputedStyle(el).backgroundColor === 'rgb(230, 247, 255)'
    }, null, { timeout: 2000 })
    await page.click('#root .effort-picker__reset')
    await page.waitForFunction(() => document.querySelector('#root .effort-picker__current')?.textContent === 'Auto')
    assert.deepEqual(await page.evaluate(() => window.__calls.filter((c) => c[0] === 'effort')), [['effort', 'chat', 'medium'], ['effort', 'chat', null]])
  })
})

test('le nom du modèle ouvre la liste « Par défaut » + rôles ; un rôle non installé est grisé', options, async () => {
  await withPage(async (page) => {
    await page.click('#root .effort-picker__trigger')
    await page.click('#root .effort-picker__model-link')
    await page.waitForSelector('#root .effort-picker__list')
    const titles = await page.$$eval('#root .effort-picker__option-title', (els) => els.map((el) => el.textContent))
    assert.deepEqual(titles, ['Par défaut', 'Rapide', 'Médium', 'Puissant', 'Vision', 'Code'])
    assert.equal(await page.locator('#root .effort-picker__option:has-text("Code")').isDisabled(), true)
    await page.click('#root .effort-picker__option:has-text("Puissant")')
    await page.waitForSelector('#root .effort-picker__slider')
    assert.match(await page.textContent('#root .effort-picker__trigger'), /Puissant/)
    assert.deepEqual(await page.evaluate(() => window.__calls.filter((c) => c[0] === 'chat')), [['chat', 'role:large']])
  })
})

test('Code : le panneau dit les VRAIS niveaux du modèle et ce que l’effort donnera dessus', options, async () => {
  await withPage(async (page) => {
    await page.click('#code-picker .effort-picker__trigger')
    await page.click('#code-picker .effort-picker__step[aria-label="Élevée"]')
    await page.waitForFunction(() => /qwen3\.8:27b : off · low · medium · xhigh → xhigh/.test(document.querySelector('#code-picker .effort-picker__note')?.textContent ?? ''))
  })
})

test('un modèle qui ne réfléchit pas : curseur désactivé et expliqué', options, async () => {
  await withPage(async (page) => {
    await page.click('#code-picker .effort-picker__trigger')
    await page.waitForSelector('#code-picker .effort-picker__slider--off')
    assert.match(await page.textContent('#code-picker .effort-picker__note'), /qwen2\.5-coder:7b ne réfléchit pas/)
    assert.equal(await page.locator('#code-picker .effort-picker__step').first().isDisabled(), true)
  }, "window.__codeModel = 'qwen2.5-coder:7b'; window.__codeLevels = 'ne réfléchit pas'")
})
