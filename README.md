# Jaris

Assistant IA personnel vocal, inspiré de J.A.R.V.I.S. — **100% local, 0€/mois**.
Electron + React + TypeScript, aucun appel à une API payante : tout le pipeline
(voix → réflexion → réponse) tourne sur la machine.

## État actuel

- ✅ Étape 1 — Projet Electron + React + TS (Vite / electron-vite) initialisé
- ✅ Étape 2 — Visage animé (`JarisFace`, remplacé à l'étape 17 par
  `JarisOrb`) avec 5 états d'émotion : veille, écoute, réflexion, content,
  surpris
- ✅ Étape 3 — Pipeline vocal local : mot d'activation (openWakeWord),
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
  compte SMTP configuré dans `.env` — voir plus bas
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
- ⬜ Étape 21 — Intégration téléphone : système pour connecter Jaris au
  téléphone de l'utilisateur (via son numéro ou une connexion directe au
  téléphone) afin d'envoyer des messages, voir les notifications, et plus
  largement tout voir/contrôler depuis le téléphone — en s'appuyant sur un
  projet open source existant faisant le pont PC/téléphone (ex: KDE Connect)
  plutôt que de tout réécrire
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
- ⬜ Étape 34 — Playwright pour piloter un vrai navigateur : en complément de
  l'UI Automation Windows (étape 32, pour les applications de bureau),
  utiliser Playwright (open source, gratuit, 100% local) pour naviguer,
  cliquer, remplir des formulaires et prendre des captures d'écran dans un
  navigateur réel — utile pour les sites web dynamiques que le simple scan
  d'écran (étape 6) ou le scraping (étape 33) ne suffisent pas à piloter
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
- ⬜ Étape 35 — Optimisation complète de l'application : passe à fond sur les
  performances avant de passer aux étapes de mise sur le marché ci-dessous —
  réduire au maximum la consommation CPU/GPU/RAM au repos et en usage
  (démarrage, appels redondants comme `nvidia-smi` relancé plusieurs fois par
  question, animations qui tournent même fenêtre cachée), accélérer les
  temps de réponse (chargement des modèles, transcription, synthèse vocale),
  réduire la taille de l'appli packagée, et nettoyer le code mort et les
  dépendances inutilisées
- ⬜ Étape 16 — Installeur en un clic : **règle absolue — le Jaris installé par
  le public doit être exactement le même que celui utilisé en développement**
  (mêmes modèles, mêmes fonctionnalités, même qualité de réponse), jamais une
  version allégée ou dégradée, et ça doit rester 0€ pour toujours (aucun
  abonnement, aucune API payante, tout tourne en local sur la machine de
  l'utilisateur, exactement comme aujourd'hui en dev). Pour y arriver :
  empaqueter toute la chaîne (app + Ollama + modèles, y compris le modèle de
  transcription Cohere Transcribe déjà téléchargé et embarqué — licence
  Apache 2.0, donc redistribution autorisée) dans un seul installeur simple,
  avec tous les réglages techniques déjà configurés par défaut à l'intérieur.
  Aucun fichier `.env` à ouvrir ni à modifier à la main, aucun compte
  Hugging Face à créer, même pour un débutant complet — seuls les vrais
  réglages perso (connecter Gmail, choisir son prénom) resteront dans
  l'interface, jamais dans un fichier texte ni sur un site tiers
- ⬜ Étape 20 — Mise à jour automatique de l'application dès qu'une nouvelle
  version est publiée
- ⬜ Étape 22 — Vérification des licences avant mise en vente : vérifier la
  compatibilité des licences des briques open source utilisées (Ollama,
  modèles Qwen, openWakeWord, Cohere Transcribe, Supertonic HD, SearXNG) avec
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

### 2. Synthèse vocale (Supertonic HD)

Rien à installer à la main : `supertonic` est dans `python/requirements.txt`
(déjà installé à l'étape 1), et le modèle (~100 Mo, léger) se télécharge tout
seul au premier lancement de Jaris, comme Cohere Transcribe. `TTS_VOICE`
dans `.env` fixe la voix par défaut (`M3` de base) ; 10 voix sont dispo au
total (`M1`-`M5`, `F1`-`F5`) et peuvent être écoutées et choisies directement
depuis le menu **Options** de l'appli (clic sur une voix = phrase d'exemple
jouée + voix retenue pour les prochaines réponses), sans toucher au `.env`.

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

Au tout premier lancement (juste après la connexion Gmail), Jaris scanne la
carte graphique (`nvidia-smi`) et choisit 3 modèles Ollama adaptés à la
machine :
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

**Agent vocal** — l'expérience d'origine : l'orbe, le mot d'activation, la
réponse parlée. Rien n'y change.

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
- **Réagit depuis n'importe où** : le mot d'activation "Hey Jarvis" (déjà
  basé sur le micro, indépendant de la fenêtre) et le **+ du pavé
  numérique** (`globalShortcut`, enregistré au démarrage) déclenchent
  l'écoute quel que soit le programme qui a le focus.
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
