/**
 * Étape 358 : Faible, Moyen, Élevé et Code ne prennent plus leur force dans Artificial Analysis, mais dans les duels
 * (tous à 0 point au départ). Les tests de la MÉCANIQUE du choix (gabarit des petits, plancher de vitesse, repli…)
 * gardent leurs exemples réels en branchant des « duels » dont la force reproduit l'ancienne note publiée :
 * intelligence × part « n'invente pas » pour la conversation, Terminal-Bench 2.1 (plancher d'une tâche sur 89) pour
 * le Code. × 1000 : un modèle sans mesure publiée (force 1, comme un modèle jamais voté) passe toujours après.
 */

/** À ajouter au code transpilé de hardwareScan.ts : expose les tables publiées (privées au module) au test. */
export const EXPOSE_AA_TABLES =
  '\nexports.__AA = { index: ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX, omniscience: ARTIFICIAL_ANALYSIS_OMNISCIENCE, terminalBench: ARTIFICIAL_ANALYSIS_TERMINAL_BENCH_21 }\n'

export function useAaAsDuels(m) {
  const { index, omniscience, terminalBench } = m.__AA
  const conversation = new Map()
  const code = new Map()
  for (const [model, value] of Object.entries(index)) {
    if (omniscience[model] !== undefined) conversation.set(model, { strength: 1000 * value * ((100 + omniscience[model]) / 200), duels: 1 })
  }
  for (const [model, value] of Object.entries(terminalBench)) code.set(model, { strength: 1000 * Math.max(value, 100 / 89), duels: 1 })
  m.setDuelStrengthSource((category) => (category === 'code' ? code : conversation))
  return m
}
