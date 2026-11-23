import type { OllamaTool } from './ollama'
import { launchedAppName, openApp } from './appLauncher'
import { computerUseTask } from './computerUse'
import { rememberNote, recallNote } from './memoryStore'
import { cancelReminder, listReminders, scheduleReminder } from './reminders'
import { lookAtScreen } from './vision'
import { searchWebDetailed } from './webSearch'
import { readWebPage } from './webPage'
import { clickMouse, keyPolicy, mediaKey, pressKey, scrollWheel, typeText, waitForForegroundApp } from './inputControl'
import { appWindow, setVolume, windowsSetting } from './pcControl'
import { filesTool } from './fileTools'
import { getSystemStatsText, shutdownPc } from './systemControl'
import { generateImage, type GeneratedImage } from './imageGenerator'
import type { WebActivity } from '../../shared/ipc'
import { t } from '../../shared/i18n'

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
      description:
        "Programme un rappel : au moment voulu, Jaris le dit à voix haute et l'affiche en notification Windows. " +
        'Le délai est toujours en minutes, convertis-le toi-même ("dans 2 heures" = 120 ; "à 18 h" = le nombre ' +
        "de minutes entre l'heure actuelle, donnée au début de la demande, et 18 h). Si l'utilisateur ne dit " +
        "pas quand, demande-le-lui au lieu d'inventer un délai.",
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Le contenu du rappel, tel qu\'il sera dit et affiché' },
          delay_minutes: { type: 'number', description: 'Dans combien de minutes déclencher le rappel (en minutes, jamais en heures)' }
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
        "Recherche sur internet (DuckDuckGo) pour des informations récentes, actuelles, ou que tu ne " +
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
      name: 'read_web_page',
      description:
        "Lit le contenu texte d'une page web précise — à utiliser quand les extraits de " +
        "search_web ne suffisent pas (détail précis manquant : adresse exacte, horaire, prix...). " +
        "Prends l'URL parmi celles déjà renvoyées par un précédent appel à search_web dans cette même " +
        "conversation, jamais une URL inventée.",
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: "URL complète de la page à lire, trouvée via search_web" }
        },
        required: ['url']
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
          title: { type: 'string', description: 'Titre court de la note (ex: "Paul", "Préférences café")' },
          content: { type: 'string', description: 'Le contenu à retenir, en markdown' },
          replace: {
            type: 'boolean',
            description:
              "true UNIQUEMENT si l'utilisateur corrige une info déjà connue (\"mon adresse a changé\", " +
              '"en fait ce n\'est plus...") : remplace tout le contenu existant de cette note par le nouveau, ' +
              "sans garder l'ancienne valeur. Absent/false (par défaut) pour une info vraiment nouvelle, qui " +
              "s'ajoute simplement à la suite de ce qui est déjà noté."
          }
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
        'juste après avoir tapé du texte avec type_text) ou sur un raccourci.',
      parameters: {
        type: 'object',
        properties: {
          key: {
            type: 'string',
            description:
              'Nom de la touche : entrée, tab, échap, espace, retour arrière, suppr, haut, bas, gauche, ' +
              'droite, début, fin ; ou un raccourci, ex: "ctrl+c", "alt+tab"'
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
        "Clique avec la souris là où se trouve déjà le curseur (ex: \"clique\", \"fais un clic droit\"). Pour " +
        "cliquer sur un élément précis de l'écran (un bouton, un lien...), utilise computer_use_task, qui regarde " +
        "l'écran pour le trouver : ne devine jamais une position. N'indique x et y que si l'utilisateur donne " +
        'lui-même une position en pixels.',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: "Position horizontale en pixels, seulement si l'utilisateur la donne" },
          y: { type: 'number', description: "Position verticale en pixels, seulement si l'utilisateur la donne" },
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
        "suivante/précédente. Pour le volume, un appel = un seul cran : pour \"monte beaucoup le son\", " +
        'appelle-le plusieurs fois. Volume précis : set_volume avec percent (0 à 100).',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'Action à effectuer',
            enum: ['volume_up', 'volume_down', 'mute', 'play_pause', 'next', 'previous', 'set_volume']
          },
          percent: { type: 'number' }
        },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'computer_use_task',
      description:
        "Accomplit un objectif en pilotant réellement l'ordinateur à la souris et au clavier, comme le " +
        "ferait un humain : ouvrir un site et y naviguer, cliquer des boutons/liens, remplir un formulaire, " +
        "envoyer un mail (ouvre le vrai Gmail/client mail déjà connecté sur la machine), acheter/rechercher " +
        "quelque chose sur un site. Décris l'objectif complet en une phrase claire (pas une suite d'étapes " +
        "détaillées : l'agent regarde l'écran et improvise le détail lui-même). Plus lent qu'une réponse " +
        "directe (plusieurs captures d'écran et clics avant de terminer) : appelle-le directement, sans " +
        "phrase d'annonce, Jaris montre lui-même l'avancement à l'utilisateur.",
      parameters: {
        type: 'object',
        properties: {
          goal: {
            type: 'string',
            description:
              'Objectif complet et autonome, ex: "Envoie un mail à jean@exemple.com avec pour objet ' +
              '\'Réunion\' et pour contenu \'Je confirme demain 14h\'", "Va sur youtube.com et cherche des ' +
              'tutos de guitare", "Ajoute le premier résultat au panier sur ce site".'
          }
        },
        required: ['goal']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'generate_image',
      description:
        "Dessine une image (illustration, photo, logo, paysage...) à partir d'une description, entièrement sur " +
        "l'ordinateur de l'utilisateur. N'appelle cet outil que si l'utilisateur demande de CRÉER une image " +
        "(dessine, génère une image, fais-moi une image de...), jamais pour regarder l'écran ou décrire une " +
        'image existante.',
      parameters: {
        type: 'object',
        properties: {
          prompt: {
            type: 'string',
            description:
              "Description détaillée de l'image à dessiner, EN ANGLAIS (sujet, décor, style, lumière, cadrage), " +
              'ex: "a ginger cat sitting on a blue sofa, realistic photo, soft daylight".'
          }
        },
        required: ['prompt']
      }
    }
  },
  // Étape 508 (Léo : « oui tout », pour les outils qui manquaient). Descriptions courtes à dessein : consignes + outils
  // doivent rester sous ~7 500 tokens estimés, sinon chaque demande passe à la fenêtre de 32 768 (ollama.ts,
  // AUTO_CONTEXT_STEPS) et le modèle prend deux fois plus de mémoire (vérifié par test-benchmark-cases).
  {
    type: 'function',
    function: {
      name: 'app_window',
      description: 'Ferme une application ouverte (comme sa croix) ou la remet au premier plan.',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['close', 'focus'] }, app_name: { type: 'string' } },
        required: ['action', 'app_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'manage_reminders',
      description: 'Liste les rappels programmés, ou en annule un (which : son numéro ou des mots de son message).',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['list', 'cancel'] }, which: { type: 'string' } },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'files',
      description:
        "Fichiers de l'utilisateur (Documents, Bureau, Téléchargements, Images, Musique, Vidéos) : find cherche par " +
        'name et donne les chemins ; open ouvre ce path ; read lit ce fichier texte.',
      parameters: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['find', 'open', 'read'] }, name: { type: 'string' }, path: { type: 'string' } },
        required: ['action']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'scroll',
      description: 'Fait défiler la fenêtre sous la souris (amount : crans de molette, 3 par défaut).',
      parameters: {
        type: 'object',
        properties: { direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'number' } },
        required: ['direction']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'windows_setting',
      description:
        'Réglage de Windows. value : brightness = 0 à 100 ; dark_mode = on ou off ; open_page = wifi, bluetooth, ' +
        'display, sound, colors, battery, updates ou apps.',
      parameters: {
        type: 'object',
        properties: { setting: { type: 'string', enum: ['brightness', 'dark_mode', 'open_page'] }, value: { type: 'string' } },
        required: ['setting', 'value']
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

/**
 * Début de la réponse d'une image réussie (court-circuit d'assistant.ts : jamais reformulée par le modèle). Le texte
 * affiché suit la langue de Jaris (`reply.imageDone`) ; cette version française reste la référence du simulateur.
 */
export const IMAGE_DONE_REPLY = 'Voilà ton image.'

/**
 * Un booléen d'outil : `true`, ou le texte "true" que renvoient certains modèles. Étape 233 : `Boolean(x)` faisait
 * de "false" (un texte non vide) un VRAI — un modèle qui écrivait `replace: "false"` effaçait la note au lieu de la
 * compléter, et `restart: "false"` redémarrait au lieu d'éteindre. Vu en relisant les outils pour le simulateur.
 */
export function toolFlag(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true')
}

type ReminderFireHandler = (message: string) => void
type LogHandler = (message: string) => void
/** Étape 173 : reçoit chaque image dessinée (le Chat l'affiche, la voix l'ouvre). */
export type ImageHandler = (image: GeneratedImage) => void
/** Étape 273 : une recherche web ou une page lue, pour le bloc « A cherché sur le web » du Chat. */
export type WebActivityHandler = (activity: WebActivity) => void

export function createToolExecutor(
  onReminderFire: ReminderFireHandler,
  visionModel: string,
  onLog?: LogHandler,
  signal?: AbortSignal,
  onImage?: ImageHandler,
  onWebActivity?: WebActivityHandler,
  /** Étape 520 : en duel ou depuis le téléphone, toute touche pressée (press_key ET pilotage de l'écran) est seule. */
  options: { singleKeysOnly?: boolean } = {}
) {
  // Étape 346 : l'application ouverte pendant CETTE demande, tant qu'aucun texte n'y a été tapé.
  let openedApp: string | undefined
  return async function executeTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (options.singleKeysOnly) return keyPolicy.run({ singleKeysOnly: true }, () => runOne(name, args))
    return runOne(name, args)
  }
  async function runOne(name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
      case 'open_app': {
        const result = await openApp(String(args.app_name ?? ''))
        openedApp = launchedAppName(result) ?? openedApp
        return result
      }
      case 'set_reminder':
        return scheduleReminder(String(args.message ?? ''), Number(args.delay_minutes ?? 0), onReminderFire)
      case 'look_at_screen':
        return lookAtScreen(String(args.question ?? ''), visionModel, signal)
      // Étape 273 : chaque recherche et chaque page lue sont aussi signalées au Chat (bloc dépliable), en
      // échec compris — une recherche qui n'a rien donné doit se voir autant qu'une recherche réussie.
      // Étape 274 : une première fois dès le début (`pending`), pour que la question cherchée s'affiche tout de
      // suite plutôt qu'après les résultats.
      case 'search_web': {
        const query = String(args.query ?? '')
        onWebActivity?.({ kind: 'search', query, results: [], pending: true })
        try {
          const { text, sources } = await searchWebDetailed(query, undefined, signal)
          onWebActivity?.({ kind: 'search', query, results: sources })
          return text
        } catch (err) {
          onWebActivity?.({ kind: 'search', query, results: [], failed: true })
          throw err
        }
      }
      case 'read_web_page': {
        const url = String(args.url ?? '')
        onWebActivity?.({ kind: 'read', url, pending: true })
        try {
          const text = await readWebPage(url)
          // Une adresse refusée (pas http/https) revient en texte, pas en erreur : comptée comme un échec.
          onWebActivity?.({ kind: 'read', url, ...(/^https?:\/\//i.test(url) ? {} : { failed: true }) })
          return text
        } catch (err) {
          onWebActivity?.({ kind: 'read', url, failed: true })
          throw err
        }
      }
      case 'remember':
        return rememberNote(String(args.title ?? ''), String(args.content ?? ''), toolFlag(args.replace))
      case 'recall_memory':
        return recallNote(String(args.title ?? ''))
      case 'computer_use_task':
        return computerUseTask(String(args.goal ?? ''), visionModel, onLog, signal)
      case 'type_text': {
        // Étape 346 : juste après une ouverture, attendre que l'application soit au premier plan — jamais taper dans la
        // fenêtre au hasard qui a le focus. Non confirmée : rien n'est tapé, et Jaris le dit.
        if (openedApp) {
          const app = openedApp
          if (!(await waitForForegroundApp(app))) throw new Error(t('tool.typeText.notForeground', { app }))
          openedApp = undefined
        }
        return typeText(String(args.text ?? ''))
      }
      case 'press_key':
        return pressKey(String(args.key ?? ''))
      case 'click_mouse': {
        const x = args.x === undefined || args.x === null ? null : Number(args.x)
        const y = args.y === undefined || args.y === null ? null : Number(args.y)
        return clickMouse(x, y, String(args.button ?? 'left'))
      }
      case 'get_system_stats':
        return getSystemStatsText()
      case 'media_control':
        // Étape 508 : un volume précis en pourcentage.
        if (String(args.action ?? '').trim().toLowerCase() === 'set_volume') return setVolume(args.percent)
        return mediaKey(String(args.action ?? ''))
      case 'app_window':
        return appWindow(String(args.action ?? '').trim().toLowerCase(), String(args.app_name ?? ''))
      case 'manage_reminders': {
        const action = String(args.action ?? '').trim().toLowerCase()
        if (action === 'list') return listReminders()
        if (action === 'cancel') return cancelReminder(String(args.which ?? ''))
        return `Action "${action}" inconnue : list ou cancel.`
      }
      case 'files':
        return filesTool(String(args.action ?? '').trim().toLowerCase(), { name: args.name, path: args.path })
      case 'scroll':
        return scrollWheel(String(args.direction ?? ''), args.amount)
      case 'windows_setting':
        return windowsSetting(String(args.setting ?? '').trim().toLowerCase(), args.value)
      case 'generate_image': {
        const image = await generateImage(String(args.prompt ?? ''), onLog, signal)
        onImage?.(image)
        return t('reply.imageDone')
      }
      case 'shutdown_pc':
        return shutdownPc(toolFlag(args.restart))
      default:
        return `Outil inconnu : ${name}`
    }
  }
}
