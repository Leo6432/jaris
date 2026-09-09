# Jaris — instructions pour Claude Code

Assistant IA vocal 100% local (Electron + React + TypeScript, LLM via Ollama). Développé pour Léo, seul
utilisateur/testeur — pas d'autres développeurs, pas d'utilisateurs externes à ménager.

Ce fichier est mis à jour à chaque session avec les nouveaux pièges rencontrés — jamais un instantané figé.
Une version équivalente mais générique (pas spécifique à Claude Code) existe dans `AGENTS.md` pour les autres
IA/outils utilisés sur ce dépôt (ex: Codex/ChatGPT, qui ne lit pas `CLAUDE.md`) : garder les deux synchronisés
quand un nouveau piège ou une nouvelle étape de la checklist est ajouté ici.

## À vérifier après CHAQUE changement, avant de le considérer terminé

Dans cet ordre, sans en sauter :

1. `npm run typecheck` — doit passer sans erreur (node ET web).
2. `npm run build` — doit compiler sans erreur (`electron-vite build`).
3. Si un fichier a été supprimé/renommé/déplacé : `grep` tout le dépôt pour toute référence encore
   pendante (imports, IPC channels, préférences oubliées) avant de considérer le nettoyage terminé.
4. Bump de version dans `package.json` :
   - patch (x.y.Z+1) pour un correctif ciblé ;
   - minor (x.Y+1.0) seulement pour un changement d'architecture/de fonctionnalité de grande ampleur.
5. `npm install --package-lock-only` pour resynchroniser `package-lock.json` avec la nouvelle version
   (ou `npm install` complet si des dépendances ont changé).
6. Commit avec un message détaillé en français expliquant le POURQUOI (pas juste le quoi), terminé par :
   ```
   Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
   Claude-Session: <URL de la session>
   ```
7. `git push -u origin claude/jaris-local-ai-assistant-a2drk4` (vérifier avant que `origin` pointe bien
   vers `https://github.com/Leo6432/jaris.git` — a déjà dérivé vers l'ancien nom `jarvis` après redémarrage
   du conteneur).
8. Vérifier que la CI (`Installeur Windows`, `.github/workflows/build-installer.yml`) passe, et que la
   Release GitHub correspondante existe avec son `Jaris-Setup-X.Y.Z.exe`. Un échec CI en `ECONNRESET`/réseau
   sur le téléchargement electron-builder est transitoire : relancer le job (`rerun_failed_jobs`) au lieu de
   re-pousser un nouveau commit.
9. Confirmer à Léo en une ligne courte une fois la Release publiée (ex: "v0.2.4 est publiée."), jamais avant.

Ne JAMAIS annoncer un correctif "terminé" avant l'étape 8 confirmée.

## Pièges déjà rencontrés dans ce projet (pour ne pas les refaire)

- **Une exception dans un outil (`tools.ts`) ou un appel Ollama ne doit jamais remonter telle quelle** sans
  être transformée en message clair pour l'utilisateur : le message générique "vérifie qu'Ollama tourne
  bien" cache la vraie cause (SearXNG/Docker mal configuré, réseau coupé, machine surchargée...). Toujours
  préférer relayer le message d'erreur réel (déjà écrit pour être actionnable dans webSearch.ts/ollama.ts)
  plutôt qu'un message générique.
- **Une vérification purement visuelle (screenshot) ne suffit pas** pour un changement CSS/layout : vérifier
  aussi par un vrai clic Playwright (`page.click()` + `getBoundingClientRect()`) que rien d'autre n'a cassé
  (ex: un conteneur invisible en `position:absolute` qui intercepte des clics ailleurs sur la page).
- **`app.requestSingleInstanceLock()` seul ne suffit pas** : sans un retour explicite en tout début du
  callback `app.whenReady()` quand le verrou n'a pas été obtenu, une instance perdante peut quand même créer
  une fenêtre/démarrer des services avant que son `app.quit()` ne soit vraiment effectif.
- **`app.quit()` ne quitte pas réellement** si le module `quitting` (main.ts) n'est pas mis à `true` avant :
  la fenêtre principale intercepte sa propre fermeture pour se replier en widget par défaut.
- Léo ne peut pas exécuter l'appli lui-même pendant la session (pas d'accès Windows dans cet environnement) :
  tout changement UI/Electron n'est vraiment vérifié qu'une fois qu'il l'a testé en usage réel — rester
  honnête sur ce qui est "vérifié par le build" vs "vérifié en usage réel", ne jamais confondre les deux.
