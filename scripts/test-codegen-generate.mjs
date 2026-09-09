import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

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

/** Fabrique un module généré avec une file de réponses successives pour chatWithOllama (dans l'ordre d'appel). */
function setup(responses) {
  const calls = []
  const statusLines = []
  const modules = {
    electron: { app: { getPath: () => '/tmp' } },
    'fs/promises': { mkdir: async () => {}, writeFile: async () => {} },
    path: { join: (...parts) => parts.join('/') },
    './ollama': {
      chatWithOllama: async (messages) => {
        calls.push(messages)
        const next = responses.shift()
        if (next === undefined) throw new Error('plus de réponse simulée disponible (critique/réparation)')
        return { role: 'assistant', content: next }
      },
      listInstalledModels: async () => ['test-model'],
      pullModelIfMissing: async () => {},
      ModelTooLargeError: class extends Error {},
      DiskFullError: class extends Error {}
    },
    './hardwareScan': { pickBestCodeModel: async () => 'test-model' },
    './profileStore': { getProfile: async () => ({ codeModel: 'test-model' }) }
  }
  const exports = {}
  vm.runInNewContext(source, { exports, require: (name) => modules[name], module: { exports }, console })
  return {
    generateApp: (description) => exports.generateApp(description, (line) => statusLines.push(line)),
    calls,
    statusLines
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
