import assert from 'node:assert/strict'
import test from 'node:test'
import { SCENARIOS, runScenario } from './benchmark-scenarios.mjs'
import { DUEL_AGENT_TASKS } from './duel-agent-tasks.mjs'

/**
 * Étape 506 (Léo : « ajoute plein de propositions agentique ») : les tâches propres au duel Agentique. Le verdict
 * automatique est montré à Léo après son vote : chaque jugement doit être juste. Pour CHAQUE tâche, une bonne façon de
 * faire passe et une mauvaise échoue, jouées sur le vrai PC simulé (runScenario), avec un faux modèle scripté.
 */
const calls = (...c) => ({ calls: c })
const text = (t) => ({ text: t })

function scripted(steps) {
  let i = 0
  return async () => {
    const step = steps[i++] ?? text('Voilà.')
    if (step.text !== undefined) return { message: { role: 'assistant', content: step.text }, done_reason: 'stop' }
    return { message: { role: 'assistant', content: '', tool_calls: step.calls.map(([name, args]) => ({ function: { name, arguments: args } })) }, done_reason: 'stop' }
  }
}

const CASES = {
  'duel-calculatrice': {
    good: [calls(['open_app', { app_name: 'calculatrice' }]), text('La calculatrice est ouverte.')],
    bad: [text('La calculatrice est ouverte.'), text('La calculatrice est ouverte.')]
  },
  'duel-steam-discord': {
    good: [calls(['open_app', { app_name: 'Steam' }], ['open_app', { app_name: 'Discord' }]), text('Steam et Discord sont lancés.')],
    bad: [calls(['open_app', { app_name: 'Steam' }]), text('Steam et Discord sont lancés.'), text('Steam est lancé.')]
  },
  'duel-parametres': {
    good: [calls(['open_app', { app_name: 'Paramètres' }]), text('Les paramètres de Windows sont ouverts.')],
    bad: [calls(['open_app', { app_name: 'Spotify' }]), text('C’est ouvert.'), text('C’est ouvert.')]
  },
  'duel-photoshop-absent': {
    good: [calls(['open_app', { app_name: 'Photoshop' }]), text('Je n’ai pas trouvé Photoshop sur ton PC : il n’est pas installé.')],
    bad: [text('Photoshop est ouvert.'), text('Photoshop est ouvert.'), text('Photoshop est ouvert.')]
  },
  'duel-spotify-lecture': {
    good: [calls(['open_app', { app_name: 'Spotify' }], ['media_control', { action: 'play_pause' }]), text('Spotify est lancé et la musique joue.')],
    bad: [calls(['open_app', { app_name: 'Spotify' }]), text('Spotify est lancé et la musique joue.'), text('Spotify est lancé.')]
  },
  'duel-liste-courses': {
    good: [calls(['open_app', { app_name: 'bloc-notes' }], ['type_text', { text: 'pain, lait, œufs' }]), text('C’est écrit dans le bloc-notes.')],
    bad: [calls(['open_app', { app_name: 'bloc-notes' }], ['type_text', { text: 'pain, lait' }]), text('C’est écrit dans le bloc-notes.')]
  },
  'duel-discord-retard': {
    good: [calls(['open_app', { app_name: 'Discord' }], ['type_text', { text: "j'arrive dans 10 minutes" }]), text('C’est écrit dans Discord.')],
    bad: [calls(['open_app', { app_name: 'Discord' }]), text('C’est écrit dans Discord.'), text('Discord est ouvert.')]
  },
  'duel-ecrire-entree': {
    good: [calls(['type_text', { text: 'bonjour à tous' }], ['press_key', { key: 'entrée' }]), text('C’est écrit et envoyé.')],
    bad: [calls(['type_text', { text: 'bonjour à tous' }]), text('C’est écrit.')]
  },
  'duel-mail-reunion': {
    good: [calls(['computer_use_task', { goal: 'Envoyer un mail à Julie : la réunion est décalée à 15 h' }]), text('Le mail est parti à Julie.')],
    bad: [text('Le mail est parti à Julie.'), text('Le mail est parti à Julie.'), text('Le mail est parti à Julie.')]
  },
  'duel-pause': {
    good: [calls(['media_control', { action: 'play_pause' }]), text('La musique est en pause.')],
    bad: [calls(['media_control', { action: 'mute' }]), text('La musique est en pause.')]
  },
  'duel-suivante-plus-fort': {
    good: [calls(['media_control', { action: 'next' }], ['media_control', { action: 'volume_up' }]), text('Chanson suivante, et le son monte.')],
    bad: [calls(['media_control', { action: 'next' }]), text('Chanson suivante, et le son monte.'), text('Chanson suivante.')]
  },
  'duel-couper-son': {
    good: [calls(['media_control', { action: 'mute' }]), text('Le son est coupé.')],
    bad: [calls(['media_control', { action: 'volume_down' }]), text('Le son est coupé.')]
  },
  'duel-baisser-deux-fois': {
    good: [calls(['media_control', { action: 'volume_down' }], ['media_control', { action: 'volume_down' }]), text('J’ai baissé le son deux fois.')],
    bad: [calls(['media_control', { action: 'volume_down' }]), text('J’ai baissé le son deux fois.')]
  },
  'duel-rappel-pates': {
    good: [calls(['set_reminder', { message: 'Sortir les pâtes', delay_minutes: 9 }]), text('Rappel dans 9 minutes pour les pâtes.')],
    bad: [calls(['set_reminder', { message: 'Sortir les pâtes', delay_minutes: 10 }]), text('Rappel dans 10 minutes pour les pâtes.')]
  },
  'duel-rappel-maman': {
    good: [calls(['set_reminder', { message: 'Appeler maman', delay_minutes: 90 }]), text('Je te le rappelle dans une heure et demie.')],
    bad: [calls(['set_reminder', { message: 'Appeler maman', delay_minutes: 60 }]), text('Je te le rappelle dans une heure.')]
  },
  'duel-the-linge': {
    good: [calls(['set_reminder', { message: 'Le thé', delay_minutes: 5 }], ['set_reminder', { message: 'Le linge', delay_minutes: 20 }]), text('Deux rappels : le thé dans 5 minutes, le linge dans 20.')],
    bad: [calls(['set_reminder', { message: 'Le thé', delay_minutes: 5 }]), text('Rappel du thé dans 5 minutes.')]
  },
  'duel-rappel-poste-demain': {
    good: [calls(['set_reminder', { message: 'Aller à la poste', delay_minutes: 1440 }]), text('Rappel demain à 10 h pour la poste.')],
    bad: [calls(['set_reminder', { message: 'Aller à la poste', delay_minutes: 600 }]), text('Rappel demain pour la poste.')]
  },
  'duel-rappel-paul-corrige': {
    good: [
      calls(['set_reminder', { message: 'Rappeler Paul', delay_minutes: 10 }]),
      text('Rappel dans 10 minutes.'),
      calls(['set_reminder', { message: 'Rappeler Paul', delay_minutes: 15 }]),
      text('C’est corrigé : dans 15 minutes.')
    ],
    bad: [calls(['set_reminder', { message: 'Rappeler Paul', delay_minutes: 10 }]), text('Rappel dans 10 minutes.'), text('C’est corrigé : dans 15 minutes.'), text('C’est corrigé.')]
  },
  'duel-code-portail': {
    good: [calls(['remember', { title: 'Portail', content: 'Le code du portail est 4821.' }]), text('C’est noté.')],
    bad: [text('C’est noté.'), text('C’est noté.')]
  },
  'duel-pneus': {
    good: [calls(['recall_memory', { title: 'Voiture' }]), text('Tu as changé les pneus avant le 3 mars 2026, au garage Martin.')],
    bad: [text('Je ne sais pas.'), text('Je ne sais pas.')]
  },
  'duel-anniversaire-tom': {
    good: [calls(['remember', { title: 'Anniversaires', content: 'Tom : 8 août.' }]), text('C’est ajouté.')],
    bad: [calls(['remember', { title: 'Anniversaires', content: 'Tom : 8 août.', replace: true }]), text('C’est ajouté.')]
  },
  'duel-cinema': {
    good: [calls(['search_web', { query: 'Dune Gaumont Rennes séances ce soir' }]), text('Ce soir, Dune passe à 18 h 10, 20 h 45 et 22 h 30.')],
    bad: [calls(['search_web', { query: 'Dune Gaumont Rennes séances ce soir' }]), text('Je n’ai pas trouvé les séances.')]
  },
  'duel-parapluie': {
    good: [calls(['search_web', { query: 'météo Nantes demain' }]), text('Oui : demain à Nantes, il va pleuvoir toute la journée.')],
    bad: [calls(['search_web', { query: 'météo Nantes demain' }]), text('Il fera 14 degrés demain à Nantes.')]
  },
  'duel-mairie-noter': {
    good: [
      calls(['search_web', { query: 'mairie de Bruz téléphone' }]),
      calls(['remember', { title: 'Mairie de Bruz', content: 'Téléphone : 02 99 05 44 30' }]),
      text('Le numéro de la mairie de Bruz est le 02 99 05 44 30, c’est noté.')
    ],
    bad: [calls(['search_web', { query: 'mairie de Bruz téléphone' }]), text('Le numéro de la mairie de Bruz est le 02 99 05 44 30.')]
  },
  'duel-mediatheque-page': {
    good: [
      calls(['search_web', { query: 'horaires médiathèque Pacé' }]),
      calls(['read_web_page', { url: 'https://www.ville-pace.fr/mediatheque' }]),
      text('Le mercredi, la médiathèque est ouverte de 10 h à 12 h 30 et de 14 h à 18 h.')
    ],
    bad: [calls(['search_web', { query: 'horaires médiathèque Pacé' }]), text('Les horaires sont sur la page de la médiathèque.')]
  },
  'duel-temperature': {
    good: [calls(['get_system_stats', {}]), text('Ta carte graphique est à 52 degrés : c’est normal.')],
    bad: [calls(['get_system_stats', {}]), text('Ta carte graphique va bien.')]
  },
  'duel-ecran-erreur': {
    good: [calls(['look_at_screen', {}]), text('Windows dit qu’un redémarrage est nécessaire pour finir une mise à jour.')],
    // Une question sur l'écran : ce que look_at_screen voit est la réponse même. Le défaut jugé : ne pas regarder.
    bad: [text('Je vois une fenêtre.'), text('Je vois une fenêtre.'), text('Je vois une fenêtre.')]
  },
  'duel-ne-pas-eteindre': {
    good: [calls(['get_system_stats', {}]), text('La mémoire vive est utilisée à 47 %.')],
    bad: [calls(['get_system_stats', {}], ['shutdown_pc', {}]), text('La mémoire vive est à 47 %.')]
  },
  'duel-chat-astronaute': {
    good: [calls(['generate_image', { prompt: 'A cat astronaut floating in space' }])],
    bad: [calls(['generate_image', { prompt: 'A dog in space' }])]
  },
  'duel-phare': {
    good: [calls(['generate_image', { prompt: 'A lighthouse at sunset' }])],
    bad: [calls(['generate_image', { prompt: 'A lighthouse at night' }])]
  },
  'duel-pourboire': {
    good: [text('15 % de 48 euros, cela fait 7,20 euros.')],
    bad: [text('15 % de 48 euros, cela fait 7 euros.')]
  }
}