- Éviter les correctifs spéculatifs en rafale sur un même symptôme flou : si la cause exacte n'est pas
  claire, poser une question ciblée à Léo (il n'est pas très technique — préférer des questions à choix
  simples plutôt que demander d'interpréter des logs) plutôt que de deviner et de multiplier les versions.
- **Une tâche longue (`computer_use_task`, jusqu'à 20 allers-retours capture d'écran + clic, chaque étape
  pouvant prendre jusqu'à 45s) doit donner un signe de vie régulier**, sinon elle paraît plantée alors qu'elle
  travaille juste lentement (constaté en usage réel : Léo a cru Jaris bloqué après 3 minutes sans rien voir
  bouger). Toute action qui peut prendre plus de quelques secondes doit annoncer sa progression au fil de
  l'eau (voir `onLog`/`window.jaris.onLog`), pas seulement un indicateur statique du type "Jaris réfléchit…".
- **Vérifier si un mécanisme IPC existe déjà avant d'en ajouter un nouveau** : `window.jaris.onLog` était déjà
  exposé côté preload depuis longtemps mais jamais consommé par aucun composant React — le brancher a suffi,
  pas besoin de créer un nouveau channel.
- Le canal "chat" (texte, sans synthèse vocale) et le canal "voix" (Agent Vocal) partagent exactement les
  mêmes outils (même fonction `converse()`, même tableau `TOOLS`) — seul le `channel` passé à
  `buildSystemPrompt` change le style de réponse autorisé (listes/gras/code OK en chat, jamais en voix car lu
  à voix haute par la synthèse). La progression en direct ajoutée dans `ChatPanel.tsx` est donc chat-only par
  design (pas de transcript équivalent en voix, et narrer chaque étape à voix haute serait pénible) : le mode
  voix garde seulement l'overlay de scan plein écran comme signe visuel pendant une tâche longue.
- **`computer_use_task` (petit modèle de vision local) s'arrête facilement après la PREMIÈRE sous-tâche
  visible d'un objectif à plusieurs actions** ("ouvre YouTube et cherche un tuto guitare" → ouvre YouTube,
  répond "done" sans jamais avoir tapé/lancé la recherche) : le prompt système de la boucle
  (`SYSTEM_PROMPT`, computerUse.ts) doit explicitement interdire de conclure "done" tant que chaque verbe de
  l'objectif n'est pas vérifié un par un — un exemple concret dans le prompt aide plus qu'une règle abstraite.
- **Le modèle de conversation répond parfois par une PROMESSE d'action ("je vais faire X", "un instant",
  "attends") SANS appeler le moindre outil dans ce tour** : comme `message.tool_calls` est vide, la boucle
  d'assistant.ts prenait ce texte pour la réponse finale et s'arrêtait là — rien ne se passait jamais malgré
  l'annonce. Détecter ça sur le LANGAGE DE PROMESSE dans la réponse elle-même (pas sur l'intention de la
  phrase de l'utilisateur, trop spécifique à deviner à l'avance) est plus robuste et généralise mieux que le
  filet `wantsEmailSent`, propre au seul cas du mail.
- **Une capture d'écran réduite pour l'envoyer à un modèle de vision (`MAX_SCREENSHOT_WIDTH`, vision.ts) doit
  toujours renvoyer aussi son facteur d'échelle** : un modèle qui répond en coordonnées pixel sur l'image
  réduite (ex: `computer_use_task`) doit reconvertir ces coordonnées vers l'écran réel avant tout clic, sinon
  chaque clic atterrit au mauvais endroit dès que l'écran dépasse la largeur réduite (repéré par une
  relecture externe du code — Codex/ChatGPT — jamais en usage réel, la plupart des essais de Léo n'étant
  jamais allés jusqu'à un vrai clic).
- **Un mot-clé seul (ex: "mail" pour déclencher une relance corrective) ne suffit pas à détecter une
  intention** : "n'envoie PAS de mail" contient bien "mail"/"envoie" mais l'intention est l'inverse. Vérifier
  l'absence de négation (ne/pas/jamais/évite...) dans une fenêtre de texte autour du mot déclencheur avant de
  pousser une relance qui suppose l'action voulue.
