# Jaris

Assistant IA personnel vocal, inspiré de J.A.R.V.I.S. — **100% local, 0€/mois**.
Electron + React + TypeScript, aucun appel à une API payante : tout le pipeline
(voix → réflexion → réponse) tourne sur la machine.

## État actuel

- ✅ Étape 1 — Projet Electron + React + TS (Vite / electron-vite) initialisé
- ✅ Étape 2 — Visage animé (`JarisFace`) avec 5 états d'émotion : veille,
  écoute, réflexion, content, surpris
- ✅ Étape 3 — Pipeline vocal local : mot d'activation (openWakeWord),
  transcription (faster-whisper), synthèse vocale (Piper). **Testé de bout
  en bout avec un vrai micro** (voir plus bas)
- ✅ Étape 4 — Connexion Ollama : Jaris comprend vraiment ce que tu dis et
  répond avec un LLM local (`qwen3.5:9b` par défaut, configurable)
- ✅ Étape 5 — Tool calling : Jaris peut ouvrir des applications et
  programmer des rappels vocaux (persistés, survivent à un redémarrage de
  Jaris avant l'échéance) — voir plus bas
- ✅ Étape 6 — Vision d'écran : Jaris peut capturer l'écran et le décrire ou
  répondre à une question dessus, via un modèle de vision local (`qwen3-vl:8b`
  par défaut, séparé du modèle de conversation) — voir plus bas
- ✅ Étape 7 — Recherche web : Jaris peut chercher sur le web via une
  instance [SearXNG](https://github.com/searxng/searxng) auto-hébergée
  (Docker), aucune clé API ni compte — voir plus bas
- ⬜ Étape 8 — Mémoire locale façon Obsidian : Jaris enregistre ce qu'il
  retient (préférences, infos données en conversation, résumés) dans de
  simples fichiers markdown liés entre eux sur le disque, plutôt que dans une
  base opaque. Un bouton "Voir le cerveau de Jaris" dans l'interface ouvre ce
  dossier de mémoire pour le consulter/modifier à la main
- ⬜ Étape 9 — Envoi de mails
- ⬜ Étape 10 — Sélection automatique de modèle selon la complexité de la
  question : un petit modèle rapide (ex: `phi-4-mini`) pour les questions
  simples/rapides, `qwen3.5` pour le reste, afin de gagner du temps et de la
  VRAM sur les échanges courants sans sacrifier la qualité sur les questions
  qui le méritent
- ⬜ Étape 11 — Surveillance des ressources du PC : Jaris prévient à voix
  haute quand la machine est surchargée (GPU, CPU, RAM trop élevés), pour
  éviter de lancer une tâche lourde ou d'insister sur une réponse lente sans
  prévenir
- ⬜ Étape 12 — Contrôle clavier et souris : Jaris peut écrire du texte et
  cliquer à la place de l'utilisateur, pour automatiser des actions
  complètes sur l'ordinateur (pas seulement ouvrir une application)
- ⬜ Étape 13 — Intégration téléphone : voir les notifications, envoyer des
  messages et passer des appels depuis le téléphone de l'utilisateur, en
  s'appuyant sur un projet open source existant faisant le pont PC/téléphone
  (ex: KDE Connect) plutôt que de tout réécrire
- ⬜ Étape 14 — Installeur en un clic : empaqueter toute la chaîne (app +
  Ollama + modèles) dans un seul installeur simple, pour que d'autres
  utilisateurs puissent installer Jaris sans suivre toutes les étapes
  manuelles de ce README
- ⬜ Étape 15 — Amélioration du design de l'interface
- ⬜ Étape 16 — Animation pendant la capture/analyse d'écran, pour donner un
  retour visuel pendant que Jaris "regarde" (étape 6)
- ⬜ Étape 17 — Mode toujours visible : petite fenêtre Jaris affichée en
  permanence en bas à droite de l'écran (widget flottant), au lieu de
  n'apparaître que quand la fenêtre principale a le focus
- ⬜ Étape 18 — Mise à jour automatique de l'application dès qu'une nouvelle
  version est publiée
- ⬜ Étape 19 — Préparation à la vente (~5€) : licence, protection contre la
  copie/redistribution du logiciel. Nécessitera au préalable de vérifier la
  compatibilité des licences des briques open source utilisées (Ollama,
  modèles Qwen, openWakeWord, faster-whisper, Piper, SearXNG) avec une
  distribution commerciale
- ⬜ Étape 20 — Site web avec tableau de bord personnel : chaque utilisateur
  peut noter son planning et sa to-do list sur le site, et Jaris peut y
  écrire des informations
- ⬜ Étape 21 — Jaris connaît la date et l'heure : briefing du matin
  (planning du jour, tâches à faire), et ajoute automatiquement une tâche à
  la to-do list du site dès que l'utilisateur en mentionne une à voix haute
- ✅ Étape 22 — Personnalisation, prénom de l'utilisateur : au tout premier
  lancement, Jaris demande comment l'appeler (une seule fois, sauvegardé
  localement) et s'adresse ensuite à l'utilisateur par son prénom en
  conversation — voir plus bas
- ⬜ Étape 23 — Paramètres avancés : page dédiée pour tout personnaliser
  (connecter son planning/calendrier, son Gmail, choisir la langue, etc.)
- ⬜ Étape 24 — Sous-agents : Jaris peut lancer plusieurs sous-agents (agents
  web, etc.) en parallèle pour des tâches complexes qui demandent plusieurs
  actions en même temps, au lieu de tout faire en une seule séquence
- ⬜ Étape 25 — Scan de capacité au premier lancement : Jaris analyse le PC
  (GPU, VRAM, RAM) pour vérifier qu'il peut faire tourner les modèles par
  défaut ; si la machine n'est pas assez puissante, il propose automatiquement
  des modèles plus légers. Dans le bouton options, une liste de modèles
  classés du plus puissant au plus léger, avec sélection automatique (ou
  manuelle) de 3 modèles selon le profil de la machine : un modèle qui
  réfléchit beaucoup pour les tâches complexes, un modèle médium, et un
  modèle "flash" rapide pour les questions simples
- ⬜ Étape 26 — Mentions légales / conditions d'utilisation à faire accepter
  avant la première utilisation, pour dégager la responsabilité en cas
  d'action problématique de l'IA
- ⬜ Étape 27 — Publication et monétisation : site pour vendre un abonnement
  (~10€/mois), avec une protection contre la redistribution à d'autres
  personnes — par exemple un identifiant unique par utilisateur/licence pour
  pouvoir tracer une copie qui circule (piste à creuser, pas encore figée)

## Démarrer en développement

```bash
npm install
cp .env.example .env   # puis remplis les valeurs, voir ci-dessous
npm run dev
```

Au tout premier lancement, Jaris demande comment l'appeler (juste un
prénom, sauvegardé localement) — il ne le redemandera plus ensuite, et
s'adressera à toi par ton prénom en conversation.

