import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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

// Étape 420 : les 45 outils du vrai serveur MCP de Canva (noms tels que le serveur les donne), avec les extraits de
// leurs descriptions qui comptent ici, copiés des descriptions publiées par Canva.
const CANVA_TOOLS = ['comment-on-design', 'copy-design', 'create-brand-template-draft', 'create-design', 'create-design-from-brand-template', 'create-design-from-candidate', 'create-folder', 'create-upload-url', 'create-video', 'edit-design', 'export-design', 'generate-design', 'generate-design-structured', 'generate-image', 'get-assets', 'get-brand-template-dataset', 'get-create-design-async-job', 'get-design-dataset', 'get-export-formats', 'get-generate-image-job', 'get-motion-import-job-status', 'get-separate-image-layers-job', 'get-video-generation-status', 'get-video-production-guide', 'help', 'import-claude-motion-from-url', 'import-design-from-url', 'list-brand-kits', 'list-comments', 'list-folder-items', 'list-replies', 'merge-designs', 'move-item-to-folder', 'publish-brand-template', 'read-design', 'remove-background', 'reply-to-comment', 'request-outline-review', 'resize-design', 'resolve-shortlink', 'search-brand-templates', 'search-designs', 'search-folders', 'separate-image-layers', 'upload-asset-from-url']
const CANVA_DESCRIPTIONS = {
  'create-design': 'Generate a new Canva design from a written brief. Use this tool only when the requested output itself is an editable Canva page or layout. Returns a job_id and continuation_token. Only when no widget is shown, poll get-create-design-async-job with both, until the job completes, then share the design link with the user.',
  'generate-design': 'LEGACY-ONLY — DO NOT CALL WHEN create-design IS AVAILABLE. If create-design is in the tool list, you MUST NOT call this tool. The generated designs are design candidates for users to select from. Ask for a preferred design and use \'create-design-from-candidate\' tool to add the design to users\' account.',
  'generate-design-structured': 'LEGACY-ONLY — DO NOT CALL WHEN create-design IS AVAILABLE.',
  'create-design-from-candidate': 'LEGACY-ONLY — DO NOT CALL WHEN create-design IS AVAILABLE. Create a new Canva design from a generation job candidate ID.',
  'get-create-design-async-job': 'Get the result of a create-design job.',
  // Étape 421 : descriptions réelles (premières phrases) des outils qui disputent les places (« page », « Canva »).
  'copy-design': 'Duplicate an existing Canva design, or copy selected pages from it, into a new design. Use to make a separate working copy, create an independent cloned, forked, or backup version, or preserve the original before making changes.',
  'edit-design': 'Make changes to the content or layout of an existing Canva design within an active editing transaction. Use to revise wording or text styles; replace, crop, position, or resize images and videos on a page; restyle page colors, shapes, and graphics; add or reorder pages.',
  'export-design': 'Export an existing Canva design as a downloadable file to save and use outside Canva. Use when a selected design needs to be printed, attached to an email, sent or shared as a file outside Canva, converted to another file type, or downloaded as selected pages.',
  'get-assets': 'Get names, tags, types, creation dates, and thumbnails for images and videos in a Canva design. Use when you need to check which image or video is the target on a page.',
  'create-folder': 'Create a Canva folder to organise related work.',
  'comment-on-design': 'Leave a new comment on an existing Canva design as a note to self or for collaborators to read.'
}
const canvaTools = () =>
  CANVA_TOOLS.map((toolName) => ({ name: `mcp_canva_${toolName}`, serverName: 'Canva', toolName, description: CANVA_DESCRIPTIONS[toolName] ?? `Canva tool ${toolName}` }))

test('étape 420 : Canva (45 outils) — la demande de Léo reçoit create-design ET l’outil qui va chercher le design, jamais l’ancien generate-design', () => {
  const picked = mcp.pickMcpTools('utilise le mcp de canva, et prend une page a4 et met un texte bonjour en gros', canvaTools()).map((t) => t.toolName)
  assert.ok(picked.includes('create-design'), picked.join())
  assert.ok(picked.includes('get-create-design-async-job'), 'l’outil cité par create-design suit')
  assert.ok(!picked.includes('generate-design') && !picked.includes('generate-design-structured') && !picked.includes('create-design-from-candidate'), 'les outils « LEGACY » passent après')
  assert.ok(picked.length <= mcp.MCP_MAX_TOOLS_PER_REQUEST + mcp.MCP_COMPANION_TOOLS_MAX)
})

test('étape 420 : un outil choisi emmène ceux qu’il nomme (même serveur, nom exact), au plus 4 en plus', () => {
  const tool = (serverName, toolName, description = '') => ({ name: `mcp_${serverName}_${toolName}`, serverName, toolName, description })
  const tools = [
    ...Array.from({ length: 14 }, (_, i) => tool('a', `filler_${i}`)),
    tool('a', 'make_poster', 'Make a poster. Then call finish_job and share_job.'),
    tool('a', 'finish_job'),
    tool('a', 'share_job'),
    tool('a', 'finish_job_v2'),
    tool('b', 'finish_job', 'Another server with the same tool name')
  ]
  const picked = mcp.pickMcpTools('fais un poster avec make poster', tools)
  const names = picked.map((t) => `${t.serverName}/${t.toolName}`)
  assert.ok(names.includes('a/make_poster') && names.includes('a/finish_job') && names.includes('a/share_job'), names.join())
  assert.ok(!names.includes('a/finish_job_v2'), 'nom exact seulement')
  assert.ok(!names.includes('b/finish_job'), 'jamais d’un autre serveur')
  assert.equal(mcp.isLegacyTool('This tool is deprecated, use x'), true)
  assert.equal(mcp.isLegacyTool('Do not use this tool when the user wants an image'), true)
  assert.equal(mcp.isLegacyTool('Lists the user’s designs'), false)
})

