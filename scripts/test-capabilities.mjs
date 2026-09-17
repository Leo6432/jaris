import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Onglet Options → "Ce que Jaris sait faire" (étape 108, shared/capabilities.ts), demandé par Léo.
 *
 * Le risque que ce test surveille : `CAPABILITIES` est une redite VOLONTAIREMENT réécrite (langage courant,
 * groupée par usage) de `TOOLS` (electron/services/tools.ts, écrit pour Ollama) — pas une copie automatique.
 * Un outil ajouté à `tools.ts` sans mise à jour de `capabilities.ts` laisserait Léo croire que la liste est
 * complète alors qu'elle a pris du retard, sans que rien ne le signale. Même famille de piège que
 * `findLeakedToolName`, déjà dérivé de `TOOLS` pour rester synchronisé automatiquement.
 */
const projectRoot = new URL('..', import.meta.url)

const toolsSource = readFileSync(new URL('electron/services/tools.ts', projectRoot), 'utf8')
// Motif volontairement simple (pas un vrai parseur AST) : il vise UNIQUEMENT `name: 'xxx'` dans le tableau
// TOOLS, qui est la forme utilisée pour chaque outil dans ce fichier depuis le début du projet.
const toolNamesInSource = [...toolsSource.matchAll(/\n\s*name: '([a-z_]+)',/g)].map((match) => match[1])

const capabilitiesSource = ts.transpileModule(readFileSync(new URL('shared/capabilities.ts', projectRoot), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const exports = {}
vm.runInThisContext(`(function (exports, module, require) { ${capabilitiesSource} })`)(exports, { exports }, () => ({}))
const { CAPABILITIES } = exports

const declaredToolNames = CAPABILITIES.flatMap((group) => group.items.flatMap((item) => item.toolNames ?? []))

test('tous les outils réels de tools.ts sont trouvés dans le fichier source', () => {
  // Seuil abaissé à l'étape 116 (retrait complet de Mobile connecté : 5 outils téléphone en moins). Si ce
  // test échoue, le motif regex ci-dessus a raté quelque chose — pas une preuve que tools.ts est vide.
  assert.ok(toolNamesInSource.length >= 12, `seulement ${toolNamesInSource.length} outil(s) trouvé(s) dans tools.ts : le motif a-t-il changé ?`)
})

test('aucun outil de tools.ts ne manque dans "Ce que Jaris sait faire"', () => {
  const manquants = toolNamesInSource.filter((name) => !declaredToolNames.includes(name))
  assert.deepEqual(manquants, [], `outil(s) ajouté(s) à tools.ts sans entrée dans capabilities.ts : ${manquants.join(', ')}`)
})

test('aucune entrée ne cite un outil qui n’existe plus', () => {
  // Le sens inverse : un outil renommé ou retiré de tools.ts (comme read_phone_notifications à l'étape
  // 21quater) laisserait sinon une référence morte, invisible tant que rien ne la relit.
  const fantomes = declaredToolNames.filter((name) => !toolNamesInSource.includes(name))
  assert.deepEqual(fantomes, [], `capabilities.ts cite un outil introuvable dans tools.ts : ${fantomes.join(', ')}`)
})

test('un même outil n’est jamais listé deux fois (un vrai doublon, pas juste un regroupement)', () => {
  const comptes = new Map()
  for (const name of declaredToolNames) comptes.set(name, (comptes.get(name) ?? 0) + 1)
  const doublons = [...comptes.entries()].filter(([, count]) => count > 1).map(([name]) => name)
  assert.deepEqual(doublons, [], `outil(s) listé(s) plusieurs fois : ${doublons.join(', ')}`)
})

test('chaque capacité a un vrai titre et une vraie description, en français courant', () => {
  for (const group of CAPABILITIES) {
    assert.ok(group.title.trim().length > 0, 'un groupe sans titre')
    assert.ok(group.summary.trim().length > 10, `groupe sans résumé lisible : ${group.title}`)
    assert.ok(group.items.length > 0, `groupe vide : ${group.title}`)
    for (const item of group.items) {
      assert.ok(item.title.trim().length > 0, `capacité sans titre dans ${group.title}`)
      assert.ok(item.description.trim().length > 10, `description trop courte pour « ${item.title} »`)
      // Un identifiant technique qui fuiterait dans le texte affiché à Léo (ex: "click_mouse") serait
      // exactement le genre de détail écrit pour Ollama, pas pour lui — même souci que les messages
      // d'erreur qui ne doivent jamais montrer du jargon interne.
      assert.doesNotMatch(item.description, /[a-z]+_[a-z]+/, `« ${item.title} » contient un identifiant technique (snake_case) dans sa description`)
    }
  }
})

test("chaque capacité utilisable à la demande donne la phrase exacte à dire", () => {
  // C'est le cœur du retour de Léo (étape 111) : "on comprend pas trop". Une capacité qui correspond à un
  // outil se déclenche en le DEMANDANT — sans exemple, il faut deviner la formulation. Les entrées sans
  // outil (mode Code, Chat) décrivent un écran où l'on va, pas une phrase à prononcer : elles en sont
  // dispensées, comme les limitations.
  for (const group of CAPABILITIES) {
    for (const item of group.items) {
      if (!item.toolNames || item.limitation) continue
      assert.ok(item.example, `« ${item.title} » correspond à un outil mais n'a aucune phrase d'exemple`)
      assert.ok(item.example.trim().length > 5, `phrase d'exemple trop courte pour « ${item.title} »`)
    }
  }
})

test("aucune phrase d'exemple ne porte ses propres guillemets", () => {
  // Le rendu (OptionsMenu.tsx) encadre déjà chaque exemple de « » : un exemple qui en contient lui-même
  // donnait « écris « bonjour... » » à l'écran. Repéré sur une capture du rendu réel, jamais en relecture.
  for (const group of CAPABILITIES) {
    for (const item of group.items) {
      if (!item.example) continue
      assert.doesNotMatch(item.example, /[«»"]/, `guillemets en trop dans l'exemple de « ${item.title} »`)
    }
  }
})

test('une limitation ne se fait jamais passer pour une capacité', () => {
  // "Les messages sont hors de portée" ne doit ni porter d'outil ni proposer une phrase à dire : ce serait
  // exactement la famille des fausses confirmations déjà corrigée plusieurs fois dans ce projet.
  for (const group of CAPABILITIES) {
    for (const item of group.items) {
      if (!item.limitation) continue
      assert.equal(item.toolNames, undefined, `la limitation « ${item.title} » prétend correspondre à un outil`)
      assert.equal(item.example, undefined, `la limitation « ${item.title} » propose une phrase à dire`)
    }
  }
})
