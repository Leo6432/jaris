import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

/**
 * Étape 234 (bêta de Jaris) : trois phrases envoyaient vers des onglets d'Options disparus depuis leur fusion
 * (étape 115) — « Options → Activation », « Options → Mise à jour », et la mise à jour d'Ollama annoncée dans
 * « Modèles » alors qu'elle est dans Général. Envoyer quelqu'un vers un onglet qui n'existe pas, c'est le laisser
 * chercher sans fin. Ce test relit tout le texte affiché (hors commentaires) et vérifie chaque « Options → X ».
 */
const root = new URL('../', import.meta.url).pathname
const files = (dir) =>
  readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name)
    return statSync(join(root, path)).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : []
  })

test('chaque « Options → … » montré à l’utilisateur désigne un onglet qui existe', () => {
  const menu = readFileSync(join(root, 'src/components/OptionsMenu.tsx'), 'utf8')
  const tabs = new Set([...menu.matchAll(/setTab\('\w+'\)\}>\s*([^<{]+?)\s*<\/button>/g)].map((m) => m[1].trim()))
  assert.ok(tabs.has('Voix') && tabs.has('Général'), `onglets lus : ${[...tabs].join(', ')}`)
  const wrong = []
  for (const file of [...files('src'), ...files('electron')]) {
    const lines = readFileSync(join(root, file), 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line)) return
      const labels = [...tabs, 'Ce que Jaris sait faire']
      for (const m of line.matchAll(/Options → /g)) {
        const after = line.slice(m.index + m[0].length)
        if (!labels.some((label) => after.startsWith(label))) wrong.push(`${file}:${i + 1} « Options → ${after.slice(0, 20)} »`)
      }
    })
  }
  assert.deepEqual(wrong, [])
})

test('aucun texte affiché ne renvoie vers un README (aucun n’est livré avec Jaris)', () => {
  const offenders = [...files('src'), ...files('electron')].filter((file) =>
    readFileSync(join(root, file), 'utf8')
      .split('\n')
      .some((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line) && /README/.test(line))
  )
  assert.deepEqual(offenders, [])
})
