import { readFileSync } from 'node:fs'

/**
 * Étape 463 : le test de code est proposé à TOUS les modèles (CODE_ROLE_MODELS dans hardwareScan.ts). Les tests qui
 * vérifient autre chose (reprise, cas à refaire, durée estimée…) partent du vrai fichier de scores en y ajoutant un
 * score de code (5/5) pour chaque modèle qui n'en a pas — sinon chacun d'eux serait « à tester » pour son code.
 */
const source = readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8')
const lists = [...source.matchAll(/const (?:FLASH|MEDIUM|LARGE|VISION|CODE)_CANDIDATES[\s\S]*?\n\]/g)].map((m) => m[0])
export const ALL_CANDIDATE_MODELS = [...new Set(lists.flatMap((list) => [...list.matchAll(/model: '([^']+)'/g)].map((x) => x[1])))]

export function withCodeForAll(scores, score = '5/5', except = []) {
  const start = scores.indexOf('## Code')
  if (start < 0) {
    // Pas de section Code (scores coupés par un test) : une section entière, sauf les modèles demandés.
    const rows = ALL_CANDIDATE_MODELS.filter((model) => !except.includes(model)).map((model) => `| ${model} | ${score} |`)
    return `${scores.trimEnd()}\n\n## Code — génération\n\n| Modèle | Score |\n|---|---|\n${rows.join('\n')}\n`
  }
  const next = scores.indexOf('\n## ', start + 1)
  const section = scores.slice(start, next < 0 ? undefined : next)
  const has = (model) => section.includes(`| ${model} |`)
  const rows = ALL_CANDIDATE_MODELS.filter((model) => !has(model) && !except.includes(model)).map((model) => `| ${model} | ${score} |`)
  const header = section.indexOf('|---|')
  const lineEnd = section.indexOf('\n', header)
  const updated = `${section.slice(0, lineEnd + 1)}${rows.map((row) => `${row}\n`).join('')}${section.slice(lineEnd + 1)}`
  return scores.slice(0, start) + updated + (next < 0 ? '' : scores.slice(next))
}
