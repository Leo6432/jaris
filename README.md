# Jaris

Assistant IA personnel vocal, inspiré de J.A.R.V.I.S. — **100% local, 0€/mois**.
Electron + React + TypeScript, aucun appel à une API payante : tout le pipeline
(voix → réflexion → réponse) tourne sur la machine.

## État actuel

- ✅ Étape 1 — Projet Electron + React + TS (Vite / electron-vite) initialisé
- ✅ Étape 2 — Visage animé (`JarisFace`) avec 5 états d'émotion : veille,
  écoute, réflexion, content, surpris
- ✅ Étape 3 — Pipeline vocal local : mot d'activation (openWakeWord),
  transcription (Cohere Transcribe), synthèse vocale (Piper). **Testé de bout
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
- ✅ Étape 8 — `docker compose up -d` lancé, recherche web (étape 7) testée
  et fonctionnelle
- ✅ Étape 9 — Mémoire locale façon Obsidian : Jaris enregistre ce qu'il
  retient (préférences, infos données en conversation, résumés) dans de
  simples fichiers markdown liés entre eux sur le disque, plutôt que dans une
  base opaque. Un bouton "Voir le cerveau de Jaris" dans l'interface ouvre ce
  dossier de mémoire pour le consulter/modifier à la main — voir plus bas
- ✅ Étape 10 — Graphe 3D du cerveau de Jaris : le bouton "Voir le cerveau de
  Jaris" (étape 9) affiche une vraie visualisation en 3D des notes markdown
  et de leurs liens sous forme de graphe interactif (rotation, zoom), comme
  la vue graphe d'Obsidian — voir plus bas
- ✅ Étape 11 — Envoi de mails : Jaris peut envoyer un vrai mail via un
  compte SMTP configuré dans `.env` — voir plus bas
- ⬜ Étape 12 — Sélection automatique de modèle selon la complexité de la
  question : un petit modèle rapide (ex: `phi-4-mini`) pour les questions
  simples/rapides, `qwen3.5` pour le reste, afin de gagner du temps et de la
  VRAM sur les échanges courants sans sacrifier la qualité sur les questions
  qui le méritent
- ⬜ Étape 13 — Surveillance des ressources du PC : Jaris prévient à voix
  haute quand la machine est surchargée (GPU, CPU, RAM trop élevés), pour
  éviter de lancer une tâche lourde ou d'insister sur une réponse lente sans
  prévenir
- ⬜ Étape 14 — Contrôle clavier et souris : Jaris peut écrire du texte et
  cliquer à la place de l'utilisateur, pour automatiser des actions
  complètes sur l'ordinateur (pas seulement ouvrir une application)
- ⬜ Étape 15 — Installeur en un clic : empaqueter toute la chaîne (app +
  Ollama + modèles) dans un seul installeur simple, avec tous les réglages
  techniques (modèle de transcription, etc.) déjà configurés par défaut à l'intérieur.
  Aucun fichier `.env` à ouvrir ni à modifier à la main, même pour un
  débutant complet — seuls les vrais réglages perso (connecter Gmail, choisir
  son prénom) resteront dans l'interface, jamais dans un fichier texte
- ⬜ Étape 16 — Amélioration du design de l'interface
- ⬜ Étape 17 — Animation pendant la capture/analyse d'écran, pour donner un
  retour visuel pendant que Jaris "regarde" (étape 6)
- ⬜ Étape 18 — Mode toujours visible : petite fenêtre Jaris affichée en
  permanence en bas à droite de l'écran (widget flottant), au lieu de
  n'apparaître que quand la fenêtre principale a le focus
- ⬜ Étape 19 — Mise à jour automatique de l'application dès qu'une nouvelle
  version est publiée
- ⬜ Étape 20 — Intégration téléphone : système pour connecter Jaris au
  téléphone de l'utilisateur (via son numéro ou une connexion directe au
  téléphone) afin d'envoyer des messages, voir les notifications, et plus
  largement tout voir/contrôler depuis le téléphone — en s'appuyant sur un
  projet open source existant faisant le pont PC/téléphone (ex: KDE Connect)
  plutôt que de tout réécrire
