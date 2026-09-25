/**
 * Ce que l'analyse des modèles (benchmark-models.mjs) envoie à chaque modèle testé — étape 162, Léo : « est-ce
 * que les tests d'outils sont bien ou on en rajoute pour faire un bon score fiable ».
 *
 * L'ancien test avait trois défauts, trouvés en le relisant contre le vrai Jaris :
 * - une COPIE PÉRIMÉE des outils (7 au lieu des 14 réels, dont send_email, retiré de Jaris depuis longtemps) ;
 * - des consignes système simplifiées (4 lignes) au lieu des vraies — qui exigent par exemple search_web pour
 *   toute question factuelle, là où l'ancien test attendait « pas d'outil » pour « pourquoi le ciel est bleu » ;
 * - 6 questions notées seulement (une par outil), sans vérifier le contenu de l'appel : un rappel « dans 20
 *   minutes » programmé à 2 minutes comptait comme réussi, et beaucoup de modèles plafonnaient à 6/6.
 *
 * TOOLS et SYSTEM_PROMPT_TEMPLATE sont donc des copies EXACTES de electron/services/tools.ts et
 * electron/services/systemPrompt.ts (canal voix, sans prénom ni mémoire) — ce script tourne en node simple,
 * sans import TypeScript possible. scripts/test-benchmark-cases.mjs échoue dès que l'une des deux copies
 * diverge de l'original : régénérer alors ce fichier plutôt que de le corriger à la main.
 */

/**
 * Version du test de conversation, écrite en tête du fichier de résultats. Étape 163 : la version 1 (première
 * analyse de Léo, 25/09/2026) n'imposait pas la fenêtre de contexte, et Ollama prenait 4096 — trop peu pour les
 * vraies consignes + 14 outils (~4 600 tokens) : granite4.2 et G9v3-3B refusaient tout, les qwen recevaient des
 * consignes COUPÉES sans prévenir. Tout résultat de conversation sans cette version est donc refait, et ignoré
 * par Jaris en attendant (parseLocalBenchmark, hardwareScan.ts). À augmenter à chaque changement du test.
 * Version 3 (même étape, avant la relance de Léo) : une réponse coupée faute de place compte comme un échec,
 * plus comme « aucun outil » (qui passait pour juste sur les questions sans outil) ; vérifications moins
 * pointilleuses sur la forme (« BTC », « return », « guitar »...), pour ne noter que le fond.
 */
export const CONVERSATION_TEST_VERSION = 3

/**
 * Fenêtre de contexte des questions de conversation : la valeur minimale que Jaris utilise en vrai
 * (OLLAMA_NUM_CTX, electron/config.ts). Sans elle, Ollama prend sa valeur par défaut (4096).
 */
export const CONVERSATION_NUM_CTX = 8192

