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
            }
            return proc
          }
        }
      }
      // `existsSync` toujours false : "ollama app.exe" est introuvable, donc restartOllamaApp abandonne
      // immédiatement et updateOllama passe directement au téléchargement de l'installeur — le chemin qui
      // a occupé Léo pendant 5 minutes.
      if (id === 'fs') return { existsSync: () => false }
      if (id === 'os') return { tmpdir: () => '/tmp' }
      if (id === 'path') return { join: (...parts) => parts.join('/') }
      if (id === 'util') return { promisify: (fn) => (...args) => new Promise((resolve) => fn(...args, () => resolve({ stdout: '', stderr: '' }))) }
      if (id.endsWith('/config')) return { config: { ollama: { host: 'http://127.0.0.1:11434' } } }
      if (id.endsWith('/appLauncher')) return { didAppLaunch: () => true, openApp: async () => '' }
      if (id.endsWith('/download')) return { downloadToFile: onDownload }
      if (id.endsWith('/paths')) return { resourcesRoot: () => '/resources' }
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
