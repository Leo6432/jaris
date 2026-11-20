/**
 * Étape 497 puis 501 : la VRAIE raison d'un programme qui s'arrête en erreur, tirée de ses dernières lignes, pour le
 * message affiché — jamais un simple « code 1 » (règle « les erreurs remontent avec leur vrai message »). Les lignes
 * d'erreur reconnues d'abord (les trois dernières), sinon les deux dernières lignes. Les repères internes du test des
 * modèles (`##…##`) ne sont jamais montrés.
 */
export function failureDetail(lines: string[]): string {
  const meaningful = lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('##'))
  const errors = meaningful.filter((l) => /^(ERROR|error)\b|Error:|Erreur|OSError|denied|refus|requires|introuvable|not found/i.test(l)).slice(-3)
  return (errors.length ? errors : meaningful.slice(-2)).join(' / ').slice(0, 600)
}
