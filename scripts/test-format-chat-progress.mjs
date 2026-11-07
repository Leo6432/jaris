import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'
import { i18nModule } from './i18n-test-module.mjs'

/**
 * src/lib/formatChatProgress.ts : la ligne affichée dans le Chat et le widget pendant qu'une réponse se prépare, tirée
 * du journal de Jaris (onLog). Jusqu'à la version 0.49.1, une liste d'EXCLUSION terminée par « afficher la ligne telle
 * quelle » : toute ligne de journal inconnue (en français, technique) s'affichait — « Outils MCP proposés : … » à
 * chaque demande dès qu'un serveur MCP était actif, « VRAM utilisable actuelle… », « Modèle X pas installé… ».
 * Désormais une liste d'AUTORISATION : `null` par défaut, comme phoneStatusFromLog (phoneAccess.ts).
 */
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const catalog = (code) => JSON.parse(readFileSync(join(projectRoot, `shared/i18n/locales/${code}.json`), 'utf8'))
const { t } = i18nModule

const { formatChatProgress } = loadTsModule('src/lib/formatChatProgress.ts', {
  '../../shared/imageGallery': loadTsModule('shared/imageGallery.ts'),
  '../../shared/voiceActivity': loadTsModule('shared/voiceActivity.ts')
})

/** Lignes RÉELLES du journal (recopiées des onLog d'assistant.ts, computerUse.ts, voicePipeline.ts…). */
const TECHNICAL_LINES = [
  'Outils MCP proposés : github__create_issue, github__list_repos',
  'Outils MCP chargés à la demande du modèle : notion__search',
  'Outils MCP indisponibles : spawn npx ENOENT',
  'VRAM utilisable actuelle : 3.2 Go (insuffisant pour qwen3:14b) : repli sur qwen3:4b.',
  'Modèle qwen3:14b pas installé : repli sur qwen3:8b.',
  'Service nommé (Notion) : pilotage de l\'écran non proposé.',
  'Service nommé mais pas prêt : Notion ne répond pas',
  '8 actions faites : dernière réponse demandée, sans outil.',
  'Notion nommé et connecté, mais aucun de ses outils appelé : relance corrective d\'un tour.',
  'Modèle choisi : qwen3:8b (réflexion : non)',
  'Résultat de l\'outil : {"ok":true}',
  'Outil appelé : remember({"fact":"Léo aime le thé"})',
  'Outil refusé : send_email',
  'Appel d\'outil détecté : passage au palier médium pour la suite (qwen3:14b).',
  'GPU à 87°C (seuil 85°C) : passage au palier rapide le temps qu\'elle refroidisse.',
  'Erreur Ollama : model requires more system memory',
  'Phrase captée pendant la réflexion, gardée pour juste après la réponse : « et demain »',
  'Étape 3/20 : champ "Nom" choisi.'
]

test('une ligne technique du journal ne s’affiche JAMAIS (liste d’autorisation, null par défaut)', () => {
  for (const line of TECHNICAL_LINES) assert.equal(formatChatProgress(line), null, line)
})

test('les indications utiles déjà traduites restent : recherche, lecture, pilotage', () => {
  assert.equal(formatChatProgress('Outil appelé : search_web({"query":"météo Paris"})'), t('progress.searching'))
  assert.equal(formatChatProgress('Question de connaissance sans recherche web : relance corrective d\'un tour.'), t('progress.searching'))
  assert.equal(formatChatProgress('Outil appelé : read_web_page({"url":"https://exemple.fr"})'), t('progress.readingPage'))
  assert.equal(formatChatProgress('Outil appelé : look_at_screen({})'), t('progress.readingScreen'))
  assert.equal(formatChatProgress('Action à l\'écran demandée : pilotage direct, sans réflexion préalable du modèle.'), t('progress.acting'))
  assert.equal(formatChatProgress('Étape 2/20 : clic sur "Envoyer".'), t('activity.step.clickNamed', { step: '2', name: 'Envoyer' }))
})

test('les phrases écrites pour Léo (t()) passent telles quelles, avec leurs valeurs', () => {
  for (const line of [
    t('log.opening', { app: 'Spotify' }),
    t('log.browserSearch', { query: 'recette crêpes' }),
    t('log.notepad.preparing'),
    t('pilot.takingOver', { reason: t('pilot.foreground.closed') }),
    t('pilot.background'),
    t('image.translated', { text: 'a cat on the moon' }),
    t('image.preparing'),
    t('engine.finishing.image')
  ]) {
    assert.equal(formatChatProgress(line), line)
  }
  assert.equal(formatChatProgress(t('common.labelValue', { label: t('engine.step.image'), value: '2/4' })), 'Dessin : 2/4')
  // Une phrase traduite qui cite un modèle et une erreur brute reste au journal.
  assert.equal(formatChatProgress(t('pilot.textFailed', { model: 'qwen3:8b', error: 'timeout' })), null)
})

test('dans une autre langue aussi : la phrase traduite passe, la ligne technique française jamais', () => {
  i18nModule.setLanguage('de', catalog('de'))
  try {
    const opening = t('log.opening', { app: 'Spotify' })
    assert.notEqual(opening, 'Ouverture demandée : Spotify.')
    assert.equal(formatChatProgress(opening), opening)
    assert.equal(formatChatProgress(t('common.labelValue', { label: t('engine.step.image'), value: '1/4' })), t('common.labelValue', { label: t('engine.step.image'), value: '1/4' }))
    assert.equal(formatChatProgress('Outil appelé : search_web({"query":"Wetter"})'), t('progress.searching'))
    for (const line of TECHNICAL_LINES) assert.equal(formatChatProgress(line), null, line)
  } finally {
    i18nModule.setLanguage('fr')
  }
})

test('le Chat et le widget passent bien par ce filtre', () => {
  for (const file of ['src/components/ChatPanel.tsx', 'src/components/ChatWidget.tsx']) {
    const source = readFileSync(join(projectRoot, file), 'utf8')
    assert.match(source, /const visible = formatChatProgress\(message\)\s*\r?\n\s*if \(visible\) setProgress\(visible\)/, file)
  }
})
