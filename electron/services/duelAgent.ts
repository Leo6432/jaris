import { SCENARIOS, runScenario, type Scenario } from '../../scripts/benchmark-scenarios.mjs'
import { TOOLS as SCENARIO_TOOLS } from '../../scripts/benchmark-cases.mjs'
import { DUEL_AGENT_TASKS } from '../../scripts/duel-agent-tasks.mjs'
import { chatWithOllama, type OllamaMessage, type OllamaTool } from './ollama'
import type { ThinkValue } from '../../shared/effort'

/**
 * Étape 504 (Léo : « on enlève la conversation et on fait un duel agentique », puis « oui, Discussion plus
 * Agentique ») : le duel Agentique. Chaque modèle reçoit une VRAIE tâche en plusieurs étapes (ouvrir une application
 * puis écrire, chercher puis envoyer un mail, se corriger au deuxième message…) et la fait sur un PC SIMULÉ : celui du
 * test des demandes complètes (scripts/benchmark-scenarios.mjs), dont la boucle est vérifiée identique à converse() par
 * test-benchmark-scenarios.mjs. Rien n'est ouvert, tapé, envoyé ni éteint pour de vrai — ni deux fois. Léo regarde ce
 * que chaque modèle a fait, étape par étape, et vote. Les tâches sont en français, comme le test des modèles.
 */

/** Une tâche du duel : la demande du test et le jeu de résultats simulés (prix, météo…) commun aux deux modèles. */
export interface AgentTask {
  id: string
  /** Les messages de Léo, joués l'un après l'autre (une correction au deuxième message, par exemple). */
  turns: string[]
  variant: number
}

/**
 * Les demandes du test qui exigent au moins une action (les « merci », blagues et heures ne départagent rien ici), plus,
 * étape 506 (Léo : « ajoute plein de propositions agentique »), les tâches propres au duel (duel-agent-tasks.mjs).
 */
const AGENT_SCENARIOS: Scenario[] = [...SCENARIOS.filter((s) => !['merci', 'blague', 'heure'].includes(s.id)), ...DUEL_AGENT_TASKS]

const toTask = (scenario: Scenario, random: () => number): AgentTask => ({
  id: scenario.id,
  turns: [...scenario.turns],
  variant: scenario.repeat ? Math.floor(random() * 2) : 0
})

/**
 * Étape 518 (Léo : « ajoute dans Agentique des propositions simples et dures, avec plusieurs choses ») : difficile =
 * une tâche marquée comme telle (plusieurs actions d'outils différents à enchaîner) ou en plusieurs messages (une
 * correction au deuxième) ; sinon simple.
 */
export function agentTaskLevel(scenario: Scenario): 'simple' | 'hard' {
  return scenario.level === 'hard' || scenario.turns.length > 1 ? 'hard' : 'simple'
}

/** Étape 506 : les tâches proposées à l'écran (le premier message de chacune), pour que Léo en choisisse une. */
export interface AgentTaskChoice {
  id: string
  text: string
  level: 'simple' | 'hard'
}
export function agentTaskChoices(): AgentTaskChoice[] {
  return AGENT_SCENARIOS.map((s) => ({ id: s.id, text: s.turns[0], level: agentTaskLevel(s) }))
}

/** Étape 506 : la tâche choisie par Léo (son identifiant), avec un jeu de résultats ; `null` si elle n'existe pas. */
export function agentTaskById(id: string, random: () => number = Math.random): AgentTask | null {
  const scenario = AGENT_SCENARIOS.find((s) => s.id === id)
  return scenario ? toTask(scenario, random) : null
}

/** Une tâche pas encore jouée dans cette session (sinon n'importe laquelle), au hasard, avec un jeu de résultats. */
export function pickAgentTask(played: ReadonlySet<string>, random: () => number = Math.random): AgentTask {
  const fresh = AGENT_SCENARIOS.filter((s) => !played.has(s.id))
  const pool = fresh.length ? fresh : AGENT_SCENARIOS
  return toTask(pool[Math.floor(random() * pool.length) % pool.length], random)
}

/** Étape 531 : les outils du PC simulé, tels qu'ils sont proposés aux modèles — pour l'avis de Claude. */
export function agentToolsForJudge(): { name: string; description: string }[] {
  return (SCENARIO_TOOLS as unknown as OllamaTool[]).map((tool) => ({ name: tool.function.name, description: tool.function.description ?? '' }))
}

export function agentTaskExists(id: string): boolean {
  return AGENT_SCENARIOS.some((s) => s.id === id)
}

/** Ce qu'un modèle a fait pendant la tâche, au fil de l'eau (l'écran le montre étape par étape). */
export type AgentStep =
  | { kind: 'thinking'; turn: number }
  | { kind: 'tool'; turn: number; name: string; args: Record<string, unknown>; result: string }
  | { kind: 'reply'; turn: number; text: string }

export interface AgentOutcome {
  /** La réponse de chaque tour. */
  replies: string[]
  /** Le jugement automatique du test (réussie ou non) : montré à Léo seulement après son vote. */
  ok: boolean
}

/**
 * Joue la tâche avec `model` sur le PC simulé. `think` : le même niveau de réflexion pour les deux modèles du duel
 * (DUEL_THINK_LEVEL). Une erreur d'Ollama remonte telle quelle (l'écran dit laquelle).
 */
export async function runAgentTask(
  task: AgentTask,
  model: string,
  think: ThinkValue,
  signal: AbortSignal,
  onStep: (step: AgentStep) => void
): Promise<AgentOutcome> {
  const scenario = AGENT_SCENARIOS.find((s) => s.id === task.id)
  if (!scenario) throw new Error(`tâche inconnue : ${task.id}`)
  const run = await runScenario(
    scenario,
    async (messages, opts) => {
      if (signal.aborted) throw new DOMException('Arrêté', 'AbortError')
      const tools = opts?.tools === false ? undefined : (SCENARIO_TOOLS as unknown as OllamaTool[])
      const message = await chatWithOllama(messages as OllamaMessage[], tools, model, think, signal)
      return { message: message as { role: string; content: string; tool_calls?: unknown; thinking?: string } }
    },
    {
      variant: task.variant,
      onEvent: (event) => {
        if (event.kind === 'requete') onStep({ kind: 'thinking', turn: event.turn })
        else if (event.kind === 'outil') {
          onStep({ kind: 'tool', turn: event.turn, name: event.name ?? '', args: event.args ?? {}, result: event.result ?? '' })
        }
      }
    }
  )
  // Une erreur d'Ollama est relancée par runScenario avec son vrai message. Un modèle qui tourne en rond sans jamais
  // répondre, lui, a simplement raté la tâche : ses actions restent montrées, et Léo vote.
  run.turns.forEach((turn, index) => onStep({ kind: 'reply', turn: index, text: turn.reply ?? '' }))
  return { replies: run.turns.map((turn) => turn.reply ?? ''), ok: run.ok }
}