test('étape 420 : un serveur qui demande d’attendre (Canva : polling_policy.wait_seconds) est écouté, jusqu’à une minute', () => {
  assert.equal(mcp.serverRequestedWaitMs([], { job: { status: 'in_progress' }, polling_policy: { wait_seconds: 5 } }), 5000)
  assert.equal(mcp.serverRequestedWaitMs([{ type: 'text', text: '{"status":"in_progress","polling_policy":{"wait_seconds":3}}' }], undefined), 3000)
  assert.equal(mcp.serverRequestedWaitMs([{ type: 'text', text: 'Job queued. wait_seconds: 2' }], undefined), 2000)
  assert.equal(mcp.serverRequestedWaitMs([{ type: 'text', text: 'Fini : https://www.canva.com/design/x' }], { design: { id: 'x' } }), 0)
  assert.equal(mcp.serverRequestedWaitMs([], { polling_policy: { wait_seconds: 600 } }), 0, 'au-delà d’une minute : la main au modèle')
  assert.equal(mcp.serverRequestedWaitMs([], { wait_seconds: -1 }), 0)
})

test('étape 421 : isServerNamed — le service doit être nommé en entier, sans tenir compte des accents ni des majuscules', async () => {
  const { isServerNamed } = mcp
  assert.equal(isServerNamed('Fais-moi une affiche sur Canva', 'Canva'), true)
  assert.equal(isServerNamed('fais une affiche sur canva', 'Canva'), true)
  assert.equal(isServerNamed('mets ça dans GitHub', 'GitHub'), true)
  assert.equal(isServerNamed('mets ça dans git', 'GitHub'), false, 'un morceau du nom ne suffit pas')
  assert.equal(isServerNamed('cherche sur hugging face', 'Hugging Face'), true)
  assert.equal(isServerNamed('un visage souriant (face)', 'Hugging Face'), false)
  assert.equal(isServerNamed('Fais une affiche', 'Canva'), false)
  assert.equal(isServerNamed('Fais une affiche', 'X'), false, 'un nom trop court ne compte jamais')
})

// Étape 421 : les 45 vrais outils de Canva (noms, paramètres obligatoires, descriptions de Canva).
const REAL_CANVA = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'canva-tools.json'), 'utf8')).tools
const realCanva = (without = []) =>
  REAL_CANVA.filter((tool) => !without.includes(tool.name)).map((tool) => ({ name: `mcp_canva_${tool.name}`, serverName: 'Canva', toolName: tool.name, description: tool.description, required: tool.required }))
const LEO = 'utilise le mcp de canva, et prend une page a4 et met un texte bonjour en gros'

test('étape 421 : vrais outils de Canva SANS create-design (ce que Jaris reçoit chez Léo) — generate-design et l’outil qui met le design dans le compte', () => {
  const picked = mcp.pickMcpTools(LEO, realCanva(['create-design'])).map((t) => t.toolName)
  assert.ok(picked.includes('generate-design'), picked.join())
  assert.ok(picked.includes('create-design-from-candidate'), 'l’outil qui met la proposition dans le compte suit')
})

test('étape 421 : vrais outils de Canva AVEC create-design — create-design et son suivi, jamais les anciens', () => {
  const picked = mcp.pickMcpTools(LEO, realCanva()).map((t) => t.toolName)
  assert.ok(picked.includes('create-design') && picked.includes('get-create-design-async-job'), picked.join())
  assert.ok(!picked.includes('generate-design') && !picked.includes('create-design-from-candidate'), picked.join())
})

test('étape 421 : un outil qui exige un identifiant passe après, sauf si la demande en contient un', () => {
  assert.equal(mcp.needsPriorId(['design_id']), true)
  assert.equal(mcp.needsPriorId(['jobId']), true)
  assert.equal(mcp.needsPriorId(['asset_ids']), true)
  assert.equal(mcp.needsPriorId(['brief']), false)
  assert.equal(mcp.needsPriorId(['valid', 'paid']), false, 'un mot finissant par « id » sans séparateur ne compte pas')
  assert.equal(mcp.hasIdLikeToken('exporte le design DAGk3x9LmQ2 en PDF'), true)
  assert.equal(mcp.hasIdLikeToken('https://www.canva.com/design/x'), true)
  assert.equal(mcp.hasIdLikeToken(LEO), false, '« a4 » n’est pas un identifiant')
  const withId = mcp.pickMcpTools('exporte le design DAGk3x9LmQ2 en PDF', realCanva()).map((t) => t.toolName)
  assert.ok(withId.includes('export-design'), withId.join())
})

test('étape 421 : legacyReplacement — le remplaçant nommé par la description, sinon rien', () => {
  assert.equal(mcp.legacyReplacement(CANVA_DESCRIPTIONS['generate-design']), 'create-design')
  assert.equal(mcp.legacyReplacement('Deprecated: use v2 instead.'), null)
  assert.equal(mcp.legacyReplacement('Do not use when `search_v2` is available.'), 'search_v2')
  // Sans remplaçant nommé, un outil « deprecated » passe toujours après les autres.
  const tool = (toolName, description) => ({ name: `mcp_s_${toolName}`, serverName: 's', toolName, description })
  const many = Array.from({ length: 12 }, (_, i) => tool(`t${i}`, 'list items'))
  const picked = mcp.pickMcpTools('list items', [tool('old', 'Deprecated. list items'), ...many]).map((t) => t.toolName)
  assert.ok(!picked.includes('old'), picked.join())
})
