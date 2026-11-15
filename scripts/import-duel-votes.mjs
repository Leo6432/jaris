// Étape 369 : ajoute les votes d'un fichier exporté par Jaris (bouton « Télécharger les votes » de l'historique des
// duels) à scripts/shared-duel-votes.json, livré avec Jaris pour que ces votes comptent pour tout le monde.
// Usage : node scripts/import-duel-votes.mjs <jaris-votes-AAAA-MM-JJ.json> [fichier partagé]
// Seuls les champs utiles au classement sont gardés : ni la demande ni les réponses (vie privée de celui qui a voté).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadTsModule } from './load-ts-module.mjs'

const { parseDuelVotes } = loadTsModule('shared/duel.ts')
// Étape 489 : `judge` (le modèle Claude qui a voté, absent pour un vote humain) est gardé, pour pouvoir toujours
// séparer les votes de Claude de ceux de Léo.
const KEPT = ['id', 'category', 'at', 'sessionId', 'modelA', 'modelB', 'outcome', 'judge']
export const DEFAULT_SHARED = fileURLToPath(new URL('./shared-duel-votes.json', import.meta.url))
/**
 * Étape 490 : votes retirés à la demande de Léo (identifiant + raison). Supprimer un duel de l'historique de Jaris garde
 * son vote dans l'export (étape 398) : sans cette liste, le vote retiré reviendrait au prochain import.
 */
export const DEFAULT_EXCLUDED = fileURLToPath(new URL('./excluded-duel-votes.json', import.meta.url))

function excludedIds(path) {
  if (!path || !existsSync(path)) return new Set()
  return new Set(JSON.parse(readFileSync(path, 'utf8')).map((entry) => entry.id))
}

/** Fusionne l'export dans le fichier partagé. Renvoie le nombre de votes ajoutés et le total. */
export function importDuelVotes(exportText, sharedPath = DEFAULT_SHARED, excludedPath = DEFAULT_EXCLUDED) {
  const excluded = excludedIds(excludedPath)
  const data = JSON.parse(exportText)
  if (data?.format !== 'jaris-duel-votes' || !Array.isArray(data.votes)) {
    throw new Error('Ce fichier n’est pas un export de votes de Jaris (format « jaris-duel-votes » attendu).')
  }
  const incoming = (parseDuelVotes(data.votes) ?? []).map((v) => Object.fromEntries(KEPT.map((k) => [k, v[k]])))
  const current = (existsSync(sharedPath) ? parseDuelVotes(JSON.parse(readFileSync(sharedPath, 'utf8'))) ?? [] : []).filter((v) => !excluded.has(v.id))
  const known = new Set([...current.map((v) => v.id), ...excluded])
  const added = incoming.filter((v) => !known.has(v.id) && known.add(v.id))
  // Un vote déjà partagé, importé avant l'étape 489 sans sa marque `judge`, la retrouve.
  const judgeOf = new Map(incoming.filter((v) => v.judge).map((v) => [v.id, v.judge]))
  const kept = current.map((v) => Object.fromEntries(KEPT.map((k) => [k, k === 'judge' ? (v.judge ?? judgeOf.get(v.id)) : v[k]])))
  const all = [...kept, ...added].sort((a, b) => a.at - b.at)
  writeFileSync(sharedPath, JSON.stringify(all, null, 2) + '\n')
  return { added: added.length, total: all.length }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [file, shared] = process.argv.slice(2)
  if (!file) {
    console.error('Usage : node scripts/import-duel-votes.mjs <export.json> [fichier partagé]')
    process.exit(1)
  }
  const { added, total } = importDuelVotes(readFileSync(file, 'utf8'), shared)
  console.log(`Votes ajoutés : ${added} (total : ${total})`)
}
