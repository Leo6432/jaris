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

- **Vérifier qu'un type partagé n'est pas dupliqué localement dans un autre fichier avant de l'étendre** :
  un fichier avait sa PROPRE copie locale d'un type censé être partagé, jamais synchronisée avec le vrai —
  ajouter un champ au type partagé n'avait aucun effet tant que cette copie locale existait. Chercher toutes
  les déclarations du même nom de type dans le dépôt avant d'en étendre un.
- **Un calcul déjà fait mais jamais réellement exploité en aval** (ici : un "meilleur modèle de code selon
  la machine" calculé depuis le début mais toujours jeté avant d'être utilisé) est un signe qu'un
  comportement plus cohérent avec le reste du système était possible depuis longtemps sans jamais avoir été
  branché — vérifier si une valeur déjà calculée est réellement utilisée avant de supposer qu'un
  comportement différent est intentionnel.
- **Un tableau "illustratif" avec une ligne mise en avant comme "ta configuration" doit vraiment refléter
  cette configuration, pas le point représentatif fixe le plus proche** : un calcul de paliers par 3 points
  fixes de VRAM (6/12/24 Go) donnait la même ligne "current" à deux machines pourtant différentes (7 Go et 11
  Go), avec potentiellement des modèles différents de ceux réellement choisis pour chacune. Corrigé en
  calculant cette ligne précise avec la VRAM réelle détectée, pas le point fixe du palier — seules les lignes
  purement illustratives (pas "la sienne") peuvent rester approximatives.
- **Un service démarré une fois et laissé "up" indéfiniment (ex: SearXNG via `docker compose up -d`) ne se
  reconfigure jamais tout seul si un fichier monté en volume change** : un simple check "le service
  répond-il" faisait sortir la fonction de démarrage immédiatement sans jamais vérifier que le conteneur déjà
  lancé fonctionne vraiment comme prévu, bloquant un utilisateur non technique derrière une commande de
  redémarrage qu'il ne sait pas taper lui-même.
  **Premier correctif insuffisant, à ne pas refaire** : comparer un hash du fichier de config à un marqueur
  supposait que la SEULE cause possible était "le process n'a jamais relu le fichier depuis qu'il a changé" —
  un simple redémarrage du process suffisait alors. Vécu en usage réel : le même échec persistait après cette
  version. Un redémarrage relance le PROCESS mais ne retouche jamais à la résolution du montage (volume)
  fait à la création du conteneur — si ce montage a un jour pointé vers autre chose que le vrai fichier
  (dossier auto-créé vide par le moteur de conteneurs si le chemin n'existait pas encore à la toute première
  création), aucun redémarrage simple ne le corrige, seule une VRAIE recréation du conteneur le peut.
  **Corrigé pour de bon** en testant directement la vraie capacité dont l'app a besoin (une requête réelle
  reproduisant l'usage réel) plutôt que de deviner la cause via des comparaisons de fichiers : peu importe
  POURQUOI le service refuse, ce test le détecte, et une VRAIE recréation du conteneur (jamais un simple
  redémarrage) répare toutes les causes possibles d'un coup.
  **Ce deuxième correctif s'est AUSSI révélé insuffisant en usage réel** (l'utilisateur a confirmé être sur
  cette version et avoir toujours le même échec) : la vraie cause reste non identifiée avec certitude après 2
  hypothèses fausses écartées. Ne pas tenter un 3e correctif spéculatif sans données réelles — voir le point
  suivant, qui sert justement à obtenir enfin le VRAI message d'erreur pour diagnostiquer avec des faits.
  **Leçon générale : préférer toujours tester le comportement RÉEL observable (est-ce que ça marche ?) plutôt
  que d'inférer un état interne (un fichier a-t-il changé ?) quand la cause exacte d'un bug n'est pas
  confirmée avec certitude** — un correctif basé sur une hypothèse non vérifiée peut sembler correct en
  relecture de code tout en ne réglant rien en usage réel, et peut le démontrer plusieurs fois de suite.
  **"Cause identifiée" à ce moment-là : en réalité FAUSSE, corrigée après un nouvel échec en usage réel.**
  Conclu à tort que le corps de la réponse 403 était la page d'erreur Apache par défaut (donc qu'un AUTRE
  logiciel occupait le port), sur la base d'une recherche web généraliste sur "403 forbidden" — jamais du
  code source réel du composant suspecté. Changé le port sur cette base. Le même 403 est réapparu sur le
  nouveau port. En vérifiant pour de vrai le CODE SOURCE de Werkzeug (la bibliothèque WSGI sous-jacente de
  l'appli suspectée) : ce texte est son propre message d'erreur par défaut pour un 403 — c'était bien l'appli
  elle-même qui répondait depuis le début, exactement comme le tout premier diagnostic le suggérait. Le
  changement de port était une fausse piste sans rapport avec le vrai problème. Corrigé en ajoutant un VRAI
  diagnostic plutôt qu'une hypothèse de plus : lire la config TELLE QUE LE SERVICE LA VOIT RÉELLEMENT (via la
  commande d'exécution du conteneur) et l'inclure directement dans le message d'erreur, pour comparer un FAIT
  au fichier réel sur le disque plutôt que de deviner encore. **Leçon générale, renforcée par cet échec** :
  une recherche web généraliste sur un message d'erreur NE VÉRIFIE RIEN de spécifique — pour identifier la
  source EXACTE d'un texte précis, il faut consulter le CODE SOURCE réel du composant suspecté, jamais des
  articles génériques qui parlent du sujet en surface. Une conclusion présentée avec assurance peut être
  fausse même après une recherche qui SEMBLE la confirmer — la revérifier avec la source primaire avant de la
  communiquer comme un fait à l'utilisateur.
- **Une consigne système ("ne jamais inventer de dépannage") ne suffit pas à empêcher un petit modèle local
  de le faire quand même** : face à un vrai message d'erreur technique, un modèle de conversation a remplacé
  le message réel par un dépannage générique halluciné et FAUX (des étapes qui n'existent pas dans
  l'installation réelle) — malgré une consigne explicite déjà en place le lui interdisant. Corrigé en
  COURT-CIRCUITANT le modèle plutôt qu'en renforçant encore la consigne (déjà démontrée insuffisante) : dès
  qu'un appel d'outil échoue, la réponse finale devient le message d'erreur lui-même, jamais reformulé par un
  nouvel appel au modèle. Les messages d'erreur doivent donc être rédigés directement pour un lecteur humain,
  plus jamais en supposant qu'un modèle les reformulera avant affichage. **Leçon générale : quand une
  consigne "ne fais pas X" échoue en usage réel face à un petit modèle, la bonne réponse est souvent de
  rendre X impossible dans le code plutôt que de reformuler la consigne une fois de plus.**
- **Une automatisation qui reproduit un mécanisme existant doit aussi reproduire son INTERFACE, pas
  seulement sa logique interne** : la sélection automatique du modèle Code (ci-dessus) gardait d'abord un
  menu déroulant manuel dans Options par prudence, alors qu'aucun autre palier (flash/médium/puissant/vision)
  n'en a — repéré par l'utilisateur, corrigé en lisant directement la valeur déjà calculée et enregistrée
  dans le profil (comme `visionModel`), sans recalcul en direct ni choix manuel.
- **Un mode vocal (mot d'activation) qui écoute en continu doit pouvoir être suspendu selon le mode d'usage
  actif** (ex: un onglet Chat/Code à côté d'un mode Vocal) : sans ça, parler pendant qu'on écrit ailleurs
  déclenche quand même une réaction vocale. Suspendre par un simple drapeau qui fait ignorer les évènements
  déjà reçus est plus léger que d'arrêter/relancer tout le pipeline audio à chaque changement de mode. Piège
  identifié en l'écrivant : si la fenêtre qui pilote ce drapeau peut se cacher SANS être détruite (son état
  React survit), la resuspendre en dernier au repli laisserait l'écoute bloquée indéfiniment pour un
  utilisateur qui ne voit plus que l'interface représentant le mode vocal — forcer la reprise explicitement
  au moment où cette fenêtre se cache/réduit, pas seulement dépendre de ce que pense encore son état interne.
- **Un budget de fenêtre de contexte LLM choisi une fois n'est jamais revu quand le système prompt/la liste
  d'outils grossissent** : figé depuis le début (choix volontaire pour tenir en VRAM), jamais réévalué malgré
  l'ajout progressif de nombreux outils et consignes système au fil des versions — mesuré pour de vrai cette
  session : le système prompt + la liste d'outils consomment déjà à eux seuls plusieurs milliers de tokens,
  AVANT même le premier message de l'utilisateur. Sur le plus petit modèle disponible, ça ne laissait
  quasiment plus de budget pour une vraie réponse — une réponse vide constatée en usage réel. Corrigé en
  doublant la valeur par défaut : le coût mémoire supplémentaire (cache K/V) est négligeable comparé au poids
  du modèle, surtout pour les petits modèles justement les plus concernés. **Leçon générale : un budget fixe
  basé sur "ce qu'on utilise aujourd'hui" doit être revu chaque fois que ce qu'on empile dedans (prompt
  système, outils...) grossit significativement — mesurer pour de vrai (compter les caractères/tokens réels)
  plutôt que de supposer qu'une valeur choisie il y a plusieurs versions est toujours valable.**
- **Une dépendance externe lourde (Docker Desktop) n'était PAS auto-installée comme les autres** (choix
  volontaire au départ) : le code ne faisait que la LANCER si déjà installée — confusion légitime pour
  l'utilisateur si une autre dépendance similaire (Ollama), elle, s'installe déjà toute seule. Corrigé en
  ajoutant un vrai téléchargement + installation automatique, déclenché seulement quand on détecte que la
  dépendance n'est PAS installée (pas juste "pas encore lancée"). **Différence assumée avec l'installation
  silencieuse existante** : PAS silencieux cette fois, à la demande explicite de l'utilisateur — activer la
  virtualisation nécessaire à Docker Desktop demande une élévation Windows (UAC) qu'aucun indicateur ne peut
  contourner, donc l'utilisateur voit de toute façon une fenêtre système lui demander une autorisation ; cette
  fenêtre sert l'accord explicite demandé, pas la peine d'en ajouter une autre. Jamais de redémarrage forcé à
  la place de l'utilisateur (action difficile à annuler) : si le service ne répond toujours pas après
  l'installation, le message suggère juste qu'un redémarrage est PROBABLEMENT nécessaire (vérifié sur la
  documentation officielle AVANT d'écrire cette fonction : cette dépendance ne documente pas ses codes de
  sortie, contrairement à la convention standard — donc jamais affirmer "il faut redémarrer" comme un fait
  déduit d'un code de sortie précis, seulement une piste probable). Taille de l'installeur vérifiée pour de
  vrai (requête HEAD) avant de choisir un délai de téléchargement adapté, plutôt que de réutiliser le même
  délai qu'une autre dépendance bien plus légère : un délai trop court aurait coupé un téléchargement en
  pleine réussite sur une connexion modeste, faisant croire à un échec à tort.
- **Un détecteur "promesse sans action" basé sur un motif de mot-clé précis (ex: "je vais faire") généralise
  mal** : constaté en usage réel, le modèle a promis une action avec un AUTRE verbe ("je vais rechercher...")
  sans jamais appeler le bon outil, et cette phrase ne matchait pas le motif d'origine limité à un seul verbe.
  Vérifié avec un vrai test du motif sur le texte exact avant de corriger (jamais supposé la cause). Corrigé
  en détectant le PATRON GRAMMATICAL (verbe au futur proche : "je vais " + un mot se terminant par les
  terminaisons d'infinitif de la langue) plutôt qu'un verbe précis — couvre tous les verbes sans avoir à les
  connaître à l'avance, testé pour ne pas accrocher les usages bénins ("je vais bien") avant d'être adopté.
  **Leçon générale : dès que c'est possible, détecter le PATRON GRAMMATICAL plutôt qu'un mot-clé précis** —
  un mot-clé précis oblige à rajouter chaque nouveau cas un par un à mesure qu'on le découvre en usage réel.
- **Installer une dépendance lourde tout seul ne suffit pas si SON PROPRE prérequis manque aussi en
  silence** — vécu en usage réel dans la foulée du correctif précédent (auto-installation de Docker
  Desktop) : installée avec succès, mais bloquée au démarrage derrière son propre message d'erreur
  réclamant un prérequis système (WSL) jamais vérifié. Bug de PLACEMENT du check, pas de logique : le
  premier ajout ne vérifiait ce prérequis qu'à L'INTÉRIEUR de la branche "pas installée du tout" — jamais
  atteinte une fois la dépendance déjà présente (le cas dès le lancement suivant), donc jamais réellement
  exécuté. Corrigé en déplaçant ce check tout en haut, AVANT même de toucher à la dépendance elle-même, que
  celle-ci soit déjà installée ou non : ce prérequis conditionne le FONCTIONNEMENT, pas seulement
  l'installation. **Leçon générale : quand une vérification/installation automatique est ajoutée dans UNE
  branche précise d'un flux à plusieurs chemins, vérifier qu'elle reste atteignable une fois que l'état qui a
  déclenché cette branche a changé** — un correctif qui marche pour le premier lancement peut devenir
  invisible dès le lancement suivant si son placement suppose à tort que les deux lancements prennent le
  même chemin.

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
  empêche justement ça) — d'où "rien du tout ne se passe" au clic, confirmé par Léo (question ciblée à choix
  simples : il cliquait bien DANS l'aperçu de Jaris). **Diagnostic vérifié pour de vrai avant tout
  correctif** : un test Playwright avec le VRAI CSS compilé (`out/renderer/assets/index-*.css`) et un clic
  bas niveau aux coordonnées ÉCRAN réelles du bouton (position de l'iframe + position du bouton DANS
  l'iframe, pas `frame.click()` qui cible l'élément directement sans passer par le vrai rendu) a confirmé
  que le bouton tombe hors de la zone visible de l'iframe — jamais deviné, contrairement à la saga SearXNG
  plus haut. Corrigé à la source (`APP_RULES`, codeGenerator.ts) : nouvelle consigne interdisant `overflow:
  hidden` + hauteur fixe (100vh/100%) sur `<html>`/`<body>`, ET un contrôle mécanique dans
  `validateGeneratedHtml` (même mécanisme déjà là pour les classes fantômes/ressources externes/JS hors
  `<script>`) qui détecte ce motif et déclenche la passe de réparation. **Piège dans le correctif lui-même,
  attrapé par le test AVANT de le considérer terminé** : la première version du contrôle cherchait `selector
  { déclarations }` sur le HTML ENTIER, mais pour la toute PREMIÈRE règle CSS du fichier, la capture du
  "sélecteur" (`[^{}]+`, qui remonte jusqu'à la dernière accolade rencontrée) avalait tout le HTML précédent
  — `<!DOCTYPE html><html><head><style>` contient lui-même le mot "html", donc CHAQUE fichier généré aurait
  déclenché un faux positif dès sa première règle CSS. Corrigé en isolant d'abord le contenu des balises
  `<style>` avant d'y chercher des règles html/body. Régression : `node --test
  scripts/test-codegen-validate.mjs`. **Leçon générale : un correctif "évident" doit quand même être testé
  avec des cas limites simples (ici : le tout premier cas réel, la page générée elle-même) avant d'être
  considéré fiable** — la relecture seule n'aurait pas forcément repéré ce faux positif.

## Commandes utiles

```
npm run typecheck   # tsc, node + web, sans build complet
npm run build       # electron-vite build (rapide, sans générer l'installeur)
npm run dist        # build complet + installeur .exe (long, normalement laissé à la CI)
```

`docker-compose.yml` + `searxng/settings.yml` : recherche web locale (SearXNG). Nécessite Docker Desktop
lancé ; `searxng/settings.yml` n'est relu par SearXNG qu'au démarrage du conteneur — un changement de config
nécessite `docker compose restart`, pas seulement `docker compose up -d`.
