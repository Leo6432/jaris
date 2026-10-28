// Étape 369 : ajoute les votes d'un fichier exporté par Jaris (bouton « Télécharger les votes » de l'historique des
// duels) à scripts/shared-duel-votes.json, livré avec Jaris pour que ces votes comptent pour tout le monde.
// Usage : node scripts/import-duel-votes.mjs <jaris-votes-AAAA-MM-JJ.json> [fichier partagé]
// Seuls les champs utiles au classement sont gardés : ni la demande ni les réponses (vie privée de celui qui a voté).
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadTsModule } from './load-ts-module.mjs'

const { parseDuelVotes } = loadTsModule('shared/duel.ts')
const KEPT = ['id', 'category', 'at', 'sessionId', 'modelA', 'modelB', 'outcome']
export const DEFAULT_SHARED = fileURLToPath(new URL('./shared-duel-votes.json', import.meta.url))

/** Fusionne l'export dans le fichier partagé. Renvoie le nombre de votes ajoutés et le total. */
export function importDuelVotes(exportText, sharedPath = DEFAULT_SHARED) {
  const data = JSON.parse(exportText)
  if (data?.format !== 'jaris-duel-votes' || !Array.isArray(data.votes)) {
    throw new Error('Ce fichier n’est pas un export de votes de Jaris (format « jaris-duel-votes » attendu).')
  }
  const incoming = (parseDuelVotes(data.votes) ?? []).map((v) => Object.fromEntries(KEPT.map((k) => [k, v[k]])))
  const current = existsSync(sharedPath) ? parseDuelVotes(JSON.parse(readFileSync(sharedPath, 'utf8'))) ?? [] : []
  const known = new Set(current.map((v) => v.id))
  const added = incoming.filter((v) => !known.has(v.id) && known.add(v.id))
  const all = [...current.map((v) => Object.fromEntries(KEPT.map((k) => [k, v[k]]))), ...added].sort((a, b) => a.at - b.at)
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
