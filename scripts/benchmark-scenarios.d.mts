/**
 * Étape 504 : les types de ce que le duel Agentique (electron/services/duelAgent.ts) utilise du test des demandes
 * complètes — le PC simulé et les demandes. Le module lui-même reste en JavaScript (il sert aussi au script de test).
 */
export interface ScenarioToolCall {
  turn: number
  name: string
  args: Record<string, unknown>
  result: string
}
export interface ScenarioTurn {
  user: string
  reply: string
  shortCircuit: boolean
  error: string | null
}
export interface Scenario {
  id: string
  family: string
  turns: string[]
  repeat?: boolean
  history?: { role: string; content: string }[]
}
export interface ScenarioEvent {
  kind: 'requete' | 'reponse' | 'outil'
  turn: number
  round: number
  name?: string
  args?: Record<string, unknown>
  result?: string
}
export interface ScenarioRun {
  ok: boolean
  reason: string | null
  calls: ScenarioToolCall[]
  turns: ScenarioTurn[]
}
export type ScenarioChat = (
  messages: { role: string; content: string; tool_calls?: unknown; thinking?: string }[],
  opts?: { tools?: boolean }
) => Promise<{ message?: { role: string; content: string; tool_calls?: unknown; thinking?: string }; done_reason?: string; prompt_eval_count?: number }>
export const SCENARIOS: Scenario[]
export function runScenario(
  scenario: Scenario,
  chat: ScenarioChat,
  options?: { variant?: number; onEvent?: (event: ScenarioEvent) => void }
): Promise<ScenarioRun>
