import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Étapes 418-419 : Options → Outils MCP (McpSettings.tsx), dans un vrai navigateur avec le CSS compilé, sur le modèle
 * des Connecteurs de Claude : « Les vôtres » (actif/désactivé, détails), « Découvrir » (la base de Jaris, ajoutée d'un
 * clic, avec dossier ou clé), « + Ajouter » (son propre serveur). Le faux pont reproduit les transitions du vrai main.
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
const reply = () => Promise.resolve(JSON.parse(JSON.stringify(window.__servers)))
const server = (patch) => ({ enabled: true, status: 'connecting', error: null, secretNames: [], tools: [], kind: 'local', catalogId: null, ...patch })
// Comme le vrai main : le serveur démarre, puis il est connecté et ses outils arrivent par l'évènement.
const connectLater = (id, tools, delay = 50) => setTimeout(() => {
  Object.assign(window.__servers.find((s) => s.id === id), { status: 'ready', tools })
  emit()
}, delay)
window.jaris = {
  mcpList: () => reply(),
  onMcpChanged: (cb) => { listeners.push(cb); return () => {} },
  mcpCatalogAdd: async (id) => {
    window.__calls.push(['catalog', id])
    const names = { canva: 'Canva', notion: 'Notion', zapier: 'Zapier' }
    // Comme le vrai main : ajouté, la page de connexion s'ouvre (« Connexion dans ton navigateur… »), puis connecté.
    window.__servers.push(server({ id: 'c-' + id, name: names[id] ?? id, catalogId: id, kind: 'online', status: 'authorizing', summary: 'https://mcp.' + id + '.com/mcp' }))
    // Le temps de se connecter dans le navigateur.
    connectLater('c-' + id, [{ name: 'list-designs', description: 'List designs', enabled: true, readOnly: true }], 1500)
    return reply()
  },
  mcpSignIn: async (id) => {
    window.__calls.push(['signin', id])
    Object.assign(window.__servers.find((s) => s.id === id), { status: 'authorizing', error: null })
    return reply()
  },
  mcpCancelSignIn: async (id) => {
    window.__calls.push(['cancelSignin', id])
    Object.assign(window.__servers.find((s) => s.id === id), { status: 'signin' })
    return reply()
  },
  mcpAdd: async (pasted, name) => {
    window.__calls.push(['add', pasted, name ?? null])
    if (!pasted.includes('mcpServers')) throw new Error("Error invoking remote method 'jaris:mcp-add': Error: Rien de reconnu. Colle la configuration donnée par la page du serveur.")
    window.__servers.push(server({ id: 's1', name: name || 'mon-serveur', summary: 'npx -y mon-serveur', secretNames: ['API_KEY'] }))
    connectLater('s1', [
      { name: 'list_issues', description: 'List issues in a repository', enabled: true, readOnly: true },
      { name: 'create_issue', description: 'Create a new issue', enabled: true, readOnly: false }
    ])
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
    await page.setViewportSize({ width, height: 1000 })
    // L'état de départ du faux main, posé AVANT le code de l'écran (setContent ne déclenche pas addInitScript).
    await page.setContent(buildPage().replace('<div id="root"></div>', `<div id="root"></div><script>${init}</script>`))
    await page.waitForSelector('.mcp')
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }
const shot = async (page, name) => {
  if (!process.env.JARIS_SHOTS) return
  await page.mouse.move(0, 0)
  await page.waitForTimeout(300)
  await page.screenshot({ path: join(process.env.JARIS_SHOTS, name), fullPage: true })
}
const call = (page, kind) => page.evaluate((k) => window.__calls.find((c) => c[0] === k) ?? null, kind)

test('rien d’ajouté : on arrive sur « Découvrir » ; les services en cartes ; « + » ajoute et ouvre la connexion par compte', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.mcp-card')
    assert.equal(await page.getByRole('tab', { name: 'Découvrir' }).getAttribute('aria-selected'), 'true')
    const names = await page.$$eval('.mcp-card__name', (els) => els.map((el) => el.textContent))
    assert.deepEqual(names, ['Canva', 'Notion', 'Zapier', 'Figma', 'Atlassian', 'Linear', 'Todoist', 'Airtable', 'Dropbox', 'Miro', 'monday.com', 'Supabase', 'Hugging Face'])
    assert.match(await page.textContent('.mcp-card[aria-label="Canva"]'), /designs Canva.*Avec ton compte · En ligne/)
    assert.match(await page.textContent('.mcp-card[aria-label="Zapier"]'), /Gmail/)
    // Pastille : l'initiale du service sur sa couleur (pas son logo).
    const badge = await page.$eval('.mcp-card[aria-label="Canva"] .mcp-icon', (el) => ({ text: el.textContent, bg: getComputedStyle(el).backgroundColor, color: getComputedStyle(el).color }))
    assert.deepEqual(badge, { text: 'C', bg: 'rgb(125, 42, 232)', color: 'rgb(255, 255, 255)' })
    await shot(page, 'decouvrir.png')
    await page.getByRole('button', { name: 'Ajouter Canva' }).click()
    await page.waitForSelector('.mcp-row')
    assert.deepEqual(await call(page, 'catalog'), ['catalog', 'canva'])
    assert.equal(await page.getByRole('tab', { name: 'Les vôtres' }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.textContent('.mcp-row .mcp-status'), 'Connexion dans ton navigateur…')
    assert.equal(await page.locator('.mcp-row__signin').getByRole('button', { name: 'Annuler' }).count(), 1)
    await shot(page, 'connexion.png')
    await page.waitForSelector('.mcp-status--ready')
    assert.match(await page.textContent('.mcp-row'), /Canva\s*Connecté · outils : 1/)
    assert.equal(await page.locator('.mcp-row__signin').count(), 0, 'connecté : plus de bouton de connexion')
    await page.getByRole('tab', { name: 'Découvrir' }).click()
    assert.equal(await page.locator('.mcp-card[aria-label="Canva"] .mcp-card__added').count(), 1, '✓ à la place de +')
  })
})

