import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Bouton "Mettre à jour" d'Ollama (Options → Modèles), étape 112.
 *
 * Léo : "je clique sur mis a jour de ollama [...] ça bloque depuis 5m et je fait clique droit sur ollama et
 * je voit aucune mis a jour". Rien n'était bloqué : Jaris téléchargeait l'installeur officiel d'Ollama,
 * 1,5 Go (mesuré), sans remonter le moindre signe de vie — le bouton restait figé sur "Mise à jour en
 * cours…" pendant tout ce temps, impossible à distinguer d'un plantage. C'était le SEUL des quatre appels à
 * `downloadToFile` du dépôt à ne passer aucun `onProgress`, alors que c'est de loin le plus long.
 *
 * Deux garanties verrouillées ici :
 *  1. l'avancement traverse vraiment toute la chaîne jusqu'à l'appelant (comportement réel, modules simulés) ;
 *  2. aucun futur téléchargement ne peut réintroduire le même silence (garde structurel sur tout le dépôt).
 */
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * Chargé dans le realm COURANT (`runInThisContext`), pas dans un contexte séparé : ce test compare de vrais
 * objets d'avancement avec `assert.deepEqual`, et `vm.runInNewContext` leur donnerait des prototypes
 * différents — "Values have same structure but are not reference-equal", piège déjà documenté dans ce dépôt.
 */
