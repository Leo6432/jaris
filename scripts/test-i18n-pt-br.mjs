import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * La traduction portugaise de Jaris est celle du BRÉSIL (shared/i18n/languages.ts : pt-BR, dates et nombres à la
 * brésilienne), avec « você ». Jusqu'à la version 0.49.1, elle mélangeait les deux portugais d'un écran à l'autre :
 * « telemóvel » (4 fois) à côté de « celular », « ficheiro » (12 fois) à côté de « arquivo », « ecrã » à côté de
 * « tela », le tutoiement du Portugal (« teu », « podes », « clica ») à côté de « você »/« seu ». Ici, seuls des mots
 * SANS ambiguïté : propres au Portugal, ou à la 2e personne du singulier.
 */
const { LANGUAGES } = loadTsModule('shared/i18n/languages.ts')
const pt = JSON.parse(readFileSync(new URL('../shared/i18n/locales/pt.json', import.meta.url), 'utf8'))

// Un mot entier : ni lettre ni chiffre autour (« TI2V » n'est pas « ti »).
const word = (list) => new RegExp(`(?<![\\p{L}\\p{N}-])(?:${list.join('|')})(?![\\p{L}\\p{N}])`, 'iu')
const RULES = [
  { why: 'mot du Portugal (Brésil : celular, arquivo, tela, mouse, baixar, conexão…)', pattern: word(['telemóvel', 'telemóveis', 'ficheiro', 'ficheiros', 'ecrã', 'ecrãs', 'rato', 'utilizador', 'utilizadores', 'transferir', 'descarregar', 'equipa', 'equipas', 'registo', 'contacto', 'contactos', 'ligação', 'ligações', 'encriptada', 'anónimo', 'anónimos', 'cronómetro', 'pré-visualização', 'definições', 'placa gráfica', 'detetada', 'todo o lado', 'por agora', 'iniciar sessão', 'até ao', 'em baixo']) },
  { why: 'tutoiement du Portugal (Brésil : você, seu, pode, quer, tem)', pattern: word(['teu', 'tua', 'teus', 'tuas', 'ti', 'contigo', 'podes', 'queres', 'tens', 'estás', 'precisas', 'consegues', 'votas', 'quiseres', 'terminares']) },
  { why: '« a + infinitif » du Portugal (Brésil : gérondif, « carregando »)', pattern: /(?<![\p{L}])(?:está|estão|estou|continua) a [\p{L}]+(?:ar|er|ir)(?![\p{L}])|^A [\p{L}]+(?:ar|er|ir)…$/iu },
  { why: 'guillemets du Portugal (Brésil : “ ”)', pattern: /[«»]/u }
]

test('la langue portugaise de Jaris est bien celle du Brésil', () => {
  assert.equal(LANGUAGES.find((language) => language.code === 'pt').locale, 'pt-BR')
})

for (const { why, pattern } of RULES) {
  test(`portugais du Brésil partout : ${why}`, () => {
    const found = Object.entries(pt)
      .filter(([, text]) => pattern.test(text))
      .map(([key, text]) => `${key} : « ${text.match(pattern)[0]} » dans « ${text} »`)
    assert.deepEqual(found, [])
  })
}
