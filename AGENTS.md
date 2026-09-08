# Jaris — instructions pour toute IA travaillant sur ce dépôt

Assistant IA vocal 100% local (Electron + React + TypeScript, LLM via Ollama). Développé pour Léo, seul
utilisateur/testeur — pas d'autres développeurs, pas d'utilisateurs externes à ménager.

Ce fichier suit la convention [agents.md](https://agents.md), reconnue par plusieurs outils IA (dont Codex/
ChatGPT). Une version équivalente existe dans `CLAUDE.md`, spécifique à Claude Code (format d'attribution des
commits notamment) — garder les deux synchronisés à chaque nouveau piège ou étape de checklist découverte.
Les deux fichiers sont mis à jour en continu, jamais un instantané figé.

## À vérifier après CHAQUE changement, avant de le considérer terminé

Dans cet ordre, sans en sauter :

1. `npm run typecheck` — doit passer sans erreur (node ET web).
2. `npm run build` — doit compiler sans erreur (`electron-vite build`).
3. Si un fichier a été supprimé/renommé/déplacé : recherche dans tout le dépôt (grep ou équivalent) toute
   référence encore pendante (imports, IPC channels, préférences oubliées) avant de considérer le nettoyage
   terminé.
4. Bump de version dans `package.json` :
   - patch (x.y.Z+1) pour un correctif ciblé ;
   - minor (x.Y+1.0) seulement pour un changement d'architecture/de fonctionnalité de grande ampleur.
5. `npm install --package-lock-only` pour resynchroniser `package-lock.json` avec la nouvelle version
   (ou `npm install` complet si des dépendances ont changé).
6. Commit avec un message détaillé en français expliquant le POURQUOI (pas juste le quoi), signé avec
   l'attribution propre à l'outil utilisé (ex: co-auteur, lien de session) pour qu'on sache quelle IA a fait
   le changement.
7. `git push -u origin claude/jaris-local-ai-assistant-a2drk4` (vérifier avant que `origin` pointe bien
   vers `https://github.com/Leo6432/jaris.git` — a déjà dérivé vers l'ancien nom `jarvis` après redémarrage
   d'un environnement).
8. Vérifier que la CI (`Installeur Windows`, `.github/workflows/build-installer.yml`) passe, et que la
   Release GitHub correspondante existe avec son `Jaris-Setup-X.Y.Z.exe`. Un échec CI en `ECONNRESET`/réseau
   sur le téléchargement electron-builder est transitoire : relancer le job plutôt que re-pousser un nouveau
   commit.
9. Confirmer à Léo en une ligne courte une fois la Release publiée (ex: "v0.2.6 est publiée."), jamais avant.

Ne JAMAIS annoncer un correctif "terminé" avant l'étape 8 confirmée.

## Pièges déjà rencontrés dans ce projet (pour ne pas les refaire)

- **Une exception dans un outil (`electron/services/tools.ts`) ou un appel Ollama ne doit jamais remonter
  telle quelle** sans être transformée en message clair pour l'utilisateur : un message générique du style
  "vérifie qu'Ollama tourne bien" cache la vraie cause (SearXNG/Docker mal configuré, réseau coupé, machine
  surchargée...). Toujours relayer le message d'erreur réel (déjà écrit pour être actionnable dans
  `webSearch.ts`/`ollama.ts`) plutôt qu'un message générique.
- **Une vérification purement visuelle (screenshot) ne suffit pas** pour un changement CSS/layout : vérifier
  aussi par un vrai clic (Playwright `page.click()` + `getBoundingClientRect()`) que rien d'autre n'a cassé
  (ex: un conteneur invisible en `position:absolute` qui intercepte des clics ailleurs sur la page).
- **`app.requestSingleInstanceLock()` seul ne suffit pas** (Electron) : sans un retour explicite en tout
  début du callback `app.whenReady()` quand le verrou n'a pas été obtenu, une instance perdante peut quand
  même créer une fenêtre/démarrer des services avant que son `app.quit()` ne soit vraiment effectif.
- **`app.quit()` ne quitte pas réellement** si le module `quitting` (`electron/main.ts`) n'est pas mis à
  `true` avant : la fenêtre principale intercepte sa propre fermeture pour se replier en widget par défaut.
- Léo ne peut généralement pas exécuter l'appli lui-même pendant qu'une IA y travaille (pas d'accès Windows
  direct dans un environnement cloud) : tout changement UI/Electron n'est vraiment vérifié qu'une fois qu'il
  l'a testé en usage réel — rester honnête sur ce qui est "vérifié par le build" vs "vérifié en usage réel",
  ne jamais confondre les deux.
