import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 234 (bêta de Jaris) : trois phrases envoyaient vers des onglets d'Options disparus depuis leur fusion
 * (étape 115) — « Options → Activation », « Options → Mise à jour », et la mise à jour d'Ollama annoncée dans
 * « Modèles » alors qu'elle est dans Général. Envoyer quelqu'un vers un onglet qui n'existe pas, c'est le laisser
 * chercher sans fin. Ce test relit tout le texte affiché (hors commentaires) et vérifie chaque « Options → X ».
 */
// fileURLToPath, pas `.pathname` : sous Windows (la CI), `.pathname` donne « /D:/... » et le chemin devient « D:\\D:\\... ».
const root = fileURLToPath(new URL('../', import.meta.url))
const files = (dir) =>
  readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name)
    return statSync(join(root, path)).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : []
  })

/**
 * Étape 293 (24 langues) : les phrases « Options → Modèles » vivent maintenant dans les catalogues, une par langue.
 * Le risque change de forme : un traducteur qui écrit « Optionen → Modell » alors que l'onglet s'appelle
 * « Modelle » envoie l'utilisateur vers un onglet introuvable — exactement le défaut de l'étape 234, langue par
 * langue. Chaque catalogue est donc vérifié contre SES PROPRES noms d'onglets.
 */
const { fr } = loadTsModule('shared/i18n/fr.ts')
const { LANGUAGES } = loadTsModule('shared/i18n/languages.ts')
const WINDOWS_SETTINGS_KEYS = new Set(['options.startup.blocked', 'options.micTest.silent'])
const catalogs = [
  ['fr', fr],
  ...LANGUAGES.filter((l) => l.code !== 'fr').map((l) => [l.code, JSON.parse(readFileSync(join(root, `shared/i18n/locales/${l.code}.json`), 'utf8'))])
]

test('les onglets d’Options affichent bien les libellés du catalogue', () => {
  const menu = readFileSync(join(root, 'src/components/OptionsMenu.tsx'), 'utf8')
  const tabKeys = [...menu.matchAll(/setTab\('\w+'\)\}>\s*\{t\('([\w.]+)'\)\}\s*<\/button>/g)].map((m) => m[1])
  assert.deepEqual(tabKeys.sort(), ['options.tab.capabilities', 'options.tab.general', 'options.tab.models', 'options.tab.phone', 'options.tab.voice'])
})

for (const [code, messages] of catalogs) {
  test(`${code} : chaque « Options → … » désigne un onglet qui existe dans cette langue`, () => {
    const prefix = `${messages['options.title']} → `
    const labels = ['options.tab.capabilities', 'options.tab.general', 'options.tab.models', 'options.tab.phone', 'options.tab.voice'].map((key) => messages[key])
    let seen = 0
    const wrong = []
    for (const [key, text] of Object.entries(messages)) {
      // Chemins dans les Paramètres de WINDOWS, pas dans les Options de Jaris — en danois, finnois ou russe, les deux
      // portent le même nom (« Indstillinger », « Asetukset », « Параметры »).
      if (WINDOWS_SETTINGS_KEYS.has(key)) continue
      for (const m of text.matchAll(new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))) {
        seen++
        const after = text.slice(m.index + prefix.length)
        if (!labels.some((label) => after.startsWith(label))) wrong.push(`${key} « ${prefix}${after.slice(0, 24)} »`)
      }
    }
    assert.ok(seen >= 8, `seulement ${seen} renvois vers Options trouvés en ${code} (attendu : au moins 8)`)
    assert.deepEqual(wrong, [])
  })
}

test('aucune phrase « Options → … » écrite en dur dans le code (elles passent toutes par le catalogue)', () => {
  const wrong = []
  for (const file of [...files('src'), ...files('electron')]) {
    readFileSync(join(root, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (!/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line) && /Options → /.test(line)) wrong.push(`${file}:${i + 1}`)
      })
  }
  assert.deepEqual(wrong, [])
})

// Seule exception, étape 306 : le README.md que Jaris CRÉE dans le dépôt GitHub de Léo quand « tout supprimer »
// laisserait la branche vide (GitHub la refuse). Ce n'est pas un renvoi vers une documentation de Jaris.
const KEPT_README_LINE = /^\s*stage\(session, 'README\.md', /
test('aucun texte affiché ne renvoie vers un README (aucun n’est livré avec Jaris)', () => {
  const offenders = [...files('src'), ...files('electron')].filter((file) =>
    readFileSync(join(root, file), 'utf8')
      .split('\n')
      .some(
        (line) =>
          !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line) &&
          /README/.test(line) &&
          !(file.endsWith('githubSession.ts') && KEPT_README_LINE.test(line))
      )
  )
  assert.deepEqual(offenders, [])
})
