import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 418 : le moteur MCP de Jaris (mcpHub.ts) branché à un VRAI serveur MCP (scripts/fixtures/mcp-test-server.mjs,
 * kit officiel), lancé comme Léo le ferait en collant sa configuration : outils listés, appelés, échecs lisibles,
 * clés jamais montrées à l'écran, serveur arrêté avec Jaris.
 */
const require = createRequire(import.meta.url)
const SERVER = fileURLToPath(new URL('./fixtures/mcp-test-server.mjs', import.meta.url))
const shared = loadTsModule('shared/mcp.ts')

function setup() {
  const root = mkdtempSync(path.join(tmpdir(), 'jaris-mcp-'))
  const atomic = loadTsModule('electron/services/atomicFile.ts', { fs: require('fs'), 'fs/promises': require('fs/promises'), path: require('path') })
  const hub = loadTsModule('electron/services/mcpHub.ts', {
    crypto: require('crypto'),
    fs: require('fs'),
    path: require('path'),
    '@modelcontextprotocol/sdk/client/index.js': require('@modelcontextprotocol/sdk/client/index.js'),
    '@modelcontextprotocol/sdk/client/stdio.js': require('@modelcontextprotocol/sdk/client/stdio.js'),
    '@modelcontextprotocol/sdk/client/streamableHttp.js': require('@modelcontextprotocol/sdk/client/streamableHttp.js'),
    '@modelcontextprotocol/sdk/client/sse.js': require('@modelcontextprotocol/sdk/client/sse.js'),
    './atomicFile': atomic,
    './dataLocation': { getDataRoot: () => root },
    '../../shared/mcp': shared
  })
  let changes = 0
  hub.setMcpChangeListener(() => changes++)
  return { hub, root, changes: () => changes, done: async () => {
    await hub.stopMcpHub()
    rmSync(root, { recursive: true, force: true })
  } }
}

