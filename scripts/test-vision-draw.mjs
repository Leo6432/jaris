import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 478 (Léo : « Dessine une miniature Roblox pour mon jeu, et voici une image de mon jeu » → « Désolé, je ne peux
 * pas générer d'images ») : une image jointe au Chat part au modèle de vision, qui reçoit maintenant l'outil de dessin —
 * mais seulement si ce PC dessine ET si le modèle sait appeler un outil (sinon Ollama refuserait toute la demande).
 */
function setup({ canCallTools = true, reply }) {
  const calls = []
  const vision = loadTsModule('electron/services/vision.ts', {
    electron: { desktopCapturer: {}, screen: {} },
    '../config': { config: { ollama: { numCtx: 8192 } } },
    './scanOverlay': { showScanOverlay: () => {}, hideScanOverlay: () => {} },
    './hardwareScan': { getModelGpuStatus: async () => ({ freeVramGb: null }), pickSafeVisionModel: (_v, _i, model) => model },
    './ollama': {
      autoContextFor: async () => 8192,
      listInstalledModels: async () => [],
      modelCanCallTools: async () => canCallTools,
      chatWithOllama: async (messages, tools, model) => {
        calls.push({ messages, tools, model })
        return reply
      }
    }
  })
  return { vision, calls }
}

const DRAW = { role: 'assistant', content: '', tool_calls: [{ function: { name: 'generate_image', arguments: { prompt: 'a Roblox thumbnail of this island city' } } }] }

test('le modèle de vision reçoit l’outil de dessin et décide de dessiner : sa description en anglais revient', async () => {
  const { vision, calls } = setup({ reply: DRAW })
  const answer = await vision.answerImageInChat('IMG', 'Dessine une miniature Roblox pour mon jeu', 'qwen3-vl:8b', true)
  assert.deepEqual(answer, { kind: 'draw', prompt: 'a Roblox thumbnail of this island city' })
  const [{ messages, tools, model }] = calls
  assert.equal(model, 'qwen3-vl:8b')
  assert.deepEqual(tools.map((tool) => tool.function.name), ['generate_image'], 'seulement le dessin, aucun autre outil')
  assert.deepEqual(messages[1].images, ['IMG'])
  assert.match(messages[0].content, /generate_image/, 'les consignes disent qu’il sait dessiner')
})

test('une question sur l’image : du texte, comme avant', async () => {
  const { vision } = setup({ reply: { role: 'assistant', content: 'Une île avec une grande roue.' } })
  assert.deepEqual(await vision.answerImageInChat('IMG', 'Il y a quoi ?', 'm', true), { kind: 'text', text: 'Une île avec une grande roue.' })
})

test('sans description utilisable, la demande de Léo sert de description (traduite ensuite)', async () => {
  const { vision } = setup({ reply: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'generate_image', arguments: {} } }] } })
  assert.deepEqual(await vision.answerImageInChat('IMG', 'Dessine une miniature', 'm', true), { kind: 'draw', prompt: 'Dessine une miniature' })
})

test('PC qui ne dessine pas, ou modèle sans outils : aucun outil proposé, et un appel inventé est ignoré', async () => {
  for (const [canDraw, canCallTools] of [[false, true], [true, false], [true, null]]) {
    const { vision, calls } = setup({ canCallTools, reply: { ...DRAW, content: 'Voici ce que je vois.' } })
    const answer = await vision.answerImageInChat('IMG', 'Dessine', 'm', canDraw)
    assert.equal(calls[0].tools, undefined, `${canDraw}/${canCallTools}`)
    assert.doesNotMatch(calls[0].messages[0].content, /generate_image/)
    assert.deepEqual(answer, { kind: 'text', text: 'Voici ce que je vois.' })
  }
})
