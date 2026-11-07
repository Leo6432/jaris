import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Aucune phrase du catalogue (shared/i18n/fr.ts, et donc les 23 traductions) ne reste sans usage. Une clé morte se
 * traduit quand même 24 fois à chaque relecture, et finit par être prise pour la bonne (jusqu'à la version 0.49.1 :
 * « models.all », « vision.httpError », « ollama.noStreamBody », que plus rien n'affichait).
 *
 * Une clé compte comme utilisée quand son nom figure entre guillemets dans le code de Jaris (electron/, shared/, src/,
 * phone/) — pour un pluriel, son nom sans « _one »/« _other ». Seules les familles dont le nom est FABRIQUÉ par le code
 * sont admises sans cela, et chacune doit l'être réellement (sinon la famille entière serait morte).
 */
const root = fileURLToPath(new URL('..', import.meta.url))
const { fr } = loadTsModule('shared/i18n/fr.ts')

/** Familles de clés construites par le code, avec la forme exacte qui les fabrique. */
const BUILT_FAMILIES = [
  { prefix: 'mcp.catalog.', builtBy: 'mcp.catalog.${' },
  { prefix: 'mcp.category.', builtBy: 'mcp.category.${' },
  { prefix: 'github.lost.', builtBy: 'github.lost.${' },
  { prefix: 'duel.suggest.', builtBy: 'duel.suggest.' }
]

function sourceFiles(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'locales' || name.startsWith('.')) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (['.ts', '.tsx', '.js', '.mjs', '.html'].includes(extname(name))) out.push(path)
  }
  return out
}

const catalogPath = join(root, 'shared', 'i18n', 'fr.ts')
const code = ['electron', 'shared', 'src', 'phone']
  .flatMap((dir) => sourceFiles(join(root, dir)))
  .filter((path) => path !== catalogPath)
  .map((path) => readFileSync(path, 'utf8'))
  .join('\n')

const quoted = (name) => code.includes(`'${name}'`) || code.includes(`"${name}"`) || code.includes(`\`${name}\``)
const pluralBase = (key) => key.replace(/_(zero|one|two|few|many|other)$/, '')

test('chaque famille de clés fabriquées l’est vraiment par le code', () => {
  for (const { prefix, builtBy } of BUILT_FAMILIES) assert.ok(code.includes(builtBy), `plus rien ne fabrique les clés « ${prefix}… »`)
})

test('aucune clé du catalogue sans usage dans le code de Jaris', () => {
  const unused = Object.keys(fr).filter(
    (key) => !quoted(key) && !quoted(pluralBase(key)) && !BUILT_FAMILIES.some(({ prefix }) => key.startsWith(prefix))
  )
  assert.deepEqual(unused, [], 'clés à supprimer des 24 catalogues (ou à brancher là où elles devaient servir)')
})

test('les trois clés mortes de la version 0.49.1 ne reviennent pas', () => {
  for (const key of ['models.all', 'vision.httpError', 'ollama.noStreamBody']) assert.equal(key in fr, false, key)
})