- ⬜ Étape 21 — Préparation à la vente (~5€) : licence, protection contre la
  copie/redistribution du logiciel. Nécessitera au préalable de vérifier la
  compatibilité des licences des briques open source utilisées (Ollama,
  modèles Qwen, openWakeWord, Cohere Transcribe, Piper, SearXNG) avec une
  distribution commerciale
- ⬜ Étape 22 — Site web avec tableau de bord personnel : chaque utilisateur
  peut noter son planning et sa to-do list sur le site, et Jaris peut y
  écrire des informations
- ⬜ Étape 23 — Jaris connaît la date et l'heure : briefing du matin
  (planning du jour, tâches à faire), et ajoute automatiquement une tâche à
  la to-do list du site dès que l'utilisateur en mentionne une à voix haute
- ✅ Étape 24 — Personnalisation, prénom de l'utilisateur : au tout premier
  lancement, Jaris demande comment l'appeler (une seule fois, sauvegardé
  localement) et s'adresse ensuite à l'utilisateur par son prénom en
  conversation — voir plus bas
- ⬜ Étape 25 — Paramètres avancés : page dédiée pour tout personnaliser
  (connecter son planning/calendrier, son Gmail, choisir la langue, etc.)
- ⬜ Étape 26 — Sous-agents : Jaris peut lancer plusieurs sous-agents (agents
  web, etc.) en parallèle pour des tâches complexes qui demandent plusieurs
  actions en même temps, au lieu de tout faire en une seule séquence
- ⬜ Étape 27 — Scan de capacité au premier lancement : Jaris analyse le PC
  (GPU, VRAM, RAM) pour vérifier qu'il peut faire tourner les modèles par
  défaut ; si la machine n'est pas assez puissante, il propose automatiquement
  des modèles plus légers. Dans le bouton options, une liste de modèles
  classés du plus puissant au plus léger, avec sélection automatique (ou
  manuelle) de 3 modèles selon le profil de la machine : un modèle qui
  réfléchit beaucoup pour les tâches complexes, un modèle médium, et un
  modèle "flash" rapide pour les questions simples
- ⬜ Étape 28 — Mentions légales / conditions d'utilisation à faire accepter
  avant la première utilisation, pour dégager la responsabilité en cas
  d'action problématique de l'IA
- ⬜ Étape 29 — Protection contre la redistribution : identifiant unique par
  utilisateur/licence pour pouvoir tracer une copie de Jaris qui circule ou
  est partagée à d'autres personnes (piste à creuser, pas encore figée)
- ⬜ Étape 30 — Publication et monétisation : site pour vendre un abonnement
  (~10€/mois)
- ⬜ Étape 31 — Vidéo de présentation : animation en full motion design
  générée avec l'IA pour présenter le projet Jaris, avec sound effects et
  musique
- ⬜ Étape 32 — Levée de fonds : page sur le site pour présenter le projet à
  des investisseurs et demander des fonds pour agrandir le site

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

Tout se télécharge directement, sauf la reconnaissance vocale qui demande un
compte Hugging Face gratuit (voir plus bas) — c'est la seule exception au
"zéro compte" du reste de Jaris.

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

Si tu as une carte graphique NVIDIA et veux utiliser `STT_DEVICE=cuda` : `pip install
torch` (ci-dessus) installe par défaut une version **CPU uniquement** de
PyTorch sur Windows. Réinstalle-le depuis l'index CUDA officiel (regarde la
ligne `CUDA Version` dans `nvidia-smi` pour choisir `cu121`/`cu124`/`cu126`
selon ton driver) :

```bash
pip uninstall -y torch
pip install torch --index-url https://download.pytorch.org/whl/cu124
```

