import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

/**
 * Garde `dialogOpen` (étape 73, élargie à l'étape 93).
 *
 * La fenêtre de réglages se replie en widget dès qu'elle perd le focus (`win.on('blur')`, main.ts). Un
 * dialogue natif de Jaris prend lui aussi le focus OS sans que l'utilisateur ait quitté l'application : le
 * drapeau `dialogOpen` existe uniquement pour distinguer ces deux cas. Tout dialogue qui l'oublie replie
 * Jaris en plein milieu d'une sélection de fichier — exactement ce qu'a vécu Léo avec le bouton "joindre une
 * image", qui ouvrait son dialogue côté RENDERER (`<input type="file">`), donc hors de portée du drapeau.
 *
 * Ce test est STRUCTUREL : il vérifie la forme du code (chaque dialogue natif est encadré, aucun sélecteur
 * de fichier ne repart côté renderer), pas le comportement réel de Windows — invérifiable ici, faute
 * d'Electron et de Windows dans cet environnement. Il protège contre la reprise du même oubli dans un
 * nouveau chemin, qui est le piège déjà rencontré deux fois dans ce projet (le check WSL placé dans une
 * branche jamais atteinte, la touche "+" gatée d'un seul côté sur deux).
 */
const projectRoot = new URL('..', import.meta.url)

/**
 * Les commentaires de ce dépôt CITENT abondamment le code qu'ils expliquent (`dialog.showOpenDialog`,
 * `<input type="file">`...) : les scanner comme du code donnerait des échecs sur des explications
 * parfaitement justes. Le compilateur TypeScript fait ce tri correctement, y compris pour un `//` à
 * l'intérieur d'une chaîne (une URL, par exemple), ce qu'une simple expression régulière raterait.
 */
function sourceWithoutComments(relativePath, jsx = ts.JsxEmit.None) {
  return ts.transpileModule(readFileSync(new URL(relativePath, projectRoot), 'utf8'), {
    compilerOptions: { removeComments: true, jsx, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
}

function context(source, index) {
  return source.slice(Math.max(0, index - 120), index + 60).trim()
}

const mainSource = sourceWithoutComments('electron/main.ts')

test('chaque dialogue natif du main process est ouvert pendant que dialogOpen vaut true', () => {
  const events = [...mainSource.matchAll(/(let )?dialogOpen = (true|false)|dialog\.showOpenDialog/g)]
  const dialogs = events.filter((event) => event[0] === 'dialog.showOpenDialog')
  assert.ok(dialogs.length > 0, 'aucun dialog.showOpenDialog trouvé : ce test ne vérifie plus rien')

  let guarded = false
  for (const event of events) {
    // La déclaration initiale (`let dialogOpen = false`) n'est pas la fin d'un dialogue : l'ignorer.
    if (event[1]) continue
    if (event[2] === 'true') guarded = true
    else if (event[2] === 'false') guarded = false
    else assert.ok(guarded, `dialog.showOpenDialog non encadré par dialogOpen :\n${context(mainSource, event.index)}`)
  }
  assert.equal(guarded, false, 'un dialogOpen = true reste sans dialogOpen = false correspondant')
})

test('le drapeau est toujours retiré dans un finally, jamais sur le seul chemin de succès', () => {
  // Sans finally, un dialogue qui échoue laisse dialogOpen bloqué à true pour TOUTE la session : la fenêtre
  // de réglages ne se replierait alors plus jamais en widget en changeant d'application.
  const releases = [...mainSource.matchAll(/(let )?dialogOpen = false/g)].filter((release) => !release[1])
  assert.ok(releases.length > 0)
  for (const release of releases) {
    const before = mainSource.slice(Math.max(0, release.index - 300), release.index)
    assert.match(before, /\bfinally\b\s*{[^{}]*$/, `dialogOpen = false hors d'un finally :\n${context(mainSource, release.index)}`)
  }
})

test('le repli en widget sur perte de focus consulte bien ce drapeau', () => {
  const blurHandler = /win\.on\(['"]blur['"],[\s\S]{0,400}?\}\);/.exec(mainSource)
  assert.ok(blurHandler, "handler 'blur' introuvable dans main.ts")
  assert.match(blurHandler[0], /dialogOpen/)
})

test("aucun sélecteur de fichier ne repasse côté renderer, où le drapeau ne peut rien", () => {
  // C'est la cause exacte du bug signalé par Léo : un <input type="file"> ouvre son dialogue depuis
  // Chromium, que le main process ne voit jamais passer.
  for (const file of globSync(new URL('src/**/*.tsx', projectRoot).pathname)) {
    const source = sourceWithoutComments(file.replace(projectRoot.pathname, ''), ts.JsxEmit.Preserve)
    assert.doesNotMatch(source, /type="file"/, `${file} ouvre un sélecteur de fichier côté renderer`)
  }
})
