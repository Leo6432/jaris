import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, globSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Sélecteur de modèle (étape 141) devenu « modèle + réflexion » façon ChatGPT (étapes 191 à 193), sur le VRAI
 * ChatPanel et le vrai CSS compilé. Léo (étape 193, capture de ChatGPT à l'appui) : le modèle est affiché dès
 * l'ouverture ; l'icône de raisonnement n'apparaît que si le modèle réfléchit ; la barre seulement s'il a des
 * niveaux, avec un cran par niveau RÉEL — jamais « max » sur un modèle qui n'a rien. Playwright absent : tests
 * ignorés, jamais verts en silence.
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

const INSTALLED = ['gemma4:12b', 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF:latest', 'qwen3.8:27b']
window.__choices = { code: null, chat: null }
window.__thinks = { code: null, chat: null }
window.__calls = []

const ROLES = [
  { value: 'role:flash', label: 'Rapide', model: 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF:latest', installed: true },
  { value: 'role:medium', label: 'Médium', model: 'gemma4:12b', installed: true },
  { value: 'role:large', label: 'Puissant', model: 'qwen3.8:27b', installed: true },
  { value: 'role:vision', label: 'Vision', model: 'gemma4:12b', installed: true },
  { value: 'role:code', label: 'Code', model: 'qwen2.5-coder:14b', installed: false }
]
// Ce que le main calcule depuis /api/show (shared/effort.ts), pour chaque modèle.
const THINKING = {
  'qwen3.8:27b': { kind: 'levels', options: ['off', 'low', 'medium', 'xhigh'].map((l) => ({ value: l === 'off' ? false : l, label: l })) },
  'gemma4:12b': { kind: 'toggle', options: [{ value: false, label: 'off' }, { value: true, label: 'on' }] },
  'hf.co/bartowski/ai9stars_G9v3-3B-GGUF:latest': { kind: 'none', options: [] },
  'qwen2.5-coder:7b': { kind: 'none', options: [] }
}

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
  getModelChoice: (mode) => {
    const autoModel = mode === 'code' ? 'qwen2.5-coder:7b' : null
    const selected = window.__choices[mode] ?? null
    const model = selected ? ROLES.find((r) => r.value === selected).model : autoModel
    return Promise.resolve({
      selected,
      installed: INSTALLED,
      autoModel,
      roles: ROLES,
      thinking: model ? { model, ...THINKING[model], selected: window.__thinks[mode] } : null
    })
  },
  setThinkChoice: (mode, think) => {
    window.__calls.push(['think', mode, think])
    window.__thinks[mode] = think
    return Promise.resolve()
  },
  setModelChoice: (mode, model) => {
    window.__calls.push([mode, model])
    window.__choices[mode] = model
    window.__thinks[mode] = null
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
    assert.equal((await page.textContent('#root .effort-picker__trigger')).trim(), 'Auto', 'rien sur la réflexion tant qu’aucun modèle n’est choisi')
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

async function openPicker(page, root = '#root') {
  await page.click(`${root} .effort-picker__trigger`)
  await page.waitForSelector(`${root} .effort-picker__head`)
}

async function chooseRole(page, label, root = '#root') {
  await page.click(`${root} .effort-picker__model-link`)
  await page.click(`${root} .effort-picker__option:has-text("${label}")`)
  await page.waitForSelector(`${root} .effort-picker__head`)
}

const hasReasoningIcon = (page, root = '#root') => page.locator(`${root} .effort-picker__head-icon svg`).count()
const steps = (page, root = '#root') => page.$$eval(`${root} .effort-picker__step`, (els) => els.map((el) => el.getAttribute('aria-label')))

test('dès l’ouverture : le modèle est affiché ; en Chat Auto, ni icône de raisonnement ni barre', options, async () => {
  await withPage(async (page) => {
    await openPicker(page)
    assert.match(await page.textContent('#root .effort-picker__model-link'), /Auto/)
    assert.equal(await hasReasoningIcon(page), 0)
    assert.equal(await page.locator('#root .effort-picker__slider').count(), 0)
    assert.match(await page.textContent('#root .effort-picker__note'), /choisis un modèle/)
    assert.equal(await page.locator('#root .effort-picker__panel svg path[d^="M13 3L5"]').count(), 0, 'plus d’éclair')
  })
})

test('modèle à niveaux (qwen3.8) : icône de raisonnement + barre avec SES niveaux, jamais « high » ni « max »', options, async () => {
  await withPage(async (page) => {
    await openPicker(page)
    await chooseRole(page, 'Puissant')
    await page.waitForSelector('#root .effort-picker__slider')
    assert.match(await page.textContent('#root .effort-picker__model-link'), /Puissant.*qwen3\.8:27b/)
    assert.equal(await hasReasoningIcon(page), 1)
    assert.deepEqual(await steps(page), ['off', 'low', 'medium', 'xhigh'])
    assert.match(await page.textContent('#root .effort-picker__current'), /^Auto$/)

    await page.click('#root .effort-picker__step[aria-label="medium"]')
    await page.waitForSelector('#root .effort-picker__step--active[aria-label="medium"]')
    assert.deepEqual((await page.evaluate(() => window.__calls)).at(-1), ['think', 'chat', 'medium'])
    assert.match(await page.textContent('#root .effort-picker__current'), /^medium$/)
    assert.match(await page.textContent('#root .effort-picker__trigger'), /Puissant\s*medium/)

    await page.click('#root .effort-picker__step[aria-label="off"]')
    await page.waitForSelector('#root .effort-picker__step--active[aria-label="off"]')
    assert.deepEqual((await page.evaluate(() => window.__calls)).at(-1), ['think', 'chat', false], '« off » envoie false, pas un texte')

    await page.click('#root .effort-picker__reset')
    await page.waitForFunction(() => document.querySelector('#root .effort-picker__current').textContent === 'Auto')
    assert.deepEqual((await page.evaluate(() => window.__calls)).at(-1), ['think', 'chat', null])
  })
})

test('modèle avec ou sans (gemma4) : icône de raisonnement + interrupteur, pas de barre', options, async () => {
  await withPage(async (page) => {
    await openPicker(page)
    await chooseRole(page, 'Médium')
    await page.waitForSelector('#root .effort-picker__toggle')
    assert.equal(await hasReasoningIcon(page), 1)
    assert.equal(await page.locator('#root .effort-picker__slider').count(), 0)
    await page.click('#root .effort-picker__toggle')
    await page.waitForSelector('#root .effort-picker__toggle[aria-checked="true"]')
    assert.deepEqual((await page.evaluate(() => window.__calls)).at(-1), ['think', 'chat', true])
  })
})

test('modèle qui ne réfléchit pas : ni icône, ni barre — et changer de modèle efface la réflexion précédente', options, async () => {
  await withPage(async (page) => {
    await openPicker(page)
    await chooseRole(page, 'Puissant')
    await page.click('#root .effort-picker__step[aria-label="xhigh"]')
    await page.waitForFunction(() => /xhigh/.test(document.querySelector('#root .effort-picker__trigger').textContent))

    await chooseRole(page, 'Rapide')
    await page.waitForFunction(() => /ne réfléchit pas/.test(document.querySelector('#root .effort-picker__panel').textContent))
    assert.equal(await hasReasoningIcon(page), 0)
    assert.equal(await page.locator('#root .effort-picker__slider, #root .effort-picker__toggle').count(), 0, 'impossible de mettre « max » sur ce modèle')
    assert.doesNotMatch(await page.textContent('#root .effort-picker__trigger'), /xhigh/)
  })
})

test('Code en Auto : le modèle d’Auto est affiché avec ses vrais choix ; un rôle non installé est grisé', options, async () => {
  await withPage(async (page) => {
    await openPicker(page, '#code-picker')
    assert.match(await page.textContent('#code-picker .effort-picker__model-link'), /qwen2\.5-coder:7b/)
    assert.match(await page.textContent('#code-picker .effort-picker__note'), /ne réfléchit pas/)
    await page.click('#code-picker .effort-picker__model-link')
    assert.equal(await page.locator('#code-picker .effort-picker__option').last().isDisabled(), true)
  })
})

test('la barre est habillée par le CSS de Jaris (pilule, cran choisi en disque clair)', options, async () => {
  await withPage(async (page) => {
    await openPicker(page)
    await chooseRole(page, 'Puissant')
    await page.click('#root .effort-picker__step[aria-label="medium"]')
    await page.waitForSelector('#root .effort-picker__step--active')
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#root .effort-picker__step--active')).backgroundColor === 'rgb(230, 247, 255)')
    const slider = await page.$eval('#root .effort-picker__slider', (el) => getComputedStyle(el).borderRadius)
    assert.ok(parseFloat(slider) >= 15, `barre en pilule (rayon ${slider})`)
  })
})
