import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Étape 252 : en mode vocal, Léo ne voyait rien pendant 1 min (le modèle réfléchissait avant même de piloter).
 * L'écran dit maintenant ce que Jaris fait, avec un compteur qui avance ; et « clique sur… » part directement au
 * pilotage, sans la réflexion du modèle de conversation.
 */
function load(path) {
  const source = ts.transpileModule(readFileSync(new URL(path, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, require, module) {\n${source}\n})`)(module.exports, () => ({}), module)
  return module.exports
}
const { activityFromLog, formatActivity, THINKING_ACTIVITY } = load('../shared/voiceActivity.ts')

test('le compteur avance chaque seconde, puis en minutes', () => {
  assert.equal(formatActivity(THINKING_ACTIVITY, 0), 'Je réfléchis… 0 s')
  assert.equal(formatActivity(THINKING_ACTIVITY, 45_900), 'Je réfléchis… 45 s')
  assert.equal(formatActivity(THINKING_ACTIVITY, 125_000), 'Je réfléchis… 2 min 05')
})

test('les vraies lignes du journal de Léo deviennent des phrases courtes, sans coordonnées ni nom technique', () => {
  assert.equal(activityFromLog('Outil appelé : computer_use_task({"goal":"Ouvrir Firefox"})'), "Je prends la main sur l'écran")
  assert.equal(activityFromLog('Outil appelé : search_web({"query":"tiramisu"})'), 'Je cherche sur internet')
  assert.equal(activityFromLog('Outil appelé : get_system_stats({})'), "J'utilise un outil")
  assert.equal(activityFromLog("Étape 1/20 : je regarde l'écran…"), "Étape 1 : je regarde l'écran")
  assert.equal(activityFromLog('Étape 1/20 : clic left à (96, 1302).'), 'Étape 1 : je clique')
  assert.equal(activityFromLog('Étape 2/20 : je vise précisément the "Rechercher" button…'), 'Étape 2 : je vise the "Rechercher" button')
  assert.equal(activityFromLog('Étape 2/20 : clic left sur the "Play" button à (10, 20) (visé par MAI-UI).'), 'Étape 2 : je clique sur the "Play" button')
  assert.equal(activityFromLog('Étape 3/20 : clic sur "Rechercher".'), 'Étape 3 : je clique sur « Rechercher »')
  assert.equal(activityFromLog('Étape 2/20 : texte tapé.'), "Étape 2 : j'écris le texte")
  assert.equal(activityFromLog('Étape 4/20 : attente du chargement de la page…'), "Étape 4 : j'attends que la page charge")
  assert.equal(activityFromLog("Résultat de l'outil : Firefox a été lancé."), 'Je prépare la réponse')
  // Les lignes techniques ne changent pas ce qui est affiché.
  assert.equal(activityFromLog('Modèle choisi : granite4.2:8b (réflexion : medium)'), null)
  assert.equal(activityFromLog('VRAM libre actuelle : 3 Go'), null)
})

test('la ligne d’activité suit la vraie demande vocale : démarrée, mise à jour par le journal, effacée à la fin', () => {
  const source = readFileSync(new URL('../electron/services/voicePipeline.ts', import.meta.url), 'utf8')
  const turn = source.slice(source.indexOf('private async runTranscript'), source.indexOf('private async speak'))
  assert.ok(turn.indexOf('this.startActivity()') > -1 && turn.indexOf('this.startActivity()') < turn.indexOf('await converse('), 'affichée AVANT la réflexion')
  assert.match(turn, /this\.noteActivity\(message\)/)
  // Effacée dans le finally : même une erreur ou une annulation ne la laisse jamais affichée.
  assert.match(turn, /finally \{[^}]*this\.stopActivity\(\)/)
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  assert.match(main, /pipeline\.on\('activity', \(text: string \| null\) => broadcast\(IPC_CHANNELS\.voiceActivity, text\)\)/)
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.equal((app.match(/<p className="app__activity">\{voiceActivity\}<\/p>/g) ?? []).length, 2, 'écran vocal ET widget')
})