- Éviter les correctifs spéculatifs en rafale sur un même symptôme flou : si la cause exacte n'est pas
  claire, poser une question ciblée à Léo (il n'est pas très technique — préférer des questions à choix
  simples plutôt que demander d'interpréter des logs) plutôt que de deviner et de multiplier les versions.
- **Une tâche longue (`computer_use_task`, jusqu'à 20 allers-retours capture d'écran + clic, chaque étape
  pouvant prendre jusqu'à 45s) doit donner un signe de vie régulier**, sinon elle paraît plantée alors qu'elle
  travaille juste lentement. Toute action qui peut prendre plus de quelques secondes doit annoncer sa
  progression au fil de l'eau (voir `onLog`/`window.jaris.onLog`), pas seulement un indicateur statique.
- **Vérifier si un mécanisme IPC existe déjà avant d'en ajouter un nouveau** : `window.jaris.onLog` était déjà
  exposé côté preload depuis longtemps mais jamais consommé par aucun composant React — le brancher a suffi,
  pas besoin de créer un nouveau channel.
- Le canal "chat" (texte, sans synthèse vocale) et le canal "voix" (Agent Vocal) partagent exactement les
  mêmes outils (même fonction `converse()` dans `assistant.ts`, même tableau `TOOLS`) — seul le `channel`
  passé à `buildSystemPrompt` change le style de réponse autorisé (listes/gras/code OK en chat, jamais en
  voix car lu à voix haute par la synthèse).
- **`computer_use_task` (petit modèle de vision local) s'arrête facilement après la PREMIÈRE sous-tâche
  visible d'un objectif à plusieurs actions** ("ouvre YouTube et cherche un tuto guitare" → ouvre YouTube,
  répond "done" sans jamais avoir tapé/lancé la recherche) : le prompt système de la boucle
  (`SYSTEM_PROMPT`, `electron/services/computerUse.ts`) doit explicitement interdire de conclure "done" tant
  que chaque verbe de l'objectif n'est pas vérifié un par un — un exemple concret dans le prompt aide plus
  qu'une règle abstraite.
- **Le modèle de conversation répond parfois par une PROMESSE d'action ("je vais faire X", "un instant",
  "attends") SANS appeler le moindre outil dans ce tour** : comme la liste des appels d'outils est vide, la
  boucle (`electron/services/assistant.ts`) prenait ce texte pour la réponse finale et s'arrêtait là — rien
  ne se passait jamais malgré l'annonce. Détecter ça sur le LANGAGE DE PROMESSE dans la réponse elle-même
  (pas sur l'intention de la phrase de l'utilisateur, trop spécifique à deviner à l'avance) généralise mieux
  qu'un filet propre à un seul cas d'usage (ex: le mail).
- **Une capture d'écran réduite pour l'envoyer à un modèle de vision (`MAX_SCREENSHOT_WIDTH`,
  `electron/services/vision.ts`) doit toujours renvoyer aussi son facteur d'échelle** : un modèle qui répond
  en coordonnées pixel sur l'image réduite (ex: `computer_use_task`) doit reconvertir ces coordonnées vers
  l'écran réel avant tout clic, sinon chaque clic atterrit au mauvais endroit dès que l'écran dépasse la
  largeur réduite. Repéré par une relecture externe du code (autre IA), jamais en usage réel.
- **Un mot-clé seul (ex: "mail" pour déclencher une relance corrective) ne suffit pas à détecter une
  intention** : "n'envoie PAS de mail" contient bien "mail"/"envoie" mais l'intention est l'inverse. Vérifier
  l'absence de négation (ne/pas/jamais/évite...) dans une fenêtre de texte autour du mot déclencheur avant de
  pousser une relance qui suppose l'action voulue.
- **Un signal d'annulation (`AbortSignal`) qui s'arrête au premier appel Ollama ne couvre pas les outils qui
  lancent leur propre boucle** (`computer_use_task`) : une fois lancée, une boucle de clics devait aller
  jusqu'à `MAX_STEPS` ou sa fin naturelle, sans pouvoir être interrompue. Le signal doit être transmis
  explicitement à l'outil concerné, pas seulement à l'appel de conversation — et combiné (`AbortSignal.any`)
  avec le timeout déjà en place par étape.
- **Figer des versions de dépendances Python une par une, en prenant la "dernière" de chaque paquet
  indépendamment, peut choisir des versions incompatibles entre elles** (constaté : la dernière version
  indépendante de librosa et de scipy ne fonctionnaient pas ensemble). Toujours résoudre l'ENSEMBLE via
  `pip install --dry-run --report -` (ou équivalent) et figer le résultat de cette résolution. Un paquet avec
  un chemin d'installation particulier (`torch`, installé à part via un index CUDA dédié) ne doit PAS être
  figé dans `requirements.txt` : une version figée ici pourrait forcer une réinstallation d'une autre version
  par-dessus celle déjà installée pour de bonnes raisons.
- **Pour figer une image Docker `:latest` sur un tag précis**, interroger l'API du registre (digest de
  `:latest`, puis quel tag nommé partage ce digest) plutôt que deviner un numéro de version.
- **Ajouter du streaming à un appel LLM partagé par plusieurs canaux sans risquer de régression** : passer un
  callback optionnel qui, quand fourni, bascule l'appel en streaming — absent, le comportement reste
  identique à avant pour les autres canaux.

## Commandes utiles

```
npm run typecheck   # tsc, node + web, sans build complet
npm run build       # electron-vite build (rapide, sans générer l'installeur)
npm run dist        # build complet + installeur .exe (long, normalement laissé à la CI)
```

`docker-compose.yml` + `searxng/settings.yml` : recherche web locale (SearXNG). Nécessite Docker Desktop
lancé ; `searxng/settings.yml` n'est relu par SearXNG qu'au démarrage du conteneur — un changement de config
nécessite `docker compose restart`, pas seulement `docker compose up -d`.
