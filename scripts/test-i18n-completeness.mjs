import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Les 23 traductions de Jaris face au catalogue source français (shared/i18n/fr.ts) — demande de Léo : « tout doit
 * être traduit ». Une clé manquante retomberait en silence sur le français, une {variable} oubliée afficherait un
 * trou, une catégorie de pluriel absente afficherait la mauvaise forme (« 21 fichiers » en russe se dit autrement
 * que « 5 fichiers ») : rien de tout ça ne lève d'erreur à l'écran, d'où ce test.
 */
const { fr } = loadTsModule('shared/i18n/fr.ts')
const { LANGUAGES } = loadTsModule('shared/i18n/languages.ts')
const CODES = LANGUAGES.map((language) => language.code).filter((code) => code !== 'fr')

const locales = Object.fromEntries(
  CODES.map((code) => [code, JSON.parse(readFileSync(new URL(`../shared/i18n/locales/${code}.json`, import.meta.url), 'utf8'))])
)

const PLURAL_SUFFIX = /_(zero|one|two|few|many|other)$/
const pluralBases = new Set(Object.keys(fr).filter((key) => key.endsWith('_other')).map((key) => key.replace(/_other$/, '')))
const simpleKeys = Object.keys(fr).filter((key) => !(PLURAL_SUFFIX.test(key) && pluralBases.has(key.replace(PLURAL_SUFFIX, ''))))

const placeholders = (text) => new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))
const sorted = (set) => [...set].sort()

/** Les catégories que des NOMBRES ENTIERS atteignent dans cette langue (« many » ne sert qu'aux décimales en tchèque). */
function integerCategories(locale) {
  const rules = new Intl.PluralRules(locale)
  const seen = new Map()
  for (let n = 0; n <= 1000; n++) {
    const category = rules.select(n)
    if (!seen.has(category)) seen.set(category, [])
    seen.get(category).push(n)
  }
  return seen
}

test('le catalogue français a bien des clés simples et des pluriels (sinon le test ne vérifierait rien)', () => {
  assert.ok(simpleKeys.length > 1000, `seulement ${simpleKeys.length} clés simples`)
  assert.ok(pluralBases.size >= 20, `seulement ${pluralBases.size} pluriels`)
  assert.equal(CODES.length, 23)
})

for (const { code, locale } of LANGUAGES.filter((language) => language.code !== 'fr')) {
  const messages = locales[code]
  const categories = integerCategories(locale)
  // « other » toujours, même quand aucun entier n'y tombe (russe, polonais) : c'est le repli de tn() et la forme des
  // décimales.
  const expectedPluralCategories = sorted(new Set([...categories.keys(), 'other']))
  // « one » qui ne couvre que 0 et 1 (comme en français) peut s'écrire sans {count} (« Nouveau modèle disponible ») ;
  // ailleurs (russe : 1, 21, 31…), une phrase sans le nombre serait fausse pour 21.
  const oneIsOnlyOne = (categories.get('one') ?? []).every((n) => n <= 1)

  test(`${code} : aucune clé manquante, aucune en trop`, () => {
    const expected = new Set(simpleKeys)
    for (const base of pluralBases) for (const category of expectedPluralCategories) expected.add(`${base}_${category}`)
    const missing = [...expected].filter((key) => !(key in messages))
    const extra = Object.keys(messages).filter((key) => !expected.has(key))
    assert.deepEqual(missing, [], `clés manquantes en ${code}`)
    assert.deepEqual(extra, [], `clés en trop en ${code}`)
  })

  test(`${code} : aucun texte vide, mêmes espaces de bord que le français`, () => {
    for (const key of simpleKeys) {
      const text = messages[key]
      assert.equal(typeof text, 'string', `${code}/${key}`)
      if (fr[key].trim()) assert.ok(text.trim(), `${code}/${key} est vide`)
      const edges = (value) => [value.length - value.trimStart().length, value.length - value.trimEnd().length]
      assert.deepEqual(edges(text), edges(fr[key]), `${code}/${key} : espaces de bord différents (« ${text} »)`)
    }
  })

  test(`${code} : mêmes {variables} que le français`, () => {
    for (const key of simpleKeys) {
      assert.deepEqual(sorted(placeholders(messages[key])), sorted(placeholders(fr[key])), `${code}/${key} : « ${messages[key]} »`)
    }
    for (const base of pluralBases) {
      const reference = placeholders(fr[`${base}_other`])
      for (const category of expectedPluralCategories) {
        const found = placeholders(messages[`${base}_${category}`])
        if (category === 'one' && oneIsOnlyOne) {
          // Forme du seul « 1 » : le nombre peut être sous-entendu, les autres variables jamais.
          for (const name of reference) if (name !== 'count') assert.ok(found.has(name), `${code}/${base}_one : {${name}} manque`)
          for (const name of found) assert.ok(reference.has(name), `${code}/${base}_one : {${name}} en trop`)
        } else {
          assert.deepEqual(sorted(found), sorted(reference), `${code}/${base}_${category} : « ${messages[`${base}_${category}`]} »`)
        }
      }
    }
  })

  test(`${code} : réellement traduit (pas une copie du français)`, () => {
    // Des libellés identiques sont normaux (« VRAM », « {s} s », « Chat ») ; au-delà d'un quart, c'est une copie.
    const same = simpleKeys.filter((key) => messages[key] === fr[key])
    assert.ok(same.length < simpleKeys.length * 0.25, `${same.length} textes identiques au français en ${code}`)
  })
}
