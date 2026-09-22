import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, globSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Sélecteur de modèle (étape 141, Léo : « ajoute dans chat code vocal, la possibilité de choisir le model ou
 * faire auto »), sur le VRAI ChatPanel et le vrai CSS compilé : il est bien dans la barre du champ de saisie,
 * il propose Auto + les modèles installés sous leur nom lisible, et un choix envoie le VRAI identifiant du
 * modèle au main process (jamais le nom affiché). Playwright absent : tests ignorés, jamais verts en silence.
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
import ModelPicker from './src/components/ModelPicker'

const INSTALLED = ['gemma4:12b', 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF:latest', 'qwen3.5:4b']
window.__choices = { code: null, chat: null }
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
    autoModel: mode === 'code' ? 'qwen2.5-coder:7b' : null
  }),
  setModelChoice: (mode, model) => {
    window.__calls.push([mode, model])
    window.__choices[mode] = model
    return Promise.resolve()
  }
}

createRoot(document.getElementById('root')).render(<Panel />)
createRoot(document.getElementById('code-picker')).render(<ModelPicker mode="code" />)
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
  </style></head><body><div id="root"></div><div id="code-picker"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

/** try/finally : sinon une assertion qui échoue laisse Chromium ouvert et `node --test` ne se termine jamais. */
async function withPage(run) {
  const html = buildPage()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.setContent(html)
    await page.waitForSelector('#root .model-picker__select option:nth-child(2)', { state: 'attached' })
    await run(page)
  } finally {
    await browser.close()
  }
}


const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('le sélecteur est dans la barre du champ du Chat et propose Auto + les modèles installés, sous leur nom lisible', options, async () => {
  await withPage(async (page) => {
    assert.equal(await page.locator('#root .composer__actions .model-picker__select').count(), 1)
    const labels = await page.locator('#root .model-picker__select option').allTextContents()
    assert.deepEqual(labels, ['Auto (selon la question)', 'gemma4:12b', 'G9v3-3B', 'qwen3.5:4b'])
    assert.equal(await page.inputValue('#root .model-picker__select'), '', 'Auto par défaut')
  })
})

test('choisir un modèle envoie son VRAI identifiant, et revenir à Auto envoie null', options, async () => {
  await withPage(async (page) => {
    await page.selectOption('#root .model-picker__select', { label: 'G9v3-3B' })
    await page.waitForFunction(() => window.__calls.length === 1)
    await page.selectOption('#root .model-picker__select', { label: 'Auto (selon la question)' })
    await page.waitForFunction(() => window.__calls.length === 2)
    assert.deepEqual(await page.evaluate(() => window.__calls), [
      ['chat', 'hf.co/bartowski/ai9stars_G9v3-3B-GGUF:latest'],
      ['chat', null]
    ])
  })
})

test("en mode Code, Auto nomme le modèle qu'il utilise", options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('#code-picker .model-picker__select option:nth-child(2)', { state: 'attached' })
    assert.equal(await page.textContent('#code-picker .model-picker__select option:first-child'), 'Auto (qwen2.5-coder:7b)')
  })
})

test("le sélecteur reste discret : pas le cadre plein des champs de saisie (règle globale en !important)", options, async () => {
  await withPage(async (page) => {
    const style = await page.evaluate(() => {
      const s = getComputedStyle(document.querySelector('#root .model-picker__select'))
      return { border: s.borderTopColor, radius: s.borderTopLeftRadius, background: s.backgroundColor }
    })
    assert.equal(style.border, 'rgba(0, 0, 0, 0)', 'bordure transparente au repos')
    assert.equal(style.radius, '10px', 'coins arrondis comme l’icône de pièce jointe')
    assert.equal(style.background, 'rgba(0, 0, 0, 0)')
  })
})
