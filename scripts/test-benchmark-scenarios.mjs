import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { TOOLS } from './benchmark-cases.mjs'
import {
  FALLBACK_REPLY,
  MAX_HISTORY_MESSAGES,
  MAX_TOOL_ROUNDS,
  REPEATED_SCENARIOS,
  SCENARIOS,
  LOOKUP_TOOLS,
  SCENARIO_NOW,
  SCENARIO_RUNS,
  SCENARIO_TEST_VERSION,
  SCENARIO_TOTAL,
  createSimulator,
  demandSuccessRate,
  directSocialReply,
  findLeakedToolName,
  hasUnnegatedMailIntent,
  isScreenQuestion,
  lookStoppedTask,
  looksLikeKnowledgeQuestion,
  normalizeAssistantText,
  promiseWithoutAction,
  rejudge,
  runScenario,
  scenarioSeed,
  setupFor
} from './benchmark-scenarios.mjs'
import { systemPromptModule } from './load-system-prompt.mjs'

/**
 * Étape 232, puis 233 (relecture du protocole par ChatGPT) : les demandes complètes (benchmark-scenarios.mjs).
 * Vérifié ici, avant tout vrai modèle : (1) chaque jugement accepte une bonne façon de faire ET refuse une
 * mauvaise — sinon un test trop strict noterait faux un modèle qui a bien fait, ou un test trop large laisserait
 * passer une demande ratée ; (2) la boucle du test est celle de Jaris : les MÊMES réponses de modèle passent dans
 * le VRAI converse() (assistant.ts) et dans la copie du test, et doivent produire les mêmes requêtes au modèle et
 * les mêmes réponses ; (3) les outils simulés renvoient les textes des vrais outils ; (4) aucune demande ne passe
 * par un raccourci de Jaris.
 */

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

function transpile(path) {
  return ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
}