test('« À connecter » : « Se connecter » ouvre la connexion ; pendant ce temps, « Annuler »', options, async () => {
  const init = `window.__servers = [{ id: 'n', name: 'Notion', enabled: true, status: 'signin', error: null, summary: 'https://mcp.notion.com/mcp', secretNames: [], kind: 'online', catalogId: 'notion', tools: [] }]`
  await withPage(async (page) => {
    await page.waitForSelector('.mcp-row')
    assert.equal(await page.textContent('.mcp-row .mcp-status'), 'À connecter')
    await page.getByRole('button', { name: 'Se connecter' }).click()
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'signin'))
    assert.deepEqual(await call(page, 'signin'), ['signin', 'n'])
    await page.getByRole('button', { name: 'Annuler' }).click()
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'cancelSignin'))
    await page.waitForSelector('.mcp-status--signin')
  }, { init })
})

test('« Les vôtres » : interrupteur actif/désactivé ; détails avec outils décochables, Relancer, Supprimer confirmé', options, async () => {
  const init = `window.__servers = [
    { id: 'a', name: 'GitHub', enabled: true, status: 'ready', error: null, summary: 'https://api.githubcopilot.com/mcp/', secretNames: ['Authorization'], kind: 'online', catalogId: 'github',
      tools: [{ name: 'list_issues', description: 'List issues', enabled: true, readOnly: true }, { name: 'create_issue', description: 'Create an issue', enabled: true, readOnly: false }] },
    { id: 'b', name: 'Fichiers', enabled: true, status: 'error', error: "La commande « npx » est introuvable sur ce PC. Pour « npx », installe Node.js (nodejs.org).", summary: 'npx -y @modelcontextprotocol/server-filesystem@2.0.0 C:\\\\Users\\\\Léo', secretNames: [], kind: 'local', catalogId: 'files', tools: [] }
  ]`
  await withPage(async (page) => {
    await page.waitForSelector('.mcp-row')
    assert.equal(await page.getByRole('tab', { name: 'Les vôtres' }).getAttribute('aria-selected'), 'true')
    assert.deepEqual(await page.$$eval('.mcp-table__head span', (els) => els.map((el) => el.textContent)), ['Outil MCP', 'Type', 'Actif'])
    assert.match(await page.textContent('.mcp-row[aria-label="Fichiers"] .mcp-error'), /installe Node\.js/)
    await shot(page, 'les-votres.png')
    await page.getByRole('switch', { name: 'Activer GitHub' }).click()
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'enabled'))
    assert.deepEqual(await call(page, 'enabled'), ['enabled', 'a', false])
    await page.waitForSelector('.mcp-row[aria-label="GitHub"] .mcp-status--off')
    assert.equal(await page.textContent('.mcp-row[aria-label="GitHub"] .mcp-status'), 'Désactivé')

    const row = page.locator('.mcp-row[aria-label="GitHub"]')
    await row.locator('.mcp-row__name').click()
    await page.waitForSelector('.mcp-row__details')
    assert.match(await row.locator('.mcp-server__secrets').textContent(), /Authorization/)
    assert.match(await row.locator('.mcp-tools__title').textContent(), /2 sur 2/)
    await page.getByRole('switch', { name: 'Proposer « create_issue » à Jaris' }).click()
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'tool'))
    assert.deepEqual(await call(page, 'tool'), ['tool', 'a', 'create_issue', false])
    await shot(page, 'details.png')
    await row.getByRole('button', { name: 'Supprimer' }).click()
    assert.match(await row.locator('.mcp-server__confirm').textContent(), /Supprimer « GitHub » \?/)
    await row.getByRole('button', { name: 'Annuler' }).click()
    assert.equal(await call(page, 'remove'), null, 'rien n’est supprimé sans confirmation')
    await row.getByRole('button', { name: 'Supprimer' }).click()
    await row.locator('.mcp-btn--danger').click()
    await page.waitForFunction(() => document.querySelectorAll('.mcp-row').length === 1)
  }, { init })
})

