import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

/**
 * Gardes sur le handler `blur` de la fenêtre principale (main.ts) — deux, ajoutés à la suite l'un de
 * l'autre pour deux raisons différentes de perdre le focus qui n'ont rien à voir avec "une autre appli
 * prend la main" (le seul cas que ce handler était censé couvrir à l'origine, étape 73).
 *
 * 1. `quitting` — signalé par Léo : "je clique sur mis a jour et ça fait 100 pourcent et apres ça fait
 *    rien". Le téléchargement de l'installeur (appUpdater.ts, déjà couvert par test-app-updater.mjs) se
 *    déroule bien jusqu'au bout — mais Jaris ne fermait jamais, et l'installeur ne se lançait donc jamais
 *    non plus.
 *    Cause trouvée en relisant TOUTE la séquence de fermeture, pas seulement appUpdater.ts : fermer une
 *    fenêtre lui fait perdre le focus juste AVANT de se fermer pour de bon — `app.quit()` (mise à jour,
 *    croix de la fenêtre, "Quitter" du menu, arrêt GPU) déclenche donc un vrai évènement 'blur' sur la
 *    fenêtre principale EN PLEIN MILIEU de sa propre fermeture, avant même que 'close' n'ait fini de
 *    s'exécuter. Sans ce garde, 'blur' réaffichait donc le widget (ou le RECRÉAIT, si `app.quit()` avait
 *    déjà eu le temps de le détruire) juste avant que la fenêtre principale ne finisse de disparaître, et
 *    Electron ne quitte jamais tant qu'il reste une fenêtre ouverte : `will-quit` (qui lance l'installeur)
 *    ne se déclenchait donc jamais — aucune erreur visible, Jaris restait juste plantée là.
 * 2. `optionsOpen` — signalé par Léo juste après : "quand on est dans les option, jaris ne doit pas partir
 *    en widget quand on part". La page Options (OptionsMenu.tsx) vit dans fullWindow, pas une fenêtre à
 *    part : cliquer sur une autre appli en pleine configuration perdait le focus de fullWindow tout autant
 *    qu'un vrai changement d'application, et repliait Jaris en widget en plein milieu — la page Options a
 *    déjà son propre bouton "Fermer" pour signaler qu'on a vraiment terminé, le repli en widget en plus
 *    était un mauvais signal.
 *
 * Test STRUCTUREL (pas de vraie fenêtre Electron ici, invérifiable faute de Windows dans cet
 * environnement) : même famille que test-native-dialog-guard.mjs, qui vérifie déjà que ce même handler
 * 'blur' consulte `dialogOpen`, pour une troisième raison différente (un dialogue natif, pas une fermeture
 * en cours ni la page Options).
 */
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

function sourceWithoutComments(relativePath, jsx = ts.JsxEmit.None) {
  return ts.transpileModule(readFileSync(join(projectRoot, relativePath), 'utf8'), {
    compilerOptions: { removeComments: true, jsx, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
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

test("le repli en widget sur perte de focus ('blur') ne se déclenche jamais pendant que la page Options est ouverte", () => {
  const blurHandler = /win\.on\(['"]blur['"],[\s\S]{0,400}?\}\);/.exec(mainSource)
  assert.ok(blurHandler, "handler 'blur' introuvable dans main.ts")
  assert.match(
    blurHandler[0],
    /optionsOpen/,
    "le handler 'blur' ne consulte pas `optionsOpen` : perdre le focus en pleine configuration (Options) " +
      'repliait Jaris en widget, alors que la page Options a déjà son propre bouton pour se fermer'
  )
})

test('`optionsOpen` est bien mis à jour par le canal IPC dédié, pas laissé figé à sa valeur initiale', () => {
  assert.match(
    mainSource,
    /ipcMain\.on\(IPC_CHANNELS\.setOptionsOpen,\s*\(_event,\s*open[^)]*\)\s*=>\s*\{\s*optionsOpen = open/,
    'aucun handler `ipcMain.on(IPC_CHANNELS.setOptionsOpen, ...)` trouvé qui affecte `optionsOpen`'
  )
})

test('OptionsMenu.tsx prévient bien main.ts à chaque ouverture/fermeture de la page Options', () => {
  const optionsMenuSource = sourceWithoutComments('src/components/OptionsMenu.tsx', ts.JsxEmit.Preserve)
  assert.match(
    optionsMenuSource,
    /window\.jaris\.setOptionsOpen\(/,
    "OptionsMenu.tsx n'appelle jamais window.jaris.setOptionsOpen : main.ts ne peut alors jamais savoir " +
      'que la page Options est ouverte, et `optionsOpen` reste figé à `false` pour toute la session'
  )
})

test("quitter Jaris arrête aussi les deux programmes Python de la voix (étape 153)", () => {
  // app.quit() (mise à jour, croix, « Quitter ») ne déclenche pas 'window-all-closed' : sans cet arrêt dans
  // 'before-quit', l'écoute et la synthèse vocale survivaient à Jaris, micro ouvert.
  const source = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const handler = source.match(/app\.on\('before-quit', \(\) => \{([\s\S]*?)\n\}\)/)
  assert.ok(handler, "gestionnaire 'before-quit' introuvable")
  assert.match(handler[1], /pipeline\?\.stop\(\)/)
  assert.match(handler[1], /ttsClient\.stop\(\)/)
})