- **Un signal d'annulation (`AbortSignal`) qui s'arrête au premier appel Ollama ne couvre pas les outils qui
  lancent leur propre boucle** (`computer_use_task`) : une fois lancée, une boucle de clics devait aller
  jusqu'à `MAX_STEPS` ou sa fin naturelle, sans pouvoir être interrompue par une nouvelle phrase à la voix.
  Le signal doit être transmis explicitement à `createToolExecutor`/l'outil concerné, pas seulement à l'appel
  de conversation — et combiné (`AbortSignal.any`) avec le timeout déjà en place par étape.
- **Figer des versions de dépendances Python (`requirements.txt`) une par une, en prenant la "dernière" de
  chaque paquet indépendamment, peut choisir des versions incompatibles entre elles** (constaté : la dernière
  version indépendante de librosa et de scipy ne fonctionnaient pas ensemble). Toujours résoudre l'ENSEMBLE
  via `pip install --dry-run --report -` (ou équivalent) et figer le résultat de cette résolution, jamais des
  choix indépendants. Un paquet avec un chemin d'installation particulier (`torch`, installé à part via un
  index CUDA dédié dans `pythonRuntime.ts`) ne doit PAS être figé dans `requirements.txt` : une version figée
  ici pourrait forcer pip à réinstaller une autre version par-dessus celle déjà installée pour de bonnes
  raisons.
- **Pour figer une image Docker `:latest` sur un tag précis**, interroger l'API du registre (ex: Docker Hub
  `/v2/repositories/<image>/tags/latest` pour le digest, puis chercher quel tag nommé partage ce digest)
  plutôt que deviner un numéro de version.
