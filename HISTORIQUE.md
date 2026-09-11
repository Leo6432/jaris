# Historique des étapes terminées

Ce fichier contient toutes les étapes déjà terminées (✅) du développement de Jaris, dans leur ordre
chronologique d'achèvement (pas forcément l'ordre numérique des étapes). Déplacées ici depuis le README
(demande de Léo, "enleve toute les etape deja fait") pour que le README reste concentré sur ce qui reste à
faire — rien n'est perdu, juste rangé à part. Voir README.md pour la liste des étapes encore en attente.

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
- ✅ Étape 34 — Agent "computer use" pour piloter réellement l'ordinateur à la souris et au clavier (voir plus bas)
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
- ✅ Étape 45 — Installations plus prévisibles : dépendances Python et
  image Docker SearXNG figées, modèle ignoré (VRAM/RAM/disque
  insuffisants) signalé clairement au lieu de disparaître dans le
  journal, test de démarrage de l'appli packagée ajouté à la CI
- ✅ Étape 46 — Modèle de code choisi et téléchargé automatiquement selon
  la VRAM+RAM de la machine (Options → Modèles), exactement comme les
  autres paliers/vision — plus les deux choix fixes historiques ni le
  menu déroulant manuel qui les accompagnait, catalogue élargi avec
  qwen2.5-coder:14b
- ✅ Étape 48 — Réponses du Chat affichées au fil de leur génération
  (streaming), nouvel outil read_web_page pour lire le contenu complet
  d'une page trouvée par search_web quand l'extrait ne suffit pas
- ✅ Étape 50 — Deux corrections signalées par Léo après l'étape 46 : le
  tableau des 3 paliers affiche à nouveau la ligne Code (retirée en
  v0.3.1 quand elle ne reflétait pas encore un vrai calcul), et calcule
  maintenant la ligne "ta configuration" avec la VRAM réelle détectée
  plutôt qu'un des 3 points fixes (6/12/24 Go) — deux machines de la même
  tranche pouvaient sinon afficher des modèles différents de ceux
  vraiment enregistrés dans leur profil