Sans configuration vocale, la fenêtre s'ouvre quand même après ça : un
bandeau indique ce qui manque.

## Mettre en place le pipeline vocal (étape 3)

Zéro compte, zéro clé à créer : tout se télécharge directement.

> **Mot d'activation : "Hey Jarvis" (en anglais), pas "Jaris".**
> openWakeWord (le moteur 100% local et gratuit, sans compte) ne fournit pas
> de mot-clé "Jaris" prêt à l'emploi — le plus proche livré nativement est
> "Hey Jarvis", qu'on utilise donc par défaut. Un vrai mot-clé "Jaris"
> demanderait d'entraîner un modèle maison (notebook fourni par
> openWakeWord, plus de travail) ; ce n'est pas fait pour l'instant.

### 1. Environnement Python (mot d'activation + reconnaissance vocale)

Un seul process Python à côté d'Electron gère le micro, la détection du mot
d'activation et la transcription.

```bash
python -m venv python/venv
python/venv/Scripts/activate   # (Windows) — python/venv/bin/activate sur Mac/Linux
pip install -r python/requirements.txt
python python/download_wakeword_models.py   # télécharge les modèles openWakeWord (~5 Mo) dans models/wakeword/
```

Renseigne dans `.env` :
- `PYTHON_BIN` → chemin vers `python/venv/Scripts/python.exe`
- `WHISPER_MODEL` → `small` (rapide) ou `medium` (plus précis) pour le français
- `WHISPER_DEVICE=cuda` sur la RTX 3070 (nécessite les DLL CUDA/cuDNN livrées
  avec `pip install nvidia-cublas-cu12 nvidia-cudnn-cu12` si `ctranslate2` ne
  les trouve pas), sinon `cpu`
- `WAKEWORD_THRESHOLD` si le mot d'activation se déclenche trop souvent/pas
  assez (0 à 1, défaut 0.5)

### 2. Synthèse vocale (Piper)