- **Ajouter du streaming à un appel LLM partagé par plusieurs canaux (chat ET voix ici) sans risquer de
  régression** : passer un callback optionnel (`onToken`) qui, quand fourni, bascule l'appel en `stream:
  true` — absent (cas de la voix, qui attend le texte complet avant de le lire), le comportement reste
  rigoureusement identique à avant. Un tour d'appel d'outil ne "raconte" en général rien pendant qu'il
  tourne (content vide, tout est dans tool_calls) : le callback ne reçoit donc du texte visible que sur le
  tour qui répond vraiment, sans logique spéciale à écrire pour distinguer les deux cas.

- **Vérifier qu'un type partagé (`shared/ipc.ts`) n'est pas dupliqué localement dans un autre fichier avant
  de l'étendre** : `hardwareScan.ts` avait sa PROPRE copie locale de `CapacityScanResult` (jamais importée du
  fichier partagé), désynchronisée du vrai type depuis longtemps — ajouter un champ dans `shared/ipc.ts`
  n'avait aucun effet sur les fonctions de ce fichier tant que cette copie locale existait. `grep -rn
  "interface NomDuType"` dans tout le dépôt avant d'ajouter un champ à un type partagé.
- **Le mode Code n'a pas de raison de choisir son modèle différemment des autres paliers** (flash/médium/
  puissant/vision) : le choisir "automatiquement selon ce qui tient sur la machine" plutôt qu'un repli fixe
  sur seulement 2 modèles (qualité si déjà installée, sinon toujours le plus léger) est plus cohérent avec le
  reste de Jaris, à la demande explicite de Léo. Le calcul existait déjà (`computeModelPicks` calculait un
  pick "code" depuis le début) mais son résultat était juste jeté sans être utilisé — vérifier si une valeur
  déjà calculée est réellement exploitée en aval avant de supposer qu'un comportement différent est voulu.
- **Un tableau "illustratif" qui met en évidence la ligne "ta configuration" doit vraiment refléter cette
  configuration, pas le point représentatif fixe le plus proche** : `previewHardwareTiers` (hardwareScan.ts)
  calculait les 3 paliers avec 3 VRAM fixes (6/12/24 Go), y compris la ligne marquée comme correspondant à la
  machine de l'utilisateur — deux machines dans la même tranche (7 Go et 11 Go, toutes deux "Moyenne")
  pouvaient donc voir des modèles différents de ceux réellement choisis pour elles. Repéré par Léo. Corrigé
  en calculant la ligne "current" avec la VRAM RÉELLE détectée plutôt qu'avec le point fixe du palier — les 2
  autres lignes restent de la pure illustration, seule celle qui prétend représenter "ta configuration" doit
  être exacte.
- **Un service démarré une fois par Jaris et qui reste "up" indéfiniment (SearXNG, `docker compose up -d`)
  n'est jamais reconfiguré tout seul si le fichier monté en volume change** (`searxng/settings.yml`) : le
  check `isUp` faisait sortir `ensureSearxngRunning` immédiatement sans jamais vérifier que le conteneur déjà
  lancé fonctionne vraiment comme prévu — un 403 sur le format JSON restait donc bloqué jusqu'à un
  redémarrage MANUEL du conteneur, que Léo n'est pas censé savoir faire lui-même.
  **Premier correctif (v0.3.6) insuffisant, à ne pas refaire** : comparer un hash de settings.yml à un
  marqueur stocké dans userData supposait que la SEULE cause possible était "le process de SearXNG n'a jamais
  relu le fichier depuis qu'il a changé" — un `docker compose restart` suffisait alors. Vécu en usage réel :
  Léo avait toujours le même 403 après cette version. Cause probable plus large (jamais confirmée avec
  certitude faute d'accès à sa machine) : un `restart` relance le PROCESS mais ne retouche jamais à la
  résolution du montage Docker (`volumes:`) fait à la création du conteneur — si ce montage a un jour pointé
  vers autre chose que le vrai `searxng/settings.yml` (dossier auto-créé vide par Docker si le chemin
  n'existait pas encore à la toute première création du conteneur, par exemple), aucun `restart` ne le
  corrige jamais, seule une VRAIE recréation du conteneur le peut. **v0.3.7** a testé directement la vraie
  capacité dont Jaris a besoin (une requête `?format=json` réelle, voir `searxngJsonSearchWorks` dans
  dependencyServices.ts) plutôt que de deviner la cause via des comparaisons de fichiers, et recrée le
  conteneur (`docker compose up -d --force-recreate`, jamais un simple `restart`) si ce test échoue.
  **Léo a confirmé être sur cette version et avoir TOUJOURS le même 403 après ce correctif aussi** — la vraie
  cause reste donc non identifiée avec certitude à ce stade (2 hypothèses fausses déjà écartées : process pas
  redémarré, montage jamais recréé). Ne pas tenter un 3e correctif spéculatif sans données réelles : le
  correctif suivant (voir plus bas, court-circuit de la réponse du modèle sur un échec d'outil) sert
  justement à obtenir enfin le VRAI message d'erreur de SearXNG, verbatim, pour diagnostiquer avec des faits
  plutôt qu'une hypothèse de plus. **Leçon générale : préférer toujours tester le comportement RÉEL observable
  (est-ce que ça marche ?) plutôt que d'inférer un état interne (un fichier a-t-il changé ?) quand la cause
  exacte d'un bug n'est pas confirmée avec certitude** — un correctif basé sur une hypothèse non vérifiée peut
  sembler correct en relecture de code tout en ne réglant rien en usage réel, et l'a effectivement démontré
  deux fois de suite ici.
  **"Cause identifiée" en v0.3.9 : en réalité FAUSSE, corrigée après un 4e échec en usage réel (v0.4.3+).**
  J'avais conclu (v0.3.9) que le corps de la réponse 403 ("You don't have the permission to access the
  requested resource. It is either read-protected or not readable by the server.") était la page d'erreur
  Apache par défaut, donc qu'un AUTRE logiciel occupait le port 8080 — et changé le port vers 8091 sur cette
  base. Léo a eu EXACTEMENT le même 403 après ce correctif (et après le passage à 8091). En vérifiant pour de
  vrai le CODE SOURCE de Werkzeug (la bibliothèque WSGI utilisée par Flask, donc par SearXNG lui-même) plutôt
  que de m'en tenir à une recherche web générique sur "403 forbidden" : ce texte est l'attribut `description`
  EXACT de la classe `Forbidden` de Werkzeug — c'est SearXNG LUI-MÊME qui répond, exactement comme le
  suggérait le tout premier diagnostic (v0.3.6/v0.3.7, jamais confirmé ni infirmé avec certitude à l'époque).
  Le changement de port était donc une fausse piste sans rapport avec le vrai problème (rester au demeurant
  inoffensif, gardé). Corrigé en ajoutant un VRAI diagnostic plutôt qu'une 5e hypothèse : `readSearxngContainerSettings`
  (dependencyServices.ts) lit le settings.yml TEL QUE LE CONTENEUR LE VOIT via `docker compose exec`, inclus
  directement dans le message d'erreur (webSearch.ts) pour enfin comparer un FAIT (ce que le conteneur voit)
  au fichier réel sur le disque, plutôt que de deviner encore. **Leçon générale, renforcée par cet échec** :
  une recherche web généraliste ("qu'est-ce qu'une erreur 403 ?") NE VÉRIFIE RIEN de spécifique — pour
  identifier la source EXACTE d'un texte d'erreur précis, il faut aller consulter le CODE SOURCE réel du
  composant suspecté (ici Werkzeug), jamais des articles génériques qui parlent du sujet en surface. Une
  conclusion présentée avec assurance ("c'est Apache, pas SearXNG") peut être fausse même après une recherche
  qui SEMBLE confirmer la thèse — la revérifier avec la source primaire avant de la communiquer comme un fait
  à l'utilisateur, surtout après avoir déjà été repris une fois sur l'exactitude des affirmations.
- **Une consigne système ("ne jamais inventer de dépannage", buildSystemPrompt) ne suffit pas à empêcher un
  petit modèle local de le faire quand même** : face à un vrai message d'erreur SearXNG (403), le modèle de
  conversation a remplacé le message réel par un dépannage générique halluciné et FAUX (étapes nginx/
  .htaccess/journaux qui n'existent pas dans l'installation de Jaris) — constaté en usage réel malgré la
  consigne explicite déjà en place. Corrigé en COURT-CIRCUITANT le modèle plutôt qu'en renforçant encore la
  consigne (déjà démontrée insuffisante) : dès qu'un appel d'outil échoue (`Échec de l'outil :`, assistant.ts),
  la réponse finale est le message d'erreur lui-même, jamais reformulé par un nouvel appel au modèle — même
  logique que le court-circuit déjà existant pour `look_at_screen`. Les messages d'erreur (webSearch.ts etc.)
  doivent donc être rédigés directement pour un lecteur humain non technique, plus jamais en supposant qu'un
  modèle les reformulera avant affichage. **Leçon générale : quand une consigne "ne fais pas X" échoue en
  usage réel face à un petit modèle, la bonne réponse est souvent de rendre X impossible dans le code plutôt
  que de reformuler la consigne une fois de plus.**
