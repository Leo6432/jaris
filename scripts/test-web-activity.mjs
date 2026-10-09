import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 273 (Léo : « quand il recherche sur le web, tu peux pas faire comme Claude, une petite flèche pour voir ce
 * qu'il recherche ? ») : chaque recherche web et chaque page lue remontent au Chat (bloc dépliable). Vérifie le
 * libellé du bloc, les pages gardées par la recherche, et le signalement fait par l'outil lui-même — succès ET
 * échec : une recherche ratée doit se voir autant qu'une recherche réussie.
 */
function load(path, modules = {}) {
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, (name) => modules[name] ?? {})
  return exports
}

const { webActivityLabel, mergeWebActivity, sourceDomain, isWebLink, pageAddress } = load('../src/lib/webActivity.ts')

const search = (query, n = 2) => ({ kind: 'search', query, results: Array.from({ length: n }, (_, i) => ({ title: `R${i}`, url: `https://ex${i}.fr/` })) })

test('libellé replié : ce qui a été fait, au singulier comme au pluriel', () => {
  assert.equal(webActivityLabel([search('météo')]), 'A cherché sur le web')
  assert.equal(webActivityLabel([search('a'), search('b')]), 'A fait 2 recherches sur le web')
  assert.equal(webActivityLabel([search('a'), search('b'), { kind: 'read', url: 'https://x.fr' }]), 'A fait 2 recherches sur le web et lu 1 page')
  assert.equal(webActivityLabel([{ kind: 'read', url: 'https://x.fr' }, { kind: 'read', url: 'https://y.fr' }]), 'A lu 2 pages')
})

test('libellé pendant une recherche en cours (étape 274) : ce qui est cherché, dès le début', () => {
  assert.equal(webActivityLabel([search('a'), { kind: 'search', query: 'prix du pain', results: [], pending: true }]), 'Recherche : « prix du pain »')
  assert.equal(webActivityLabel([{ kind: 'read', url: 'https://www.meteofrance.com/rennes', pending: true }]), 'Lecture de meteofrance.com')
})

test('une recherche terminée REMPLACE sa version en cours, au lieu de s’ajouter à côté (étape 274)', () => {
  const pending = { kind: 'search', query: 'prix du pain', results: [], pending: true }
  const done = { kind: 'search', query: 'prix du pain', results: [{ title: 'T', url: 'https://t.fr' }] }
  const first = search('météo')
  assert.equal(JSON.stringify(mergeWebActivity(mergeWebActivity([first], pending), done)), JSON.stringify([first, done]))
  // Une autre recherche, elle, s'ajoute.
  assert.equal(mergeWebActivity([first], done).length, 2)
  // Une page lue remplace sa propre lecture en cours, pas une recherche.
  const reading = { kind: 'read', url: 'https://t.fr', pending: true }
  assert.equal(JSON.stringify(mergeWebActivity([pending, reading], { kind: 'read', url: 'https://t.fr' })), JSON.stringify([pending, { kind: 'read', url: 'https://t.fr' }]))
})

test('adresses : le site seul, seules les adresses web deviennent des liens', () => {
  assert.equal(sourceDomain('https://www.fr.wikipedia.org/wiki/Rennes'), 'fr.wikipedia.org')
  assert.equal(sourceDomain('pas une adresse'), 'pas une adresse')
  assert.equal(pageAddress('https://www.meteofrance.com/rennes/'), 'meteofrance.com/rennes')
  assert.equal(isWebLink('https://a.fr'), true)
  assert.equal(isWebLink('javascript:alert(1)'), false)
  assert.equal(isWebLink('file:///C:/Windows'), false)
})

test('la recherche garde les pages trouvées (adresses web seulement), et le même texte pour le modèle', async () => {
  const { searchWebDetailed } = load('../electron/services/webSearch.ts', {
    '../config': { config: { searxng: { host: 'http://127.0.0.1:8091' } } },
    './dependencyServices': { readSearxngContainerSettings: async () => null }
  })
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      results: [
        { title: 'Météo Rennes', url: 'https://meteofrance.com/rennes', content: '17 °C' },
        { title: 'Piège', url: 'javascript:alert(1)', content: 'x' }
      ]
    })
  })
  try {
    const { text, sources } = await searchWebDetailed('météo Rennes')
    assert.equal(text, '1. Météo Rennes — 17 °C (https://meteofrance.com/rennes)\n2. Piège — x (javascript:alert(1))')
    assert.equal(JSON.stringify(sources), JSON.stringify([{ title: 'Météo Rennes', url: 'https://meteofrance.com/rennes' }]))
  } finally {
    globalThis.fetch = realFetch
  }
})

test('l’outil signale chaque recherche et page lue au Chat, échecs compris', async () => {
  const { createToolExecutor } = load('../electron/services/tools.ts', {
    './webSearch': {
      searchWebDetailed: async (query) => {
        if (query === 'panne') throw new Error('La recherche web ne répond pas.')
        return { text: 'résumé', sources: [{ title: 'T', url: 'https://t.fr' }] }
      }
    },
    './webPage': { readWebPage: async (url) => (url.startsWith('http') ? 'contenu' : `URL invalide : "${url}".`) }
  })
  const seen = []
  const run = createToolExecutor(() => {}, 'vision', undefined, undefined, undefined, (activity) => seen.push(activity))
  assert.equal(await run('search_web', { query: 'météo' }), 'résumé', 'le modèle reçoit toujours le même texte')
  await assert.rejects(run('search_web', { query: 'panne' }), /ne répond pas/)
  assert.equal(await run('read_web_page', { url: 'https://t.fr/page' }), 'contenu')
  await run('read_web_page', { url: 'ftp://t.fr' })
  assert.equal(
    JSON.stringify(seen),
    JSON.stringify([
      // Étape 274 : chacune signalée dès son début, puis terminée.
      { kind: 'search', query: 'météo', results: [], pending: true },
      { kind: 'search', query: 'météo', results: [{ title: 'T', url: 'https://t.fr' }] },
      { kind: 'search', query: 'panne', results: [], pending: true },
      { kind: 'search', query: 'panne', results: [], failed: true },
      { kind: 'read', url: 'https://t.fr/page', pending: true },
      { kind: 'read', url: 'https://t.fr/page' },
      { kind: 'read', url: 'ftp://t.fr', pending: true },
      { kind: 'read', url: 'ftp://t.fr', failed: true }
    ])
  )
})
