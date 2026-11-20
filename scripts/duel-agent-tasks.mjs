import { norm } from './benchmark-scenarios.mjs'

/**
 * Étape 506 (Léo : « ajoute plein de propositions agentique, et aussi les séries dans Agentique ») : des tâches EN PLUS
 * de celles du test des modèles, pour le duel Agentique seulement — le test des modèles (et ses scores vérifiés) n'en
 * voit aucune. Même forme que SCENARIOS (benchmark-scenarios.mjs) : jouées par runScenario sur le même PC simulé, avec
 * les mêmes règles communes (judge) et un jugement propre à chaque tâche. En français, comme le test.
 * Chaque tâche a son jugement vérifié par test-duel-agent-tasks.mjs : une bonne façon de faire passe, une mauvaise non.
 */

const callsOf = (ctx, name, turn) => ctx.calls.filter((c) => c.name === name && (turn === undefined || c.turn === turn))
const replyOf = (ctx, turn = ctx.turns.length - 1) => norm(ctx.turns[turn]?.reply)
const has = (text, pattern) => pattern.test(norm(text))
const typedText = (ctx) => ctx.state.typed.map((t) => norm(t.text)).join(' ')
const opened = (ctx, app) => ctx.state.opened.some((o) => o.app === app)

/** Une page ou un résultat de recherche seulement quand la requête parle du bon sujet. */
const searchFor = (pattern, text) => (q) => (pattern.test(q) ? text : undefined)

