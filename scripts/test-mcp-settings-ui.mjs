import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Étape 418 : Options → Outils MCP (McpSettings.tsx), dans un vrai navigateur avec le CSS compilé : coller une
 * configuration, voir l'état de chaque serveur (connecté avec ses outils, ou la vraie raison d'un échec), décocher
 * un outil, supprimer après confirmation. Le faux pont reproduit les transitions du vrai main (démarre → connecté).
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-mcp-settings-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import McpSettings from './src/components/McpSettings'

const listeners = []
window.__calls = []
window.__servers = window.__servers || []
const emit = () => listeners.forEach((cb) => cb(JSON.parse(JSON.stringify(window.__servers))))
window.__emit = emit
const reply = () => Promise.resolve(JSON.parse(JSON.stringify(window.__servers)))
window.jaris = {
  mcpList: () => reply(),
  onMcpChanged: (cb) => { listeners.push(cb); return () => {} },
  mcpAdd: async (pasted, name) => {
    window.__calls.push(['add', pasted, name ?? null])
    if (!pasted.includes('mcpServers')) throw new Error("Error invoking remote method 'jaris:mcp-add': Error: Rien de reconnu. Colle la configuration donnée par la page du serveur.")
    window.__servers.push({ id: 's1', name: name || 'github', enabled: true, status: 'connecting', error: null, summary: 'npx -y @modelcontextprotocol/server-github', secretNames: ['GITHUB_PERSONAL_ACCESS_TOKEN'], tools: [] })
    // Comme le vrai main : le serveur démarre, puis il est connecté et ses outils arrivent par l'évènement.
    setTimeout(() => {
      Object.assign(window.__servers[0], { status: 'ready', tools: [
        { name: 'list_issues', description: 'List issues in a GitHub repository with filtering options', enabled: true, readOnly: true },
        { name: 'create_issue', description: 'Create a new issue in a GitHub repository', enabled: true, readOnly: false }
      ] })
      emit()
    }, 50)
    return reply()
  },
  mcpSetToolEnabled: async (id, tool, enabled) => {
    window.__calls.push(['tool', id, tool, enabled])
    window.__servers.find((s) => s.id === id).tools.find((t) => t.name === tool).enabled = enabled
    return reply()
  },
  mcpSetEnabled: async (id, enabled) => {
    window.__calls.push(['enabled', id, enabled])
    Object.assign(window.__servers.find((s) => s.id === id), { enabled, status: enabled ? 'connecting' : 'off' })
    return reply()
  },
  mcpRestart: async (id) => { window.__calls.push(['restart', id]); return reply() },
  mcpRemove: async (id) => {
    window.__calls.push(['remove', id])
    window.__servers = window.__servers.filter((s) => s.id !== id)
    return reply()
  }
}
createRoot(document.getElementById('root')).render(<div className="options-page"><div className="options-page__content"><McpSettings /></div></div>)
`

let pageHtml = null
function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-mcp-ui-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, outfile: bundlePath })
  } finally {
    rmSync(entryPath, { force: true })
  }
  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><style>html,body{margin:0;background:#05070c;}${css}</style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

async function withPage(run, { width = 1000, init = '' } = {}) {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width, height: 900 })
    // L'état de départ du faux main, posé AVANT le code de l'écran (setContent ne déclenche pas addInitScript).
    await page.setContent(buildPage().replace('<div id="root"></div>', `<div id="root"></div><script>${init}</script>`))
    await page.waitForSelector('.mcp')
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }
const PASTE = '{"mcpServers": {"github": {"command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_secret"}}}}'

test('coller une configuration : le serveur démarre, puis se dit connecté avec ses outils ; une erreur dit la vraie raison', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.mcp-empty')
    assert.match(await page.textContent('.mcp-empty'), /Aucun serveur MCP/)
    const add = page.getByRole('button', { name: 'Ajouter' })
    assert.equal(await add.isDisabled(), true, 'rien à ajouter')
    // Un texte non reconnu : le vrai message du main, sans le préfixe technique d'Electron.
    await page.fill('.mcp-add__input', 'bonjour')
    await add.click()
    await page.waitForSelector('.mcp-add .mcp-error')
    assert.equal(await page.textContent('.mcp-add .mcp-error'), 'Rien de reconnu. Colle la configuration donnée par la page du serveur.')

    await page.fill('.mcp-add__input', PASTE)
    await add.click()
    await page.waitForSelector('.mcp-status--connecting')
    assert.equal(await page.inputValue('.mcp-add__input'), '', 'le champ se vide une fois ajouté')
    await page.waitForSelector('.mcp-status--ready')
    assert.equal(await page.textContent('.mcp-status--ready'), 'Connecté · outils : 2')
    assert.match(await page.textContent('.mcp-server__secrets'), /GITHUB_PERSONAL_ACCESS_TOKEN/)
    assert.doesNotMatch(await page.textContent('.mcp-server'), /ghp_secret/)
    // La pastille « connecté » est verte pour de vrai (style calculé), « erreur » non.
    const pill = await page.$eval('.mcp-status--ready', (el) => getComputedStyle(el).color)
    assert.notEqual(pill, await page.$eval('.mcp-server__summary', (el) => getComputedStyle(el).color))

    // Les outils : repliés, puis dépliés ; lecture seule dite ; un outil décoché part au main.
    await page.click('.mcp-tools > summary')
    assert.match(await page.textContent('.mcp-tools > summary'), /2 sur 2/)
    assert.match(await page.textContent('.mcp-tool:first-child'), /list_issues\s*lecture seule/)
    await page.getByRole('switch', { name: 'Proposer « create_issue » à Jaris' }).click()
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'tool'))
    assert.deepEqual(await page.evaluate(() => window.__calls.find((c) => c[0] === 'tool')), ['tool', 's1', 'create_issue', false])
    assert.match(await page.textContent('.mcp-tools > summary'), /1 sur 2/)
    assert.equal(await page.getByRole('switch', { name: 'Proposer « create_issue » à Jaris' }).getAttribute('aria-checked'), 'false')
    // Décoché pour de vrai à l'écran (pas seulement dans l'attribut) : le rail n'a pas la couleur d'un outil actif.
    await page.waitForTimeout(400)
    const rails = await page.$$eval('.mcp-tool [role=switch]', (els) => els.map((el) => getComputedStyle(el).backgroundColor))
    assert.notEqual(rails[0], rails[1])
    if (process.env.JARIS_SHOT) {
      await page.mouse.move(0, 0)
      await page.screenshot({ path: process.env.JARIS_SHOT, fullPage: true })
    }
  })
})

test('un serveur en échec montre son message ; Relancer ; Supprimer demande confirmation dans la page', options, async () => {
  const init = `window.__servers = [{ id: 's9', name: 'fichiers', enabled: true, status: 'error', error: "La commande « npx » est introuvable sur ce PC. Pour « npx », installe Node.js (nodejs.org).", summary: 'npx -y @modelcontextprotocol/server-filesystem C:\\\\Users\\\\Léo', secretNames: [], tools: [] }]`
  await withPage(async (page) => {
    await page.waitForSelector('.mcp-status--error')
    assert.equal(await page.textContent('.mcp-status--error'), 'Erreur')
    assert.match(await page.textContent('.mcp-server .mcp-error'), /installe Node\.js/)
    await page.getByRole('button', { name: 'Relancer' }).click()
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'restart'))
    await page.getByRole('button', { name: 'Supprimer' }).click()
    assert.match(await page.textContent('.mcp-server__confirm'), /Supprimer « fichiers » \?/)
    await page.getByRole('button', { name: 'Annuler' }).click()
    assert.equal(await page.evaluate(() => window.__calls.some((c) => c[0] === 'remove')), false, 'rien n’est supprimé sans confirmation')
    await page.getByRole('button', { name: 'Supprimer' }).click()
    await page.locator('.mcp-btn--danger').click()
    await page.waitForSelector('.mcp-empty')
    // Désactivé : pastille « Désactivé », plus de bouton Relancer.
  }, { init })
})

test('fenêtre étroite (760 px) : rien ne déborde, le champ et les boutons restent dans la carte', options, async () => {
  const init = `window.__servers = [{ id: 's1', name: 'un serveur au nom vraiment très long pour voir', enabled: false, status: 'off', error: null, summary: 'npx -y @modelcontextprotocol/server-filesystem C:\\\\Users\\\\Léo\\\\Documents\\\\Un dossier au chemin très long', secretNames: [], tools: [] }]`
  await withPage(async (page) => {
    await page.waitForSelector('.mcp-status--off')
    assert.equal(await page.textContent('.mcp-status--off'), 'Désactivé')
    assert.equal(await page.getByRole('button', { name: 'Relancer' }).count(), 0, 'rien à relancer quand il est désactivé')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert.ok(overflow <= 0, `débordement horizontal de ${overflow} px`)
    const inside = await page.$eval('.mcp-server', (card) => {
      const c = card.getBoundingClientRect()
      return [...card.querySelectorAll('button, .mcp-server__summary')].every((el) => {
        const r = el.getBoundingClientRect()
        return r.left >= c.left - 0.5 && r.right <= c.right + 0.5
      })
    })
    assert.equal(inside, true)
    const field = await page.$eval('.mcp-add__input', (el) => ({ radius: parseFloat(getComputedStyle(el).borderTopLeftRadius), font: getComputedStyle(el).fontFamily }))
    assert.ok(field.radius >= 8, 'habillé par le CSS de Jaris')
    assert.match(field.font, /Mono|Consolas|monospace/i, 'une configuration se lit en police à chasse fixe')
    await page.getByRole('switch', { name: /Activer un serveur/ }).click()
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'enabled'))
    assert.deepEqual(await page.evaluate(() => window.__calls.find((c) => c[0] === 'enabled')), ['enabled', 's1', true])
  }, { width: 760, init })
})