test('« + Ajouter » : son propre serveur collé ; erreur réelle ; une fois ajouté, le formulaire se ferme', options, async () => {
  await withPage(async (page) => {
    await page.waitForSelector('.mcp-card')
    await page.getByRole('button', { name: 'Ajouter un serveur' }).click()
    const form = page.locator('.mcp-add')
    await form.locator('.mcp-add__input').fill('bonjour')
    await form.getByRole('button', { name: 'Ajouter', exact: true }).click()
    await page.waitForSelector('.mcp-add .mcp-error')
    assert.equal(await page.textContent('.mcp-add .mcp-error'), 'Rien de reconnu. Colle la configuration donnée par la page du serveur.')
    await form.locator('.mcp-add__input').fill('{"mcpServers": {"mon-serveur": {"command": "npx", "args": ["-y", "mon-serveur"], "env": {"API_KEY": "secret-123"}}}}')
    await form.getByRole('button', { name: 'Ajouter', exact: true }).click()
    await page.waitForSelector('.mcp-row')
    assert.equal(await page.locator('.mcp-add').count(), 0, 'formulaire fermé')
    assert.doesNotMatch(await page.textContent('.mcp'), /secret-123/)
  })
})

test('fenêtre étroite (760 px) : rien ne déborde, tableau et cartes restent dans la page', options, async () => {
  const init = `window.__servers = [{ id: 'a', name: 'un serveur au nom vraiment très long pour voir ce qui se passe', enabled: false, status: 'off', error: null, summary: 'npx -y x', secretNames: [], kind: 'local', catalogId: null, tools: [] }]`
  await withPage(async (page) => {
    await page.waitForSelector('.mcp-row')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
    assert.ok(overflow <= 0, `débordement horizontal de ${overflow} px`)
    const sw = await page.$eval('.mcp-row [role=switch]', (el) => { const r = el.getBoundingClientRect(); return r.right <= document.documentElement.clientWidth })
    assert.equal(sw, true, 'l’interrupteur reste visible')
    await page.getByRole('tab', { name: 'Découvrir' }).click()
    await page.waitForSelector('.mcp-card')
    const fits = await page.$$eval('.mcp-card', (cards) => cards.every((c) => c.getBoundingClientRect().right <= document.documentElement.clientWidth))
    assert.equal(fits, true)
    await shot(page, 'etroit.png')
  }, { width: 760, init })
})
