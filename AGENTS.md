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
- **Fermer la croix de la fenêtre principale se repliait en widget EXACTEMENT comme minimize** (étape 19,
  jamais remis en cause jusqu'à ce que Léo le demande à l'étape 72) : `win.on('close', ...)` faisait
  `event.preventDefault()` + `win.hide()` + `showWidgetWindow()`, la même chose que `win.on('minimize', ...)`
  juste en dessous — Jaris continuait donc de tourner en arrière-plan (widget + écoute du double clap) quel
  que soit le bouton cliqué, sans que rien ne distingue "je veux juste réduire" de "je veux fermer l'appli".
  Corrigé en séparant les deux : la croix met `quitting = true` puis appelle `app.quit()` (même idiome déjà
  utilisé pour "Quitter" dans le menu de la barre système et pour l'arrêt d'urgence GPU), minimize reste
  inchangé. **Piège pour la prochaine fois qu'un TROISIÈME état de fenêtre est ajouté (ex: un futur "réduire
  dans la barre système sans widget") : `quitting` n'est qu'un booléen global partagé par plusieurs
  déclencheurs (croix, tray "Quitter", arrêt GPU) — avant d'ajouter un nouveau chemin qui doit vraiment quitter
  l'app, vérifier s'il doit lui aussi passer par ce même drapeau (sinon un `close` ultérieur sur une fenêtre
  encore ouverte pourrait se re-intercepter et re-replier en widget au lieu de laisser le quit se terminer).**


- **Une animation au remontage ne relie pas deux états du widget** : changer la clé React détruit le
  canvas précédent et le repli natif immédiat coupe le contenu. Garder les deux rendus montés, animer
  transform/opacity avec un ancrage indépendant de la taille native, agrandir avant l’évènement renderer
  et différer le repli natif après le fondu. Annuler ce repli si une nouvelle activation survient.
  Vérifier les étapes intermédiaires, les clics et les inversions rapides, pas seulement les états finaux.
- **Masquer un processus parent ne suffit pas pour ses commandes secondaires** : les trois taskkill
  internes d’Ollama utilisaient exec sans windowsHide. Chaque lancement interne doit masquer sa console ;
  Start-Process exige aussi son propre WindowStyle Hidden. Les interfaces d’installation et l’UAC restent
  gérées par Windows. Un audit des options confirme le correctif, pas l’absence de toute fenêtre tierce.


- **Le saut horizontal du widget persistait malgré un fondu CSS** : redimensionner ET déplacer la
  fenêtre native laisse brièvement l’ancien rendu à sa nouvelle origine avant le recalcul Chromium.
  Sur Windows/Linux, garder x et la largeur constants et limiter la région native avec setShape au repos.
  La région exclue laisse passer les clics ; vérifié via GetWindowRgn/PtInRegion sous Windows, pas seulement
  par les rectangles DOM. Le fondu et le repli vertical différé restent inchangés.
- **Les consoles restantes venaient des enfants d’Ollama, pas des commandes taskkill** : trace réelle
  du redémarrage en 0.4.22 : llama-server et gpu-discover créaient chacun un conhost. windowsHide sur
  un parent sans console ne fournit pas de console cachée à hériter. Lancer ollama serve via Start-Process
  -WindowStyle Hidden puis attendre le processus maintient une console cachée commune et l’arbre d’arrêt.
  Ne pas détacher le lanceur PowerShell : le test exact avec detached:true sortait sans lancer le serveur ;
  sans ce drapeau, démarrage et arrêt de l’arbre sont vérifiés avec les mêmes options que la production.
  Test réel avec Ollama 0.34.0 sur un port isolé : helpers observés, API disponible, aucune fenêtre visible
  relevée pendant 35 s. Ne pas déduire l’absence de régression d’une version minimale ancienne d’Ollama.
  Win32_ProcessStartTrace était refusé sur cette machine malgré la lecture CIM autorisée : ne pas avaler
  silencieusement cette erreur ; la trace utile a été obtenue par des instantanés CIM rapprochés.
