import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 299 (Léo : « Ollama donne-t-il la fenêtre de contexte, pour qu'on mette comme ChatGPT ou Claude, 461k/1m ? »).
 * Verrouillé ici : le chiffre vient d'Ollama (conversation envoyée + réponse), jamais d'une estimation ; le maximum
 * est la fenêtre DEMANDÉE pour l'appel ; et le Chat comme le mode Code le reçoivent vraiment.
 */
const usage = loadTsModule('electron/services/contextUsage.ts', { events: await import('node:events') })
const format = loadTsModule('src/lib/formatContextUsage.ts')

test('utilisé = conversation envoyée + réponse écrite, d’après Ollama ; rien de mesuré : rien d’affiché', () => {
  assert.deepEqual({ ...usage.contextUsageOf('chat', { promptTokens: 5000, outputTokens: 213, thinkingChars: 0 }, 32768) }, { scope: 'chat', used: 5213, max: 32768 })
  assert.equal(usage.contextUsageOf('chat', undefined, 32768), null)
  assert.equal(usage.contextUsageOf('chat', { thinkingChars: 0 }, 32768), null, 'réponse interrompue : pas de chiffre inventé')
  assert.equal(usage.contextUsageOf('code', { promptTokens: 10, thinkingChars: 0 }, 0), null)
})

test('chaque mesure est diffusée à qui écoute, puis plus du tout une fois désabonné', () => {
  const seen = []
  const stop = usage.onContextUsage((value) => seen.push(value))
  usage.reportContextUsage('code', { promptTokens: 100, outputTokens: 20, thinkingChars: 0 }, 16384)
  usage.reportContextUsage('code', undefined, 16384)
  stop()
  usage.reportContextUsage('chat', { promptTokens: 1, thinkingChars: 0 }, 8192)
  assert.deepEqual(seen.map((value) => ({ ...value })), [{ scope: 'code', used: 120, max: 16384 }])
})

test('affichage court, comme ChatGPT ou Claude : « k » de 1024, une décimale pour les petits nombres', () => {
  assert.equal(format.formatTokenCount(850, 'fr-FR'), '850')
  assert.equal(format.formatTokenCount(5213, 'fr-FR'), '5,1k')
  assert.equal(format.formatTokenCount(5213, 'en-US'), '5.1k')
  assert.equal(format.formatTokenCount(32768, 'fr-FR'), '32k')
  assert.equal(format.formatTokenCount(472064, 'fr-FR'), '461k')
  assert.equal(format.formatTokenCount(1048576, 'fr-FR'), '1m')
  assert.equal(format.contextUsageRatio(16384, 32768), 0.5)
  assert.equal(format.contextUsageRatio(40000, 32768), 1, 'borné : la réflexion peut dépasser un peu')
  assert.equal(format.contextUsageRatio(5, 0), 0)
})

// --- Câblage (structurel : pas d'Ollama ni d'Electron ici) --------------------------------------------------------
const plain = (path) =>
  ts.transpileModule(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'), {
    compilerOptions: { removeComments: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText

test('Chat : chaque appel au modèle de conversation est mesuré, avec la fenêtre de CET appel (pas le téléphone)', () => {
  const assistant = plain('electron/services/assistant.ts')
  assert.match(assistant, /journal\.timed\(describeModelCall\(model, message, metrics\), askedAt\);\s*if \(!restrictions\)\s*reportContextUsage\('chat', metrics, numCtx\);/)
})

test('Code : chaque étape est mesurée avec la fenêtre de son propre appel (qui change d’une étape à l’autre)', () => {
  const generator = plain('electron/services/codeGenerator.ts')
  assert.match(generator, /const call = \(numCtx\) => chatWithOllama\([\s\S]*?\(metrics\) => reportContextUsage\('code', metrics, numCtx\)\)/)
})

test('le processus principal relaie chaque mesure aux fenêtres', () => {
  assert.match(plain('electron/main.ts'), /onContextUsage\(\(usage\) => broadcast\(IPC_CHANNELS\.contextUsage, usage\)\)/)
})

// Étape 300 (Léo : « je vois pas le contexte, c'est où ? ») : le maximum est demandé AVANT toute réponse.
test('maximum connu d’avance : la mémoire réglée en Chat (ramenée au modèle choisi), le plafond Code ramené au modèle Code', () => {
  const main = plain('electron/main.ts')
  const handler = /ipcMain\.handle\(IPC_CHANNELS\.getContextWindow,[\s\S]*?\n\s*\}\);/.exec(main)?.[0] ?? ''
  assert.match(handler, /scope === 'code'\)\s*return profile\?\.codeModel \? fitToModelContext\(profile\.codeModel, CODE_NUM_CTX_MAX\) : null;/)
  assert.match(handler, /const setting = profile\?\.contextLength \?\? config\.ollama\.numCtx;/)
  assert.match(handler, /return chosen \? fitToModelContext\(chosen, setting\) : setting;/)
})
