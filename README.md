# Jaris

Assistant IA personnel vocal, inspiré de J.A.R.V.I.S. — **100% local, 0€/mois**.
Electron + React + TypeScript, aucun appel à une API payante : tout le pipeline
(voix → réflexion → réponse) tourne sur la machine.

## État actuel

- ⬜ Étape 21 — Intégration téléphone : système pour connecter Jaris au
  téléphone de l'utilisateur (via son numéro ou une connexion directe au
  téléphone) afin d'envoyer des messages, voir les notifications, et plus
  largement tout voir/contrôler depuis le téléphone — en s'appuyant sur un
  projet existant faisant le pont PC/téléphone plutôt que de tout réécrire :
  soit open source (ex: KDE Connect), soit la fonctionnalité native de
  Windows **Mobile connecté** (Phone Link) déjà présente sur la machine de
  l'utilisateur — à comparer avant de choisir (couverture fonctionnelle,
  et surtout si Phone Link expose de quoi être piloté par Jaris plutôt que
  seulement utilisable à la main)
- ⬜ Étape 42 — Canal Telegram : pouvoir parler à Jaris à distance par
  message Telegram, en plus de la voix et du chat (étape 30) déjà présents.
  Nouveau canal branché directement sur le moteur `converse()` existant
  (`electron/services/assistant.ts`) plutôt qu'un bot séparé et
  déconnecté : mêmes outils (mail, recherche web, rappels, mémoire — voir
  `tools.ts`), même historique, même mémoire longue durée qu'en local. Bot
  Telegram en mode "polling" (ex: `node-telegram-bot-api`) : aucun serveur
  public ni IP fixe nécessaire, reste 100% local et gratuit. Limite propre
  au 100% local : le PC de l'utilisateur doit être allumé et Jaris lancé
  pour recevoir un message — rien n'est hébergé ailleurs, un message envoyé
  pendant que la machine est éteinte reste juste en attente chez Telegram
  jusqu'au redémarrage
- ⬜ Étape 23 — Site web avec tableau de bord personnel : chaque utilisateur
  peut noter son planning et sa to-do list sur le site, et Jaris peut y
  écrire des informations
- ⬜ Étape 24 — Jaris connaît la date et l'heure : briefing du matin
  (planning du jour, tâches à faire), et ajoute automatiquement une tâche à
  la to-do list du site dès que l'utilisateur en mentionne une à voix haute
- ⬜ Étape 26 — Paramètres avancés : page dédiée pour tout personnaliser
  (connecter son planning/calendrier, son Gmail, choisir la langue, etc.)
- ⬜ Étape 27 — Sous-agents : Jaris peut lancer plusieurs sous-agents (agents
  web, etc.) en parallèle pour des tâches complexes qui demandent plusieurs
  actions en même temps, au lieu de tout faire en une seule séquence
- ⬜ Étape 31 — Design sonore : donne à Jaris sa propre identité sonore, avec
  des sons distincts selon l'action en cours (clic de souris, envoi d'un
  message/mail, réflexion, scan d'écran...), en plus de la voix — comme les
  bips caractéristiques de J.A.R.V.I.S. (Iron Man)
- ⬜ Étape 32 — Clics plus fiables via UI Automation (Windows) : au lieu de
  deviner des coordonnées à partir d'une capture d'écran (vision), utiliser
  l'API d'accessibilité Windows (`UIAutomationClient`/`UIAutomationTypes`,
  accessible depuis PowerShell comme le reste du contrôle clavier/souris —
  étape 15) pour repérer les vrais éléments cliquables d'une fenêtre (nom,
  type, position exacte via `ClickablePointProperty`) et cliquer dessus avec
  certitude, même si l'interface bouge — reste 100% local et gratuit.
  Limite : certaines interfaces personnalisées (jeux, rendu custom) n'exposent
  pas toujours un arbre d'accessibilité complet, garder look_at_screen
  (étape 6) en repli dans ce cas
- ⬜ Étape 33 — Firecrawl pour un scraping web plus fiable : en complément de
  la recherche web (étape 7, basée sur SearXNG en local), auto-héberger
  Firecrawl (open source, licence AGPL-3.0, conteneur Docker comme SearXNG —
  étapes 7/8) pour extraire le contenu des pages en markdown propre, avec
  rendu JS des sites dynamiques — reste 100% local et gratuit. Limite : la
  version auto-hébergée n'a pas le contournement anti-bot/rotation de proxy
  de la version cloud payante, suffisant pour un usage perso normal