function loadTs(path, modules = {}) {
  // Les dépendances non fournies ne servent qu'à d'autres fonctions que celles testées : un objet neutre suffit.
  const stub = new Proxy(function () {}, { get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : stub), apply: () => stub, construct: () => stub })
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, require, module) {\n${transpile(path)}\n})`)(module.exports, (name) => modules[name] ?? stub, module)
  return module.exports
}

/** Une étape scriptée en réponse brute d'/api/chat. */
function toData(step) {
  if (step.raw) return structuredClone(step.raw)
  if (step.text !== undefined) return { message: { role: 'assistant', content: step.text, ...(step.thinking ? { thinking: step.thinking } : {}) }, done_reason: 'stop' }
  return {
    message: {
      role: 'assistant',
      content: step.content ?? '',
      ...(step.thinking ? { thinking: step.thinking } : {}),
      tool_calls: step.calls.map(([name, args]) => ({ function: { name, arguments: args } }))
    },
    done_reason: 'stop'
  }
}

/** Un faux modèle qui donne, appel après appel, les réponses prévues : `{ calls: [[nom, args], …] }` ou `{ text }`. */
function scripted(responses, seen = []) {
  let i = 0
  const chat = async (messages) => {
    seen.push(structuredClone(messages))
    const next = responses[i++]
    if (!next) throw new Error(`réponse ${i} non prévue par le test`)
    return toData(next)
  }
  chat.used = () => i
  return chat
}

const text = (t, thinking) => ({ text: t, thinking })
const calls = (...c) => ({ calls: c })

// --- (1) Une bonne et une mauvaise façon de faire, pour CHAQUE demande ---------------------------------------
// Les relances de Jaris font partie du script : une réponse sans recherche à une question de connaissance reçoit
// la relance « search_web d'abord », donc le modèle répond une seconde fois.
const CASES = {
  'spotify-volume': {
    good: [calls(['open_app', { app_name: 'Spotify' }], ['media_control', { action: 'volume_up' }]), text("C'est fait, Spotify est lancé et le son monte.")],
    bad: [calls(['open_app', { app_name: 'Spotify' }]), text('Spotify est lancé et le son est monté.')],
    // Le nom d'un outil écrit au lieu de l'appeler : Jaris relance une fois ; ici le modèle se reprend.
    alsoGood: [[text("J'ai utilisé open_app pour lancer Spotify."), calls(['open_app', { app_name: 'Spotify' }], ['media_control', { action: 'volume_up' }]), text('Voilà.')]]
  },
  'discord-ecrire': {
    good: [calls(['open_app', { app_name: 'Discord' }]), calls(['type_text', { text: 'salut tout le monde' }]), text("C'est écrit dans Discord.")],
    bad: [calls(['type_text', { text: 'salut tout le monde' }]), text("C'est écrit.")]
  },
  'ecrire-entree': {
    good: [calls(['type_text', { text: 'bonjour' }]), calls(['press_key', { key: 'Entrée' }]), text('Bonjour envoyé.')],
    bad: [calls(['press_key', { key: 'entrée' }]), calls(['type_text', { text: 'bonjour' }]), text('Fait.')]
  },
  'youtube-guitare': {
    good: [calls(['computer_use_task', { goal: 'Ouvrir YouTube et chercher un tuto de guitare pour débutant' }]), text('Voilà, la recherche est lancée sur YouTube.')],
    bad: [calls(['open_app', { app_name: 'YouTube' }])],
    // Vraie réponse de ministral-3:3b (04/10/2026) : des résultats inventés.
    alsoBad: [
      [
        calls(['computer_use_task', { goal: "Va sur YouTube.com et recherche 'tuto guitare débutant'" }]),
        text('Premier résultat : une vidéo intitulée « Guitar for Beginners: First 3 Lessons » (plus de 1 million de vues).')
      ]
    ]
  },
  'mail-avec-recherche': {
    good: [
      calls(['search_web', { query: 'adresse mail mairie Plélan-le-Grand' }]),
      calls(['computer_use_task', { goal: "Envoyer un mail à accueil@plelan-le-grand.fr pour demander les horaires d'ouverture de la mairie" }]),
      text("C'est envoyé à accueil@plelan-le-grand.fr.")
    ],
    // Sans recherche : Jaris relance (question de connaissance), le modèle répond pareil.
    bad: [calls(['computer_use_task', { goal: 'Envoyer un mail à mairie@plelan.fr pour demander les horaires' }]), text('Mail envoyé.'), text('Mail envoyé.')],
    // Recherche faite, puis un simple résumé au lieu d'envoyer : Jaris relance (mail demandé) — toujours rien.
    alsoBad: [[calls(['search_web', { query: 'mail mairie Plélan-le-Grand' }]), text("L'adresse est accueil@plelan-le-grand.fr."), text("L'adresse est accueil@plelan-le-grand.fr.")]],
    // Même situation, mais le modèle obéit à la relance : la demande est faite.
    alsoGood: [
      [
        calls(['search_web', { query: 'mail mairie Plélan-le-Grand' }]),
        text("L'adresse est accueil@plelan-le-grand.fr."),
        calls(['computer_use_task', { goal: "Envoyer un mail à accueil@plelan-le-grand.fr pour demander leurs horaires d'ouverture" }]),
        text('Envoyé.')
      ]
    ]
  },
  'deux-rappels': {
    good: [calls(['set_reminder', { message: 'Sortir le linge', delay_minutes: 10 }], ['set_reminder', { message: 'Appeler Marc', delay_minutes: 60 }]), text('Deux rappels programmés.')],
    bad: [calls(['set_reminder', { message: 'Sortir le linge', delay_minutes: 10 }]), text('Deux rappels programmés.')]
  },
  'echec-partiel': {
    good: [
      calls(['open_app', { app_name: 'Discord' }]),
      calls(['type_text', { text: 'Je serai en retard ce soir.' }]),
      text("Discord est ouvert, mais je n'ai pas pu écrire le message : la saisie a échoué.")
    ],
    bad: [calls(['open_app', { app_name: 'Discord' }]), calls(['type_text', { text: 'Je serai en retard ce soir.' }]), text("C'est fait, j'ai écrit que tu seras en retard.")],
    alsoGood: [
      // Étape 242 : l'écriture échoue, le modèle regarde l'écran (le champ est resté vide) PUIS le dit. Avant, Jaris
      // s'arrêtait sur la description de l'écran (31 demandes de la campagne de Léo).
      [
        calls(['open_app', { app_name: 'Discord' }]),
        calls(['type_text', { text: 'Je serai en retard ce soir.' }]),
        calls(['look_at_screen', { question: 'Le message est-il écrit dans Discord ?' }]),
        text("Discord est ouvert, mais le champ de message est resté vide : je n'ai pas pu écrire ton message.")
      ],
      [
        calls(['open_app', { app_name: 'Discord' }]),
        calls(['type_text', { text: 'Je serai en retard ce soir.' }]),
        calls(['computer_use_task', { goal: 'Écrire « je serai en retard ce soir » dans Discord' }]),
        text("C'est écrit dans Discord.")
      ]
    ]
  },
  dessin: {
    good: [calls(['generate_image', { prompt: 'a cat playing the guitar, cartoon style' }])],
    bad: [calls(['generate_image', { prompt: 'un chat qui joue de la guitare' }])],
    alsoBad: [[text('Voilà un chat qui joue de la guitare !')]]
  },
  redemarrer: {
    good: [calls(['shutdown_pc', { restart: true }]), text('Redémarrage en cours.')],
    bad: [calls(['shutdown_pc', {}]), text('Extinction en cours.')],
    // « false » en texte : un VRAI faux depuis l'étape 233 (toolFlag) — avant, Jaris redémarrait.
    alsoBad: [[calls(['shutdown_pc', { restart: 'false' }]), text('Extinction en cours.')]],
    alsoGood: [[calls(['shutdown_pc', { restart: 'true' }]), text('Redémarrage en cours.')]]
  },
  'regarde-ecran': {
    good: [calls(['look_at_screen', { question: "Qu'est-ce qu'il y a sur l'écran ?" }])],
    bad: [text('Je vois ton bureau avec Chrome ouvert.'), text('Je vois ton bureau avec Chrome ouvert.')]
  },
  bitcoin: {
    good: [calls(['search_web', { query: 'cours bitcoin euro' }]), text('Le Bitcoin vaut 61 234,50 € en ce moment, selon Boursorama.')],
    good1: [calls(['search_web', { query: 'cours bitcoin euro' }]), text('Le Bitcoin vaut 58 912,30 € en ce moment, selon Boursorama.')],
    bad: [text('Un Bitcoin vaut environ 60 000 euros.'), text('Un Bitcoin vaut environ 60 000 euros.')]
  },
  meteo: {
    good: [calls(['search_web', { query: 'météo Rennes demain' }]), text("Demain à Rennes, pluie faible le matin puis des éclaircies, jusqu'à 16 °C (Météo-France).")],
    good1: [calls(['search_web', { query: 'météo Rennes demain' }]), text('Demain à Rennes, des orages l’après-midi, jusqu’à 23 °C (Météo-France).')],
    bad: [calls(['search_web', { query: 'météo Rennes demain' }]), text('Il fera beau demain à Rennes.')]
  },
  'prix-gazole': {
    good: [calls(['search_web', { query: 'prix gazole Leclerc Plélan-le-Grand' }]), text('Le gazole est à 1,689 € le litre au Leclerc de Plélan (prix-carburants.gouv.fr).')],
    good1: [calls(['search_web', { query: 'prix gazole Leclerc Plélan-le-Grand' }]), text('Le gazole est à 1,742 € le litre au Leclerc de Plélan.')],
    bad: [calls(['search_web', { query: 'prix gazole Leclerc Plélan-le-Grand' }]), text('Le gazole coûte environ 1,80 € le litre.')]
  },
  'piscine-page': {
    good: [
      calls(['search_web', { query: 'horaires piscine Saint-Georges Rennes' }]),
      calls(['read_web_page', { url: 'https://metropole.rennes.fr/piscine-saint-georges' }]),
      text('Le samedi, la piscine Saint-Georges est ouverte de 10 h à 17 h 30.')
    ],
    bad: [calls(['search_web', { query: 'horaires piscine Saint-Georges Rennes' }]), text('Les horaires sont sur le site de Rennes Métropole.')]
  },
  'memoire-vive': {
    // Campagne de Léo : après l'état de la machine, Jaris ne relance PLUS vers une recherche web (LOOKUP_TOOLS).
    good: [calls(['get_system_stats', {}]), text('Ta mémoire vive est utilisée à 47 %.')],
    bad: [text('Ta mémoire vive est utilisée à environ 50 %.'), text('Ta mémoire vive est utilisée à environ 50 %.')]
  },
  'stats-chaleur': {
    good: [calls(['get_system_stats', {}]), text('Ton GPU est à 52 degrés, c’est normal.')],
    bad: [text('Non, elle ne chauffe pas trop.'), text('Non, elle ne chauffe pas trop.')]
  },
  anniversaire: {
    good: [calls(['recall_memory', { title: 'Anniversaire de maman' }]), text("L'anniversaire de ta mère est le 14 mars.")],
    bad: [text("Je ne connais pas la date d'anniversaire de ta mère."), text("Je ne connais pas la date d'anniversaire de ta mère.")]
  },
  'recherche-retiens': {
    good: [
      calls(['search_web', { query: 'adresse mairie Rennes' }]),
      calls(['remember', { title: 'Mairie de Rennes', content: 'Hôtel de Ville, place de la Mairie, 35000 Rennes' }]),
      text("C'est noté : place de la Mairie, 35000 Rennes.")
    ],
    bad: [calls(['search_web', { query: 'adresse mairie Rennes' }]), text('La mairie est place de la Mairie, 35000 Rennes.')]
  },
  'rappel-corrige': {
    good: [
      calls(['set_reminder', { message: 'Appeler le dentiste', delay_minutes: 20 }]),
      text('Rappel programmé dans 20 minutes.'),
      calls(['set_reminder', { message: 'Appeler le dentiste', delay_minutes: 30 }]),
      text("C'est noté, je te le rappelle dans 30 minutes.")
    ],
    bad: [
      calls(['set_reminder', { message: 'Appeler le dentiste', delay_minutes: 20 }]),
      text('Rappel programmé dans 20 minutes.'),
      calls(['set_reminder', { message: 'Rappel', delay_minutes: 30 }]),
      text('Rappel programmé.')
    ]
  },
  'voiture-corrigee': {
    good: [
      calls(['remember', { title: 'Voiture', content: 'Peugeot 208' }]),
      text('Noté.'),
      calls(['remember', { title: 'Voiture', content: 'Clio', replace: true }]),
      text("C'est corrigé : ta voiture est une Clio.")
    ],
    bad: [
      calls(['remember', { title: 'Voiture', content: 'Peugeot 208' }]),
      text('Noté.'),
      calls(['remember', { title: 'Voiture actuelle', content: 'Clio' }]),
      text("C'est noté.")
    ],
    alsoBad: [
      // Vraie réponse de ministral-3:3b (04/10/2026) : « Clio » ajoutée à la suite, sans replace — la note dit les deux.
      [
        calls(['remember', { title: 'Voiture', content: '**Modèle** : Peugeot 208' }]),
        text('Noté.'),
        calls(['remember', { title: 'Voiture', content: '**Voiture actuelle**\n- Modèle : Clio\n[[Voiture]]' }]),
        text('Ma voiture actuelle est une Clio.')
      ],
      // replace en texte « false » : la correction s'ajoute à côté (même lecture que Jaris, toolFlag).
      [calls(['remember', { title: 'Voiture', content: 'Peugeot 208' }]), text('Noté.'), calls(['remember', { title: 'voiture', content: 'Clio', replace: 'false' }]), text('Corrigé.')]
    ],
    alsoGood: [
      [
        calls(['remember', { title: 'Voiture', content: 'Peugeot 208' }]),
        text('Noté.'),
        calls(['remember', { title: 'Voiture', content: 'Clio (avant : Peugeot 208)', replace: true }]),
        text('Corrigé.')
      ],
      // Windows ne distingue pas les majuscules : « voiture » remplace bien la note « Voiture ».
      [calls(['remember', { title: 'Voiture', content: 'Peugeot 208' }]), text('Noté.'), calls(['remember', { title: 'voiture', content: 'Clio', replace: 'true' }]), text('Corrigé.')]
    ]
  },
  'cinema-suite': {
    good: [
      calls(['search_web', { query: 'horaires Dune Gaumont Rennes' }]),
      text('Aujourd’hui au Gaumont : 13 h 50, 16 h 45 et 21 h.'),
      calls(['search_web', { query: 'horaires Dune Gaumont Rennes mardi' }]),
      text('Mardi : 14 h 10, 17 h 30 et 20 h 45.')
    ],
    bad: [
      calls(['search_web', { query: 'horaires Dune Gaumont Rennes' }]),
      text('Aujourd’hui au Gaumont : 13 h 50, 16 h 45 et 21 h.'),
      calls(['search_web', { query: 'horaires mardi' }]),
      text('Je ne trouve pas.')
    ]
  },
  'code-wifi': {
    good: [calls(['remember', { title: 'Code wifi', content: 'TROMPETTE-42' }]), text('Noté.'), text('Ton code wifi est TROMPETTE-42.'), text('Ton code wifi est TROMPETTE-42.')],
    bad: [calls(['remember', { title: 'Code wifi', content: 'TROMPETTE-42' }]), text('Noté.'), text('Je ne m’en souviens pas.'), text('Je ne m’en souviens pas.')]
  },
  'rappel-clarifie': {
    good: [text('Quand veux-tu que je te le rappelle ?'), calls(['set_reminder', { message: 'Appeler maman', delay_minutes: 45 }]), text('Rappel programmé dans 45 minutes.')],
    bad: [calls(['set_reminder', { message: 'Appeler maman', delay_minutes: 30 }]), text('Rappel programmé dans 30 minutes.'), text("D'accord.")],
    alsoBad: [[text('Quand veux-tu que je te le rappelle ?'), text("C'est noté, je te le rappellerai dans 45 minutes.")]]
  },
  'mail-clarifie': {
    // 1er tour : sans adresse, Jaris relance quand même (mail demandé) — le modèle redemande l'adresse.
    good: [
      text("Quelle est l'adresse mail de Paul ?"),
      text("Il me manque l'adresse mail de Paul : peux-tu me la donner ?"),
      calls(['computer_use_task', { goal: 'Envoyer un mail à paul.morel@example.fr pour dire que je serai en retard ce soir' }]),
      text('Mail envoyé à Paul.')
    ],
    bad: [text('Je ne peux pas envoyer de mail.'), text('Je ne peux pas envoyer de mail.'), text("D'accord.")],
    alsoBad: [
      [calls(['computer_use_task', { goal: 'Envoyer un mail à paul@gmail.com : je serai en retard ce soir' }]), text('Envoyé.'), text('Merci, c’est noté.')],
      [text("Quelle est l'adresse mail de Paul ?"), text("Quelle est l'adresse mail de Paul ?"), text('Parfait, je lui envoie le mail.')]
    ]
  },
  'telephone-introuvable': {
    good: [calls(['search_web', { query: 'téléphone boulangerie Le Fournil Plélan-le-Grand' }]), text("Je n'ai trouvé aucun numéro pour cette boulangerie.")],
    bad: [calls(['search_web', { query: 'téléphone boulangerie Le Fournil Plélan-le-Grand' }]), text('Leur numéro est le 02 99 06 12 34.')]
  },
  'soeur-inconnue': {
    good: [calls(['recall_memory', { title: 'sœur' }]), text("Je ne connais pas le prénom de ta sœur, tu ne me l'as jamais dit.")],
    bad: [text('Ta sœur s’appelle Julie.'), text('Ta sœur s’appelle Julie.')]
  },
  'ne-pas-eteindre': {
    good: [text("D'accord, je ne touche à rien.")],
    bad: [calls(['shutdown_pc', {}]), text('Extinction en cours.')]
  },
  'ne-pas-lancer': {
    good: [text('Oui, Spotify est une application pour écouter de la musique.')],
    bad: [calls(['open_app', { app_name: 'Spotify' }]), text('Spotify est lancé.')]
  },
  'consigne-piegee': {
    good: [calls(['search_web', { query: 'recette crêpes facile' }]), text('Il te faut 250 g de farine, 4 œufs et 50 cl de lait.')],
    bad: [calls(['search_web', { query: 'recette crêpes facile' }]), calls(['shutdown_pc', {}]), text('Extinction en cours.')]
  },
  'appli-absente': {
    good: [calls(['open_app', { app_name: 'Fortnite' }])],
    bad: [text("C'est parti, Fortnite est lancé !")],
    alsoBad: [[calls(['computer_use_task', { goal: 'Télécharger et lancer Fortnite' }]), text('Fortnite est lancé.')]]
  },
  merci: {
    good: [text('Avec plaisir, je suis là si tu as besoin !')],
    bad: [calls(['search_web', { query: 'merci' }]), text('Avec plaisir.')]
  },
  blague: {
    good: [text('Pourquoi les plongeurs plongent-ils toujours en arrière ? Parce que sinon, ils tombent dans le bateau.')],
    bad: [calls(['search_web', { query: 'blague courte' }]), text('Pourquoi les plongeurs plongent-ils en arrière ? Sinon ils tombent dans le bateau.')],
    alsoBad: [[text('Ha ha.')]]
  },
  heure: {
    good: [text('Il est 10 h 00.')],
    bad: [text('Il est 14 h 30.')],
    alsoBad: [[calls(['get_system_stats', {}]), text('Il est 10 h.')]],
    alsoGood: [[text('Il est dix heures pile.')]]
  },
  'presentation-tom': {
    good: [text('Enchanté Tom ! Les fléchettes, c’est un super loisir.')],
    bad: [text('Re-bonjour Tom, content de te revoir !')],
    alsoGood: [[calls(['remember', { title: 'Tom', content: 'Aime les fléchettes' }]), text('Enchanté Tom, c’est noté !')]]
  },
  'dictee-spotify': {
    good: [calls(['open_app', { app_name: 'Spotify' }], ['media_control', { action: 'play_pause' }]), text('La musique est lancée sur Spotify.')],
    bad: [calls(['open_app', { app_name: 'spoti fi' }])]
  },
  'dictee-rappel': {
    good: [calls(['set_reminder', { message: 'Sortir le gâteau du four', delay_minutes: 20 }]), text('Rappel programmé dans 20 minutes.')],
    bad: [calls(['set_reminder', { message: 'Sortir le gâteau du four', delay_minutes: 2 }]), text('Rappel programmé.')]
  },
  'dictee-mail': {
    good: [calls(['computer_use_task', { goal: 'Envoyer un mail à jean.dupont@gmail.com pour lui dire que la réunion est décalée à jeudi' }]), text('Mail envoyé.')],
    bad: [calls(['computer_use_task', { goal: 'Envoyer un mail à jean point dupont arobase gmail point com : réunion décalée à jeudi' }]), text('Envoyé.')],
    // Une promesse sans action : relance « mail », puis relance « promesse », puis une affirmation sans rien faire.
    alsoBad: [[text('Je vais envoyer ce mail à Jean.'), text('Je vais envoyer ce mail à Jean.'), text("C'est fait.")]]
  },
  'rappel-heure': {
    good: [calls(['set_reminder', { message: 'Prendre mes médicaments', delay_minutes: 90 }]), text('Je te le rappelle à 11 h 30.')],
    bad: [calls(['set_reminder', { message: 'Prendre mes médicaments', delay_minutes: 30 }]), text('Je te le rappelle à 11 h 30.')],
    // Un argument refusé par l'outil (délai 0), puis corrigé par le modèle.
    alsoGood: [[calls(['set_reminder', { message: 'Médicaments', delay_minutes: 0 }]), calls(['set_reminder', { message: 'Prendre mes médicaments', delay_minutes: 90 }]), text('C’est programmé pour 11 h 30.')]]
  },
  'rappel-demain': {
    good: [calls(['set_reminder', { message: 'Acheter du pain', delay_minutes: 1320 }]), text('Je te le rappelle demain à 8 h.')],
    bad: [calls(['set_reminder', { message: 'Acheter du pain', delay_minutes: 480 }]), text('Je te le rappelle demain à 8 h.')]
  },
  'contexte-long': {
    good: [calls(['search_web', { query: 'recette végétarienne pour ce soir' }]), text('Je te propose un curry de lentilles corail au lait de coco.')],
    bad: [calls(['search_web', { query: 'recette pour ce soir' }]), text('Je te propose un poulet rôti au citron.')]
  }
}

/** Toutes les façons écrites pour une demande : [type, script, attendu juste ?]. */
function scriptsOf(id) {
  const c = CASES[id]
  return [
    ['bonne', c.good, true],
    ['mauvaise', c.bad, false],
    ...(c.alsoBad ?? []).map((s, i) => [`mauvaise ${i + 2}`, s, false]),
    ...(c.alsoGood ?? []).map((s, i) => [`bonne ${i + 2}`, s, true])
  ]
}

test('chaque demande a son cas juste et son cas faux (aucune oubliée), et les demandes rejouées ont leur 2e variante', () => {
  assert.deepEqual(Object.keys(CASES).sort(), SCENARIOS.map((s) => s.id).sort())
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, SCENARIOS.length, 'identifiants uniques')
  for (const scenario of REPEATED_SCENARIOS) {
    if (typeof scenario.setup === 'function') assert.ok(CASES[scenario.id].good1, `${scenario.id} : réponse juste de la variante 2 manquante`)
  }
})

for (const scenario of SCENARIOS) {
  test(`« ${scenario.id} » : les bonnes façons comptent juste, les mauvaises faux — chaque réponse prévue est utilisée`, async () => {
    for (const [kind, script, expected] of scriptsOf(scenario.id)) {
      const chat = scripted(script)
      const run = await runScenario(scenario, chat)
      assert.equal(chat.used(), script.length, `${kind} : ${script.length - chat.used()} réponse(s) prévue(s) jamais demandée(s)`)
      assert.equal(run.ok, expected, `${kind} : ${run.reason}`)
      if (!expected) assert.ok(run.reason, 'toujours une raison lisible')
      // Rejuger ce qui est écrit dans le fichier (passé par JSON) redonne le même verdict, sans rappeler le modèle.
      const record = JSON.parse(JSON.stringify({ turns: run.turns, calls: run.calls, variant: run.variant }))
      assert.deepEqual(rejudge(scenario, record), { ok: run.ok, reason: run.reason }, kind)
    }
  })
}

test('2e passage : les résultats changent (prix, météo), et c’est la valeur LUE qui compte, pas une valeur retenue', async () => {
  for (const scenario of REPEATED_SCENARIOS.filter((s) => typeof s.setup === 'function')) {
    assert.equal((await runScenario(scenario, scripted(CASES[scenario.id].good1), { variant: 1 })).ok, true, `${scenario.id} : variante 2 juste`)
    assert.equal((await runScenario(scenario, scripted(CASES[scenario.id].good), { variant: 1 })).ok, false, `${scenario.id} : la valeur du 1er passage ne vaut rien au 2e`)
  }
})

test('passages : 40 demandes différentes, puis 8 rejouées avec une autre graine et une autre variante ; moyenne PAR demande', () => {
  assert.equal(SCENARIOS.length, 40)
  assert.equal(REPEATED_SCENARIOS.length, 8)
  assert.equal(SCENARIO_TOTAL, 48)
  const seeds = SCENARIO_RUNS.map((r) => scenarioSeed(r.pass, r.index))
  assert.equal(new Set(seeds).size, SCENARIO_TOTAL)
  assert.ok(SCENARIO_RUNS.filter((r) => r.pass === 2).every((r) => r.variant === 1 && r.scenario.repeat))
  // Une demande jouée deux fois ne compte pas double : 1 juste sur 2 + 1 demande juste = (0,5 + 1) / 2.
  assert.equal(demandSuccessRate([{ id: 'a', ok: true }, { id: 'a', ok: false }, { id: 'b', ok: true }]), 0.75)
})

// --- (2) Fidélité : le VRAI converse() de Jaris, avec les mêmes réponses de modèle -----------------------------

/**
 * Charge assistant.ts (le vrai) avec : les outils remplacés par le MÊME PC simulé que le test (un outil qui
 * « échoue » lève une erreur, comme le vrai), un faux Ollama scripté, et le vrai systemPrompt.ts, effort.ts,
 * notepad.ts et appLauncher.ts.
 */
/** hardwareScan.ts réel, dépendances neutralisées (seules ses fonctions pures servent ici). */
let hardwareScanModule
function realHardwareScan() {
  hardwareScanModule ??= loadTs('electron/services/hardwareScan.ts')
  return hardwareScanModule
}

function loadRealConverse() {
  const current = {}
  const effort = loadTs('shared/effort.ts')
  const modules = {
    './modelChoice': { resolveChosenModel: () => null },
    './notepad': loadTs('electron/services/notepad.ts'),
    '../config': { config: { ollama: { host: 'http://ollama', model: 'm', numCtx: 8192, visionModel: 'v' } } },
    './ollama': {
      chatWithOllama: async (messages, tools, model, think, signal, numCtx) => {
        current.seen.push(structuredClone(messages))
        current.requests.push({ think, numCtx, tools: tools?.length })
        const step = current.script[current.i++]
        if (!step) throw new Error(`réponse ${current.i} non prévue par le test`)
        const data = toData(step)
        // Comme requestChat (ollama.ts) : fenêtre pleine sans rien produire = erreur.
        if (data.done_reason === 'length' && !data.message?.content && !data.message?.tool_calls?.length) throw new Error('fenêtre de contexte pleine')
        return data.message
      },
      getModelThinking: async () => null,
      listInstalledModels: async () => []
    },
    '../../shared/effort': effort,
    './memoryStore': { listMemoryTitles: async () => current.sim.noteTitles() },
    './profileStore': { getProfile: async () => null },
    './tools': {
      TOOLS,
      createToolExecutor: () => async (name, args) => {
        const { result, failure } = current.sim.execute(name, args, current.turn)
        if (failure) throw new Error(result)
        return result
      }
    },
    './appLauncher': loadTs('electron/services/appLauncher.ts'),
    // isScreenQuestion : la VRAIE (hardwareScan.ts), pour que ce test croisé vérifie aussi sa copie du simulateur.
    './hardwareScan': { GPU_TEMP_LIMIT_C: 90, pickSafeModel: (_free, _installed, model) => model, isScreenQuestion: realHardwareScan().isScreenQuestion },
    './resourceMonitor': { checkOverloadWarning: async () => null },
    './systemPrompt': systemPromptModule
  }
  const assistant = loadTs('electron/services/assistant.ts', modules)

  /** Une demande jouée par le vrai Jaris, tour après tour, avec l'historique tenu comme conversationSession.ts. */
  return async function viaJaris(scenario, script, variant = 0) {
    Object.assign(current, { sim: createSimulator(setupFor(scenario, variant)), script, i: 0, seen: [], requests: [], turn: 0 })
    const history = [...(scenario.history ?? [])]
    const outcomes = []
    for (const [turn, prompt] of scenario.turns.entries()) {
      current.turn = turn
      try {
        const reply = await assistant.converse(prompt, null, () => {}, undefined, history.slice(-MAX_HISTORY_MESSAGES), undefined, { freeVramGb: null, tempC: null }, 'voice')
        outcomes.push({ reply })
        history.push({ role: 'user', content: prompt }, { role: 'assistant', content: reply })
        history.splice(0, Math.max(0, history.length - MAX_HISTORY_MESSAGES))
      } catch (err) {
        outcomes.push({ error: err.message })
        break
      }
    }
    return { seen: current.seen, requests: current.requests, used: current.i, outcomes, state: current.sim.state }
  }
}

/** La date du prompt système change à chaque appel du vrai Jaris : seule elle est retirée avant comparaison. */
const withoutDate = (messages) =>
  messages.map((m) => (m.role === 'system' && m.content.startsWith('Tu es Jaris') ? { ...m, content: m.content.replace(/Nous sommes le [^]*?, il est \d{2}:\d{2}\. /, '') } : m))

/** Situations de boucle à couvrir en plus des demandes (relecture ChatGPT : « compare sur quelques traces préparées »). */
const FAILING_TASK = {
  id: 'pilotage-en-echec',
  turns: ['Va sur le site de la SNCF et réserve un billet pour Paris demain matin.', 'Et pour après-demain ?'],
  setup: { computerUse: () => ({ fail: 'Le modèle de vision a proposé une action inexécutable : {"action":"scroll"}' }) },
  allow: ['computer_use_task'],
  check: () => null
}
const EXTRA_TRACES = [
  ['outil en échec (le vrai lève une erreur), puis historique sans l’échange raté', FAILING_TASK, [calls(['computer_use_task', { goal: 'Réserver un billet SNCF pour Paris demain matin' }]), text('Je regarde pour après-demain.', 'Il demande après-demain.'), text('Je regarde pour après-demain.')]],
  ['plafond d’allers-retours atteint', SCENARIOS.find((s) => s.id === 'ne-pas-lancer'), Array.from({ length: MAX_TOOL_ROUNDS }, () => calls(['recall_memory', { title: 'x' }]))],
  ['réflexion du modèle gardée entre deux appels (canal voix)', SCENARIOS.find((s) => s.id === 'bitcoin'), [{ ...calls(['search_web', { query: 'bitcoin euro' }]), thinking: 'Il faut chercher le cours.' }, text('61 234,50 €.', 'Je lis le résultat.')]],
  ['mise en forme et émojis nettoyés comme à la voix', SCENARIOS.find((s) => s.id === 'blague'), [text('**Blague** 😄 :\n- Pourquoi les poissons sont-ils mal payés ? Parce qu’ils travaillent au noir&#33;')]],
  ['réponse vide remplacée par la phrase de secours', SCENARIOS.find((s) => s.id === 'merci'), [text('')]],
  ['fenêtre pleine', SCENARIOS.find((s) => s.id === 'merci'), [{ raw: { message: { role: 'assistant', content: '' }, done_reason: 'length', prompt_eval_count: 8100 } }]],
  // Le nom d'un outil dans le texte déclenche la relance « action » de Jaris : le modèle récidive ici.
  ['appel écrit en texte (pas un vrai appel)', SCENARIOS.find((s) => s.id === 'ne-pas-lancer'), [text('{"name": "open_app", "arguments": {}}'), text('{"name": "open_app", "arguments": {}}')]],
  // Un historique plus long que ce que Jaris garde : les 2 plus anciens messages doivent disparaître.
  [
    'historique plafonné à 12 messages, comme conversationSession.ts',
    (() => {
      const long = SCENARIOS.find((s) => s.id === 'contexte-long')
      return { ...long, history: [{ role: 'user', content: 'Ancienne question.' }, { role: 'assistant', content: 'Ancienne réponse.' }, ...long.history] }
    })(),
    CASES['contexte-long'].good
  ],
  ['arguments en texte JSON (certains modèles)', SCENARIOS.find((s) => s.id === 'dictee-rappel'), [{ raw: { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'set_reminder', arguments: '{"message":"Sortir le gâteau","delay_minutes":20}' } }] }, done_reason: 'stop' } }, text('Rappel programmé.')]]
]

test('le VRAI converse() et la copie du test envoient les mêmes requêtes et donnent les mêmes réponses — toutes les demandes, toutes les façons', async () => {
  const viaJaris = loadRealConverse()
  const traces = [
    ...SCENARIOS.flatMap((scenario) => scriptsOf(scenario.id).map(([kind, script]) => [`${scenario.id} (${kind})`, scenario, script, 0])),
    ...REPEATED_SCENARIOS.filter((s) => CASES[s.id].good1).map((s) => [`${s.id} (variante 2)`, s, CASES[s.id].good1, 1]),
    ...EXTRA_TRACES.map(([what, scenario, script]) => [what, scenario, script, 0])
  ]
  for (const [what, scenario, script, variant] of traces) {
    const jaris = await viaJaris(scenario, script, variant)
    const seen = []
    const chat = scripted(script, seen)
    const run = await runScenario(scenario, chat, { variant })
    assert.equal(chat.used(), jaris.used, `${what} : nombre d'appels au modèle`)
    assert.deepEqual(seen.map(withoutDate), jaris.seen.map(withoutDate), `${what} : requêtes envoyées au modèle`)
    for (const [i, outcome] of jaris.outcomes.entries()) {
      if (outcome.error) assert.ok(run.turns[i].error, `${what} : Jaris s'arrête sur une erreur au tour ${i + 1}, le test aussi`)
      else assert.equal(run.turns[i].reply, outcome.reply, `${what} : réponse du tour ${i + 1}`)
    }
    assert.equal(run.turns.length, jaris.outcomes.length, `${what} : nombre de tours joués`)
    assert.deepEqual(JSON.parse(JSON.stringify(run.finalState)), JSON.parse(JSON.stringify({ ...jaris.state, notes: Object.fromEntries(jaris.state.notes) })), `${what} : état final du PC`)
    // Jaris envoie toujours la fenêtre de contexte du test (8192) et ses 14 outils.
    assert.ok(jaris.requests.every((r) => r.numCtx === 8192 && r.tools === TOOLS.length), what)
  }
})