export const DUEL_AGENT_TASKS = [
  // --- Applications ---
  {
    id: 'duel-calculatrice',
    family: 'Applications',
    turns: ['Ouvre la calculatrice.'],
    allow: ['open_app'],
    check: (ctx) => (opened(ctx, 'Calculatrice') ? null : 'la calculatrice n’a jamais été ouverte')
  },
  {
    id: 'duel-steam-discord',
    family: 'Applications',
    turns: ['Lance Steam puis Discord.'],
    allow: ['open_app'],
    check: (ctx) => {
      if (!opened(ctx, 'Steam')) return 'Steam jamais ouvert'
      return opened(ctx, 'Discord') ? null : 'Discord jamais ouvert'
    }
  },
  {
    id: 'duel-parametres',
    family: 'Applications',
    turns: ['Ouvre les paramètres de Windows.'],
    allow: ['open_app', 'computer_use_task'],
    check: (ctx) => (opened(ctx, 'Paramètres') || ctx.state.computerTasks.some((t) => has(t.goal, /parametre/)) ? null : 'les paramètres ne sont jamais ouverts')
  },
  {
    id: 'duel-photoshop-absent',
    family: 'Applications',
    // open_app en échec répond lui-même (« aucune application nommée… ») : ce qui se juge ici, c'est un modèle qui
    // affirme sans avoir essayé.
    turns: ['Ouvre Photoshop.'],
    allow: ['open_app'],
    check: (ctx) => {
      const reply = replyOf(ctx)
      if (/\b(est ouvert|est lance|j ai ouvert|j ai lance|c est ouvert|c est fait)\b/.test(reply) && !/\b(pas|aucune?|introuvable)\b/.test(reply)) {
        return 'dit avoir ouvert Photoshop, qui n’est pas installé'
      }
      return /\b(pas|aucune?|introuvable|installe)\b/.test(reply) ? null : 'ne dit pas que Photoshop est introuvable'
    }
  },
  {
    id: 'duel-spotify-lecture',
    family: 'Applications',
    turns: ['Lance Spotify et mets la musique en route.'],
    allow: ['open_app', 'media_control'],
    check: (ctx) => {
      if (!opened(ctx, 'Spotify')) return 'Spotify jamais ouvert'
      return ctx.state.media.some((m) => m.action === 'play_pause') ? null : 'la musique n’a jamais été lancée'
    }
  },

  // --- Écrire ---
  {
    id: 'duel-liste-courses',
    family: 'Écrire',
    turns: ['Ouvre le bloc-notes et écris la liste : pain, lait, œufs.'],
    allow: ['open_app', 'type_text', 'press_key'],
    check: (ctx) => {
      if (!opened(ctx, 'Bloc-notes')) return 'le bloc-notes n’a jamais été ouvert'
      // Brut, en minuscules : norm() enlève « œ » (« œufs » deviendrait « ufs »).
      const typed = ctx.state.typed.map((t) => t.text.toLowerCase()).join(' ')
      return /pain/.test(typed) && /lait/.test(typed) && /(œ|oe)ufs?/.test(typed) ? null : 'la liste (pain, lait, œufs) n’a pas été écrite en entier'
    }
  },
  {
    id: 'duel-discord-retard',
    family: 'Écrire',
    turns: ["Ouvre Discord et écris « j'arrive dans 10 minutes »."],
    allow: ['open_app', 'type_text', 'press_key', 'computer_use_task'],
    check: (ctx) => {
      if (!opened(ctx, 'Discord') && !ctx.state.computerTasks.length) return 'Discord jamais ouvert'
      const typed = typedText(ctx) + ' ' + ctx.state.computerTasks.map((t) => norm(t.goal)).join(' ')
      return /arrive/.test(typed) && /10/.test(typed) ? null : 'le message « j’arrive dans 10 minutes » n’a pas été écrit'
    }
  },
  {
    id: 'duel-ecrire-entree',
    family: 'Écrire',
    turns: ['Écris « bonjour à tous » et appuie sur Entrée.'],
    allow: ['type_text', 'press_key'],
    check: (ctx) => {
      if (!/bonjour a tous/.test(typedText(ctx))) return '« bonjour à tous » n’a pas été écrit'
      return ctx.state.keys.some((k) => /entr|enter/.test(norm(k.key))) ? null : 'Entrée n’a jamais été pressée'
    }
  },
  {
    id: 'duel-mail-reunion',
    family: 'Écrire',
    turns: ['Envoie un mail à Julie pour lui dire que la réunion est décalée à 15 h.'],
    allow: ['computer_use_task', 'open_app'],
    check: (ctx) => {
      const goals = ctx.state.computerTasks.map((t) => norm(t.goal))
      if (!goals.length) return 'aucun mail envoyé (rien fait à l’écran)'
      return goals.some((g) => /julie/.test(g) && /15/.test(g)) ? null : 'le mail ne parle pas à Julie de 15 h'
    }
  },

  // --- Musique et son ---
  {
    id: 'duel-pause',
    family: 'Musique et son',
    turns: ['Mets la musique en pause.'],
    allow: ['media_control'],
    check: (ctx) => (ctx.state.media.some((m) => m.action === 'play_pause') ? null : 'la musique n’a pas été mise en pause')
  },
  {
    id: 'duel-suivante-plus-fort',
    family: 'Musique et son',
    turns: ['Passe à la chanson suivante et monte le son.'],
    allow: ['media_control'],
    check: (ctx) => {
      if (!ctx.state.media.some((m) => m.action === 'next')) return 'pas passé à la chanson suivante'
      return ctx.state.media.some((m) => m.action === 'volume_up') ? null : 'le son n’a pas été monté'
    }
  },
  {
    id: 'duel-couper-son',
    family: 'Musique et son',
    turns: ['Coupe le son.'],
    allow: ['media_control'],
    check: (ctx) => (ctx.state.media.some((m) => m.action === 'mute') ? null : 'le son n’a pas été coupé')
  },
  {
    id: 'duel-baisser-deux-fois',
    family: 'Musique et son',
    turns: ['Baisse le son deux fois.'],
    allow: ['media_control'],
    check: (ctx) => (ctx.state.media.filter((m) => m.action === 'volume_down').length >= 2 ? null : 'le son n’a pas été baissé deux fois')
  },

  // --- Rappels ---
  {
    id: 'duel-rappel-pates',
    family: 'Rappels',
    turns: ['Rappelle-moi de sortir les pâtes dans 9 minutes.'],
    allow: ['set_reminder'],
    check: (ctx) => (ctx.state.reminders.some((r) => r.delay === 9 && has(r.message, /pates/)) ? null : 'pas de rappel « pâtes » dans 9 minutes')
  },
  {
    id: 'duel-rappel-maman',
    family: 'Rappels',
    turns: ["Rappelle-moi d'appeler maman dans une heure et demie."],
    allow: ['set_reminder'],
    check: (ctx) => (ctx.state.reminders.some((r) => r.delay === 90 && has(r.message, /maman/)) ? null : 'pas de rappel « maman » dans 90 minutes')
  },
  {
    id: 'duel-the-linge',
    family: 'Rappels',
    turns: ['Mets un rappel dans 5 minutes pour le thé et un autre dans 20 minutes pour le linge.'],
    allow: ['set_reminder'],
    check: (ctx) => {
      if (!ctx.state.reminders.some((r) => r.delay === 5 && has(r.message, /the/))) return 'pas de rappel « thé » dans 5 minutes'
      return ctx.state.reminders.some((r) => r.delay === 20 && has(r.message, /linge/)) ? null : 'pas de rappel « linge » dans 20 minutes'
    }
  },
  {
    id: 'duel-rappel-poste-demain',
    family: 'Rappels',
    // SCENARIO_NOW : dimanche 4 octobre 2026, 10 h. Demain 10 h = dans 24 heures.
    turns: ["Rappelle-moi demain à 10 h d'aller à la poste."],
    allow: ['set_reminder'],
    check: (ctx) => (ctx.state.reminders.some((r) => r.delay === 1440 && has(r.message, /poste/)) ? null : 'pas de rappel « poste » demain à 10 h (dans 1440 minutes)')
  },
  {
    id: 'duel-rappel-paul-corrige',
    family: 'Rappels',
    turns: ['Rappelle-moi de rappeler Paul dans 10 minutes.', 'Non, plutôt dans un quart d’heure.'],
    allow: ['set_reminder'],
    check: (ctx) => {
      if (!ctx.state.reminders.some((r) => r.turn === 0 && r.delay === 10)) return 'premier rappel (10 minutes) jamais créé'
      return ctx.state.reminders.some((r) => r.turn === 1 && r.delay === 15 && has(r.message, /paul/)) ? null : 'au 2e message, pas de rappel « Paul » dans 15 minutes'
    }
  },

  // --- Mémoire ---
  {
    id: 'duel-code-portail',
    family: 'Mémoire',
    turns: ['Retiens que le code du portail est 4821.'],
    check: (ctx) => (callsOf(ctx, 'remember').some((c) => /4821/.test(String(c.args.content ?? '') + String(c.args.title ?? ''))) ? null : 'le code 4821 n’a pas été noté')
  },
  {
    id: 'duel-pneus',
    family: 'Mémoire',
    turns: ["Quand est-ce que j'ai changé les pneus de la voiture ?"],
    setup: { notes: { Voiture: 'Pneus avant changés le 3 mars 2026 au garage Martin.' } },
    check: (ctx) => {
      if (!callsOf(ctx, 'recall_memory').length) return 'n’a pas relu ses notes'
      return /3 mars/.test(replyOf(ctx)) ? null : 'la date (3 mars) n’est pas dans la réponse'
    }
  },
  {
    id: 'duel-anniversaire-tom',
    family: 'Mémoire',
    turns: ['Ajoute à mes anniversaires que Tom est né le 8 août.'],
    setup: { notes: { Anniversaires: 'Maman : 12 juin.' } },
    check: (ctx) => {
      const note = [...ctx.state.notes.entries()].find(([title]) => /anniversaire/i.test(norm(title)))?.[1] ?? ''
      if (!/tom/.test(norm(note)) || !/8 aout/.test(norm(note))) return 'Tom (8 août) n’est pas dans la note des anniversaires'
      return /maman/.test(norm(note)) ? null : 'l’anniversaire de maman a été effacé'
    }
  },

  // --- Chercher sur le Web ---
  {
    id: 'duel-cinema',
    family: 'Chercher',
    turns: ['À quelle heure passe Dune au Gaumont de Rennes ce soir ?'],
    setup: {
      search: searchFor(
        /dune|gaumont|cinema|seance/,
        '1. Dune : Troisième partie — Gaumont Rennes — Séances de ce soir : 18 h 10, 20 h 45 et 22 h 30 (VF), 21 h 15 (VOST). (https://www.cinemaspathegaumont.com/cinemas/gaumont-rennes)'
      )
    },
    check: (ctx) => {
      if (!callsOf(ctx, 'search_web').length) return 'répondu sans chercher'
      const reply = String(ctx.turns.at(-1)?.reply ?? '')
      return /20\s*h\s*45|20:45/.test(reply) || /18\s*h\s*10|18:10/.test(reply) ? null : 'aucun horaire trouvé dans la réponse'
    }
  },
  {
    id: 'duel-parapluie',
    family: 'Chercher',
    turns: ['Est-ce que je dois prendre un parapluie demain à Nantes ?'],
    setup: {
      search: searchFor(/nantes|meteo|pluie/, '1. Météo Nantes demain — Météo-France — Lundi 5 octobre : pluie toute la journée, 14 °C, rafales à 50 km/h. (https://meteofrance.com/previsions-meteo-france/nantes/44000)')
    },
    check: (ctx) => {
      if (!callsOf(ctx, 'search_web').length) return 'répondu sans chercher'
      const reply = replyOf(ctx)
      if (!/pluie|pleu/.test(reply)) return 'ne dit pas qu’il va pleuvoir'
      return /\b(pas besoin|inutile|pas la peine)\b/.test(reply) ? 'déconseille le parapluie alors qu’il va pleuvoir' : null
    }
  },
  {
    id: 'duel-mairie-noter',
    family: 'Chercher',
    turns: ['Trouve le numéro de la mairie de Bruz et note-le.'],
    setup: {
      search: searchFor(/mairie|bruz/, '1. Mairie de Bruz — Contact — Place du Docteur Joly, 35170 Bruz. Téléphone : 02 99 05 44 30. Ouvert du lundi au vendredi. (https://www.ville-bruz.fr/contact)')
    },
    check: (ctx) => {
      if (!callsOf(ctx, 'search_web').length) return 'le numéro n’a pas été cherché'
      const noted = callsOf(ctx, 'remember').some((c) => /02 ?99 ?05 ?44 ?30|0299054430/.test(String(c.args.content ?? '')))
      return noted ? null : 'le numéro trouvé (02 99 05 44 30) n’a pas été noté'
    }
  },
  {
    id: 'duel-mediatheque-page',
    family: 'Chercher',
    turns: ['Quels sont les horaires de la médiathèque de Pacé le mercredi ?'],
    setup: {
      search: searchFor(
        /mediatheque|pace|horaire/,
        '1. Médiathèque Le Cube — Ville de Pacé — Présentation, animations, horaires et tarifs sur la page de la médiathèque. (https://www.ville-pace.fr/mediatheque)'
      ),
      pages: {
        'https://www.ville-pace.fr/mediatheque':
          'Médiathèque Le Cube. Horaires : mardi 16 h - 19 h ; mercredi 10 h - 12 h 30 et 14 h - 18 h ; vendredi 16 h - 19 h ; samedi 10 h - 17 h.'
      }
    },
    check: (ctx) => {
      if (!callsOf(ctx, 'read_web_page').length) return 'la page de la médiathèque n’a pas été lue'
      const reply = String(ctx.turns.at(-1)?.reply ?? '')
      return /14\s*h|14:00/.test(reply) && /10\s*h|10:00/.test(reply) ? null : 'les horaires du mercredi ne sont pas dans la réponse'
    }
  },

  // --- Le PC ---
  {
    id: 'duel-temperature',
    family: 'Le PC',
    turns: ['Ma carte graphique chauffe ? Donne-moi sa température.'],
    allow: ['get_system_stats'],
    check: (ctx) => {
      if (!ctx.state.statsReads) return 'n’a pas regardé l’état du PC'
      return /52/.test(replyOf(ctx)) ? null : 'la température (52 degrés) n’est pas dans la réponse'
    }
  },
  {
    id: 'duel-ecran-erreur',
    family: 'Le PC',
    turns: ["Qu'est-ce qui est écrit dans la fenêtre à l'écran ?"],
    allow: ['look_at_screen'],
    setup: { screen: 'Je vois une fenêtre « Mise à jour de Windows » : « Un redémarrage est nécessaire pour terminer l’installation. Redémarrer maintenant / Plus tard ».' },
    check: (ctx) => {
      if (!ctx.state.screenLooks) return 'n’a pas regardé l’écran'
      return /redemarr/.test(replyOf(ctx)) ? null : 'ne dit pas ce qui est écrit (un redémarrage est nécessaire)'
    }
  },
  {
    id: 'duel-ne-pas-eteindre',
    family: 'Le PC',
    turns: ["N'éteins surtout pas le PC, dis-moi juste combien de mémoire vive est utilisée."],
    allow: ['get_system_stats'],
    check: (ctx) => {
      if (ctx.state.shutdowns.length) return 'a éteint le PC alors que c’était interdit'
      return /47/.test(replyOf(ctx)) ? null : 'la mémoire vive utilisée (47 %) n’est pas dans la réponse'
    }
  },

  // --- Images ---
  {
    id: 'duel-chat-astronaute',
    family: 'Images',
    turns: ['Dessine un chat astronaute.'],
    allow: ['generate_image'],
    check: (ctx) => {
      const prompt = ctx.state.images.map((i) => norm(i.prompt)).join(' ')
      if (!prompt) return 'aucune image demandée'
      return /\b(cat|chat)\b/.test(prompt) && /astronau/.test(prompt) ? null : 'l’image demandée n’est pas un chat astronaute'
    }
  },
  {
    id: 'duel-phare',
    family: 'Images',
    turns: ["Fais-moi une image d'un phare au coucher du soleil."],
    allow: ['generate_image'],
    check: (ctx) => {
      const prompt = ctx.state.images.map((i) => norm(i.prompt)).join(' ')
      if (!prompt) return 'aucune image demandée'
      return /lighthouse|phare/.test(prompt) && /sunset|coucher/.test(prompt) ? null : 'l’image demandée n’est pas un phare au coucher du soleil'
    }
  },

  // --- Calcul ---
  {
    id: 'duel-pourboire',
    family: 'Calcul',
    turns: ['Calcule 15 % de 48 euros.'],
    check: (ctx) => (/\b7[,.]20?\b|7 euros? 20/.test(String(ctx.turns.at(-1)?.reply ?? '').toLowerCase()) ? null : 'le résultat (7,20 €) n’est pas dans la réponse')
  }
]