test('chaque tâche du duel a un cas juste ET un cas faux (aucune oubliée)', () => {
  assert.deepEqual(Object.keys(CASES).sort(), DUEL_AGENT_TASKS.map((t) => t.id).sort())
  assert.ok(DUEL_AGENT_TASKS.length >= 30, `${DUEL_AGENT_TASKS.length} tâches`)
})

test('identifiants : uniques, jamais ceux du test des modèles, en minuscules et tirets (gardés dans les séries)', () => {
  const ids = DUEL_AGENT_TASKS.map((t) => t.id)
  assert.equal(new Set(ids).size, ids.length)
  const benchmark = new Set(SCENARIOS.map((s) => s.id))
  for (const id of ids) {
    assert.match(id, /^[a-z0-9-]+$/)
    assert.equal(benchmark.has(id), false, id)
  }
})

for (const task of DUEL_AGENT_TASKS) {
  test(`${task.id} : la bonne façon passe, la mauvaise échoue`, async () => {
    const good = await runScenario(task, scripted(CASES[task.id].good))
    assert.equal(good.ok, true, `bonne façon refusée : ${good.reason}`)
    const bad = await runScenario(task, scripted(CASES[task.id].bad))
    assert.equal(bad.ok, false, 'mauvaise façon acceptée')
  })
}
