/**
 * Liste de ce que Jaris sait faire, affichée dans Options → Découvrir (étape 108, demande de Léo :
 * "dans les option tu peut mettre tout se que jaris peut faire" ; refondue à l'étape 111, "fait une
 * meilleur présentation car on comprend pas trop").
 *
 * ÉCRIT POUR LÉO, PAS POUR LE MODÈLE. `TOOLS` (electron/services/tools.ts) décrit chaque outil pour Ollama
 * (impératif technique, parfois avec des détails d'implémentation) et vit côté main process — un module qui
 * importe `child_process`/`fs` ne peut de toute façon pas être empaqueté dans le renderer. Ce fichier est
 * une redite volontairement DIFFÉRENTE, en langage courant, groupée par usage plutôt que par ordre d'ajout.
 *
 * CE QUI A CHANGÉ À L'ÉTAPE 111, et pourquoi : chaque entrée avait UNE seule longue description qui mélangeait
 * trois choses — ce que c'est, comment on s'en sert, et des détails techniques (SearXNG, VRAM, "second
 * agent"). Rendue telle quelle, ça donnait un pavé de texte par ligne, et la phrase à DIRE — la seule chose
 * dont Léo a vraiment besoin — était noyée au milieu. Désormais : `description` dit à quoi ça sert en une
 * phrase courte, et `example` porte la phrase exacte à prononcer, affichée à part. Les détails techniques
 * sont simplement supprimés : ils n'aidaient personne ici, et ils vivent déjà dans le code.
 *
 * COMMENT ÇA NE DÉSYNCHRONISE PAS DE `TOOLS` : chaque capacité qui correspond à un outil précis porte son
 * `toolNames` (le(s) nom(s) exacts de `tools.ts`). `scripts/test-capabilities.mjs` relit `tools.ts` et
 * vérifie qu'AUCUN outil n'y existe sans être couvert ici — un outil ajouté sans mise à jour de ce fichier
 * fait échouer le test, plutôt que de laisser Léo croire que la liste est complète alors qu'elle a pris du
 * retard (même discipline que `findLeakedToolName`, dérivé de `TOOLS` pour la même raison).
 *
 * Une capacité SANS `toolNames` décrit une fonctionnalité de l'application elle-même (mode Code, plusieurs
 * conversations...), pas un appel d'outil : rien dans `tools.ts` ne peut la couvrir, donc rien ne l'exige.
 */
export interface Capability {
  title: string
  /** À quoi ça sert, en une phrase courte — jamais le détail de l'implémentation. */
  description: string
  /** La phrase exacte à dire pour déclencher ça, affichée à part (sans guillemets : le rendu les ajoute). */
  example?: string
  /** Vrai pour une entrée qui explique ce que Jaris NE peut PAS faire : affichée en note, pas en carte. */
  limitation?: boolean
  /** Noms exacts dans `TOOLS` (tools.ts) si cette capacité correspond à un ou plusieurs outils précis.
   *  Sert uniquement à la vérification de synchronisation, jamais affiché à Léo. */
  toolNames?: string[]
}

export interface CapabilityGroup {
  title: string
  /** Une ligne qui situe le groupe, affichée sous son titre. */
  summary: string
  /** Étiquette devant les exemples du groupe. "Dis" par défaut — le mode Code, lui, se pilote au clavier
   *  dans son propre champ, jamais à la voix : y afficher "Dis" serait une consigne fausse. */
  exampleLabel?: string
  items: Capability[]
}

