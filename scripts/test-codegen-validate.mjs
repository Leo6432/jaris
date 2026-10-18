import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { modelChoiceModule } from './load-model-choice.mjs'
import { loadTsModule } from './load-ts-module.mjs'
import { withI18n } from './i18n-test-module.mjs'

// `vm.runInNewContext` crée un realm SANS les globaux de Node : depuis l'étape 99, generateApp arme un
// battement de cœur (setInterval) pendant chaque appel au modèle, qui échouait ici sur un simple
// "setInterval is not defined" — un piège qui ne vient pas du code testé mais du bac à sable du test.
const TIMERS = { setInterval, clearInterval }

/**
 * validateGeneratedHtml() est une fonction pure (aucun appel réseau/disque à l'exécution) mais son module
 * importe electron/ollama/hardwareScan/profileStore au chargement — mockés ici en no-op puisque cette
 * fonction précise ne les appelle jamais, exactement comme scripts/test-computer-use.mjs le fait déjà pour
 * computerUse.ts.
 */
const source = ts.transpileModule(readFileSync(new URL('../electron/services/codeGenerator.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

const modules = {
  electron: { app: { getPath: () => '/tmp' } },
  './dataLocation': { getDataRoot: () => '/tmp' },
  'fs/promises': { mkdir: async () => {}, writeFile: async () => {} },
  path: { join: (...parts) => parts.join('/') },
  './ollama': {
      // Étape 291 : le modèle est-il déjà chargé ? (« Charge le modèle… » avant le premier mot)
      isModelLoaded: async () => true,
    chatWithOllama: async () => ({ content: '' }),
    listInstalledModels: async () => [],
    pullModelIfMissing: async () => {},
    ModelTooLargeError: class extends Error {},
    DiskFullError: class extends Error {}
  },
  // Étape 286 : le VRAI calcul de différences (pur, sans import), pour compter les lignes écrites dans index.html.
  '../../shared/lineDiff': loadTsModule('shared/lineDiff.ts'),
  // Le VRAI contrôle de syntaxe des scripts (compile sans exécuter) : validateGeneratedHtml le consulte à chaque génération.
  './scriptSyntax': loadTsModule('electron/services/scriptSyntax.ts', { vm }),
  './hardwareScan': { pickBestCodeModel: async () => 'test-model' },
  './modelChoice': modelChoiceModule,
  './profileStore': { getProfile: async () => null }
}
const exports = {}
vm.runInNewContext(source, { exports, require: withI18n((name) => modules[name]), module: { exports }, ...TIMERS })

const { validateGeneratedHtml } = exports

const withStyle = (bodyRule) => `<!DOCTYPE html><html><head><style>${bodyRule}</style></head><body></body></html>`

test("body { height: 100vh; overflow: hidden } est détecté (piège réel du jeu Snake de Léo)", () => {
  const issues = validateGeneratedHtml(withStyle('body { height: 100vh; overflow: hidden; }'))
  assert.ok(issues.some((issue) => /overflow: hidden/.test(issue)))
})

test('html, body { height: 100%; overflow: hidden } (sélecteur combiné) est détecté', () => {
  const issues = validateGeneratedHtml(withStyle('html, body { height: 100%; overflow: hidden; }'))
  assert.ok(issues.some((issue) => /overflow: hidden/.test(issue)))
})

test("overflow-y: hidden (variante) est détecté", () => {
  const issues = validateGeneratedHtml(withStyle('body { height: 100vh; overflow-y: hidden; }'))
  assert.ok(issues.some((issue) => /overflow: hidden/.test(issue)))
})

test('overflow-x: hidden seul (page normale scrollable verticalement) ne déclenche PAS le piège', () => {
  const issues = validateGeneratedHtml(withStyle('body { min-height: 100vh; overflow-x: hidden; }'))
  assert.ok(!issues.some((issue) => /overflow: hidden/.test(issue)))
})

test("overflow: hidden sur un sélecteur qui n'est ni html ni body ne déclenche PAS le piège", () => {
  const issues = validateGeneratedHtml(withStyle('.card { overflow: hidden; } body { height: 100vh; }'))
  assert.ok(!issues.some((issue) => /overflow: hidden/.test(issue)))
})

test('height: 100vh sans overflow: hidden (page normale) ne déclenche PAS le piège', () => {
  const issues = validateGeneratedHtml(withStyle('body { min-height: 100vh; }'))
  assert.ok(!issues.some((issue) => /overflow: hidden/.test(issue)))
})

/**
 * Bug vu en vrai : une application livrée avec `function toggleAlarm(false) {` — « Unexpected token 'false' ». Tout le
 * script mort, aucun bouton qui marche, et aucun avertissement : les motifs de texte ci-dessus ne compilaient jamais
 * le JavaScript. Désormais chaque script de la page est compilé (sans être exécuté).
 */
const withScripts = (...scripts) =>
  `<!DOCTYPE html>\n<html>\n<head><style>body { margin: 0; }</style></head>\n<body>\n<button id="alarme">Alarme</button>\n${scripts.join('\n')}\n</body>\n</html>`

test('le cas réel `function toggleAlarm(false) {` est signalé au modèle : script, ligne, erreur et ligne fautive', () => {
  const html = withScripts(
    '<script>\n  const etat = { alarme: false }\n</script>',
    "<script>\n  let alarme = false\n  function toggleAlarm(false) {\n    alarme = !alarme\n  }\n  document.getElementById('alarme').addEventListener('click', toggleAlarm)\n</script>"
  )
  const issues = validateGeneratedHtml(html)
  const syntax = issues.filter((issue) => /erreur de syntaxe/.test(issue))
  assert.equal(syntax.length, 1, issues.join(' | '))
  assert.match(syntax[0], /script n°2/)
  assert.match(syntax[0], /ligne 3 de ce script \(ligne 11 du fichier\)/)
  assert.match(syntax[0], /Unexpected token 'false'/)
  assert.match(syntax[0], /function toggleAlarm\(false\) \{/)
})

test('des scripts valides et variés ne déclenchent AUCUNE erreur de syntaxe (le contrôle tourne à chaque génération)', () => {
  const html = withScripts(
    '<script type="application/json" id="config">{ "theme": "sombre", pas du JavaScript }</script>',
    '<script type="text/template" id="ligne"><li>{{ nom }}</li></script>',
    `<script>
  /* Horloge avec alarme */
  class Horloge {
    #alarme = null
    constructor(el) { this.el = el }
    async tic() { await new Promise((r) => setTimeout(r, 1000)); return new Date() }
  }
  const format = (d) => \`\${String(d?.getHours() ?? 0).padStart(2, '0')}:\${String(d?.getMinutes() ?? 0).padStart(2, '0')}\`
  const heureValide = /^\\d{2}:\\d{2}$/
  const reglages = { volume: 0.5, ...JSON.parse(document.getElementById('config')?.textContent || '{}') }
  document.getElementById('alarme').addEventListener('click', async () => {
    const h = new Horloge(document.body)
    document.title = format(await h.tic())
  })
</script>`,
    `<script type="module">
import { lancer } from './jeu.js'
export const version = 1
const donnees = await fetch(import.meta.url).catch(() => null)
lancer?.(donnees)
</script>`
  )
  const issues = validateGeneratedHtml(html)
  assert.equal(
    issues.filter((issue) => /erreur de syntaxe/.test(issue)).length,
    0,
    `faux positif : du JavaScript valide signalé comme cassé (${issues.join(' | ')})`
  )
})

test('la page piégée (`<p>` puis `a<b` répété, jamais fermée) est vérifiée en moins d’une seconde, même très grande', () => {
  // Relecture croisée : 49 s pour 8 000 caractères (scriptSyntax.ts), toutes les fenêtres figées pendant ce temps ; puis,
  // une fois ce défaut corrigé, encore 2,8 s pour 160 000 caractères dans le retrait des balises du texte visible. Du
  // plus petit au plus grand : si un défaut revenait, l'échec arriverait en quelques secondes, pas en quelques heures.
  for (const size of [4_000, 8_000, 160_000]) {
    const html = '<p>' + 'a<b'.repeat(Math.ceil((size - 3) / 3))
    const start = performance.now()
    const issues = validateGeneratedHtml(html)
    const elapsed = performance.now() - start
    assert.ok(elapsed < 1000, `${html.length} caractères : ${Math.round(elapsed)} ms`)
    // Toujours la même lecture : ni <html> ni <body>, et pas d'erreur de script inventée.
    assert.equal(issues.length, 2, issues.join(' | '))
  }
})
