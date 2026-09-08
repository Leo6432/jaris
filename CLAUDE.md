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
  check `isUp` faisait sortir `ensureSearxngRunning` immédiatement sans jamais comparer la config sur le
  disque à celle réellement appliquée par le conteneur déjà lancé — un 403 causé par une config devenue
  périmée (mise à jour de Jaris, ou modif manuelle) restait donc bloqué jusqu'à un redémarrage MANUEL du
  conteneur, que Léo n'est pas censé savoir faire lui-même. Corrigé en comparant un hash de settings.yml à un
  marqueur stocké dans userData (mis à jour à chaque (re)démarrage réussi) : différent -> `docker compose
  restart` automatique, sans jamais demander à Léo de taper une commande.
- **Une automatisation "propre" mais laissée à côté d'un menu déroulant manuel n'est qu'à moitié faite** : la
  première version de la sélection automatique du modèle Code (ci-dessus) gardait un réglage manuel dans
  Options par prudence, alors qu'aucun autre palier (flash/médium/puissant/vision) n'en a — Léo l'a repéré
  immédiatement ("pourquoi mettre un menu déroulant, et pas directement mettre les meilleurs modèles... comme
  vision"). Corrigé en retirant le menu déroulant et en lisant directement `profile.codeModel` (calculé et
  enregistré par `runQuickSetup`/l'analyse comparative), exactement comme `profile.visionModel` est déjà lu
  dans `assistant.ts` — jamais recalculé "en direct" à chaque génération. Une fois qu'un calcul reproduit
  fidèlement le comportement d'un mécanisme existant, aligner aussi l'INTERFACE sur ce mécanisme, pas
  seulement la logique interne.

## Commandes utiles

```
npm run typecheck   # tsc, node + web, sans build complet
npm run build       # electron-vite build (rapide, sans générer l'installeur)
npm run dist        # build complet + installeur .exe (long, normalement laissé à la CI)
```

`docker-compose.yml` + `searxng/settings.yml` : recherche web locale (SearXNG). Nécessite Docker Desktop
lancé ; `searxng/settings.yml` n'est relu par SearXNG qu'au démarrage du conteneur — un changement de config
nécessite `docker compose restart`, pas seulement `docker compose up -d`.
