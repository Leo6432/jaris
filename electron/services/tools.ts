import type { OllamaTool } from './ollama'
import { openApp } from './appLauncher'
import { scheduleReminder } from './reminders'
import { lookAtScreen } from './vision'

export const TOOLS: OllamaTool[] = [
  {
    type: 'function',
    function: {
      name: 'open_app',
      description:
        "Ouvre n'importe quelle application installée sur l'ordinateur de l'utilisateur (pas seulement " +
        "quelques applications connues : appelle toujours cet outil avec le nom demandé, il cherche lui-même " +
        "parmi toutes les applications installées sur la machine).",
      parameters: {
        type: 'object',
        properties: {
          app_name: {
            type: 'string',
            description: "Nom de l'application à ouvrir, tel que demandé par l'utilisateur"
          }
        },
        required: ['app_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: 'Programme un rappel vocal qui sera dit à voix haute dans un certain nombre de minutes.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Le contenu du rappel à dire à voix haute' },
          delay_minutes: { type: 'number', description: 'Dans combien de minutes déclencher le rappel' }
        },
        required: ['message', 'delay_minutes']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'look_at_screen',
      description:
        "Capture une image de l'écran de l'utilisateur et la décrit, ou répond à une question précise sur " +
        'ce qui y est affiché (ex: lire un message d\'erreur, décrire une fenêtre ouverte).',
      parameters: {
        type: 'object',
        properties: {
          question: {
            type: 'string',
            description: "Ce qu'il faut chercher ou décrire sur l'écran, en français"
          }
        },
        required: ['question']
      }
    }
  }
]

type ReminderFireHandler = (message: string) => void

export function createToolExecutor(onReminderFire: ReminderFireHandler) {
  return async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'open_app':
        return openApp(String(args.app_name ?? ''))
      case 'set_reminder':
        return scheduleReminder(String(args.message ?? ''), Number(args.delay_minutes ?? 0), onReminderFire)
      case 'look_at_screen':
        return lookAtScreen(String(args.question ?? ''))
      default:
        return `Outil inconnu : ${name}`
    }
  }
}