- **Une automatisation "propre" mais laissée à côté d'un menu déroulant manuel n'est qu'à moitié faite** : la
  première version de la sélection automatique du modèle Code (ci-dessus) gardait un réglage manuel dans
  Options par prudence, alors qu'aucun autre palier (flash/médium/puissant/vision) n'en a — Léo l'a repéré
  immédiatement ("pourquoi mettre un menu déroulant, et pas directement mettre les meilleurs modèles... comme
  vision"). Corrigé en retirant le menu déroulant et en lisant directement `profile.codeModel` (calculé et
  enregistré par `runQuickSetup`/l'analyse comparative), exactement comme `profile.visionModel` est déjà lu
  dans `assistant.ts` — jamais recalculé "en direct" à chaque génération. Une fois qu'un calcul reproduit
  fidèlement le comportement d'un mécanisme existant, aligner aussi l'INTERFACE sur ce mécanisme, pas
  seulement la logique interne.
- **Le mode vocal (mot d'activation) écoutait en continu quel que soit l'onglet actif** (Agent vocal/Chat/
  Code, App.tsx) : passer en Chat ou Code pour écrire n'empêchait pas Jaris de réagir à la voix par-dessus, à
  la demande explicite de Léo ("faut pas que jarvis s'active ou puisse être utilisé" pendant Chat/Code).
  Corrigé par un drapeau `suspended` dans `VoicePipeline` (electron/services/voicePipeline.ts) qui fait
  ignorer les évènements 'wake'/'transcript' déjà reçus, plutôt que d'arrêter/relancer tout le sidecar Python
  à chaque changement d'onglet (lent, inutile) — piloté par un nouveau canal IPC `setActiveMode` envoyé par
  App.tsx à chaque changement de `appMode`. Piège identifié en l'écrivant : la fenêtre de réglages n'est
  JAMAIS détruite en se repliant en widget (juste `win.hide()`), donc son état React (`appMode`) reste figé
  sur Chat/Code même après le repli — sans un `setListeningSuspended(false)` forcé côté main.ts sur les
  évènements 'close'/'minimize' de cette fenêtre (avant même de savoir ce que pense le renderer), l'écoute
  vocale serait restée bloquée indéfiniment dès qu'on repliait la fenêtre depuis Chat/Code, pour un
  utilisateur qui ne voit plus que le widget (symbole du mode vocal) et n'a aucune raison de deviner pourquoi
  Jaris ne réagit plus à sa voix.
- **Un budget de fenêtre de contexte (`OLLAMA_NUM_CTX`) choisi une fois n'est jamais revu quand le système
  prompt/la liste d'outils grossissent** : figé à 4096 depuis le début (choix volontaire pour tenir en VRAM),
  jamais réévalué malgré l'ajout progressif de nombreux outils et consignes système au fil des versions —
  mesuré pour de vrai cette session : le système prompt (`buildSystemPrompt`) + `TOOLS` (tools.ts) consomment
  déjà à eux seuls environ 4200-4500 tokens, AVANT même le premier message de l'utilisateur. Sur le plus
  petit modèle du palier Rapide (qwen3.5:0.8b, choisi sur les machines à faible VRAM), ça ne laissait
  quasiment plus de budget pour une vraie réponse — "Réponse vide d'Ollama" constaté en usage réel par Léo.
  Corrigé en doublant la valeur par défaut (4096 -> 8192, `config.ts`/`.env.example`) : le coût VRAM
  supplémentaire (cache K/V) est négligeable comparé au poids du modèle, surtout pour les petits modèles
  justement les plus concernés. **Leçon générale : un budget fixe basé sur "ce qu'on utilise aujourd'hui"
  doit être revu chaque fois que ce qu'on empile dedans (prompt système, outils...) grossit significativement
  — mesurer pour de vrai (compter les caractères/tokens réels) plutôt que de supposer qu'une valeur choisie
  il y a plusieurs versions est toujours valable.**
- **Docker Desktop n'est PAS auto-installé comme Ollama** (choix volontaire, jusqu'à ce que Léo demande le
  contraire) : `ensureSearxngRunning` (dependencyServices.ts) ne fait que LANCER Docker Desktop s'il est déjà
  installé — vécu par Léo sur une machine sans Docker du tout ("je croyais qu'en installant Jaris ça installe
  Ollama ET Docker Desktop automatiquement"), une confusion légitime vu qu'Ollama, lui, s'installe déjà tout
  seul. Corrigé en ajoutant `installDockerDesktop` (dependencyServices.ts), déclenché quand `openApp('Docker
  Desktop')` répond "aucune application nommée..." (pas juste "pas encore lancé"). **Différence assumée avec
  installOllamaSilently** : PAS silencieux comme Ollama, à la demande explicite de Léo — activer la
  virtualisation nécessaire à Docker Desktop demande une élévation Windows (UAC) qu'aucun indicateur ne peut
  contourner, donc l'utilisateur voit de toute façon une fenêtre Windows lui demander une autorisation ; cette
  fenêtre sert l'accord explicite demandé, pas la peine d'en ajouter une autre côté Jaris. Jamais de
  redémarrage forcé à la place de l'utilisateur (action difficile à annuler) : si Docker ne répond toujours
  pas après l'installation, le message suggère juste qu'un redémarrage Windows est PROBABLEMENT nécessaire
  (vérifié sur docs.docker.com AVANT d'écrire cette fonction : Docker Desktop ne documente PAS ses codes de
  sortie, contrairement à la convention Windows Installer standard — donc jamais affirmer "il faut redémarrer"
  comme un fait déduit d'un code de sortie précis, seulement une piste probable). Taille de l'installeur
  vérifiée pour de vrai (requête HEAD, ~600 Mo) avant de choisir un délai de téléchargement (10 minutes, pas
  les 2 minutes utilisées pour Ollama dont l'installeur est bien plus léger) : un délai trop court aurait
  coupé un téléchargement en pleine réussite sur une connexion modeste, faisant croire à un échec à tort.
- **Le détecteur `PROMISE_WITHOUT_ACTION` (assistant.ts, v0.2.8) était trop étroit** : limité au seul motif
  "je vais (le/la/les )?faire", il ratait toute promesse formulée avec un autre verbe — constaté en usage
  réel (Léo, question sur le président américain) : le modèle a promis "je vais RECHERCHER pour vous..."
  sans jamais appeler `search_web`, et cette phrase ne matchait pas le motif d'origine. Vérifié avec un vrai
  test du regex sur le texte exact avant de corriger (`current regex matches: false`) plutôt que de supposer
  la cause. Corrigé en généralisant à "je vais " + un pronom optionnel (le/la/les/lui/y/en) + un verbe (mot
  se terminant par -er/-ir/-re, les 3 terminaisons d'infinitif du français) — couvre "je vais chercher/
  envoyer/vérifier/regarder/etc." sans connaître le verbe à l'avance, tout en restant sans faux positif sur
  "je vais bien" (bien/très ne se terminent pas en -er/-ir/-re, vérifié par test avant d'adopter le motif).
  **Leçon générale : un détecteur basé sur un mot-clé précis (ici "faire") généralise mal** — dès que c'est
  possible, détecter le PATRON GRAMMATICAL (ici : verbe au futur proche) plutôt qu'un mot précis évite de
  devoir rajouter chaque nouveau verbe rencontré un par un à mesure qu'on les découvre en usage réel.
- **Installer Docker Desktop tout seul (v0.4.0) ne suffisait pas : WSL, son prérequis sur Windows, manque
  silencieusement sur une machine qui ne l'a jamais eu** — vécu en usage réel par Léo dans la FOULÉE du
  correctif précédent : Docker Desktop installé avec succès par Jaris, mais bloqué au démarrage derrière sa
  propre erreur "WSL not installed", lui demandant de lancer `wsl --install` à la main. Bug de PLACEMENT du
  check, pas de logique : le premier ajout ne vérifiait WSL qu'à L'INTÉRIEUR de la branche "Docker Desktop pas
  installé du tout" — jamais atteinte une fois Docker Desktop déjà présent (le cas de Léo dès le lancement
  suivant), donc jamais réellement exécuté pour lui. Corrigé en déplaçant le check WSL tout en haut, AVANT
  même de toucher à Docker Desktop, que celui-ci soit déjà installé ou non : WSL est un prérequis pour que
  Docker Desktop FONCTIONNE sur Windows, pas seulement pour l'installer. Installé de la même manière que
  Docker Desktop (élévation Windows via PowerShell `Start-Process -Verb RunAs`, jamais de redémarrage forcé —
  vérifié sur learn.microsoft.com/windows/wsl/install qu'un redémarrage est TOUJOURS requis après un premier
  `wsl --install`, contrairement aux codes de sortie non documentés de Docker Desktop). **Leçon générale :
  quand une vérification/installation automatique est ajoutée dans UNE branche précise d'un flux à plusieurs
  chemins, vérifier qu'elle reste atteignable une fois que l'état qui a déclenché cette branche a changé** —
  un correctif qui marche pour le premier lancement peut devenir invisible dès le lancement suivant si son
  placement suppose à tort que les deux lancements prennent le même chemin.

- **Un ancien échec d'outil dans l'historique peut être recopié SANS nouvel appel d'outil** : reproduit avec
  qwen3.5:4b, qui annonçait encore un 403 alors que la recherche JSON réelle répondait 200. Le message
  provenait d'une ancienne version et n'existait même plus dans le programme installé. Comparer le code
  embarqué, l'historique et les appels réellement exécutés avant d'accuser de nouveau le service externe.
  Exclure les échanges en échec du contexte envoyé au modèle dans `converse()`, sans effacer l'historique
  visible ni masquer les vrais échecs du tour actuel. Régression : `node --test scripts/test-assistant-history.mjs`.
- **Deux copies indépendantes du même historique court terme (voix et chat) se désynchronisent** : avant
  l'étape 47, `voicePipeline.ts` et `chatSession.ts` avaient chacun leur propre `history` chargée séparément
  au premier usage de chaque canal — les deux écrivaient bien dans le même `conversation-history.json`, mais
  passer de l'un à l'autre en pleine conversation ne voyait pas forcément le tout dernier échange dit sur
  l'autre canal. Corrigé en extrayant la logique commune dans un nouveau module partagé
  (`conversationSession.ts`, un seul état au niveau du module, pas une classe par canal) que les deux fichiers
  relisent à chaque tour (`getSessionHistory()`) au lieu de garder leur propre copie. **Leçon générale : avant
  de dupliquer un état "juste pour ce fichier", vérifier si un autre fichier du dépôt a déjà exactement la
  même donnée en copie séparée** — la dupliquer plus loin aggrave la désynchronisation au lieu de la
  corriger.
- **Une mémoire markdown qui n'ajoute JAMAIS ne peut pas représenter une correction** : `rememberNote`
  ajoutait toujours un nouvel horodatage à la suite du contenu existant, donc corriger une info ("mon adresse
  a changé") laissait l'ancienne et la nouvelle valeur côte à côte dans la même note, sans façon fiable de
  savoir laquelle est encore valable en la relisant. Corrigé (étape 47) par un paramètre `replace` optionnel
  (défaut `false`, comportement identique à avant) qui, à `true`, réécrit la note avec UNIQUEMENT le nouveau
  contenu. Le modèle décide lui-même quand le mettre à `true` (nouvelle instruction dans le prompt système de
  `assistant.ts` pour une correction dite en pleine conversation, et dans celui de `memoryExtractor.ts` pour
  l'extraction automatique en arrière-plan) — sans cette instruction explicite dans LES DEUX prompts (la
  conversation live ET l'extraction silencieuse utilisent chacune leur propre appel au modèle), le paramètre
  existerait dans l'outil sans jamais être utilisé.
- **Un évènement broadcast aux deux fenêtres (widget + réglages, jamais détruites, juste cachées) se joue
  deux fois si le renderer ne filtre pas lui-même** : le design sonore (étape 31, `IPC_CHANNELS.soundCue`)
  utilise le même `broadcast()` que `emotion`/`log`, qui envoie à `[fullWindow, widgetWindow]` sans savoir
  laquelle est réellement affichée. Sans un garde côté renderer, les DEUX fenêtres auraient joué le bip en
  même temps dès que les deux existent (widget caché derrière la fenêtre de réglages, par ex.) — corrigé en
  ne jouant le son QUE si `document.visibilityState === 'visible'` dans le renderer qui reçoit l'évènement
  (App.tsx), pas en changeant `broadcast()` lui-même (déjà utilisé tel quel par d'autres évènements qui, eux,
  ont besoin d'atteindre une fenêtre cachée — voir le repli sur `audioRef.current` pour `onReply` un peu plus
  haut dans ce même fichier : deux évènements différents peuvent légitimement vouloir deux stratégies de
  filtrage différentes, pas de solution unique à copier partout sans réfléchir à CE cas précis).
- **Un conteneur CSS en `pointer-events: none` (pour laisser cliquer au travers d'un grand bloc `position:
  absolute; inset: 0` par ailleurs vide) désactive aussi les clics sur tout nouvel élément interactif ajouté
  dedans, silencieusement** : `.options-menu__voice-picker` (OptionsMenu.tsx, onglet Voix) n'autorisait le
  clic QUE sur ses `button` (`pointer-events: auto` ciblé), un choix qui datait d'avant l'ajout d'une case à
  cocher (étape 31, "Bips d'interface") — un `<label><input type="checkbox">` n'est pas un `button`, donc
  sans étendre cette règle explicitement à `.options-menu__checkbox`, la case aurait été visible mais
  totalement incliquable. Repéré en écrivant le CSS, pas en testant dans un vrai navigateur (aucun accès
  Windows cette session) : toujours vérifier les règles `pointer-events`/`inset` déjà en place sur un
  conteneur avant d'y ajouter un nouvel élément interactif, jamais supposer qu'un enfant hérite du
  comportement de clic normal.

- **Une boucle de pilotage peut scanner sans agir si une action JSON inconnue est acceptée** :
  `extractStep()` ne vérifiait que la présence du champ `action`, puis le `switch` ignorait les valeurs
  inconnues. Reproduit par test : 20 captures, zéro clic. Valider les actions et leurs arguments avant
  exécution ; vérifier aussi le résultat des helpers clavier/souris, qui renvoient leurs erreurs en texte.
  Un échec de `computer_use_task` doit lever une erreur pour activer le court-circuit de `assistant.ts`,
  sinon le modèle peut le reformuler ou relancer la même tâche. Les attentes répétées doivent être bornées.
  Ce garde-fou fournit un diagnostic, il ne prouve pas à lui seul pourquoi une tâche réelle YouTube échoue.
  Les logs intermédiaires du Chat ne sont pas lus à voix haute pendant une tâche vocale.

## Commandes utiles

```
npm run typecheck   # tsc, node + web, sans build complet
npm run build       # electron-vite build (rapide, sans générer l'installeur)
npm run dist        # build complet + installeur .exe (long, normalement laissé à la CI)
```

`docker-compose.yml` + `searxng/settings.yml` : recherche web locale (SearXNG). Nécessite Docker Desktop
lancé ; `searxng/settings.yml` n'est relu par SearXNG qu'au démarrage du conteneur — un changement de config
nécessite `docker compose restart`, pas seulement `docker compose up -d`.