export const TOOLS = [
  {
    "type": "function",
    "function": {
      "name": "open_app",
      "description": "Ouvre n'importe quelle application installée sur l'ordinateur de l'utilisateur (pas seulement quelques applications connues : appelle toujours cet outil avec le nom demandé, il cherche lui-même parmi toutes les applications installées sur la machine).",
      "parameters": {
        "type": "object",
        "properties": {
          "app_name": {
            "type": "string",
            "description": "Nom de l'application à ouvrir, tel que demandé par l'utilisateur"
          }
        },
        "required": [
          "app_name"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "set_reminder",
      "description": "Programme un rappel vocal qui sera dit à voix haute dans un certain nombre de minutes.",
      "parameters": {
        "type": "object",
        "properties": {
          "message": {
            "type": "string",
            "description": "Le contenu du rappel à dire à voix haute"
          },
          "delay_minutes": {
            "type": "number",
            "description": "Dans combien de minutes déclencher le rappel"
          }
        },
        "required": [
          "message",
          "delay_minutes"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "look_at_screen",
      "description": "Capture une image de l'écran de l'utilisateur et la décrit, ou répond à une question précise sur ce qui y est affiché (ex: lire un message d'erreur, décrire une fenêtre ouverte).",
      "parameters": {
        "type": "object",
        "properties": {
          "question": {
            "type": "string",
            "description": "Ce qu'il faut chercher ou décrire sur l'écran, en français"
          }
        },
        "required": [
          "question"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "search_web",
      "description": "Recherche sur le web (moteur local) pour des informations récentes, actuelles, ou que tu ne connais pas avec certitude.",
      "parameters": {
        "type": "object",
        "properties": {
          "query": {
            "type": "string",
            "description": "Les mots-clés de recherche"
          }
        },
        "required": [
          "query"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "read_web_page",
      "description": "Lit le contenu texte d'une page web précise (étape 48) — à utiliser quand les extraits de search_web ne suffisent pas (détail précis manquant : adresse exacte, horaire, prix...). Prends l'URL parmi celles déjà renvoyées par un précédent appel à search_web dans cette même conversation, jamais une URL inventée.",
      "parameters": {
        "type": "object",
        "properties": {
          "url": {
            "type": "string",
            "description": "URL complète de la page à lire, trouvée via search_web"
          }
        },
        "required": [
          "url"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "remember",
      "description": "Enregistre une information importante à retenir sur le long terme dans la mémoire locale de Jaris (préférence de l'utilisateur, fait donné en conversation, résumé à garder). N'utilise cet outil que pour de l'info qui vaut la peine d'être gardée d'une conversation à l'autre, pas pour la conversation courante. Pour lier une note à une autre note existante, écris [[Titre de l'autre note]] dans le contenu.",
      "parameters": {
        "type": "object",
        "properties": {
          "title": {
            "type": "string",
            "description": "Titre court de la note (ex: \"Léo\", \"Préférences café\")"
          },
          "content": {
            "type": "string",
            "description": "Le contenu à retenir, en markdown"
          },
          "replace": {
            "type": "boolean",
            "description": "true UNIQUEMENT si l'utilisateur corrige une info déjà connue (\"mon adresse a changé\", \"en fait ce n'est plus...\") : remplace tout le contenu existant de cette note par le nouveau, sans garder l'ancienne valeur. Absent/false (par défaut) pour une info vraiment nouvelle, qui s'ajoute simplement à la suite de ce qui est déjà noté."
          }
        },
        "required": [
          "title",
          "content"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "recall_memory",
      "description": "Relit le contenu complet d'une note existante de la mémoire locale de Jaris.",
      "parameters": {
        "type": "object",
        "properties": {
          "title": {
            "type": "string",
            "description": "Le titre (ou un mot-clé du titre) de la note à relire"
          }
        },
        "required": [
          "title"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "type_text",
      "description": "Écrit du texte à l'endroit où se trouve le curseur/focus actuel sur l'ordinateur (un champ de texte, une barre de recherche, une zone de discussion déjà ouverte...), comme si l'utilisateur le tapait lui-même au clavier. Appelle cet outil directement dès que l'utilisateur demande explicitement d'écrire ou de taper quelque chose : ne vérifie JAMAIS l'écran avec look_at_screen avant, ça ne fait que ralentir inutilement — fais confiance à l'utilisateur, il sait déjà où il veut que ça tape.",
      "parameters": {
        "type": "object",
        "properties": {
          "text": {
            "type": "string",
            "description": "Le texte exact à taper"
          }
        },
        "required": [
          "text"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "press_key",
      "description": "Appuie sur une touche spéciale du clavier (par exemple pour valider un formulaire ou une recherche juste après avoir tapé du texte avec type_text).",
      "parameters": {
        "type": "object",
        "properties": {
          "key": {
            "type": "string",
            "description": "Nom de la touche : entrée, tab, échap, espace, retour arrière, suppr, haut, bas, gauche, droite, début, fin"
          }
        },
        "required": [
          "key"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "click_mouse",
      "description": "Clique avec la souris. Si l'utilisateur (ou une capture d'écran précédente via look_at_screen) donne une position précise en pixels, clique à cet endroit ; sinon clique à la position actuelle du curseur.",
      "parameters": {
        "type": "object",
        "properties": {
          "x": {
            "type": "number",
            "description": "Position horizontale en pixels sur l'écran (optionnel)"
          },
          "y": {
            "type": "number",
            "description": "Position verticale en pixels sur l'écran (optionnel)"
          },
          "button": {
            "type": "string",
            "description": "Type de clic",
            "enum": [
              "left",
              "right",
              "double"
            ]
          }
        },
        "required": []
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "get_system_stats",
      "description": "Donne l'état actuel de l'ordinateur : utilisation CPU, RAM utilisée, VRAM libre et température du GPU si disponible.",
      "parameters": {
        "type": "object",
        "properties": {},
        "required": []
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "media_control",
      "description": "Contrôle la lecture multimédia ou le volume du système, un cran à la fois (comme une touche multimédia physique) : monter/baisser le son, couper/réactiver le son, lecture/pause, piste suivante/précédente.",
      "parameters": {
        "type": "object",
        "properties": {
          "action": {
            "type": "string",
            "description": "Action à effectuer",
            "enum": [
              "volume_up",
              "volume_down",
              "mute",
              "play_pause",
              "next",
              "previous"
            ]
          }
        },
        "required": [
          "action"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "computer_use_task",
      "description": "Accomplit un objectif en pilotant réellement l'ordinateur à la souris et au clavier, comme le ferait un humain : ouvrir un site et y naviguer, cliquer des boutons/liens, remplir un formulaire, envoyer un mail (ouvre le vrai Gmail/client mail déjà connecté sur la machine), acheter/rechercher quelque chose sur un site. Décris l'objectif complet en une phrase claire (pas une suite d'étapes détaillées : l'agent regarde l'écran et improvise le détail lui-même). Plus lent qu'une réponse directe (plusieurs captures d'écran et clics avant de terminer) : préviens l'utilisateur que ça va prendre un instant plutôt que de rester silencieux pendant l'exécution.",
      "parameters": {
        "type": "object",
        "properties": {
          "goal": {
            "type": "string",
            "description": "Objectif complet et autonome, ex: \"Envoie un mail à jean@exemple.com avec pour objet 'Réunion' et pour contenu 'Je confirme demain 14h'\", \"Va sur youtube.com et cherche des tutos de guitare\", \"Ajoute le premier résultat au panier sur ce site\"."
          }
        },
        "required": [
          "goal"
        ]
      }
    }
  },
  {
    "type": "function",
    "function": {
      "name": "shutdown_pc",
      "description": "Éteint ou redémarre l'ordinateur. Action CRITIQUE et irréversible : n'appelle cet outil que si l'utilisateur a clairement et explicitement demandé d'éteindre ou de redémarrer la machine, jamais de ta propre initiative ni sur un simple soupçon.",
      "parameters": {
        "type": "object",
        "properties": {
          "restart": {
            "type": "boolean",
            "description": "true pour redémarrer, false (ou absent) pour éteindre"
          }
        },
        "required": []
      }
    }
  }
]

/** Les vraies consignes de Jaris ; {{DATE_HEURE}} est remplacé par la date et l'heure du test. */
export const SYSTEM_PROMPT_TEMPLATE = "Tu es Jaris, un assistant personnel qui tourne entièrement en local sur l'ordinateur de l'utilisateur. Réponds en français, de façon concise et naturelle, comme dans une conversation orale. Ta réponse est lue à voix haute par une synthèse vocale : n'utilise jamais d'émojis, d'astérisques, de listes à puces ni de mise en forme, uniquement du texte normal. {{DATE_HEURE}}Tu as une mémoire locale sous forme de notes markdown (comme Obsidian), encore vide. Dès que l'utilisateur te demande explicitement de retenir/mémoriser quelque chose (\"retiens que...\", \"n'oublie pas que...\", etc.), ou que tu identifies toi-même une info importante à garder sur le long terme (préférence, fait donné en conversation), tu dois IMPÉRATIVEMENT appeler l'outil remember tout de suite, dans ce même tour, avant de répondre. Ne dis jamais \"je retiens\" ou \"c'est noté\" sans avoir réellement appelé remember. Comme dans Obsidian, préfère plusieurs petites notes liées plutôt qu'une seule grosse note fourre-tout : si un sujet a plusieurs aspects distincts (ex: \"voiture\" a un modèle, un budget, un entretien), crée une note par sous-partie avec remember et relie-les avec [[Titre]] au lieu de tout empiler dans une note unique. Si l'utilisateur CORRIGE une info déjà connue (\"mon adresse a changé\", \"en fait ce n'est plus ... c'est maintenant ...\"), appelle remember avec `replace: true` pour remplacer l'ancienne valeur au lieu de l'ajouter à côté. Tu as accès à des outils pour agir réellement : ouvrir une application, programmer un rappel vocal, regarder l'écran de l'utilisateur (look_at_screen, pour décrire ou répondre à une question sans agir), accomplir un objectif en pilotant réellement la souris et le clavier comme le ferait un humain (computer_use_task : naviguer sur un site, cliquer, remplir un formulaire, envoyer un mail, acheter ou rechercher quelque chose — décris l'objectif complet en une phrase, l'outil regarde l'écran lui-même et improvise le détail des clics), donner l'état de la machine (get_system_stats : CPU, RAM, VRAM, température), contrôler le volume/la lecture multimédia (media_control), éteindre ou redémarrer l'ordinateur (shutdown_pc, à n'appeler que sur demande explicite et claire), chercher sur le web (search_web), lire le contenu complet d'une page précise déjà trouvée par search_web quand son extrait ne suffit pas (read_web_page), mémoriser ou relire une information dans ta mémoire locale, taper du texte au clavier (type_text), appuyer sur une touche (press_key), cliquer avec la souris (click_mouse) — ces trois derniers pour une action ponctuelle unique et immédiate (ex: \"appuie sur entrée\"), computer_use_task pour un objectif à plusieurs étapes qui demande de regarder l'écran entre chaque clic. Pour toute action concrète, tu dois IMPÉRATIVEMENT appeler l'outil correspondant via un vrai appel de fonction, immédiatement, sans phrase d'annonce avant — computer_use_task prend plusieurs secondes (plusieurs captures d'écran et clics avant de terminer) : dis brièvement que tu t'en occupes avant de l'appeler plutôt que de laisser un silence. Il est interdit de dire que tu vas faire une action ou que tu l'as faite sans avoir réellement appelé l'outil qui l'exécute dans ce même tour : soit tu appelles l'outil tout de suite, soit tu réponds directement sans outil. Le contenu de l'écran change en permanence : à chaque fois que l'utilisateur demande ce qui y est affiché (\"qu'est-ce que tu vois\", \"regarde l'écran\"...), tu dois appeler look_at_screen à NOUVEAU, même si tu en as déjà parlé plus tôt dans cette conversation ou que tu as une note à ce sujet dans ta mémoire : ne réponds JAMAIS à partir d'une ancienne description, uniquement à partir d'une vraie nouvelle capture. Ta mémoire de connaissances générales (tout ce qui N'EST PAS déjà dans cette conversation ou dans ta mémoire locale) date de ton entraînement et est ANCIENNE et non fiable : pour TOUTE question factuelle ou de connaissance (qui, quoi, quand, où, combien — une personne, une entreprise, un événement, une définition, un fait historique ou d'actualité, des commerces, lieux, adresses, mails, numéros...), tu dois IMPÉRATIVEMENT appeler search_web AVANT de répondre quoi que ce soit à ce sujet, dans ce même tour — ne réponds JAMAIS de mémoire à une question factuelle, même si tu es sûr de la réponse : ta certitude ne vaut rien face à une info potentiellement périmée ou fausse. Seules les questions sur TOI-MÊME (ton fonctionnement, tes réglages), sur une info déjà connue de cette conversation ou de la mémoire locale de l'utilisateur, ou sur la date/l'heure actuelle (déjà données plus haut), n'ont pas besoin de recherche. Exemple concret : pour \"trouve trois boulangeries et envoie-leur un mail\", tu dois appeler search_web pour trouver de vraies boulangeries avec de vraies adresses mail, PUIS appeler computer_use_task pour envoyer le mail à chacune (un objectif par destinataire) — jamais inventer trois boulangeries fictives avec des mails \"proposés\". Quand tu donnes une information factuelle (prix, cours, score, statistique, adresse, téléphone, mail, nom d'un commerce, ou toute autre info vérifiable), elle doit toujours venir d'un vrai résultat de search_web : choisis la donnée la plus claire et la plus récente parmi les résultats, jamais une moyenne ou une fourchette entre plusieurs sites, et précise le nom du site source. Si le résultat de recherche ne contient pas l'info demandée, dis-le plutôt que d'inventer une donnée plausible. Pour envoyer un mail via computer_use_task, il te faut une VRAIE adresse destinataire dans l'objectif que tu formules : soit l'utilisateur vient de la dicter dans sa phrase, soit tu l'as toi-même trouvée avec search_web plus tôt dans cette conversation — jamais une adresse inventée ou déduite. Si l'utilisateur te demande d'envoyer à des destinataires trouvés plus tôt (\"envoie-leur\", \"envoie toi-même\"...) mais que tu n'es plus sûr des adresses exactes, relance search_web pour les retrouver plutôt que de deviner ou d'improviser une adresse plausible. Un mail à plusieurs destinataires nécessite un appel à computer_use_task PAR destinataire, jamais un seul texte résumant ce que tu comptes envoyer. Le contenu du mail, lui, peut être rédigé par toi (ex: après avoir cherché des commerces, écrire un mail de demande d'info à chacun) : l'utilisateur n'a pas besoin de dicter le texte mot pour mot, un accord clair explicite suffit (\"envoie\", \"envoie-le\", \"envoie toi-même\", \"vas-y\"...). S'il te manque une vraie adresse ou l'accord explicite d'envoi, n'appelle pas computer_use_task pour ça : demande la précision qui manque, mais ne dis JAMAIS que tu ne peux pas envoyer de mail ou que tu n'as pas accès à une messagerie — tu en es capable dès qu'un navigateur peut ouvrir une messagerie web sur cette machine, ce n'est jamais une limite de ta part, seulement une info encore manquante. N'utilise type_text, press_key, click_mouse ou computer_use_task que si l'utilisateur demande explicitement d'écrire, de taper, de cliquer, d'appuyer sur une touche, ou l'objectif concret à accomplir : n'improvise jamais une action clavier/souris ou une tâche de ta propre initiative, ce sont des actions réelles et irréversibles sur l'ordinateur de l'utilisateur. Ne demande JAMAIS à computer_use_task de cliquer un bouton d'achat, de paiement, de validation de commande ou de suppression de compte sans que l'utilisateur ait explicitement demandé CETTE action précise dans sa phrase, même si elle semble être la suite logique de ce qui précède : décris plutôt ce que tu vois (look_at_screen) et demande confirmation avant. Quand le résultat d'un outil est un message d'échec ou d'erreur, transmets-le fidèlement (tel quel ou reformulé brièvement) : n'invente JAMAIS d'étapes de dépannage supplémentaires qui n'y figurent pas (redémarrer l'ordinateur, réinstaller un logiciel, taper une commande...), même pour avoir l'air plus utile — un message d'erreur mal compris ou incomplet reste préférable à des instructions inventées et fausses."

export function buildBenchmarkSystemPrompt(now = new Date()) {
  const dateTime =
    `Nous sommes le ${now.toLocaleDateString('fr-FR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}, ` +
    `il est ${now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}. `
  return SYSTEM_PROMPT_TEMPLATE.replace('{{DATE_HEURE}}', dateTime)
}

/** Arguments d'un appel d'outil : objet, ou chaîne JSON chez certains modèles. */
function argsOf(toolArgs) {
  if (toolArgs && typeof toolArgs === 'object') return toolArgs
  if (typeof toolArgs === 'string') {
    try {
      return JSON.parse(toolArgs)
    } catch {
      return {}
    }
  }
  return {}
}

const text = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v)).toLowerCase()
const num = (v) => (typeof v === 'number' ? v : Number(v))

/**
 * Chaque question compte : `expectedTool: null` = le modèle doit répondre SANS outil (remerciement, question
 * sur lui-même, heure déjà donnée, négation). `check` vérifie le contenu de l'appel, pas seulement son nom.
 */
export const TEST_CASES = [
  { prompt: 'Écris bonjour dans le champ de texte ouvert.', expectedTool: 'type_text', check: (a) => text(a.text).includes('bonjour') },
  { prompt: "Cherche le prix du Bitcoin aujourd'hui.", expectedTool: 'search_web', check: (a) => /bitcoin|btc/.test(text(a.query)) },
  { prompt: 'Qui est le président de la France en ce moment ?', expectedTool: 'search_web', check: (a) => /pr[ée]sident|chef de l'[ée]tat|macron|[ée]lys[ée]e/.test(text(a.query)) },
  { prompt: "Rappelle-moi d'appeler le dentiste dans 20 minutes.", expectedTool: 'set_reminder', check: (a) => num(a.delay_minutes) === 20 && text(a.message).includes('dentiste') },
  { prompt: 'Préviens-moi dans une heure et demie de sortir le linge.', expectedTool: 'set_reminder', check: (a) => num(a.delay_minutes) === 90 },
  { prompt: "Qu'est-ce qui est affiché sur mon écran en ce moment ?", expectedTool: 'look_at_screen', check: () => true },
  { prompt: 'Ouvre le bloc-notes.', expectedTool: 'open_app', check: (a) => /bloc|notepad|notes/.test(text(a.app_name)) },
  { prompt: "Lance Spotify, s'il te plaît.", expectedTool: 'open_app', check: (a) => text(a.app_name).includes('spotify') },
  { prompt: 'Retiens que mon code postal est 75001.', expectedTool: 'remember', check: (a) => text(a.content).includes('75001') || text(a.title).includes('75001') },
  { prompt: 'Monte le son.', expectedTool: 'media_control', check: (a) => a.action === 'volume_up' },
  { prompt: 'Appuie sur Entrée.', expectedTool: 'press_key', check: (a) => /entr|enter|return/.test(text(a.key)) },
  { prompt: "Combien de mémoire vive j'utilise en ce moment ?", expectedTool: 'get_system_stats', check: () => true },
  { prompt: 'Va sur YouTube et cherche un tuto de guitare.', expectedTool: 'computer_use_task', check: (a) => text(a.goal).includes('youtube') && text(a.goal).includes('guitar') },
  { prompt: "Merci, c'est parfait !", expectedTool: null },
  { prompt: "Comment tu t'appelles et qu'est-ce que tu peux faire pour moi ?", expectedTool: null },
  { prompt: 'Quelle heure est-il ?', expectedTool: null },
  { prompt: "N'éteins surtout pas l'ordinateur, je voulais juste savoir si tu m'entends.", expectedTool: null }
]

/** Vrai si la réponse du modèle est celle attendue : bon outil ET bon contenu, ou aucun outil quand il n'en faut pas. */
export function isCorrectAnswer(testCase, { toolName, toolArgs }) {
  if (testCase.expectedTool === null) return !toolName
  if (toolName !== testCase.expectedTool) return false
  return testCase.check(argsOf(toolArgs))
}
