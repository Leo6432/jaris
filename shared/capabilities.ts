import type { MessageKey } from './i18n'
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
// Étape 293 (24 langues) : chaque texte est une CLÉ du catalogue (shared/i18n/fr.ts), traduite au rendu. Le
// français source de chaque clé reste lisible dans fr.ts, sous `capabilities.*`.
export interface Capability {
  title: MessageKey
  /** À quoi ça sert, en une phrase courte — jamais le détail de l'implémentation. */
  description: MessageKey
  /** La phrase exacte à dire pour déclencher ça, affichée à part (sans guillemets : le rendu les ajoute). */
  example?: MessageKey
  /** Vrai pour une entrée qui explique ce que Jaris NE peut PAS faire : affichée en note, pas en carte. */
  limitation?: boolean
  /** Noms exacts dans `TOOLS` (tools.ts) si cette capacité correspond à un ou plusieurs outils précis.
   *  Sert uniquement à la vérification de synchronisation, jamais affiché à Léo. */
  toolNames?: string[]
}

export interface CapabilityGroup {
  title: MessageKey
  /** Une ligne qui situe le groupe, affichée sous son titre. */
  summary: MessageKey
  /** Étiquette devant les exemples du groupe. "Dis" par défaut — le mode Code, lui, se pilote au clavier
   *  dans son propre champ, jamais à la voix : y afficher "Dis" serait une consigne fausse. */
  exampleLabel?: MessageKey
  items: Capability[]
}

export const CAPABILITIES: CapabilityGroup[] = [
  {
    title: 'capabilities.g1.title',
    summary: 'capabilities.g1.summary',
    items: [
      {
        title: 'capabilities.g1.i1.title',
        description: 'capabilities.g1.i1.description',
        example: 'capabilities.g1.i1.example',
        toolNames: ['open_app']
      },
      {
        title: 'capabilities.g1.i2.title',
        description: 'capabilities.g1.i2.description',
        // Jamais de guillemets DANS un exemple : le rendu l'encadre déjà des siens (OptionsMenu.tsx), et
        // deux niveaux imbriqués donnaient « écris « bonjour... » » — vu sur une capture, pas en relecture.
        example: 'capabilities.g1.i2.example',
        toolNames: ['type_text']
      },
      {
        title: 'capabilities.g1.i3.title',
        description: 'capabilities.g1.i3.description',
        example: 'capabilities.g1.i3.example',
        toolNames: ['press_key', 'click_mouse']
      },
      {
        title: 'capabilities.g1.i4.title',
        description: 'capabilities.g1.i4.description',
        example: 'capabilities.g1.i4.example',
        toolNames: ['media_control']
      },
      {
        title: 'capabilities.g1.i5.title',
        description: 'capabilities.g1.i5.description',
        example: 'capabilities.g1.i5.example',
        toolNames: ['look_at_screen']
      },
      {
        title: 'capabilities.g1.i6.title',
        description: 'capabilities.g1.i6.description',
        example: 'capabilities.g1.i6.example',
        toolNames: ['computer_use_task']
      },
      {
        title: 'capabilities.g1.i7.title',
        description: 'capabilities.g1.i7.description',
        example: 'capabilities.g1.i7.example',
        toolNames: ['generate_image']
      },
      {
        title: 'capabilities.g1.i8.title',
        description: 'capabilities.g1.i8.description',
        example: 'capabilities.g1.i8.example',
        toolNames: ['get_system_stats']
      },
      {
        title: 'capabilities.g1.i9.title',
        description: 'capabilities.g1.i9.description',
        example: 'capabilities.g1.i9.example',
        toolNames: ['shutdown_pc']
      }
    ]
  },
  {
    title: 'capabilities.g2.title',
    summary: 'capabilities.g2.summary',
    items: [
      {
        title: 'capabilities.g2.i1.title',
        description: 'capabilities.g2.i1.description',
        example: 'capabilities.g2.i1.example',
        toolNames: ['search_web']
      },
      {
        title: 'capabilities.g2.i2.title',
        description: 'capabilities.g2.i2.description',
        example: 'capabilities.g2.i2.example',
        toolNames: ['read_web_page']
      }
    ]
  },
  {
    title: 'capabilities.g3.title',
    summary: 'capabilities.g3.summary',
    items: [
      {
        title: 'capabilities.g3.i1.title',
        description: 'capabilities.g3.i1.description',
        example: 'capabilities.g3.i1.example',
        toolNames: ['remember']
      },
      {
        title: 'capabilities.g3.i2.title',
        description: 'capabilities.g3.i2.description',
        example: 'capabilities.g3.i2.example',
        toolNames: ['recall_memory']
      },
      {
        title: 'capabilities.g3.i3.title',
        description: 'capabilities.g3.i3.description',
        example: 'capabilities.g3.i3.example',
        toolNames: ['set_reminder']
      }
    ]
  },
  {
    title: 'capabilities.g4.title',
    summary: 'capabilities.g4.summary',
    exampleLabel: 'capabilities.write',
    items: [
      {
        title: 'capabilities.g4.i1.title',
        description: 'capabilities.g4.i1.description',
        example: 'capabilities.g4.i1.example'
      },
      {
        title: 'capabilities.g4.i2.title',
        description: 'capabilities.g4.i2.description',
        example: 'capabilities.g4.i2.example'
      },
      {
        title: 'capabilities.g4.i3.title',
        description: 'capabilities.g4.i3.description',
      }
    ]
  },
  {
    title: 'capabilities.g5.title',
    summary: 'capabilities.g5.summary',
    exampleLabel: 'capabilities.write',
    items: [
      {
        title: 'capabilities.g5.i1.title',
        description: 'capabilities.g5.i1.description',
        example: 'capabilities.g5.i1.example'
      },
      {
        title: 'capabilities.g5.i2.title',
        description: 'capabilities.g5.i2.description'
      }
    ]
  },
  {
    title: 'capabilities.g6.title',
    summary: 'capabilities.g6.summary',
    exampleLabel: 'capabilities.write',
    items: [
      {
        title: 'capabilities.g6.i1.title',
        description: 'capabilities.g6.i1.description',
        example: 'capabilities.g6.i1.example'
      },
      {
        title: 'capabilities.g6.i2.title',
        description: 'capabilities.g6.i2.description'
      },
      {
        title: 'capabilities.g6.i3.title',
        description: 'capabilities.g6.i3.description'
      }
    ]
  },
  {
    title: 'capabilities.g7.title',
    summary: 'capabilities.g7.summary',
    items: [
      {
        title: 'capabilities.g7.i1.title',
        description: 'capabilities.g7.i1.description'
      },
      {
        title: 'capabilities.g7.i2.title',
        description: 'capabilities.g7.i2.description'
      },
      {
        title: 'capabilities.g7.i3.title',
        description: 'capabilities.g7.i3.description'
      },
      {
        title: 'capabilities.g7.i4.title',
        description: 'capabilities.g7.i4.description'
      }
    ]
  }
]
