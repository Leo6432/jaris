import type { OllamaTool } from './ollama'
import { openApp } from './appLauncher'
import { sendEmail } from './email'
import { rememberNote, recallNote } from './memoryStore'
import { scheduleReminder } from './reminders'
import { lookAtScreen } from './vision'
import { searchWeb } from './webSearch'
import { clickMouse, pressKey, typeText } from './inputControl'

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
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description:
        "Recherche sur le web (moteur local) pour des informations récentes, actuelles, ou que tu ne " +
        'connais pas avec certitude.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Les mots-clés de recherche' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        "Enregistre une information importante à retenir sur le long terme dans la mémoire locale de Jaris " +
        "(préférence de l'utilisateur, fait donné en conversation, résumé à garder). N'utilise cet outil que " +
        "pour de l'info qui vaut la peine d'être gardée d'une conversation à l'autre, pas pour la conversation " +
        "courante. Pour lier une note à une autre note existante, écris [[Titre de l'autre note]] dans le contenu.",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Titre court de la note (ex: "Léo", "Préférences café")' },
          content: { type: 'string', description: 'Le contenu à retenir, en markdown' }
        },
        required: ['title', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'recall_memory',
      description: "Relit le contenu complet d'une note existante de la mémoire locale de Jaris.",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Le titre (ou un mot-clé du titre) de la note à relire' }
        },
        required: ['title']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: "Envoie un vrai mail via le compte configuré par l'utilisateur.",
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description:
              "Adresse mail EXACTE du destinataire, telle que dictée par l'utilisateur dans sa phrase. Ne " +
              "mets jamais ta propre adresse d'envoi, ni une adresse inventée ou déduite : si l'utilisateur " +
              "n'a pas donné d'adresse claire, n'appelle pas cet outil."
          },
          subject: { type: 'string', description: 'Objet du mail' },
          body: { type: 'string', description: 'Contenu du mail, en texte simple' }
        },
        required: ['to', 'subject', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description:
        "Écrit du texte à l'endroit où se trouve le curseur/focus actuel sur l'ordinateur (un champ de texte, " +
        "une barre de recherche, une zone de discussion déjà ouverte...), comme si l'utilisateur le tapait " +
        "lui-même au clavier. N'utilise cet outil que si l'utilisateur demande explicitement d'écrire ou de " +
        "taper quelque chose, et seulement si le bon champ est déjà ouvert et actif (au besoin, vérifie avec " +
        'look_at_screen avant).',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Le texte exact à taper' }
        },
        required: ['text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'press_key',
      description:
        'Appuie sur une touche spéciale du clavier (par exemple pour valider un formulaire ou une recherche ' +
        'juste après avoir tapé du texte avec type_text).',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description:
              'Nom de la touche : entrée, tab, échap, espace, retour arrière, suppr, haut, bas, gauche, ' +
              'droite, début, fin'
          }
        },
        required: ['key']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'click_mouse',
      description:
        "Clique avec la souris. Si l'utilisateur (ou une capture d'écran précédente via look_at_screen) donne " +
        'une position précise en pixels, clique à cet endroit ; sinon clique à la position actuelle du curseur.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: "Position horizontale en pixels sur l'écran (optionnel)" },
          y: { type: 'number', description: "Position verticale en pixels sur l'écran (optionnel)" },
          button: {
            type: 'string',
            description: 'Type de clic',
            enum: ['left', 'right', 'double']
          }
        },
        required: []
      }
    }
  }
]

type ReminderFireHandler = (message: string) => void

export function createToolExecutor(onReminderFire: ReminderFireHandler, visionModel: string) {
  return async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'open_app':
        return openApp(String(args.app_name ?? ''))
      case 'set_reminder':
        return scheduleReminder(String(args.message ?? ''), Number(args.delay_minutes ?? 0), onReminderFire)
      case 'look_at_screen':
        return lookAtScreen(String(args.question ?? ''), visionModel)
      case 'search_web':
        return searchWeb(String(args.query ?? ''))
      case 'remember':
        return rememberNote(String(args.title ?? ''), String(args.content ?? ''))
      case 'recall_memory':
        return recallNote(String(args.title ?? ''))
      case 'send_email':
        return sendEmail(String(args.to ?? ''), String(args.subject ?? ''), String(args.body ?? ''))
      case 'type_text':
        return typeText(String(args.text ?? ''))
      case 'press_key':
        return pressKey(String(args.key ?? ''))
      case 'click_mouse': {
        const x = args.x === undefined || args.x === null ? null : Number(args.x)
        const y = args.y === undefined || args.y === null ? null : Number(args.y)
        return clickMouse(x, y, String(args.button ?? 'left'))
      }
      default:
        return `Outil inconnu : ${name}`
    }
  }
}
