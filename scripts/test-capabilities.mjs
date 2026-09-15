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
  // Si ce test échoue, le motif regex ci-dessus a raté quelque chose — pas une preuve que tools.ts est vide.
  assert.ok(toolNamesInSource.length >= 16, `seulement ${toolNamesInSource.length} outil(s) trouvé(s) dans tools.ts : le motif a-t-il changé ?`)
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