- ✅ Étape 52 — Le modèle de conversation remplaçait parfois un vrai
  message d'erreur d'outil par un dépannage générique inventé et FAUX
  (constaté sur un échec SearXNG persistant, voir étape 53 : des étapes
  nginx/.htaccess qui n'existent pas dans Jaris), malgré une consigne
  système explicite le lui interdisant déjà. Corrigé en court-circuitant
  le modèle plutôt qu'en renforçant encore la consigne : un échec d'outil
  devient directement la réponse finale, jamais reformulé — même logique
  que le court-circuit déjà existant pour look_at_screen
- ✅ Étape 53 — Deux corrections supplémentaires signalées par Léo :
  (1) SearXNG répondait 403 en boucle malgré 2 correctifs (v0.3.6/v0.3.7)
  qui ciblaient tous les deux le conteneur SearXNG lui-même — le VRAI
  message d'erreur obtenu grâce à l'étape 52 a d'abord semblé montrer que
  le corps de la réponse était la page 403 par défaut d'Apache, jamais
  produite par SearXNG (un AUTRE logiciel occuperait le port 8080).
  Corrigé sur cette base en déplaçant SearXNG sur le port 8091 — **ce
  diagnostic s'est révélé FAUX, voir étape 58** ;
  (2) le mode vocal réagissait à la voix même en étant sur l'onglet Chat
  ou Code — suspendu tant qu'un de ces deux onglets est actif
- ✅ Étape 54 — "Réponse vide d'Ollama" constaté en usage réel sur le plus
  petit modèle du palier Rapide (qwen3.5:0.8b, choisi sur les machines à
  faible VRAM) : mesuré pour de vrai, le système prompt de Jaris + la
  liste de ses outils consomment à eux seuls environ 4200-4500 tokens,
  déjà presque tout le budget de la fenêtre de contexte par défaut
  (4096) avant même le premier message. OLLAMA_NUM_CTX passe à 8192
  (config.ts/.env.example), jamais revu depuis sa valeur d'origine
  malgré la croissance du système prompt/des outils au fil des versions
- ✅ Étape 55 — Docker Desktop (nécessaire à la recherche web) s'installe
  maintenant lui-même si besoin, à la demande explicite de Léo qui
  pensait à tort qu'il l'était déjà (seul Ollama s'installait tout seul
  jusqu'ici, pas Docker Desktop). Pas silencieux comme Ollama : activer
  la virtualisation nécessaire demande une autorisation Windows
  incontournable, qui sert justement l'accord explicite voulu ici. Un
  redémarrage Windows n'est jamais forcé à la place de l'utilisateur —
  juste suggéré s'il semble nécessaire après coup
- ✅ Étape 56 — Le détecteur "promesse sans action" (empêche Jaris de
  dire "je vais faire X" sans jamais appeler l'outil) ne couvrait que
  le verbe "faire" — constaté en usage réel (Léo, une
  question sur le président américain), le modèle a promis "je vais
  RECHERCHER..." sans jamais appeler search_web, une formulation qui ne
  matchait pas l'ancien motif. Généralisé pour détecter "je vais " +
  n'importe quel verbe (motif grammatical, pas un mot précis), vérifié
  pour ne pas déclencher à tort sur des tournures bénignes ("je vais
  bien")
- ✅ Étape 57 — L'auto-installation de Docker Desktop (étape 55) ne
  suffisait pas : constaté en usage réel juste après, Docker Desktop
  installé avec succès mais bloqué au démarrage par sa propre erreur
  "WSL not installed" (son prérequis sur Windows, jamais vérifié).
  Corrigé en installant WSL en premier (même mécanisme de consentement
  Windows visible que pour Docker Desktop), déplacé pour être vérifié à
  chaque lancement de Jaris et pas seulement au tout premier — l'ancien
  emplacement du check ne pouvait jamais s'exécuter une fois Docker
  Desktop déjà installé
- ✅ Étape 58 — Le 403 SearXNG est réapparu à l'identique après l'étape
  53 (port 8091 y compris) : le diagnostic "page d'erreur Apache par
  défaut" était FAUX, basé sur une recherche web généraliste plutôt que
  sur le vrai code source. Vérifié pour de vrai cette fois (code source
  de Werkzeug, la bibliothèque utilisée par SearXNG) : ce texte est le
  message d'erreur PAR DÉFAUT de SearXNG lui-même — c'était bien lui qui
  répondait depuis le début, le changement de port était une fausse
  piste. Plus de 4e hypothèse non vérifiée : Jaris lit maintenant la
  config telle que le conteneur la voit RÉELLEMENT et l'inclut dans le
  message d'erreur, pour comparer un fait au fichier réel sur le disque
- ✅ Étape 59 — La vraie cause du 403 SearXNG (étapes 55 à 58) : un ANCIEN
  échec d'outil rejoué depuis l'historique de conversation, sans nouvel
  appel réel à SearXNG (déjà redevenu fonctionnel entre-temps). Aucune des
  hypothèses précédentes n'était donc la cause. Corrigé (par Codex) en
  excluant du contexte envoyé au modèle les échanges où l'outil avait
  échoué, sans effacer l'historique visible ni masquer un vrai échec du
  tour en cours. Régression : `node --test scripts/test-assistant-history.mjs`
- ✅ Étape 47 — Mémoire unifiée entre Voix et Chat : les deux modes
  chargeaient chacun leur propre copie de l'historique court terme envoyé
  au modèle, désynchronisées dès qu'on passait de l'un à l'autre en pleine
  conversation. Fusionné dans un module partagé
  (`conversationSession.ts`), relu à chaque tour par les deux canaux.
  Gère aussi les corrections explicites : l'outil `remember` accepte un
  paramètre `replace` (mis à `true` par le modèle quand l'utilisateur
  corrige une info déjà connue, ex: "mon adresse a changé") qui remplace
  le contenu de la note au lieu de s'ajouter à côté
- ✅ Étape 31 — Design sonore : Jaris a sa propre identité sonore, des bips
  courts façon J.A.R.V.I.S. synthétisés à la volée (Web Audio API, aucun
  fichier audio à embarquer) pour l'écoute, la réflexion, un succès, une
  erreur, un clic de souris, un scan d'écran et l'envoi d'un message en Chat
  — en Voix comme en Chat, qui partagent le même mécanisme. Désactivable en
  un clic dans Options → Voix
- ✅ Étape 60 — "Les boutons marchent jamais" en mode Code (Léo) : les
  applications générées qui utilisent `body { height: 100vh; overflow:
  hidden; }` (un motif courant pour une page "plein écran") plaçaient leur
  bouton principal hors de la zone visible du petit aperçu de Jaris, plus
  étroit qu'une vraie fenêtre de navigateur — invisible et incliquable, sans
  moyen de faire défiler pour l'atteindre. Confirmé par un vrai test (pas
  une supposition) avant de corriger. Le générateur interdit maintenant ce
  motif et le détecte automatiquement pour le réparer si le modèle l'utilise
  quand même
- ✅ Étape 61 — Mode Code, "le modèle n'a pas renvoyé de code HTML
  exploitable" à chaque tentative pour "un jeu Snake" (Léo) : le modèle
  répondait en Python/tkinter au lieu de HTML, Snake étant un exemple trop
  classique des tutoriels Python — trouvé grâce à un message d'erreur qui
  montre maintenant la vraie réponse du modèle au lieu de rester générique.
  Le générateur relance désormais automatiquement une fois avec une
  consigne corrective avant d'abandonner, et la consigne de départ cite
  explicitement ce piège (Snake/Tetris/Pong) pour l'éviter dès le début
- ✅ Étape 62 — Le jeu Snake généré en mode Code avait TOUJOURS un bouton
  incliquable après deux correctifs réels (étapes 60 et 61 : overflow
  masqué, puis réponse en Python) — la vraie 3e cause (Codex) : l'aperçu
  héritait de la politique de sécurité (CSP) de la fenêtre principale de
  Jaris, qui bloque les scripts, donc le JavaScript du jeu généré ne
  s'exécutait jamais dans l'aperçu même si le fichier était parfaitement
  valide. Corrigé en servant l'aperçu depuis sa propre origine dédiée, avec
  sa propre CSP et un isolement complet (jamais d'accès à Jaris, au réseau
  ou au stockage) — vérifié par un vrai clic automatisé qui démarre
  effectivement la partie
- ✅ Étape 63 — "Si on relance jarvis, on a plus rien dans le code et
  chat" (Léo) : le Chat repartait toujours d'un écran vide au démarrage
  (choix d'origine), même si le modèle, lui, se souvenait déjà des derniers
  échanges — corrigé en réaffichant la conversation depuis le même fichier
  partagé voix/chat (une seule conversation continue, pas plusieurs fils
  nommés comme sur Claude/ChatGPT). Le mode Code perdait carrément l'accès
  aux applications déjà générées (pourtant bien enregistrées sur le disque)
  — ajout d'un écran "Récents" qui les liste et permet d'en rouvrir une
- ✅ Étape 64 — Léo a remarqué qu'à score "parfait" (6/6, notre test maison
  d'appel d'outils) le départage entre plusieurs candidats du même palier se
  faisait uniquement par taille (le plus gros gagne), et a demandé d'aller
  chercher de vrais benchmarks externes avant de départager ainsi. 6/6 est un
  PLAFOND (test à 6 questions) que plusieurs modèles peuvent atteindre sans
  être aussi capables l'un que l'autre — pas un classement fin. Le départage
  utilise maintenant le score MMLU-Pro publié (`INTELLIGENCE_MMLU_PRO`,
  hardwareScan.ts) quand les DEUX candidats à égalité en ont un connu, la
  VRAM ne restant un repli que si l'un des deux (ou les deux) n'a aucun
  chiffre MMLU-Pro trouvé. Recherché à cette occasion (question de Léo sur
  qwen3.8:27b, 18 Go) : un score MMLU-Pro de 84.3 (source tierce, BenchLM.ai,
  pas la fiche officielle Alibaba) — plus bas que qwen3.5:27b (86.1, 17 Go)
  et qwen3.5:35b (85.3, 24 Go) déjà utilisés. Résultat concret : qwen3.8:27b
  ne devient PAS le nouveau choix du palier Puissant sur cette seule mesure
  (connaissance générale) — aucun chiffre comparatif fiable trouvé côté
  code/agentic, l'axe où les PDF fournis par Léo rapportaient un gain
- ✅ Étape 65 — Léo a fait remarquer que les 3 points fixes de l'écran
  d'accueil (6/12/24 Go, "Petite/Moyenne/Grande configuration") pouvaient
  regrouper sous une même étiquette deux machines qui reçoivent en réalité
  des modèles différents — il a demandé qu'à VRAM égale, tout le monde ait
  garanti le même modèle, avec autant de paliers que nécessaire ("ajoute 10
  palier, mais les 10 palier doivent etre exact pour tout le monde"). Les 3
  points fixes sont remplacés par les VRAIES frontières de VRAM (une par
  modèle candidat déjà benchmarké) : 10 paliers exactement avec les données
  actuelles, comme deviné par Léo — deux machines dans le même palier
  reçoivent maintenant garanti le même modèle, palier par palier
- ✅ Étape 66 — Léo a demandé de revoir tous les modèles candidats (les 5
  listes : Rapide/Médium/Puissant/Vision/Code) pour vérifier qu'aucun
  meilleur choix n'a été manqué. Revue complète sur les sources officielles
  (ollama.com) plutôt qu'un simple coup d'œil : aucune famille majeure
  manquante trouvée (pas de Qwen4 stable publié — juste un aperçu
  d'architecture MLX-only inutilisable ici —, pas de Gemma 5 ni de Granite
  4.3), et deux suggestions d'agrégateurs externes vérifiées puis rejetées
  (un "Qwen3 8B" déjà dépassé par qwen3.5:9b, un "Hermes 4 14B" qui n'existe
  QUE dans des espaces de noms communautaires non officiels sur Ollama,
  jamais publié par Nous Research lui-même). Un vrai correctif trouvé au
  passage : qwen3.6:35b (palier Puissant) avait un poids provisoire
  (24 Go, recopié de qwen3.5:35b faute de mieux) — recalé au vrai poids
  confirmé (23 Go, ollama.com/library/qwen3.6/tags)
- ✅ Étape 68 — Widget "notch" en haut de l'écran : Léo a repéré chez
  VoiceOS un indicateur qui vit en haut au milieu de l'écran, collé au bord
  (façon "notch"/Dynamic Island), toujours disponible sans besoin d'être
  ouvert/fermé, et qui se réduit/disparaît au repos — le widget de Jaris
  était ancré en bas à droite, taille fixe, sans réduction automatique.
  Repositionné en haut au centre, collé au bord haut (`positionWidgetWindow`,
  main.ts) ; replié (juste le petit orbe, 24px) tant que Jaris est au repos
  ('idle'), déplié (orbe 160px + statut + transcript/réponse, comme avant)
  dès que l'émotion change — la vraie fenêtre Electron change de taille en
  direct à chaque évènement `emotion` du pipeline vocal, pas seulement le
  CSS à l'intérieur. Pas d'animation native du redimensionnement de fenêtre
  sur Windows (contrairement à macOS) : accepté comme limite connue plutôt
  que d'ajouter une dépendance d'animation pour ce premier jet. Layout
  vérifié avec le vrai CSS compilé via Playwright (mesure des rectangles
  réels, pas une supposition) : l'orbe replié (24px) tient bien dans la
  fenêtre repliée (84x36) sans débordement, l'orbe déplié (160px) + le texte
  tiennent dans la fenêtre dépliée (320x460) — jamais testé en usage réel
  (pas d'accès Windows dans cet environnement)
