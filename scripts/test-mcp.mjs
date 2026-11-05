import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 418 : shared/mcp.ts — ce que Léo colle (les formats que donnent les pages des serveurs MCP), les noms d'outils
 * donnés au modèle, le choix des outils utiles à une demande, et le texte d'un résultat.
 */
const mcp = loadTsModule('shared/mcp.ts')

test('Claude Desktop / Cursor : le bloc « mcpServers », plusieurs serveurs, clés gardées', () => {
  const pasted = `{
    "mcpServers": {
      "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_x" } },
      "fichiers": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "C:\\\\Users\\\\Léo\\\\Documents"] }
    }
  }`
  const drafts = mcp.parseMcpPaste(pasted)
  assert.deepEqual(drafts.map((d) => d.name), ['github', 'fichiers'])
  assert.deepEqual(drafts[0].transport, { kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_x' } })
  assert.equal(drafts[1].transport.args[2], 'C:\\Users\\Léo\\Documents', 'chemin Windows intact')
})

test('VS Code (« servers »), un serveur seul, un bloc sans accolades, une adresse, une ligne de commande', () => {
  assert.deepEqual(mcp.parseMcpPaste('{"servers": {"web": {"type": "http", "url": "https://mcp.exemple.fr/mcp", "headers": {"Authorization": "Bearer x"}}}}'), [
    { name: 'web', transport: { kind: 'http', url: 'https://mcp.exemple.fr/mcp', headers: { Authorization: 'Bearer x' } } }
  ])
  assert.deepEqual(mcp.parseMcpPaste('{"command": "uvx", "args": ["mcp-server-time"]}', 'heure'), [
    { name: 'heure', transport: { kind: 'stdio', command: 'uvx', args: ['mcp-server-time'], env: {} } }
  ])
  assert.deepEqual(mcp.parseMcpPaste('"memoire": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] },').map((d) => d.name), ['memoire'])
  assert.deepEqual(mcp.parseMcpPaste('https://mcp.notion.com/mcp'), [{ name: 'mcp.notion.com', transport: { kind: 'http', url: 'https://mcp.notion.com/mcp', headers: {} } }])
  const line = mcp.parseMcpPaste('npx -y @modelcontextprotocol/server-filesystem "C:\\Users\\Léo\\Mes documents"')
  assert.deepEqual(line, [
    { name: 'filesystem', transport: { kind: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\Users\\Léo\\Mes documents'], env: {} } }
  ])
  // « command » écrit en une seule ligne, sans « args ».
  assert.deepEqual(mcp.parseMcpPaste('{"x": {"command": "npx -y mcp-server-time"}}')[0].transport.args, ['-y', 'mcp-server-time'])
  // Rien de reconnaissable : rien.
  assert.deepEqual(mcp.parseMcpPaste(''), [])
  assert.deepEqual(mcp.parseMcpPaste('{"mcpServers": {"x": {"nom": "y"}}}'), [])
  assert.deepEqual(mcp.parseMcpPaste('{"url": "file:///etc/passwd"}'), [], 'seulement http(s)')
})

test('noms devinés et lignes de commande', () => {
  assert.equal(mcp.guessServerName(['npx', '-y', '@modelcontextprotocol/server-github']), 'github')
  assert.equal(mcp.guessServerName(['uvx', 'mcp-server-time']), 'time')
  assert.equal(mcp.guessServerName(['npx', '-y', '@playwright/mcp@latest']), 'mcp')
  assert.equal(mcp.guessServerName(['C:\\outils\\notion-mcp.exe']), 'notion')
  assert.deepEqual(mcp.splitCommandLine(`node "a b" 'c d' e`), ['node', 'a b', 'c d', 'e'])
  assert.deepEqual(mcp.splitCommandLine('x ""'), ['x', ''])
  assert.equal(mcp.joinCommandLine(['node', 'a b', 'c']), 'node "a b" c')
})

test('noms d’outils pour le modèle : préfixés, propres, uniques, 64 caractères au plus', () => {
  const taken = new Set()
  const a = mcp.mcpToolName('Mes fichiers', 'list_files', taken)
  assert.equal(a, 'mcp_mes_fichiers_list_files')
  taken.add(a)
  assert.equal(mcp.mcpToolName('Mes-fichiers', 'list.files', taken), 'mcp_mes_fichiers_list_files_2')
  assert.equal(mcp.mcpToolName('Été', 'créer', new Set()), 'mcp_ete_creer')
  const long = mcp.mcpToolName('serveur'.repeat(10), 'outil'.repeat(10), new Set())
  assert.ok(long.length <= 64 && /^[A-Za-z0-9_-]+$/.test(long), long)
})

test('choix des outils d’une demande : tous s’il y en a peu ; sinon les plus proches, au plus 12, dans l’ordre', () => {
  const tool = (server, name, description = '') => ({ name: `mcp_${server}_${name}`, serverName: server, toolName: name, description })
  const few = [tool('a', 'x'), tool('a', 'y')]
  assert.equal(mcp.pickMcpTools('peu importe', few).length, 2)
  const many = [
    ...Array.from({ length: 15 }, (_, i) => tool('fichiers', `outil_${i}`, 'Something unrelated')),
    tool('github', 'list_issues', 'List issues of a repository'),
    tool('github', 'create_issue', 'Create a new issue')
  ]
  const picked = mcp.pickMcpTools('Montre les issues de mon dépôt sur GitHub', many)
  assert.equal(picked.length, 12)
  assert.ok(picked.some((t) => t.toolName === 'list_issues') && picked.some((t) => t.toolName === 'create_issue'), 'le serveur nommé passe devant')
  assert.deepEqual(picked.map((t) => t.name), [...picked].sort((x, y) => many.indexOf(x) - many.indexOf(y)).map((t) => t.name), 'ordre des serveurs gardé')
  assert.deepEqual(mcp.words('getFileContents Été GitHub'), ['getfilecontents', 'get', 'file', 'contents', 'ete', 'github', 'git', 'hub'])
})

test('résultat d’un outil : texte, images et ressources dites, données structurées, coupé et c’est dit', () => {
  assert.equal(mcp.mcpResultText([{ type: 'text', text: 'a' }, { type: 'image', mimeType: 'image/png' }, { type: 'resource', resource: { uri: 'file:///x', text: 'contenu' } }], undefined), 'a\n\n[image image/png]\n\ncontenu')
  assert.equal(mcp.mcpResultText([], { temp: 21 }), '{"temp":21}')
  const cut = mcp.mcpResultText([{ type: 'text', text: 'x'.repeat(30) }], undefined, 10)
  assert.match(cut, /^x{10}\n\[… résultat coupé : 20 caractères de plus\]$/)
})

test('fichier de configuration : un serveur abîmé est ignoré, jamais tout le fichier', () => {
  const file = mcp.parseMcpConfigFile({
    servers: [
      { id: '1', name: 'ok', enabled: true, disabledTools: ['x', 3], transport: { kind: 'stdio', command: 'npx', args: ['-y', 'p'], env: { K: 'v' } } },
      { id: '1', name: 'doublon', transport: { kind: 'stdio', command: 'npx' } },
      { id: '2', name: 'sans transport' },
      { id: '3', name: 'web', enabled: false, transport: { kind: 'http', url: 'https://x.fr/mcp' } },
      { id: '4', name: 'mauvaise adresse', transport: { kind: 'http', url: 'ftp://x' } }
    ]
  })
  assert.deepEqual(file.servers.map((s) => [s.id, s.name, s.enabled]), [['1', 'ok', true], ['3', 'web', false]])
  assert.deepEqual(file.servers[0].disabledTools, ['x'])
  assert.equal(mcp.parseMcpConfigFile({ nope: true }), null)
  assert.deepEqual(mcp.secretNames({ kind: 'stdio', command: 'x', args: [], env: { B: '1', A: '2' } }), ['A', 'B'])
})

test('étape 419 : le catalogue — services en ligne officiels (https), connexion par compte (aucune clé), ni GitHub ni navigateur', () => {
  const catalog = loadTsModule('shared/mcpCatalog.ts')
  const ids = catalog.MCP_CATALOG.map((e) => e.id)
  assert.equal(new Set(ids).size, ids.length, 'identifiants uniques')
  for (const id of ['canva', 'notion', 'zapier', 'figma', 'atlassian']) assert.ok(ids.includes(id), id)
  for (const id of ['github', 'browser', 'files']) assert.ok(!ids.includes(id), `${id} : Jaris l'a déjà (Léo)`)
  for (const entry of catalog.MCP_CATALOG) {
    const transport = catalog.catalogTransport(entry)
    assert.equal(transport.kind, 'http', entry.id)
    assert.match(transport.url, /^https:\/\//, entry.id)
    assert.deepEqual(transport.headers, {}, `${entry.id} : pas de clé collée, la connexion se fait par le compte`)
    assert.match(entry.color, /^#[0-9a-f]{6}$/i)
  }
  assert.equal(catalog.catalogEntry('nope'), null)
  const file = mcp.parseMcpConfigFile({ servers: [{ id: '1', name: 'Canva', catalogId: 'canva', transport: { kind: 'http', url: 'https://x.fr/mcp' } }] })
  assert.equal(file.servers[0].catalogId, 'canva')
})