- ⬜ Étape 43 — Agent de contrôle d'ordinateur complet (comparé à GPT-6 Astra
  d'OpenAI, sorti le 3 septembre 2026 avec le "computer use" comme capacité
  phare — mais dans le cloud, payant, contrairement à Jaris) : au-delà de ce
  que les étapes 32/34 couvrent déjà (clics fiables, navigateur piloté), il
  manque encore :
  - **Fichiers** : créer, déplacer, renommer, organiser (rien aujourd'hui)
  - **Documents bureautiques** : lire/écrire dans Word/Excel/PowerPoint ou
    équivalents (rien aujourd'hui)
  - **Vraie boucle de programmation** : ouvrir un projet EXISTANT (pas
    seulement générer une appli depuis zéro comme le mode Code actuel),
    éditer un fichier précis, lancer une commande shell, lire le résultat,
    corriger, retester — un outil d'exécution shell/édition de fichier
    n'existe pas encore
  - **Raccourcis clavier avec modificateurs** (Ctrl+C, Alt+Tab...) et
    **glisser-déposer** : `press_key`/`click_mouse` (étape 15) ne couvrent
    qu'une touche seule ou un clic simple
  - **Plafond d'actions** : `MAX_TOOL_ROUNDS = 10` (`assistant.ts`) limite
    une tâche à 10 appels d'outils par échange — bloquerait une vraie tâche
    à plusieurs dizaines d'étapes, à lever (ou remplacer par une vraie
    limite de temps/budget) une fois les outils au-dessus ajoutés

  Plus d'outils capables d'agir sur de vrais fichiers/documents/commandes
  shell veut dire plus de risque, pas seulement plus de capacités — à garder
  en tête même sans confirmation systématique par outil (retirée, voir
  étape 31)
- ⬜ Étape 41 — Génération d'images et de vidéos avec
  [Wan2GP](https://github.com/deepbeepmeep/Wan2GP) : équivalent local et
  open source d'Higgsfield, taillé pour les GPU grand public ("GPU Poor") —
  certains modèles (Wan 2.2 TI2V-5B, Wan 2.2 14B en GGUF...) tournent dès 6
  Go de VRAM. Demander une image ou une courte vidéo à voix haute ou dans le
  chat (étape 30) télécharge et lance Wan2GP en local, comme Ollama et
  SearXNG aujourd'hui. Points à vérifier avant de s'y mettre : licence
  personnalisée de Wan2GP (gratuit à l'usage d'après le dépôt, mais à
  confirmer pour une redistribution commerciale — même vérification que
  l'étape 22 pour les autres briques open source utilisées), et cohabitation
  en VRAM avec le modèle de conversation déjà chargé (probablement décharger
  temporairement l'un pour l'autre, comme pour la vision — étape 6)

  ### Repère qualité : MiniMax H3 (Max / Live)
  Modèle cloud payant (dispo via Higgsfield) pris comme repère de qualité
  pour cette étape : mode **Max** pour la meilleure qualité, mode **Live**
  pour une génération quasi temps réel. Pas une dépendance de Jaris (qui
  reste 100% local et gratuit) — juste l'objectif visé localement avec
  Wan2GP, à rapprocher autant que possible.
- ⬜ Étape 35 — Optimisation complète de l'application : passe à fond sur les
  performances avant de passer aux étapes de mise sur le marché ci-dessous —
  réduire au maximum la consommation CPU/GPU/RAM au repos et en usage
  (démarrage, appels redondants comme `nvidia-smi` relancé plusieurs fois par
  question, animations qui tournent même fenêtre cachée), accélérer les
  temps de réponse (chargement des modèles, transcription, synthèse vocale),
  réduire la taille de l'appli packagée, et nettoyer le code mort et les
  dépendances inutilisées
- ⬜ Étape 22 — Vérification des licences avant mise en vente : vérifier la
  compatibilité des licences des briques open source utilisées (Ollama,
  modèles Qwen, Cohere Transcribe, Supertonic HD, SearXNG) avec
  une distribution commerciale, avant de passer aux étapes de mise sur le
  marché ci-dessous (mentions légales, protection contre la redistribution,
  publication et monétisation)
- ⬜ Étape 36 — Mentions légales / conditions d'utilisation à faire accepter
  avant la première utilisation, pour dégager la responsabilité en cas
  d'action problématique de l'IA
- ⬜ Étape 37 — Protection contre la redistribution : identifiant unique par
  utilisateur/licence pour pouvoir tracer une copie de Jaris qui circule ou
  est partagée à d'autres personnes (piste à creuser, pas encore figée)
- ⬜ Étape 38 — Publication et monétisation : site pour vendre un abonnement
  (~10€/mois)
- ⬜ Étape 39 — Vidéo de présentation : animation en full motion design
  générée avec l'IA pour présenter le projet Jaris, avec sound effects et
  musique
- ⬜ Étape 40 — Levée de fonds : page sur le site pour présenter le projet à
  des investisseurs et demander des fonds pour agrandir le site
- ✅ Étape 1 — Projet Electron + React + TS (Vite / electron-vite) initialisé
- ✅ Étape 2 — Visage animé (`JarisFace`, remplacé à l'étape 17 par
  `JarisOrb`) avec 5 états d'émotion : veille, écoute, réflexion, content,
  surpris
- ✅ Étape 3 — Pipeline vocal local : déclenchement par double clap,
  transcription (Cohere Transcribe), synthèse vocale (Supertonic HD). **Testé
  de bout en bout avec un vrai micro** (voir plus bas)
- ✅ Étape 4 — Connexion Ollama : Jaris comprend vraiment ce que tu dis et
  répond avec un LLM local (`qwen3.5:9b` par défaut, configurable)
- ✅ Étape 5 — Tool calling : Jaris peut ouvrir des applications et
  programmer des rappels vocaux (persistés, survivent à un redémarrage de
  Jaris avant l'échéance) — voir plus bas
- ✅ Étape 6 — Vision d'écran : Jaris peut capturer l'écran et le décrire ou
  répondre à une question dessus, via un modèle de vision local (`qwen3-vl`,
  taille choisie selon la VRAM comme les modèles de conversation — étape 13,
  séparé du modèle de conversation) — voir plus bas
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
  compte Gmail connecté depuis l'appli (OAuth) — voir plus bas
- ✅ Étape 12 — Meilleure voix : Piper remplacé par
  [Supertonic HD](https://huggingface.co/Supertone/supertonic-3) (voix plus
  naturelle, 99M paramètres, licence OpenRAIL-M compatible avec une
  distribution commerciale future) — voir plus bas
- ✅ Étape 13 — Sélection automatique de modèle selon la complexité de la
  question : au premier lancement, Jaris scanne la VRAM disponible (en
  réservant de la place pour le STT en permanence chargé) et choisit 3
  modèles Ollama adaptés à la machine (rapide/médium/puissant, jamais plus
  gros que ce qu'elle supporte), puis route chaque question vers le palier
  le plus adapté — voir plus bas
- ✅ Étape 14 — Surveillance des ressources du PC : Jaris prévient à voix
  haute quand la machine est surchargée (GPU, CPU, RAM trop élevés), pour
  éviter de lancer une tâche lourde ou d'insister sur une réponse lente sans
  prévenir — voir plus bas
- ✅ Étape 15 — Contrôle clavier et souris : Jaris peut écrire du texte et
  cliquer à la place de l'utilisateur, pour automatiser des actions
  complètes sur l'ordinateur (pas seulement ouvrir une application) — voir
  plus bas
- ✅ Étape 17 — Amélioration du design de l'interface : le visage animé
  (`JarisFace`) est remplacé par `JarisOrb`, un noyau holographique façon
  J.A.R.V.I.S. (Iron Man) — voir plus bas
- ✅ Étape 18 — Animation pendant la capture/analyse d'écran, pour donner un
  retour visuel pendant que Jaris "regarde" (étape 6) — voir plus bas
- ✅ Étape 19 — Mode toujours visible : petite fenêtre Jaris affichée en
  permanence en bas à droite de l'écran (widget flottant), au lieu de
  n'apparaître que quand la fenêtre principale a le focus — voir plus bas
- ✅ Étape 25 — Personnalisation, prénom de l'utilisateur : au tout premier
  lancement, Jaris demande comment l'appeler (une seule fois, sauvegardé
  localement) et s'adresse ensuite à l'utilisateur par son prénom en
  conversation — voir plus bas
- ✅ Étape 28 — Onglet "Modèles" dans le menu Options : affiche les 3 paliers
  rapide/médium/puissant choisis par le scan de capacité (étape 13), avec un
  bouton pour relancer l'analyse à tout moment (pas seulement au premier
  lancement) — voir plus bas
- ✅ Étape 29 — Veille des nouveaux modèles : à chaque scan de capacité
  (étape 13/28), Jaris retient un instantané de tous les modèles candidats
  qu'il connaît (hardwareScan.ts). Si une nouvelle version de Jaris ajoute
  des modèles à cette liste (ex: MiniCPM5-1B, G9v3-3B et GLM-4.6V-Flash,
  ajoutés le 26 août 2026) depuis le dernier scan, un popup en prévient
  l'utilisateur au lancement suivant, avec le nom des nouveautés, plutôt que
  d'attendre qu'il pense à relancer l'analyse lui-même — pas de re-benchmark
  automatique en tâche de fond (trop lourd, 20-40+ min), c'est toujours
  l'utilisateur qui déclenche via le bouton existant
- ✅ Étape 30 — Colonne latérale permanente avec 3 modes : **Agent vocal**
  (l'expérience d'origine), **Chat** (le même Jaris par écrit) et **Code**
  (générateur d'applications 100% local façon Lovable/Emergent) — voir plus
  bas. Une première version de Code avait été retirée (qualité insuffisante
  sur un modèle généraliste de la taille qui tient sur 8 Go de VRAM) puis
  reprise avec deux modèles réellement spécialisés en code (voir plus bas)
- ✅ Étape 34 — Playwright pour piloter un vrai navigateur (voir plus bas)
- ✅ Étape 20 — Mise à jour automatique de l'application (voir plus bas)
- ✅ Étape 16 — Installeur en un clic (voir plus bas) : **règle absolue — le Jaris installé par
  le public doit être exactement le même que celui utilisé en développement**
  (mêmes modèles, mêmes fonctionnalités, même qualité de réponse), jamais une
  version allégée ou dégradée, et ça doit rester 0€ pour toujours (aucun
  abonnement, aucune API payante, tout tourne en local sur la machine de
  l'utilisateur, exactement comme aujourd'hui en dev). **Un seul fichier
  `.exe` téléchargé et double-cliqué, comme n'importe quel vrai logiciel
  Windows** — aucune commande à taper, aucun terminal à ouvrir. En
  particulier, rien de ce qui est aujourd'hui manuel pour un développeur ne
  doit rester manuel pour le public :
  - `npm install`/`npm run build` (l'app Electron elle-même)
  - `python -m venv` + `pip install -r python/requirements.txt` (Python,
    torch, transformers... — plusieurs Go à eux seuls) : soit le Python et
    ses dépendances sont embarqués tout faits dans l'installeur, soit
    l'installeur les installe lui-même en silence pendant l'installation,
    jamais une commande que l'utilisateur doit lancer lui-même
  - `ollama pull <modèle>` et les modèles de conversation/vision/code
  - le modèle de transcription Cohere Transcribe (déjà téléchargé et
    embarqué — licence Apache 2.0, donc redistribution autorisée) et le
    modèle de synthèse vocale Supertonic HD

  Tous les réglages techniques déjà configurés par défaut à l'intérieur.
  Aucun fichier `.env` à ouvrir ni à modifier à la main, aucun compte
  Hugging Face à créer, même pour un débutant complet — seuls les vrais
  réglages perso (connecter Gmail, choisir son prénom) resteront dans
  l'interface, jamais dans un fichier texte ni sur un site tiers
- ✅ Étape 44 — Choisir l'emplacement disque des modèles (voir plus bas)

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

Tout se télécharge directement : aucun compte à créer nulle part, y compris
pour la reconnaissance vocale (voir plus bas).

> Cette section décrit l'installation **manuelle, pour le développement**.
> L'application installée, elle, fait tout ça toute seule au premier
> lancement — voir "Installeur en un clic (étape 16)" plus bas.

> **Déclenchement : double clap, pas de mot à dire.**
> Jaris n'a plus de mot d'activation parlé (openWakeWord, qui obligeait à
> dire "Hey Jarvis" en anglais faute de mot-clé "Jaris" pré-entraîné, a été
> retiré). Deux claps francs et rapprochés suffisent — voir plus bas —, en
> plus du raccourci clavier **+** pour un déclenchement manuel.

### 1. Environnement Python (déclenchement par clap + reconnaissance vocale)

Un seul process Python à côté d'Electron gère le micro, la détection du
double clap et la transcription.

```bash
python -m venv python/venv
python/venv/Scripts/activate   # (Windows) — python/venv/bin/activate sur Mac/Linux
pip install -r python/requirements.txt
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

La reconnaissance vocale utilise [Cohere Transcribe](https://huggingface.co/CohereLabs/cohere-transcribe-03-2026)
(open source, #1 du classement Open ASR Leaderboard). Le dépôt officiel est
"gated" (compte Hugging Face + acceptation de conditions en ligne), ce que
l'étape 16 interdit explicitement pour le public. Jaris télécharge donc une
**copie non protégée** du même modèle, à la version exacte épinglée
(`DEFAULT_STT_MODEL`/`DEFAULT_STT_REVISION` dans `python/voice_server.py`) :

- ce ne sont pas d'autres poids ni une version allégée — le fichier
  `model.safetensors` a exactement la même empreinte SHA256 que l'officiel
  (`987bd3e1…`, 4 131 862 976 octets), vérifié via l'API Hugging Face ;
- la licence Apache 2.0 du modèle autorise explicitement cette
  redistribution ;
- la version est épinglée par identifiant de commit, immuable : le dépôt
  tiers ne peut pas remplacer les poids sous nos pieds.

> À faire avant la mise en vente (étapes 22/38) : héberger cette copie
> nous-mêmes plutôt que dépendre d'un dépôt tiers qui pourrait être supprimé.
> La licence le permet ; seule la disponibilité est en jeu, pas le contenu.

Renseigne dans `.env` :
- `PYTHON_BIN` → chemin vers `python/venv/Scripts/python.exe`
- `STT_DEVICE` peut rester vide : le GPU est détecté automatiquement au
  chargement (`torch.cuda.is_available()`), avec repli sur le processeur.
  Ne le renseigne que pour forcer `cuda` ou `cpu`.

**Déclenchement par double clap.** Toujours DEUX claps francs et rapprochés,
jamais un seul : un objet qui tombe ou une porte qui claque ne doit pas
déclencher Jaris par accident (même logique qu'un interrupteur "clap
on/clap off").

Un simple seuil de volume FIXE s'est révélé ingérable en usage réel : trop
bas, de la voix parlée normale le dépassait ; trop haut, de vrais claps ne
le dépassaient plus (1 détection sur 10 claps constatée) — le même geste de
clap donne un RMS très différent selon la distance au micro, le gain
matériel, le bruit ambiant de la pièce. Deux vraies techniques de détection
de clap/onset percussif remplacent le seuil fixe (sources : [Arduino Clap
Detector](https://docs.arduino.cc/tutorials/generic/clap-detector/),
littérature sur le
[spectral flux](https://en.wikipedia.org/wiki/Spectral_flux) et le
"high-frequency content" pour la détection d'onsets percussifs) :
1. **Niveau ambiant adaptatif** (`noise_floor`, moyenne mobile) — un clap
   doit dépasser le bruit de fond RÉEL de la pièce d'un facteur donné
   (`CLAP_RATIO_ABOVE_FLOOR`), pas un chiffre absolu deviné à l'avance :
   s'auto-calibre tout seul à l'environnement de chaque utilisateur.
2. **Contenu haute fréquence** (FFT, `high_frequency_ratio`) — ce qui
   distingue vraiment un clap (transitoire, large bande) d'une voyelle
   parlée forte (concentrée en basses fréquences/formants) : une voix qui
   parle fort peut dépasser le niveau ambiant mais n'a presque jamais assez
   d'énergie haute fréquence pour passer ce filtre (`CLAP_HF_RATIO_MIN`).

Réglages dans `python/voice_server.py` (`NOISE_FLOOR_EMA_ALPHA`,
`CLAP_RATIO_ABOVE_FLOOR`, `CLAP_ABS_RMS_FLOOR`, `CLAP_HF_CUTOFF_HZ`,
`CLAP_HF_RATIO_MIN`, `CLAP_MIN_INTERVAL_MS`, `CLAP_MAX_INTERVAL_MS`), à
ajuster si besoin après un vrai test — chaque pic candidat retenu (avant
même de vérifier si c'est un vrai double clap) est loggué avec son RMS
exact et le seuil du moment (`{"event": "log", "message": "Pic candidat :
..."}`, visible dans la fenêtre Jaris), pour ajuster les seuils à partir de
vraies mesures plutôt qu'à l'aveugle. Le raccourci clavier **+** (dans la
fenêtre Jaris) reste disponible pour déclencher l'écoute manuellement, sans
clap.

### 2. Synthèse vocale (Supertonic HD)

Rien à installer à la main : `supertonic` est dans `python/requirements.txt`
(déjà installé à l'étape 1), et le modèle (~100 Mo, léger) se télécharge tout
seul au premier lancement de Jaris, comme Cohere Transcribe. `TTS_VOICE`
dans `.env` fixe la voix par défaut (`M3` de base) ; 10 voix sont dispo au
total (`M1`-`M5`, `F1`-`F5`) et peuvent être écoutées et choisies directement
depuis le menu **Options** de l'appli (clic sur une voix = phrase d'exemple
jouée + voix retenue pour les prochaines réponses), sans toucher au `.env`.

### Vérifier

`npm run dev` : tape deux fois dans les mains près du micro, Jaris doit
s'illuminer, transcrire ce que tu dis ensuite, puis le redire à voix haute
pour confirmer qu'il a compris — c'est la preuve que toute la chaîne audio
fonctionne, avant de brancher un vrai raisonnement à l'étape 4.

> Pipeline testé de bout en bout avec un vrai micro sur une machine Windows
> (RTX 3070) : déclenchement, capture, transcription et synthèse vocale
> fonctionnent tous en conditions réelles.
>
> Pièges rencontrés en conditions réelles, déjà corrigés dans le code : le
> périphérique micro par défaut du système n'est pas forcément le bon (ex: un
> micro virtuel type Voice Changer/Voicemod) — se règle directement depuis
> l'onglet **Micro & Haut-parleur** du menu Options (menu déroulant "Micro
> utilisé", plus besoin de passer par `MIC_INPUT_DEVICE`/
> `python -m sounddevice` à la main) ; un modèle de transcription peut
> halluciner du texte plausible sur du silence (le pipeline filtre déjà ça
> via la détection de silence avant capture, plus un filtre de secours sur
> des formules types) ; et certains micros (USB, Bluetooth...) refusent
> d'être ouverts directement en 16 kHz (`Invalid sample rate`,
> `PaErrorCode -9997`) — le sidecar retombe automatiquement sur le débit
> natif du périphérique et ré-échantillonne en 16 kHz à la volée (voir
> `make_audio_callback` dans `python/voice_server.py`), sans rien à faire
> côté utilisateur.
>
> Le même onglet **Micro & Haut-parleur** permet aussi de choisir le
> haut-parleur utilisé pour les réponses de Jaris, et de lancer un **test
> micro** (bouton "Tester le micro") : une rangée de barres qui réagit en
> direct pendant qu'on parle, façon Discord. Pas de durée fixe — le bouton
> devient "Arrêter le test" pour désactiver quand on veut, plutôt qu'un
> compte à rebours imposé. Changer de micro redémarre le pipeline vocal
> (rechargement du modèle de transcription, quelques secondes) ; changer de
> haut-parleur est instantané, appliqué à la prochaine réponse.
>
> Un raccourci clavier **+** (dans la fenêtre Jaris) déclenche aussi l'écoute
> manuellement, sans clap — pratique pour tester ou en environnement bruyant.

## Mettre en place Ollama (étape 4)

1. Installe [Ollama](https://ollama.com/) (installeur Windows classique) —
   **version 0.7.0 ou plus récente** : en dessous, un bug côté Ollama
   ([ollama/ollama#8668](https://github.com/ollama/ollama/pull/8668), corrigé
   dans la 0.7.0) fait apparaître de brèves fenêtres de console Windows vides
   à chaque chargement/changement de modèle. Rien à faire côté Jaris pour
   ça — c'est entièrement dans le binaire Ollama — mais Jaris le détecte et
   le dit dans les logs si une version trop ancienne tourne
2. Télécharge le modèle de raisonnement :
   ```
   ollama pull qwen3.5:9b
   ```
3. Vérifie dans `.env` que `OLLAMA_HOST` (`http://127.0.0.1:11434` par
   défaut) et `OLLAMA_MODEL` (`qwen3.5:9b` par défaut) sont corrects — le nom
   du modèle est entièrement configurable, pas besoin de toucher au code pour
   en changer

Ollama doit être lancé pour que Jaris puisse réfléchir. Jaris essaie de le
démarrer automatiquement (`ollama serve`) s'il ne répond pas au lancement de
l'appli — inutile de le lancer à la main dans la plupart des cas. Si le
démarrage automatique échoue (Ollama pas installé, par exemple), Jaris le dit
à voix haute au lieu de planter.

**Avertissement si Ollama n'est pas à jour.** En plus du check ciblé sur la
0.7.0 ci-dessus, Jaris compare au lancement la version locale d'Ollama à la
vraie dernière version publiée (`getOllamaVersionStatus`,
`electron/services/dependencyServices.ts`, via l'API GitHub d'Ollama) —
jamais un plancher fixe à remonter à la main à chaque nouvelle exigence,
toujours la dernière en date. Utile car certains modèles récents refusent
carrément de se télécharger sur une version trop ancienne (`pull model
manifest: 412`, ex: `qwen3.8:27b`) : sans avertissement, Jaris n'aurait dit
que "modèle ignoré", sans expliquer pourquoi ni quoi faire. Si une mise à
jour existe, un bandeau s'affiche dans l'onglet **Modèles** du menu Options
(étape 28) avec un lien direct vers ollama.com/download — jamais bloquant
(purement informatif, en best-effort : pas de connexion, GitHub
injoignable ou limite de requêtes atteinte n'empêchent jamais Jaris de
démarrer, le bandeau reste juste absent).

Un popup miroir (`App.tsx`, même style que celui des nouveaux modèles
candidats, étape 29) apparaît en plus dans les 3 modes de la fenêtre de
réglages (Agent vocal/Chat/Code) — pas seulement en ouvrant l'onglet
Modèles comme avant — pour ne pas rater l'avertissement pendant des jours
si cet onglet précis n'est jamais ouvert. "Fermer" ne le cache que pour la
session en cours (jamais définitivement) : le bandeau détaillé + le bouton
"Mettre à jour" restent toujours consultables dans Options → Modèles.

Le bandeau propose aussi un bouton **"Mettre à jour"** (`updateOllama`,
`electron/services/dependencyServices.ts`), en trois temps :
1. **Redémarrer `ollama app.exe`** (l'appli barre système Windows, pas le
   CLI) : Ollama télécharge déjà ses mises à jour tout seul en arrière-plan
   par défaut ("Auto-download updates") — aucune invite Windows, aucun
   catalogue externe. Jaris fait juste `taskkill /IM "ollama app.exe" /F`
   puis relance l'exécutable, revérifie la version une fois le serveur
   revenu. **Ne suffit pas toujours** (constaté en usage réel) : le "Restart
   to update" de la vraie icône barre système d'Ollama relance en fait tout
   un installeur téléchargé à part, pas juste le même binaire déjà installé
   — un simple redémarrage peut donc ne rien changer.
2. **Télécharger et lancer le vrai installeur officiel** en repli
   (`https://ollama.com/download/OllamaSetup.exe`, la même adresse que le
   lien manuel juste à côté) si le redémarrage seul n'a rien changé :
   garanti de fonctionner puisque c'est l'installeur officiel, contrairement
   à essayer de deviner où Ollama cache le sien. Aucun flag silencieux
   documenté pour `OllamaSetup.exe` (pas question d'en inventer un) : la
   fenêtre de l'installeur s'ouvre normalement, il faut cliquer
   "Suivant"/"Installer" soi-même — Jaris a juste fait le travail de
   téléchargement à la place de l'utilisateur.
3. **`winget upgrade --id Ollama.Ollama`** en tout dernier repli, seulement
   si même le téléchargement de l'installeur a échoué (pas de réseau vers
   ollama.com, par exemple) — `winget` (App Installer, préinstallé sur
   Windows 10 1809+/11), paquet `Ollama.Ollama` officiellement maintenu sur
   [winget-pkgs](https://github.com/microsoft/winget-pkgs). Une invite
   Windows (élévation UAC) reste possible ici — ni winget ni Jaris ne
   peuvent la contourner. Piège rencontré en usage réel : winget peut
   répondre `APPINSTALLER_CLI_ERROR_UPDATE_NOT_APPLICABLE` (code
   `2316632107`, "aucune mise à jour applicable") alors qu'une version plus
   récente existe bien sur GitHub — le catalogue `winget-pkgs`, maintenu par
   des contributeurs externes (pas Ollama), peut mettre plusieurs jours à
   suivre une nouvelle sortie ; Jaris détecte spécifiquement ce code et
   l'explique clairement plutôt que d'afficher un échec générique. Si aucune
   des trois méthodes n'aboutit, le bouton le dit clairement et renvoie vers
   le téléchargement manuel sur ollama.com/download.

> Le modèle a par défaut une fenêtre de contexte énorme (131072 tokens pour
> qwen3.5), ce qui peut le faire déborder de la VRAM et tourner en partie sur
> le CPU (très lent). `OLLAMA_NUM_CTX` dans `.env` (4096 par défaut) évite ça
> — vérifie avec `ollama ps` que la colonne PROCESSOR affiche bien ~100% GPU.

**Mémoire courte de la conversation.** Chaque question envoyée à Ollama
inclut maintenant les derniers échanges (question/réponse), pas seulement
la dernière phrase toute seule — sinon une précision ou une correction
("répète juste l'adresse mail") arrivait à Jaris sans aucun contexte, sans
lien avec la demande en cours (ex: envoyer un mail), et il répondait
n'importe quoi. La fenêtre est glissante (les 12 derniers messages, soit
~6 échanges) : le contexte ancien sort tout seul au fil de la conversation,
pas de vrai "reset" à gérer.

Elle survit aussi à un redémarrage de Jaris (ou à une pause d'un jour à
l'autre) : au lancement, les derniers échanges sont rechargés depuis
`conversation-history.json` (un journal local de tous les échanges,
question/réponse/horodatage, dans le dossier de données de l'app — plafonné
à 300 entrées pour ne jamais grossir indéfiniment ni ralentir au fil du
temps), donc revenir le lendemain sur le même sujet continue la
conversation au lieu de repartir de zéro. Ça reste une fenêtre glissante
bornée pour Ollama (~6 derniers échanges, pas tout l'historique) : pour
qu'un fait précis survive vraiment sur la durée, sans dépendre de cette
fenêtre, c'est le rôle de la mémoire longue durée façon Obsidian (étape 9,
plus bas) — qui elle aussi s'alimente maintenant automatiquement, voir
plus bas.

## Sélection automatique de modèle (étape 13)

Au tout premier lancement (juste après la connexion Gmail), Jaris détecte
la machine (VRAM, RAM) et télécharge directement les modèles déjà connus
pour cette configuration (`previewHardwareTiers`/`runQuickSetup`,
`electron/services/hardwareScan.ts`/`benchmarkRunner.ts`) — quelques
minutes tout au plus (juste les 4-5 modèles vraiment retenus, dont le
modèle Code rapide, jamais des dizaines de candidats concurrents).
L'écran affiche d'abord les 3 profils de machine possibles (Configuration
petite/moyenne/grande, moins de 6 Go / 6 à 12 Go / plus de 12 Go de VRAM)
avec les modèles que chacun obtiendrait, et repère clairement celui qui
correspond à cette machine, avant même de lancer le moindre téléchargement.

Ça n'a pas toujours été le cas : jusqu'ici, le premier lancement forçait
une analyse comparative complète (chaque candidat réellement téléchargé et
testé, potentiellement plusieurs dizaines de minutes) — remplacée par ce
chemin rapide maintenant que `scripts/verified-tool-scores.md` (voir plus
bas) couvre la quasi-totalité des configurations courantes : plus besoin
de comparer pour savoir qui gagne, juste télécharger le gagnant déjà
connu. L'ancienne analyse comparative complète (voir "Comparer des modèles
candidats sur ta machine" plus bas) reste disponible à la main depuis
Options → Modèles, pour qui veut vérifier/affiner au-delà de ce qui est
déjà vérifié — chaque modèle candidat qui tient sur la machine est alors
réellement testé, pas seulement choisi par taille, avec une barre de
progression et un tableau de suivi en direct de chaque candidat.

Une fois l'analyse terminée, Jaris a choisi 3 modèles Ollama adaptés à la
machine (typiquement, sur la config de développement testée) :
- **rapide** — questions courtes sans action à faire — `qwen3:1.7b` par
  défaut (repli `qwen3.5:0.8b`)
- **médium** — le défaut pour la plupart des échanges, et le seul palier
  utilisé pour tout appel d'outil (ouvrir une appli, rappel, recherche web,
  mémoire, mail) : c'est le seul dont la fiabilité d'appel d'outils est
  éprouvée, pas question de la sacrifier pour gagner un peu de vitesse —
  `gemma4:e4b` si la VRAM le permet, sinon replis en cascade jusqu'à
  `qwen3.5:0.8b` (voir `MEDIUM_CANDIDATES` dans `hardwareScan.ts`)
- **puissant** — questions qui demandent explicitement une réflexion
  poussée ("pourquoi", "explique", "compare"...) ou un message long —
  famille `qwen3.5` (de `9b` à `35b`)

Les modèles par défaut ne sont pas choisis uniquement sur la taille/VRAM :
`scripts/benchmark-models.mjs` (voir plus bas) permet de comparer plusieurs
modèles candidats sur le vrai matériel (vitesse, fiabilité d'appel d'outils,
respect de la consigne "pas de mise en forme" cruciale pour un assistant
vocal) avant de les retenir — `qwen3:1.7b` et `gemma4:e4b` ont remplacé les
choix initiaux (`qwen3.5:2b`/`9b`) suite à ces tests locaux.

Le calcul réserve ~4,5 Go de VRAM pour le STT (Cohere Transcribe, chargé en
permanence pendant toute la session) avant de choisir les modèles : le
palier "puissant" ne peut donc jamais dépasser ce que la carte supporte
réellement, même sur une machine avec beaucoup de VRAM totale mais peu de
marge une fois le STT pris en compte. Les modèles manquants sont
téléchargés automatiquement pendant l'écran de scan (`ollama pull`), donc
peut prendre plusieurs minutes selon la connexion.

### Comparer des modèles candidats sur ta machine

```
npm run benchmark:models
```

Compare plusieurs modèles Ollama (déjà téléchargés, `ollama pull <modèle>`
sinon) sur le matériel réel plutôt que sur des benchmarks publiés — souvent
absents pour les petits modèles, ou mesurés dans des conditions différentes
d'un modèle à l'autre. Utilise exactement les mêmes schémas d'outils que
Jaris (`electron/services/tools.ts`), sans jamais les exécuter pour de vrai
(aucune appli ne s'ouvre, aucun mail ne part) : le script vérifie juste que
le bon outil est appelé, avec des arguments plausibles, sur des questions
réalistes. Mesure aussi la latence, la vitesse (tokens/seconde) et si la
réponse respecte la consigne "pas de mise en forme" (essentielle puisque
tout est lu à voix haute). Résultat affiché dans le terminal et sauvegardé
dans `scripts/benchmark-results.md`.

Depuis l'onglet **Modèles** du menu Options, "Tester tous les modèles et
choisir les meilleurs" ouvre un choix de périmètre : tout analyser, ou un
seul palier (rapide/médium/puissant/vision/code) — bien plus rapide pour
re-tester juste ce qui a changé (`OLLAMA_HOST=... JARIS_ANALYSIS_SCOPE=large
npm run benchmark:models` en ligne de commande). Les résultats des autres
paliers, déjà connus, sont conservés tels quels dans
`scripts/benchmark-results.md` — jamais effacés par un run ciblé.

**Reprise après interruption.** `scripts/benchmark-results.md` est réécrit
après chaque modèle terminé, pas seulement à la toute fin du script :
interrompre l'analyse en cours (PC éteint, process tué) ne perd plus que le
modèle en train d'être testé, jamais ceux déjà finis. Pour reprendre là où
elle s'est arrêtée plutôt que tout retester depuis le début, relancer avec
`JARIS_RESUME=1` (`OLLAMA_HOST=... JARIS_RESUME=1 npm run benchmark:models`,
ou `$env:JARIS_RESUME="1"` avant la commande sous PowerShell) : tout modèle
du périmètre déjà présent dans `scripts/benchmark-results.md` est sauté (ni
retéléchargé ni retesté), sa ligne existante est juste conservée. Pas le
comportement par défaut — sans cette variable, un run reteste tout son
périmètre même si des résultats existent déjà, pour ne pas gêner le
re-test volontaire d'un palier après un changement (`JARIS_ANALYSIS_SCOPE`
ci-dessus).

Sur une machine contrainte, plusieurs paliers peuvent finir sur le même
modèle (pas assez de VRAM pour un vrai modèle "puissant" séparé) : ils
restent quand même différenciés via l'effort de réflexion d'Ollama
(paramètre `think`, sans coût VRAM supplémentaire) — `low` pour le rapide,
`medium` pour le médium, `high` pour le puissant.

Le calcul se base sur la VRAM *totale* de la carte (fixe), pas sur ce qui
est libre à l'instant du scan : sinon le résultat changerait selon qu'un
jeu ou un autre logiciel gourmand tourne au même moment, pour la même
machine. L'onglet **Modèles** du menu Options (étape 28) affiche les 3
paliers actuels et permet de relancer l'analyse à la main (utile après un
changement matériel, pas pour s'adapter à l'usage GPU du moment).

**Modèle de vision aussi adapté à la VRAM.** Le même scan choisit un
quatrième modèle, dédié à `look_at_screen` (étape 6), parmi `qwen3-vl`
(`2b`/`4b`/`8b`) et `GLM-4.6V-Flash` — plutôt qu'un modèle de vision fixe
pour tout le monde : sur une carte contrainte, un modèle trop gros pour la
VRAM restante forçait Ollama à décharger/recharger un gros modèle à chaque
capture d'écran, plusieurs dizaines de secondes d'attente. `npm run
benchmark:models` teste aussi ces candidats vision (pas juste les modèles de
conversation/code) : trois images générées à la volée (aplat de couleur,
moitié rouge/moitié verte, comptage de carrés) avec une question à réponse
objectivement vérifiable chacune — pas de description ouverte à juger à la
main, comme pour l'appel d'outils des autres paliers. "Lancer l'analyse"
choisit donc désormais le modèle vision le plus fiable *mesuré*, pas
seulement le plus gros qui rentre.

**Espace disque vérifié en plus de la VRAM/RAM, à chaque téléchargement.**
Un modèle peut tenir en RAM une fois chargé tout en étant impossible à
télécharger faute de place sur le disque — deux contraintes indépendantes,
vérifiées séparément avant chaque téléchargement (jamais mis en cache : le
disque diminue au fil d'un même run, contrairement à la VRAM/RAM). L'analyse
télécharge jusqu'à 2 à 4 modèles à la fois (adapté à la RAM détectée — une
machine avec plus de RAM encaisse mieux plusieurs téléchargements simultanés)
en tâche de fond pendant que ceux déjà installés passent déjà leurs tests (au
lieu de tout télécharger puis tout tester) ; sur une machine à l'espace disque
limité, elle passe automatiquement en téléchargement strictement séquentiel
(cette sécurité prime toujours sur la vitesse) et supprime immédiatement un
candidat dès qu'un meilleur est trouvé pour son palier — plutôt que de garder
tous les modèles testés installés simultanément jusqu'à la toute fin.

**Petits modèles : scores vérifiés une fois, sans jamais les réinstaller sur
la machine de chaque utilisateur.** Certains modèles candidats sont assez
petits pour être testés par Léo directement, une seule fois — la fiabilité
d'un modèle (répond-il avec le bon outil et les bons arguments en
conversation, comprend-il vraiment une image en vision, génère-t-il du code
valide) est une propriété du modèle lui-même, pas du matériel qui le fait
tourner : un score mesuré une fois reste valable sur n'importe quelle
machine. Ces scores vivent dans `scripts/verified-tool-scores.md` (commité,
contrairement à `benchmark-results.md`), dans **trois sections séparées**
(Conversation/Vision/Code — jamais une seule liste par nom de modèle, voir
son en-tête pour pourquoi `qwen3.5:4b` a besoin d'une ligne distincte dans
chacune des deux premières) et `npm run benchmark:models` saute
automatiquement le téléchargement et le test de tout modèle présent dans
la bonne section pour son palier. Concrètement, aucun de ces modèles n'est
jamais téléchargé pour l'analyse chez l'utilisateur final.

La **vitesse**, elle, dépend du matériel de chacun et n'est donc jamais
stockée dans `verified-tool-scores.md` : pour ces modèles-là, elle est
recalculée par une formule (`estimateSpeedTokPerSec` dans
`electron/services/hardwareScan.ts`) à partir de la VRAM qu'occupe le
modèle et de la bande passante mémoire de la carte graphique détectée
(table `GPU_MEMORY_BANDWIDTH_GBPS`, RTX 30/40/50 séries) — sans jamais
installer le modèle. Le tableau de l'onglet **Modèles** affiche ces vitesses
avec la mention "(estimé)" pour les distinguer d'une vraie mesure. Sur une
carte graphique non reconnue, la formule ne devine pas : la vitesse affichée
reste `—`.

Les modèles trop gros pour la machine de Léo (donc jamais testés par lui)
continuent de suivre le chemin d'origine, inchangé : téléchargés et
mesurés pour de vrai (vitesse *et* appel d'outils) sur la machine de
l'utilisateur final qui a assez de VRAM pour le faire.

**Vérification en temps réel avant chaque question.** Les paliers (et le
modèle de vision) restent fixes (scan ci-dessus), mais juste avant
d'appeler Ollama, Jaris regarde aussi l'état réel du GPU à l'instant
présent :
- si la VRAM *libre* ne suffit plus pour le modèle normalement prévu (un
  jeu ou un autre logiciel en consomme une partie), Jaris se replie
  automatiquement sur le modèle le plus gros qui tient encore dans ce
  palier (ou, pour la vision, dans la famille `qwen3-vl`) *et qui est déjà
  installé* (`ollama list`) — jamais un modèle jamais téléchargé, qui
  ferait échouer la question avec une erreur "model not found" ;
- si la carte dépasse 83°C, Jaris bascule directement sur le palier rapide
  le temps qu'elle refroidisse, pour ne pas insister sur une carte qui
  chauffe déjà.

Ce repli est ponctuel (recalculé à chaque question, jamais enregistré) :
dès que la VRAM se libère ou que la carte a refroidi, Jaris revient
naturellement au modèle normalement prévu pour le palier. Ça évite d'avoir
à réserver une marge fixe "au cas où" en permanence (ce qui gâcherait de la
capacité inutilement la plupart du temps) : la marge ne s'applique que
quand elle sert vraiment.

**Filet de sécurité tool calling.** Le choix du palier "rapide vs médium
vs puissant" se fait sur des mots-clés dans la question (voir plus bas) :
ça peut rater une question qui a quand même besoin d'un outil (ex: une
question météo sans le mot "cherche"). Si Jaris se retrouve à appeler un
outil alors qu'il tournait sur le palier rapide, il repasse automatiquement
sur le palier médium pour reformuler la réponse une fois le résultat de
l'outil reçu — c'est cette étape-là (formuler une vraie phrase à partir
d'un résultat d'outil) que le petit modèle rate parfois en pratique (réponse
vide, ce qui plantait la synthèse vocale). Et si malgré tout Jaris n'a
vraiment rien à dire, il le signale à voix haute au lieu de planter.

## Surveillance des ressources du PC (étape 14)

Jaris vérifie l'état général de la machine juste avant de répondre à chaque
question, avec deux logiques bien distinctes :

**CPU et RAM — juste une histoire de lenteur.** Si l'un des deux dépasse 90%
d'utilisation, Jaris le dit à voix haute avant sa réponse habituelle
("Attention, ta machine est assez chargée en ce moment, avec le CPU à 96%, ça
risque d'être plus lent que d'habitude."), avec un délai de 2 minutes entre
deux avertissements pour ne pas se répéter à chaque question tant que la
charge ne redescend pas.

**Température du GPU — un vrai risque matériel, traité différemment.** Le %
d'utilisation du GPU n'est *pas* surveillé : tourner à 90-100% est normal et
sans danger pour une carte graphique (c'est littéralement ce pour quoi elle
est faite), ce n'est pas un signe de surcharge. Seule la température réelle
compte, avec trois paliers, **vérifiés à chaque question sans aucun délai
anti-spam** (contrairement au CPU/RAM ci-dessus : une carte qui reste chaude
doit continuer à alerter/agir à chaque fois) :
- **75°C** — Jaris prévient à voix haute, mais répond quand même normalement
- **85°C** — la requête est annulée avant même d'appeler le LLM (inutile de
  charger encore plus un GPU déjà chaud), Jaris dit "85 degrés dépassés,
  arrêt de la requête" à la place de répondre
- **90°C** — Jaris s'arrête complètement (`app.quit()`) pour protéger la
  machine, après avoir eu le temps de le dire à voix haute

## Animation de scan pendant l'analyse d'écran (étape 18)

Quand Jaris regarde l'écran (`look_at_screen`, étape 6), une ligne de balayage
cyan façon J.A.R.V.I.S. (même couleur que l'orbe en écoute) descend l'écran en
boucle, avec des repères d'angle statiques dans les quatre coins — retour
visuel explicite pendant l'analyse, plutôt qu'un silence total le temps que
le modèle de vision réponde (plusieurs secondes).

Techniquement, une fenêtre Electron dédiée, plein écran, transparente et
cliquable au travers (`setIgnoreMouseEvents`), affiche cette animation
(`ScreenScan.tsx`, canvas 2D). Elle ne s'affiche qu'**après** la capture de
l'écran, jamais avant : sinon l'overlay apparaîtrait lui-même dans l'image
envoyée au modèle de vision. `setContentProtection(true)` sur cette fenêtre
garantit en plus qu'elle ne pourrait de toute façon jamais apparaître dans
une capture d'écran, même si le minutage changeait un jour.

## Contrôle clavier et souris (étape 15)

Jaris peut agir directement sur l'ordinateur, pas seulement ouvrir une
application :
- **`type_text`** — tape du texte à l'endroit où se trouve déjà le focus
  (un champ de recherche, une zone de discussion...), comme si l'utilisateur
  le tapait lui-même
- **`press_key`** — appuie sur une touche spéciale (entrée, tab, échap,
  espace, retour arrière, suppr, flèches, début, fin), par exemple pour
  valider un formulaire juste après avoir tapé du texte
- **`click_mouse`** — clique (clic gauche, droit ou double-clic) à une
  position écran précise en pixels, ou à la position actuelle du curseur si
  aucune coordonnée n'est donnée

Techniquement, ça passe par l'API Windows bas niveau `SendInput` (mode
`KEYEVENTF_UNICODE` pour le texte, donc n'importe quel caractère accentué
tape correctement quelle que soit la disposition clavier), appelée via un
petit bout de C# compilé à la volée par PowerShell — comme pour
`open_app` (étape 5), plutôt qu'un paquet npm avec du code natif
(robotjs, nut.js...) qu'il faudrait recompiler pour l'ABI d'Electron, une
complexité en plus pour l'installeur en un clic (étape 16). Le texte à
taper passe par une variable d'environnement, jamais interpolé dans le
script PowerShell lui-même, pour éviter tout risque d'injection.

Jaris n'utilise ces outils que si l'utilisateur le demande explicitement
("écris...", "tape...", "clique...", "appuie sur...") : il ne clique ou ne
tape jamais de sa propre initiative, ce sont des actions réelles et
irréversibles sur la machine.

## Contrôle machine (étape 31)

Trois outils, pour élargir ce que Jaris peut réellement *faire* sur la
machine, pas seulement répondre :
- **`get_system_stats`** — donne l'état actuel de l'ordinateur en une phrase
  (CPU, RAM, VRAM libre, température GPU), en réutilisant directement
  `getSystemLoad`/`getLiveGpuStatus` (déjà utilisés en interne pour la
  surveillance des ressources, étape 14) plutôt qu'une nouvelle mesure
- **`media_control`** — volume (monter/baisser/couper), lecture/pause,
  piste suivante/précédente, un cran à la fois comme une vraie touche
  multimédia (même mécanisme `SendInput` que `press_key`, étape 15) : pas de
  volume en pourcentage exact, aucune API Windows simple pour ça sans
  dépendance supplémentaire
- **`shutdown_pc`** — éteint ou redémarre la machine via `shutdown.exe`
  natif (aucune dépendance)

Tous les outils, y compris `send_email` et `shutdown_pc`, s'exécutent
directement dès que le modèle les appelle, sans confirmation orale/écrite
préalable — une confirmation systématique par outil a existé un temps
(niveaux N1/N2/N3, onglet Options → Sécurité) mais a été retirée : jugée
inutile pour un usage personnel. Le prompt système garde quand même une
consigne de prudence ciblée pour les clics dans le navigateur (achat,
paiement, suppression de compte — voir l'étape 34 plus bas), qui reste au
niveau du modèle plutôt qu'un blocage mécanique.

## Installeur en un clic (étape 16)

`npm run dist` produit **`Jaris-Setup-<version>.exe`** (electron-builder,
NSIS) : un seul fichier à double-cliquer, sans assistant "Suivant/Suivant",
sans invite d'élévation Windows (installation par utilisateur dans
`%LOCALAPPDATA%\Programs`), et Jaris se lance à la fin. L'icône est générée
par code (`scripts/generate-icon.mjs`), comme celle de la barre système :
aucun binaire opaque dans le dépôt.

**Personne n'a besoin d'un environnement de développement pour l'obtenir.**
Le workflow `.github/workflows/build-installer.yml` construit l'installeur
sur un runner Windows de GitHub à chaque commit poussé (récupérable dans
l'onglet Actions) et le publie en Release sur un tag `v*` — donc sans Node,
sans npm et sans dépôt cloné sur le PC qui va s'en servir.

### Ce qui s'installe tout seul au premier lancement

L'installeur ne contient que l'application (~100 Mo). Le reste est trop lourd
pour un `.exe` et dépend de la machine, donc Jaris l'installe lui-même au
premier démarrage, avec une barre de progression (`RuntimeSetup.tsx`,
`firstRunSetup.ts`) — jamais une commande à taper :

| Brique | Comment | Où |
| --- | --- | --- |
| Ollama | installeur officiel lancé en mode silencieux (`/VERYSILENT`) | `dependencyServices.ts` |
| Python | version autonome (python-build-standalone), décompressée dans `%LOCALAPPDATA%\Jaris` | `pythonRuntime.ts` |
| PyTorch, transformers… | `pip install` dans ce Python-là | `pythonRuntime.ts` |
| Modèles de conversation | écran de configuration existant, selon la VRAM détectée | `benchmarkRunner.ts` |
| Transcription et voix | téléchargés au premier usage par les sidecars Python | `voice_server.py`, `tts_server.py` |

**PyTorch est installé à part, et avant le reste.** Sur Windows, le paquet
`torch` publié sur PyPI — celui qu'installerait un simple `pip install -r
requirements.txt` — est une version **sans support GPU**. L'installer tel
quel ferait tourner la transcription sur le processeur (des secondes au lieu
d'une fraction de seconde) sur une machine qui a pourtant une carte
graphique : exactement la "version dégradée" que cette étape interdit. Jaris
détecte donc la carte NVIDIA et installe la version GPU depuis l'index
officiel PyTorch, avec repli automatique sur la version processeur si ça
échoue.

L'empreinte de `requirements.txt` est enregistrée après installation : une
future version de Jaris qui ajoute une dépendance déclenchera l'installation
manquante toute seule, sans que l'utilisateur ait à s'en occuper (base de
l'étape 20).

### Une action à faire une seule fois (par le développeur, jamais l'utilisateur)

Pour que le bouton "Connecter Gmail" fonctionne dans l'application installée,
ajoute `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET` dans **Settings → Secrets
and variables → Actions** du dépôt GitHub. Ils sont figés dans la
construction (`define` dans `electron.vite.config.ts`), jamais écrits dans le
dépôt, et l'application installée n'a donc aucun `.env` à remplir. Sans eux,
le build réussit quand même et Jaris explique simplement que l'envoi de mails
n'est pas disponible dans cette version.

### Ce qui reste à faire sur cette étape

- **Signature du code** : l'exécutable n'est pas signé, donc Windows
  SmartScreen affiche un avertissement au premier lancement ("Informations
  complémentaires" → "Exécuter quand même" pour continuer, sans risque —
  c'est notre propre `.exe`). Pas de solution gratuite viable pour Jaris :
  - **SignPath Foundation** (signature gratuite pour l'open source) est
    disqualifié — exige un dépôt public, une licence open source, et une
    application téléchargeable gratuitement, ce que le modèle par abonnement
    de l'étape 38 exclut.
  - Construire une réputation SmartScreen sans certificat (des centaines
    d'installations propres sur plusieurs semaines) ne marche pas ici : le
    hash de l'exécutable change à chaque nouveau build, la réputation
    repartirait de zéro à chaque commit.
  - Reste un vrai certificat payant à prévoir avec l'étape 38 : soit
    classique (~100-300€/an chez une autorité type DigiCert/Sectigo), soit
    Azure Trusted Signing (~10$/mois, moins cher, mais réservé aux
    particuliers US/Canada — en France il faudrait une société enregistrée,
    de toute façon nécessaire pour facturer un abonnement).
- **Recherche web sans Docker** : `docker-compose.yml` et la configuration
  SearXNG sont bien embarqués, donc la recherche web marche sur une machine
  qui a déjà Docker Desktop. Mais Docker ne s'installe pas en silence : sur
  une machine qui ne l'a pas, la recherche web reste indisponible. À
  remplacer par une solution sans Docker.

## Mise à jour automatique de l'application (étape 20)

Même principe que le bouton "Mettre à jour" déjà en place pour Ollama
(Options → Modèles), appliqué à Jaris lui-même (`appUpdater.ts`) — jamais de
`git pull`/`npm run build` à lancer à la main :

1. Au lancement, Jaris compare sa propre version (`app.getVersion()`, lue
   dans `package.json` au moment du build) à la dernière **Release GitHub
   stable** (`GET /repos/Leo6432/jaris/releases/latest`).
2. Si elle est plus récente, un bandeau apparaît partout dans l'interface
   (même mécanisme que le popup "nouveaux modèles"/"Ollama pas à jour") et
   dans Options → Modèles, avec un bouton **"Mettre à jour"**.
3. Un clic télécharge le VRAI installeur (`Jaris-Setup-*.exe`) joint à cette
   Release, le lance, puis ferme Jaris tout seul pour libérer son propre
   exécutable — l'installeur "un clic" (voir étape 16) continue alors
   entièrement silencieux et relance Jaris à la fin.

Options → Modèles affiche aussi en permanence un **journal des mises à
jour** : la version installée (`getAppVersion`, jamais bloquée par le réseau,
contrairement au bandeau ci-dessus) et la liste de toutes les Releases
stables déjà publiées avec leurs notes (`getReleaseHistory`, `GET
/releases`) — de quoi voir d'un coup d'œil sa propre version et tout
l'historique, sans aller chercher sur GitHub.

**Publier une nouvelle version** : entièrement automatique, plus aucune
commande à taper par personne (ni un utilisateur, ni le développeur). Il
suffit de bumper le champ `version` de `package.json` et de pousser le commit
— sur n'importe quelle branche. Le workflow (`build-installer.yml`) construit
l'installeur puis, si aucune Release ne correspond déjà à cette version,
publie lui-même la vraie Release GitHub `vX.Y.Z` avec l'installeur en pièce
jointe (`gh release create`, sans jamais passer par `git tag`). La Release
**"dernier-build"**, republiée à chaque push de branche pour tester le
développement en cours, est marquée `--prerelease` : `releases/latest`
l'ignore toujours, elle ne peut jamais être confondue avec une vraie sortie
versionnée par le mécanisme de mise à jour.

## Choisir l'emplacement disque des modèles (étape 44)

Les trois briques les plus lourdes de Jaris ont chacune leur emplacement
Windows habituel, sur le disque système par défaut :

| Brique | Emplacement habituel | Poids typique |
| --- | --- | --- |
| Modèles Ollama | `%USERPROFILE%\.ollama\models` | plusieurs Go par palier |
| Environnement Python (voix) | `%LOCALAPPDATA%\Jaris\python-runtime` | quelques Go (torch en tête) |
| Cache reconnaissance/synthèse vocale | `%USERPROFILE%\.cache\huggingface` | ~4 Go |

**Options → Modèles → "Choisir un dossier…"** ouvre un sélecteur de dossier
puis déplace les trois vers l'endroit choisi (`modelsLocation.ts`) — utile
pour les libérer d'un petit SSD système vers un disque secondaire plus
grand.

**Comment, techniquement.** Plutôt que d'apprendre à chaque outil un nouvel
emplacement (variable d'environnement différente pour chacun, configuration
séparée, risque de casser un usage en dehors de Jaris), chaque emplacement
habituel est transformé en **jonction NTFS** (`mklink /J`) pointant vers le
dossier choisi : totalement transparent pour Ollama, `transformers` et
`huggingface_hub`, qui continuent de lire/écrire au même chemin qu'avant
sans rien savoir du changement — les données, elles, vivent physiquement sur
le disque choisi. Une jonction, contrairement à un lien symbolique Windows,
ne demande jamais de droits administrateur et fonctionne aussi bien entre
deux disques différents que sur le même disque.

Ollama et les sidecars Python sont arrêtés avant le déplacement (fichiers
verrouillés sinon) puis relancés une fois terminé. Les données existantes
sont copiées AVANT que l'ancien emplacement ne soit touché : un échec en
cours de route (disque de destination plein, par exemple) laisse tout
exactement comme avant l'essai, jamais dans un état à moitié déplacé. Un
nouveau changement d'emplacement migre depuis l'ancien dossier choisi (pas
depuis l'emplacement Windows d'origine) et nettoie l'ancien disque au passage
— jamais de copies orphelines qui s'accumulent.

## Contrôle du navigateur avec Playwright (étape 34)

Cinq outils (tous N1, voir plus haut) pilotent la fenêtre Chrome dédiée à
Jaris via [Playwright](https://playwright.dev/) (`playwright-core`, sans
navigateur embarqué — réutilise le Chrome déjà installé sur la machine) :
- **`read_browser_tab`** — lit le titre, l'URL et le texte de l'onglet actif
  pour répondre à "résume cette page", "traduis ça", "de quoi ça parle" — le
  texte brut extrait est renvoyé comme un résultat d'outil normal, c'est le
  modèle de conversation qui résume/traduit/répond, pas une réponse déjà
  toute faite (contrairement à `look_at_screen`, qui lui court-circuite la
  reformulation)
- **`open_browser_url`** — ouvre une adresse (ou une recherche Google si ce
  n'en est pas une) dans un nouvel onglet
- **`click_browser_element`** — clique un élément décrit en langage naturel
  (le texte visible d'un bouton/lien, ex: "Suivant", "Se connecter"), jamais
  un sélecteur CSS/XPath à deviner : essaie dans l'ordre repérage par rôle
  bouton, rôle lien, puis texte brut (`page.getByRole`/`getByText`)
- **`fill_browser_field`** — remplit un champ de formulaire décrit en langage
  naturel (son label ou son placeholder, `page.getByLabel`/`getByPlaceholder`)
- **`screenshot_browser_tab`** — capture l'onglet actif et le fait décrire
  par le modèle de vision (même modèle et même logique de repli VRAM que
  `look_at_screen`, juste une image différente), pour une mise en page ou un
  contenu visuel qu'un simple texte ne suffit pas à décrire

**Contrainte Chrome, pas une limite de Jaris.** Depuis Chrome 136+, Google
interdit la connexion CDP (Chrome DevTools Protocol, nécessaire pour piloter
un onglet depuis l'extérieur) sur le profil par défaut, pour des raisons de
sécurité — vérifié sur `jarvis-assistant-vocal` (projet comparable), seule
solution qui fonctionne encore : une fenêtre Chrome **séparée**, avec son
propre profil dédié (`%LOCALAPPDATA%\JarisChrome`), lancée avec
`--remote-debugging-port`. Jaris ne peut donc piloter que les onglets ouverts
dans cette fenêtre dédiée, jamais le Chrome habituel de l'utilisateur.
`electron/services/browserControl.ts` lance cette fenêtre automatiquement au
premier besoin (rien à installer ni à lancer à la main) : elle démarre vide
(nouveau profil), l'utilisateur doit y ouvrir/naviguer vers la page qu'il
veut faire piloter à Jaris. Bouton **"Connecter mon profil Chrome
existant"** dans Options → Connexions (`importRealChromeProfile`,
`browserControl.ts`) pour éviter ce profil vide : copie le vrai profil
Chrome de l'utilisateur (comptes connectés, favoris, mots de passe) dans le
dossier de la fenêtre dédiée — possible car la restriction de Chrome 136+
porte sur le dossier de profil *par défaut* exactement, pas sur un dossier
personnalisé qui contiendrait les mêmes données. Instantané figé (pas
synchronisé en continu avec le Chrome habituel), sauf à activer la
synchronisation Google dans les deux profils.

**Sécurité "achat/paiement".** Comme sur `jarvis-assistant-vocal`, le prompt
système (`assistant.ts`) interdit explicitement de cliquer un bouton
d'achat/paiement/validation de commande/suppression de compte sans que
l'utilisateur ait demandé CETTE action précise dans sa phrase, même si elle
semble être la suite logique de ce qui précède — Jaris décrit plutôt ce qu'il
voit et demande confirmation avant. C'est une consigne au niveau du prompt,
pas un blocage mécanique (aucune confirmation systématique par outil,
voir étape 31) : sans quoi la navigation assistée deviendrait impraticable
(une confirmation avant chaque clic).

## Design de l'interface (étape 17)

Le visage animé d'origine (`JarisFace` : yeux + bouche stylisés) est remplacé
par `JarisOrb`, un noyau holographique dessiné sur un `<canvas>` (Canvas 2D,
sans dépendance supplémentaire), inspiré de l'interface de J.A.R.V.I.S. dans
Iron Man :
- un double anneau au contour irrégulier ("déchiré"), qui tourne lentement
- deux anneaux fins plus réguliers façon verre, à l'intérieur
- un petit noyau filaire au centre (maillage type sphère géodésique, généré
  par répartition de Fibonacci + connexion aux plus proches voisins), qui
  tourne sur lui-même

La couleur et la vitesse de rotation changent selon l'émotion de Jaris (teal
en veille, cyan à l'écoute, orange en réflexion, vert content, rouge
surpris), comme avant avec `JarisFace`.

**Réactif à la voix.** Pendant que Jaris parle, `JarisOrb` écoute le niveau
sonore réel de l'audio joué (Web Audio API, `AnalyserNode` branché sur
l'élément `<audio>` de la réponse) et fait vibrer/pulser l'anneau et le
noyau en fonction — l'anneau tremble plus fort et brille plus quand Jaris
parle fort, et revient à une respiration légère au repos.

## Les 3 modes de l'interface (étape 30)

La fenêtre de réglages a une colonne latérale permanente, toujours visible,
qui donne accès à trois façons d'utiliser Jaris. Le cerveau de Jaris et le
menu Options sont en bas de cette colonne, disponibles quel que soit le mode.

**Agent vocal** — l'expérience d'origine : l'orbe, le déclenchement par
double clap, la réponse parlée. Rien n'y change.

**Chat** — exactement le même Jaris, au clavier : mêmes outils (ouvrir une
application, chercher sur le web, regarder l'écran, mémoriser, envoyer un
mail), même mémoire markdown, et surtout le **même historique** que la voix.
Commencer une demande à l'oral et l'enchaîner par écrit (ou l'inverse)
continue la même conversation. Deux différences seulement avec la voix : pas
de synthèse vocale, et le prompt système autorise les listes et les blocs de
code — l'interdiction de toute mise en forme n'existait que parce que le
texte était lu à voix haute (`ConverseChannel` dans `assistant.ts`). Un rappel
programmé depuis le chat est quand même annoncé à voix haute, comme un rappel
programmé à la voix.

**Code** — un générateur d'applications façon Lovable/Emergent, 100% local :
on décrit une application en français, Jaris produit une page web autonome
(HTML + CSS + JavaScript dans un seul fichier, aucune dépendance réseau),
l'affiche en direct dans un aperçu, et l'enregistre sur le disque. Les
demandes suivantes modifient l'application en cours au lieu d'en repartir de
zéro. Ce qui le distingue d'un simple appel LLM brut (`codeGenerator.ts`) :

- **Scaffolding** : un prompt système enrichi de consignes strictes
  (`APP_RULES`) sur le design, la structure du code, la gestion des cas
  limites et surtout l'interdiction absolue de toute ressource externe (CDN,
  police distante, appel réseau) — sans ces règles, un modèle local produit
  typiquement une page grise avec un `<script src>` vers un CDN qui ne
  chargera jamais.
- **Boucle multi-agents** : le premier jet n'est jamais affiché tel quel. Un
  second passage relit tout le fichier pour corriger la syntaxe, retirer les
  dépendances externes oubliées, mettre en forme ce qui ne l'est pas et
  combler les écarts avec la demande. Si cette relecture échoue, le premier
  jet est conservé plutôt que de faire échouer toute la génération.
- **Vérification mécanique puis réparation ciblée** : cette relecture est
  faite "au jugé" par le modèle, qui laisse passer des défauts pourtant
  détectables automatiquement. `validateGeneratedHtml` vérifie donc pour de
  vrai le fichier produit — balises `<script>` appariées, `<html>`/`<body>`
  présents, aucune ressource externe, et surtout aucun code JavaScript resté
  dans le `<body>` (un petit modèle local l'y laisse régulièrement, où il
  s'affiche comme un pavé de texte au milieu de la page au lieu de
  s'exécuter). Les problèmes trouvés sont renvoyés au modèle avec la liste
  exacte de ce qui ne va pas, bien plus efficace qu'une nouvelle demande de
  relecture générique. La réparation n'est gardée que si elle réduit vraiment
  le nombre de problèmes, et ceux qui subsistent sont **affichés à
  l'utilisateur** plutôt que de faire passer une page cassée pour un succès.
- **Contexte ciblé** : pour une modification, seul le fichier courant et la
  nouvelle demande sont envoyés au modèle, jamais tout l'historique de la
  discussion.
- **Deux modèles dédiés, pas un palier de conversation** : une première
  version s'appuyait sur le palier "puissant" du profil (un modèle
  généraliste, pas spécialisé code) — la qualité produite restait trop en
  dessous de ce qu'on peut attendre d'un vrai générateur, malgré les
  correctifs ci-dessus (tentative visible dans l'historique Git). `Jaris`
  utilise maintenant deux modèles réellement entraînés pour le code
  (`resolveCodeModel` dans `codeGenerator.ts`, candidats listés dans
  `CODE_CANDIDATES` de `hardwareScan.ts`) : `qwen2.5-coder:7b` par défaut
  (rapide, tient sur 8 Go de VRAM, téléchargé automatiquement au premier
  lancement du mode Code s'il manque), et `qwen3.6:35b-a3b` s'il est déjà
  installé — nettement plus capable en code, mais 35 Md de paramètres au
  total qui débordent largement de la VRAM et tournent surtout via la RAM
  système (plus lent, demande une machine avec beaucoup de RAM). Contrairement
  au modèle rapide, il n'est jamais téléchargé automatiquement **pendant**
  une génération (trop volumineux pour une attente en plein milieu d'une
  tâche) — mais `scripts/benchmark-models.mjs` (bouton "Lancer l'analyse" de
  l'onglet Modèles) l'installera au prochain lancement si la machine peut
  raisonnablement le faire tourner : ce modèle fait partie de
  `RAM_OFFLOAD_MODELS`, jugé sur **VRAM + RAM combinées** (moins une marge de
  8 Go réservée à l'OS) plutôt que sur la VRAM seule comme les autres
  candidats — sur une machine avec peu de VRAM mais beaucoup de RAM (le cas de
  Léo), il passe le filtre ; sur une machine qui n'a ni l'une ni l'autre, il
  reste bloqué comme n'importe quel modèle trop gros. Le modèle réellement
  utilisé si le mode Code démarrait maintenant est affiché dans l'onglet
  Modèles, à côté des autres paliers.
- **Testé sur la génération de code, pas l'appel d'outils.** `generateApp`
  n'appelle jamais Ollama avec des outils (`tools` toujours `undefined`,
  contrairement à la conversation) — les candidats du palier Code étaient
  pourtant testés avec les mêmes prompts d'appel d'outils que les paliers de
  conversation dans `scripts/benchmark-models.mjs`, une capacité que le mode
  Code n'utilise jamais. `CODE_TEST_CASES` les teste maintenant sur leur
  vraie tâche : une seule passe de génération (pas la relecture/réparation du
  vrai pipeline, pour mesurer la capacité brute du modèle) puis
  `validateGeneratedHtml` vérifie mécaniquement le résultat — même logique
  que les images générées pour Vision plus haut, une réponse objectivement
  vérifiable plutôt qu'un jugement humain sur le design.

L'aperçu tourne dans une iframe `sandbox="allow-scripts"`, sans
`allow-same-origin` : le code produit par le modèle s'exécute dans une origine
opaque, sans accès à Jaris ni aux fichiers de la machine. Conséquence assumée
et affichée dans l'interface : `localStorage` y est bloqué (d'où le try/catch
imposé dans les consignes de génération), mais refonctionne dès qu'on ouvre le
fichier depuis son dossier.

## Widget flottant toujours visible (étape 19)

Jaris se lance toujours normalement, dans sa fenêtre classique (comme avant
cette étape) — rien ne change au démarrage. Ce qui change : dès qu'on la
réduit (bouton "Réduire") ou qu'on la ferme (croix), au lieu de disparaître
ou de quitter l'appli, elle laisse la place à un petit widget (`JarisOrb`,
sans fenêtre ni fond) posé en bas à droite de l'écran, au-dessus de toutes
les autres fenêtres — visible même en travaillant dans le navigateur ou une
autre appli. Jaris continue de tourner en arrière-plan, il n'y a juste plus
la grande fenêtre à l'écran.
- **Sans fond** : la fenêtre Electron du widget est transparente
  (`transparent: true`, sans bordure) ; seul l'anneau lumineux de `JarisOrb`
  est visible, pas de rectangle derrière.
- **Toujours au-dessus** : `alwaysOnTop` + visible sur tous les bureaux
  virtuels, donc il reste affiché même en changeant d'application ou de
  bureau.
- **Réagit depuis n'importe où** : le double clap (déjà basé sur le micro,
  indépendant de la fenêtre) et le **+ du pavé numérique** (`globalShortcut`,
  enregistré au démarrage) déclenchent l'écoute quel que soit le programme
  qui a le focus.
  > Le caractère "+" tout seul (celui à côté du Entrée sur un clavier
  > AZERTY) n'est pas un accelerator valide pour `globalShortcut` : Electron
  > lève carrément une exception à l'enregistrement ("conversion failure
  > from +"), ce qui plantait le démarrage entier de Jaris avant que ce soit
  > entouré d'un `try/catch`. Le "+" du pavé numérique (`numadd`) est un
  > code touche distinct et stable, sans cette ambiguïté — visuellement
  > c'est quand même la touche "+" recherchée à l'origine. Une fois un
  > raccourci global enregistré avec succès, Electron/Windows donnent
  > l'exclusivité totale sur cette touche à Jaris — il n'y a rien de plus à
  > "prioriser" à ce niveau-là ; si l'enregistrement échoue (touche déjà
  > réservée par une autre appli...), le terminal l'indique clairement au
  > démarrage (`[jaris] Raccourci global ... enregistré avec succès` ou
  > `Impossible de réserver...`).
- **Cliquer sur le widget** rouvre la fenêtre classique (l'orbe en grand, la
  conversation, le bouton Options, le cerveau de Jaris). Une icône dans la
  barre système (clic droit) permet aussi de la rouvrir, ou de vraiment
  quitter Jaris.
- **Messages longs** : le widget est volontairement plus haut que large
  (320×520) et son contenu est ancré en bas (donc collé au vrai coin
  bas-droit au repos, vide et transparent donc invisible tant qu'il n'y a
  rien à dire) — une réponse longue pousse vers le haut sans être coupée,
  avec un défilement en dernier recours si elle dépasse quand même.
- **Pré-chargé au démarrage** (cette fenêtre existe déjà, cachée, dès le
  lancement de Jaris) et repositionné juste avant chaque affichage (pas
  figé une fois pour toutes) : pas de délai ni de mauvais cadrage la
  première fois qu'on réduit la fenêtre.
- **La conversation s'efface toute seule** : la transcription et la réponse
  restent affichées tant que Jaris parle, puis disparaissent une fois qu'il
  a fini (retour à "idle" une fois la lecture audio terminée) — pas de
  vieille conversation qui traîne à l'écran indéfiniment.
- Les deux fenêtres ne sont jamais affichées en même temps, pour éviter que
  la réponse vocale soit jouée deux fois.

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

Jaris peut capturer l'écran et le décrire, ou répondre à une question dessus
("qu'est-ce qui est affiché ?", "y a-t-il un message d'erreur ?") — dis
simplement ce que tu veux savoir, il capture et regarde tout seul. Utilise
un modèle séparé du modèle de conversation, dans la famille `qwen3-vl`
(`2b`/`4b`/`8b` selon la VRAM détectée, voir "Modèle de vision aussi adapté
à la VRAM" à l'étape 13 — `OLLAMA_VISION_MODEL` dans `.env`, `qwen3-vl:8b`
par défaut, sert uniquement de repli si le scan de capacité n'a jamais
tourné).

## Recherche web (étape 7)

Nécessite [Docker Desktop](https://www.docker.com/products/docker-desktop/)
installé. Jaris démarre lui-même Docker Desktop (s'il n'est pas déjà lancé)
puis l'instance [SearXNG](https://github.com/searxng/searxng) locale (aucun
compte, aucune clé) au lancement de l'appli — pas besoin de lancer
`docker compose up -d` à la main. Pour le faire manuellement quand même
(ou si le démarrage auto échoue) :

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

**Alimentée automatiquement, pas seulement sur demande explicite.** En
pratique, compter sur l'utilisateur pour dire "retiens que..." à chaque
fois qu'il mentionne un fait important ne marche pas — personne n'y pense
systématiquement, et sur le palier "rapide" (conversation sans mot-clé
d'action), rien ne garantit que le modèle appelle vraiment `remember` de
lui-même. Après chaque échange, un second appel Ollama tourne en arrière-plan
(`memoryExtractor.ts`), toujours sur le palier médium (le seul dont la
fiabilité d'appel d'outils est éprouvée) et avec un effort de réflexion bas
(tâche de classification simple) : il relit l'échange qui vient d'avoir
lieu et décide s'il contient un fait qui mérite d'être gardé, sans attendre
une demande explicite. Ne retarde jamais la réponse déjà dite à l'utilisateur
(lancé sans l'attendre) et n'interrompt jamais la conversation en cas
d'erreur (avalée silencieusement, juste loguée).

## Graphe 3D du cerveau de Jaris (étape 10)

Le bouton "Voir le cerveau de Jaris" dans l'interface ouvre une vraie
visualisation en 3D (via [`3d-force-graph`](https://github.com/vasturiano/3d-force-graph),
rendu Three.js) des notes markdown de la mémoire (étape 9) et de leurs liens
`[[...]]`, interactive (rotation, zoom, survol) — comme la vue graphe
d'Obsidian. Un bouton "Ouvrir le dossier" dans cette vue permet d'accéder
directement aux fichiers `.md` dans l'explorateur pour les consulter ou les
modifier à la main.

## Envoi de mails (étape 11)

Jaris peut envoyer un vrai mail via un compte Gmail connecté depuis l'appli.

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

> Tant que l'écran de consentement OAuth reste en statut **"Test"** (étape
> 3 ci-dessus), Google fait expirer le jeton persistant au bout de **7
> jours**, même sans rien faire de mal — l'envoi échoue alors avec
> `invalid_grant` (Jaris déconnecte automatiquement le compte dans ce cas,
> il suffit de recliquer "Connecter Gmail" dans Options). Pour éviter d'avoir
> à reconnecter tous les 7 jours, passe l'écran de consentement en statut
> **"En production"** (bouton "Publier l'application" sur la page Écran de
> consentement OAuth) : aucune vérification Google n'est nécessaire pour un
> usage personnel, juste un écran "Cette application n'est pas validée" à
> traverser une fois via "Paramètres avancés → Accéder à [nom de l'app]
> (dangereux)" lors de la connexion.

Pour l'application installée (étape 16, pas de `.env`), ces deux identifiants
sont figés à la construction depuis les secrets GitHub Actions du dépôt (voir
"Une action à faire une seule fois" plus bas) — c'est ce qui permet à
n'importe quel installeur téléchargé de connecter Gmail sans que l'utilisateur
n'ait à créer quoi que ce soit lui-même.

Si aucun compte Gmail n'est connecté, Jaris te préviendra à voix haute qu'il
ne peut pas envoyer le mail au lieu d'échouer silencieusement.