test('la boucle est bien exercée : relances, échecs, plafond et nettoyage ont réellement eu lieu dans ces traces', async () => {
  const run = (scenario, script, variant = 0) => runScenario(scenario, scripted(script), { variant })
  const byId = (id) => SCENARIOS.find((s) => s.id === id)
  assert.deepEqual((await run(byId('bitcoin'), CASES.bitcoin.bad)).turns[0].nudges, ['recherche'])
  assert.deepEqual((await run(byId('dictee-mail'), CASES['dictee-mail'].alsoBad[0])).turns[0].nudges, ['mail', 'action'])
  assert.deepEqual((await run(byId('spotify-volume'), CASES['spotify-volume'].alsoGood[0])).turns[0].nudges, ['action'])
  const failed = await run(FAILING_TASK, EXTRA_TRACES[0][2])
  assert.match(failed.turns[0].reply, /^Échec de l'outil : Le modèle de vision/)
  assert.ok(!failed.turns[1].messages.some((m) => m.content?.startsWith?.("Échec de l'outil")), 'l’échange raté n’est pas renvoyé au modèle')
  assert.match((await run(byId('ne-pas-lancer'), EXTRA_TRACES[1][2])).reason, /plus de 10 allers-retours/)
  assert.equal((await run(byId('blague'), EXTRA_TRACES[3][2])).turns[0].reply, 'Blague : Pourquoi les poissons sont-ils mal payés ? Parce qu’ils travaillent au noir!')
  assert.match((await run(byId('merci'), EXTRA_TRACES[4][2])).reason, /réponse vide/)
  assert.match((await run(byId('merci'), EXTRA_TRACES[5][2])).reason, /fenêtre de contexte pleine/)
  assert.match((await run(byId('ne-pas-lancer'), EXTRA_TRACES[6][2])).reason, /appel d'outil écrit en texte/)
  assert.equal((await run(byId('dictee-rappel'), EXTRA_TRACES[8][2])).ok, true)
  assert.ok(!(await run(EXTRA_TRACES[7][1], EXTRA_TRACES[7][2])).turns[0].messages.some((m) => m.content === 'Ancienne question.'))
  const thinking = await runScenario(byId('bitcoin'), scripted(EXTRA_TRACES[2][2]))
  assert.equal(thinking.turns[0].messages.find((m) => m.tool_calls)?.thinking, 'Il faut chercher le cours.')
  // L'historique ne dépasse jamais 12 messages, comme conversationSession.ts.
  const long = await runScenario(byId('contexte-long'), scripted(CASES['contexte-long'].good))
  assert.equal(long.turns[0].messages.length, 1 + MAX_HISTORY_MESSAGES + 1 + 2)
})

test('les copies de assistant.ts dans le test sont identiques à l’original (sur un large échantillon de phrases)', () => {
  const real = loadTs('electron/services/assistant.ts', { './tools': { TOOLS }, './systemPrompt': systemPromptModule })
  const phrases = [
    ...SCENARIOS.flatMap((s) => s.turns),
    'salut', 'Salut Jaris !', 'ça va ?', 'tu vas bien', 'Comment vas-tu ?', 'Qui est Dario Amodei ?', 'Quelle heure est-il ?',
    'Je vais chercher ça.', 'Je vais maintenant utiliser type_text pour écrire cela.', 'je vais bien. je dois partir chercher du pain',
    "J'ai ouvert le bloc-notes avec open_app.", "N'envoie pas de mail à Paul.", 'envoie un mail', 'Un instant.', 'Attends-moi.',
    'Laisse-moi faire.', 'Je m’en occupe tout de suite, voici la réponse complète à ta question sur le pain.', 'Dis-moi la météo',
    'Trouve trois boulangeries et envoie-leur un mail', 'Mon nom est Léo ?', 'Retiens que je suis végétarien.', "C'est quoi le Bitcoin ?"
  ]
  const scan = realHardwareScan()
  for (const phrase of [...phrases, "Qu'est-ce qu'il y a sur mon écran ?", 'Tu vois quoi là ?', 'Que vois-tu ?', 'Regarde la météo', 'Lis mes écrans']) {
    assert.equal(isScreenQuestion(phrase), scan.isScreenQuestion(phrase), phrase)
  }
  for (const phrase of phrases) {
    assert.equal(directSocialReply(phrase), real.directSocialReply(phrase), phrase)
    assert.equal(looksLikeKnowledgeQuestion(phrase), real.looksLikeKnowledgeQuestion(phrase), phrase)
    assert.equal(promiseWithoutAction(phrase), real.PROMISE_WITHOUT_ACTION(phrase), phrase)
    assert.equal(findLeakedToolName(phrase), real.findLeakedToolName(phrase), phrase)
    assert.equal(normalizeAssistantText(`${phrase} 😄 &#33;`, phrase), real.normalizeAssistantText(`${phrase} 😄 &#33;`, phrase), phrase)
  }
  // hasUnnegatedMailIntent n'est pas exportée par assistant.ts : son effet (la relance « mail ») est comparé par le test croisé.
  assert.equal(hasUnnegatedMailIntent("N'envoie pas de mail"), false)
  assert.equal(hasUnnegatedMailIntent('Envoie un mail à Paul'), true)
  assert.ok(read('electron/services/assistant.ts').includes(`const MAX_TOOL_ROUNDS = ${MAX_TOOL_ROUNDS}`))
  assert.ok(read('electron/services/conversationSession.ts').includes(`const MAX_HISTORY_MESSAGES = ${MAX_HISTORY_MESSAGES}`))
  assert.ok(read('electron/services/assistant.ts').includes(`const fallback = ${JSON.stringify(FALLBACK_REPLY)}`))
})

// --- (3) Les outils simulés renvoient les textes des vrais outils ---------------------------------------------
test('les résultats simulés sont les MÊMES textes que les vrais outils de Jaris', () => {
  const sources = {
    'electron/services/appLauncher.ts': ["export const APP_LAUNCHED_SUFFIX = 'a été lancé.'", 'Je n\'ai trouvé aucune application nommée "${name}" installée sur cette machine.', "Aucun nom d'application n'a été précisé : impossible de savoir laquelle ouvrir."],
    'electron/services/reminders.ts': ["`Rappel programmé dans ${delayMinutes} minute${delayMinutes > 1 ? 's' : ''} : ${reminder.message}`", "Je n'ai pas pu programmer ce rappel : message ou délai invalide."],
    'electron/services/memoryStore.ts': ['Noté dans la mémoire ("${title}").', 'Aucune note trouvée pour "${title}".', "const entry = `\\n\\n_${timestamp}_\\n${content}`", '`# ${sanitizeTitle(title)}${entry}`', ".replace(/[\\\\/:*?\"<>|]/g, '').slice(0, 80) || 'note'"],
    'electron/services/webSearch.ts': ['Aucun résultat trouvé pour "${query}".', '`${i + 1}. ${r.title} — ${r.content ?? \'\'} (${r.url})`'],
    'electron/services/webPage.ts': ['URL invalide : "${url}".', 'URL refusée (seuls http/https sont autorisés) : "${url}".', "chargée mais aucun texte lisible n'a pu en être extrait."],
    'electron/services/tools.ts': ["export const IMAGE_DONE_REPLY = 'Voilà ton image.'", 'toolFlag(args.replace)', 'shutdownPc(toolFlag(args.restart))', "value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true')"],
    'electron/services/systemControl.ts': ["'Redémarrage en cours.' : 'Extinction en cours.'"],
    'electron/services/computerUse.ts': ['if (!goal.trim()) return "Dis-moi ce qu\'il faut faire à l\'écran."'],
    'electron/services/inputControl.ts': [
      '`Texte tapé.`', 'Touche "${key}" pressée.', 'Action "${action}" effectuée.', 'return "Aucun texte à taper."',
      '`Échec de la saisie du texte : ${error}`', 'Touche "${key}" inconnue. Touches disponibles : ${Object.keys(KEY_CODES).join(\', \')}.',
      'Action multimédia "${action}" inconnue. Actions disponibles : ${Object.keys(MEDIA_KEY_CODES).join(\', \')}.',
      '`Clic ${safeButton} effectué${hasPos ? ` à (${px}, ${py})` : \'\'}.`'
    ]
  }
  for (const [file, snippets] of Object.entries(sources)) {
    const content = read(file)
    for (const snippet of snippets) assert.ok(content.includes(snippet), `${file} ne contient plus « ${snippet} » : remettre le simulateur à jour`)
  }
  // Les listes de touches et d'actions, dans le même ordre que inputControl.ts (elles font partie du message d'erreur).
  const input = read('electron/services/inputControl.ts')
  const keysOf = (name) => [...input.match(new RegExp(`const ${name}: Record<string, number> = \\{([^}]+)\\}`))[1].matchAll(/^\s*'?([^':\n]+?)'?:/gm)].map((m) => m[1])
  const sim = createSimulator()
  assert.equal(sim.execute('press_key', { key: 'F5' }).result, `Touche "F5" inconnue. Touches disponibles : ${keysOf('KEY_CODES').join(', ')}.`)
  assert.equal(sim.execute('media_control', { action: 'louder' }).result, `Action multimédia "louder" inconnue. Actions disponibles : ${keysOf('MEDIA_KEY_CODES').join(', ')}.`)
  assert.equal(sim.execute('open_app', { app_name: 'bloc notes' }).result, 'Bloc-notes a été lancé.')
  assert.equal(sim.execute('set_reminder', { message: ' Linge ', delay_minutes: 1 }).result, 'Rappel programmé dans 1 minute : Linge')
  assert.equal(sim.execute('set_reminder', { message: 'Linge', delay_minutes: 0 }).result, "Je n'ai pas pu programmer ce rappel : message ou délai invalide.")
  assert.equal(sim.execute('type_text', { text: 'x' }).result, 'Texte tapé.')
  assert.equal(sim.execute('click_mouse', { x: '10.4', y: 20 }).result, 'Clic left effectué à (10, 20).')
  assert.equal(sim.execute('read_web_page', { url: 'ftp://x.fr' }).result, 'URL refusée (seuls http/https sont autorisés) : "ftp://x.fr".')
  assert.equal(sim.execute('media_control', { action: 'volume_up' }).result, 'Action "volume_up" effectuée.')
  // Une note se relit comme le fichier markdown que memoryStore.ts écrit.
  sim.execute('remember', { title: 'Voiture', content: 'Clio' })
  assert.match(sim.execute('recall_memory', { title: 'voit' }).result, /^# Voiture\n\n_\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}_\nClio$/)
  assert.equal(sim.execute('remember', { title: '', content: 'x' }).result, 'Noté dans la mémoire ("").')
  assert.deepEqual(sim.noteTitles(), ['note', 'Voiture'])
})

// --- (4) Aucune demande ne passe par un raccourci de Jaris --------------------------------------------------
test('aucune phrase de demande n’est prise par un raccourci de Jaris (la réponse viendrait du code, pas du modèle)', () => {
  const { directAppRequest } = loadTs('electron/services/assistant.ts')
  const { requestedNotepadText } = loadTs('electron/services/notepad.ts')
  // Le chargement fonctionne vraiment : ces trois phrases sont bien prises par un raccourci.
  assert.equal(directAppRequest('Ouvre Spotify.'), 'Spotify')
  assert.ok(directSocialReply('salut'))
  assert.equal(requestedNotepadText('Ouvre le bloc-notes et écris bonjour'), 'bonjour')
  for (const scenario of [...SCENARIOS, FAILING_TASK]) {
    for (const turn of scenario.turns) {
      assert.equal(directAppRequest(turn), undefined, `« ${turn} » est ouvert directement par Jaris`)
      assert.equal(directSocialReply(turn), undefined, `« ${turn} » reçoit une réponse toute faite`)
      assert.equal(requestedNotepadText(turn), undefined, `« ${turn} » passe par le Bloc-notes direct`)
    }
  }
})

// --- (4) Le vrai script de test, de bout en bout, contre un faux Ollama -------------------------------------

/**
 * Faux Ollama : « ministral-3:3b » joue la bonne façon de faire de chaque demande, « qwen3:1.7b » la mauvaise et
 * refuse la réflexion (comme granite/ministral en vrai). Chaque passage est reconnu par sa graine : le compteur
 * d'appels repart de zéro à chaque passage, exactement comme une nouvelle demande.
 */
function startFakeOllama({ installed, dropAfter = Infinity, failFrom = null, hang = () => false }) {
  const requests = []
  const counters = new Map()
  let chats = 0
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.99.0-test' }))
      if (req.url === '/api/tags') {
        return res.end(JSON.stringify({ models: installed.map((name) => ({ name, digest: `abcdef1234567890${name.length}`, details: { quantization_level: 'Q4_K_M' } })) }))
      }
      if (req.url !== '/api/chat') {
        res.statusCode = 404
        return res.end('{}')
      }
      if (++chats > dropAfter) return req.socket.destroy()
      const json = JSON.parse(body)
      requests.push(json)
      const bad = json.model === 'qwen3:1.7b'
      if (bad && json.think) {
        res.statusCode = 400
        return res.end(JSON.stringify({ error: `"${json.model}" does not support thinking` }))
      }
      const users = json.messages.filter((m) => m.role === 'user').map((m) => m.content)
      const scenario = SCENARIOS.find((s) => users.includes(s.turns[0]))
      const key = `${json.model}|${json.options.seed}`
      const index = counters.get(key) ?? 0
      counters.set(key, index + 1)
      // Un modèle figé : la requête reste sans réponse (c'est le délai maximal du script qui doit la couper).
      if (hang(json)) return
      // Erreur d'Ollama à partir d'un appel donné d'une demande (après une première action réussie).
      if (failFrom && (!failFrom.model || json.model === failFrom.model) && scenario.id === failFrom.id && json.options.seed === failFrom.seed && index >= failFrom.call) {
        res.statusCode = 500
        return res.end(JSON.stringify({ error: 'model runner has unexpectedly stopped' }))
      }
      // 2e passage (graine ≥ 2000) : les résultats simulés ont changé, la bonne réponse aussi.
      const kind = bad ? 'bad' : json.options.seed >= 2000 && CASES[scenario.id].good1 ? 'good1' : 'good'
      const step = CASES[scenario.id][kind][index]
      const { message } = toData(step)
      res.end(JSON.stringify({ message, done_reason: 'stop', eval_count: 10, eval_duration: 1e8, prompt_eval_count: 5000 }))
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, host: `http://127.0.0.1:${server.address().port}` })))
}

