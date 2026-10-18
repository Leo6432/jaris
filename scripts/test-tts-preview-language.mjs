import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'
import { i18nModule } from './i18n-test-module.mjs'

/**
 * Aperçu d'une voix (Options → Voix) dans la langue de Jaris. Jusqu'à la version 0.34.31, la phrase d'exemple était
 * écrite en dur en français, alors que la synthèse reçoit la langue de Jaris (ttsClient envoie `lang`) : un Allemand
 * entendait « Bonjour, je suis Jaris… » lu avec la prononciation allemande. Et « Jaris » devenait « Jarisse » dans
 * toutes les langues, une astuce de prononciation propre au français (le « s » final muet).
 *
 * Le VRAI tts.ts, avec une fausse voix qui note ce qu'on lui fait lire.
 */
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const localesDir = join(projectRoot, 'shared/i18n/locales')
const catalog = (code) => JSON.parse(readFileSync(join(localesDir, `${code}.json`), 'utf8'))

function loadTts() {
  const sent = []
  const tts = loadTsModule('electron/services/tts.ts', {
    'fs/promises': { readFile: async () => Buffer.from('RIFF'), rm: async () => {} },
    '../config': { config: { tts: { voice: 'M1' } } },
    './profileStore': { getProfile: async () => null },
    './ttsClient': {
      ttsClient: {
        synthesize: async (text, voice) => {
          sent.push({ text, voice })
          return 'apercu.wav'
        }
      }
    }
  })
  return { tts, sent }
}

/** Change la langue du traducteur partagé le temps de `run`, puis revient au français (comportement par défaut). */
async function inLanguage(code, run) {
  i18nModule.setLanguage(code, code === 'fr' ? undefined : catalog(code))
  try {
    await run()
  } finally {
    i18nModule.setLanguage('fr')
  }
}

test('en allemand, l’aperçu lit une phrase ALLEMANDE, sans « Jarisse »', async () => {
  const { tts, sent } = loadTts()
  await inLanguage('de', async () => {
    await tts.previewVoice('F2')
  })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].voice, 'F2')
  assert.equal(sent[0].text, catalog('de')['options.voice.previewSentence'])
  assert.doesNotMatch(sent[0].text, /Bonjour|assistant vocal|aujourd/, 'plus aucune phrase française lue en allemand')
  assert.doesNotMatch(sent[0].text, /Jarisse/, 'l’astuce de prononciation française ne vaut pas en allemand')
})

test('en français, la phrase française garde « Jarisse » (le « s » final muet)', async () => {
  const { tts, sent } = loadTts()
  await tts.previewVoice('M1')
  assert.match(sent[0].text, /^Bonjour, je suis Jarisse, ton assistant vocal/)
})

test('les réponses lues à voix haute aussi : « Jarisse » seulement en français', async () => {
  const { tts, sent } = loadTts()
  await tts.synthesizeSpeech('Jaris a terminé.')
  await inLanguage('en', async () => {
    await tts.synthesizeSpeech('Jaris is done.')
  })
  assert.deepEqual(
    sent.map((s) => s.text),
    ['Jarisse a terminé.', 'Jaris is done.']
  )
})

test('chacune des 23 autres langues lit SA propre phrase d’aperçu, jamais la française', async () => {
  const codes = readdirSync(localesDir).map((name) => name.replace(/\.json$/, ''))
  assert.equal(codes.length, 23)
  for (const code of codes) {
    const { tts, sent } = loadTts()
    await inLanguage(code, async () => {
      await tts.previewVoice('M1')
    })
    const expected = catalog(code)['options.voice.previewSentence']
    assert.equal(sent[0].text, expected, code)
    assert.doesNotMatch(sent[0].text, /Bonjour|Jarisse/, code)
  }
})