async function waitFor(check, what, timeout = 30_000) {
  const start = Date.now()
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() - start > timeout) throw new Error(`Délai dépassé : ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

const config = (args = [], env) => JSON.stringify({ mcpServers: { 'Mes fichiers': { command: process.execPath, args: [SERVER, ...args], ...(env ? { env } : {}) } } })
const ready = (hub) => waitFor(async () => (await hub.listMcpServers()).find((s) => s.status === 'ready' || s.status === 'error'), 'serveur prêt')

test('un vrai serveur collé en JSON : connecté, outils listés (lecture seule dite), configuration enregistrée sans rien montrer des clés', async () => {
  const env = setup()
  try {
    const views = await env.hub.addMcpServers(config([], { SECRET: 'jeton-tres-secret' }), '')
    assert.equal(views.length, 1)
    assert.equal(views[0].name, 'Mes fichiers')
    const server = await ready(env.hub)
    assert.equal(server.status, 'ready', server.error)
    assert.deepEqual(server.tools.map((tool) => tool.name).sort(), ['add_numbers', 'crash', 'fail', 'list_files', 'secret'])
    assert.equal(server.tools.find((tool) => tool.name === 'list_files').readOnly, true)
    assert.equal(server.tools.find((tool) => tool.name === 'add_numbers').readOnly, false)
    assert.deepEqual(server.secretNames, ['SECRET'])
    assert.ok(!JSON.stringify(await env.hub.listMcpServers()).includes('jeton-tres-secret'), 'la valeur d’une clé ne part jamais à l’écran')
    assert.ok(env.changes() > 0, 'l’écran est prévenu')
    const saved = JSON.parse(readFileSync(path.join(env.root, 'mcp-servers.json'), 'utf8'))
    assert.equal(saved.servers[0].transport.env.SECRET, 'jeton-tres-secret', 'la clé est gardée pour relancer le serveur')

    // Le modèle reçoit les outils (au nom préfixé) et peut les appeler ; la clé arrive bien au serveur.
    const offered = env.hub.mcpToolsFor('Additionne 2 et 3')
    const names = offered.tools.map((tool) => tool.function.name)
    assert.ok(names.includes('mcp_mes_fichiers_add_numbers'), names.join())
    const add = offered.tools.find((tool) => tool.function.name === 'mcp_mes_fichiers_add_numbers')
    assert.equal(add.function.parameters.type, 'object')
    assert.ok(add.function.parameters.properties.a, 'le schéma des paramètres suit')
    assert.match(add.function.description, /^\[MCP Mes fichiers\] Add two numbers/)
    assert.equal(await offered.call('mcp_mes_fichiers_add_numbers', { a: 2, b: 3 }), '5')
    assert.equal(await offered.call('mcp_mes_fichiers_secret', {}), 'secret=jeton-tres-secret')
    // Un échec signalé par le serveur : son vrai message, tel quel.
    await assert.rejects(offered.call('mcp_mes_fichiers_fail', {}), /L'outil « fail » du serveur MCP « Mes fichiers » a échoué : Jeton GitHub refusé \(401\)\./)
    // Un nom jamais proposé est refusé.
    await assert.rejects(offered.call('mcp_autre_outil', {}), /n'a pas été proposé/)

    // Un outil décoché n'est plus proposé.
    await env.hub.setMcpToolEnabled(server.id, 'add_numbers', false)
    assert.ok(!env.hub.mcpToolsFor('Additionne').tools.some((tool) => tool.function.name === 'mcp_mes_fichiers_add_numbers'))
    assert.equal((await env.hub.listMcpServers())[0].tools.find((tool) => tool.name === 'add_numbers').enabled, false)
  } finally {
    await env.done()
  }
})

test('un serveur qui plante en cours de route : son dernier message est dit, et « Relancer » le reconnecte', async () => {
  const env = setup()
  try {
    await env.hub.addMcpServers(config(), '')
    const server = await ready(env.hub)
    assert.equal(server.status, 'ready', server.error)
    await env.hub.mcpToolsFor('').call('mcp_mes_fichiers_crash', {})
    const crashed = await waitFor(async () => (await env.hub.listMcpServers()).find((s) => s.status === 'error'), 'arrêt vu')
    assert.match(crashed.error, /s'est arrêté\. Son dernier message : Plantage volontaire du serveur de test\./)
    assert.equal(env.hub.mcpToolsFor('').tools.length, 0, 'plus aucun outil proposé d’un serveur arrêté')
    await env.hub.restartMcpServer(server.id)
    const back = await ready(env.hub)
    assert.equal(back.status, 'ready')
  } finally {
    await env.done()
  }
})

test('un serveur qui échoue au démarrage dit pourquoi (ce qu’il a écrit), une commande absente dit quoi installer', async () => {
  const env = setup()
  try {
    await env.hub.addMcpServers(config(['broken']), 'cassé')
    const broken = await ready(env.hub)
    assert.equal(broken.status, 'error')
    assert.match(broken.error, /Le serveur MCP « cassé » n'a pas démarré : Erreur : la variable API_KEY est manquante\./)

    await env.hub.addMcpServers('commande-introuvable-jaris -y paquet', '')
    const missing = await waitFor(async () => (await env.hub.listMcpServers()).find((s) => s.summary.startsWith('commande-introuvable') && s.status === 'error'), 'échec')
    assert.match(missing.error, /La commande « commande-introuvable-jaris » est introuvable sur ce PC\. Pour « npx », installe Node\.js/)
  } finally {
    await env.done()
  }
})

test('désactiver arrête le serveur ; supprimer l’efface ; la configuration est relue au démarrage suivant', async () => {
  const env = setup()
  try {
    const [first] = await env.hub.addMcpServers(config(), '')
    await ready(env.hub)
    const off = await env.hub.setMcpServerEnabled(first.id, false)
    assert.equal(off[0].status, 'off')
    assert.equal(off[0].enabled, false)
    assert.equal(env.hub.mcpToolsFor('').tools.length, 0)
    // Un nom déjà pris reçoit un numéro : rien n'est remplacé en silence.
    const two = await env.hub.addMcpServers(config(), '')
    assert.deepEqual(two.map((s) => s.name), ['Mes fichiers', 'Mes fichiers 2'])
    // Un autre Jaris (redémarrage) relit le même dossier.
    const again = loadTsModule('electron/services/mcpHub.ts', {
      crypto: require('crypto'),
      fs: require('fs'),
      path: require('path'),
      '@modelcontextprotocol/sdk/client/index.js': require('@modelcontextprotocol/sdk/client/index.js'),
      '@modelcontextprotocol/sdk/client/stdio.js': require('@modelcontextprotocol/sdk/client/stdio.js'),
      '@modelcontextprotocol/sdk/client/streamableHttp.js': require('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      '@modelcontextprotocol/sdk/client/sse.js': require('@modelcontextprotocol/sdk/client/sse.js'),
      './atomicFile': loadTsModule('electron/services/atomicFile.ts', { fs: require('fs'), 'fs/promises': require('fs/promises'), path: require('path') }),
      './dataLocation': { getDataRoot: () => env.root },
      '../../shared/mcp': shared
    })
    const reread = await again.listMcpServers()
    assert.deepEqual(reread.map((s) => [s.name, s.enabled]), [['Mes fichiers', false], ['Mes fichiers 2', true]])
    await again.stopMcpHub()
    await env.hub.removeMcpServer(first.id)
    assert.deepEqual((await env.hub.listMcpServers()).map((s) => s.name), ['Mes fichiers 2'])
    await assert.rejects(env.hub.removeMcpServer('inconnu'), /n'existe plus/)
    await assert.rejects(env.hub.addMcpServers('   ', ''), /Rien de reconnu/)
  } finally {
    await env.done()
  }
})

test('commande cherchée comme Windows le fait (PATH puis PATHEXT : npx → npx.cmd), chemin direct accepté', () => {
  const { hub, done } = setup()
  try {
    const dir = mkdtempSync(path.join(tmpdir(), 'jaris-path-'))
    try {
      writeFileSync(path.join(dir, 'npx.cmd'), '@echo off')
      assert.equal(hub.commandExists('npx', { PATH: `C:\\absent;${dir}`, PATHEXT: '.EXE;.CMD' }, 'win32'), true)
      assert.equal(hub.commandExists('npx', { PATH: dir }, 'linux'), false, 'sans extension, pas de npx.cmd ailleurs que sous Windows')
      assert.equal(hub.commandExists('uvx', { PATH: dir, PATHEXT: '.EXE;.CMD' }, 'win32'), false)
      assert.equal(hub.commandExists(process.execPath), true)
      assert.equal(hub.commandExists(path.join(dir, 'absent.exe')), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  } finally {
    void done()
  }
})
