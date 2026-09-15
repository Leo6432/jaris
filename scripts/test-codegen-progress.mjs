import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Avancement et arrêt d'une génération en mode Code (étape 99).
 *
 * Léo : "quand on demande une mise à jour [d'une application] on ne sait pas quand c'est terminé et des fois
 * c'est bloqué et ça fait rien". Une génération enchaîne 2 à 4 appels au modèle local, chacun pouvant durer
 * plusieurs minutes : avant cette étape, RIEN n'était envoyé à l'écran entre le début et la fin d'un appel,
 * et une génération partie ne pouvait plus être arrêtée autrement qu'en fermant Jaris.
 *
 * Ce que ce test verrouille :
 *  - l'avancement est émis pendant l'appel (pas seulement à la fin), et `charsWritten` monte vraiment ;
 *  - les étapes sont numérotées, et le total s'ajuste quand une passe supplémentaire devient nécessaire ;
 *  - "Arrêter" interrompt POUR DE VRAI : plus aucun appel au modèle, et rien n'est enregistré sur le disque.
 */
const source = ts.transpileModule(readFileSync(new URL('../electron/services/codeGenerator.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

// Voir le même commentaire dans les autres tests de ce module : le realm de vm n'a pas les globaux de Node,
// et generateApp arme un battement de cœur pendant chaque appel au modèle.
const TIMERS = { setInterval, clearInterval }

const VALID_HTML =
  '```html\n<!DOCTYPE html>\n<html>\n<head><style>body { margin: 0; }</style></head>\n' +
  '<body><button id="go">Jouer</button><script>\n' +
  "document.getElementById('go').addEventListener('click', function () {});\n" +
  '</script></body>\n</html>\n```'

/**
 * Faux Ollama en streaming : chaque réponse est découpée en fragments remis à `onToken`, exactement comme le
 * vrai `chatWithOllama` le fait quand on lui passe ce callback. `onAbort` permet de simuler un arrêt
 * pendant l'appel.
 */
function setup(responses, { onBeforeCall } = {}) {
  const calls = []
  const statusLines = []
  const progress = []
  const written = []

  const modules = {
    electron: { app: { getPath: () => '/tmp' } },
    'fs/promises': {
      mkdir: async () => {},
      writeFile: async (path, content) => written.push({ path, content })
    },
    path: { join: (...parts) => parts.join('/') },
    './ollama': {
      chatWithOllama: async (messages, _tools, _model, _think, signal, _numCtx, onToken, onThinking) => {
        calls.push(messages)
        await onBeforeCall?.(calls.length)
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
        const next = responses.shift()
        if (next === undefined) throw new Error('plus de réponse simulée disponible')
        // Un modèle qui réfléchit avant d'écrire : le seul signe de vie pendant ce temps.
        onThinking?.('réflexion…')
        for (let i = 0; i < next.length; i += 200) {
          if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' })
          onToken?.(next.slice(i, i + 200))
        }
        return { role: 'assistant', content: next }
      },
      listInstalledModels: async () => ['test-model'],
      pullModelIfMissing: async () => {},
      ModelTooLargeError: class extends Error {},
      DiskFullError: class extends Error {}
    },
    './hardwareScan': { pickBestCodeModel: async () => 'test-model' },
    './profileStore': { getProfile: async () => ({ codeModel: 'test-model', visionModel: 'vision-test' }) },
    '../config': { config: { ollama: { visionModel: 'vision-par-defaut' } } },
    './vision': { IMAGE_FOR_CODE_SYSTEM_PROMPT: 'prompt', describeImage: async () => 'une maquette' }
  }
  const exports = {}
  vm.runInNewContext(source, { exports, require: (name) => modules[name], module: { exports }, console, ...TIMERS })
  return { exports, calls, statusLines, progress, written }
}

function run(app, description, { currentHtml, signal } = {}) {
  return app.exports.generateApp(description, (line) => app.statusLines.push(line), currentHtml, undefined, {
    onProgress: (p) => app.progress.push({ ...p }),
    signal
  })
}

test("l'avancement est émis PENDANT l'appel au modèle, pas seulement à la fin", async () => {
  const app = setup([VALID_HTML, VALID_HTML])
  await run(app, 'une liste de courses')

  assert.ok(app.progress.length >= 2, `aucun avancement émis (${app.progress.length})`)
  // La preuve que ça avance : le compteur de caractères monte au fil des fragments reçus.
  const chars = app.progress.filter((p) => p.stepIndex === 1).map((p) => p.charsWritten)
  assert.equal(chars[0], 0)
  assert.ok(Math.max(...chars) > 0, 'charsWritten est resté à 0 pendant toute la génération')

  // Avant le premier caractère, l'état doit être "il réfléchit" — pas un compteur figé à 0 sans explication.
  assert.equal(app.progress[0].thinking, true)
  assert.ok(app.progress.some((p) => p.thinking === false))
})

test('les étapes sont numérotées, et la relecture est bien la seconde', async () => {
  const app = setup([VALID_HTML, VALID_HTML])
  await run(app, 'une liste de courses')

  const labels = new Map()
  for (const p of app.progress) labels.set(p.stepIndex, p.label)
  assert.equal(labels.get(1), "Écriture de l'application")
  assert.equal(labels.get(2), 'Relecture du code')
  for (const p of app.progress) assert.equal(p.stepCount, 2)
})

test("une modification d'application existante est annoncée comme telle", async () => {
  const app = setup([VALID_HTML, VALID_HTML])
  await run(app, 'ajoute un bouton', { currentHtml: '<html></html>' })
  assert.equal(app.progress[0].label, "Modification de l'application")
})

test('une passe supplémentaire fait monter le total annoncé, jamais "étape 3 sur 2"', async () => {
  // Première réponse inexploitable : generateApp relance une fois. Cette relance est une vraie étape en
  // plus, le total doit suivre — sinon l'écran afficherait une étape au-delà du total annoncé.
  const app = setup(['désolé, je ne peux pas', VALID_HTML, VALID_HTML])
  await run(app, 'un jeu Snake')

  const last = app.progress.at(-1)
  assert.ok(last.stepIndex <= last.stepCount, `étape ${last.stepIndex} sur ${last.stepCount}`)
  assert.equal(app.progress.some((p) => p.label === 'Nouvelle tentative'), true)
})

test('"Arrêter" interrompt vraiment : plus aucun appel au modèle, et rien n\'est enregistré', async () => {
  const controller = new AbortController()
  // Arrêt demandé pendant le PREMIER appel, comme un clic réel en pleine génération.
  const app = setup([VALID_HTML, VALID_HTML], {
    onBeforeCall: async (callNumber) => {
      if (callNumber === 1) controller.abort()
    }
  })

  await assert.rejects(
    () => run(app, 'une liste de courses', { signal: controller.signal }),
    (err) => {
      // Un arrêt voulu n'est pas une panne : le message le dit tel quel, sans jargon.
      assert.match(err.message, /arrêtée/i)
      assert.doesNotMatch(err.message, /AbortError/)
      return true
    }
  )
  assert.equal(app.calls.length, 1, 'le modèle a été rappelé après un arrêt')
  assert.equal(app.written.length, 0, 'une application a été enregistrée malgré un arrêt')
})

test("un arrêt pendant la RELECTURE ne se fait pas avaler par sa tolérance aux erreurs", async () => {
  // La relecture est volontairement tolérante (un échec garde le premier jet). Sans relais explicite, un
  // arrêt demandé à ce moment-là aurait été absorbé et la génération serait allée jusqu'au bout — donc un
  // bouton "Arrêter" qui, du point de vue de Léo, "ne fait rien".
  const controller = new AbortController()
  const app = setup([VALID_HTML, VALID_HTML], {
    onBeforeCall: async (callNumber) => {
      if (callNumber === 2) controller.abort()
    }
  })

  await assert.rejects(() => run(app, 'une liste de courses', { signal: controller.signal }), /arrêtée/i)
  assert.equal(app.written.length, 0)
})