- **"Jaris est ouvert mais pas en haut" (Léo, étape 73) : le repli en widget ne réagissait qu'à un clic
  explicite sur minimize, jamais à une simple perte de focus** — Léo a précisé (2 questions ciblées
  nécessaires pour lever l'ambiguïté initiale, message garanti flou : "je clique n'importe ou pour l'enlever")
  qu'il ne parlait NI du bouton réduire NI du widget lui-même, mais du cas où il reste sur la fenêtre normale
  de Jaris puis clique sur une AUTRE application (ex: le navigateur) SANS jamais toucher au bouton réduire :
  rien n'indiquait alors plus nulle part que Jaris tournait encore. Contradiction avec l'intention documentée
  depuis l'étape 19 elle-même ("widget flottant... visible même quand une autre appli a le focus") : le code
  n'a en réalité JAMAIS câblé cette partie, seul `win.on('minimize', ...)` déclenchait le repli. Corrigé en
  ajoutant `win.on('blur', ...)` (createFullWindow, electron/main.ts) qui traite une perte de focus EXACTEMENT
  comme minimize (même repli en widget) — sauf pendant un vrai dialogue natif Windows attaché à la fenêtre
  (ex: `chooseModelsLocation`, `dialog.showOpenDialog`), qui prend lui aussi le focus OS sans que Léo ait
  quitté Jaris : un nouveau drapeau `dialogOpen` (mis à `true`/`false` autour de l'appel à `showOpenDialog`)
  empêche le handler `blur` de cacher la fenêtre (et son dialogue enfant, orphelin si le parent disparaît)
  dans ce cas précis. **Piège identifié avant de coder, pas après** : un dialogue MODAL attaché à une fenêtre
  parente (`dialog.showOpenDialog(fullWindow, ...)`) prend le focus OS au même titre qu'une autre application
  pour Electron — sans ce garde, choisir l'emplacement des modèles (étape 44) aurait fait disparaître la
  fenêtre de réglages en plein milieu de la sélection du dossier.
- **Kokoro (étape 74) revenu en arrière (étape 75) après écoute en usage réel** : malgré des comparatifs
  indépendants favorables et une licence plus permissive, Léo a demandé de revenir à Supertonic HD
  ("remet supersonic en faite") après l'avoir vraiment écouté sur sa machine — retour en arrière via
  `git revert` (commit propre, sans conflit) plutôt qu'une réécriture manuelle, puisque le commit Kokoro
  était isolé et le plus récent de la branche. **Leçon générale, qui rejoint celle déjà tirée pour le
  visuel du widget (étapes 69-71) : un jugement de QUALITÉ PERÇUE (ici le son d'une voix, là le rendu d'un
  orbe) ne se laisse jamais deviner par des chiffres de comparatifs, même corroborés par deux sources
  indépendantes — seule une vraie écoute/un vrai visionnage en usage réel tranche.** Le compromis objectif
  (1 voix au lieu de 10, français "peu représenté" selon les créateurs de Kokoro, documenté à l'étape 74)
  était donc le bon signal d'alerte à donner à Léo AVANT de coder — mais le verdict final ne pouvait venir
  que de lui, après une vraie écoute, jamais d'une décision prise ici à sa place sur la base des seuls
  chiffres.
- **Le sélecteur de voix (Options → Voix) affichait un simple cercle plein (gradient CSS, `border-radius:
  50%`) pour représenter chaque voix — Léo l'a jugé incohérent avec l'identité visuelle de Jaris** ("fait
  pas un cercle rond... fait le même cercle que dans l'accueil... change juste la couleur pour différencier
  les voix"), la même préférence déjà exprimée pour la pilule du widget replié (étapes 69-70 : "la vraie
  signature de Jaris est un anneau au bord IRRÉGULIER, pas un cercle lisse"). Corrigé en ajoutant un prop
  optionnel `color?: string` à `JarisOrb` (src/components/JarisOrb.tsx) qui REMPLACE UNIQUEMENT la couleur
  tirée de `EMOTION_STYLES[emotion]` (jamais modifiée elle-même — vitesse de rotation/pulsation restent
  celles de `emotion`, ici toujours `'idle'`) : `const color = colorRef.current ?? style.color` puis chaque
  usage de `style.color` dans `draw()` remplacé par cette variable locale. Le sélecteur affiche donc
  maintenant un vrai `<JarisOrb emotion="idle" color={voice.color} size={220} />` par voix (10 couleurs
  hexadécimales, `TTS_VOICES`, à la place des 10 dégradés CSS retirés) — même forme reconnaissable pour
  toutes, seule la couleur change. **Vérifié pour de vrai, pas juste en relecture** : un test Playwright a
  bundlé le VRAI composant `JarisOrb.tsx` (via esbuild, react-dom/client) et lu les pixels du canvas rendu
  pour deux couleurs différentes — confirme que (1) le rayon de l'anneau varie selon l'angle (variance
  mesurée > 0, jamais un cercle parfait), et (2) la couleur moyenne du canvas correspond exactement à la
  couleur passée en prop (rouge pur vs vert pur, aucune contamination par `EMOTION_STYLES.idle.color` par
  défaut).

- **L'orbe de l'onglet Voix (étape 76) restait à une taille FIXE (220px) quelle que soit la taille réelle
  de la fenêtre** — sur un grand écran, il paraît minuscule et perdu au milieu d'un immense vide, capture
  d'écran de Léo à l'appui en usage réel : "ne se met pas bien par rapport a l'écrant... trop petit".
  Corrigé en mesurant `.options-menu__voice-picker` (déjà en `position: absolute; inset: 0`, donc déjà
  aux dimensions réelles disponibles) via `ResizeObserver`, borné entre 180 et 420px. **Piège dans mon
  PROPRE premier correctif, attrapé par un test Playwright avant de livrer, pas en usage réel** : un
  `useRef` + `useEffect(..., [tab])` classique ne se redéclenche QUE quand `tab` change — au tout premier
  rendu (`open` encore `false`, la page Options n'existe pas dans le DOM), cet effet tourne quand même avec
  `tab` déjà à `'voix'` (valeur par défaut), trouve `ref.current === null` et ressort aussitôt SANS jamais
  observer quoi que ce soit ; comme `tab` ne change plus jamais après l'ouverture réelle du panneau,
  l'effet ne se relance JAMAIS — l'orbe restait bloqué à 220px quelle que soit la fenêtre testée, confirmé
  par un test qui a mesuré le canvas rendu à 1000x760 ET 1920x1080 (chiffres identiques, plus grand nulle
  part). **Corrigé en remplaçant `useRef`+`useEffect` par une CALLBACK REF** (`(el) => { ... }` passée
  directement à `ref=`) : elle se redéclenche exactement quand LE NOEUD LUI-MÊME apparaît/disparaît dans le
  DOM, peu importe la raison (`open`, `tab`, ou une autre condition future) — plus besoin de deviner le bon
  tableau de dépendances. Revérifié après correction : 266px à 1000x760, 378px à 1920x1080, bien croissant
  et borné. **Leçon générale : pour une logique de setup/nettoyage liée à la PRÉSENCE d'un nœud DOM précis
  (mesure, ResizeObserver, focus...), une callback ref est plus fiable qu'un `useRef` + `useEffect` avec un
  tableau de dépendances qu'il faut deviner correctement — surtout quand le nœud est conditionnellement
  rendu par PLUSIEURS états différents (ici `open` ET `tab`), pas un seul.**
- **Étape 77 (taille responsive de l'orbe des voix) elle-même revenue en arrière juste après (étape 78)** :
  Léo a précisé "je veut la meme taille que dans l'aceuille la meme" — pas une taille CALCULÉE selon l'écran
  (même bien bornée 180-420px), littéralement LA MÊME valeur fixe que `<JarisOrb emotion={emotion} />` sur
  l'écran d'accueil (App.tsx, mode 'voice', sans prop `size` → défaut `320` de JarisOrb.tsx). Tout le
  ResizeObserver/callback ref de l'étape 77 retiré (déjà plus de complexité que nécessaire une fois le vrai
  besoin connu) : le sélecteur de voix omet maintenant lui aussi la prop `size`, héritant du MÊME défaut
  que l'accueil plutôt que de dupliquer la valeur `320` en dur À CÔTÉ (une divergence future entre les deux
  écrans resterait alors impossible par construction, pas seulement par convention). **Leçon générale :
  "adapter à l'écran de l'utilisateur" et "la même taille qu'ailleurs dans l'app" sont deux demandes qui se
  RESSEMBLENT en français courant mais impliquent des implémentations opposées (calcul dynamique vs valeur
  fixe partagée) — la première tentative (étape 77) a supposé la première lecture sans la confirmer, alors
  que Léo décrivait déjà la seconde ("le même cercle que dans l'accueil") dès sa toute première demande sur
  ce sujet (étape 76) ; une relecture plus attentive de sa phrase d'origine aurait évité ce détour.**
- **Qualité Supertonic (`total_steps`, python/tts_server.py) : 8 -> 12, décidé sur des FAITS mesurés, pas des
  suppositions.** Léo avait remarqué que Supertonic a "plusieurs niveaux" (question sur "étape combien") ;
  vérifié que `total_steps` va de 5 (rapide, moins net) à 12 (recommandé max, plus propre) chez Supertonic,
  8 étant déjà la valeur par défaut de la bibliothèque — donc DÉJÀ un choix raisonnable avant tout
  changement, pas une valeur négligée. Avant de choisir, deux choses vérifiées pour de vrai plutôt que
  supposées : (1) 3 vrais échantillons audio générés (niveaux 1/5/12, MÊME phrase, dans un venv jetable avec
  le `supertonic==1.3.1` réellement figé dans requirements.txt) envoyés à Léo pour qu'il écoute et compare
  lui-même — jamais une recommandation basée sur des chiffres de comparatifs seuls (même leçon que Kokoro,
  étapes 74-75) ; (2) le coût réel en temps CHRONOMÉTRÉ (pas estimé) avant de répondre à sa question "ça va
  prendre beaucoup plus de puissance ?" : ~1,45s à 8 contre ~1,98s à 12 sur la machine de test (+35-40%,
  aucune VRAM/GPU supplémentaire nécessaire — c'est un coût CPU par réponse, pas un besoin matériel nouveau).
  Léo a choisi 12 en connaissance de cause. **Leçon générale : quand une question porte sur un coût concret
  ("combien de temps/puissance en plus ?"), le chronométrer réellement (même sur une machine différente de
  celle de l'utilisateur, en le précisant) donne une réponse bien plus utile qu'une estimation qualitative
  ("un peu plus lent").**
- **"on vas pas faire en tappant dans les mains c'est galere... dire juste jaris" (Léo, étape 80)** :
  remplace le double clap par un vrai mot d'activation "Jaris", en évitant le piège de la toute première
  tentative (openWakeWord retiré une première fois car aucun mot-clé "Jaris" n'existe tout fait, obligeant
  à dire "Hey Jarvis" en anglais). Entraîné un modèle openWakeWord DÉDIÉ à "Jaris" plutôt que de réutiliser
  un mot existant : corpus synthétique généré avec les 10 voix Supertonic DÉJÀ utilisées par Jaris (français
  réel, pas le générateur Piper anglais fourni par défaut par openWakeWord) — positifs ("Jaris" dans
  plusieurs phrasings/voix/vitesses) et négatifs DURS (mots phonétiquement proches : "Paris", "chariot", "a
  ri", "Jarvis"...) plutôt qu'un jeu de données générique. Le jeu de négatifs "arrière-plan" officiel
  d'openWakeWord (ACAV100M, ~17 Go de features pré-calculées) a été délibérément écarté (disproportionné
  pour ce cas, en plus d'un risque réel pour le budget disque de la session) au profit des augmentations
  synthétiques déjà intégrées à la bibliothèque (bruit coloré, gain, pitch, filtre EQ) — validé objectivement
  à la fin via le jeu de validation OFFICIEL d'openWakeWord (faux positifs/heure sur ~11h de vrai audio
  varié, téléchargé à part car minuscule, 185 Mo) plutôt qu'une estimation.
  **Piège d'empaquetage identifié AVANT de coder l'intégration** : le paquet PyPI `openwakeword` lui-même ne
  s'installe PAS sur Windows/Python récent — sa dépendance dure `tflite-runtime` n'a aucune roue disponible
  au-delà de Python 3.9 ni pour Windows (vérifié sur PyPI, pas supposé). `python/wakeword.py` réimplémente
  donc EN MINIATURE (numpy + onnxruntime seulement, déjà une dépendance transitive de Supertonic) le
  pipeline melspectrogramme + embedding + classifieur d'AudioFeatures/Model (Apache-2.0, réimplémentation
  autorisée par la licence — même logique que la copie non protégée de Cohere Transcribe) — jamais deviné
  correct : un test dédié (bundle le vrai fichier audio, traité chunk par chunk comme le fera vraiment
  voice_server.py) a confirmé une correspondance BIT-À-BIT avec `openwakeword.utils.AudioFeatures` officiel
  avant de faire confiance à cette réimplémentation.
  **Vrai bug découvert EN CONSTRUISANT ce corpus, sans lien direct avec le mot d'activation lui-même, mais
  qui affecte potentiellement tout micro dont le débit natif n'est pas 16 kHz (donc du code déjà en
  production) : `scipy.signal.resample_poly` sur un tableau **int16** renvoie du SILENCE TOTAL, sans la
  moindre erreur ni avertissement, quel que soit le ratio ou le contenu (vérifié avec un ton pur ET du bruit
  aléatoire, aux deux ratios 44100→16000 ET 48000→16000 — toujours 0, alors que la MÊME opération sur le
  MÊME signal converti en float64 d'abord donne le résultat attendu).** Découvert parce que le corpus généré
  pour l'entraînement (ré-échantillonné 44,1 kHz -> 16 kHz avec ce même appel, copié depuis
  `make_audio_callback` de `voice_server.py`) donnait un modèle bloqué à un rappel de 0% (toujours "pas
  Jaris") quel que soit l'hyperparamètre ajusté — en creusant (comparaison directe du melspectrogramme
  brut ONNX avant/après transform, puis du signal audio lui-même) le fichier resamplé s'est révélé
  totalement silencieux (RMS = 0), pas juste "mal entraîné". `make_audio_callback` (voice_server.py) a
  exactement le même appel, dans la retombée utilisée quand un micro n'accepte pas 16 kHz directement (USB/
  Bluetooth, cas déjà documenté plus haut) : CORRIGÉ en castant en `float64` avant `resample_poly`, jamais
  vérifié en usage réel avant (aucun micro de ce type rencontré). **Leçon générale, très concrète : une
  fonction scipy/numpy qui accepte un tableau entier SANS lever d'erreur ne veut pas dire qu'elle le traite
  correctement — certaines routines de filtrage supposent silencieusement une entrée en virgule flottante et
  renvoient un résultat FAUX (ici : zéro partout) sur un entier, sans le moindre signal d'alerte. Toujours
  caster explicitement en float avant un traitement DSP (filtrage, ré-échantillonnage, FFT...), même quand
  la doc ne l'exige pas explicitement en entrée.** Régression : reproduit avec un script minimal (ton pur +
  bruit aléatoire, scipy 1.14.1), pas encore de test automatisé dans `scripts/` (aucune convention Python
  dans la suite de tests existante, uniquement `node --test scripts/test-*.mjs`).


- **Un modèle présent dans Git peut manquer dans l’application installée** : en v0.5.0, le filtre
  `extraResources` ne copiait que les fichiers Python et requirements.txt, excluant les trois modèles
  ONNX du mot « Jaris ». Reproduit sur l’installation réelle : `NoSuchFile` dès le chargement du
  melspectrogramme. Inclure `models/*.onnx` et charger le vrai détecteur depuis les ressources
  empaquetées en CI. Le sidecar ne doit annoncer `ready` qu’après ce chargement ; un échec doit
  émettre `fatal` avec sa cause réelle, sinon l’interface croit l’écoute prête alors que Python quitte.

- **Un score de mot-clé élevé ne prouve pas qu’une voix est présente** : le modèle Jaris 0.5.0
  donne environ 0,999 sur du silence numérique. Exiger un niveau sonore récent suffisant, avec
  le seuil déjà utilisé pour la capture vocale ; conserver une fenêtre pour ne pas perdre un
  score qui monte juste après la fin du mot. Tester silence, bruit faible et mot prononcé.

- **Bloquer le silence ne valide pas un détecteur de mot-clé** : après v0.5.1, Léo constatait
  une activation dès qu’il parlait. Reproduit avec météo, nombres et Paris. Un contrôle RMS vérifie
  seulement qu’il y a du son, jamais que le nom est prononcé. Le score ONNX reste un candidat ;
  confirmer le nom par la transcription locale déjà chargée avant tout événement wake. Conserver
  les 3 secondes récentes et 640 ms après le candidat pour finir le mot sans perdre la demande.
  Échec ou absence du nom : aucune activation. La touche + contourne cette confirmation.
  Tester des phrases négatives, pas seulement silence et mot positif. La vérification ajoute un
  délai et un coût de transcription ; ne pas présenter cette solution comme un classifieur réentraîné.

- **La confirmation par transcription de v0.5.2 (ci-dessus) résolvait les faux positifs mais en créait un
  autre : Léo a rapporté "il s'active meme pas quand je dit jaris il s'active jamais" juste après.** Diagnostic
  vérifié pour de vrai, pas deviné : téléchargé le vrai modèle Cohere Transcribe dans un venv jetable et
  transcrit 25 échantillons TTS "Jaris" frais (jamais vus à l'entraînement) — AUCUN bug de timing (le
  candidat ONNX arrive bien dans la fenêtre des 3s gardées par `WakeConfirmation`, confirmé par une
  simulation chunk par chunk de toute la boucle), mais `WAKE_NAME` (`\b(?:jaris|jarice|jarisse)\b`, la liste
  de graphies exactes de v0.5.2) ratait 33-40% des vraies transcriptions : Cohere rend "Jaris" de façon très
  variable ("Jarissa", "Jariste", "Jarisses"...), toutes avec le préfixe COMMUN "jari" (pas "jaris" : "Jarice"
  n'a pas de "s"). **Corrigé en généralisant le motif à `\bjari\w*\b`** (préfixe + n'importe quelle
  terminaison) plutôt que d'allonger la liste à chaque nouvelle graphie découverte — même leçon que le
  détecteur de promesse d'action dans assistant.ts : détecter le PATRON plutôt qu'un mot précis. Reste
  strict sur le préfixe lui-même : "jarvis" (préfixe "jarv") et surtout "j'arrive"/"j'arrise" (préfixe
  "arriv"/"arris", une confusion RÉELLE et fréquente avec un mot français très courant, ~24% des
  transcriptions même après ce correctif) ne matchent jamais — ajouter "j'arrive" à la liste acceptée aurait
  fait activer Jaris sur une phrase innocente ("j'arrive dans 5 minutes"), un risque jugé pire qu'un rappel
  imparfait. **Limite acceptée, pas résolue** : "Jaris" reste phonétiquement proche d'un vrai mot français
  très courant, aucun correctif de regex ne peut fermer cet écart — d'où l'ajout, à la même étape, d'un
  onglet Options → Activation pour que Léo garde la touche "+"/le clic sur l'orbe comme filets fiables. Un
  `else` manquant dans voice_server.py (aucun log quand la confirmation REJETTE un candidat, seulement
  quand elle réussit) a aussi été ajouté : sans lui, impossible de savoir pourquoi une activation ratait
  sans relire le code. Régression : `python scripts/test-wake-confirmation.py`.
- **"ajoute dans une option un truc activation... activer jaris avec la touche plus et en disant jaris ou
  juste en cliquant sur jaris le cecle" (Léo, étape 81)** : nouvel onglet Options → Activation, 3 cases
  indépendantes (absent/true par défaut chacune, même convention que `soundEffectsEnabled`) —
  `activationKeyEnabled`/`activationOrbClickEnabled` sont de simples champs du profil relus À LA VOLÉE côté
  renderer (App.tsx, `window.jaris.getProfile()` à chaque pression de "+"/clic sur l'orbe, même pattern que
  `playSoundCueIfEnabled` dans soundDesign.ts) — aucun redémarrage nécessaire, contrairement à
  `activationWakeWordEnabled` qui redémarre tout le pipeline vocal (`setWakewordEnabled`, main.ts, même
  raison que `setAudioInputDevice` : le sidecar Python décide de charger le détecteur ONNX une seule fois, à
  son démarrage, `--wakeword-disabled`). **Bug PRÉ-EXISTANT trouvé en cherchant où ajouter le clic sur
  l'orbe** : l'astuce affichée sur l'écran d'accueil ("Astuce : tape deux fois dans les mains...") référençait
  encore le double clap RETIRÉ à l'étape 80 — jamais repéré par le grep sur le mot "clap" lui-même (cette
  phrase ne le contient pas), preuve qu'un grep-sweep après un retrait doit aussi chercher des paraphrases
  évidentes du comportement retiré, pas seulement son nom technique. Vérifié avec un vrai clic Playwright
  (bundle du vrai `OptionsMenu.tsx`, clic bas niveau sur la 3e case, les 2 autres inchangées) que les 3 cases
  existent et se basculent indépendamment, pas juste une relecture du JSX.
