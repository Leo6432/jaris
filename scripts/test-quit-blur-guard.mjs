import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

/**
 * Garde `quitting` sur le handler `blur` de la fenêtre principale (main.ts).
 *
 * Signalé par Léo : "je clique sur mis a jour et ça fait 100 pourcent et apres ça fait rien". Le
 * téléchargement de l'installeur (appUpdater.ts, déjà couvert par test-app-updater.mjs) se déroule bien
 * jusqu'au bout — mais Jaris ne fermait jamais, et l'installeur ne se lançait donc jamais non plus.
 *
 * Cause trouvée en relisant TOUTE la séquence de fermeture, pas seulement appUpdater.ts : fermer une
 * fenêtre lui fait perdre le focus juste AVANT de se fermer pour de bon — `app.quit()` (mise à jour, croix
 * de la fenêtre, "Quitter" du menu, arrêt GPU) déclenche donc un vrai évènement 'blur' sur la fenêtre
 * principale EN PLEIN MILIEU de sa propre fermeture, avant même que 'close' n'ait fini de s'exécuter. Le
 * handler 'blur' (étape 73 : replier Jaris en widget dès qu'une autre appli prend le focus) ne consultait
 * pas le drapeau `quitting` — il réaffichait donc le widget (ou le RECRÉAIT, si `app.quit()` avait déjà eu
 * le temps de le détruire) juste avant que la fenêtre principale ne finisse de disparaître. Electron ne
 * quitte jamais tant qu'il reste une fenêtre ouverte, donc `will-quit` (l'évènement qui lance l'installeur,
 * voir appUpdater.ts) ne se déclenchait jamais. Aucune erreur visible nulle part : Jaris restait juste
 * plantée là, exactement le "ça fait rien" de Léo, après un téléchargement pourtant complet et affiché à
 * 100 %.
 *
 * Test STRUCTUREL (pas de vraie fenêtre Electron ici, invérifiable faute de Windows dans cet
 * environnement) : même famille que test-native-dialog-guard.mjs, qui vérifie déjà que ce même handler
 * 'blur' consulte `dialogOpen`, pour une raison différente (un dialogue natif, pas une fermeture en cours).
 */
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

function sourceWithoutComments(relativePath) {
  return ts.transpileModule(readFileSync(join(projectRoot, relativePath), 'utf8'), {
    compilerOptions: { removeComments: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
}

const mainSource = sourceWithoutComments('electron/main.ts')

test("le repli en widget sur perte de focus ('blur') ne se déclenche jamais pendant une fermeture volontaire", () => {
  const blurHandler = /win\.on\(['"]blur['"],[\s\S]{0,400}?\}\);/.exec(mainSource)
  assert.ok(blurHandler, "handler 'blur' introuvable dans main.ts")
  assert.match(
    blurHandler[0],
    /quitting/,
    "le handler 'blur' ne consulte pas `quitting` : un blur déclenché par app.quit() en train de fermer " +
      'la fenêtre recréerait le widget et empêcherait Jaris de jamais quitter (ex: mise à jour bloquée à 100 %)'
  )
})