function loadModule(relativePath, requireShim) {
  const source = ts.transpileModule(readFileSync(join(projectRoot, relativePath), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const exports = {}
  vm.runInThisContext(`(function (exports, module, require) { ${source} })`)(exports, { exports }, requireShim)
  return exports
}

function loadDependencyServices({ onDownload }) {
  const spawned = []
  return {
    spawned,
    module: loadModule('electron/services/dependencyServices.ts', (id) => {
      if (id === 'child_process') {
        return {
          exec: (_cmd, _opts, cb) => cb?.(null, { stdout: '', stderr: '' }),
          execSync: () => '',
          spawn: (command) => {
            spawned.push(command)
            // Faux process minimal mais RÉALISTE sur un point précis : winget est interrogé en dernier
            // recours, et updateOllama l'attend via une promesse que seul un évènement 'error'/'close'
            // résout. Un mock qui n'émet jamais rien laisse cette promesse pendante pour toujours — le test
            // ne se termine alors pas du tout, sans dire pourquoi (piège rencontré en écrivant ce fichier).
            const handlers = {}
            const proc = {
              stdout: { on: () => {} },
              stderr: { on: () => {} },
              unref: () => {},
              on: (event, cb) => {
                handlers[event] = cb
                return proc
              }
            }
            if (String(command) === 'winget') {
              // Machine sans winget : exactement le cas où Jaris doit renvoyer un message actionnable.
              setImmediate(() => handlers.error?.(new Error('winget introuvable')))
            } else if (String(command) === 'powershell.exe') {
              // La signature officielle de l'installeur est vérifiée avant son lancement.
              setImmediate(() => handlers.close?.(0))
            }
            return proc
          }
        }
      }
      // `existsSync` toujours false : "ollama app.exe" est introuvable, donc restartOllamaApp abandonne
      // immédiatement et updateOllama passe directement au téléchargement de l'installeur — le chemin qui
      // a occupé Léo pendant 5 minutes.
      if (id === 'fs') return { existsSync: () => false }
      if (id === 'fs/promises') return { rm: async () => {} }
      if (id.endsWith('/storageRoot')) return { downloadsDir: () => '/tmp', getStorageRoot: () => null }
      if (id.endsWith('/dockerLocation')) return { dockerInstallFlags: () => [] }
      if (id === 'path') return { join: (...parts) => parts.join('/'), basename: (p) => p.split('/').pop(), dirname: (p) => p.split('/').slice(0, -1).join('/') }
      if (id === 'util') return { promisify: (fn) => (...args) => new Promise((resolve) => fn(...args, () => resolve({ stdout: '', stderr: '' }))) }
      if (id.endsWith('/config')) return { config: { ollama: { host: 'http://127.0.0.1:11434' } } }
      if (id.endsWith('/appLauncher')) return { didAppLaunch: () => true, openApp: async () => '' }
      if (id.endsWith('/download')) return { downloadToFile: onDownload }
      if (id.endsWith('/searxngHome')) return {} // SearXNG (étape 153) : sans rapport avec la mise à jour d'Ollama
      if (id.endsWith('/formatBytes')) return { formatBytes: (n) => `${n} o` }
      throw new Error(`module non simulé dans le test : ${id}`)
    })
  }
}

test("l'avancement du téléchargement d'Ollama remonte vraiment jusqu'à l'appelant", async () => {
  // 1,5 Go livrés en quatre paquets, comme le ferait le vrai serveur.
  const total = 1_610_612_736
  const { module, spawned } = loadDependencyServices({
    onDownload: async (_url, _destination, options) => {
      for (const percent of [0, 25, 75, 100]) {
        options?.onProgress?.({ receivedBytes: Math.round(total * (percent / 100)), totalBytes: total, percent })
      }
    }
  })

  const recu = []
  const result = await module.updateOllama((progress) => recu.push(progress))

  assert.equal(result.success, true, `la mise à jour a échoué : ${result.message}`)
  assert.ok(spawned.some((cmd) => String(cmd).includes('JarisOllamaSetup')), "l'installeur n'a jamais été lancé")

  // Le vrai cœur du correctif : sans onProgress, ce tableau restait VIDE pendant plusieurs minutes.
  const telechargement = recu.filter((p) => p.phase === 'download')
  assert.ok(telechargement.length >= 4, `avancement muet : ${JSON.stringify(recu)}`)
  assert.deepEqual(
    telechargement.map((p) => p.percent),
    [0, 25, 75, 100],
    "les pourcentages réellement reçus ne sont pas ceux transmis par le téléchargement"
  )
  assert.equal(telechargement[0].totalBytes, total, 'la taille totale ne remonte pas (aucune barre possible)')
  // Une dernière étape après le téléchargement : l'installeur est lancé, la fenêtre attend un clic.
  assert.equal(recu.at(-1).phase, 'install')
})

test("aucun avancement n'est inventé quand le téléchargement échoue", async () => {
  // Un échec doit retomber sur les méthodes suivantes (winget), jamais faire croire que c'est terminé.
  const { module } = loadDependencyServices({
    onDownload: async () => {
      throw new Error('connexion coupée')
    }
  })

  const recu = []
  await module.updateOllama((progress) => recu.push(progress))
  assert.deepEqual(
    recu.filter((p) => p.phase === 'install'),
    [],
    "un téléchargement échoué a quand même annoncé « installation lancée »"
  )
})

/**
 * Étape 170, Léo : « après la mise à jour le message ne se supprime pas et on peut refaire la mise à jour, faut
 * redémarrer l'appli ». L'installeur officiel se termine dans SA fenêtre, bien après le clic ; le statut n'était
 * relu qu'une fois, juste après son lancement. Faux Ollama local : la version change quand l'installeur a fini.
 */
function fakeOllamaFetch(versions) {
  let calls = 0
  return async (url) => {
    if (String(url).endsWith('/api/version')) {
      const version = versions[Math.min(calls++, versions.length - 1)]
      return { ok: true, json: async () => ({ version }) }
    }
    if (String(url).includes('api.github.com/repos/ollama/ollama/releases/latest')) {
      return { ok: true, json: async () => ({ tag_name: 'v0.34.4' }) }
    }
    throw new Error(`requête inattendue : ${url}`)
  }
}

async function withFetch(fetchImpl, run) {
  const original = globalThis.fetch
  globalThis.fetch = fetchImpl
  // La surveillance attend avec des minuteurs « unref » (elle ne doit jamais retenir Jaris) : sans ce minuteur
  // normal, Node s'arrêterait pendant l'attente du test.
  const keepAlive = setInterval(() => {}, 1000)
  try {
    await run()
  } finally {
    clearInterval(keepAlive)
    globalThis.fetch = original
  }
}

test("fin de l'installeur officiel : la nouvelle version est diffusée sans redémarrer Jaris", async () => {
  const { module } = loadDependencyServices({ onDownload: async () => {} })
  const recu = []
  module.onOllamaVersionStatus((status) => recu.push(status))
  await withFetch(fakeOllamaFetch(['0.34.2', '0.34.2', '0.34.4']), () =>
    module.watchOllamaInstallerCompletion('0.34.2', { intervalMs: 5, timeoutMs: 5000 })
  )
  assert.deepEqual(recu.at(-1), { current: '0.34.4', latest: '0.34.4', outdated: false })
  assert.deepEqual(module.getOllamaVersionStatus(), { current: '0.34.4', latest: '0.34.4', outdated: false })
})

test("installeur fermé sans installer : le statut « pas à jour » revient, pour pouvoir relancer", async () => {
  const { module } = loadDependencyServices({ onDownload: async () => {} })
  const recu = []
  module.onOllamaVersionStatus((status) => recu.push(status))
  await withFetch(fakeOllamaFetch(['0.34.2']), () =>
    module.watchOllamaInstallerCompletion('0.34.2', { intervalMs: 5, timeoutMs: 60 })
  )
  assert.equal(recu.at(-1)?.outdated, true)
})

test("updateOllama signale que l'installeur tourne encore (le bouton ne doit pas réapparaître)", async () => {
  const { module } = loadDependencyServices({ onDownload: async () => {} })
  await withFetch(fakeOllamaFetch(['0.34.2']), async () => {
    const result = await module.updateOllama()
    assert.equal(result.installerPending, true, result.message)
  })
})

test('aucun téléchargement du dépôt ne se fait en silence', () => {
  // Garde pour la suite : c'est précisément l'oubli d'un `onProgress` sur UN seul appel (le plus lourd) qui a
  // produit le blocage apparent. Un futur téléchargement ajouté sans avancement se lirait pareil.
  const fichiers = globSync('electron/**/*.ts', { cwd: projectRoot })
  const appels = []
  for (const fichier of fichiers) {
    const source = ts.transpileModule(readFileSync(join(projectRoot, fichier), 'utf8'), {
      compilerOptions: { removeComments: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
    }).outputText
    // La définition elle-même (download.ts) n'est pas un appel.
    for (const match of source.matchAll(/downloadToFile\(([\s\S]{0,400}?)\)\s*[;\n]/g)) {
      if (fichier.endsWith('download.ts')) continue
      appels.push({ fichier, args: match[1] })
    }
  }
  assert.ok(appels.length >= 3, `motif de détection des téléchargements en panne : ${appels.length} appel(s)`)
  const muets = appels.filter((appel) => !appel.args.includes('onProgress')).map((appel) => appel.fichier)
  assert.deepEqual(muets, [], `téléchargement(s) sans le moindre signe de vie : ${muets.join(', ')}`)
})
