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
- ⬜ Étape 15 — Contrôle clavier et souris : Jaris peut écrire du texte et
  cliquer à la place de l'utilisateur, pour automatiser des actions
  complètes sur l'ordinateur (pas seulement ouvrir une application)
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
- ✅ Étape 17 — Amélioration du design de l'interface : le visage animé
  (`JarisFace`) est remplacé par `JarisOrb`, un noyau holographique façon
  J.A.R.V.I.S. (Iron Man) — voir plus bas
- ⬜ Étape 18 — Animation pendant la capture/analyse d'écran, pour donner un
  retour visuel pendant que Jaris "regarde" (étape 6)
- ✅ Étape 19 — Mode toujours visible : petite fenêtre Jaris affichée en
  permanence en bas à droite de l'écran (widget flottant), au lieu de
  n'apparaître que quand la fenêtre principale a le focus — voir plus bas
- ⬜ Étape 20 — Mise à jour automatique de l'application dès qu'une nouvelle
  version est publiée
- ⬜ Étape 21 — Intégration téléphone : système pour connecter Jaris au
  téléphone de l'utilisateur (via son numéro ou une connexion directe au
  téléphone) afin d'envoyer des messages, voir les notifications, et plus
  largement tout voir/contrôler depuis le téléphone — en s'appuyant sur un
  projet open source existant faisant le pont PC/téléphone (ex: KDE Connect)
  plutôt que de tout réécrire
- ⬜ Étape 22 — Préparation à la vente (~5€) : licence, protection contre la
  copie/redistribution du logiciel. Nécessitera au préalable de vérifier la
  compatibilité des licences des briques open source utilisées (Ollama,
  modèles Qwen, openWakeWord, Cohere Transcribe, Supertonic HD, SearXNG) avec
  une distribution commerciale
- ⬜ Étape 23 — Site web avec tableau de bord personnel : chaque utilisateur
  peut noter son planning et sa to-do list sur le site, et Jaris peut y
  écrire des informations
- ⬜ Étape 24 — Jaris connaît la date et l'heure : briefing du matin
  (planning du jour, tâches à faire), et ajoute automatiquement une tâche à
  la to-do list du site dès que l'utilisateur en mentionne une à voix haute
- ✅ Étape 25 — Personnalisation, prénom de l'utilisateur : au tout premier
  lancement, Jaris demande comment l'appeler (une seule fois, sauvegardé
  localement) et s'adresse ensuite à l'utilisateur par son prénom en
  conversation — voir plus bas
- ⬜ Étape 26 — Paramètres avancés : page dédiée pour tout personnaliser
  (connecter son planning/calendrier, son Gmail, choisir la langue, etc.)
- ⬜ Étape 27 — Sous-agents : Jaris peut lancer plusieurs sous-agents (agents
  web, etc.) en parallèle pour des tâches complexes qui demandent plusieurs
  actions en même temps, au lieu de tout faire en une seule séquence
- ✅ Étape 28 — Onglet "Modèles" dans le menu Options : affiche les 3 paliers
  rapide/médium/puissant choisis par le scan de capacité (étape 13), avec un
  bouton pour relancer l'analyse à tout moment (pas seulement au premier
  lancement) — voir plus bas
- ⬜ Étape 29 — Mentions légales / conditions d'utilisation à faire accepter
  avant la première utilisation, pour dégager la responsabilité en cas
  d'action problématique de l'IA
- ⬜ Étape 30 — Protection contre la redistribution : identifiant unique par
  utilisateur/licence pour pouvoir tracer une copie de Jaris qui circule ou
  est partagée à d'autres personnes (piste à creuser, pas encore figée)
- ⬜ Étape 31 — Publication et monétisation : site pour vendre un abonnement
  (~10€/mois)
- ⬜ Étape 32 — Vidéo de présentation : animation en full motion design
  générée avec l'IA pour présenter le projet Jaris, avec sound effects et
  musique