1. `mkdir -p bin/piper models/tts`
2. Télécharge le binaire Windows sur les
   [releases GitHub de Piper](https://github.com/rhasspy/piper/releases)
   (`piper_windows_amd64.zip`), dézippe dans `bin/piper/`.
3. Télécharge une voix française, par exemple `fr_FR-siwis-medium`, depuis le
   [dépôt de voix Piper](https://huggingface.co/rhasspy/piper-voices/tree/main/fr/fr_FR)
   (les deux fichiers `.onnx` et `.onnx.json`) dans `models/tts/`.
4. Vérifie que `.env` pointe bien vers ces chemins (`PIPER_BIN_PATH`,
   `PIPER_VOICE_PATH`).

### Vérifier

`npm run dev` : dis "Hey Jarvis" près du micro, Jaris doit s'illuminer,
transcrire ce que tu dis ensuite, puis le redire à voix haute pour confirmer
qu'il a compris — c'est la preuve que toute la chaîne audio fonctionne, avant
de brancher un vrai raisonnement à l'étape 4.

> Pipeline testé de bout en bout avec un vrai micro sur une machine Windows
> (RTX 3070) : mot d'activation, capture, transcription et synthèse vocale
> fonctionnent tous en conditions réelles.
>
> Deux pièges rencontrés en conditions réelles, déjà corrigés dans le code :
> le périphérique micro par défaut du système n'est pas forcément le bon
> (ex: un micro virtuel type Voice Changer/Voicemod) — utilise
> `python -m sounddevice` pour lister les micros et choisir le bon index via
> `WAKEWORD_INPUT_DEVICE` ; et Whisper peut halluciner du texte plausible sur
> du silence (le pipeline filtre déjà ça via la détection de voix intégrée).
>
> Un raccourci clavier **+** (dans la fenêtre Jaris) déclenche aussi l'écoute
> manuellement, sans dire le mot d'activation — pratique pour tester ou en
> environnement bruyant.

## Mettre en place Ollama (étape 4)

1. Installe [Ollama](https://ollama.com/) (installeur Windows classique)
2. Télécharge le modèle de raisonnement :
   ```
   ollama pull qwen3.5:9b
   ```
3. Vérifie dans `.env` que `OLLAMA_HOST` (`http://127.0.0.1:11434` par
   défaut) et `OLLAMA_MODEL` (`qwen3.5:9b` par défaut) sont corrects — le nom
   du modèle est entièrement configurable, pas besoin de toucher au code pour
   en changer

Ollama doit être lancé (il tourne en arrière-plan une fois installé) pour que
Jaris puisse réfléchir. S'il n'est pas joignable, Jaris le dit à voix haute au
lieu de planter.

> Le modèle a par défaut une fenêtre de contexte énorme (131072 tokens pour
> qwen3.5), ce qui peut le faire déborder de la VRAM et tourner en partie sur
> le CPU (très lent). `OLLAMA_NUM_CTX` dans `.env` (4096 par défaut) évite ça
> — vérifie avec `ollama ps` que la colonne PROCESSOR affiche bien ~100% GPU.

## Ouvrir des applications et programmer des rappels (étape 5)

Jaris peut maintenant exécuter deux actions pendant la conversation :
ouvrir une application, ou programmer un rappel vocal ("rappelle-moi de
sortir le linge dans 10 minutes").

**Ouvrir des applications** : aucune configuration nécessaire. Jaris
interroge directement le menu Démarrer de Windows (classiques et Store) pour
trouver l'application dont le nom se rapproche le plus de ce que tu as dit,
puis la lance — toute application installée sur ta machine est utilisable
sans liste à maintenir.

**Rappels** : dis simplement "Jaris, rappelle-moi de [...] dans [x] minutes"
— pas de configuration nécessaire, c'est un outil intégré. Les rappels sont
sauvegardés sur disque : si tu fermes Jaris avant l'échéance, le rappel se
déclenche dès que tu relances l'app (ou immédiatement s'il est en retard).

> Comme pour les autres outils, un prompt système strict interdit au modèle
> de "raconter" une action sans avoir réellement appelé l'outil correspondant
> — sinon les modèles ont tendance à répondre comme si l'action avait eu
> lieu sans jamais l'exécuter. Le mode réflexion d'Ollama (`think`) aide
> aussi beaucoup à la fiabilité des appels d'outils.

## Vision d'écran (étape 6)

```
ollama pull qwen3-vl:8b
```

Jaris peut capturer l'écran et le décrire, ou répondre à une question dessus
("qu'est-ce qui est affiché ?", "y a-t-il un message d'erreur ?") — dis
simplement ce que tu veux savoir, il capture et regarde tout seul. Utilise
un modèle séparé du modèle de conversation (`OLLAMA_VISION_MODEL` dans
`.env`, `qwen3-vl:8b` par défaut).

## Recherche web (étape 7)

Nécessite [Docker Desktop](https://www.docker.com/products/docker-desktop/).
Lance l'instance [SearXNG](https://github.com/searxng/searxng) locale (aucun
compte, aucune clé) :

```
docker compose up -d
```

Ça démarre un moteur de recherche auto-hébergé sur `http://localhost:8080`.
La config nécessaire (API JSON activée) est déjà dans `searxng/settings.yml`,
suivi par Git — rien à configurer à la main. Jaris l'utilise automatiquement
dès que tu lui poses une question qui demande une info récente ou qu'il ne
connaît pas ("cherche sur le web...", ou même sans le dire explicitement).

Pour arrêter SearXNG : `docker compose down`.

Aucune clé API payante n'est nécessaire à aucune étape.