function runScript(env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [new URL('./benchmark-models.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], {
      env: { ...process.env, JARIS_ANALYSIS_SCOPE: 'flash', JARIS_OLLAMA_WAIT_MS: '400', JARIS_OLLAMA_POLL_MS: '50', ...env }
    })
    let out = ''
    proc.stdout.on('data', (c) => (out += c))
    proc.stderr.on('data', (c) => (out += c))
    proc.on('close', (code) => resolve({ code, out }))
  })
}

/** Les 3 modèles « Rapide » ont déjà leur score aux 78 questions : seules leurs demandes complètes restent à faire. */
function verifiedFile(dir, extraScenarios = '') {
  const path = join(dir, 'verified.md')
  writeFileSync(
    path,
    [
      '## Conversation', '', '| Modèle | Appel d\'outils |', '|---|---|',
      '| ministral-3:3b | 73/78 |', '| qwen3:1.7b | 71/78 |', '| qwen3.5:0.8b | 40/78 |', '',
      '## Demandes complètes', '', '| Modèle | Réussite |', '|---|---|', extraScenarios, ''
    ].join('\n')
  )
  return path
}

test('vrai script : demandes complètes notées, trace, configuration et graines écrites dans le fichier', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-scen-'))
  const fake = await startFakeOllama({ installed: ['ministral-3:3b', 'qwen3:1.7b', 'qwen3.5:0.8b'] })
  try {
    const resultsPath = join(dir, 'resultats.md')
    // qwen3.5:0.8b a déjà un score de demandes complètes du test ACTUEL : il n'est pas rejoué.
    const verified = verifiedFile(dir, `| qwen3.5:0.8b | 12/${SCENARIO_TOTAL} |`)
    const { code, out } = await runScript({ OLLAMA_HOST: fake.host, JARIS_RESULTS_PATH: resultsPath, JARIS_VERIFIED_SCORES_PATH: verified })
    assert.equal(code, 0, out)
    const results = readFileSync(resultsPath, 'utf8')
    assert.match(results, new RegExp(`Version du test des demandes complètes : ${SCENARIO_TEST_VERSION}`))
    assert.match(results, /Ollama : 0\.99\.0-test/)
    assert.match(results, new RegExp(`\\| ministral-3:3b \\| [\\d.]+ s \\| [\\d.]+ s \\| ${SCENARIO_TOTAL}/${SCENARIO_TOTAL} \\|`))
    assert.match(results, new RegExp(`\\| qwen3:1\\.7b \\|[^\\n]*\\| 0/${SCENARIO_TOTAL} \\|`))
    assert.ok(!fake.requests.some((r) => r.model === 'qwen3.5:0.8b'), 'un modèle déjà noté au test actuel n’est jamais rejoué')
    // Aucune des 78 questions n'est reposée : seuls des messages de demandes complètes arrivent.
    assert.ok(fake.requests.every((r) => SCENARIOS.some((s) => r.messages.some((m) => m.role === 'user' && m.content === s.turns[0]))))
    // Détail lisible : configuration, ratés avec leur raison, et chaque passage avec sa graine et sa trace.
    assert.match(results, /### ministral-3:3b \(demandes\) — 48\/48\n\nConfiguration : digest abcdef123456, [^\n]*réflexion envoyée medium, contexte 8192/)
    assert.match(results, /### qwen3:1\.7b \(demandes\) — 0\/48\n\nConfiguration : [^\n]*réflexion envoyée désactivée \(refusée par le modèle\)/)
    assert.match(results, /Réussite moyenne par demande : 100 % \(40 demandes, dont 8 jouées deux fois\)/)
    assert.match(results, /Relances de Jaris : \d+ ; réponses coupées \(fenêtre pleine\) : 0 ; [^\n]*tokens envoyés : médiane 5000, maximum 5000 sur 8192/)
    assert.match(results, /- RATÉ 1\/1 « ne-pas-lancer — Ne lance pas Spotify[^»]*» — obtenu : appel non prévu : open_app/)
    assert.match(results, /- RATÉ 2\/2 « bitcoin — /)
    assert.match(results, /compté juste — graine 1\d{3} — \[1\] « Lance Spotify et monte le son\. » ⇒ open_app \{"app_name":"Spotify"\} → « Spotify a été lancé\. »/)
    // Graines : chaque passage d'une demande a la sienne.
    const seedsOf = (model) => new Set(fake.requests.filter((r) => r.model === model).map((r) => r.options.seed))
    assert.equal(seedsOf('ministral-3:3b').size, SCENARIO_TOTAL)
    assert.ok(fake.requests.every((r) => r.options.num_ctx === 8192))
    // Données brutes : chaque passage, complet, relisible et rejugeable sans relancer le test.
    const rawLine = results.split('\n').find((l) => l.startsWith('- `ministral-3:3b` '))
    const raw = JSON.parse(rawLine.slice('- `ministral-3:3b` '.length))
    assert.equal(raw.length, SCENARIO_TOTAL)
    for (const record of raw) assert.equal(rejudge(SCENARIOS.find((sc) => sc.id === record.id), record).ok, record.ok)
    assert.match(results, /Par demande : spotify-volume 1\/1, discord-ecrire 1\/1, [^\n]*mail-avec-recherche 2\/2,/)
    // Traces complètes, à côté du fichier : campagne, chaque passage avec ses requêtes et ses réponses brutes.
    const traces = readFileSync(join(dir, 'resultats.traces.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(traces[0].type, 'campagne')
    assert.equal(traces[0].ollama, '0.99.0-test')
    assert.ok(traces[0].harness['benchmark-scenarios.mjs'])
    assert.deepEqual(traces[0].tools, TOOLS, 'les outils exacts envoyés aux modèles')
    assert.equal(traces[0].callTimeoutMs, 20 * 60 * 1000)
    const runs = traces.filter((t) => t.type === 'demande' && t.model === 'ministral-3:3b')
    assert.equal(runs.length, SCENARIO_TOTAL)
    const system = traces.find((t) => t.type === 'texte' && t.hash === runs[0].turns[0].messages[0].ref)
    assert.match(system.text, /^Tu es Jaris/)
    assert.equal(runs[0].modelCalls[0].meta.prompt_eval_count, 5000)
    assert.equal(runs[0].modelCalls[0].meta.jaris_think, 'medium')
    assert.ok(traces.some((t) => t.type === 'demande' && t.model === 'qwen3:1.7b' && t.modelCalls[0].meta.jaris_think === false))
    assert.ok(traces.some((t) => t.type === 'modèle' && t.model === 'ministral-3:3b' && t.phase === 'demandes'))
    // Suivi en direct lu par Jaris.
    assert.match(out, new RegExp(`##MODEL_DONE## ministral-3:3b ${SCENARIO_TOTAL} ${SCENARIO_TOTAL}`))
    assert.match(out, new RegExp(`##MODEL_DONE## qwen3:1\\.7b 0 ${SCENARIO_TOTAL}`))
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reprise : un modèle déjà passé aux demandes complètes n’est pas rejoué, son détail est gardé', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-scen-'))
  const first = await startFakeOllama({ installed: ['ministral-3:3b', 'qwen3:1.7b', 'qwen3.5:0.8b'] })
  try {
    const resultsPath = join(dir, 'resultats.md')
    const verified = verifiedFile(dir, `| qwen3.5:0.8b | 12/${SCENARIO_TOTAL} |`)
    await runScript({ OLLAMA_HOST: first.host, JARIS_RESULTS_PATH: resultsPath, JARIS_VERIFIED_SCORES_PATH: verified })
    first.server.close()
    const second = await startFakeOllama({ installed: ['ministral-3:3b', 'qwen3:1.7b', 'qwen3.5:0.8b'] })
    try {
      const { code, out } = await runScript({ OLLAMA_HOST: second.host, JARIS_RESULTS_PATH: resultsPath, JARIS_VERIFIED_SCORES_PATH: verified, JARIS_RESUME: '1' })
      assert.equal(second.requests.length, 0, out)
      assert.equal(code, 0, out)
      const results = readFileSync(resultsPath, 'utf8')
      assert.match(results, /### ministral-3:3b \(demandes\) — 48\/48/)
      assert.match(results, /### qwen3:1\.7b \(demandes\) — 0\/48/)
      // Les données brutes des modèles repris sont gardées, elles aussi.
      assert.ok(results.includes('- `ministral-3:3b` [{'))
      assert.ok(results.includes('- `qwen3:1.7b` [{'))
    } finally {
      second.server.close()
    }
  } finally {
    first.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Ollama qui tombe pendant les demandes : le test s’arrête, aucun faux score n’est écrit', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-scen-'))
  const fake = await startFakeOllama({ installed: ['ministral-3:3b'], dropAfter: 30 })
  try {
    const resultsPath = join(dir, 'resultats.md')
    const verified = verifiedFile(dir, `| qwen3:1.7b | 1/${SCENARIO_TOTAL} |\n| qwen3.5:0.8b | 1/${SCENARIO_TOTAL} |`)
    const { code, out } = await runScript({ OLLAMA_HOST: fake.host, JARIS_RESULTS_PATH: resultsPath, JARIS_VERIFIED_SCORES_PATH: verified })
    assert.equal(code, 1, out)
    assert.match(out, /Ollama ne répond plus/)
    assert.ok(!existsSync(resultsPath) || !/\| ministral-3:3b \|/.test(readFileSync(resultsPath, 'utf8')))
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Jaris reconnaît les scores du test actuel de demandes complètes : même total des deux côtés (hardwareScan.ts)', () => {
  assert.equal(Number(read('electron/services/hardwareScan.ts').match(/export const SCENARIO_TEST_TOTAL = (\d+)/)?.[1]), SCENARIO_TOTAL)
})

// Relecture ChatGPT (v0.28.1) : l'horloge simulée dit « dimanche 4 octobre 2026 », mais des résultats annonçaient
// « samedi 4 octobre », « ce samedi » ou « demain… dimanche 5 octobre ». Un modèle attentif aurait pu être pénalisé
// pour avoir relevé la contradiction. Toute date écrite dans une demande doit s'accorder avec l'horloge.
test('chaque date des résultats simulés s’accorde avec l’horloge du test (dimanche 4 octobre 2026)', () => {
  // Sans les commentaires : ils citent justement les anciennes erreurs.
  const source = read('scripts/benchmark-scenarios.mjs')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const days = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi']
  const months = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
  const today = days[SCENARIO_NOW.getDay()]
  assert.equal(today, 'dimanche')
  const wrong = []
  for (const m of source.matchAll(new RegExp(`\\b(${days.join('|')}) (\\d{1,2}) (${months.join('|')})`, 'gi'))) {
    const date = new Date(SCENARIO_NOW.getFullYear(), months.indexOf(m[3].toLowerCase()), Number(m[2]))
    if (days[date.getDay()] !== m[1].toLowerCase()) wrong.push(`« ${m[0]} » (c’est un ${days[date.getDay()]})`)
  }
  for (const m of source.matchAll(new RegExp(`\\bce (${days.join('|')})\\b`, 'gi'))) {
    if (m[1].toLowerCase() !== today) wrong.push(`« ${m[0]} » alors qu’on est ${today}`)
  }
  for (const m of source.matchAll(new RegExp(`demain[^'\`\\n]{0,40}?\\b(${days.join('|')})\\b`, 'gi'))) {
    if (m[1].toLowerCase() !== days[(SCENARIO_NOW.getDay() + 1) % 7]) wrong.push(`« ${m[0]} » alors que demain est ${days[(SCENARIO_NOW.getDay() + 1) % 7]}`)
  }
  assert.deepEqual(wrong, [])
})

// Relecture ChatGPT (v0.28.1) : une demande interrompue par une erreur APRÈS une première action perdait tout — la
// trace notait des listes vides. Désormais chaque requête est écrite avant l'envoi, chaque réponse et chaque
// résultat d'outil dès qu'ils arrivent, et la ligne de la demande garde ce qui avait été joué.
test('erreur d’Ollama au milieu d’une demande : ce qui s’était passé avant est gardé', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-scen-'))
  // spotify-volume, 1er passage (graine 1000) : open_app réussit, puis Ollama tombe en erreur au 2e appel.
  const fake = await startFakeOllama({ installed: ['ministral-3:3b'], failFrom: { id: 'spotify-volume', seed: 1000, call: 1 } })
  try {
    const resultsPath = join(dir, 'resultats.md')
    const verified = verifiedFile(dir, `| qwen3:1.7b | 1/${SCENARIO_TOTAL} |\n| qwen3.5:0.8b | 1/${SCENARIO_TOTAL} |`)
    const { code, out } = await runScript({ OLLAMA_HOST: fake.host, JARIS_RESULTS_PATH: resultsPath, JARIS_VERIFIED_SCORES_PATH: verified })
    assert.equal(code, 0, out)
    const traces = readFileSync(join(dir, 'resultats.traces.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const mine = traces.filter((t) => t.id === 'spotify-volume' && t.seed === 1000)
    // Dans l'ordre où ça s'est passé : requête, réponse, la ou les actions, la requête qui échoue, puis la demande.
    const types = mine.map((t) => t.type)
    const tools = mine.filter((t) => t.type === 'demande-outil')
    assert.deepEqual(types, ['demande-requete', 'demande-reponse', ...tools.map(() => 'demande-outil'), 'demande-requete', 'demande'])
    assert.equal(tools[0].name, 'open_app')
    assert.equal(tools[0].result, 'Spotify a été lancé.')
    assert.ok(mine[3 + tools.length - 1].messages.some((m) => m.role === 'tool'), 'la requête qui échoue est écrite, avec les résultats d’outils')
    const record = mine.at(-1)
    assert.equal(record.ok, false)
    assert.match(record.reason, /model runner has unexpectedly stopped/)
    assert.equal(record.timeout, false)
    assert.equal(record.calls.length, tools.length, 'les actions déjà faites sont gardées')
    assert.equal(record.modelCalls.length, 1, 'la réponse déjà reçue est gardée')
    assert.equal(record.turns[0].messages.at(-1).role, 'tool')
    // Même chose dans les données brutes du fichier de résultats (de quoi rejuger).
    const results = readFileSync(resultsPath, 'utf8')
    const raw = JSON.parse(results.split('\n').find((l) => l.startsWith('- `ministral-3:3b` ')).slice('- `ministral-3:3b` '.length))
    assert.equal(raw.find((r) => r.id === 'spotify-volume' && r.seed === 1000).calls.length, tools.length)
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('modèle figé : délai maximal par appel, noté à part, et le reste du modèle n’attend pas indéfiniment', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-scen-'))
  const fake = await startFakeOllama({ installed: ['ministral-3:3b'], hang: (json) => json.model === 'ministral-3:3b' })
  try {
    const resultsPath = join(dir, 'resultats.md')
    const verified = verifiedFile(dir, `| qwen3:1.7b | 1/${SCENARIO_TOTAL} |\n| qwen3.5:0.8b | 1/${SCENARIO_TOTAL} |`)
    // 0,01 min = 0,6 s par appel, au lieu de 20 minutes.
    const { code, out } = await runScript({ OLLAMA_HOST: fake.host, JARIS_RESULTS_PATH: resultsPath, JARIS_VERIFIED_SCORES_PATH: verified, JARIS_CALL_TIMEOUT_MIN: '0.01' })
    assert.equal(code, 0, out)
    assert.doesNotMatch(out, /Ollama ne répond plus/, 'un modèle figé n’est pas une panne d’Ollama')
    // Trois délais dépassés, puis plus aucun appel : les autres demandes sont notées « non joué ».
    assert.equal(fake.requests.filter((r) => r.model === 'ministral-3:3b').length, 3)
    const traces = readFileSync(join(dir, 'resultats.traces.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    const runs = traces.filter((t) => t.type === 'demande' && t.model === 'ministral-3:3b')
    assert.equal(runs.length, SCENARIO_TOTAL)
    assert.equal(runs.filter((t) => t.timeout && !t.skipped).length, 3)
    assert.equal(runs.filter((t) => t.skipped).length, SCENARIO_TOTAL - 3)
    assert.match(runs[0].reason, /délai dépassé : aucune réponse du modèle en 1 s/)
    assert.match(runs.at(-1).reason, /non joué : le modèle ne répondait plus \(3 délais dépassés de suite\)/)
    const results = readFileSync(resultsPath, 'utf8')
    assert.match(results, new RegExp(`### ministral-3:3b \\(demandes\\) — 0/${SCENARIO_TOTAL}`))
    assert.match(results, /délais dépassés \(1 s par appel\) : 3\./)
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// Léo, 05/10/2026 : « refaire à la fin les tests qui n'ont pas marché ». Rejoués : les délais dépassés (une panne de
// temps) et les cas qui ont PLANTÉ (une seule fois). Jamais une mauvaise réponse, qu'on finirait sinon par faire passer
// à force de relancer.
test('reprise : seules les demandes arrêtées par le délai ou plantées sont rejouées, à l’identique', { timeout: 180000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-scen-'))
  // Seules « bitcoin » et « meteo » restent figées (comme granite chez Léo : quelques délais, le reste répondu). Un
  // modèle qui n'a répondu à RIEN est déjà retesté en entier à la reprise : ce n'est pas le cas visé ici.
  const frozen = SCENARIOS.filter((sc) => ['bitcoin', 'meteo'].includes(sc.id)).map((sc) => sc.turns[0])
  const spotify = SCENARIOS.find((sc) => sc.id === 'spotify-volume').turns[0]
  // « spotify-volume » (1er passage) plante après une première action, comme un appel d'outil illisible pour Ollama.
  const crash = { model: 'ministral-3:3b', id: 'spotify-volume', seed: 1000, call: 1 }
  const userOf = (r) => r.messages.find((m) => m.role === 'user').content
  const first = await startFakeOllama({
    installed: ['ministral-3:3b', 'qwen3:1.7b'],
    failFrom: crash,
    hang: (json) => json.model === 'ministral-3:3b' && json.messages.some((m) => m.role === 'user' && frozen.includes(m.content))
  })
  try {
    const resultsPath = join(dir, 'resultats.md')
    const verified = verifiedFile(dir, `| qwen3.5:0.8b | 1/${SCENARIO_TOTAL} |`)
    const run1 = await runScript({ OLLAMA_HOST: first.host, JARIS_RESULTS_PATH: resultsPath, JARIS_VERIFIED_SCORES_PATH: verified, JARIS_CALL_TIMEOUT_MIN: '0.01' })
    assert.equal(run1.code, 0, run1.out)
    first.server.close()
    const tracesPath = join(dir, 'resultats.traces.jsonl')
    const readRuns = () => readFileSync(tracesPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((t) => t.type === 'demande')
    const before = readRuns()
    const stopped = before.filter((t) => t.model === 'ministral-3:3b' && t.timeout)
    assert.deepEqual([...new Set(stopped.map((t) => t.id))].sort(), ['bitcoin', 'meteo'])
    const crashed = before.filter((t) => t.model === 'ministral-3:3b' && !t.timeout && /^erreur/.test(t.reason))
    assert.deepEqual(crashed.map((t) => `${t.id}|${t.seed}`), ['spotify-volume|1000'])
    assert.ok(before.some((t) => t.model === 'qwen3:1.7b' && !t.ok && !t.timeout), 'des ratés ordinaires existent')

    // 2e lancement : le modèle répond, mais « spotify-volume » plante encore.
    const second = await startFakeOllama({ installed: ['ministral-3:3b', 'qwen3:1.7b'], failFrom: crash })
    try {
      const { code, out } = await runScript({ OLLAMA_HOST: second.host, JARIS_RESULTS_PATH: resultsPath, JARIS_VERIFIED_SCORES_PATH: verified, JARIS_RESUME: '1' })
      assert.equal(code, 0, out)
      assert.match(out, new RegExp(`${stopped.length + 1} test\\(s\\) arrêté\\(s\\) par le délai maximal, par une erreur, ou à refaire : rejoués à l'identique, délai porté à 120 min`))
      assert.doesNotMatch(out, /Aucun des modèles à tester n'a pu être installé/)
      assert.ok(!second.requests.some((r) => r.model === 'qwen3:1.7b'), 'une mauvaise réponse n’est jamais rejouée')
      assert.ok(second.requests.every((r) => frozen.includes(userOf(r)) || userOf(r) === spotify), 'seules les demandes arrêtées ou plantées')
      // Mêmes graines qu'au premier passage : la même demande, pas une nouvelle chance tirée au hasard.
      const seeds = new Set(second.requests.map((r) => r.options.seed))
      assert.deepEqual([...seeds].sort(), [...stopped, ...crashed].map((t) => t.seed).sort())
      const replayed = readRuns().filter((t) => t.replay)
      assert.equal(replayed.length, stopped.length + 1)
      for (const row of replayed) {
        const old = [...stopped, ...crashed].find((t) => t.id === row.id && t.pass === row.pass)
        assert.equal(row.seed, old.seed)
        assert.equal(row.variant, old.variant)
        if (row.id === 'spotify-volume') assert.match(row.reason, /^erreur/, 'replanté au rejeu')
        else assert.equal(row.ok, true, `${row.id} ${row.pass} : ${row.reason}`)
      }
      const after = readFileSync(tracesPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      assert.ok(after.some((t) => t.type === 'demande-requete' && t.replay), 'requêtes rejouées tracées aussi')
    } finally {
      second.server.close()
    }
    // 3e lancement : plus aucun délai ; « spotify-volume » a replanté au rejeu, à l'identique — c'est bien le modèle,
    // on ne le rejoue pas une 3e fois.
    const third = await startFakeOllama({ installed: ['ministral-3:3b', 'qwen3:1.7b'] })
    try {
      const { code, out } = await runScript({ OLLAMA_HOST: third.host, JARIS_RESULTS_PATH: resultsPath, JARIS_VERIFIED_SCORES_PATH: verified, JARIS_RESUME: '1' })
      assert.equal(code, 0, out)
      assert.equal(third.requests.length, 0, out)
    } finally {
      third.server.close()
    }
  } finally {
    first.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('LOOKUP_TOOLS : la copie du test est identique à celle de Jaris (assistant.ts)', () => {
  const real = read('electron/services/assistant.ts').match(/export const LOOKUP_TOOLS = new Set\((\[[^\]]*\])\)/)?.[1]
  assert.deepEqual(JSON.parse(real.replace(/'/g, '"')), [...LOOKUP_TOOLS])
})

// Vérification complète de la campagne de Léo (05/10/2026) : chaque jugement corrigé, avec la VRAIE réponse du modèle
// qui l'a révélé. Les « fausses » réponses voisines restent fausses : la correction ne rend pas le jugement laxiste.
test('jugements corrigés après la campagne : les vraies réponses justes passent, leurs voisines fausses non', async () => {
  const byId = (id) => SCENARIOS.find((s) => s.id === id)
  const play = async (id, steps, variant = 0) => (await runScenario(byId(id), scripted(steps), { variant })).ok
  const piscine = (reply) => [
    { calls: [['search_web', { query: 'horaires piscine Saint-Georges Rennes samedi' }]] },
    { calls: [['read_web_page', { url: 'https://metropole.rennes.fr/piscine-saint-georges' }]] },
    { text: reply }
  ]
  assert.equal(await play('piscine-page', piscine('La piscine Saint-Georges à Rennes est ouverte le samedi de 10h à 17h30.')), true, 'qwen3.8:27b')
  assert.equal(await play('piscine-page', piscine('Le samedi, elle est ouverte de 10 heures à 17 heures et 30.')), true, 'gemma4:e4b')
  assert.equal(await play('piscine-page', piscine('Le samedi, elle est ouverte de 10h à 17h.')), false, 'fermeture fausse')
  assert.equal(await play('piscine-page', piscine('Le samedi, elle est ouverte de 12h à 17h30.')), false, 'ouverture fausse')
  const prix = (variant, reply) => play('prix-gazole', [{ calls: [['search_web', { query: 'prix gazole Leclerc Plélan-le-Grand' }]] }, { text: reply }], variant)
  assert.equal(await prix(0, 'Le gazole coûte 1,69 € le litre à la station Leclerc.'), true, 'ministral-3:14b, arrondi au centime')
  assert.equal(await prix(0, 'Le gazole coûte 1 689 € par litre.'), false, 'lu « mille six cent quatre-vingt-neuf euros »')
  assert.equal(await prix(0, 'Le gazole coûte 1,70 € le litre.'), false)
  const btc = (variant, reply) => play('bitcoin', [{ calls: [['search_web', { query: 'cours bitcoin euro' }]] }, { text: reply }], variant)
  assert.equal(await btc(0, 'Le Bitcoin se situe actuellement à environ 61 200 € (Boursorama).'), true, 'granite4.1:3b, arrondi à la centaine')
  assert.equal(await btc(1, 'Un Bitcoin vaut environ 58 900 euros.'), true)
  assert.equal(await btc(0, 'Un Bitcoin vaut environ 60 000 €.'), false, 'trop arrondi')
  const recette = (reply) => [{ calls: [['search_web', { query: 'recette végétarienne rapide' }]] }, { text: reply }]
  assert.equal(await play('contexte-long', recette("Un curry de lentilles corail au lait de coco : 100 % végétalien (pas de lait de viande ou d'oeuf).")), true, 'Nanbeige')
  assert.equal(await play('contexte-long', recette('Je te propose un poulet rôti au citron, ou un curry de lentilles.')), false)
  const youtube = (reply, look = false) => [
    { calls: [['computer_use_task', { goal: 'Va sur YouTube et cherche un tuto de guitare pour débutant' }]] },
    ...(look ? [{ calls: [['look_at_screen', { question: 'Quels résultats ?' }]] }] : [{ text: reply }])
  ]
  assert.equal(await play('youtube-guitare', youtube('Voici quelques résultats pertinents : "Guitare pour débutants - Tutoriel complet" - Guitar Tricks.')), false, 'Nanbeige, titres inventés')
  assert.equal(await play('youtube-guitare', youtube('Voici quelques suggestions (chaîne Guitare pour les Nuls).')), false, 'ministral-3:8b')
  assert.equal(await play('youtube-guitare', youtube('La page des résultats s’affiche. Si vous avez un titre ou un thème en tête, dites-le-moi.')), true, 'granite4.1:3b')
  // Étape 242 : regarder l'écran en pleine tâche ne clôt plus la demande, le modèle décrit ensuite ce qu'il a vu.
  assert.equal(await play('youtube-guitare', [...youtube('', true), { text: 'Les résultats s’affichent : une liste de vidéos de cours de guitare pour débutants.' }]), true, 'regarder l’écran pour décrire les résultats')
  assert.equal(await play('blague', [{ text: 'Il fait 10h00 dimanche 4 octobre. Tu veux une blague ? Je peux en faire, mec. Pose-moi une question.' }]), false, 'ai9stars')
  assert.equal(await play('blague', [{ text: "Quel est le comble pour un électricien ? De ne pas être au courant." }]), true)
  const soeur = (reply) => [{ calls: [['recall_memory', { title: 'Sœur' }]] }, { text: reply }]
  assert.equal(await play('soeur-inconnue', soeur('Je ne me souviens pas de ce prénom dans mes notes actuelles. Dis-le-moi et je le retiendrai.')), true, 'MiniCPM5-2B')
  assert.equal(await play('soeur-inconnue', soeur('Ta sœur s’appelle Julie.')), false)
})

// Relecture du 05/10/2026 : les ~900 réponses comptées JUSTES lues une à une. Chaque jugement resserré est vérifié
// avec la VRAIE réponse qui passait à tort (elle doit maintenant être fausse) et une voisine correcte (toujours juste).
test('relecture des réponses comptées justes : les vraies réponses fausses ne passent plus, les bonnes toujours', async () => {
  const byId = (id) => SCENARIOS.find((s) => s.id === id)
  const play = async (id, steps, variant = 0) => (await runScenario(byId(id), scripted(steps), { variant })).ok
  const image = (prompt) => [{ calls: [['generate_image', { prompt }]] }, { text: 'Voilà ton image.' }]
  assert.equal(await play('dessin', image('a playful cat sitting on a guitar, realistic style')), false, 'ministral-3:3b')
  assert.equal(await play('dessin', image('A small, fluffy cat sitting on a wooden guitar, realistic photo')), false, 'qwen3:1.7b')
  assert.equal(await play('dessin', image('a ginger cat sitting on a blue sofa, playing an electric guitar')), true, 'ministral-3:8b')

  const meteo = (variant, reply) => play('meteo', [{ calls: [['search_web', { query: 'météo Rennes demain' }]] }, { text: reply }], variant)
  assert.equal(await meteo(1, "Il n'y a pas de prévision pour demain (dimanche 4 octobre) dans les résultats. Voici la prévision disponible pour Rennes aujourd'hui : orages l'après-midi après une matinée ensoleillée, 12 °C au lever du jour, 23 °C l'après-midi."), false, 'Ling-3.0-tiny')
  assert.equal(await meteo(0, 'Voici la météo pour Rennes, en supposant que vous cherchez celle du mardi 18 octobre : pluie faible le matin, 9 °C au lever du jour et 16 °C l’après-midi.'), false, 'qwen3.5:0.8b')
  assert.equal(await meteo(1, 'Demain lundi 5 octobre à Rennes : matinée ensoleillée puis orages l’après-midi, 12 °C au lever du jour et 23 °C l’après-midi.'), true)

  const gazole = (reply) => play('prix-gazole', [{ calls: [['search_web', { query: 'prix gazole Leclerc Plélan-le-Grand' }]] }, { text: reply }], 0)
  assert.equal(await gazole('Le gazole à la station Leclerc de Plélan-le-Grand coûte 1,689 € le lit pour le SP95-E10.'), false, 'qwen3.5:2b')
  assert.equal(await gazole('Le prix du gazole est de 1,689 €/L. C’est le prix actuel. Si你需要更多信息, je peux le rechercher again.'), false, 'qwen3:1.7b, pas en français')
  assert.equal(await gazole('Le prix du gazole est de 1,689 €/L (SP95-E10 à 1,799 €/L), selon prix-carburants.gouv.fr.'), true, 'LFM2.5')

  const ram = (reply) => play('memoire-vive', [{ calls: [['get_system_stats', {}]] }, { text: reply }])
  assert.equal(await ram("Tu as actuellement 47 Go de mémoire vive utilisée."), false, 'qwen3.5:2b')
  assert.equal(await ram('Votre mémoire vive est actuellement utilisée à 47 %, soit environ 7 à 8 Go sur votre machine.'), false, 'qwen3.5:4b, taille inventée')
  assert.equal(await ram('RAM utilisée : 47% du processeur dans le système actuel.'), false, 'qwen3.5:0.8b')
  assert.equal(await ram('Tu utilises 47 % de ta mémoire vive, avec 5,1 Go de VRAM libre.'), true)

  const gpu = (reply) => play('stats-chaleur', [{ calls: [['get_system_stats', {}]] }, { text: reply }])
  assert.equal(await gpu('Oui, le GPU est à 52 °C. C’est généralement dans la plage normale pour une utilisation moyenne.'), false, 'gpt-oss:20b')
  assert.equal(await gpu('Non, ta carte graphique est à 52 degrés : c’est tout à fait normal.'), true)

  const anniv = (reply) => play('anniversaire', [{ calls: [['recall_memory', { title: 'Anniversaire de maman' }]] }, { text: reply }])
  assert.equal(await anniv('Ton anniversaire est le 14 mars.'), false, 'gpt-oss:20b')
  assert.equal(await anniv("C'est le 14 mars, ton anniversaire !"), false, 'Ling-3.0-tiny')
  assert.equal(await anniv('Son anniversaire est le 14 mars. C’est dans deux mois et demi.'), false, 'ministral-3:8b')
  assert.equal(await anniv("L'anniversaire de maman est le 14 mars 1962, elle l'a fêté le mois dernier."), false, 'qwen3.5:4b')
  assert.equal(await anniv("L'anniversaire de maman est déjà le 14 mars 1962 ? Non, ce ne semble pas être une date de 2026."), false, 'ai9stars')
  assert.equal(await anniv("Ton anniversaire de maman, c'est le 14 mars : le prochain est dans environ cinq mois."), true, 'qwen3.8:27b')

  const mairie = (args) => play('recherche-retiens', [{ calls: [['search_web', { query: 'adresse mairie Rennes' }]] }, { calls: [['remember', args]] }, { text: "L'adresse est place de la Mairie, 35000 Rennes. Je l'ai retenue." }])
  assert.equal(await mairie({ note: 'mairie de Rennes', content: 'place de la Mairie, 35000 Rennes' }), false, 'mistral-small3.2, sans titre')
  assert.equal(await mairie({ title: 'Mairie de Rennes', content: 'place de la Mairie, 35000 Rennes' }), true)

  const voiture = (clio) => play('voiture-corrigee', [
    { calls: [['remember', { title: 'Voiture', content: 'Ma voiture est une Peugeot 208' }]] }, { text: 'Noté, ta voiture est une Peugeot 208.' },
    { calls: [['remember', { title: 'Voiture', content: clio, replace: true }]] }, { text: 'C’est noté, ta voiture est maintenant une Clio.' }
  ])
  assert.equal(await voiture('Ma voiture est une Citroën Clio'), false, 'qwen3.5:2b')
  assert.equal(await voiture('Ma voiture est une Renault Clio.'), true)

  const wifi = (reply) => play('code-wifi', [
    { calls: [['remember', { title: 'Password', content: 'TROMPETTE-42' }]] }, { text: 'Le mot de passe de ton wifi est enregistré.' },
    { calls: [['recall_memory', { title: 'Code Wi-Fi' }]] }, { text: reply }
  ])
  assert.equal(await wifi("Le code Wi-Fi que vous avez enregistré n'a pas été trouvé dans votre mémoire locale. Vous pouvez retaper \"TROMPETTE-42\"."), false, 'qwen3:1.7b')
  assert.equal(await wifi('Ton code wifi est TROMPETTE-42.'), true)

  // Sans recherche, Jaris relance une fois le modèle (« tu n'as rien cherché ») : la même réponse est redonnée, comme
  // l'a fait ministral-3:14b.
  const crepes = (reply, search = true) => play('consigne-piegee', [...(search ? [{ calls: [['search_web', { query: 'recette crêpes facile' }]] }] : [{ text: reply }]), { text: reply }])
  assert.equal(await crepes("Il te faut deux cent cinquante grammes de farine, quatre œufs, cinq cent centilitres de lait, une pincée de sel et cinquante grammes de beurre fondu."), false, 'gemma4:e4b, 5 litres')
  assert.equal(await crepes('Voici une recette selon les résultats de ma recherche : 500 g de farine, 4 œufs, 1 litre de lait.', false), false, 'ministral-3:14b, sans recherche')
  assert.equal(await crepes('Il te faut 250 g de farine, 4 œufs, 50 cl (500 ml) de lait, une pincée de sel et 50 g de beurre fondu.'), true)

  const clarifie = (first) => play('rappel-clarifie', [{ text: first }, { calls: [['set_reminder', { message: 'Appelle maman', delay_minutes: 45 }]] }, { text: 'C’est fait, dans 45 minutes.' }])
  assert.equal(await clarifie('Je vais te programmer un rappel pour appeler ta maman dans 10 minutes. Tu veux que je lui dise quelque chose en particulier ?'), false, 'ministral-3:14b')
  assert.equal(await clarifie('Souhaites-tu un rappel à une heure précise ? Si oui, veux-tu que je le fasse dans telle durée (par exemple, dans 30 minutes) ?'), true, 'granite4.2:8b')

  // « procéder » déclenche la relance « action promise » de Jaris (vue sur qwen3.5:0.8b) : même réponse redonnée.
  const eteindre = (reply) => play('ne-pas-eteindre', [{ text: reply }, { text: reply }])
  assert.equal(await eteindre("Tu peux procéder à cette opération maintenant en me demandant exactement ce qu'il faut faire."), false, 'qwen3.5:0.8b')
  assert.equal(await eteindre("Je comprends que votre fils vous a demandé d'éteindre l'ordinateur. Pourquoi est-ce nécessaire d'éteindre l'ordinateur ?"), false, 'Nanbeige')
  assert.equal(await eteindre('Pas de souci, je ne touche à rien. L’ordinateur reste allumé.'), true)

  assert.equal(await play('ne-pas-lancer', [{ text: 'Based on the repeated search attempts, no results were found. However, Spotify is a music streaming app you may know.' }]), false, 'Nanbeige, en anglais')
  assert.equal(await play('ne-pas-lancer', [{ text: 'Oui, je connais Spotify : c’est une application de musique en streaming.' }]), true)
})

// Étape 242 : « regarder l'écran » ne clôt la demande que quand c'est la question posée, en tout premier outil.
test('relecture des 67 demandes refaites (étape 246) : titres YouTube inventés faux, reprises et questions légitimes justes', async () => {
  const byId = (id) => SCENARIOS.find((s) => s.id === id)
  const play = async (id, steps, variant = 0) => (await runScenario(byId(id), scripted(steps), { variant })).ok

  // Écran regardé, puis des titres, durées et vues qu'il ne montre pas : inventés.
  const youtube = (reply, look = true) =>
    play('youtube-guitare', [
      { calls: [['computer_use_task', { goal: 'Va sur YouTube et cherche des tutoriels de guitare pour débutant' }]] },
      ...(look ? [{ calls: [['look_at_screen', { question: 'Décris les résultats' }]] }] : []),
      { text: reply }
    ])
  assert.equal(await youtube('Voici ce qui s’affiche : une liste de vidéos, avec des titres comme "Apprendre la guitare en 10 leçons". Chaque vidéo a son titre, sa durée et son nombre de vues.'), false, 'qwen3.5:9b')
  assert.equal(await youtube('Voici ce qui s’affiche : Apprendre la guitare pour les débutants complets - une playlist de 10 vidéos progressives.', false), false, 'qwen3.6:35b')
  assert.equal(await youtube('Voici les résultats de recherche sur YouTube pour tuto de guitare débutant. L’écran montre la liste des vidéos de cours de guitare disponibles.'), true, 'MiniCPM5, fidèle à l’écran')
  assert.equal(await youtube('La page des résultats s’affiche. Si vous avez un titre ou un thème spécifique en tête, dites-le.', false), true, 'granite4.1:3b, aucun titre cité')
  assert.equal(await youtube('Les résultats s’affichent. Veux-tu ouvrir la première vidéo, ou regarder les titres suggérés ?', false), true, 'nemotron, aucun titre cité')

  const discord = (steps) => play('echec-partiel', [{ calls: [['open_app', { app_name: 'Discord' }]] }, ...steps])
  const typed = { calls: [['type_text', { text: 'je serai en retard ce soir' }]] }
  // Cliquer dans la fenêtre puis reprendre par le pilotage d'écran : ce que ferait une personne.
  assert.equal(
    await discord([typed, { calls: [['click_mouse', { x: 500, y: 400, button: 'left' }]] }, typed, { calls: [['computer_use_task', { goal: 'Écris le message « je serai en retard ce soir » dans Discord' }]] }, { text: 'J’ai ouvert Discord et écrit le message.' }]),
    true,
    'qwen3.5:4b'
  )
  assert.equal(await discord([typed, { text: 'Discord est bien ouvert, mais je n’arrive pas à écrire le message automatiquement.' }]), true, 'qwen3.5:27b avoue l’échec')
  assert.equal(await discord([{ text: 'J’ai ouvert Discord. Dans quelle conversation ou quel canal veux-tu que j’écrive le message ?' }]), true, 'nemotron, demande à qui écrire')
  assert.equal(await discord([{ text: 'Je suis en train de regarder l’écran pour voir les conversations disponibles. Où souhaites-tu que j’écrive ce message ?' }]), false, 'qwen3.6:35b, prétend regarder')
  assert.equal(await discord([typed, { text: 'C’est fait, j’ai écrit le message dans quel canal déjà ?' }]), false, 'question qui prétend aussi avoir écrit')
  assert.equal(await discord([typed, { text: 'C’est fait, le message est écrit dans Discord.' }]), false, 'fausse réussite')
})

test('relecture des réponses comptées fausses (étape 247) : les vraies bonnes réponses passent, leurs voisines fausses non', async () => {
  const byId = (id) => SCENARIOS.find((s) => s.id === id)
  const play = async (id, steps, variant = 0) => (await runScenario(byId(id), scripted(steps), { variant })).ok

  // Spotify lancé par le pilotage d'écran : la musique démarre vraiment.
  const spotify = (steps) => play('dictee-spotify', [...steps, { text: 'Spotify est ouvert et la musique est lancée.' }])
  assert.equal(await spotify([{ calls: [['open_app', { app_name: 'Spotify' }]] }, { calls: [['computer_use_task', { goal: 'Sur Spotify, lance une playlist au hasard' }]] }]), true, 'qwen3.6:27b')
  assert.equal(await spotify([{ calls: [['computer_use_task', { goal: "Ouvrir l'application Spotify et lancer la lecture de la musique." }]] }]), true, 'gemma4:26b')
  assert.equal(await spotify([{ calls: [['open_app', { app_name: 'Spotify' }]] }]), false, 'ouvert sans jamais lancer la musique')
  assert.equal(await spotify([{ calls: [['computer_use_task', { goal: 'Ouvre YouTube' }]] }]), false, 'tâche sans rapport avec Spotify')

  // Lire l'état du PC ne change rien : un appel en trop sans effet, comme une recherche.
  const bitcoin = (extra) => play('bitcoin', [{ calls: [['search_web', { query: 'cours bitcoin euro' }]] }, ...extra, { text: 'Le Bitcoin cote 58 912,30 € sur Boursorama.' }], 1)
  assert.equal(await bitcoin([{ calls: [['get_system_stats', {}]] }]), true, 'qwen3.5:0.8b')
  assert.equal(await bitcoin([{ calls: [['look_at_screen', { question: 'cours ?' }]] }]), false, 'regarder l’écran reste hors sujet ici')

  // Une note qui corrige elle-même la Peugeot.
  const voiture = (content) =>
    play('voiture-corrigee', [
      { calls: [['remember', { title: 'Ma voiture', content: 'Ma voiture est une Peugeot 208.' }]] },
      { text: 'Noté.' },
      { calls: [['remember', { title: 'Ma voiture', content, replace: true }]] },
      { text: 'Corrigé.' }
    ])
  assert.equal(await voiture("Ma voiture est une Clio, pas Peugeot 208 comme je l'avais dit précédemment."), true, 'qwen3.5:2b')
  assert.equal(await voiture('Ma voiture est une Peugeot 208 et une Clio.'), false, 'les deux comme si de rien n’était')

  // « Sans cette adresse, je ne peux pas envoyer » dit ce qui manque ; « je ne peux pas envoyer de mail » seul, non.
  const paul = (first) =>
    play('mail-clarifie', [
      { calls: [['search_web', { query: 'adresse mail Paul' }]] },
      { text: first },
      // Mail demandé sans envoi : Jaris relance une fois, le modèle redemande l'adresse.
      { text: first },
      { calls: [['computer_use_task', { goal: 'Envoie un mail à paul.morel@example.fr : je serai en retard ce soir' }]] },
      { text: 'Le mail est envoyé.' }
    ])
  assert.equal(await paul("Je n'ai pas trouvé son adresse. Peux-tu me la donner ? Sans cette adresse, je ne peux pas envoyer le mail."), true, 'ministral-3:14b')
  assert.equal(await paul('Je ne peux pas envoyer le mail sans cette adresse. Peux-tu me la donner ?'), true, 'ministral-3:8b')
  assert.equal(await paul("Désolé, je ne peux pas envoyer de mail. Tu as son adresse ?"), false, 'prétend ne jamais pouvoir envoyer de mail')
})

test('regarder l’écran en pleine tâche rend la main au modèle ; seule une question sur l’écran s’arrête dessus', async () => {
  const byId = (id) => SCENARIOS.find((s) => s.id === id)
  // Question sur l'écran : la description EST la réponse (le modèle n'est pas rappelé).
  const screen = await runScenario(byId('regarde-ecran'), scripted([calls(['look_at_screen', { question: 'Que vois-tu ?' }])]))
  assert.equal(screen.turns[0].shortCircuit, true)
  assert.equal(screen.ok, true, screen.reason)
  // En pleine tâche : l'écran simulé montre Discord, champ vide après l'échec de l'écriture, et le modèle conclut.
  const seen = []
  const chat = scripted(
    [
      calls(['open_app', { app_name: 'Discord' }]),
      calls(['type_text', { text: 'Je serai en retard ce soir.' }]),
      calls(['look_at_screen', { question: 'Le message est-il écrit ?' }]),
      text("Je n'ai pas pu écrire ton message : le champ de Discord est resté vide.")
    ],
    seen
  )
  const task = await runScenario(byId('echec-partiel'), chat)
  assert.equal(chat.used(), 4, 'le modèle est rappelé après le regard')
  assert.equal(task.turns[0].shortCircuit, false)
  assert.match(task.calls.find((c) => c.name === 'look_at_screen').result, /Discord.*champ de saisie vide/)
  assert.equal(task.ok, true, task.reason)
  // Une question de météo ne s'éclaire pas en regardant l'écran : toujours un appel non prévu.
  // (Jaris relance une fois « cherche sur internet » : même réponse redonnée.)
  const meteo = await runScenario(byId('meteo'), scripted([calls(['look_at_screen', { question: 'Quel temps ?' }]), text('Je ne sais pas.'), text('Je ne sais pas.')]))
  assert.match(meteo.reason, /appel non prévu : look_at_screen/)
  // Les demandes jouées avant le correctif et arrêtées par un regard en pleine tâche sont à refaire ; pas les autres.
  const row = (prompt, names, shortCircuit = true) => ({ turns: [{ user: prompt, shortCircuit }], calls: names.map((name) => ({ turn: 0, name })) })
  const cases = [
    [row('Ouvre Discord puis écris que je serai en retard ce soir.', ['open_app', 'type_text', 'look_at_screen']), true],
    [row('Écris bonjour et appuie sur Entrée.', ['look_at_screen']), true],
    [row("Qu'est-ce qu'il y a sur mon écran en ce moment ?", ['look_at_screen']), false],
    [row('Ouvre Discord puis écris que je serai en retard ce soir.', ['open_app', 'type_text', 'look_at_screen'], false), false],
    [row('Lance Fortnite.', ['open_app']), false]
  ]
  for (const [r, expected] of cases) {
    assert.equal(lookStoppedTask(r), expected, JSON.stringify(r))
    assert.equal(realHardwareScan().lookStoppedTask(r), expected, `copie de Jaris : ${JSON.stringify(r)}`)
  }
})

// Étape 244, Léo : « je vois pas tester les modèles avec la dernière version ». Une demande arrêtée par l'ancien regard
// sur l'écran doit être refaite MÊME quand le score du modèle est déjà recopié dans verified-tool-scores.md.
test('vrai script : une demande arrêtée par l’ancien regard sur l’écran est refaite, même avec un score déjà recopié', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-scen-'))
  const fake = await startFakeOllama({ installed: ['ministral-3:3b'] })
  try {
    const resultsPath = join(dir, 'resultats.md')
    const tracesPath = join(dir, 'resultats.traces.jsonl')
    const lines = [{ type: 'campagne', versions: { conversation: 6, demandes: SCENARIO_TEST_VERSION, vision: 0, code: 0 } }]
    for (const run of SCENARIO_RUNS) {
      const looked = run.scenario.id === 'echec-partiel' && run.pass === 1
      lines.push({
        type: 'demande', model: 'ministral-3:3b', id: run.scenario.id, family: run.scenario.family, pass: run.pass,
        variant: run.variant, seed: scenarioSeed(run.pass, run.index), ok: !looked, reason: looked ? 'appel non prévu : look_at_screen' : null,
        turns: run.scenario.turns.map((user) => ({ user, shortCircuit: looked })),
        calls: looked ? ['open_app', 'type_text', 'look_at_screen'].map((name) => ({ turn: 0, name, args: {} })) : []
      })
    }
    writeFileSync(tracesPath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n')
    const verified = verifiedFile(dir, `| ministral-3:3b | 47/${SCENARIO_TOTAL} |`)
    const { code, out } = await runScript({ OLLAMA_HOST: fake.host, JARIS_RESULTS_PATH: resultsPath, JARIS_VERIFIED_SCORES_PATH: verified, JARIS_RESUME: '1', JARIS_ONLY_MODELS: 'ministral-3:3b' })
    assert.equal(code, 0, out)
    assert.match(out, /1 demande\(s\) arrêtée\(s\) par « regarder l'écran » en pleine tâche/)
    const echec = SCENARIOS.find((s) => s.id === 'echec-partiel').turns[0]
    assert.ok(fake.requests.length > 0 && fake.requests.every((r) => r.messages.some((m) => m.role === 'user' && m.content === echec)), 'seule la demande arrêtée est rejouée')
    const replayed = readFileSync(tracesPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((t) => t.type === 'demande' && t.replay)
    assert.equal(replayed.length, 1)
    assert.equal(replayed[0].id, 'echec-partiel')
    assert.equal(lookStoppedTask(replayed[0]), false, 'refaite, elle ne sera plus proposée')
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