export const CAPABILITIES: CapabilityGroup[] = [
  {
    title: 'Sur ton ordinateur',
    summary: 'Jaris fait à ta place ce que tu ferais à la souris et au clavier.',
    items: [
      {
        title: 'Ouvrir une application',
        description: 'Cherche parmi tout ce qui est installé : rien à configurer, rien à tenir à jour.',
        example: 'ouvre le bloc-notes',
        toolNames: ['open_app']
      },
      {
        title: 'Écrire du texte à ta place',
        description: 'Dicte, Jaris tape là où ton curseur clignote.',
        // Jamais de guillemets DANS un exemple : le rendu l'encadre déjà des siens (OptionsMenu.tsx), et
        // deux niveaux imbriqués donnaient « écris « bonjour... » » — vu sur une capture, pas en relecture.
        example: 'écris merci beaucoup, à demain',
        toolNames: ['type_text']
      },
      {
        title: 'Appuyer sur une touche, cliquer',
        description: 'Valider, fermer, cliquer quelque part — sans lâcher ce que tu fais.',
        example: 'appuie sur Entrée',
        toolNames: ['press_key', 'click_mouse']
      },
      {
        title: 'Régler le son',
        description: 'Volume, coupure du son, lecture, pause, piste suivante.',
        example: 'baisse le son',
        toolNames: ['media_control']
      },
      {
        title: 'Regarder ton écran',
        description: 'Te décrit ce qui est affiché, ou répond à une question précise dessus.',
        example: "qu'est-ce qu'il y a à l'écran ?",
        toolNames: ['look_at_screen']
      },
      {
        title: 'Faire une tâche complète tout seul',
        description: 'Plusieurs actions à la suite, en pilotant la souris et le clavier. Plus lent : Jaris te prévient avant de s\'y mettre.',
        example: 'ouvre YouTube et cherche un tuto guitare',
        toolNames: ['computer_use_task']
      },
      {
        title: "Te dire l'état de la machine",
        description: 'Processeur, mémoire, carte graphique, température.',
        example: 'ça chauffe, mon PC ?',
        toolNames: ['get_system_stats']
      },
      {
        title: 'Éteindre ou redémarrer le PC',
        description: 'Seulement si tu le demandes clairement — jamais de sa propre initiative.',
        example: "éteins l'ordinateur",
        toolNames: ['shutdown_pc']
      }
    ]
  },
  {
    title: 'Chercher une information',
    summary: 'Pour ce que Jaris ne sait pas, ou ce qui a changé depuis.',
    items: [
      {
        title: 'Chercher sur le web',
        description: "Pour une info récente ou dont il n'est pas sûr. La recherche tourne sur ta machine, pas chez un service payant.",
        example: 'quel temps il fait demain ?',
        toolNames: ['search_web']
      },
      {
        title: 'Lire une page précise',
        description: "Quand un extrait de recherche ne suffit pas : horaire exact, adresse, prix.",
        example: 'lis-moi cette page et résume-la',
        toolNames: ['read_web_page']
      }
    ]
  },
  {
    title: 'Se souvenir de toi',
    summary: "Ce que tu lui dis une fois, il le garde — sur ton disque, jamais en ligne.",
    items: [
      {
        title: 'Retenir quelque chose',
        description: 'Une habitude, une préférence, un fait — retrouvé même après un redémarrage.',
        example: 'retiens que je bois du thé, pas du café',
        toolNames: ['remember']
      },
      {
        title: 'Te le ressortir plus tard',
        description: 'Il relit ce qu\'il a noté dès que tu y fais référence.',
        example: 'je bois quoi le matin, déjà ?',
        toolNames: ['recall_memory']
      },
      {
        title: 'Te rappeler quelque chose à l\'heure dite',
        description: 'Dit à voix haute au bon moment, même si Jaris a été relancé entre-temps.',
        example: 'rappelle-moi de sortir le linge dans 10 minutes',
        toolNames: ['set_reminder']
      }
    ]
  },
  {
    title: 'Ton téléphone',
    summary: 'Ce que Mobile connecté a déjà recopié sur le PC. Rien ne part sur internet.',
    items: [
      {
        title: 'Qui t\'a appelé',
        description: 'Les derniers appels, avec le nom quand il est connu.',
        example: "qui m'a appelé aujourd'hui ?",
        toolNames: ['read_call_history']
      },
      {
        title: 'Le numéro d\'un contact',
        description: 'Cherche dans les contacts recopiés sur le PC.',
        example: "c'est quoi le numéro de maman ?",
        toolNames: ['find_contact']
      },
      {
        title: 'Les messages, eux, sont hors de portée',
        description: "Mobile connecté ne les garde pas sur le disque, et Apple interdit d'en envoyer depuis un ordinateur. Jaris te le dit plutôt que de faire semblant.",
        limitation: true
      }
    ]
  },
  {
    title: 'Créer une application (mode Code)',
    summary: "Décris ce que tu veux, Jaris l'écrit et te le montre tout de suite.",
    exampleLabel: 'Écris',
    items: [
      {
        title: 'Partir d\'une idée',
        description: "Jaris écrit la page, se relit lui-même, et corrige ce qu'il trouve. Tu peux joindre une image comme modèle.",
        example: 'un minuteur de cuisine avec un gros bouton'
      },
      {
        title: 'Changer ce qui existe déjà',
        description: 'Redemande un changement sur une application ouverte : elle est mise à jour sur place.',
        example: 'mets le fond en noir et le texte en plus gros'
      },
      {
        title: 'Retrouver tes créations',
        description: "Elles restent toutes dans la colonne de gauche après un redémarrage, et tu peux en supprimer.",
      }
    ]
  },
  {
    title: 'Discuter par écrit',
    summary: "Le Chat, pour quand tu ne veux pas parler à voix haute.",
    items: [
      {
        title: 'Plusieurs conversations séparées',
        description: 'Comme sur ChatGPT : un fil par sujet, chacun avec son propre historique.'
      },
      {
        title: 'Lui montrer une image',
        description: 'Joins une photo ou une capture : Jaris la décrit, ou s\'en sert comme modèle en mode Code.'
      },
      {
        title: 'Continuer à la voix',
        description: 'Ce que tu dis à voix haute continue la conversation ouverte dans le Chat, et inversement.'
      }
    ]
  }
]
