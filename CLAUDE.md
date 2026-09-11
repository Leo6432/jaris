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
- **Un cue sonore déclenché par une action LOCALE au renderer n'a pas besoin de repasser par le
  main process** : les cues d'écoute/réflexion/succès/échec/clic/scan (étape 31) viennent tous d'un
  évènement backend (émotion vocale, appel d'outil) diffusé par `broadcast()` puis rejoué côté renderer
  (`onSoundCue`, App.tsx). Le son "envoi de message" en Chat, lui, réagit au clic sur Envoyer/Entrée DANS
  cette même fenêtre : le copier sur le même circuit IPC (main -> renderer) aurait juste ajouté un
  aller-retour inutile pour un son censé être instantané. Ajouté à la place `playSoundCueIfEnabled`
  (soundDesign.ts, factorise la vérification du réglage `soundEffectsEnabled`) appelé directement depuis
  `ChatPanel.tsx`. **Leçon générale : ne pas copier le circuit d'un mécanisme existant par réflexe** —
  vérifier d'abord si l'évènement à jouer est déjà disponible localement avant de le faire transiter par
  le main process comme les cas précédents.

- **Une boucle de pilotage peut scanner sans agir si une action JSON inconnue est acceptée** :
  `extractStep()` ne vérifiait que la présence du champ `action`, puis le `switch` ignorait les valeurs
  inconnues. Reproduit par test : 20 captures, zéro clic. Valider les actions et leurs arguments avant
  exécution ; vérifier aussi le résultat des helpers clavier/souris, qui renvoient leurs erreurs en texte.
  Un échec de `computer_use_task` doit lever une erreur pour activer le court-circuit de `assistant.ts`,
  sinon le modèle peut le reformuler ou relancer la même tâche. Les attentes répétées doivent être bornées.
  Ce garde-fou fournit un diagnostic, il ne prouve pas à lui seul pourquoi une tâche réelle YouTube échoue.
  Les logs intermédiaires du Chat ne sont pas lus à voix haute pendant une tâche vocale.

- **"Les boutons marchent jamais" en mode Code (Léo) : le vrai bug n'était NI dans le HTML/JS généré, NI
  dans le mécanisme d'aperçu (iframe `sandbox="allow-scripts"`, testé sain à part)** — c'était une
  interaction entre les deux. Un motif CSS très courant pour une page "plein écran" générée par le modèle
  (`body { height: 100vh; overflow: hidden; }`, vu tel quel dans un Snake généré) suppose une fenêtre de
  navigateur classique ; l'aperçu de Jaris (`.code-panel__preview`, CodePanel.tsx) est un iframe BEAUCOUP
  plus petit (contraint par le compositeur/la barre de statut/l'indice au-dessus et en dessous). Tout
  contenu qui dépasse cette hauteur réduite (ici le bouton "Jouer"/"Rejouer", en bas de page) devient
  invisible ET incliquable, sans le moindre moyen de faire défiler pour l'atteindre (`overflow: hidden`
  empêche justement ça) — d'où "rien du tout ne se passe" au clic, confirmé par Léo (AskUserQuestion : il
  cliquait bien DANS l'aperçu de Jaris). **Diagnostic vérifié pour de vrai avant tout correctif** : un test
  Playwright avec le VRAI CSS compilé (`out/renderer/assets/index-*.css`) et un clic bas niveau aux
  coordonnées ÉCRAN réelles du bouton (position de l'iframe + position du bouton DANS l'iframe, pas
  `frame.click()` qui cible l'élément directement sans passer par le vrai rendu) a confirmé que le bouton
  tombe hors de la zone visible de l'iframe — jamais deviné, contrairement à la saga SearXNG plus haut.
  Corrigé à la source (`APP_RULES`, codeGenerator.ts) : nouvelle consigne interdisant `overflow: hidden` +
  hauteur fixe (100vh/100%) sur `<html>`/`<body>`, ET un contrôle mécanique dans `validateGeneratedHtml`
  (même mécanisme déjà là pour les classes fantômes/ressources externes/JS hors `<script>`) qui détecte ce
  motif et déclenche la passe de réparation. **Piège dans le correctif lui-même, attrapé par le test AVANT
  de le considérer terminé** : la première version du contrôle cherchait `selector { déclarations }` sur le
  HTML ENTIER, mais pour la toute PREMIÈRE règle CSS du fichier, la capture du "sélecteur" (`[^{}]+`, qui
  remonte jusqu'à la dernière accolade rencontrée) avalait tout le HTML précédent — `<!DOCTYPE
  html><html><head><style>` contient lui-même le mot "html", donc CHAQUE fichier généré aurait déclenché un
  faux positif dès sa première règle CSS. Corrigé en isolant d'abord le contenu des balises `<style>` avant
  d'y chercher des règles html/body. Régression : `node --test scripts/test-codegen-validate.mjs`. **Leçon
  générale : un correctif "évident" doit quand même être testé avec des cas limites simples (ici : le tout
  premier cas réel, la page générée elle-même) avant d'être considéré fiable** — la relecture seule n'aurait
  pas forcément repéré ce faux positif.
- **"Le modèle n'a pas renvoyé de code HTML exploitable" (mode Code) : message générique qui ne disait RIEN
  de ce que le modèle a répondu à la place** — Léo a rencontré ce message à chaque tentative pour "un jeu
  Snake" (nouvelle application, pas une modification). Un premier correctif a d'abord ajouté un extrait
  (300 caractères) de la vraie réponse dans le message d'erreur (même logique que pour un outil qui échoue,
  assistant.ts/webSearch.ts : ne jamais laisser un message générique remplacer les faits) plutôt que de
  deviner la cause sans données — leçon directement tirée de la saga SearXNG plus haut. **Cause réelle
  révélée par ce diagnostic dès la première relance de Léo** : le modèle avait répondu en PYTHON/tkinter
  (`import tkinter as tk`, `class SnakeGame`...), malgré la consigne système explicite de ne produire QUE du
  HTML — Snake est un exemple tellement classique des tutoriels Python que le modèle a suivi ce réflexe
  d'entraînement au lieu de la consigne. Corrigé en deux temps : (1) `APP_RULES` nomme maintenant EXPLICITEMENT
  ce cas (Snake/Tetris/Pong en Python/tkinter/pygame) comme exemple concret à éviter — un exemple nommé
  généralise mieux qu'une règle abstraite ("HTML uniquement"), même leçon que le prompt `computer_use_task`
  plus haut ; (2) `generateApp` relance UNE fois automatiquement avec une consigne corrective qui cite le
  langage fautif détecté (même mécanisme que `nudgedForEmail`/`nudgedForPromise` dans assistant.ts) avant
  d'abandonner avec le message détaillé. Régression : `node --test scripts/test-codegen-generate.mjs`.

- **Une iframe `srcDoc` hérite de la CSP du document Jaris** : `script-src 'self'` bloquait le JavaScript
  inline d'un jeu pourtant fonctionnel dans le navigateur. Reproduit avec un vrai clic sur Jouer : bouton
  atteint mais script bloqué par CSP. Servir l'aperçu via une origine dédiée `jaris-preview:` avec sa propre
  CSP et `sandbox allow-scripts`, sans `allow-same-origin`, plutôt qu'assouplir les scripts de la fenêtre
  principale. Le protocole ne sert que du HTML enregistré en mémoire, jamais un chemin de fichier fourni
  par l'URL. Vérifier clic Jouer, clavier, clic extérieur, accès parent/réseau refusés et CSP parent conservée.
- **"Si on relance jarvis, on a plus rien dans le code et chat" (Léo)** : deux causes DISTINCTES, dans deux
  fichiers séparés, pour le même symptôme apparent.
  - Chat : `ChatSession.visible` (chatSession.ts) démarrait TOUJOURS vide au lancement, par choix explicite
    ("vide au premier lancement : on n'y remet pas l'historique vocal", commentaire d'origine) — alors que
    `conversationSession.ts` (le contexte envoyé au MODÈLE) chargeait déjà son propre historique depuis
    `conversation-history.json` au démarrage. Résultat : le modèle "se souvenait" des derniers échanges,
    mais l'écran du Chat les affichait comme s'ils n'avaient jamais existé. Corrigé en amorçant `visible`
    depuis ce même fichier partagé (voix + chat, étape 47) au premier appel de `getVisibleMessages()`/`send()`
    — même pattern `ensureLoaded()` que `conversationSession.ts`. Jaris n'a PAS plusieurs fils de discussion
    nommés façon Claude/ChatGPT (une seule conversation continue, à dessein depuis l'étape 47) : rouvrir
    Chat après un redémarrage montre la SUITE de cette conversation, y compris ce qui a été dit à voix haute
    entre-temps — pas une liste de conversations séparées à choisir.
  - Code : chaque génération est bien enregistrée sur le disque
    (`generated-apps/<horodatage>-<slug>/index.html`), mais rien n'exposait cette liste au renderer —
    `CodePanel.tsx` repartait d'un écran vide à chaque lancement même si les fichiers existaient toujours.
    Corrigé en ajoutant `listGeneratedApps()`/`loadGeneratedApp()` (codeGenerator.ts, lisent le dossier et un
    fichier `index.html` donné) + deux canaux IPC, et un écran "Récents" dans CodePanel.tsx (visible tant
    qu'aucune application n'est chargée) qui recharge une ancienne génération avec une NOUVELLE URL d'aperçu
    isolée (`createGeneratedAppPreview`, voir l'entrée CSP juste au-dessus) plutôt que de réutiliser
    l'ancienne, qui ne survit pas à un redémarrage (Map en mémoire). **Leçon générale : un symptôme identique
    rapporté sur deux fonctionnalités différentes ("le chat ET le code") n'a pas forcément une seule cause
    commune** — vérifier chaque mécanisme séparément (ici : un flux "affichage" jamais amorcé vs. un flux
    "liste" jamais exposé) au lieu de chercher un correctif unique qui expliquerait les deux à la fois.
    Régression : `node --test scripts/test-chat-session-restore.mjs scripts/test-codegen-recents.mjs`.
- **Un score "parfait" (6/6, notre test maison d'appel d'outils) sur PLUSIEURS candidats d'un même palier ne
  veut pas dire qu'ils sont aussi capables les uns que les autres** — c'est un PLAFOND (6 questions), pas un
  classement fin. `pickBestFrom` (computeModelPicks, hardwareScan.ts) départageait jusqu'ici ces égalités
  UNIQUEMENT par VRAM (le plus gros gagne) : repéré par Léo, qui a demandé d'aller chercher de vrais
  benchmarks externes avant de départager ainsi ("tu vas regarder sur internet les benchmark si plusieurs
  model sont 6/6 pour déssider"). Corrigé en utilisant le score MMLU-Pro publié (`INTELLIGENCE_MMLU_PRO`) en
  PREMIER quand les DEUX candidats à égalité en ont un connu, la VRAM ne restant un repli que si l'un des
  deux (ou les deux) n'a aucun chiffre MMLU-Pro trouvé — la plupart des départages continuent donc de se
  faire par taille, faute de couverture large de cette table. Recherché à cette occasion (question de Léo sur
  qwen3.8:27b, 18 Go, censé succéder à qwen3.5:27b d'après des PDF externes qu'il avait fournis) : un chiffre
  MMLU-Pro de 84.3 trouvé via BenchLM.ai (agrégateur TIERS, pas la fiche officielle Alibaba — toujours flaguer
  la source d'un chiffre externe non officiel dans ce fichier) — DÉLIBÉRÉMENT plus bas que qwen3.5:27b (86.1)
  et qwen3.5:35b (85.3) déjà utilisés. **Résultat concret assumé et annoncé tel quel à Léo** : qwen3.8:27b ne
  devient donc PAS le nouveau choix sur cette seule mesure (connaissance générale) — aucun chiffre comparatif
  fiable trouvé côté code/agentic, l'axe où ses PDF rapportaient un gain ; le départage est plus justifié
  qu'avant, mais ne change pas le résultat pour ce cas précis tant qu'une meilleure donnée n'est pas trouvée.
  Régression (mock fs/child_process/systemResources, pas de vraie machine) :
  `node --test scripts/test-hardwarescan-tiebreak.mjs`.
- **`previewHardwareTiers` (3 points fixes 6/12/24 Go, "Petite/Moyenne/Grande") masquait de vraies différences
  entre machines de la même tranche** : Léo a fait remarquer que deux machines dans la même tranche "Moyenne"
  peuvent recevoir des modèles différents (une frontière réelle de pickBestFrom peut tomber ENTRE elles),
  malgré l'étiquette identique — demande initiale mal comprise d'abord comme "mets un minimum de 30 Go" (aurait
  cassé le palier Médium, donc TOUS les appels d'outils, sur sa propre machine ~8 Go de VRAM — confirmé avant
  d'implémenter quoi que ce soit), puis clarifiée en "ajoute 10 palier, mais les 10 palier doivent etre exact
  pour tout le monde". Remplacé les 3 points fixes par les VRAIES frontières de VRAM (une par candidat
  benchmarké de FLASH/MEDIUM/LARGE_CANDIDATES, convertie du poids du modèle vers la VRAM TOTALE minimale
  requise via `+STT_RESERVED_GB` et, pour les candidats "Puissant" qui tolèrent la RAM, `-ramOffloadAllowance`)
  — `previewVramSteps`, hardwareScan.ts. Résultat : 10 paliers exactement sur les données actuelles, comme
  deviné par Léo. **PAS un retour à la tentative "3 paliers matériels stricts" déjà essayée et abandonnée**
  (voir l'entrée plus haut sur previewHardwareTiers) : cette tentative calculait un SEUL budget combiné pour
  les 3 rôles à la fois, ce qui laissait le débordement RAM de "Puissant" gonfler à tort le palier "Rapide" —
  ici, Rapide/Médium/Puissant restent calculés séparément avec leur propre formule de budget, seul le nombre
  et le choix des points représentatifs change. Vérifié avant de livrer que ça ne casse rien sur la machine de
  Léo (RTX 3070, ~8 Go VRAM, budget simulé avec 32 Go de RAM) : Médium atterrit sur `qwen3.5:4b` (palier 7,9
  Go), toujours un modèle qui appelle des outils — pas d'"indisponible" comme redouté un temps avec une autre
  approche écartée en cours de route (repli sur le palier du dessous, refusé par Léo pour rester "exact").
  **Piège dans mon propre calcul, attrapé par mon propre test avant de livrer** : `candidate.vramGb` est le
  poids DU MODÈLE, pas la VRAM totale de la machine — utiliser cette valeur brute comme seuil de palier aurait
  affiché des seuils totalement faux (ex: un palier "3,4 Go" pour un modèle qui a en réalité besoin de 7,9 Go
  de VRAM totale une fois la réservation STT ajoutée). **Piège dans le TEST lui-même, attrapé en débogant un
  résultat inattendu** : le mock `child_process.exec` (déjà utilisé par test-hardwarescan-tiebreak.mjs,
  corrigé au passage) n'avait pas la marque `[util.promisify.custom]` que le VRAI `child_process.exec` de Node
  pose sur lui-même — sans elle, `promisify(exec)` résout vers un TABLEAU positionnel `[stdout, stderr]` au
  lieu de l'objet `{stdout, stderr}` attendu par `detectGpu()`, qui retombe alors silencieusement (son propre
  try/catch) sur VRAM/GPU `null` en ignorant complètement la valeur simulée — le test passait quand même par
  coïncidence (repli RAM offload) sans jamais exercer la détection VRAM qu'il prétendait simuler. **Leçon
  générale : quand un mock remplace une fonction Node normalement promisifiée nativement (exec, readFile...),
  reproduire aussi sa marque `[util.promisify.custom]` — sinon `promisify()` change silencieusement de forme
  de résultat sans la moindre erreur visible.** Régression :
  `node --test scripts/test-hardwarescan-preview-steps.mjs`.
- **`gemma4:26b` (palier Puissant, LARGE_CANDIDATES) manquait de VISION_CANDIDATES** alors que ses petits
  frères de la même famille (`gemma4:e4b`, `gemma4:12b`) y sont déjà en "réutilisation" — signalé par Léo
  ("c'est un des meilleurs en vision"), vérifié directement sur ollama.com/library/gemma4 (tag `gemma4:26b` :
  badge "Text, Image" confirmé, pas juste une affirmation à prendre pour argent comptant) avant de l'ajouter.
  Toujours vérifier le tag EXACT sur la page officielle plutôt que de faire confiance à un nom approximatif
  ("gemma-4-26b-a4b") — le nom réel dans Ollama est `gemma4:26b` (le "a4b"/"4B actifs" correspond au nombre de
  paramètres actifs du MoE, déjà documenté dans le commentaire LARGE_CANDIDATES, pas un tag Ollama à part).
- **Revue complète des 5 listes de candidats (Rapide/Médium/Puissant/Vision/Code), demande explicite de Léo
  ("revoire tous les model pour des meilleurs")** — détail complet en commentaire juste après CODE_CANDIDATES
  dans hardwareScan.ts. Résumé : aucune famille majeure manquante (pas de Qwen4 stable, pas de Gemma 5, pas
  de Granite 4.3 — vérifié directement sur les sources officielles, pas sur un simple titre d'article).
  **Deux suggestions d'agrégateurs externes vérifiées puis REJETÉES**, même discipline que d'habitude dans ce
  fichier (ne jamais prendre une affirmation externe pour argent comptant) : "Qwen3 8B" (sans le ".5",
  génération dépassée par qwen3.5:9b déjà candidat) et "Hermes 4 14B" (recherche sur ollama.com/search?q=
  hermes : n'existe QUE dans des espaces de noms communautaires non officiels — ericli1018, steelpuddles,
  MonomythDevelopment... — jamais publié par le fabricant d'origine, Nous Research, qui n'a que Hermes 3 sur
  Ollama). **Vrai correctif trouvé au passage** : `qwen3.6:35b` avait un poids PROVISOIRE (24 Go, recopié de
  qwen3.5:35b faute de mieux, déjà signalé comme "à recaler" dans son propre commentaire) — recalé au vrai
  poids confirmé sur ollama.com/library/qwen3.6/tags (23 Go).
- **Widget "notch" (étape 68)** : le widget flottant (main.ts, `createWidgetWindow`/`positionWidgetWindow`)
  était ancré en bas à droite depuis l'étape 19, taille fixe. Repositionné en haut au centre, collé au bord
  haut, avec deux tailles de fenêtre (`WIDGET_COLLAPSED_WIDTH/HEIGHT` au repos, `WIDGET_WIDTH/HEIGHT`
  déplié) — `positionWidgetWindow` prend maintenant un paramètre `expanded`, rappelée à chaque évènement
  `emotion` du pipeline vocal (`pipeline.on('emotion', ...)`) pour agrandir/replier la VRAIE fenêtre Electron
  en direct, pas seulement changer le CSS affiché à l'intérieur d'une fenêtre de taille fixe. **Piège
  identifié avant de coder, pas après** : l'ancien widget (320x520 en bas à droite) n'a jamais eu besoin de
  `setIgnoreMouseEvents` car une fenêtre transparente Electron bloque quand même les clics sur toute sa zone
  rectangulaire, même invisible — acceptable dans un coin d'écran peu utilisé, mais la même taille plaquée en
  HAUT AU CENTRE aurait bloqué une zone bien plus gênante (barres de titre/onglets d'autres applis). D'où les
  DEUX tailles de fenêtre plutôt qu'une seule fenêtre fixe avec du CSS qui cache visuellement le surplus : au
  repos, la fenêtre elle-même est minuscule (84x36), donc son emprise sur les clics reste minime.
  `resizable: false` sur la `BrowserWindow` (empêche l'utilisateur de redimensionner à la main) n'empêche PAS
  `setBounds()` d'être appelé par le code — les deux ne sont pas liés, contrairement à une intuition
  naturelle. **Limite acceptée, pas contournée** : Electron n'anime pas nativement un changement de
  `setBounds()` sur Windows (contrairement à macOS) — le redimensionnement de la fenêtre elle-même est donc
  instantané ("snap"), pas un vrai zoom fluide comme un Dynamic Island natif ; ajouter une bibliothèque
  d'animation pour ça a été jugé disproportionné pour ce premier jet. **Vérifié par le build (Playwright, vrai
  CSS compilé, mesure de rectangles réels — ni orbe ni texte ne débordent des deux tailles de fenêtre), PAS
  encore en usage réel** (pas d'accès Windows dans cet environnement) : la sensation exacte du redimensionnement
  "sec" sur une vraie machine Windows reste à confirmer par Léo.
- **Le rendu détaillé de JarisOrb (anneaux déchiquetés + noyau filaire) ne miniaturise pas bien** : conçu
  pour 160-320px, il devient un petit amas confus une fois réduit à 24px pour le widget "notch" replié
  (étape 68) — constaté en USAGE RÉEL par Léo ("on a un logo de jaris mais en tout petit, règle ça"), pas
  repéré par la vérification Playwright de l'étape précédente (qui ne testait que le DÉBORDEMENT/la position,
  jamais la qualité perçue du dessin — une vérification de layout ne remplace pas un avis sur le rendu
  visuel lui-même). Corrigé par un second mode de rendu dans JarisOrb.tsx (`MINIMAL_SIZE_THRESHOLD = 48`) :
  sous ce seuil, un simple point lumineux + un seul anneau fin (`drawMinimalGlow`) remplace tout le détail —
  toujours la couleur/pulsation de l'émotion, donc reconnaissable comme "Jaris", sans essayer de faire tenir
  la géométrie complexe dans quelques dizaines de pixels. Complété par un vrai boîtier CSS (`.app--widget-
  collapsed`, index.css : fond `--hud-panel-raised`, bordure `--hud-line`, `--hud-glow`, coins arrondis en
  pilule) autour du point — un logo seul flottant sur le bureau restait trop nu, un point lumineux à
  l'intérieur d'une vraie pilule glassy (mêmes tokens HUD que le reste de l'app, aucune couleur inventée)
  se lit tout de suite comme un vrai indicateur "notch" plutôt qu'un logo égaré. **Piège de calcul évité en
  ajustant le padding avant de considérer ça fini, pas après** : `box-sizing: border-box` (reset global) fait
  compter la bordure de 1px ET le padding DANS la hauteur totale de la pilule (36px, WIDGET_COLLAPSED_HEIGHT) —
  un padding vertical de 6px calculé sans compter cette bordure aurait laissé seulement 22px de haut pour un
  orbe de 24px (débordement de 2px) ; réduit à 4px pour repasser sous la vérification Playwright (mesure de
  rectangles réels sur le nouveau CSS compilé) avant de livrer. **Leçon générale : une vérification de layout
  (rien ne déborde) ne dit rien de la qualité perçue d'un rendu — les deux sont des questions différentes,
  toutes deux à vérifier séparément avant de considérer un changement visuel terminé.**
- **Suite en usage réel de la pilule repliée (étape 68/69) : deux retours de Léo, un vrai bug Windows et une
  préférence de forme.** (1) "il y a un fond rectangulaire" derrière les bords arrondis — limite CONNUE des
  fenêtres Electron transparentes sur Windows (le DWM anti-alias mal un bord arrondi qui touche EXACTEMENT le
  bord de la fenêtre). (2) "fait pas la forme ronde, fait la forme de jarvis" — la vraie signature de Jaris
  est un anneau au bord IRRÉGULIER (harmoniques, `drawJaggedRing`), pas un cercle lisse (`drawGlassRing`)
  utilisé dans mon premier essai de version simplifiée : réutiliser le dessin EXISTANT (un seul anneau
  déchiqueté au lieu de deux + le noyau maillé) plutôt qu'inventer une nouvelle forme "ronde" générique a
  réglé ça en gardant l'identité visuelle reconnaissable. **Piège CSS classique attrapé AVANT de livrer en
  corrigeant (1)** : une première tentative a mis `margin: 2px` directement sur le conteneur qui remplit toute
  la fenêtre (`.app--widget-collapsed`, `height: 100%` hérité de `.app`) pour décoller la pilule du bord —
  deux problèmes empilés, chacun repéré par une vraie mesure Playwright plutôt que supposé correct après
  relecture : `height: 100%` ne réagit PAS à `margin` comme `width: auto` le ferait (la pilule restait collée
  aux 4 bords malgré la marge déclarée, mesuré à (0,0,84,40) au lieu de l'inset attendu) ; en corrigeant avec
  `height: calc(100% - 4px)`, un DEUXIÈME piège est apparu — la fusion de marges CSS (margin collapsing) : le
  margin-top d'un premier enfant sans padding/bordure sur ses ancêtres (`#root`, `body`) "remonte" par fusion
  jusqu'à `body` lui-même, décalant TOUTE LA PAGE de 2px vers le bas au lieu de juste décoller la pilule
  (`BODY`/`#root` mesurés en dépassement de 2px en bas). Résolu en abandonnant `margin`/`height` sur le
  conteneur plein-écran : un élément à taille AUTO (`.widget-pill`, ajusté à son propre contenu — orbe +
  padding + bordure) centré par le flex du PARENT reste naturellement décollé des bords, sans jamais toucher
  à `margin`/`height` sur un élément qui remplit toute la fenêtre. **Leçon générale : `margin` sur un élément
  qui remplit son parent via `height: 100%` (ou toute dimension en %) ne crée PAS l'inset attendu, et un
  premier enfant en flux normal sans padding/bordure sur ses parents peut faire "remonter" sa marge jusqu'à
  un ancêtre bien plus haut (fusion de marges) — pour décoller un élément des bords d'un conteneur, préférer
  un élément à taille AUTO centré par le flex du parent plutôt que des marges/calc sur un élément qui remplit
  déjà 100% de l'espace.** Piège trouvé en testant l'hypothèse la plus simple (mesurer le rectangle réel via
  Playwright) plutôt qu'en supposant que le CSS écrit "devrait marcher" — toujours pas testé en usage réel sur
  une vraie machine Windows (pas d'accès Windows dans cet environnement).
- **3e retour de Léo sur la pilule repliée (étape 71) : agrandir, animer le "cercle" (trop statique), animer
  la transition repos/actif.** Le réglage d'animation 'idle' partagé (`EMOTION_STYLES`, pulse/spinSpeed) est
  calibré pour un anneau de 160-320px — un mouvement relatif discret y reste visible, mais devient quasi
  imperceptible en valeur ABSOLUE une fois réduit à 32px ; amplifié (×4 respiration, ×2,5 rotation)
  UNIQUEMENT dans la branche de rendu minimal de JarisOrb.tsx, jamais dans la table partagée (le grand orbe
  n'a jamais été critiqué). **Technique retenue pour "une petite animation à la transition" sans avoir à
  animer le redimensionnement de la fenêtre Electron elle-même (impossible nativement sur Windows, déjà
  documenté) : donner une `key` différente à un composant React selon l'état (ici `'collapsed'`/`'expanded'`)
  force un vrai démontage/remontage plutôt qu'un simple changement de prop sur la même instance — un
  `animation` CSS (contrairement à `transition`) se rejoue automatiquement à CHAQUE montage, donnant une
  transition visible gratuitement à chaque bascule.** Généralisable à toute transition d'état où l'élément
  qui change n'a normalement pas de raison de se démonter (ici JarisOrb reste le même composant logique,
  seule sa taille change) : forcer le remontage via `key` est plus simple qu'orchestrer une transition CSS
  manuelle sur des propriétés qui ne s'y prêtent pas nativement (ici la résolution du canvas).

## Commandes utiles

```
npm run typecheck   # tsc, node + web, sans build complet
npm run build       # electron-vite build (rapide, sans générer l'installeur)
npm run dist        # build complet + installeur .exe (long, normalement laissé à la CI)
```

`docker-compose.yml` + `searxng/settings.yml` : recherche web locale (SearXNG). Nécessite Docker Desktop
lancé ; `searxng/settings.yml` n'est relu par SearXNG qu'au démarrage du conteneur — un changement de config
nécessite `docker compose restart`, pas seulement `docker compose up -d`.
