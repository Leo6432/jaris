/**
 * Liste de ce que Jaris sait faire, affichée dans Options → Capacités (étape 108, demande de Léo :
 * "dans les option tu peut mettre tout se que jaris peut faire").
 *
 * ÉCRIT POUR LÉO, PAS POUR LE MODÈLE. `TOOLS` (electron/services/tools.ts) décrit chaque outil pour Ollama
 * (impératif technique, parfois avec des détails d'implémentation) et vit côté main process — un module qui
 * importe `child_process`/`fs` ne peut de toute façon pas être empaqueté dans le renderer. Ce fichier est
 * une redite volontairement DIFFÉRENTE, en langage courant, groupée par usage plutôt que par ordre d'ajout.
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
  description: string
  /** Noms exacts dans `TOOLS` (tools.ts) si cette capacité correspond à un ou plusieurs outils précis.
   *  Sert uniquement à la vérification de synchronisation, jamais affiché à Léo. */
  toolNames?: string[]
}

export interface CapabilityGroup {
  title: string
  items: Capability[]
}

export const CAPABILITIES: CapabilityGroup[] = [
  {
    title: 'Sur ton ordinateur',
    items: [
      {
        title: 'Ouvrir une application',
        description: '« ouvre le bloc-notes », « lance Spotify »… — cherche parmi tout ce qui est installé, aucune liste à tenir à jour.',
        toolNames: ['open_app']
      },
      {
        title: 'Écrire, appuyer sur une touche, cliquer',
        description: 'Dicte un texte pour qu\'il soit tapé là où tu as le curseur, valide avec une touche, ou clique à ta place.',
        toolNames: ['type_text', 'press_key', 'click_mouse']
      },
      {
        title: 'Régler le son et la lecture',
        description: 'Monter/baisser le volume, couper le son, lecture/pause, piste suivante — comme les touches multimédia du clavier.',
        toolNames: ['media_control']
      },
      {
        title: "Voir l'état de la machine",
        description: 'Utilisation du processeur, mémoire utilisée, VRAM libre, température de la carte graphique.',
        toolNames: ['get_system_stats']
      },
      {
        title: "Regarder l'écran",
        description: 'Décrit ce qui est affiché, ou répond à une question précise dessus (« il y a un message d\'erreur ? »).',
        toolNames: ['look_at_screen']
      },
      {
        title: 'Accomplir une tâche complète en pilotant la souris et le clavier',
        description: 'Naviguer sur un site, remplir un formulaire, envoyer un mail déjà connecté sur la machine — plus lent qu\'une réponse directe, Jaris te prévient avant de s\'y mettre.',
        toolNames: ['computer_use_task']
      },
      {
        title: 'Éteindre ou redémarrer le PC',
        description: "Seulement si tu le demandes clairement — jamais de sa propre initiative ni sur un simple soupçon.",
        toolNames: ['shutdown_pc']
      }
    ]
  },
  {
    title: 'Sur le web',
    items: [
      {
        title: 'Chercher sur le web',
        description: "Pour une info récente ou qu'il ne connaît pas avec certitude — moteur de recherche local (SearXNG), sans passer par un service payant.",
        toolNames: ['search_web']
      },
      {
        title: 'Lire une page web précise',
        description: "Quand un simple extrait de recherche ne suffit pas (adresse exacte, horaire, prix...).",
        toolNames: ['read_web_page']
      }
    ]
  },
  {
    title: 'Mémoire',
    items: [
      {
        title: 'Retenir une information',
        description: 'Une préférence, un fait donné en conversation — gardé d\'une session à l\'autre, consultable dans le cerveau de Jaris (graphe 3D).',
        toolNames: ['remember']
      },
      {
        title: 'Se souvenir',
        description: "Relit une note déjà enregistrée quand tu y fais référence plus tard.",
        toolNames: ['recall_memory']
      }
    ]
  },
  {
    title: 'Rappels',
    items: [
      {
        title: 'Programmer un rappel',
        description: '« rappelle-moi de sortir le linge dans 10 minutes » — dit à voix haute à l\'heure prévue, même si Jaris vient d\'être relancé entre-temps.',
        toolNames: ['set_reminder']
      }
    ]
  },
  {
    title: 'Téléphone (via Mobile connecté)',
    items: [
      {
        title: 'Historique des appels',
        description: '« qui m\'a appelé ? » — lit ce que Mobile connecté a déjà recopié sur cet ordinateur, sans rien envoyer sur internet.',
        toolNames: ['read_call_history']
      },
      {
        title: 'Retrouver un contact',
        description: '« c\'est quoi le numéro de maman ? » — recherche dans les contacts recopiés sur le PC.',
        toolNames: ['find_contact']
      },
      {
        title: 'Ce qui reste impossible : les messages',
        description: "Mobile connecté ne les garde pas sur le disque (constaté), et Apple interdit d'en envoyer depuis un ordinateur — Jaris le dit plutôt que de faire semblant."
      }
    ]
  },
  {
    title: 'Mode Code',
    items: [
      {
        title: 'Générer une application complète',
        description: "Décris ce que tu veux (éventuellement avec une image de référence) : Jaris écrit une page HTML autonome, se relit lui-même, et corrige les problèmes qu'il trouve.",
      },
      {
        title: 'Modifier une application déjà générée',
        description: 'Redemande un changement sur une application ouverte : elle est mise à jour sur place, avec le même suivi en direct.'
      },
      {
        title: 'Retrouver et supprimer tes applications',
        description: "Toutes tes créations restent listées après un redémarrage de Jaris, avec un moyen de les effacer si tu n'en veux plus."
      }
    ]
  },
  {
    title: 'Chat et conversations',
    items: [
      {
        title: 'Plusieurs conversations séparées',
        description: 'Comme sur Claude ou ChatGPT : change de fil de discussion sans mélanger les sujets, chacun garde son propre historique.'
      },
      {
        title: 'Envoyer une image',
        description: "Joins une image au Chat ou au mode Code pour que Jaris la décrive ou s'en serve comme référence."
      }
    ]
  }
]