La reconnaissance vocale ([Cohere Transcribe](https://huggingface.co/CohereLabs/cohere-transcribe-03-2026),
open source, #1 du classement Open ASR Leaderboard) est un modèle "gated" :
1. Crée un compte gratuit sur [huggingface.co](https://huggingface.co)
2. Accepte les conditions sur la page du modèle
3. Dans le venv Python : `hf auth login` (colle un token créé sur
   [huggingface.co/settings/tokens](https://huggingface.co/settings/tokens))

Renseigne dans `.env` :
- `PYTHON_BIN` → chemin vers `python/venv/Scripts/python.exe`
- `STT_DEVICE=cuda` sur la RTX 3070, sinon `cpu`
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
> `WAKEWORD_INPUT_DEVICE` ; et un modèle de transcription peut halluciner du
> texte plausible sur du silence (le pipeline filtre déjà ça via la détection
> de silence avant capture, plus un filtre de secours sur des formules types).
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

## Mémoire locale façon Obsidian (étape 9)

Jaris peut retenir des informations d'une conversation à l'autre (préférences,
faits donnés par l'utilisateur, résumés à garder) dans de simples fichiers
markdown, un par note, stockés en clair sur le disque (dossier `memory` des
données de l'app) — pas de base de données opaque. Les notes peuvent se lier
entre elles avec la syntaxe `[[Titre de l'autre note]]`, comme dans Obsidian.

Jaris décide lui-même quand mémoriser une information importante (outil
`remember`) et quand aller relire une note existante avant de répondre avec
précision (outil `recall_memory`) — la liste des notes déjà connues lui est
toujours donnée en contexte.

## Graphe 3D du cerveau de Jaris (étape 10)

Le bouton "Voir le cerveau de Jaris" dans l'interface ouvre une vraie
visualisation en 3D (via [`3d-force-graph`](https://github.com/vasturiano/3d-force-graph),
rendu Three.js) des notes markdown de la mémoire (étape 9) et de leurs liens
`[[...]]`, interactive (rotation, zoom, survol) — comme la vue graphe
d'Obsidian. Un bouton "Ouvrir le dossier" dans cette vue permet d'accéder
directement aux fichiers `.md` dans l'explorateur pour les consulter ou les
modifier à la main.

## Envoi de mails (étape 11)

Jaris peut envoyer un vrai mail, de deux façons possibles (la première a
priorité si les deux sont configurées) :

### Option recommandée : connecter Gmail depuis l'appli

Bouton **"Options"** en haut à gauche de la fenêtre → **"Connecter Gmail"**.
Le navigateur système s'ouvre sur l'écran de connexion Google, tu acceptes
la permission "envoyer des mails en ton nom", et c'est tout — aucun mot de
passe à taper dans Jaris. Le jeton est stocké chiffré sur ta machine (via
le trousseau du système, `safeStorage` d'Electron), jamais en clair. Le
même bouton Options permet de déconnecter le compte et de s'en reconnecter
à tout moment.

Ça nécessite de créer un identifiant OAuth "Application de bureau" sur
Google Cloud Console (gratuit, une seule fois) :

1. Va sur [console.cloud.google.com](https://console.cloud.google.com/),
   crée un projet (ou réutilise un projet existant)
2. **APIs et services → Bibliothèque** → active l'API **Gmail API**
3. **APIs et services → Écran de consentement OAuth** → type "Externe",
   remplis le nom de l'app, ton mail ; en mode "Test", ajoute ton propre
   compte Gmail comme utilisateur de test (pas besoin de validation Google
   pour un usage personnel)
4. **APIs et services → Identifiants → Créer des identifiants → ID client
   OAuth**, type **"Application de bureau"**
5. Copie le "ID client" et le "Code secret du client" générés dans `.env` :

```
GOOGLE_CLIENT_ID=xxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxxx
```

### Option de secours : SMTP classique

Si aucun compte Gmail n'est connecté, Jaris utilise la configuration SMTP
de secours dans `.env` :

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=toncompte@gmail.com
SMTP_PASS=un-mot-de-passe-d-application
SMTP_FROM=
```

Pour Gmail par ce biais, utilise un [mot de passe d'application](https://myaccount.google.com/apppasswords)
(pas ton mot de passe normal, qui ne fonctionnera pas).

Si ni l'un ni l'autre n'est configuré, Jaris te préviendra à voix haute
qu'il ne peut pas envoyer le mail au lieu d'échouer silencieusement.