- **La case "touche +" (Options → Activation, étape 81) n'avait aucun effet** : Léo l'a signalé juste après
  l'avoir décochée ("je desactive le plus je fait plus sa sactive"). Le correctif de l'étape 81 n'avait gardé
  qu'un seul des DEUX mécanismes qui déclenchent l'écoute sur cette touche : `handleKeyDown` dans App.tsx
  (renderer, ne voit la touche QUE si la fenêtre de Jaris a le focus) ET `globalShortcut.register('numadd',
  ...)` dans main.ts (process principal, un raccourci Windows global qui fonctionne depuis N'IMPORTE QUELLE
  appli, à dessein depuis l'étape 19 — voir le commentaire juste au-dessus de `registerWakeShortcut`). Seul le
  premier avait été gaté par `activationKeyEnabled` ; le second appelait encore `pipeline?.triggerWake()`
  sans la moindre vérification, donc la case ne changeait rien pour Léo, qui presse `+` depuis d'autres
  applis (l'usage normal du raccourci GLOBAL, pas depuis la fenêtre de Jaris elle-même). Trouvé par un simple
  `grep -n "globalShortcut\|register("` dans main.ts avant de conclure quoi que ce soit. Corrigé en ajoutant
  la même relecture `getProfile()` (déjà utilisée telle quelle ailleurs dans ce fichier, ex: `setAudioInputDevice`)
  dans le callback de `globalShortcut.register`, avant l'appel à `triggerWake()`. **Leçon générale : quand une
  même action (ici "déclencher l'écoute avec +") est atteignable par PLUSIEURS mécanismes indépendants (un
  raccourci local au renderer ET un raccourci global au process principal), une case "désactiver X" doit
  gater CHAQUE mécanisme séparément — en gater un seul laisse croire que le réglage ne marche pas du tout,
  alors qu'il marche partiellement.**
- **"si je demande a jaris dans l'application, et je diminue la page ça fait ça" (Léo, capture d'écran :
  une simple ligne orange ondulée flottant en haut d'un écran presque noir)** : l'orbe de l'écran Agent vocal
  (App.tsx) avait une taille FIXE (320px, `<JarisOrb emotion={emotion} />` sans prop `size`), centrée par
  flexbox dans `.app.app--voice` — réduire la fenêtre ne rétrécit PAS cet orbe (les navigateurs ne
  redimensionnent pas un enfant de taille fixe en px juste parce que le parent devient trop petit), il se
  fait ROGNÉ par `.app-main` (`overflow: hidden`) dès que la fenêtre passe sous 320px de haut, ne laissant
  visible qu'une fine bande horizontale au milieu de l'anneau irrégulier — exactement la "ligne ondulée" de
  la capture. **Diagnostic vérifié pour de vrai avant tout correctif** : un test Playwright a bundlé le VRAI
  composant `JarisOrb.tsx` dans la vraie structure DOM de App.tsx (`.app-shell > .app-main > .app.app--voice`),
  avec le vrai CSS compilé, réduit la fenêtre à 900x90, et confirmé par screenshot que le rendu obtenu est
  identique à la capture de Léo (bande orange ondulée) — pas deviné. Corrigé en ajoutant `.app__orb-stage`
  (index.css), un conteneur flex (`flex: 1 1 auto; align-self: stretch; min-height: 0`) qui prend exactement
  l'espace RÉELLEMENT restant dans `.app--voice` une fois le statut et l'astuce posés (mesuré par la mise en
  page CSS elle-même, pas une marge devinée), observé par un `ResizeObserver` (App.tsx, `orbStageRef`, en
  callback ref — même technique que l'orbe du sélecteur de voix à l'étape 77, pour la même raison : se
  redéclenche à la présence réelle du nœud DOM) qui clampe la prop `size` de `JarisOrb` entre 24 et 320px
  selon l'espace dispo. Revérifié avec le même test Playwright : la fenêtre normale garde l'orbe à 320px
  (aucune régression), une fenêtre très réduite le fait rétrécir proprement (jusqu'au rendu minimal simplifié
  de JarisOrb en dessous de 48px) plutôt que de le laisser se faire rogner en forme cassée. Un clic réel
  Playwright sur le canvas confirme que `onClick` (une des 3 méthodes d'activation, étape 81) fonctionne
  toujours après l'ajout du conteneur `.app__orb-stage`.
- **Suite immédiate du correctif ci-dessus : "quand il réfléchit ça fait ça un petit bug mais après quand il
  repond il est normal" (Léo)** — le clampage de taille de l'orbe (`.app__orb-stage`/`ResizeObserver`)
  fonctionnait, mais SANS transition CSS : dès que `.app__conversation` apparaît (le transcript, connu dès le
  début de "réfléchit", avant même la réponse), il prend de la place sur `.app--voice` et l'orbe change de
  taille — un JS qui réassigne `canvas.width`/`style.width` instantanément, sans la moindre animation.
  **Reproduit pour de vrai avant tout correctif** : un test Playwright a rejoué exactement idle -> thinking
  (transcript) -> happy (reply) dans une fenêtre réduite, et confirmé que la taille de l'orbe saute d'un coup
  sec (40px -> 24px) SANS aucune valeur intermédiaire, exactement au moment où le transcript apparaît — pas
  de bug aléatoire, un vrai saut instantané, perçu comme "un petit bug" pile pendant que Jaris réfléchit.
  Corrigé en ajoutant `transition: width 0.2s ease, height 0.2s ease` à `.jaris-orb` ET `.jaris-orb canvas`
  (index.css) — les DEUX éléments, pas un seul, car chacun a sa propre taille en pixels fixée indépendamment
  par JS (le div par le prop `size` de React, le canvas par `JarisOrb.tsx`) : n'animer que l'un des deux
  aurait laissé l'autre sauter pendant que le premier rétrécit en douceur, créant un décalage visible entre
  la boîte et son contenu. Revérifié avec le même test : `canvas.width` (résolution) passe toujours
  instantanément à la valeur finale (comportement JS normal, inchangé), mais la taille AFFICHÉE
  (`getBoundingClientRect`) interpole bien 40 -> ~24 sur environ 200ms au lieu d'un saut sec — confirmé par
  échantillonnage à 165ms d'intervalle pendant la transition, pas juste par screenshot avant/après. Repris
  aussi dans le bloc `prefers-reduced-motion: reduce` déjà présent pour `.jaris-orb`, comme l'animation de
  pop-in au montage. **Leçon générale : un `ResizeObserver` qui clampe une taille pour éviter un rognage
  (défaut du correctif précédent) peut lui-même introduire un défaut différent — un saut visuel sec à chaque
  recalcul — si le changement de taille n'est jamais animé.** Toujours vérifier le comportement PENDANT la
  transition (valeurs intermédiaires), pas seulement l'état de départ et d'arrivée.

- **La MÊME "ligne ondulée" rapportée 3 fois de suite, et mes 2 premiers correctifs visaient le mauvais
  écran (étapes 83-84, v0.5.5/v0.5.6) : le vrai coupable était le WIDGET, pas la fenêtre principale.** Léo a
  fini par donner la précision qui change tout : "c'est quand jaris écoute et je diminue jaris, et ça fait sa
  avec google chatgpt claude partout" — "diminuer" = RÉDUIRE la fenêtre (pas redimensionner), "partout" = la
  forme flotte par-dessus les autres applis, donc c'est la fenêtre widget always-on-top, et la couleur CYAN
  de sa capture correspond à `listening` (#37e2ff) dans EMOTION_STYLES, pas à `thinking` (orange) comme je
  l'avais supposé à l'étape 84. Cause réelle : `showWidgetWindow` (main.ts) forçait TOUJOURS la fenêtre
  native à la taille repliée (`positionWidgetWindow(widgetWindow, false)`, 48px de haut + `setShape` à
  84x48), sur une hypothèse écrite noir sur blanc dans son propre commentaire — "Jaris vient de se replier
  depuis un moment calme... jamais en pleine écoute/réponse" — alors que le RENDERER, lui, choisit
  déplié/replié uniquement d'après l'émotion (`widgetCollapsed = emotion === 'idle'`, App.tsx) et dessinait
  donc un orbe de 160px (WIDGET_ORB_EXPANDED_SIZE) dans une fenêtre de 48px. Réduire Jaris pendant qu'il
  écoute mettait donc les deux en contradiction directe. **Vérifié pour de vrai, pas déduit** : un test
  Playwright avec le vrai DOM du widget et le vrai CSS compilé mesure 20% seulement de l'orbe visible à
  320x48 (capture obtenue identique à celle de Léo : une fine ligne cyan courbée) contre 100% à 320x460.
  Corrigé en mémorisant l'émotion courante côté main (`lastEmotion`, mis à jour dans `pipeline.on('emotion',
  ...)` même quand le widget est caché) et en s'en servant dans `showWidgetWindow`, pour que la fenêtre
  native parte à la MÊME taille que ce que le renderer va dessiner. **Leçon générale, la plus chère de cette
  série : quand un même symptôme est rapporté 2 fois de suite malgré un correctif, arrêter d'affiner le
  correctif et REMETTRE EN CAUSE le composant qu'on croit en cause** — ici trois indices présents dès la
  première capture (la position en haut de l'écran, la couleur de l'émotion, le fait que ça flotte par-dessus
  une autre appli) désignaient le widget, jamais la fenêtre principale ; je les ai lus comme du "chrome" de
  la capture d'écran au lieu de les traiter comme des données. **Corollaire : deux composants qui décident
  séparément d'un même état (ici "déplié ou replié ?", décidé une fois côté main pour la fenêtre native et
  une fois côté renderer pour le contenu) finissent toujours par se contredire** — les faire dériver de la
  même source (l'émotion) est la seule façon de garantir qu'ils ne divergent pas.

- **Suite du correctif précédent (widget à la bonne taille), dernier reste visible signalé par Léo : "on voit
  d'abord jaris essayer d'aller dans le widget quand il est inactif et apres etre actif mais en 0.5s"** — la
  fenêtre s'ouvrait bien à la bonne taille, mais son CONTENU se dépliait quand même sous les yeux de Léo,
  alors que Jaris écoutait déjà avant le repli. Cause : le widget est CACHÉ (`win.hide()`) la quasi-totalité
  du temps, et Chromium ne peint pas une fenêtre cachée — quand l'émotion passe à 'listening' pendant ce
  temps, React met bien le DOM à jour, mais le dernier état réellement PEINT reste l'état replié. À
  l'affichage, le navigateur reprend donc la transition CSS de `.widget-rest`/`.widget-active` (320ms
  transform + 240ms opacity, index.css) DEPUIS cet état périmé : la pilule "repos" reste visible une
  demi-seconde avant de se déplier. Corrigé par une classe `app--widget-instant` (App.tsx + index.css) qui
  coupe ces transitions tant que `document.visibilityState !== 'visible'` — aucune transition en attente ne
  peut alors se créer pendant que la fenêtre est cachée — et qui n'est retirée qu'après DEUX
  `requestAnimationFrame` (donc une vraie frame peinte dans le bon état), pour que les changements d'émotion
  SUIVANTS, widget déjà à l'écran, gardent leur animation normale. **Vérifié pour de vrai** : test Playwright
  sur le vrai CSS compilé, mesure de `getComputedStyle` 2 frames après le passage replié -> actif — sans la
  classe, `.widget-active` est encore à `opacity 0.053` / `scale 0.379` (la transition se joue bien, c'est
  exactement ce que voyait Léo) ; avec la classe, déjà `opacity 1` / `scale 1`, sans aucune animation. **Ce
  qui reste NON vérifiable ici** : que Chromium se comporte bien ainsi dans une vraie fenêtre Electron cachée
  (pas d'accès Windows dans cet environnement) — le mécanisme du correctif est prouvé, son déclencheur exact
  reste confirmé seulement par le symptôme décrit par Léo. **Leçon générale : une fenêtre cachée continue de
  recevoir les évènements et de mettre son DOM à jour, mais PAS de peindre — tout changement d'état arrivé
  pendant qu'elle était cachée peut donc se rejouer en animation au moment de l'afficher, depuis un état
  périmé.** Couper les transitions tant que `visibilityState` n'est pas `visible` (et ne les rendre qu'après
  une frame peinte) est la parade générique, valable pour n'importe quelle fenêtre qu'on cache/réaffiche.

- **Étape 32 (clics via UI Automation) : conçue pour que la partie NON testable ici soit la plus petite
  possible.** Aucun Windows ni PowerShell dans cet environnement — le script UIA ne peut donc être ni exécuté
  ni même vérifié syntaxiquement (contrairement au CSS/React, vérifiables avec Playwright). Deux décisions
  en découlent, et elles valent pour tout futur ajout PowerShell : (1) le script ne fait QUE LIRE (il renvoie
  les éléments cliquables et leurs positions) — c'est `clickMouse` (inputControl.ts, déjà éprouvé) qui clique,
  et la recherche par nom (`findElementByName`) est du TypeScript pur, donc entièrement testable sans
  Windows ; (2) conséquence directe et gratuite : AUCUNE donnée venant du modèle n'entre dans le script
  PowerShell, donc plus de nom d'élément à échapper, plus de risque d'injection — là où inputControl.ts doit
  encore passer le texte à taper par variable d'environnement. **Leçon générale : quand une partie du code
  n'est pas vérifiable dans l'environnement de dev, déplacer la logique qui manipule des données non fiables
  du côté VÉRIFIABLE, plutôt que d'écrire un test qui fait semblant de couvrir l'autre côté.** Toute
  défaillance du script (fenêtre sans arbre d'accessibilité, erreur, délai de 5s dépassé) renvoie une liste
  VIDE et non une exception : le pilotage retombe alors exactement sur le comportement d'avant (clic en
  pixels), le repli explicitement demandé par l'étape 32.
- **Un élément visé introuvable ne doit PAS faire échouer toute la tâche de pilotage**, contrairement à
  toutes les autres actions de la boucle (computerUse.ts) qui lèvent une erreur pour activer le court-circuit
  d'assistant.ts. Une liste d'accessibilité peut être incomplète ou avoir changé depuis la capture : l'échec
  est noté dans l'historique envoyé au modèle ("Élément X introuvable — reste le clic en pixels") pour qu'il
  VOIE le problème et reprenne en pixels au tour suivant. Abandonner la tâche entière pour un nom mal repris
  aurait rendu la nouveauté plus fragile que ce qu'elle remplace. Borné par MAX_STEPS comme le reste.
- **`ConvertTo-Json` de Windows PowerShell 5.1 n'a pas `-AsArray`** : une liste d'UN SEUL élément ressort en
  objet JSON, pas en tableau d'un élément. Sans garde côté TypeScript (`parseElements`), une fenêtre avec un
  seul bouton cliquable aurait renvoyé une liste vide — le cas le plus simple, donc celui qu'on teste le
  moins spontanément. Testé explicitement (`scripts/test-ui-automation.mjs`).
- **`vm.runInNewContext` (utilisé par tous les tests du dépôt) crée des prototypes Array/Object DIFFÉRENTS de
  ceux du test** : `assert.deepEqual` y échoue alors avec "Values have same structure but are not
  reference-equal" sur des objets pourtant identiques. Les tests existants ne comparaient que des primitives
  (`assert.equal(x.type, ...)`) et n'avaient donc jamais rencontré le piège. Pour comparer des objets
  entiers, charger le module dans le realm courant (`vm.runInThisContext` + wrapper
  `(function (exports, require, module) { ... })`) plutôt que dans un contexte séparé.
- **Les tests de régression du dépôt (`scripts/test-*.mjs`) n'étaient JAMAIS lancés par la CI** — découvert
  en ajoutant ceux de l'étape 32 : le workflow ne faisait que `typecheck` + `dist` + les tests Python du mot
  d'activation. Chaque correctif documentait pourtant sa ligne "Régression : node --test ...", sans que rien
  n'empêche de publier un installeur qui les casse. Ajouté `npm test` (script `package.json`, glob ENTRE
  GUILLEMETS pour que ce soit Node et non le shell qui le développe — la CI tourne sous PowerShell) et une
  étape dédiée dans le workflow, juste après `typecheck`. **Leçon générale : écrire un test ne suffit pas, il
  faut vérifier qu'il est réellement exécuté par la CI — un test jamais lancé ne protège de rien.**

- **Suite immédiate de l'étape 32 : "pourquoi le texte est tout en bas" (Léo, capture d'écran)** — le premier
  correctif au rognage de l'orbe (v0.5.5, `.app__orb-stage`) réglait bien le rognage mais avait un effet de
  bord non repéré jusqu'ici : `flex: 1 1 auto` sur ce conteneur lui faisait TOUJOURS occuper tout l'espace
  disponible dans `.app--voice`, ce qui poussait le statut/l'astuce tout en bas de l'écran sur une fenêtre
  normale/grande — l'orbe et le texte, centrés ENSEMBLE comme un seul groupe avant ce premier correctif,
  s'étaient retrouvés séparés aux deux bouts de l'écran. Corrigé en abandonnant le flex-grow : l'orbe redevient
  un enfant DIRECT de `.app` (qui garde son `justify-content: center` d'origine, jamais touché), et un nouveau
  conteneur `.app__voice-footer` regroupe statut/astuce/conversation/avertissement pour que le `ResizeObserver`
  (`voiceLayoutRef`, App.tsx) mesure une seule hauteur ("tout ce qui n'est pas l'orbe") à soustraire de la
  hauteur totale du conteneur, sans jamais faire grandir artificiellement quoi que ce soit. Un seul
  `ResizeObserver` observe À LA FOIS le conteneur ET le footer (measure() relit toujours les deux tailles
  fraîches via `getBoundingClientRect`/`clientHeight`, jamais `entry.contentRect`, donc peu importe lequel
  déclenche le rappel) — remplace les DEUX observations séparées qu'aurait demandées une implémentation plus
  naïve. **Vérifié pour de vrai avec Playwright, pas juste en relisant le CSS** : sur une fenêtre 1300x1080,
  le groupe orbe+footer est bien centré (écart haut/bas < 22px sur 1080px de hauteur) au lieu du texte plaqué
  en bas ; sur une fenêtre réduite (900x220), l'orbe rétrécit toujours sans déborder ; après idle -> thinking
  -> happy, l'orbe reste à 320px et le groupe reste cohérent ; un clic réel sur le canvas déclenche toujours
  `onClick`. **Leçon générale : un correctif qui résout un symptôme (rognage) en donnant TOUT l'espace
  disponible à un élément peut lui-même créer un nouveau symptôme (répartition aux deux bouts de l'écran) —
  toujours revérifier le résultat sur le cas "normal, rien de spécial" après un correctif pensé pour un cas
  extrême (fenêtre réduite), pas seulement le cas extrême lui-même.**
- **Léo a aussi rapporté, dans le même message, un vrai échec d'action : "Ouvre le bloc-notes et écris
  bonjour" a donné "Je vais maintenant utiliser type_text pour écrire cela." puis Jaris s'est rendormi SANS
  jamais taper quoi que ce soit.** `PROMISE_WITHOUT_ACTION` (assistant.ts) existe justement pour ce cas
  précis, mais ratait cette phrase : le motif ne matchait "je vais " que suivi IMMÉDIATEMENT d'un pronom de
  la liste fixe (le/la/les/lui/y/en) ou d'un verbe en -er/-ir/-re — "maintenant" n'étant ni l'un ni l'autre,
  toute la promesse passait au travers. **Vérifié avec un vrai test du regex sur le texte exact avant de
  corriger** (`current regex matches: false`), même discipline que les deux généralisations précédentes de ce
  même détecteur. Corrigé en généralisant encore une fois le motif : au lieu d'une liste fixe de pronoms, un
  mot connecteur QUELCONQUE (jusqu'à 3 : "maintenant", "simplement", "tout de suite"...) est maintenant
  accepté entre "je vais" et le verbe — les pronoms explicites étaient déjà un cas particulier de "un mot
  quelconque avant le verbe", inutile de les lister à part une fois ce cas général géré. Chaque mot connecteur
  est vérifié pour ne PAS contenir de ponctuation de fin de phrase (`.`/`!`/`?`), sinon le motif pourrait
  sauter par-dessus une vraie fin de phrase et matcher le verbe d'une phrase suivante sans rapport — testé
  explicitement ("je vais bien. je dois partir chercher..." doit rester SANS match, "partir" appartenant à
  "je dois", pas à "je vais"). `PROMISE_WITHOUT_ACTION` sortie de `converse()` vers le niveau module et
  exportée, pour être testable directement (`scripts/test-promise-detection.mjs`) sans avoir à mocker tout
  l'appel Ollama/les outils autour — même raisonnement que le service `uiAutomation.ts` de l'étape 32 (rendre
  vérifiable ce qui peut l'être). **Troisième fois que ce même détecteur doit être généralisé pour le même
  type de lacune (un mot-clé/motif précis rate une formulation légèrement différente) : chaque fois, la
  bonne réponse a été de détecter un PATRON plus large plutôt que d'ajouter le cas précis à une liste — ici,
  le patron "je vais [jusqu'à 3 mots connecteurs] [verbe]" plutôt que d'ajouter "maintenant" à une liste de
  pronoms qui aurait fallu réenrichir à chaque nouvel adverbe découvert en usage réel.**

- **Suite immédiate du correctif ci-dessus : Léo a retrouvé le MÊME type de bug sous une forme différente,
  cette fois au PASSÉ COMPOSÉ plutôt qu'au futur** — « Ouvre un bloc-notes et écris Bonjour... J'ai ouvert le
  bloc-notes (ou le premier champ texte disponible) et j'ai tapé Bonjour avec type_text. mais il a rien
  ouvert ». `PROMISE_WITHOUT_ACTION` ne pouvait pas attraper ce cas : son motif ne cherche que "je vais
  [verbe]" (futur), alors que cette réponse affirme l'action comme DÉJÀ FAITE ("j'ai ouvert", "j'ai tapé"),
  sans le moindre "je vais". Une généralisation grammaticale à la même façon (un motif uniforme pour TOUS les
  participes passés) ne fonctionne pas ici, contrairement au futur : les infinitifs français se terminent
  TOUS en -er/-ir/-re (motif exploité 3 fois déjà pour ce même détecteur), mais les participes passés n'ont
  AUCUNE terminaison commune (réguliers en -é/-i/-u, irréguliers comme "ouvert"/"fait"/"dit"/"écrit"/"pris"/
  "mis"...) — une liste de participes serait tout aussi incomplète qu'une liste de verbes au futur l'était
  avant sa généralisation. Signal retenu à la place, indépendant du temps grammatical employé : la réponse
  nommait littéralement l'outil interne ("avec type_text") — un utilisateur ne prononce jamais un identifiant
  technique comme celui-ci, donc sa présence dans une réponse SANS appel d'outil ne peut venir que du modèle
  qui a confondu DÉCRIRE l'outil (même en prétendant l'avoir déjà utilisé) et l'appeler réellement. Ajouté
  `findLeakedToolName` (assistant.ts), dérivé de `TOOLS` (`tools.ts`) plutôt que d'une liste recopiée à part
  — un outil ajouté plus tard reste couvert automatiquement, sans jamais resynchroniser quoi que ce soit à la
  main — combiné à `PROMISE_WITHOUT_ACTION` dans la même relance corrective (`nudgedForNoAction`, ex-
  `nudgedForPromise`, renommé pour refléter les deux cas qu'il couvre désormais). Régression :
  `node --test scripts/test-false-completion.mjs`. **Leçon générale : quand une généralisation grammaticale
  qui a bien marché pour UN temps verbal (futur, terminaisons uniformes) ne s'étend pas à un autre temps
  (passé composé, terminaisons irrégulières), chercher un signal DIFFÉRENT de la grammaire elle-même plutôt
  que de forcer une liste de participes à énumérer — ici, le nom de l'outil qui fuite dans le texte est
  disponible et fiable indépendamment du temps employé par le modèle pour décrire l'action.**

- **Suite immédiate du correctif ci-dessus, 3e variante du même symptôme : cette fois Jaris a réellement
  ouvert une application — mais la MAUVAISE.** Léo, après avoir redemandé : « c'est bon bloc note est ouvert
  avec bonjour, et il m'a ouvert X » (le réseau social X, ex-Twitter) — et confirmé, questions à choix simples
  à l'appui, qu'aucun texte n'a été tapé nulle part. Contrairement aux deux bugs précédents (aucune action du
  tout, puis une action narrée en plus au passé composé), cette fois un VRAI appel d'outil `open_app` a bien
  eu lieu et a bien ouvert quelque chose — juste pas ce qui était demandé, et la réponse finale du modèle a
  ensuite prétendu à tort que "bloc-notes" avec "bonjour" était fait.
  Cause racine trouvée et reproduite par un vrai test AVANT de corriger : `findBestMatch` (appLauncher.ts)
  compare la requête (`q`) à chaque nom d'application via `a.Name.includes(q) || q.includes(a.Name)`. Si `q`
  est une chaîne VIDE (`app_name` omis ou vide dans l'appel d'outil — plausible sur un petit modèle local qui
  oublie parfois un argument requis), `"n'importe quoi".includes('')` vaut TOUJOURS `true` en JavaScript :
  TOUTE application installée matchait donc la condition, et le tri qui départage par le nom le PLUS COURT
  (pensé pour départager des matches légitimes similaires, pas pour ce cas) élisait alors le nom le plus
  court de TOUTE la machine, sans le moindre rapport avec la demande — "X" (1 caractère) gagne mécaniquement
  face à "Bloc-notes" dès que la requête est vide. Confirmé par un test direct (`findBestMatch(apps, '')` ->
  `{Name: 'X'}` sur une liste imitant le cas réel) avant d'écrire le correctif. Corrigé en refusant toute
  correspondance pour une requête vide (`if (!q) return undefined`, avant même la comparaison exacte) —
  `openApp` retombe alors sur son message "aucune application nommée" déjà existant, remplacé ici par un
  message dédié plus clair quand le nom est carrément vide/absent plutôt que manquant simplement. Régression :
  `node --test scripts/test-app-launcher.mjs` (nouveau fichier, `findBestMatch` exportée pour être testée sans
  mocker `listInstalledApps`/PowerShell). **Limite distincte repérée en écrivant le test, PAS corrigée ici**
  (hors du périmètre exact du bug rapporté, pour éviter un correctif spéculatif en plus) : un nom d'application
  très court comme "X" reste sujet à un faux positif par SOUS-CHAÎNE dès que sa lettre apparaît n'importe où
  dans une requête NON vide (ex: une requête contenant la lettre "x" ailleurs) — un risque préexistant, pas
  introduit par ce correctif, à garder en tête si un futur signalement évoque encore une app à nom très court
  ouverte à tort. **Leçon générale : `"chaîne".includes('')` vaut toujours `true` en JavaScript — toute
  fonction de correspondance par sous-chaîne construite sur `.includes()` doit explicitement écarter une
  requête vide en amont, sinon une entrée absente/vide dégénère silencieusement en "tout matche", et un tri
  de départage conçu pour un cas différent (départager des matches déjà légitimes) peut alors élire un résultat
  n'ayant plus aucun rapport avec la demande d'origine.**

- **4e variante, et enfin la cause la plus banale : « même quand je dit ouvre l'application youtube ou bloc
  note il dit c'est lancé mais il lance pas » (Léo).** Une demande pourtant sans ambiguïté, sans texte à
  taper, sans plusieurs étapes — donc plus aucun rapport avec les détecteurs de fausse action des 3 correctifs
  précédents. Deux causes bien distinctes, chacune mesurée avant d'écrire la moindre ligne de correctif :
  1. **`findBestMatch` comparait des orthographes, pas des noms.** La requête vient d'une transcription
     vocale (donc sans trait d'union ni accent) alors que `Get-StartApps` renvoie le libellé Windows exact.
     Mesuré sur une liste imitant un Windows français : "bloc note", "bloc notes", "blocnotes" et
     "parametres" ne matchaient RIEN — seule la graphie exacte "bloc-notes" fonctionnait. Corrigé par une
     normalisation (minuscules, accents retirés, ponctuation en espaces) plus une petite table d'alias de
     LANGUE (`LOCALIZED_ALIASES`) pour les applications intégrées dont le libellé dépend de la langue de
     Windows : "notepad" ne matche "Bloc-notes" par aucune normalisation possible, c'est une question de
     langue, pas d'orthographe — et l'alias joue dans les deux sens, donc le correctif tient que Windows soit
     en français ou en anglais (information qu'on n'a jamais eue sur sa machine).
  2. **Le modèle annonçait "c'est lancé" par dessus l'échec.** `openApp` renvoie son échec comme une simple
     chaîne (jamais une exception), donc le court-circuit d'`assistant.ts` — qui ne se déclenche que sur une
     exception — ne s'appliquait pas : le message partait au modèle comme un résultat d'outil ordinaire, et
     le petit modèle local répondait quand même un succès par dessus. Exactement le travers déjà corrigé pour
     le dépannage halluciné par dessus une erreur SearXNG. Corrigé par un court-circuit dédié (même forme que
     celui de `look_at_screen`) : dès qu'`open_app` ne renvoie pas son message de succès, ce message devient
     la réponse finale, sans repasser par le modèle. Bénéfice secondaire important : sur une demande en
     plusieurs étapes ("ouvre le bloc-notes ET écris bonjour"), ça empêche aussi d'enchaîner sur `type_text`
     alors qu'aucune application n'a été ouverte — le texte serait parti dans la fenêtre au hasard qui a le
     focus. Le littéral `'a été lancé.'`, jusqu'ici recopié dans dependencyServices.ts, est devenu
     `APP_LAUNCHED_SUFFIX`/`didAppLaunch` : une seule définition de "l'application a VRAIMENT démarré",
     partagée par les deux appelants.
  **Piège majeur du correctif 1, attrapé en le testant avant de livrer, PAS en relecture** : la normalisation
  rend le matching plus permissif, donc elle a AGGRAVÉ la faiblesse laissée de côté au correctif précédent
  (un nom d'application d'une seule lettre matchant par sous-chaîne). Mesuré : "ouvre explorateur", "excel"
  et "le fichier texte" élisaient TOUS "X" — l'app que Léo a réellement installée, et déjà ouverte à tort une
  fois. Livrer la normalisation seule aurait donc rendu son bug d'origine PLUS fréquent, pas moins. Corrigé
  en comparant des MOTS entiers (`containsWords`, avec tolérance de préfixe sur le dernier mot pour le
  pluriel, et une longueur minimale de 3 pour tout fragment) et en remplaçant le "le nom le plus court gagne"
  par un vrai classement en deux temps : d'abord les applications dont le nom couvre TOUTE la demande (la
  plus courte gagne, celle qui ajoute le moins), sinon celles dont le nom est contenu DANS la demande (la
  plus longue gagne, celle qui en explique le plus — sans quoi "bloc notes" élirait une app "Notes" plutôt
  que "Bloc-notes"). Régression : `node --test scripts/test-app-launcher.mjs` (27 cas).
  **Leçon générale : rendre un appariement plus tolérant est rarement neutre — chaque assouplissement élargit
  aussi ce qui matche PAR ERREUR, et il faut re-tester les faux positifs connus (surtout ceux déjà notés comme
  "limite acceptée" à une étape précédente) AVANT de livrer l'assouplissement, pas après le prochain
  signalement.** Corollaire, valable au-delà de ce fichier : un tri de départage (ici "le nom le plus court")
  n'est valide que pour les candidats qu'il était censé départager — dès que la façon de sélectionner les
  candidats change, revérifier que le critère de départage a toujours un sens.

## Commandes utiles

```
npm run typecheck   # tsc, node + web, sans build complet
npm test            # tests de régression (scripts/test-*.mjs), aussi lancés par la CI
npm run build       # electron-vite build (rapide, sans générer l'installeur)
npm run dist        # build complet + installeur .exe (long, normalement laissé à la CI)
```

`docker-compose.yml` + `searxng/settings.yml` : recherche web locale (SearXNG). Nécessite Docker Desktop
lancé ; `searxng/settings.yml` n'est relu par SearXNG qu'au démarrage du conteneur — un changement de config
nécessite `docker compose restart`, pas seulement `docker compose up -d`.