- ⬜ Étape 33 — Levée de fonds : page sur le site pour présenter le projet à
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

1. Installe [Ollama](https://ollama.com/) (installeur Windows classique)
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
`conversation-history.json` (déjà tenu à jour, voir étape 5 plus bas), donc
revenir le lendemain sur le même sujet continue la conversation au lieu de
repartir de zéro. Ça reste une fenêtre glissante bornée (~6 derniers
échanges, pas tout l'historique) : pour qu'un fait précis survive
vraiment, sur la durée et sans dépendre de cette fenêtre, mieux vaut
demander à Jaris de le retenir explicitement — c'est le rôle de la mémoire
longue durée façon Obsidian (étape 9, plus bas).

## Sélection automatique de modèle (étape 13)

Au tout premier lancement (juste après la connexion Gmail), Jaris scanne la
carte graphique (`nvidia-smi`) et choisit 3 modèles Ollama adaptés à la
machine, dans la famille `qwen3.5` (de `0.8b` à `35b`) :
- **rapide** — questions courtes sans action à faire
- **médium** — le défaut pour la plupart des échanges, et le seul palier
  utilisé pour tout appel d'outil (ouvrir une appli, rappel, recherche web,
  mémoire, mail) : c'est le seul dont la fiabilité d'appel d'outils est
  éprouvée, pas question de la sacrifier pour gagner un peu de vitesse
- **puissant** — questions qui demandent explicitement une réflexion
  poussée ("pourquoi", "explique", "compare"...) ou un message long

Le calcul réserve ~4,5 Go de VRAM pour le STT (Cohere Transcribe, chargé en
permanence pendant toute la session) avant de choisir les modèles : le
palier "puissant" ne peut donc jamais dépasser ce que la carte supporte
réellement, même sur une machine avec beaucoup de VRAM totale mais peu de
marge une fois le STT pris en compte. Les modèles manquants sont
téléchargés automatiquement pendant l'écran de scan (`ollama pull`), donc
peut prendre plusieurs minutes selon la connexion.

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

**Vérification en temps réel avant chaque question.** Les 3 paliers restent
fixes (scan ci-dessus), mais juste avant d'appeler Ollama, Jaris regarde
aussi l'état réel du GPU à l'instant présent :
- si la VRAM *libre* ne suffit plus pour le modèle normalement prévu (un
  jeu ou un autre logiciel en consomme une partie), Jaris se replie
  automatiquement sur le modèle le plus gros qui tient encore dans ce
  palier *et qui est déjà installé* (`ollama list`) — jamais un modèle
  jamais téléchargé, qui ferait échouer la question avec une erreur
  "model not found" ;
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

En plus du repli automatique de modèle (étape 13 ci-dessus), Jaris vérifie
l'état général de la machine juste avant de répondre à chaque question :
- **CPU** — % d'utilisation moyen de tous les coeurs
- **RAM** — % de mémoire vive utilisée
- **GPU** — % d'utilisation de la carte graphique (`nvidia-smi`)

Si l'un de ces trois dépasse son seuil (90% pour le CPU et la RAM, 95% pour
le GPU), Jaris le dit à voix haute juste avant sa réponse habituelle ("Attention,
ta machine est assez chargée en ce moment, avec le CPU à 96%, ça risque
d'être plus lent que d'habitude.") plutôt que de répondre lentement sans
prévenir. Pour ne pas répéter le même avertissement à chaque question tant
que la charge ne redescend pas, il y a un délai de 2 minutes entre deux
avertissements.

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

```
ollama pull qwen3-vl:8b
```

Jaris peut capturer l'écran et le décrire, ou répondre à une question dessus
("qu'est-ce qui est affiché ?", "y a-t-il un message d'erreur ?") — dis
simplement ce que tu veux savoir, il capture et regarde tout seul. Utilise
un modèle séparé du modèle de conversation (`OLLAMA_VISION_MODEL` dans
`.env`, `qwen3-vl:8b` par défaut).

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
