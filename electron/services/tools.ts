import type { OllamaTool } from './ollama'
import { openApp } from './appLauncher'
import { sendEmail } from './email'
import { rememberNote, recallNote } from './memoryStore'
import { scheduleReminder } from './reminders'
import { lookAtScreen } from './vision'
import { searchWeb } from './webSearch'
import { clickMouse, mediaKey, pressKey, typeText } from './inputControl'
import { getSystemStatsText, shutdownPc } from './systemControl'
import { clickBrowserElement, fillBrowserField, openBrowserUrl, readActiveTab, screenshotActiveTab } from './browserControl'

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
              "Adresse mail EXACTE du destinataire : soit dictée par l'utilisateur dans sa phrase, soit " +
              "trouvée par toi avec search_web plus tôt dans cette conversation (ex: coordonnées d'un " +
              "commerce). Ne mets jamais ta propre adresse d'envoi, ni une adresse inventée ou déduite : si " +
              "tu n'as ni adresse dictée ni adresse trouvée par une vraie recherche, n'appelle pas cet outil."
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
        "lui-même au clavier. Appelle cet outil directement dès que l'utilisateur demande explicitement " +
        "d'écrire ou de taper quelque chose : ne vérifie JAMAIS l'écran avec look_at_screen avant, ça ne " +
        "fait que ralentir inutilement — fais confiance à l'utilisateur, il sait déjà où il veut que ça " +
        'tape.',
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
  },
  {
    type: 'function',
    function: {
      name: 'get_system_stats',
      description: "Donne l'état actuel de l'ordinateur : utilisation CPU, RAM utilisée, VRAM libre et température du GPU si disponible.",
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'media_control',
      description:
        "Contrôle la lecture multimédia ou le volume du système, un cran à la fois (comme une touche " +
        'multimédia physique) : monter/baisser le son, couper/réactiver le son, lecture/pause, piste ' +
        'suivante/précédente.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'Action à effectuer',
            enum: ['volume_up', 'volume_down', 'mute', 'play_pause', 'next', 'previous']
          }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_browser_tab',
      description:
        "Lit l'onglet actif de la fenêtre Chrome dédiée à Jaris (titre, URL, texte de la page) pour " +
        "répondre à \"résume cette page\", \"traduis ça\", \"de quoi ça parle\". Nécessite la fenêtre " +
        'Chrome dédiée à Jaris (auto-lancée au besoin, séparée du Chrome habituel de l\'utilisateur).',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_browser_url',
      description:
        "Ouvre une adresse (ou fait une recherche si ce n'est pas une adresse) dans un nouvel onglet de la " +
        "fenêtre Chrome dédiée à Jaris. Pour \"ouvre YouTube\", \"va sur le site X\", \"cherche des tests du " +
        'Godox TL60".',
      parameters: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'URL complète (https://...) ou mots-clés à chercher' }
        },
        required: ['target']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'click_browser_element',
      description:
        "Clique sur un élément de l'onglet actif de la fenêtre Chrome dédiée à Jaris, décrit en langage " +
        'naturel (le texte visible du bouton/lien, ex: "Suivant", "Se connecter", "Ajouter au panier").',
      parameters: {
        type: 'object',
        properties: {
          description: { type: 'string', description: "Texte visible de l'élément à cliquer" }
        },
        required: ['description']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'fill_browser_field',
      description:
        "Remplit un champ de formulaire de l'onglet actif de la fenêtre Chrome dédiée à Jaris, décrit en " +
        'langage naturel (son label ou son placeholder, ex: "Email", "Nom", "Rechercher").',
      parameters: {
        type: 'object',
        properties: {
          field: { type: 'string', description: 'Label ou placeholder du champ à remplir' },
          text: { type: 'string', description: 'Texte à écrire dans le champ' }
        },
        required: ['field', 'text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'screenshot_browser_tab',
      description:
        "Capture l'onglet actif de la fenêtre Chrome dédiée à Jaris et le décrit, pour un contenu qu'un " +
        "simple texte (read_browser_tab) ne suffit pas à décrire (mise en page, graphique, image).",
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: "Ce qu'il faut chercher ou décrire sur la page, en français" }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'shutdown_pc',
      description:
        "Éteint ou redémarre l'ordinateur. Action CRITIQUE et irréversible : n'appelle cet outil que si " +
        "l'utilisateur a clairement et explicitement demandé d'éteindre ou de redémarrer la machine, jamais " +
        "de ta propre initiative ni sur un simple soupçon.",
      parameters: {
        type: 'object',
        properties: {
          restart: { type: 'boolean', description: 'true pour redémarrer, false (ou absent) pour éteindre' }
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
      case 'get_system_stats':
        return getSystemStatsText()
      case 'read_browser_tab':
        return readActiveTab()
      case 'open_browser_url':
        // Un petit modèle local nomme parfois ce paramètre "url" au lieu de "target" (observé en usage
        // réel) : on accepte les deux plutôt que de silencieusement traiter ça comme une adresse vide.
        return openBrowserUrl(String(args.target ?? args.url ?? ''))
      case 'click_browser_element':
        return clickBrowserElement(String(args.description ?? ''))
      case 'fill_browser_field':
        return fillBrowserField(String(args.field ?? ''), String(args.text ?? ''))
      case 'screenshot_browser_tab':
        return screenshotActiveTab(String(args.question ?? ''), visionModel)
      case 'media_control':
        return mediaKey(String(args.action ?? ''))
      case 'shutdown_pc':
        return shutdownPc(Boolean(args.restart))
      default:
        return `Outil inconnu : ${name}`
    }
  }
}
