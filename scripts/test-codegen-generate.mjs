import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { modelChoiceModule } from './load-model-choice.mjs'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Reproduit en usage réel (Léo, "un jeu Snake") : le modèle a répondu en Python/tkinter au lieu de HTML,
 * malgré la consigne système. generateApp() doit relancer UNE fois avec une consigne corrective avant
 * d'abandonner — mêmes mocks no-op qu'ailleurs (electron/ollama/hardwareScan/profileStore), puisque cette
 * fonction précise ne les utilise que pour des à-côtés (modèle à charger, écriture sur disque).
 */
const source = ts.transpileModule(readFileSync(new URL('../electron/services/codeGenerator.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

const VALID_HTML =
  '```html\n<!DOCTYPE html>\n<html>\n<head><style>body { margin: 0; }</style></head>\n' +
  '<body><button id="go">Jouer</button><script>\n' +
  "document.getElementById('go').addEventListener('click', function () {});\n" +
  '</script></body>\n</html>\n```'

const PYTHON_RESPONSE =
  '```python\nimport tkinter as tk\n\nclass SnakeGame:\n    def __init__(self, fenetre):\n        pass\n```'

// `vm.runInNewContext` crée un realm SANS les globaux de Node : depuis l'étape 99, generateApp arme un
// battement de cœur (setInterval) pendant chaque appel au modèle, qui échouait ici sur un simple
// "setInterval is not defined" — un piège qui ne vient pas du code testé mais du bac à sable du test.
const TIMERS = { setInterval, clearInterval }

/** Fabrique un module généré avec une file de réponses successives pour chatWithOllama (dans l'ordre d'appel). */
function setup(responses, { profile = { codeModel: 'test-model', visionModel: 'vision-test' }, installed = ['test-model'] } = {}) {
  const calls = []
  const models = []
  const statusLines = []
  const activity = []
  const visionCalls = []
  const modules = {
    electron: { app: { getPath: () => '/tmp' } },
    './dataLocation': { getDataRoot: () => '/tmp' },
    'fs/promises': { mkdir: async () => {}, writeFile: async () => {} },
    path: { join: (...parts) => parts.join('/') },
    './ollama': {
      chatWithOllama: async (messages, _tools, model) => {
        calls.push(messages)
        models.push(model)
        const next = responses.shift()
        if (next === undefined) throw new Error('plus de réponse simulée disponible (critique/réparation)')
        return { role: 'assistant', content: next }
      },
      listInstalledModels: async () => installed,
      pullModelIfMissing: async () => {},
      ModelTooLargeError: class extends Error {},
      DiskFullError: class extends Error {}
    },
    // Étape 286 : le VRAI calcul de différences (pur, sans import), pour compter les lignes écrites dans index.html.
    '../../shared/lineDiff': loadTsModule('shared/lineDiff.ts'),
    './hardwareScan': { pickBestCodeModel: async () => 'test-model' },
    './modelChoice': modelChoiceModule,
    './profileStore': { getProfile: async () => profile },
    // Étape 91 : une maquette jointe est d'abord traduite en TEXTE par le modèle de vision (le modèle de
    // code ne sait pas lire une image, et les deux ne tiennent pas ensemble en VRAM).
    '../config': { config: { ollama: { visionModel: 'vision-par-defaut' } } },
    './vision': {
      IMAGE_FOR_CODE_SYSTEM_PROMPT: 'prompt-image-code',
      describeImage: async (imageBase64, question, model, systemPrompt) => {
        visionCalls.push({ imageBase64, question, model, systemPrompt })
        return 'Un bouton rouge centré sur fond noir.'
      }
    }
  }
  const exports = {}
  vm.runInNewContext(source, { exports, require: (name) => modules[name], module: { exports }, console, ...TIMERS })
  return {
    generateApp: (description, currentHtml, imageBase64) =>
      exports.generateApp(description, (line) => statusLines.push(line), currentHtml, imageBase64, {
        onActivity: (item) => activity.push(item)
      }),
    calls,
    models,
    statusLines,
    activity,
    visionCalls
  }
}

test('une réponse en Python déclenche UNE relance corrective, qui aboutit', async () => {
  // 3 appels attendus : génération (Python), relance corrective (HTML), puis la passe de critique qui suit
  // TOUJOURS une extraction réussie — pas de 4e réponse fournie exprès : son échec (mock épuisé) doit être
  // avalé par le try/catch déjà en place ("premier jet conservé"), jamais faire échouer generateApp.
  const app = setup([PYTHON_RESPONSE, VALID_HTML])
  const result = await app.generateApp('un jeu Snake')
  assert.match(result.html, /<!DOCTYPE html>/)
  assert.equal(app.calls.length, 3)
  // Le tour fautif ET la consigne corrective doivent être visibles dans le deuxième appel, pour que le
  // modèle sache exactement ce qu'il a fait de travers.
  const retryMessages = app.calls[1]
  assert.ok(retryMessages.some((m) => m.role === 'assistant' && m.content === PYTHON_RESPONSE))
  assert.ok(retryMessages.some((m) => m.role === 'user' && /python/i.test(m.content)))
  assert.ok(app.statusLines.some((line) => /répondu en python/i.test(line)))
})

test('deux réponses non-HTML de suite abandonnent avec le VRAI contenu de la relance dans le message', async () => {
  const app = setup([PYTHON_RESPONSE, "Désolé, je ne peux pas générer ça."])
  await assert.rejects(app.generateApp('un jeu Snake'), (err) => {
    assert.match(err.message, /même après une nouvelle tentative/)
    assert.match(err.message, /Désolé, je ne peux pas générer ça/)
    return true
  })
  assert.equal(app.calls.length, 2)
})

test('une réponse HTML valide dès le premier coup ne déclenche AUCUNE relance', async () => {
  // 2 appels : génération (réussie du premier coup) + la passe de critique qui suit toujours, pas de
  // relance corrective (pas de 3e réponse fournie exprès, voir le commentaire du test précédent).
  const app = setup([VALID_HTML])
  const result = await app.generateApp('une todo list')
  assert.match(result.html, /<!DOCTYPE html>/)
  assert.equal(app.calls.length, 2)
  assert.ok(!app.statusLines.some((line) => /nouvelle tentative/i.test(line)))
})

/**
 * Étape 91 — maquette jointe en mode Code. Le modèle de code ne reçoit JAMAIS l'image : elle est d'abord
 * traduite en texte par le modèle de vision, et c'est ce texte qui entre dans le prompt. Les deux modèles
 * ne sont ainsi jamais chargés en même temps (contrainte VRAM déjà documentée pour look_at_screen).
 */
test("une image jointe est lue par le modèle de vision, puis décrite au modèle de code", async () => {
  const app = setup([VALID_HTML])
  await app.generateApp('reproduis ça', undefined, 'BASE64MAQUETTE')

  assert.equal(app.visionCalls.length, 1)
  assert.equal(app.visionCalls[0].imageBase64, 'BASE64MAQUETTE')
  assert.equal(app.visionCalls[0].systemPrompt, 'prompt-image-code')
  assert.equal(app.visionCalls[0].model, 'vision-test')

  // La description de l'image doit se retrouver dans ce qui part au modèle de code, et l'image elle-même
  // ne doit jamais y apparaître.
  const userPrompt = app.calls[0].find((message) => message.role === 'user').content
  assert.match(userPrompt, /Un bouton rouge centré sur fond noir\./)
  assert.match(userPrompt, /reproduis ça/)
  assert.equal(userPrompt.includes('BASE64MAQUETTE'), false)
})

test("sans image, le prompt du modèle de code est inchangé", async () => {
  const app = setup([VALID_HTML])
  await app.generateApp('une todo list')
  assert.equal(app.visionCalls.length, 0)
  const userPrompt = app.calls[0].find((message) => message.role === 'user').content
  assert.equal(userPrompt, 'Application à créer : une todo list')
})

// Étape 141 : sélecteur de modèle du mode Code — retiré à l'étape 201 (toujours le modèle Code).
test('mode Code (étape 201) : toujours le modèle Code, même avec un ancien choix à la main enregistré', async () => {
  const app = setup([VALID_HTML, VALID_HTML], {
    profile: { codeModel: 'test-model', modelChoices: { code: 'choisi:14b' } },
    installed: ['test-model', 'choisi:14b']
  })
  await app.generateApp('une todo list')
  assert.ok(app.models.length >= 1)
  assert.ok(app.models.every((m) => m === 'test-model'), `modèles utilisés : ${app.models.join(', ')}`)
  assert.ok(!app.statusLines.some((line) => /choisi à la main/.test(line)))
})

test('mode Code : sur Auto, le modèle calculé pour la machine reste utilisé comme avant', async () => {
  const app = setup([VALID_HTML, VALID_HTML], { profile: { codeModel: 'test-model' }, installed: ['test-model', 'choisi:14b'] })
  await app.generateApp('une todo list')
  assert.ok(app.models.every((m) => m === 'test-model'))
})

/**
 * Étape 286 (Léo : « enlève l'autre carré Modèle de code choisi automatiquement pour cette machine […] mets les
 * trucs qu'il est en train de faire, par exemple ajouter plus 500 lignes de code dans index »).
 */
test('une nouvelle application annonce « Créé index.html » avec ses lignes, sans parler du modèle choisi', async () => {
  const app = setup([VALID_HTML])
  const result = await app.generateApp('une todo list')
  const lines = result.html.split('\n').length
  assert.deepEqual(JSON.parse(JSON.stringify(app.activity)), [{ kind: 'create', path: 'index.html', added: lines, removed: 0 }])
  assert.ok(!app.statusLines.some((line) => /choisi automatiquement|Réflexion de/.test(line)), app.statusLines.join(' | '))
})

test('une modification annonce « Modifié index.html » avec les lignes ajoutées et retirées', async () => {
  const before = VALID_HTML.replace(/^```html\n|```$/g, '').replace('Jouer', 'Commencer')
  const app = setup([VALID_HTML])
  await app.generateApp('renomme le bouton', before)
  assert.deepEqual(JSON.parse(JSON.stringify(app.activity)), [{ kind: 'edit', path: 'index.html', added: 1, removed: 1 }])
})

test('le téléchargement du modèle, lui, reste annoncé : long et visible', async () => {
  const app = setup([VALID_HTML], { installed: [] })
  await app.generateApp('une todo list')
  assert.ok(app.statusLines.some((line) => /Téléchargement du modèle de code/.test(line)), app.statusLines.join(' | '))
})
