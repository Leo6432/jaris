import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * findLeakedToolName (assistant.ts) détecte qu'une réponse SANS appel d'outil mentionne malgré tout le nom
 * TECHNIQUE d'un outil (ex: "j'ai tapé Bonjour avec type_text") — signe qu'une action a été NARRÉE au lieu
 * d'être réellement effectuée, y compris au passé composé ("j'ai ouvert...j'ai tapé..."), un cas que
 * PROMISE_WITHOUT_ACTION (motif au futur uniquement) ne couvre pas. Exportée au niveau module pour être
 * testée ici sans avoir à mocker tout converse() (Ollama, les outils, le profil...).
 *
 * Les mêmes 14 noms que le vrai tableau TOOLS (tools.ts) sont recopiés ici UNIQUEMENT comme liste de test
 * (via le second paramètre `toolNames` de findLeakedToolName, justement prévu pour ça) : la fonction elle
 * -même, en production, dérive toujours sa liste de TOOLS — un outil ajouté à tools.ts n'a jamais besoin
 * d'être répété ici pour rester couvert par le vrai détecteur, cette liste ne sert qu'à isoler le test.
 */
const REAL_TOOL_NAMES = [
  'open_app', 'set_reminder', 'look_at_screen', 'search_web', 'read_web_page', 'remember', 'recall_memory',
  'type_text', 'press_key', 'click_mouse', 'get_system_stats', 'media_control', 'computer_use_task', 'shutdown_pc'
]

const source = ts.transpileModule(readFileSync(new URL('../electron/services/assistant.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText

const modules = {
  '../config': { config: { ollama: {} } },
  './ollama': {},
  './memoryStore': {},
  './profileStore': {},
  './tools': {
    TOOLS: REAL_TOOL_NAMES.map((name) => ({ function: { name } })),
    createToolExecutor: () => {}
  },
  './hardwareScan': {},
  './resourceMonitor': {}
}
const exports = {}
vm.runInNewContext(source, { exports, require: (name) => modules[name], module: { exports } })
const { findLeakedToolName } = exports

test('reproduit le vrai cas rapporté par Léo : une action déjà "faite" au passé composé, avec le nom de l\'outil', () => {
  const text =
    "J'ai ouvert le bloc-notes (ou le premier champ texte disponible) et j'ai tapé Bonjour avec type_text."
  assert.equal(findLeakedToolName(text), 'type_text')
})

for (const [text, expected] of [
  ["j'ai ouvert Notepad avec open_app", 'open_app'],
  ['je viens de faire ça via computer_use_task', 'computer_use_task'],
  ['j\'ai déjà appelé click_mouse pour toi', 'click_mouse'],
  ['fait, press_key a été utilisée', 'press_key'],
  ['Type_Text a bien tapé le message', 'type_text'] // insensible à la casse
]) {
  test(`détecte le nom d'outil qui fuite : ${JSON.stringify(text)}`, () => {
    assert.equal(findLeakedToolName(text), expected)
  })
}

for (const text of [
  "Bonjour, comment puis-je t'aider ?",
  "Il fait beau aujourd'hui.",
  "Voici ce que j'ai trouvé sur le sujet.",
  // Un mot français ordinaire ne doit jamais matcher un nom d'outil par simple sous-chaîne : "remember" et
  // "mediastore" ne sont pas des mots français, mais un futur outil au nom plus commun devra rester couvert
  // par la limite de mot (\b) plutôt que par une sous-chaîne — vérifié ici avec les noms RÉELS actuels.
  'je me souviens de toi',
  ''
]) {
  test(`jamais un faux positif : ${JSON.stringify(text)}`, () => {
    assert.equal(findLeakedToolName(text), undefined)
  })
}

test('la limite de mot (\\b) évite un faux positif sur une sous-chaîne', () => {
  // "shutdown_pc" ne doit pas matcher à l'intérieur d'un mot plus long qui le contiendrait.
  assert.equal(findLeakedToolName('preshutdown_pcx', REAL_TOOL_NAMES), undefined)
})

test('un second paramètre personnalisé remplace la vraie liste TOOL_NAMES (isolation du test)', () => {
  assert.equal(findLeakedToolName('j\'ai utilisé mon_outil_de_test', ['mon_outil_de_test']), 'mon_outil_de_test')
  assert.equal(findLeakedToolName('rien à voir ici', ['mon_outil_de_test']), undefined)
})
