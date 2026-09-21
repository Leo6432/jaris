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

Juste avant le bump de version, faire `git fetch origin claude/jaris-local-ai-assistant-a2drk4` et relire la
version distante : plusieurs IA peuvent publier sur cette branche pendant une même session. Toujours partir de
la dernière version distante et intégrer ses commits avant de choisir X.Y.Z+1, sinon deux travaux distincts
peuvent annoncer ou tenter de publier le même numéro.

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
- **Afficher qu'un modèle est « utilisé » doit lire le profil réellement enregistré**, pas recalculer ce que
  le scan choisirait aujourd'hui : le matériel, les benchmarks ou les candidats peuvent avoir changé depuis
  le dernier scan, tandis que les services utilisent encore `profile.models`, `profile.visionModel` et
  `profile.codeModel`. Le recalcul ne sert que de repli avant la création d'un profil.
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
    entre-temps — pas une liste de conversations séparées à choisir. **PLUS VRAI DEPUIS L'ÉTAPE 96** (voir
    plus bas) : Léo a demandé plusieurs conversations ; la continuité voix <-> écrit décrite ici vaut
    désormais pour la conversation ACTIVE.
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

- **Image jointe dans le Chat et en mode Code (étape 91, demande de Léo : "ajoute la possibilité d'envoyer
  une image dans le chat et dans le code").** Contrainte structurante identifiée AVANT de coder, pas après :
  ni le modèle de conversation ni le modèle de code ne savent lire une image, et le modèle de vision ne tient
  pas en VRAM en même temps qu'eux sur une carte 8 Go — contrainte déjà documentée pour `look_at_screen`.
  D'où deux chemins, tous les deux STRICTEMENT séquentiels (jamais deux modèles chargés à la fois) :
  - **Chat** : l'image + la question partent au modèle de VISION (`describeImage`), et sa réponse est
    renvoyée telle quelle, sans repasser par le modèle de conversation — exactement le court-circuit qui
    existe déjà pour `look_at_screen`, pour la même raison (reformuler forcerait un rechargement complet de
    modèle pour un gain nul).
  - **Code** : l'image est d'abord traduite en TEXTE par le modèle de vision (`IMAGE_FOR_CODE_SYSTEM_PROMPT`,
    qui demande une description exploitable pour reconstruire, pas un commentaire libre), PUIS ce texte seul
    entre dans le prompt du modèle de code. Le modèle de code ne reçoit donc jamais d'image.
  `describeImage` (vision.ts) était privée : exportée avec un `systemPrompt` OPTIONNEL dont le défaut est le
  prompt d'origine — `look_at_screen` garde donc un comportement rigoureusement identique à avant, seuls les
  nouveaux appelants passent un autre prompt.
  **L'image n'est jamais envoyée telle quelle** : `src/lib/imageAttachment.ts` la réduit à 1280px de large
  (même limite que les captures d'écran de vision.ts, et pour la même raison) et la ré-encode en JPEG avant
  de la faire traverser l'IPC puis la requête Ollama. Le calcul de la taille cible est une fonction PURE
  isolée exprès (`computeScaledSize`) pour être testable sans navigateur — même principe que
  `findElementByName` (uiAutomation.ts) : mettre du côté vérifiable ce qui peut l'être.
  **La vignette n'est PAS persistée** : `ChatMessage.image` sert uniquement à l'affichage de la session en
  cours. Écrire du base64 dans `conversation-history.json` le ferait grossir de plusieurs mégaoctets par
  image, pour une vignette que personne ne relit — seuls la question et la réponse (du texte) y entrent, ce
  qui suffit à garder le contexte d'une question de suivi.
  **Duplication de type attrapée par le typecheck** : la signature de `window.jaris` est recopiée À LA MAIN
  dans `src/global.d.ts`, séparément de `electron/preload.ts` — modifier le preload seul ne suffit donc
  jamais côté renderer. Le piège générique "un type partagé dupliqué ailleurs" est déjà documenté plus haut
  pour `shared/ipc.ts`/`hardwareScan.ts` : `global.d.ts` est le troisième endroit concerné.
  **Trois pièges rencontrés en écrivant le test navigateur** (chacun coûte sinon un diagnostic à l'aveugle) :
  (1) sans `--jsx=automatic`, esbuild compile le JSX en `React.createElement` alors que le projet est en
  runtime JSX automatique (React 18) — la page plante sur "React is not defined", le composant ne se monte
  jamais, et le test semble juste "bloqué" sur son premier `waitForSelector` sans jamais dire pourquoi ;
  (2) sans `--alias:@=src`, esbuild ne résout pas les imports `@/...` du projet ; (3) sans try/finally autour
  du navigateur, une assertion qui échoue laisse Chromium ouvert, ses processus gardent la boucle
  d'évènements de Node vivante, et `node --test` ne se termine JAMAIS — l'échec n'est jamais affiché.
  **Playwright n'est pas une dépendance du projet** (présent en dev, absent du runner Windows de la CI) :
  `scripts/test-image-attachment-ui.mjs` le charge donc en import DYNAMIQUE dans un try/catch et marque ses
  tests `skip` avec une raison explicite quand il manque — sans ça, `npm test` (qui prend TOUS les
  `scripts/test-*.mjs`, CI comprise) échouerait en CI sur un simple import. Marqué "ignoré" et pas
  silencieusement vert, pour rester cohérent avec la leçon déjà tirée ici : un test qu'on croit passé alors
  qu'il n'a rien exécuté ne protège de rien.
  Régression : `node --test scripts/test-image-attachment.mjs` (calcul pur), `scripts/test-image-attachment-ui.mjs`
  (vrais composants ChatPanel ET CodePanel dans un navigateur : réduction réelle 2000px -> 1280px vérifiée sur
  l'image RÉELLEMENT transmise, aperçu, envoi possible sans texte, fichier non-image refusé), plus le routage
  backend dans `scripts/test-chat-session-restore.mjs` (une image ne doit JAMAIS appeler `converse()`) et
  `scripts/test-codegen-generate.mjs` (le modèle de code reçoit la description, jamais l'image).
  **Non vérifié ici, à confirmer par Léo en usage réel** : la QUALITÉ des réponses du modèle de vision sur de
  vraies images (photo, capture, maquette) — c'est un jugement de qualité perçue, et la leçon Kokoro/orbe
  vaut aussi ici : seuls de vrais essais sur sa machine tranchent.

- **Passe de design sur le composeur du Chat et du mode Code (étape 92, demande de Léo : "Travaille sur le
  ux visiuel met pas des bouton image, améliorer tout le design").** Deux vrais défauts, constatés sur une
  CAPTURE RÉELLE du rendu compilé (bundle esbuild des vrais composants + vrai CSS, pas une relecture du
  code) avant de toucher quoi que ce soit :
  1. **Le bouton "Image" en toutes lettres avait le même poids visuel que l'action principale** — et en mode
     Code il paraissait carrément PLUS important qu'elle : l'action secondaire était rendue dans le style
     plein du HUD, tandis que "Générer l'application", désactivée tant qu'aucun texte n'était saisi,
     s'affichait en gris. Remplacé par une icône SVG inline (aucune dépendance, aucun emoji) qui hérite de
     `currentColor`, avec `title`/`aria-label` puisqu'elle n'a plus de libellé.
  2. **Le champ et ses boutons ne formaient pas un objet** : les boutons flottaient sous la ligne de base du
     textarea, chacun avec son propre cadre. Remplacé par UNE carte (`.composer`) qui contient le champ, la
     pièce jointe et la barre d'actions — le focus allume la carte entière (`:focus-within`) au lieu de
     déplacer un contour d'un élément à l'autre.
  **Vraie cause de duplication supprimée au passage** : le composeur existait en DEUX exemplaires (ChatPanel
  et CodePanel), avec la même logique de collage/glisser-déposer/champ fichier recopiée. C'est exactement
  pour ça que les deux écrans avaient déjà divergé visuellement dès le premier ajout. Extrait dans un seul
  `src/components/Composer.tsx` : les deux panneaux se ressemblent désormais PAR CONSTRUCTION, pas par
  discipline — même leçon que `conversationSession.ts` (étape 47) pour l'historique dupliqué.
  **Piège CSS trouvé par la capture, pas en relecture** : le champ gardait un second cadre À L'INTÉRIEUR de
  la carte. Cause : une règle globale `input, textarea, select` (src/index.css) impose `border`/`background`
  avec `!important` — une classe ne peut donc pas la neutraliser. Corrigé en EXCLUANT explicitement le champ
  du composeur de cette règle (`textarea:not(.composer__input)`) plutôt qu'en ajoutant un `!important`
  concurrent : une seule source de vérité reste, et l'exception est lisible là où la règle est écrite.
  **Cohérence plutôt qu'invention** : le bouton d'envoi ne redéfinit PAS son apparence (j'avais d'abord écrit
  un bouton arrondi à lui). Il rejoint la famille de boutons déjà partagée par toute l'app (coins coupés en
  `clip-path`, Rajdhani en majuscules) — Léo a déjà repris ce projet deux fois sur des formes "génériques"
  inventées à côté de l'identité visuelle existante (le cercle lisse du widget, celui du sélecteur de voix) :
  quand une famille de composants existe déjà, s'y raccrocher AVANT d'en créer une nouvelle.
  Vérifié par mesure réelle (pas à l'œil) après coup : le bouton d'envoi reste à 11px à l'intérieur de la
  carte et l'icône fait 34x34 (vraie cible de clic), en 1280px comme en 760px de large, sans défilement
  horizontal, sur les DEUX panneaux. Les 3 tests navigateur de l'étape 91 ont été repointés sur les nouveaux
  noms de classes et passent : ils vérifient donc aussi ce composeur.
  **Périmètre assumé** : seuls le Chat et le mode Code ont été retouchés. L'écran Agent vocal, les Options et
  l'onboarding n'ont PAS été repris cette fois — "améliorer tout le design" en un seul commit aurait été
  invérifiable ; à reprendre écran par écran, avec une capture avant/après à chaque fois.

- **"quand je clique sur image ça met jaris en widget et m'ouvre bien mes fichier" (Léo, étape 93)** : le
  bouton "joindre une image" (étapes 91-92) ouvrait un `<input type="file">` caché côté RENDERER. Le dialogue
  natif que Chromium ouvre alors prend le focus OS, donc `fullWindow` reçoit 'blur' — et `win.on('blur', ...)`
  (étape 73) replie Jaris en widget exactement comme un changement d'application. Le garde qui existe déjà
  pour ce cas précis (`dialogOpen`, ajouté à l'étape 73 pour `chooseModelsLocation`) ne pouvait rien y faire :
  il n'est posé qu'autour des appels `dialog.showOpenDialog` du MAIN process, et un dialogue ouvert par le
  renderer n'est jamais vu par le main. Corrigé en déplaçant le sélecteur d'image vers le main
  (`IPC_CHANNELS.pickImageFile`, main.ts), pour que le mécanisme déjà éprouvé s'applique tel quel plutôt que
  d'en inventer un second. **Alternative écartée volontairement** : laisser l'`<input type="file">` et faire
  prévenir le renderer par IPC avant/après l'ouverture — le drapeau resterait bloqué à `true` pour toute la
  session au moindre chemin qui ne renvoie pas son "c'est fermé" (dialogue annulé, fenêtre rechargée), et
  Jaris ne se replierait alors plus JAMAIS en widget. Encadrer un `await` dans le process qui contrôle le
  dialogue rend cet état impossible. Le fichier n'est que LU côté main : la réduction à 1280px reste côté
  renderer, par la MÊME fonction que le collage et le glisser-déposer (`renderToAttachment`, extraite pour
  ça) — une seule implémentation du redimensionnement, pas deux. Les formats acceptés, jusqu'ici une liste de
  types MIME côté renderer, deviennent une table extension -> MIME PARTAGÉE (`IMAGE_TYPES_BY_EXTENSION`,
  shared/ipc.ts) : le sélecteur natif filtre par extension, le collage teste un type MIME, et deux listes
  séparées auraient fini par diverger. Correctif secondaire au passage, sur le même drapeau : les deux
  `dialogOpen = false` sont maintenant dans un `finally` — une exception du dialogue laissait sinon le
  drapeau bloqué à `true`, avec exactement la conséquence décrite plus haut. Régression :
  `node --test scripts/test-native-dialog-guard.mjs` (test STRUCTUREL : vérifie que tout `showOpenDialog` du
  main est encadré, que le drapeau est toujours relâché dans un `finally`, que 'blur' le consulte, et
  qu'aucun `<input type="file">` ne revient côté renderer — pas le comportement réel de Windows,
  invérifiable ici) plus `scripts/test-image-attachment-ui.mjs` (vrai clic sur le bouton dans un navigateur :
  image choisie, dialogue annulé, format refusé). Les 4 assertions ont été vérifiées une par une en
  réintroduisant temporairement chaque oubli, pour ne pas garder un test qui passerait quoi qu'il arrive.
  **Leçon générale : un garde ajouté pour un cas précis ne protège QUE les chemins qui passent par le code
  qu'il encadre — avant d'ajouter une nouvelle façon de déclencher le même genre d'action (ici : ouvrir un
  dialogue natif), vérifier si un garde existe déjà pour ce comportement, et faire passer le nouveau chemin
  PAR lui plutôt que de le recréer à côté.** Même famille que la touche "+" gatée d'un seul côté sur deux
  (étape 82) et que le check WSL placé dans une branche jamais atteinte.

- **"le design de code c'est mal fait, on comprend pas trop les truc recent en bas apres il ya des bouton"
  (Léo, étape 94)** — deux défauts bien distincts, tous les deux constatés sur une CAPTURE RÉELLE du rendu
  compilé (vrai composant bundlé + vrai CSS) avant de toucher au code, jamais devinés en relisant le JSX :
  1. **Écran de départ** : la liste des applications déjà générées était une suite de lignes posées sur le
     fond, sous une micro-étiquette "RÉCENTS" (0,7rem, `--hud-text-faint`), au-dessus d'un vide occupant les
     deux tiers de l'écran — rien ne disait ce qu'étaient ces lignes ni qu'un clic les rouvrait. Chaque ligne
     affichait `toLocaleString('fr-FR')` brut, soit "14/09/2026 15:11:52" : une date à la SECONDE, plus
     longue que le nom de l'application à côté. Et `text-transform: capitalize` écrivait "Liste De Courses".
     Corrigé en faisant de cette liste un vrai panneau titré ("Tes applications" + "Clique pour rouvrir"),
     rattaché à la famille HUD DÉJÀ partagée (fond `--hud-panel-raised`, bordure, équerres d'angle — les
     mêmes sélecteurs que `.chat-panel__message`/`.code-panel__result`, aucun style inventé à côté), avec
     des lignes sans cadre individuel (le panneau porte déjà une bordure : en remettre une par ligne
     empilait deux boîtes pour une seule information), un chevron de fin de ligne, et une date lisible
     (`formatRecentDate`, src/lib/formatRecentDate.ts : "Aujourd'hui, 15:11" / "Hier, 22:40" / "2 septembre").
     Une phrase d'introduction explique enfin ce que fait ce mode, comme `.chat-panel__empty` le fait déjà
     côté Chat — sans application chargée, c'est le seul contenu de l'écran, il ne pouvait pas rester muet.
  2. **Écran avec une application chargée** : QUATRE bandes s'empilaient avant d'atteindre l'application
     elle-même (composeur, deux gros boutons pleine largeur, onglets Aperçu/Code, puis enfin l'aperçu) —
     c'est le "après il y a des boutons" de Léo. Les deux actions secondaires rejoignent la ligne des
     onglets, à droite et en plus petit, À L'INTÉRIEUR du panneau de l'application : deux bandes au lieu de
     quatre. Elles gardent la famille de boutons de toute l'app (coins coupés, Rajdhani) — même leçon que le
     bouton d'envoi à l'étape 92 : se raccrocher à une famille existante plutôt qu'en inventer une.
     Le chemin complet du dossier, jusqu'ici écrit en toutes lettres sur deux lignes serrées en bas d'écran,
     passe en infobulle du bouton "Ouvrir le dossier", qui fait mieux le travail.
  **`formatRecentDate` est une fonction PURE** (l'instant courant est un paramètre, jamais un `new Date()`
  caché dedans) pour être testable sans navigateur — même principe que `computeScaledSize`. **Piège attrapé
  en l'écrivant** : calculer "aujourd'hui/hier" par `(maintenant - date) / 86400000` est FAUX — hier 23h50 vu
  depuis aujourd'hui 00h10 donne 0 jour, donc "Aujourd'hui" pour quelque chose fait la veille. Le calcul se
  fait sur des jours de CALENDRIER (minuit à minuit), et ce cas précis est un test à part entière.
  Régression : `node --test scripts/test-format-recent-date.mjs` (6 cas, dont le passage de minuit et un
  horodatage invalide) et `scripts/test-code-panel-ui.mjs` (vrai navigateur : la liste est un panneau titré
  aux dates sans secondes, un clic rouvre bien l'application, et onglets + actions restent sur UNE seule
  barre dans le panneau, à 1280px comme à 760px, sans débordement horizontal). Les assertions de mise en
  page ont été vérifiées en REMETTANT temporairement l'ancien empilement (barre en colonne, puis actions
  ressorties du panneau) : le test échoue bien dans les deux cas, il ne passerait pas quoi qu'il arrive.
  **Leçon générale : un écran "vide" n'est pas un détail cosmétique** — c'est le seul moment où l'utilisateur
  n'a aucun contexte pour deviner à quoi sert l'écran, donc celui qui mérite le plus une phrase d'explication
  et une hiérarchie visible ; ici il était resté tel quel depuis l'étape 30 alors que tout le reste du mode
  Code avait été repris plusieurs fois.

- **Supprimer une application générée (étape 95, demande de Léo : "pouvoir supprimer des application dans
  code")** — la liste "Tes applications" s'allongeait sans aucun moyen de faire le ménage autrement qu'en
  ouvrant l'explorateur de fichiers. Trois décisions structurantes :
  1. **Le chemin vient du RENDERER, il est donc revérifié côté main avant tout effacement**
     (`deleteGeneratedApp`, codeGenerator.ts) : un `rm -r` est l'opération la plus irréversible de tout le
     programme. Seul un ENFANT DIRECT du dossier des applications générées est accepté — ni le dossier
     lui-même (qui effacerait TOUT d'un coup), ni un sous-dossier plus profond, ni quoi que ce soit en
     dehors, ni une remontée par `..`. Le garde repose sur `resolve`/`relative`/`isAbsolute`/`sep`, jamais
     sur une comparaison de chaînes (`startsWith` sur le dossier parent laisserait passer `..`).
  2. **Confirmation DANS la ligne, jamais un dialogue natif.** Un `dialog.showMessageBox` aurait fait perdre
     le focus à la fenêtre — donc replié Jaris en widget en plein milieu, exactement le bug de l'étape 93.
     La ligne se transforme en "Supprimer « X » définitivement ? [Supprimer] [Annuler]" : aucun dialogue, et
     c'est vérifiable dans un vrai navigateur, contrairement à une fenêtre native.
  3. **La corbeille est un bouton FRÈRE du bouton d'ouverture, pas imbriqué dedans** (du HTML invalide, et
     un clic sur la corbeille aurait aussi ouvert l'application). Le filet de séparation entre les lignes est
     donc passé du bouton au `<li>` : avec deux boutons par ligne, il aurait sinon dessiné deux bouts de
     séparateur côte à côte.
  **Vrai défaut trouvé au passage dans MON propre travail de l'étape 94, en mesurant au lieu de croire** :
  les boutons "Nouvelle application"/"Ouvrir le dossier" étaient censés être "plus petits" que le reste —
  mesurés pour de vrai (`getComputedStyle` sur le CSS compilé), ils étaient restés à la taille pleine
  (13,12px / 9px 20px). La règle de réduction était écrite dans la section "mode Code" du fichier, donc
  AVANT la famille de boutons partagée : à spécificité ÉGALE, c'est la dernière règle du fichier qui gagne,
  et la famille écrasait donc silencieusement la réduction. Même piège pour le bouton rouge de confirmation :
  `.code-panel__recent-confirm button` (une classe + un type, spécificité 0-1-1) l'emportait sur la variante
  `.code-panel__recent-confirm-yes` (0-1-0), qui restait donc cyan au lieu de rouge. Corrigé en déplaçant la
  règle de taille APRÈS la famille, et en donnant une vraie classe à chaque bouton plutôt qu'un sélecteur
  `.conteneur button`. **Leçon générale, valable pour tout ce fichier CSS : quand on ajoute une variante à
  une famille de composants partagée, vérifier (1) que la règle est écrite APRÈS la famille — à spécificité
  égale, l'ordre décide — et (2) qu'elle n'a pas une spécificité PLUS FAIBLE que la règle de base ; un
  sélecteur de base en `.conteneur element` bat toujours une variante en `.classe-modificatrice`. Et le
  vérifier en MESURANT le style calculé, pas en relisant : une règle sans effet ne produit aucune erreur,
  elle est juste ignorée.**
  Régression : `node --test scripts/test-codegen-delete.mjs` (8 cas de garde ; vérifiés en retirant
  temporairement le garde — 7 des 8 échouent alors, donc le test mord bien) et `scripts/test-code-panel-ui.mjs`
  (vrai navigateur : la corbeille seule ne supprime rien, Annuler laisse la ligne intacte, Supprimer retire
  vraiment la ligne, et un clic sur la corbeille n'ouvre jamais l'application).

- **Plusieurs conversations dans le Chat (étape 96, demande de Léo : "avoir plusieurs conversation sur
  chat")** — l'inverse exact du choix documenté depuis l'étape 47 ("Jaris n'a PAS plusieurs fils de
  discussion nommés façon Claude/ChatGPT, une seule conversation continue, à dessein"). Quand une demande
  explicite contredit un choix de conception noté ici, c'est la demande qui gagne : cette entrée remplace
  l'ancienne affirmation, elle ne la contredit pas par accident.
  **Ce qui est PRÉSERVÉ de l'étape 47, et qui décide de toute l'architecture** : le canal VOCAL écrit dans
  la conversation ACTIVE, jamais dans un fil à part. Parler puis enchaîner par écrit continue donc toujours
  la même discussion ; changer de fil dans le Chat change aussi celui que la voix continue. L'alternative
  (un fil dédié à la voix) aurait cassé la propriété la plus utile du mode vocal pour un gain nul.
  **Stockage** : un dossier `conversations/` (un fichier JSON par fil + un `index.json` qui retient les
  titres et lequel est actif) à la place de l'unique `conversation-history.json`. Le plafond de 300 échanges
  devient PAR conversation : global, discuter dans un nouveau fil aurait fini par ronger les messages d'un
  ancien fil auquel on n'a jamais retouché.
  **Migration, le point le plus sensible** : au premier lancement après la mise à jour, l'ancien
  `conversation-history.json` devient la première conversation (titre repris de son premier message, dates
  reprises des échanges eux-mêmes). L'ancien fichier n'est JAMAIS supprimé par la migration — il reste comme
  filet, même si plus rien ne le lit. Léo s'était explicitement inquiété de ça ("j'ai peur que plus on
  avance plus tu vas perdre des données") : c'est vérifié par un test sur un faux disque, pas par relecture.
  Seul "Supprimer l'historique" (Options) l'efface aussi — sinon la migration ressortirait tout juste après
  que Léo a demandé de tout effacer.
  **Titres dérivés du premier message** (`titleFromMessage`, fonction pure testée à part), figés ensuite :
  rien à saisir, et la liste ne danse pas sous les yeux à chaque échange. Deux clics sur "Nouvelle
  conversation" ne créent qu'un seul fil vide (l'actif est réutilisé s'il est déjà vide), et supprimer le
  dernier fil en laisse toujours un : le Chat ne doit jamais se retrouver sans conversation courante.
  **Onglet Historique (Options)** : il montre désormais TOUTES les conversations mélangées, remises dans
  l'ordre du temps — c'est le journal de tout ce qui a été dit, voix comprise, pas la vue du fil en cours
  (celui-là s'affiche dans le Chat). "Ouvrir le dossier" ouvre le dossier des conversations.
  **Côté interface** : une seule ligne au-dessus du fil (nom de la conversation + "Nouvelle conversation"),
  la liste ne s'ouvrant qu'à la demande — le Chat reste une page de discussion, pas un gestionnaire de fils.
  La liste réutilise exactement le vocabulaire de "Tes applications" du mode Code (panneau HUD, lignes sans
  cadre individuel séparées par un filet, corbeille discrète, confirmation dans la ligne) : deux listes qui
  font la même chose doivent se ressembler. La corbeille, identique dans les deux, a été extraite dans
  `src/components/icons.tsx` dès son DEUXIÈME usage plutôt que recopiée.
  **Piège attrapé par les tests, pas en relecture** : `ChatPanel` appelle `listConversations()` au montage ;
  le faux pont preload de `test-image-attachment-ui.mjs` ne fournissait pas ce canal, donc l'appel plantait
  dans l'effet React, le composant ne se montait jamais, et les 3 tests d'image restaient "bloqués" 30
  secondes sur leur premier `waitForSelector` sans jamais dire pourquoi. **Leçon générale : quand un
  composant gagne un nouvel appel IPC au montage, tous les faux ponts preload des tests navigateur EXISTANTS
  doivent le fournir — un canal manquant ne donne pas une erreur lisible, il fait juste expirer le test.**
  Régression : `node --test scripts/test-conversations.mjs` (10 cas sur un faux disque : migration sans
  perte, isolation réelle des fils, titres, suppression, journal global, effacement complet) et
  `scripts/test-chat-conversations-ui.mjs` (vrai navigateur : changer de fil RECHARGE vraiment le fil
  affiché — sans ça le nouveau fil s'ouvrirait avec les messages de l'ancien —, "Nouvelle conversation"
  ouvre un fil vide, et supprimer demande confirmation).
  **Non vérifiable ici** : la migration sur la VRAIE machine de Léo, avec son vrai `conversation-history.json`.

- **`git add -A` sur un arbre de travail qui contient déjà le début du chantier SUIVANT** : un commit
  présenté (et rédigé) comme "correction d'un test uniquement" a en réalité emporté la réécriture en cours
  de `conversationStore.ts`, qui référençait un type pas encore ajouté à `shared/ipc.ts` — la CI a échoué au
  typecheck sur un commit censé ne toucher qu'un fichier de test. **Leçon générale : `git add -A` ne dit pas
  ce qu'il ajoute ; dès qu'un chantier est commencé à côté, vérifier `git status` AVANT de committer et
  stager explicitement les fichiers du correctif en cours** — sinon le message de commit décrit autre chose
  que son contenu, et la vérification (typecheck/CI) porte sur un état que personne n'a voulu.

- **"pourquoi nouvelle conversation est en gris" + "les conversation et code fait comme claude ou chatgpt la
  meme présentation" (Léo, étape 97)** — deux retours dans le même message, l'un est un défaut que j'avais
  livré, l'autre une refonte de mise en page.
  1. **Le bouton gris était un vrai bug, et de MA part.** `.chat-panel__new` avait bien été ajouté à la liste
     de survol et à la règle de taille compacte de la famille de boutons partagée, mais PAS à la règle de
     BASE : le bouton n'avait donc ni fond, ni couleur, ni coins coupés — il restait au style par défaut du
     navigateur (texte blanc, bordure blanche). J'avais "vérifié" mon remplacement avec un `grep -c` qui
     comptait 6 occurrences : le compte était juste, l'emplacement non. **Leçon générale : compter les
     occurrences d'un nom après une modification ne prouve rien sur l'endroit où elles ont atterri** — pour
     une règle CSS, la seule vérification qui vaut est de MESURER le style calculé (`getComputedStyle`) sur
     le CSS compilé, ce qui aurait montré `color: rgb(255,255,255)` et `background-image: none` tout de
     suite. C'est maintenant une assertion de test à part entière.
  2. **Présentation façon Claude/ChatGPT, pour le Chat ET le mode Code.** Le sélecteur déroulant de l'étape
     96 (la liste ne s'ouvrait qu'à la demande) et le panneau "Tes applications" de l'étape 94 (posé sous le
     champ, visible seulement tant qu'aucune application n'était chargée) sont remplacés par UNE colonne de
     gauche permanente : bouton "Nouveau…" en haut, liste en dessous, contenu à droite, champ de saisie EN
     BAS dans les deux écrans (le composeur du mode Code était en haut jusqu'ici). **Un seul composant
     partagé** (`src/components/Workspace.tsx`) plutôt que deux mises en page qui se ressemblent : Léo
     demandait explicitement "la MÊME présentation", et deux copies auraient redivergé exactement comme
     l'avaient fait les deux composeurs avant l'étape 92. La confirmation de suppression, l'état "élément
     actif" et le repli de la colonne vivent dans ce composant, plus dans chaque panneau.
  **Piège CSS trouvé par une mesure, pas en relecture** : à 760px de large, la mise en page débordait de 24px
  (mesuré : `.workspace` faisait 784px dans une fenêtre de 760px). Cause : `min-height: 0` avait été posé sur
  le conteneur flex mais pas `min-width: 0` — un élément flex refuse par défaut de se réduire en dessous de
  la largeur minimale de son contenu, donc la colonne (240px) + le contenu poussaient la fenêtre au lieu de
  la partager. **Leçon générale : sur un conteneur flex HORIZONTAL qui doit pouvoir rétrécir, `min-width: 0`
  est aussi nécessaire que `min-height: 0` l'est en vertical — et ça ne se voit qu'en mesurant une fenêtre
  étroite, jamais sur la fenêtre de développement.**
  Régression : `scripts/test-chat-conversations-ui.mjs` et `scripts/test-code-panel-ui.mjs` (vrai navigateur),
  dont un test dédié "le Chat et le mode Code ont la MÊME présentation" (colonne à gauche du contenu, champ
  de saisie en bas, dernier élément du panneau) et un test qui vérifie que le bouton de création a bien un
  fond et une couleur, pas le style par défaut du navigateur.

- **Le paramètre interne de réflexion d'Ollama (`think`) peut être pris par un petit modèle pour une commande
  `/think` tapée par l'utilisateur.** Constaté après un simple « salut » : le modèle expliquait cette
  commande imaginaire au lieu de saluer. Pour les échanges sociaux entièrement déterministes (salutation,
  « ça va ? »), court-circuiter le modèle avec une réponse locale courte ; une consigne supplémentaire dans
  le prompt ne rendrait pas l'erreur impossible. Exclure aussi du contexte court terme l'ancien couple
  salutation/réponse qui contient `/think`, sans effacer l'historique visible. Régression :
  `scripts/test-assistant-history.mjs`.

- **Le streaming du Chat ne doit pas afficher une réponse factuelle avant que l'obligation de recherche web
  soit satisfaite.** Constaté avec « Qui est Dario Amodei ? » : le modèle rapide a d'abord streamé « je ne
  sais pas, regarde Wikipédia », puis la relance mécanique a appelé `search_web` et remplacé ce brouillon
  2-3 secondes plus tard par la vraie réponse. Pour toute phrase reconnue par `looksLikeKnowledgeQuestion`,
  retenir les fragments de texte côté `converse()` pendant les tours de décision/outils et n'émettre que la
  réponse finale acceptée. Profiter de cette frontière finale pour décoder les entités numériques HTML
  (`&#x20;`) et retirer les émojis spontanés, sauf si l'utilisateur parle lui-même d'un émoji. Régression :
  `scripts/test-assistant-history.mjs`.

- **Les journaux `onLog` du moteur ne sont pas du texte destiné à l'utilisateur.** Le Chat et son widget
  affichaient littéralement `Outil appelé : search_web(...)`, puis `Résultat de l'outil : ...`, avant la
  réponse finale. Garder les journaux complets pour le diagnostic, mais les renderer via un filtre partagé :
  convertir une recherche en « Recherche sur internet… », ignorer son résultat brut, et laisser la vraie
  réponse finale prendre sa place. Ne pas supprimer tout suivi : `computer_use_task` peut durer plusieurs
  minutes et doit toujours donner un signe de vie humain. Régression : `scripts/test-chat-widget-ui.mjs`.

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

- **Une réponse passée sans nom technique d’outil échappe aux détecteurs de promesse** : les phrases réelles « L’application Steam a été ouverte » et « L’application Blocnotes a été ouverte » pouvaient être rendues sans outil. Pour les commandes simples et explicites « ouvre [l’application] X », appeler directement open_app dans le canal partagé, sans demander au modèle de décider. Exclure les commandes composées et négatives. Le signal spawn d’explorer.exe prouve seulement l’envoi de la demande à Windows, pas une fenêtre visible : la réponse directe doit refléter cette limite. Régression : test-assistant-history.mjs, voix et chat.

- **Ouvrir puis écrire ne doit pas se réduire à deux annonces du modèle, ni à une frappe dans le focus courant** : pour une demande explicite de document Bloc-notes, créer un fichier texte indépendant et l’ouvrir, puis confirmer sa fenêtre identifiable. Ne jamais interpoler le texte dicté dans PowerShell ; transmettre uniquement un chemin encodé. La commande composée doit être testée dans la vraie boucle voix/chat avec un service exécuté et avec un service en échec.

- **"quand on demande une mise à jour on ne sait pas quand c'est terminé et des fois c'est bloqué et ça fait
  rien" (Léo, étape 98)** — un seul retour, trois défauts distincts, tous les trois MESURÉS avant d'écrire la
  moindre ligne (une vraie requête HTTP sur chaque installeur, jamais une estimation) :
  1. **Un plafond de DURÉE TOTALE choisi sans jamais mesurer la taille du fichier.** `AbortSignal.timeout(N)`
     passé à `fetch` coupe aussi la lecture du corps : c'est donc un budget pour le téléchargement ENTIER,
     pas un délai de connexion. Confronté aux tailles réelles : Jaris-Setup 98 Mo en 120 s (exige 7 Mbit/s
     SOUTENUS du début à la fin), OllamaSetup 1,5 Go en 30 s pour le bouton "Mettre à jour" (400 Mbit/s :
     cette méthode ne pouvait littéralement JAMAIS aboutir, "Mettre à jour" retombait toujours en silence sur
     winget), et le même 1,5 Go en 120 s pour l'installation d'Ollama au tout premier lancement (100 Mbit/s).
     Un téléchargement qui avançait parfaitement mais lentement était donc coupé en pleine réussite.
     **Remplacé par un délai d'INACTIVITÉ** (`downloadToFile`, electron/services/download.ts) : plus aucun
     plafond de durée totale, seule l'absence de tout nouvel octet pendant une minute abandonne. Ce critère
     ne dépend ni de la taille du fichier ni du débit, donc il n'aura plus jamais à être recalculé quand un
     installeur grossira — contrairement au délai de 10 minutes de Docker Desktop, pourtant calculé à partir
     d'une vraie mesure HEAD à l'étape 60, mais qui exigeait quand même 8 Mbit/s pendant 10 minutes d'affilée.
     **Leçon générale : un délai d'attente sur une opération dont la durée dépend de la taille des données et
     du débit de l'utilisateur doit porter sur l'INACTIVITÉ (rien ne bouge), jamais sur la durée totale —
     sinon le chiffre est forcément faux pour quelqu'un, et il redevient faux à chaque fois que le fichier
     grossit.**
  2. **Aucun signe de vie pendant plusieurs minutes.** Le fichier entier était chargé en mémoire
     (`await response.arrayBuffer()`, 1,5 Go de RAM au passage) puis écrit d'un bloc : rien ne distinguait
     "ça avance" de "c'est planté", exactement ce que décrit Léo. Écrit au fil de l'eau maintenant, avec
     l'avancement renvoyé à l'interface (nouveau canal `updateProgress`, barre de progression réelle dans
     Options → Mise à jour ; octets reçus affichés pendant l'installation d'Ollama). Même famille de défaut
     que `computer_use_task` à l'étape 34 : **toute action qui peut durer plus de quelques secondes doit
     dire où elle en est, un indicateur figé se lit comme un blocage.** La barre réutilise la famille CSS
     déjà partagée (`.options-menu__progress*`) plutôt que d'en inventer une, et c'est vérifié par une
     MESURE du style calculé (leçon du bouton resté gris, étape 97).
  3. **Un installeur TRONQUÉ était lancé comme si de rien n'était.** Une connexion coupée en route laissait
     un `.exe` incomplet, que Jaris lançait juste avant de se fermer : l'installeur ne fait alors rien de
     visible, et il n'y a plus personne pour l'expliquer — le "ça fait rien" de Léo dans sa forme la plus
     trompeuse. La taille reçue est maintenant comparée à celle annoncée (`Content-Length`) AVANT de quitter,
     et le fichier partiel est effacé au lieu d'être laissé en place. **Leçon générale : avant une action
     irréversible qui dépend d'un fichier téléchargé (ici : fermer l'application pour le lancer), vérifier
     que le fichier est complet — un téléchargement interrompu ne lève aucune erreur, il produit juste un
     fichier plus court.**
  Les messages d'échec (délai, disque plein, fichier verrouillé par un antivirus, pas de réseau) sont
  désormais écrits en français et actionnables, et remontés TELS QUELS jusqu'à l'écran plutôt que réhabillés
  en "Échec de la mise à jour : The operation was aborted due to timeout" — même principe que le
  court-circuit d'assistant.ts : personne ne reformule plus un message d'erreur avant de l'afficher, donc il
  doit déjà être lisible par Léo.
  **Défaut de navigation trouvé au passage** : la popup d'accueil disait "Ouvre Options → Modèles pour mettre
  à jour" alors que la mise à jour de Jaris a son propre onglet "Mise à jour" depuis qu'elle a été séparée de
  celle d'Ollama — envoyer quelqu'un sur un onglet où le bouton n'est pas est une autre façon de "ne rien
  faire". Quand une section d'Options est scindée, relire les phrases qui y renvoient depuis ailleurs.
  Régression : `node --test scripts/test-download.mjs scripts/test-app-updater.mjs scripts/test-update-progress-ui.mjs`
  (avancement réellement émis, abandon sur inactivité et non sur durée totale, installeur incomplet qui ne
  ferme JAMAIS Jaris et ne se lance pas, messages en français, barre qui suit le pourcentage dans un vrai
  navigateur). Chaque assertion a été vérifiée en réintroduisant temporairement le défaut correspondant.

- **"quand on demande une mise à jour on ne sait pas quand c'est terminé et des fois c'est bloqué et ça fait
  rien" (Léo, étape 99) — il parlait du MODE CODE, pas de la mise à jour de Jaris.** Le mot "mise à jour"
  désignait ici une DEMANDE DE MODIFICATION d'une application déjà générée ("Que veux-tu changer ?"), pas la
  mise à jour de l'application Jaris elle-même, sur laquelle l'étape 98 venait d'être livrée. Précision
  donnée par Léo juste après ("mince je voulais dire pour code pas pour mis a jour"). **Leçon générale :
  quand un mot du vocabulaire de l'utilisateur correspond exactement à une fonctionnalité existante, ce
  n'est pas une preuve qu'il parle de celle-là** — "mise à jour" veut dire "mettre à jour quelque chose"
  bien avant de désigner l'écran qui porte ce nom. Le correctif de l'étape 98 restait un vrai bug mesuré
  (et a été livré), mais il ne répondait pas à la demande ; une question ciblée aurait coûté une minute.
  Le défaut réel, lui, est le même symptôme sur un autre écran : une génération enchaîne 2 à 4 appels au
  modèle local (écriture, relecture, parfois une relance et une réparation), chacun pouvant durer plusieurs
  minutes, et RIEN n'était envoyé à l'écran entre le début et la fin d'un appel — le journal n'affichait sa
  ligne suivante qu'une fois l'appel terminé. Trois manques, corrigés ensemble :
  1. **Aucune preuve de mouvement.** `chatWithOllama` savait déjà streamer (`onToken`, étape 48, utilisé par
     le Chat) mais le mode Code ne s'en servait pas : il attendait la réponse complète. Il streame
     maintenant, et le nombre de caractères déjà écrits est renvoyé à l'écran — c'est LA différence entre
     "ça travaille" et "c'est bloqué", qu'aucun libellé fixe ne peut donner. Le raisonnement caché
     (`message.thinking`, documenté par l'API Ollama) est relayé par un second callback `onThinking` :
     pendant une longue réflexion, aucun caractère de code n'arrive, et sans ce signal l'écran serait
     indiscernable d'un blocage. Il n'est JAMAIS accumulé dans la réponse rendue, uniquement compté comme
     signe de vie.
  2. **Rien ne disait combien de temps ça pouvait encore durer.** L'étape en cours est numérotée ("étape 2
     sur 2"), et le total monte quand une passe supplémentaire devient nécessaire (relance, réparation)
     plutôt que d'être compté d'avance pour un cas qui n'arrive pas la plupart du temps — jamais une
     "étape 3 sur 2". Un `idleMs` (temps depuis le dernier fragment reçu, renvoyé par un battement de cœur
     d'une seconde) permet de DIRE "rien reçu du modèle depuis 45 s" au lieu de laisser deviner. Un
     chronomètre côté écran ne peut pas jouer ce rôle : il continuerait de tourner même si Ollama était mort.
  3. **Aucun moyen d'arrêter.** Une génération partie ne pouvait plus être interrompue autrement qu'en
     fermant Jaris — c'est le "ça fait rien" dans sa forme la plus frustrante. Un bouton "Arrêter" annule
     désormais le vrai `AbortSignal` passé à chaque appel. **Piège attrapé par le test, pas en relecture :**
     les passes de relecture et de réparation sont volontairement TOLÉRANTES (un échec conserve le premier
     jet) — sans un relais explicite de l'arrêt dans ces deux `catch`, un clic sur "Arrêter" pendant la
     relecture était avalé comme un échec ordinaire et la génération continuait jusqu'au bout. **Leçon
     générale : un `catch` qui "absorbe les échecs pour continuer quand même" doit toujours laisser passer
     l'annulation demandée par l'utilisateur — sinon le bouton d'arrêt marche à certains moments seulement,
     ce qui est pire qu'une absence de bouton.**
  **Deux pièges de realm dans les tests, dont un qui cachait un VRAI défaut de production.** Les tests de ce
  module chargent le code avec `vm.runInNewContext`, qui crée un realm sans les globaux de Node : le
  battement de cœur (`setInterval`) échouait donc sur "setInterval is not defined", un échec qui ne vient pas
  du code testé mais du bac à sable (corrigé en passant les minuteurs au contexte). Surtout, `err instanceof
  Error` répond FALSE pour une erreur créée dans un autre realm — le test d'arrêt a ainsi révélé que la
  détection écrite en premier (`err instanceof Error && err.name === 'AbortError'`) ne tenait pas ; et elle
  est tout aussi fragile en production, où `fetch` rejette avec une `DOMException` sur un signal annulé.
  Remplacée par un contrôle du seul NOM de l'erreur. **Leçon générale : ne jamais faire dépendre la
  détection d'une annulation d'un `instanceof` — la classe change selon le realm et selon ce qui a levé
  l'erreur, le nom `AbortError`, lui, est stable.**
  **Piège de l'étape 96 revécu alors qu'il était déjà écrit ici** : `CodePanel` s'abonne désormais à un
  nouveau canal au montage, et les faux ponts preload des tests navigateur EXISTANTS ne le fournissaient pas
  — le composant ne se montait plus du tout et la suite partait en expiration de 30 s par test, sans le
  moindre message. Le réflexe à garder : après avoir ajouté un `window.jaris.xxx` consommé au montage,
  `grep` les faux ponts des tests avant de lancer la suite.
  Régression : `node --test scripts/test-codegen-progress.mjs scripts/test-format-codegen-progress.mjs
  scripts/test-code-panel-ui.mjs` (avancement réellement émis PENDANT l'appel, numérotation des étapes,
  arrêt effectif y compris pendant la relecture, et dans un vrai navigateur : bandeau affiché, silence
  prolongé annoncé, bouton "Arrêter" réellement habillé par le CSS et suivi d'un journal — pas d'une erreur
  rouge). Chaque assertion a été vérifiée en réintroduisant temporairement le défaut correspondant.

- **"on sait pas trop quand c'est terminé quand on fait un prompt dans code" + "les icones poubelle sont un
  peu mal faite" (Léo, étape 100).** Deux retours d'affilée sur le mode Code, livrés avec l'étape 99 dans la
  même version.
  1. **La fin d'une génération était annoncée ailleurs que là où l'utilisateur regardait.** L'étape 99 avait
     ajouté un bandeau d'avancement bien visible (étape en cours, caractères écrits, chronomètre) — mais la
     FIN, elle, n'était qu'une petite ligne grise de 0,72rem posée sous ce bandeau disparu. Or c'est
     exactement au même endroit que l'œil attend la nouvelle : le bandeau qui bougeait devient donc
     maintenant un bandeau vert "Terminé en 1 min 12 — ton application est à jour", même boîte, même place,
     seule la couleur change (`--hud-ok`, le jeton de succès qui existait déjà — jamais une couleur
     inventée à côté). **Leçon générale : quand une opération longue affiche un indicateur de progression,
     son message de fin doit remplacer CET indicateur au même endroit, pas s'afficher ailleurs** — sinon
     l'utilisateur continue de fixer une zone devenue vide et ne voit pas que c'est fini. Ça compte d'autant
     plus pour une MODIFICATION : l'aperçu obtenu ressemble souvent au précédent, donc le résultat visuel ne
     suffit pas à dire que le travail est terminé.
     Détail corrigé en relisant la capture : la première rédaction disait "l'aperçu ci-dessous est à jour"
     alors que l'aperçu est AU-DESSUS du bandeau. **Une phrase d'interface qui désigne une position devient
     fausse au premier changement de mise en page — préférer une formulation qui n'en dépend pas.**
  2. **La corbeille était mal dessinée, et ça ne se voyait qu'en l'agrandissant.** Trois vrais défauts de
     tracé dans `icons.tsx` : la poignée était un trait flottant AU-DESSUS du couvercle, sans montants pour
     l'y rattacher ; les deux stries intérieures partaient exactement SUR la ligne du couvercle et
     descendaient jusqu'au fond, donc elles traversaient l'un et l'autre au lieu de rester dans le bac ; et
     aucun `strokeLinecap`/`strokeLinejoin`, d'où des angles coupés net à chaque jonction. Redessinée
     (poignée rattachée, stries rentrées en haut comme en bas, extrémités arrondies), passée de 15 à 16px, et
     son opacité de repos relevée de 0,55 à 0,75 : sur une couleur déjà `--hud-text-faint`, elle était
     délavée au point qu'on ne distinguait plus sa forme. **Leçon générale : pour juger un tracé SVG, le
     rendre à très grande taille côte à côte avec l'ancien** — à 15px, un défaut de géométrie ne se lit pas
     comme "mal dessiné" mais comme "un peu sale", et on ne sait pas dire pourquoi. La comparaison agrandie
     rend la cause évidente en une seconde.

- **"c'est bizarre il y a étape 2 etc.. plus un autre rectangle avec [tout le journal]" (Léo, étape 101).**
  Le bandeau d'avancement de l'étape 99 a été ajouté À CÔTÉ du journal existant sans toucher à ce dernier —
  qui annonçait pourtant déjà les mêmes étapes, mot pour mot ("Génération de l'application…", "Relecture du
  code par un second agent…"). Résultat livré : deux cadres empilés racontant la même chose, dont un
  rempli de détails illisibles pour Léo ("les balises <script> ne sont pas appariées (1 ouvrante(s), 0
  fermante(s))") et du chemin Windows complet du dossier. Pire : la condition d'affichage du journal était
  `generating || statusLines.length > 0`, donc un cadre VIDE restait à l'écran pendant toute une génération
  qui n'avait rien à journaliser.
  **Leçon générale, la vraie cause : ajouter un nouvel affichage pour une information ne suffit pas, il faut
  RETIRER celui qu'il remplace.** Un ajout se vérifie facilement (il apparaît, il est joli, le test passe) ;
  la redondance qu'il crée, elle, ne se voit qu'en regardant l'écran ENTIER — ce que fait l'utilisateur, et
  pas un test qui ne vérifie que le nouvel élément. Le réflexe à garder : après avoir ajouté un indicateur,
  chercher qui disait déjà la même chose et le supprimer, puis regarder une capture complète.
  Corrigé en trois temps : (1) toutes les lignes de journal qui doublonnaient une étape du bandeau sont
  supprimées, (2) le détail technique de la vérification devient une seule phrase en français courant ("2
  problème(s) trouvé(s) dans le code, corrigé(s) automatiquement") — ce qui reste vraiment cassé est de
  toute façon déjà affiché à part (`GeneratedApp.issues`), et le chemin complet du dossier est déjà
  l'infobulle du bouton "Ouvrir le dossier" depuis l'étape 94 —, (3) le journal ne s'affiche PLUS QUE s'il
  a quelque chose à dire que le bandeau ne dit pas (modèle à télécharger au premier usage, réparation,
  relance après une réponse inexploitable). Dans le cas nominal, il n'y a donc plus qu'un seul cadre.
  **L'arrêt rejoint la même règle que la fin (étape 100)** : "Génération arrêtée après 12 s" s'affiche
  désormais dans le bandeau lui-même, en neutre (ni vert de succès, ni rouge d'erreur), à la place exacte de
  l'avancement qu'il interrompt — il partait avant dans le journal, c'est-à-dire dans l'autre cadre.
  Régression : `scripts/test-code-panel-ui.mjs`, test "pendant une génération, UN SEUL cadre s'affiche"
  (vérifie qu'aucun second cadre n'existe pendant la génération, qu'il revient quand il a une vraie
  information, et que le journal ne répète plus les étapes). Vérifié en remettant temporairement l'ancienne
  condition d'affichage : le test échoue bien.

- **"quand on est dans code on change de conversation ça change pas Terminé en 7 min 56 — ton application est
  à jour, soit ça a duré la même durée soit c'est un bug" (Léo, étape 102).** C'était bien un bug : le
  bandeau de fin (et le journal) décrivent UNE génération précise, mais ils n'étaient remis à zéro qu'au
  DÉBUT d'une nouvelle génération. Ouvrir une autre application depuis la colonne de gauche laissait donc
  "Terminé en 7 min 56 — ton application est à jour" affiché au-dessus d'une application qui n'avait rien à
  voir — une affirmation fausse sur ce qui est à l'écran, et impossible à distinguer d'une vraie coïncidence
  de durée (c'est exactement le doute qu'a eu Léo).
  **Leçon générale : un état qui décrit UN élément doit être effacé par TOUS les chemins qui changent
  l'élément affiché, pas seulement par celui qui l'a créé.** Ici trois chemins changent l'application
  affichée (générer, ouvrir une application de la liste, "Nouvelle application") et un seul des trois
  effaçait le bandeau. Le correctif ne se contente pas d'ajouter les lignes manquantes dans les deux autres :
  les trois remises à zéro sont regroupées dans une seule fonction (`clearGenerationFeedback`) appelée par
  les trois chemins — recopier trois `setXxx(null)` à la main dans chaque chemin est précisément ce qui
  vient d'être oublié une fois, et le serait encore au prochain chemin ajouté.
  **Famille de défauts à surveiller pour de bon** : c'est le TROISIÈME retour d'affilée (étapes 100, 101,
  102) sur le même bandeau, et les trois viennent de la même racine — un affichage ajouté sans repasser sur
  tout ce qui l'entoure : d'abord la fin annoncée ailleurs que l'avancement (100), puis l'ancien journal
  laissé en double à côté (101), puis l'effacement oublié sur deux chemins sur trois (102). **Après avoir
  ajouté un élément d'interface, faire le tour de son cycle de vie complet : qui l'affiche, qui le met à
  jour, et surtout qui doit le faire DISPARAÎTRE.**
  Régression : `scripts/test-code-panel-ui.mjs` — "changer d'application efface le bandeau de la génération
  précédente" et "« Nouvelle application » repart d'un écran propre". Vérifié en remettant temporairement
  l'ancien code : le premier test échoue bien.

- **"dans le dépôt il n'y a aucune donnée sensible car le dépôt est public ?" (Léo, étape 103) — audit du
  dépôt, puis deux corrections.** Vérifié sur des FAITS plutôt qu'en répondant "tout va bien" : aucune clé
  d'API, aucun jeton, aucune clé privée, ni dans les fichiers actuels ni dans TOUT l'historique des commits
  (un fichier supprimé reste lisible pour toujours dans un dépôt public — chercher aussi dans
  `git log --all -p`, jamais seulement dans l'arbre de travail) ; `.env` bien ignoré et `.env.example` ne
  contenant que des cases à remplir ; la CI n'utilise que le `github.token` que GitHub fournit tout seul.
  Deux vraies trouvailles, corrigées :
  1. **Le port de SearXNG était publié sur TOUTES les interfaces réseau.** `ports: - '8091:8080'`
     (docker-compose.yml) : sans adresse devant, Docker publie sur 0.0.0.0, donc n'importe qui sur le même
     Wi-Fi pouvait atteindre `http://<ip-de-la-machine>:8091` et faire ses recherches à travers la connexion
     de Léo — d'autant que la clé de signature de l'instance (`secret_key`, searxng/settings.yml) est
     publique puisque le dépôt l'est. Corrigé en `'127.0.0.1:8091:8080'`. **Leçon générale : dans un
     docker-compose.yml, `HÔTE:CONTENEUR` sans adresse publie le service sur tout le réseau local, pas
     seulement sur la machine — un service destiné à la machine elle-même doit toujours s'écrire
     `127.0.0.1:HÔTE:CONTENEUR`.** La clé de signature, elle, n'a PAS été changée : une fois le service
     limité à la machine, elle n'est plus atteignable de l'extérieur, et la remplacer supposerait de générer
     puis d'écrire un settings.yml au premier lancement — précisément le terrain qui a produit la série de
     pannes v0.3.6 à v0.4.3, pour un gain nul ici.
  2. **Corriger le fichier ne suffisait PAS à protéger la machine déjà installée**, et c'est le vrai piège.
     Un conteneur garde la publication décidée à sa CRÉATION : le fichier corrigé n'y change rien tant qu'il
     n'est pas recréé. Or `ensureSearxngRunning` ressort immédiatement quand SearXNG répond déjà, et le
     conteneur est relancé tout seul à chaque démarrage de Docker (`restart: unless-stopped`) — le correctif
     ne serait donc JAMAIS arrivé jusqu'à la machine de Léo. Ajouté un contrôle qui lit la publication
     RÉELLE (`docker compose port searxng 8080`, qui répond "0.0.0.0:8091" ou "127.0.0.1:8091") et recrée le
     conteneur si elle dépasse la machine — le même `--force-recreate` que pour le refus du format JSON, les
     deux raisons étant évaluées ensemble pour ne recréer qu'une seule fois. Un diagnostic indisponible (la
     commande échoue) répond "limité à la machine" : "je ne sais pas" ne doit jamais valoir "c'est ouvert",
     sinon Jaris recréerait pour rien un conteneur qui fonctionne. **Leçon générale, même famille que le
     check WSL placé dans une branche jamais atteinte et que la touche "+" gatée d'un seul côté sur deux :
     changer un fichier de configuration ne corrige que les installations FUTURES — pour une machine déjà
     installée, il faut un contrôle qui constate l'état réel au démarrage et le répare.**
  Corrigé aussi, sans rapport technique : une adresse e-mail qui ressemblait à une vraie adresse servait
  d'exemple dans un commentaire (voicePipeline.ts), remplacée par une adresse inventée. **Dans un dépôt
  public, un exemple repris d'un essai réel peut exposer la donnée de quelqu'un d'autre.**
  Régression : `node --test scripts/test-searxng-binding.mjs` (conteneur ouvert recréé, publication IPv6
  ouverte comptée elle aussi, conteneur déjà limité JAMAIS recréé à chaque lancement, refus du JSON toujours
  traité, diagnostic indisponible sans effet, et docker-compose.yml qui ne publie que sur 127.0.0.1). Chaque
  assertion a été vérifiée en réintroduisant temporairement le défaut correspondant.

- **Intégration téléphone (étape 21, demande de Léo : "on va faire étape 21").** L'étape demandait
  explicitement de COMPARER deux ponts PC/téléphone avant d'en choisir un — comparaison faite sur les
  sources primaires, jamais sur des articles :
  - **KDE Connect** expose un vrai programme en ligne de commande. Vérifié dans son dépôt officiel :
    `add_subdirectory(cli)` est hors de tout `if (NOT WIN32)` (CMakeLists.txt), donc `kdeconnect-cli` est
    compilé aussi sur Windows, et `cli/kdeconnect-cli.cpp` liste les options réellement disponibles
    (`--ring`, `--share-text`, `--share`, `--list-available --id-name-only`, `--send-sms --destination`,
    `--list-notifications`...). Même forme d'intégration que tout le reste de Jaris : on lance une commande,
    on lit sa sortie.
  - **Mobile connecté (Phone Link)** fait plus de choses avec un iPhone (messages, notifications, appels par
    Bluetooth — documenté par Microsoft) mais n'expose AUCUNE API : la seule réponse officielle sur
    learn.microsoft.com à « existe-t-il une API Phone Link ? » renvoie vers des services SMS payants. Le
    piloter demanderait de cliquer dans sa fenêtre à l'aveugle, ce qui casse à la première mise à jour de
    Windows — et se prétend automatique tout en étant intestable ici.
  **Léo a un iPhone, et c'est ce qui décide du périmètre réel.** Sa première demande était « envoyer un SMS
  à la voix » : impossible, et il fallait le dire avant de coder plutôt que de livrer un truc qui n'enverrait
  rien. Vérifié à la source, pas supposé : l'application iOS de KDE Connect contient exactement 8 greffons
  (liste des dossiers de `Plugins and Plugin Views` dans kdeconnect-ios : Battery, Clipboard, FindMyPhone,
  Ping, Presenter, RemoteInput, RunCommand, Share) — ni SMS, ni notifications — et leur README l'explique :
  « Notification syncing doesn't work because iOS applications can't access notifications of other apps ».
  C'est une interdiction d'Apple, donc aucun logiciel local ne peut la contourner. Léo, informé, a choisi de
  faire « ce qui marche vraiment sur iPhone » plutôt qu'un pilotage de fenêtre bricolé.
  **Leçon générale : quand une demande se heurte à une interdiction d'une plateforme tierce, la vérifier sur
  la source primaire (le code/les greffons réellement livrés, pas une page marketing) et l'annoncer AVANT de
  coder** — livrer une version dégradée en silence, ou un pilotage d'interface fragile présenté comme
  automatique, aurait coûté une version pour rien et une confiance en moins.
  **Sécurité, le point structurant du code** : le texte envoyé au téléphone vient du modèle, donc d'une
  phrase dictée. Toutes les commandes passent par `execFile` avec un TABLEAU d'arguments, jamais par une
  chaîne de shell — même règle que `type_text` (inputControl.ts). Un test lance vraiment
  `coucou" & shutdown -s -t 0 & echo "` et vérifie qu'il ressort INTACT comme argument unique, plus un
  contrôle structurel qui échoue si un futur ajout repasse par `exec`/`shell: true`.
  **Piège évité par anticipation, tiré des étapes 87-90** : le message de succès dit « Texte déposé sur ton
  téléphone, dans KDE Connect (ce n'est pas un SMS envoyé à quelqu'un) ». Un simple « Envoyé sur le
  téléphone. » aurait laissé croire qu'un message était parti à quelqu'un — exactement la famille de fausses
  confirmations déjà corrigée trois fois. La description de l'outil dit aussi au modèle de REFUSER
  franchement une demande de SMS au lieu d'utiliser cet outil à la place.
  **Deux pièges déjà documentés, rencontrés à nouveau en écrivant les tests** : (1) `vm.runInNewContext` et
  ses prototypes séparés font échouer `assert.deepEqual` sur des objets identiques — chargé dans le realm
  courant (`runInThisContext` + enveloppe) puisque ce test compare de vrais tableaux d'arguments ; (2) un
  mock d'`execFile` sans la marque `[util.promisify.custom]` fait résoudre `promisify` vers un tableau
  positionnel, et le test passerait à côté de ce qu'il prétend vérifier.
  **Piège trouvé dans MON propre test, en vérifiant qu'il mordait** : la première version de l'assertion
  « les boutons sont bien habillés par le CSS » visait `.options-menu__action` — en retirant cette classe
  d'un bouton pour vérifier, le test passait toujours : son sélecteur trouvait simplement le bouton SUIVANT,
  resté stylé. Corrigé en sélectionnant tous les boutons par leur BALISE puis en les vérifiant un par un.
  **Leçon générale : un test qui cherche ses éléments par la classe qu'il est censé vérifier ne peut pas voir
  cette classe manquer** — sélectionner par ce qui ne change pas (la balise, le rôle), puis mesurer.
  Régression : `node --test scripts/test-phone-bridge.mjs scripts/test-phone-tab-ui.mjs` (commandes
  construites, texte piégé resté inerte, aucun shell, téléphone choisi respecté, message quand rien n'est
  joignable ; et dans un vrai navigateur : onglet monté, boutons réellement habillés par le CSS compilé,
  bouton désactivé quand aucun téléphone n'est joignable). Chaque assertion a été vérifiée en réintroduisant
  temporairement le défaut correspondant.
  **Non vérifiable ici, à confirmer par Léo** : que KDE Connect s'installe bien, que Jaris trouve
  `kdeconnect-cli.exe` là où l'installeur le dépose (d'où le bouton « Trouver KDE Connect moi-même », qui
  marche quel que soit le dossier), et que l'appairage tienne sur son Wi-Fi.

- **KDE Connect RETIRÉ et remplacé par Mobile connecté, à la demande de Léo (étape 21bis) : « enlève tout
  kde connect on va faire soit mobile connecté soit rien ».** Cette entrée REMPLACE la précédente (étape 21)
  sur le choix du pont téléphone — même convention que l'étape 96 face à l'étape 47 : quand une demande
  explicite contredit un choix noté ici, c'est la demande qui gagne, et l'entrée est mise à jour plutôt que
  laissée à se contredire toute seule. Ce qui reste vrai de l'entrée précédente : les FAITS vérifiés sur
  l'application iOS de KDE Connect (8 greffons, ni SMS ni notifications) et sur l'absence d'API de Mobile
  connecté. Ce qui change : la conclusion qu'on en tire.
  **Ce que j'avais raté en concluant trop vite « Mobile connecté = pilotage de fenêtre à l'aveugle ».** J'ai
  comparé les deux ponts sur la même question — « lequel expose une API ? » — et j'ai arrêté là. Mais pour
  LIRE les notifications, il n'y a pas besoin de parler à Mobile connecté : il les dépose dans le CENTRE DE
  NOTIFICATIONS de Windows, et Windows a une API documentée pour ça (`UserNotificationListener`,
  Windows.UI.Notifications.Management, depuis Windows 10 1607). La bonne question n'était donc pas « cette
  application a-t-elle une API ? » mais « où atterrit vraiment la donnée que je veux ? ». **Leçon générale :
  quand un logiciel tiers n'expose aucune API, chercher où il DÉPOSE ses données dans le système avant de
  conclure qu'il faut piloter son interface** — le système d'exploitation, lui, a souvent une porte
  officielle, stable et documentée, là où une fenêtre change à chaque mise à jour.
  **Deux conditions hors de notre contrôle, annoncées comme telles plutôt que découvertes par Léo** : (1)
  Windows exige une autorisation explicite (`RequestAccessAsync` — « UserNotificationListener requires
  explicit user permission to be granted before it may be used », learn.microsoft.com) ; (2) les
  notifications de l'iPhone n'arrivent dans le centre de notifications que si Mobile connecté est appairé en
  Bluetooth et « Partager les notifications du système » activé côté iPhone. **Non vérifiable ici** : que
  l'autorisation soit accordée à une application NON EMPAQUETÉE comme Jaris (la documentation ne le dit pas,
  et je ne l'invente pas) — d'où un résultat qui distingue explicitement `denied` de `unsupported` et
  d'`error`, pour que le premier essai de Léo tranche avec un fait.
  **Le piège de conception le plus important de ce module, traité avant qu'il arrive** : « aucune
  notification » et « Windows refuse l'accès » produisent tous les deux une liste VIDE. Si les deux messages
  se ressemblaient, un refus se lirait comme « tu n'as rien reçu » — une affirmation fausse, exactement la
  famille des fausses confirmations des étapes 87-90. Les deux messages sont donc explicitement différents,
  et un test échoue si le message de refus se met à ressembler à celui d'une boîte vide.
  **Piège de PowerShell 5.1 déjà documenté à l'étape 32, et qui frappait à nouveau ici** : `ConvertTo-Json`
  n'a pas `-AsArray`, donc UNE seule notification ressort en objet et non en tableau d'un élément — le cas
  le plus banal aurait été perdu. Garde côté TypeScript, testé, et vérifié en retirant le garde.
  **Répartition testable/non testable, comme à l'étape 32** : le script PowerShell ne prend AUCUN paramètre
  (aucune donnée du modèle n'y entre jamais, donc rien à échapper) et ne fait que lire ; toute la logique qui
  manipule sa sortie est du TypeScript testé ici. Un test structurel échoue si une interpolation apparaît un
  jour dans le script.
  **Choix d'interface** : la lecture ne part PAS toute seule à l'ouverture de l'onglet, contrairement aux
  autres réglages — la première lecture déclenche une fenêtre d'autorisation Windows, et une fenêtre système
  qui surgit parce qu'on a simplement ouvert un onglet serait incompréhensible. C'est le clic sur le bouton
  qui la provoque, après une phrase qui explique pourquoi.
  Régression : `node --test scripts/test-phone-link.mjs scripts/test-phone-tab-ui.mjs` (notification unique
  non perdue, refus jamais confondu avec une boîte vide, sortie illisible devenue message lisible, script
  sans interpolation, et dans un vrai navigateur : rien n'est lu sans clic, les notifications s'affichent
  après le clic, un refus n'affiche jamais de liste vide). Un test vérifie aussi en permanence qu'aucune
  trace de KDE Connect ne revient dans le CODE (les commentaires qui expliquent son retrait, eux, restent) —
  le grep-sweep après un retrait devient ainsi permanent au lieu d'être fait une fois à la main.
  Chaque assertion a été vérifiée en réintroduisant temporairement le défaut correspondant.

- **« mais tu peux pas te connecter à mobile connecté, il n'y a pas un outil pour ça » (Léo, étape 21ter) —
  et la troisième fois que la même question mal posée m'a fait rater une piste.** Les notifications du
  téléphone restaient dans la fenêtre de Mobile connecté sans passer par le centre de notifications de
  Windows (constaté par Léo : son message arrive dans Mobile connecté, mais Windows + N ne le montre pas),
  donc la lecture livrée à l'étape 21bis ne voyait que les notifications du PC. Plutôt que de répéter « il
  n'y a pas d'API », j'ai reposé la question qui paye : **où atterrit la donnée ?** Réponse : Mobile connecté
  garde ses données dans un cache local en bases SQLite — documenté par des travaux publiés d'informatique
  légale sur l'application Your Phone/Phone Link (`%LOCALAPPDATA%\Packages\Microsoft.YourPhone_*\LocalCache`),
  jamais par Microsoft. **Leçon générale, désormais vérifiée trois fois sur ce seul sujet : « cette
  application n'expose pas d'API » ne veut pas dire « inaccessible » — chercher successivement (1) ce que le
  système d'exploitation publie lui-même, (2) ce que l'application écrit sur le disque, et seulement en
  dernier recours son interface graphique.**
  **Ce qui est livré est un CONSTAT, pas une fonctionnalité** (`phoneLinkCache.ts`) : Jaris regarde quelles
  bases existent, quelles tables elles contiennent et combien de lignes — et rien d'autre. Aucun contenu de
  message n'est lu, ce qui est vérifié par un test. Deux raisons : le schéma n'est documenté nulle part et
  change avec les versions, donc écrire un lecteur maintenant serait deviner (la saga SearXNG a coûté quatre
  hypothèses successives pour cette raison exacte) ; et le rapport peut être envoyé tel quel par Léo sans
  exposer ses conversations.
  **VRAI DÉFAUT DE SÉCURITÉ ATTRAPÉ PAR UN TEST, à ne jamais refaire** : `node:sqlite` attend l'option
  `readOnly` (O MAJUSCULE). Écrite `readonly` en minuscules — l'orthographe naturelle, et celle du mot-clé
  TypeScript — elle est **acceptée sans la moindre erreur ET IGNORÉE** : la base s'ouvre en ÉCRITURE. Le code
  livré aurait donc ouvert les bases de messages de Léo, appartenant à une autre application en cours
  d'exécution, avec le droit de les modifier. Repéré uniquement parce que le test ne se contente pas de lire
  l'option mais TENTE une écriture et exige qu'elle échoue ; mesuré ensuite sur les deux orthographes pour
  confirmer. **Leçon générale : un objet d'options ne valide pas ses clés — une option mal orthographiée est
  silencieusement ignorée, et le comportement par défaut (ici : écriture autorisée) s'applique. Pour toute
  option qui INTERDIT quelque chose, ne jamais se fier au nom écrit : tester que l'action interdite échoue
  vraiment.** Même famille que `resample_poly` sur un tableau d'entiers (silence total, aucune erreur) et que
  les règles CSS sans effet : ce qui ne lève pas d'erreur n'est pas pour autant appliqué.
  Le parcours du cache est borné (profondeur, nombre d'entrées, tables par base) parce qu'un cache
  d'application contient des milliers de fichiers, et un dossier illisible n'interrompt pas le reste — sans
  ça, le premier dossier verrouillé ferait dire « rien trouvé » alors que tout est là.
  Régression : `node --test scripts/test-phone-cache.mjs` — parcours sur un VRAI faux disque et lecture d'une
  VRAIE base SQLite créée par le test (pas un mock), plus l'assertion d'écriture refusée qui a trouvé le
  défaut ci-dessus, et une assertion qui échoue si un contenu de message se retrouve dans le rapport.

- **« enlève lire mes notification car ça met pc » + le résultat du constat (Léo, étape 21quater).** Le
  constat livré à l'étape 21ter a tourné sur sa machine et a renvoyé des FAITS, pas des suppositions :
  `calling.db` → `call_history` (100 lignes) ; `contacts.db` → `contact` (24), `phonenumber` (29), plus les
  tables d'index `contact_index`/`fts_*` ; et **aucune base de messages**. Pour un iPhone, Mobile connecté
  affiche les messages dans sa fenêtre sans les garder sur le disque. Périmètre donc décidé par la donnée
  réelle, pas par une envie : les appels et les contacts se lisent, les messages non — et Jaris le dit au
  lieu de le laisser croire. La lecture des notifications (étape 21bis) est retirée : elle ne voyait que
  celles du PC, ce qui n'a aucun intérêt et laissait espérer autre chose.
  **Le schéma était connu à moitié, et c'est ce qui décide de l'implémentation** : le constat donne les noms
  des TABLES, jamais ceux des COLONNES, et rien ne les documente. Deviner `date`/`number`/`name` aurait
  marché par chance sur une version et cassé à la suivante. Les colonnes sont donc RECONNUES à l'exécution
  (`PRAGMA table_info` + motifs), et deux schémas différents sont exercés exprès par les tests.
  **Trois formats d'horodatage possibles** (secondes Unix, millisecondes Unix, ticks .NET) sans savoir
  lequel : on convertit puis on VÉRIFIE que la date tombe entre 2000 et 2100. Sans ce contrôle, un mauvais
  format donnerait "17 janvier 1970" ou une date en l'an 4521 sans que rien ne le signale. **Leçon générale :
  quand plusieurs formats sont plausibles pour une même valeur, essayer puis valider le RÉSULTAT vaut mieux
  que choisir un format en espérant — une conversion fausse ne lève aucune erreur, elle produit juste une
  valeur absurde.**
  **DEUX PIÈGES TROUVÉS DANS MES PROPRES TESTS, tous deux parce que j'ai vérifié qu'ils mordaient** :
  1. Le test remplaçait `findPhoneDatabases` sur les exports du module pour simuler la machine de Léo —
     **sans le moindre effet** : un appel INTERNE à une fonction du même module ne passe jamais par les
     exports. Le test lisait donc la vraie machine (aucune base, ici) et ne vérifiait rien. Corrigé en
     rendant la dépendance réellement injectable (paramètre), comme le `fs` de phoneLinkCache. **Leçon
     générale : on ne remplace pas une fonction d'un module par ses exports — pour qu'un test contrôle
     vraiment une dépendance, elle doit être PASSÉE, pas monkey-patchée.** Même famille que le `grep -c` de
     l'étape 97, qui comptait juste sans rien prouver.
  2. L'assertion « la recherche de contacts ne doit pas attraper les tables d'index » passait aussi bien
     AVEC qu'SANS l'ancrage `/^contact$/` : dans ma base de test, la vraie table `contact` était créée en
     premier, donc trouvée en premier de toute façon. L'ordre réel chez Léo est inconnu. Corrigé en créant
     les tables d'index AVANT dans le test. **Leçon générale : un test dont le résultat dépend d'un ordre
     que le code ne garantit pas ne teste pas le code, il teste sa propre mise en scène.**
  Régression : `node --test scripts/test-phone-data.mjs scripts/test-phone-tab-ui.mjs` (vraies bases SQLite
  créées par le test, deux schémas de colonnes différents, trois formats de date, contacts avec accents,
  et dans un vrai navigateur : rien n'est lu sans clic, les appels s'affichent avec une date lisible, et
  « aucun appel » s'explique au lieu d'afficher une liste vide). Chaque assertion a été vérifiée en
  réintroduisant temporairement son défaut — c'est comme ça que les deux pièges ci-dessus sont sortis.

- **"tkt chatgpt est en train de gérer mais dans les option tu peut mettre tout se que jaris peut faire"
  (Léo, étape 108)** — un nouvel onglet Options → "Ce que Jaris sait faire", qui liste en langage courant
  tout ce que Jaris peut faire à la voix comme en Chat.
  **Décision structurante : une redite VOLONTAIREMENT réécrite de `TOOLS` (tools.ts), pas une copie
  automatique de ses descriptions.** `TOOLS` est écrit pour Ollama (impératif technique, parfois des détails
  d'implémentation — ex: "clique à cet endroit ; sinon clique à la position actuelle du curseur") et vit côté
  main process (`child_process`/`fs`), donc injouable tel quel dans le renderer. `shared/capabilities.ts`
  regroupe par USAGE plutôt que par ordre d'ajout, en phrases écrites pour Léo, pas pour un modèle.
  **Comment ça ne se désynchronise pas de `TOOLS`, le vrai risque d'une redite manuelle** : chaque capacité
  qui correspond à un outil précis porte son `toolNames` (le(s) nom(s) exacts de tools.ts). Un test relit
  `tools.ts` par expression régulière et vérifie qu'AUCUN outil n'existe sans être couvert dans
  `capabilities.ts` — et réciproquement, qu'aucune entrée ne cite un outil renommé/retiré (ce qui vient de se
  produire deux fois cette session même : `read_phone_notifications` retiré à l'étape 21quater). Même
  discipline que `findLeakedToolName`, déjà dérivé de `TOOLS` pour la même raison. **Leçon générale : quand
  une information doit exister sous deux formes différentes pour deux publics différents (ici : un modèle et
  un humain), la duplication elle-même n'est pas le problème — c'est l'ABSENCE de vérification croisée qui
  laisse les deux dériver en silence.**
  Un test vérifie aussi qu'aucun identifiant technique en snake_case (ex: "click_mouse") ne fuite dans une
  description affichée à Léo — vérifié en réintroduisant volontairement une description du genre "Appelle
  open_app pour lancer une application" : le test l'a bien attrapée.
  Régression : `node --test scripts/test-capabilities.mjs scripts/test-capabilities-tab-ui.mjs` (outil ajouté
  sans entrée détecté, référence à un outil disparu détectée, doublon détecté, jargon technique détecté ; et
  dans un vrai navigateur : tous les groupes et toutes les capacités du fichier source sont RÉELLEMENT
  affichés — pas juste comptés dans le code — et les titres de groupe sont habillés par le CSS partagé, pas
  laissés en texte brut). Chaque assertion vérifiée en réintroduisant temporairement son défaut.

- **"je clique sur mis a jour et ça fait 100 pourcent et apres ça fait rien" (Léo, étape 109) — la mise à
  jour de Jaris lui-même (Options → Mise à jour), pas le mode Code cette fois : le mot "pourcent" ne laissait
  aucune ambiguïté, contrairement à l'étape 99.** Le téléchargement de l'installeur (étape 98) fonctionnait
  bien jusqu'au bout — barre à 100 %, message "Jaris se ferme, puis se rouvre tout seul" affiché — mais Jaris
  ne fermait jamais ni ne relançait rien après ça. `downloadToFile`/`updateApp` (déjà couverts par
  `test-app-updater.mjs`) ont été revérifiés en entier et sont corrects : le fichier est complet avant que
  `app.quit()` ne soit appelé, `will-quit` lance bien l'installeur.
  **Cause trouvée en relisant TOUTE la séquence de fermeture, pas seulement le module de mise à jour** :
  fermer une fenêtre lui fait perdre le focus AVANT de se fermer pour de bon — `app.quit()` (mise à jour,
  croix de la fenêtre, "Quitter" du menu, arrêt GPU) déclenche donc un vrai évènement `'blur'` sur la fenêtre
  principale EN PLEIN MILIEU de sa propre fermeture. Le handler `win.on('blur', ...)` (électron/main.ts,
  ajouté pour replier Jaris en widget dès qu'une autre appli prend le focus) ne consultait que `dialogOpen`,
  jamais `quitting` — il réaffichait donc le widget (ou le RECRÉAIT si `app.quit()` avait déjà eu le temps de
  le détruire) juste avant que la fenêtre principale ne finisse de disparaître. Electron ne quitte jamais tant
  qu'il reste une fenêtre ouverte : `will-quit` ne se déclenchait donc jamais, l'installeur ne démarrait
  jamais, et rien n'indiquait pourquoi — exactement le "ça fait rien" de Léo, après un téléchargement pourtant
  complet. Corrigé en ajoutant `quitting` à la condition de sortie du handler `'blur'`, exactement comme
  `dialogOpen` déjà là pour une raison différente (un dialogue natif qui prend le focus OS, pas une fermeture
  en cours).
  **Familier, la même faute que la touche "+" gatée d'un seul côté sur deux et le check WSL placé dans une
  branche jamais atteinte : un garde ajouté pour un cas précis (ici `dialogOpen` pour les dialogues) ne
  protège que CE cas — un évènement qui peut se déclencher pour une AUTRE raison (ici : la fenêtre en train
  de se fermer pour de bon) doit être couvert par son PROPRE garde, pas supposé couvert par hasard par le
  premier qui existe déjà sur le même handler.**
  **Leçon générale, plus large : fermer une fenêtre déclenche 'blur' avant 'close' — tout handler `'blur'`
  ajouté sur une fenêtre qui peut aussi se fermer volontairement (croix, `app.quit()`, menu Quitter...) doit
  explicitement ignorer ce cas, sinon il s'exécute en PLEIN MILIEU de la fermeture et peut la bloquer
  indéfiniment en recréant une fenêtre juste avant que la dernière ne disparaisse — sans la moindre erreur
  visible, puisque rien n'a "planté", l'appli reste juste plantée là.**
  Test STRUCTUREL (pas de vraie fenêtre Electron ici, invérifiable faute de Windows dans cet environnement),
  même famille que le test qui vérifie déjà que ce même handler consulte `dialogOpen` :
  `node --test scripts/test-quit-blur-guard.mjs`. Vérifié en retirant temporairement `quitting` de la
  condition : le test échoue bien.

- **"quand on est dans les option, jaris ne doit pas partir en widget quand on part" (Léo, étape 110) — suite
  immédiate de l'étape précédente, même handler `'blur'`, une TROISIÈME raison de perdre le focus qui n'a
  rien à voir avec "une autre appli prend la main" (le seul cas prévu à l'origine).** La page Options (un
  composant React) vit dans la fenêtre normale, pas une fenêtre à part — c'est un simple overlay affiché par
  dessus le reste — rien côté main ne savait donc la distinguer du reste de l'app : cliquer sur une autre
  application en pleine configuration (par exemple pour vérifier un réglage ailleurs) déclenchait le même
  `'blur'` qu'un vrai changement d'appli, et repliait Jaris en widget en plein milieu — perdant l'accès direct
  à la page Options (repliée avec le reste de la fenêtre derrière le petit widget), alors qu'elle a déjà son
  propre bouton "Fermer" pour signaler qu'on a vraiment terminé.
  Corrigé par le même principe que les deux gardes déjà en place sur ce handler : un nouveau drapeau
  `optionsOpen` (électron/main.ts), mis à jour par un nouveau canal IPC dédié que le composant Options
  appelle dans un effet `useEffect(() => { window.jaris.setOptionsOpen(open) ; return () =>
  window.jaris.setOptionsOpen(false) }, [open])` — la fonction de nettoyage garantit que le drapeau retombe à
  `false` si jamais l'état d'ouverture change sans repasser par un chemin qui l'aurait fait explicitement (le
  composant n'est en pratique jamais démonté, mais un drapeau oublié à `true` bloquerait le repli en widget
  pour TOUTE la session, un risque bien pire qu'un appel redondant). Une seule source de vérité (l'état
  d'ouverture React déjà existant) plutôt que d'appeler ce canal séparément dans les deux handlers
  d'ouverture/fermeture, qu'il aurait fallu garder synchronisés à la main.
  **Décision volontairement PAS symétrique avec `minimize`** : contrairement à `'blur'`, le handler de
  réduction de fenêtre ne consulte ni le drapeau des dialogues ni celui de la page Options — un clic
  explicite sur "réduire" est un geste délibéré de l'utilisateur, à respecter tel quel même en pleine
  configuration, alors que `'blur'` est un effet de bord incident (cliquer ailleurs) qui ne devrait pas
  produire la même conséquence radicale.
  **Troisième garde ajouté sur ce même handler en l'espace de deux étapes : la leçon de l'étape précédente se
  confirme** — un handler `'blur'` sur une fenêtre qui héberge plusieurs contenus/états (dialogue natif, page
  Options, fermeture en cours...) doit explicitement écarter CHAQUE cas où perdre le focus ne doit PAS être
  traité comme "une autre appli a pris la main", sous peine de devoir en découvrir un nouveau à chaque
  nouveau signalement.
  Test STRUCTUREL (pas de vraie fenêtre Electron ici, invérifiable faute de Windows dans cet environnement),
  ajouté au même fichier que le garde précédent : `node --test scripts/test-quit-blur-guard.mjs`, avec 3
  assertions dédiées (le handler `'blur'` consulte le nouveau drapeau, le canal IPC met bien à jour ce
  drapeau, le composant Options appelle bien ce canal). Les trois ont été vérifiées en réintroduisant chacun
  des trois défauts correspondants : chaque test échoue bien seul, sans faire échouer les deux autres.

- **"met ce que jaris sait faire pas dans reglage mais crée une autre sous categorie" + "fait une meilleur
  présentation car on comprend pas trop c'est du texte mémoire : retenir c'est pas beau et on comprend pas
  totalement" (Léo, étape 111)** — deux retours sur l'onglet livré à l'étape 108, constatés sur une CAPTURE
  RÉELLE du rendu compilé avant de toucher au code (discipline déjà appliquée aux étapes 92/94) :
  1. **Rangement.** "Ce que Jaris sait faire" était le premier onglet sous l'intitulé "Réglages" — or on n'y
     règle rien, on y découvre. La colonne de gauche a donc maintenant DEUX catégories ("Découvrir" puis
     "Réglages"), chacune avec son propre intitulé et sa propre liste.
  2. **Présentation.** Chaque capacité était une ligne de texte continue (`<strong>titre</strong> — longue
     description`), et la description mélangeait trois choses : ce que c'est, comment s'en servir, et des
     détails techniques (SearXNG, VRAM, "second agent"). La phrase à DIRE — la seule chose dont Léo a
     vraiment besoin — était noyée au milieu. Refondu en CARTES rangées en grille : titre, une phrase de
     description, puis la phrase exacte à prononcer, détachée par un filet et introduite par une étiquette
     ("Dis"). `Capability` gagne `example`, `CapabilityGroup` gagne `summary`.
  **Défaut que la capture a révélé et que la relecture n'aurait pas montré** : le `{' — '}` du JSX tombait en
  DÉBUT de ligne dès que le titre occupait toute la largeur, donnant un tiret orphelin en tête de la
  deuxième ligne de chaque entrée. C'est une partie du "c'est pas beau" de Léo, qu'il n'a pas eu à nommer.
  **Deux défauts trouvés dans MON PROPRE travail, sur la capture du nouveau rendu, pas en relecture** :
  (1) un exemple contenait déjà ses guillemets alors que le rendu en ajoute → « écris « bonjour… » » à
  l'écran ; (2) les phrases à dire ne s'alignaient pas entre deux cartes voisines (chacune suivait sa
  description, de longueur différente) — corrigé par `margin: auto 0 0`, qui les colle au bas de la carte.
  **Étiquette "Dis" volontairement remplacée par "Écris" pour le mode Code** (`exampleLabel` au niveau du
  groupe) : ce mode se pilote au clavier dans son propre champ, jamais à la voix — afficher "Dis" y aurait
  été une consigne fausse, exactement la famille des affirmations inexactes déjà corrigée plusieurs fois ici.
  **Les limitations ne sont PAS des cartes** ("les messages sont hors de portée") : rendues en note à liseré,
  jamais dans la grille — une limitation rendue comme les autres se compterait visuellement comme une
  capacité de plus.
  **Vrai piège CSS attrapé par une MESURE en fenêtre étroite, pas à l'œil** : la règle générale
  `.options-menu__tabs { flex-wrap: wrap }` (plus haut dans index.css) s'appliquait aussi aux deux nouvelles
  listes d'onglets — sous 700px, la seconde s'enroulait sur trois lignes et poussait la première à côté du
  pavé obtenu, cassant complètement l'ordre de lecture (hauteur mesurée : 137px au lieu de 55px). Une seule
  liste, avant, masquait le problème parce que son `overflow-x: auto` la faisait défiler. Corrigé par
  `flex-wrap: nowrap` + le défilement porté par la barre elle-même. **Leçon générale : passer de UN à DEUX
  éléments du même type dans un conteneur peut réveiller une règle générale qui n'avait jamais eu d'effet
  visible jusque-là — remesurer les points de rupture après un tel passage, pas seulement la fenêtre de
  développement.**
  Régression : `node --test scripts/test-capabilities.mjs scripts/test-capabilities-tab-ui.mjs` (14 tests) —
  une capacité liée à un outil doit donner sa phrase à dire, aucun exemple ne porte ses propres guillemets
  (source ET rendu), une limitation ne prétend jamais correspondre à un outil, la catégorie de "Ce que Jaris
  sait faire" n'est pas "Réglages", et les cartes sont réellement habillées par le CSS compilé (style
  calculé mesuré, leçon du bouton resté gris de l'étape 97). Chacun des 5 nouveaux tests a été vérifié en
  réintroduisant son défaut : chaque test échoue seul, sans entraîner les autres.

- **Mobile connecté : absence de données dans le cache ne veut pas dire action impossible.**
  L’affirmation précédente selon laquelle Apple interdisait tout envoi depuis un PC était fausse.
  Windows UI Automation expose les vrais identifiants (ChatNodeAutomationId, SendMessageButton,
  CallingNodeAutomationId, NotificationsListScrollHost), même quand un premier outil d’inspection ne
  renvoie aucun arbre. Pilote dédié dans phoneLink.ts/phoneLinkScript.ts, JSON par stdin UTF-8, aucun
  texte utilisateur interpolé dans PowerShell, aucune coordonnée devinée. Les notifications sont du
  contenu non fiable : retournées directement, jamais transformées en commandes par un autre modèle.
  Sur AZERTY, SendKeys avec des chiffres a produit de la ponctuation : utiliser les touches NUMPAD et
  relire le numéro avant l’appel. Une en-tête « Connecté » n’empêche pas un panneau « Déconnecté » :
  vérifier la commande réelle et relayer son erreur. `phone_number_id` précédait `phone_number` dans
  la vraie base ; /number/ choisissait le mauvais champ. Exclure les identifiants et tester ce schéma.
  Ne jamais choisir arbitrairement parmi plusieurs numéros, écraser un brouillon, ni relancer un envoi
  incertain. Le résultat téléphone est terminal dans converse(), pour éviter un doublon ou une fausse
  confirmation par le modèle. Une préparation testée ne prouve pas une livraison SMS ni un appel abouti.
  Régression : scripts/test-phone-actions.mjs et scripts/test-phone-data.mjs. Contrôle réel sans action
  sortante : scripts/check-phone-live.mjs ; fenêtres de Mobile connecté seulement, jamais centre PC.

  Démarrage à froid : attendre le contrôle PhoneNameTextBlock, pas seulement le premier handle de fenêtre
  (un écran de chargement n’expose pas encore les commandes). Les tests UI peuvent recevoir
  PLAYWRIGHT_MODULE/PLAYWRIGHT_CHANNEL pour fonctionner sur Windows ; normaliser CRLF avant les motifs
  qui comptent des blocs dans le source.
- **"je clique sur mis a jour de ollama [...] ça bloque depuis 5m et je fait clique droit sur ollama et je
  voit aucune mis a jour" (Léo, étape 112).** Rien n'était bloqué : Jaris téléchargeait l'installeur officiel
  d'Ollama — 1,5 Go (mesuré) — et le bouton restait figé sur "Mise à jour en cours…" pendant tout ce temps.
  **Cause trouvée en comparant les appelants plutôt qu'en devinant** : `grep` des quatre appels à
  `downloadToFile` du dépôt (mise à jour de Jaris, installation silencieuse d'Ollama au premier lancement,
  Docker Desktop, et celui-ci) — le chemin du bouton "Mettre à jour" d'Ollama était le SEUL à ne passer aucun
  `onProgress`, alors que c'est de loin le plus lourd : 15 fois l'installeur de Jaris, pour lequel l'étape 98
  avait justement ajouté une barre parce que 98 Mo en silence étaient déjà insupportables. La leçon de
  l'étape 98 ("toute action qui peut durer plus de quelques secondes doit dire où elle en est") avait donc
  été appliquée à un seul des deux boutons de mise à jour, à côté l'un de l'autre dans le même écran.
  **Leçon générale : quand un correctif règle un défaut sur UN appelant d'une fonction partagée, lister tous
  les autres appelants avant de refermer — le même défaut y dort souvent, et c'est justement le plus gros qui
  avait été oublié ici.** C'est vérifié en permanence maintenant : un test échoue si un `downloadToFile` du
  dépôt repart sans `onProgress`.
  **Le canal d'avancement est PARTAGÉ, pas dupliqué** (`updateProgress` + `AppUpdateProgress`, déjà écrits
  pour Jaris) : un champ `target: 'jaris' | 'ollama'` distingue les deux, et chaque écran ne garde que ce qui
  le concerne — sans ce tri, télécharger Ollama aurait fait avancer la barre de l'onglet "Mise à jour" de
  Jaris, qui ne télécharge pourtant rien.
  **Deux affirmations fausses attrapées sur une CAPTURE du rendu réel, pas en relecture** : (1) la barre
  partagée affiche une consigne en bas, écrite en dur pour Jaris — "Ne ferme pas Jaris : il se ferme et se
  rouvre tout seul à la fin" s'affichait donc pendant une mise à jour d'OLLAMA, qui ne ferme jamais Jaris ;
  (2) le message de fin promettait la même reprise automatique, alors que l'installeur d'Ollama n'a AUCUN
  mode silencieux documenté : il ouvre sa fenêtre et attend un clic. Les deux textes dépendent maintenant de
  la cible. **Piège dans mon PROPRE premier correctif** : j'avais lu la cible dans `progress`, qui vaut `null`
  tant qu'aucun octet n'est arrivé — la consigne de Jaris se serait donc affichée pendant les premières
  secondes, exactement quand on la lit. La cible est passée en prop par l'écran, qui sait toujours ce qu'il
  met à jour.
  **Piège rencontré en écrivant le test, à garder en tête pour tout mock de `spawn`** : `updateOllama` retombe
  sur winget en dernier recours et attend une promesse que seuls ses évènements `'error'`/`'close'` résolvent
  — un faux process qui n'émet jamais rien laisse cette promesse pendante pour toujours, et `node --test`
  s'arrête sur "Promise resolution is still pending" sans dire quel appel l'a causé.
  **Ce qui n'est PAS corrigé ici, faute de pouvoir le vérifier** : pourquoi le clic droit sur l'icône d'Ollama
  ne propose aucune mise à jour chez Léo. C'est cohérent avec ce que fait Jaris (il ne trouve rien de prêt en
  arrière-plan, donc il télécharge le vrai installeur), mais ça dépend du réglage "Auto-download updates"
  d'Ollama lui-même, invérifiable d'ici.
  Régression : `node --test scripts/test-ollama-update-progress.mjs scripts/test-update-progress-ui.mjs`
  (avancement réellement transmis de bout en bout avec des modules simulés, aucun "installation lancée" sur un
  téléchargement échoué, aucun téléchargement muet dans tout le dépôt, et dans un vrai navigateur : le libellé
  nomme Ollama et sa taille, et aucune promesse de fermeture de Jaris). Chaque assertion a été vérifiée en
  réintroduisant son défaut.

- **"je voit des fois gemma 4 des fois pas fait tes analyse de ton cote" (Léo, étape 113) — après un prompt
  de recherche donné à une IA externe (réponses jugées incohérentes d'une fois sur l'autre), Léo a demandé
  une vraie analyse indépendante plutôt qu'un relais d'une IA tierce.** Revue complète des 5 listes de
  candidats (hardwareScan.ts) faite directement ici (recherches vérifiées, pas prises au mot d'un agrégateur).
  Confirmé : aucune nouvelle génération majeure depuis la dernière revue — pas de Qwen4 stable (Qwen3.8-
  Flash-Next reste un aperçu d'architecture MLX uniquement, déjà écarté), pas de Gemma 5 (Gemma4 du 2 avril
  2026 reste la dernière), pas de Granite 4.3 (Granite4.2 du 25 août 2026 reste la dernière) — les 5 listes
  restent à jour sur les familles principales.
  Deux trouvailles concrètes, vérifiées sur ollama.com/library avant tout changement :
  1. **`mistral-small:24b` (palier Puissant) n'était PAS ce que son propre commentaire affirmait.** Une revue
     précédente avait conclu que "3.1"/"3.2" n'existaient pas sous ce nom sur Ollama — FAUX, revérifié :
     `mistral-small3.2:24b` est un tag officiel distinct (15 Go), qui améliore explicitement l'appel
     d'outils par rapport à l'ancienne Mistral Small 3/2501 utilisée jusqu'ici (32K de contexte, texte seul)
     et ajoute la vision + 128K de contexte. Remplacé partout (hardwareScan.ts, benchmark-models.mjs,
     verified-tool-scores.md) — l'ancien score 6/6 mesuré pour l'ancien tag a été RETIRÉ plutôt que recopié
     sur le nouveau, jamais mesuré : `benchmark-models.mjs` le testera pour de vrai au prochain "Lancer
     l'analyse" sur la machine de Léo.
  2. **`glm-4.7-flash:q4_K_M` (palier Puissant) a un vrai 6/6 mesuré sur la machine de Léo, mais plusieurs
     bugs OFFICIELS non résolus** (github.com/ollama/ollama, issues #13840/#13820/#14273/#16497, de janvier
     à juin 2026) montrent l'appel d'outils qui casse en cours de conversation avec ce modèle précis sur
     Ollama — même famille de risque que DeepSeek-R1, déjà exclu pour la même raison plus haut dans ce
     fichier. Cause non tranchée avec certitude (vrai test local positif contre bugs externes documentés) :
     posé à Léo via une question à choix simple plutôt que décidé seul. Gardé tel quel sur sa décision — le
     vrai test de Jaris est passé 6/6, aucun signalement réel ici.
  **Leçon générale : une conclusion notée dans un commentaire ("X n'existe pas sous ce nom") peut devenir
  fausse avec le temps** (un tag ajouté depuis à la bibliothèque Ollama, même si la conclusion était correcte
  au moment où elle a été écrite) — la revérifier directement plutôt que de la recopier comme acquise lors
  d'une revue ultérieure.
  Régression : `npm test` (297 tests, aucun comportement testable ne change — uniquement un nom de modèle
  candidat et une ligne de score retirée).

- **Curseur de longueur de contexte (étape 114), demande de Léo devant une capture de l'app Ollama :
  "jaris voit les model et regarde la vram et propose une barre comme sur ollama mais qui est personnaliser
  a chacun pour que le dernier ne dépasse pas la vram".** Contrairement au curseur d'Ollama (4k à 256k fixe
  pour tout le monde), le MAXIMUM ici est calculé pour la VRAM libre réelle et le modèle du palier PUISSANT
  (le plus gros modèle de conversation configuré) — c'est celui qui laisse le moins de VRAM pour le cache K/V,
  donc si un contexte tient pour lui, il tient forcément aussi pour Rapide/Médium (modèles plus petits, plus
  de marge) : pas besoin de calculer les 3 paliers séparément pour un seul curseur global.
  **Deux appels Ollama vérifiés sur la doc officielle avant d'écrire la moindre ligne de calcul** (jamais
  deviné, même discipline que le reste de ce fichier) :
  - `POST /api/show` (`getModelInfo`, ollama.ts) renvoie `model_info` avec des clés PRÉFIXÉES par
    l'architecture du modèle ("llama.block_count", "qwen3.attention.head_count_kv"...) — lues par SUFFIXE
    dans `parseModelArchInfo` plutôt que par une liste d'architectures connues à maintenir à la main à
    chaque nouvelle famille de modèle (même raisonnement que le retry sans `think` dans ollama.ts).
  - `GET /api/tags` renvoie aussi un champ `size` (octets réels sur disque) par modèle installé — utilisé
    comme poids VRAM (`getInstalledModelSizeBytes`) À LA PLACE de la table `vramGb` maintenue à la main dans
    hardwareScan.ts (ModelCandidate) : cette dernière s'est déjà révélée fausse une fois (qwen3.6:35b
    recopié d'un autre modèle faute de mieux) et ne couvre de toute façon que les candidats DE JARIS, jamais
    un modèle installé manuellement en dehors de ces listes.
  **Formule du cache K/V** (`kvCacheBytesPerToken`, hardwareScan.ts) : 2 (clé+valeur) x nombre de couches x
  têtes K/V (PAS les têtes d'attention — l'attention groupée/GQA partage les mêmes clés-valeurs entre
  plusieurs têtes de requête) x dimension d'une tête x 2 octets (cache par défaut d'Ollama en f16, jamais
  changé ici). Vérifiée sur une config "8B-like" réaliste (32 couches/32 têtes/8 têtes K/V/4096 de
  dimension, proche de Llama-3-8B) AVANT d'écrire le test : 8192 tokens de contexte = exactement 1 Gio de
  cache K/V pour cette config — un ordre de grandeur déjà connu par ailleurs, pas juste un calcul qui
  "semblait juste" en le relisant.
  **Sécurité, le principe qui gouverne tout le reste** : si la moindre donnée réelle manque (Ollama
  injoignable, modèle pas installé, architecture non reconnue), le repli est TOUJOURS le palier déjà en
  usage aujourd'hui — jamais un maximum optimiste inventé faute de mieux. Proposer plus de marge sans preuve
  aurait été exactement le genre d'hypothèse non vérifiée que ce dépôt a appris à ses dépens à ne jamais
  présenter comme un fait (voir la saga SearXNG plus haut).
  **Vrai bug CSS attrapé par le test AVANT de livrer, pas en relecture — même famille que le bouton
  "Nouvelle conversation" resté gris (étape 97) et le double cadre du composeur (étape 92)** : la règle
  générale `input, textarea:not(.composer__input), select { border-radius: 0 !important; background: ...
  !important; border: ... !important }` (src/index.css) s'applique à TOUT `<input>`, y compris un
  `type="range"` — le curseur aurait hérité d'un cadre de champ de texte classique par-dessus son style
  dédié (fond de piste, coins arrondis), un `!important` ne pouvant être neutralisé que par un autre
  `!important`. Corrigé en excluant `.options-menu__context-slider` de cette règle générale, exactement
  comme `.composer__input` l'est déjà pour une raison différente. Repéré par une VRAIE mesure de style
  calculé dans un navigateur (`border-radius` mesuré à `0px` au lieu de `999px`), jamais en relisant le CSS.
  **Piège dans mon PROPRE premier jet de `formatContextLength`, attrapé par le test avant de livrer** :
  diviser par 1000 pour afficher "32k" aurait donné "33k" pour 32768 — le "k" d'une longueur de contexte
  désigne toujours 1024 (convention universelle : "128k" veut dire 131072, jamais 128000), jamais 1000.
  **Portée volontairement limitée à la conversation** (assistant.ts) : `look_at_screen`/`computer_use_task`
  (vision.ts/computerUse.ts) gardent leur `config.ollama.numCtx` fixe, jamais le réglage de ce curseur — ils
  utilisent un modèle de VISION séparé, dont le budget VRAM n'a rien à voir avec celui calculé ici pour le
  palier Puissant ; appliquer ce réglage là-bas aurait validé un contexte contre le mauvais modèle.
  **Piège déjà documenté dans ce fichier, retombé dessus une nouvelle fois** : les deux tests EXISTANTS de
  hardwareScan.ts (`test-hardwarescan-preview-steps.mjs`, `test-hardwarescan-tiebreak.mjs`) chargent ce
  fichier avec un faux pont qui ne connaissait pas le nouvel import `./ollama` — les 6 tests ont commencé à
  échouer (module introuvable) tant que ce pont n'a pas été mis à jour. Réflexe à garder : après avoir ajouté
  un `import` à un module déjà chargé par plusieurs tests, `grep` tous les faux ponts existants avant de
  lancer la suite.
  Régression : `node --test scripts/test-context-length.mjs scripts/test-format-context-length.mjs
  scripts/test-context-length-ui.mjs` (formule K/V vérifiée à la main, repli de sécurité jamais optimiste,
  jamais au-dessus du maximum natif du modèle ; et dans un vrai navigateur : seuls les paliers sûrs pour LA
  machine simulée s'affichent — jamais les 7 par défaut —, déplacer le curseur enregistre la bonne VALEUR en
  tokens et pas un index brut, et le curseur est réellement habillé par le CSS de Jaris). Chaque assertion
  critique a été vérifiée en réintroduisant temporairement son défaut.
  **Non vérifiable ici, à confirmer par Léo en usage réel** : que le calcul retombe juste sur SA vraie carte
  graphique et SES vrais modèles installés (pas d'accès Windows/GPU réel dans cet environnement) — le
  mécanisme est prouvé par la formule et les tests, sa précision exacte sur sa machine ne l'est pas encore.

- **Refonte des Options (étape 115), demande de Léo : "il ya des categorie dans les options qui peuvent etre
  ensemble, refait totalement option bien comme claude gpt".** 9 onglets réduits à 5 : Micro et Activation
  (2 réglages, chacun quelques lignes) n'avaient aucune raison d'être des onglets à part entière — regroupés
  dans Voix, qui parle déjà de l'expérience vocale dans son ensemble. Mise à jour/Stockage/Historique, trois
  réglages "à propos de l'application" plutôt que trois sujets distincts, regroupés dans un nouvel onglet
  Général — même principe que l'onglet "Général" de ChatGPT/Claude (thème, langue, effacer les
  discussions... tout sur une seule page). Modèles et Téléphone restent inchangés : déjà des catégories
  cohérentes à elles seules, rien à fusionner.
  **Piège structurel identifié AVANT de fusionner le JSX, pas après** : `.options-menu__voice-picker`
  (l'écran orbe/nom/description de la voix) était en `position: absolute; inset: 0; pointer-events: none`
  depuis l'étape 76 — un choix voulu à l'époque parce que ce bloc était le SEUL contenu de l'onglet Voix
  (trop peu pour se centrer normalement dans `.options-page__content`, donc sorti du flux pour se centrer
  sur la fenêtre entière). Une fois Micro/Activation ajoutés en dessous dans le même onglet, cette
  justification ne tenait plus : un enfant `position: absolute` ignore tout ce qui le suit dans le flux, donc
  les nouvelles sections seraient restées invisibles, cachées DERRIÈRE l'orbe. Corrigé en repassant ce bloc en
  flux normal (plus de `position: absolute`/`pointer-events: none`, ni des deux règles satellites qui
  existaient uniquement pour compenser ce choix) — l'orbe redevient un bloc ordinaire en tête d'une vraie
  page de réglages qui défile, exactement le rendu ChatGPT/Claude demandé.
  **VRAI BUG DE PRODUCTION trouvé en écrivant le test, pas juste un artefact d'environnement de test** :
  fusionner Micro dans Voix (l'onglet par défaut, `useState<Tab>('voix')`) a fait planter TOUTE la page
  Options, dans tous les tests navigateur existants de ce fichier (capacités, téléphone, longueur de
  contexte) — pas seulement les nouveaux. Diagnostiqué avec un script Playwright dédié qui capture
  `page.on('pageerror')` plutôt que de deviner à partir du seul timeout Playwright ("waiting for
  `.options-menu__trigger`" ne dit RIEN de la vraie cause) : `Cannot read properties of undefined (reading
  'getUserMedia')`. L'effet qui peuple la liste des micros/haut-parleurs appelait
  `navigator.mediaDevices.getUserMedia(...)` SANS vérifier que `navigator.mediaDevices` existe — cette API
  n'est exposée que dans un contexte sécurisé (https/localhost), absent dans le bundle de test
  (`page.setContent()` sert du contenu sur `about:blank`), mais rien ne garantit non plus qu'elle soit
  toujours présente sur une vraie machine (paramètres de confidentialité stricts, config Electron
  particulière...) — un accès direct sans garde plante alors TOUTE la page Options, pas seulement le
  sélecteur de haut-parleur. Avant la fusion, ce risque dormait dans l'onglet Micro, jamais ouvert par défaut
  ni visité par aucun test existant ; en devenant partie de l'onglet par défaut, il s'est immédiatement
  déclenché partout. Corrigé en vérifiant `navigator.mediaDevices` avant tout accès, avec un repli silencieux
  sur la liste vide (le haut-parleur reste alors au choix par défaut du système) au lieu de faire planter le
  composant entier. **Leçon générale : fusionner un onglet secondaire, jamais visité par défaut, DANS l'onglet
  par défaut peut faire remonter à la surface un bug latent qui dormait dans ce recoin depuis longtemps —
  toujours revérifier chaque effet du contenu fusionné une fois qu'il devient atteignable par défaut, pas
  seulement copier-coller le JSX.**
  Régression : `node --test scripts/test-options-reorganization-ui.mjs` (les anciens onglets ont vraiment
  disparu de la barre, Voix et Général affichent VRAIMENT tout leur contenu fusionné sur une seule page —
  pas juste les titres —, et l'orbe de la voix reste visible et cliquable maintenant qu'il partage la page),
  plus la mise à jour d'une assertion devenue fausse dans `scripts/test-capabilities-tab-ui.mjs` (comptait
  "au moins 7 réglages", devenu "exactement ces 4 réglages" — un simple comptage aurait laissé passer un
  onglet disparu par erreur, même famille de piège que le `grep -c` de l'étape 97). Vérifié aussi par deux
  captures d'écran réelles du rendu compilé (Voix et Général) avant de considérer la refonte terminée.

- **"enleve totalement mobile connect, et refait car je trouve que tu a mis plein de truc partout, ça fait
  trop charger sur des categorie, et tu voit sur claude chatgpt tout se ressemble mais dans les option rien
  ne se ressemble micro comment se déclencher" (Léo, étape 116) — deux demandes distinctes dans le même
  message.**
  1. **Retrait COMPLET de Mobile connecté**, pas une dépriorisation : `phoneLink.ts` (pilotage UI Automation),
     `phoneLinkScript.ts` (le script PowerShell qu'il lance), `phoneData.ts` (lecture calling.db/contacts.db)
     et `phoneLinkCache.ts` (constat du cache) supprimés en entier. Les 5 outils qu'ils servaient
     (`read_phone_notifications`, `call_phone`, `send_phone_message`, `read_call_history`, `find_contact`)
     retirés de `TOOLS` (tools.ts, 19 → 14 outils), `directPhoneRequest` et son court-circuit dans
     `converse()` retirés d'assistant.ts, le groupe "Ton téléphone" retiré de `CAPABILITIES`
     (shared/capabilities.ts), les 3 canaux IPC et l'onglet Options → Téléphone retirés en entier
     (`shared/ipc.ts`, `main.ts`, `preload.ts`, `global.d.ts`, `OptionsMenu.tsx`). **Même précédent que le
     retrait de KDE Connect (étape 21bis) : le CODE part, l'HISTORIQUE de ce fichier reste** — les entrées
     21/21bis/21ter/21quater/112 ci-dessus ne sont pas effacées : la leçon qu'elles portent (chercher où une
     appli DÉPOSE sa donnée avant de conclure qu'il faut piloter sa fenêtre ; les pièges `readOnly` de
     node:sqlite, `ConvertTo-Json` sans `-AsArray`, le focus perdu par un dialogue...) reste valable pour un
     futur pont similaire, même si le code qu'elles décrivaient a disparu.
     **Grep-sweep complet avant de considérer le retrait terminé** (étape 3 de la checklist) : l'alias
     `['mobile connecte', 'phone link']` dans `appLauncher.ts` (LOCALIZED_ALIASES) est volontairement GARDÉ —
     ce n'est pas un reste mort, `open_app` est un outil générique (ouvrir n'importe quelle application par
     son nom) sans le moindre rapport avec les outils téléphone retirés : un utilisateur peut toujours dire
     "ouvre mobile connecté" pour une tout autre raison (mettre son téléphone en miroir, par exemple). Les
     mentions de "téléphone"/"microphone" dans `imageAttachment.ts`, `voice_server.py` et
     `generatedAppPreview.ts` sont des faux positifs du grep large sur "phone" (une photo de téléphone en
     pièce jointe, un micro), sans aucun rapport avec la fonctionnalité retirée. Le paramètre `userPrompt`
     de `createToolExecutor` (tools.ts), qui n'existait QUE pour les outils téléphone, est aussi retiré —
     laisser un paramètre mort après le retrait de son seul consommateur aurait été le même genre d'oubli que
     les alias/canaux jamais nettoyés déjà documentés plus haut dans ce fichier.
  2. **Refonte visuelle des 3 onglets de réglages restants (Voix, Modèles, Général)**, pour la cohérence que
     Léo décrit chez Claude/ChatGPT : avant, un menu déroulant ("Micro utilisé", `.options-menu__field`), un
     groupe de cases isolées ("Comment déclencher l'écoute", `.options-menu__checkbox`) et un bouton nu
     avaient chacun leur propre mise en forme ad hoc, sans rien qui les fasse se ressembler. Deux nouveaux
     composants génériques dans OptionsMenu.tsx : `SettingRow` (intitulé + description à gauche, contrôle
     aligné à droite — peu importe que ce contrôle soit une case à cocher, un menu, un bouton ou une simple
     valeur en lecture seule comme le modèle du mode Code) et `SettingGroup` (regroupe plusieurs `SettingRow`
     apparentées dans une même carte titrée, même famille visuelle que `.options-menu__capability` : fond
     `--hud-panel-raised` + bordure `--hud-line`, jamais une couleur/un style inventé à côté). Les TROIS
     onglets de réglages restants utilisent désormais ce même gabarit — plus aucune ligne ne se présente
     différemment d'une autre selon son type de contrôle.
     **`stacked` (prop de `SettingRow`) réserve le seul cas où un contrôle a vraiment besoin de toute la
     largeur** (le curseur de longueur de contexte de l'étape 114, qui a aussi besoin de ses graduations en
     dessous) — plutôt que d'inventer une troisième forme de ligne à côté des deux évidentes.
     **Contenu riche volontairement PAS forcé dans une ligne** : le tableau des paliers de configuration
     (`HardwareTierPreview`), la liste de l'historique des versions/conversations et le visualiseur de micro
     (barres + verdict) restent du contenu de groupe ordinaire — une `SettingRow` suppose un intitulé et UN
     contrôle, pas une liste ou un tableau entiers ; les y forcer aurait juste déplacé le problème plutôt que
     de le résoudre.
     **CSS mort retiré au passage, pas laissé traîner** : `.options-menu__field`, `.options-menu__checkbox`,
     `.options-menu__mic-test` (remplacé par `.options-menu__mic-test-detail`, qui n'affiche les barres que
     PENDANT/APRÈS un test plutôt qu'en permanence), `.options-menu__actions`, `.options-menu__history-actions`
     et `.options-menu__context-length` n'avaient plus le moindre consommateur en JSX une fois la refonte
     terminée — vérifié par un grep de chaque classe avant de les supprimer, même discipline que pour un
     fichier supprimé.
     Vérifié par capture d'écran réelle du rendu compilé (bundle esbuild + vrai CSS, même discipline que les
     refontes précédentes de ce fichier) sur les 3 onglets avant de considérer la refonte terminée — jamais
     seulement une relecture du JSX.
  **Piège attrapé par le test, pas en relecture** : `scripts/test-capabilities.mjs` avait un seuil de
  sanity-check figé (`toolNamesInSource.length >= 16`) pour vérifier que son propre motif regex n'avait rien
  raté — le retrait volontaire des 5 outils téléphone (19 → 14) l'a fait échouer à tort. **Leçon générale :
  un seuil de sanity-check sur un COMPTE doit être révisé chaque fois que ce compte change délibérément,
  sinon un retrait de fonctionnalité pourtant correct se fait bloquer par un garde-fou périmé qui teste une
  vieille hypothèse plutôt que le comportement actuel.**
  Régression : `npm test` (283 tests) — `scripts/test-options-reorganization-ui.mjs` (les groupes/lignes
  remplacent bien les anciens titres de section, plus aucune trace de l'onglet Téléphone),
  `scripts/test-context-length-ui.mjs` (le curseur et sa valeur "Actuellement" restent lisibles dans leur
  nouvelle ligne), `scripts/test-capabilities-tab-ui.mjs` (plus de limitation "téléphone", la liste de
  réglages ne contient plus que Voix/Modèles/Général) et `scripts/test-capabilities.mjs` (seuil d'outils
  abaissé en connaissance de cause). Chaque assertion modifiée a été vérifiée en la faisant échouer d'abord
  (ancien texte, ancienne classe) avant de confirmer qu'elle passe sur le nouveau rendu.

- **"met juste le context au dessus des palier et c'est bizzare il ya écrit 4k8k coller, et essaye de
  proposer plusieurs choix pas 2 il en faut 4" (Léo, étape 117) — trois retours sur le curseur de longueur
  de contexte livré à l'étape 114, dans le nouveau gabarit `SettingRow`/`SettingGroup` de l'étape 116.**
  1. **Ordre.** "Longueur de mémoire" déplacé AU-DESSUS de "Les paliers de configuration" (OptionsMenu.tsx,
     onglet Modèles) — un simple réordonnancement du JSX, aucune logique changée.
  2. **"4k8k" collé : un vrai bug de mise en page, pas un problème de contenu.** Cause trouvée en relisant le
     CSS de la ligne "stacked" ajoutée à l'étape 116 : `.options-menu__row--stacked` met bien
     `flex-direction: column` sur la ligne ELLE-MÊME (texte au-dessus, contrôle en dessous), mais
     `.options-menu__row-control` — le conteneur DANS lequel vivent le curseur ET ses graduations, tous les
     deux enfants directs de ce conteneur — restait en flex-LIGNE (son mode par défaut, jamais changé pour ce
     cas). Le curseur (`.options-menu__context-slider`, déjà en `width: 100%`) réclamait donc toute la place
     à côté de ses propres graduations au lieu d'être suivi par elles en dessous ; le conteneur des
     graduations, écrasé à sa largeur minimale par ce partage de ligne, perdait l'espace que
     `justify-content: space-between` était censé lui donner — les libellés "4k"/"8k" se retrouvaient collés
     l'un à l'autre faute de place pour les écarter. Corrigé en ajoutant `flex-direction: column;
     align-items: stretch` à `.options-menu__row--stacked .options-menu__row-control` : le curseur et ses
     graduations reprennent chacun toute la largeur, l'un sous l'autre. **Leçon générale, qui rejoint celle
     déjà tirée pour `.options-menu__voice-picker` (étape 115) : `flex-direction: column` posé sur un
     conteneur ne s'hérite PAS par ses enfants flex — si un enfant direct est LUI-MÊME un conteneur flex
     (ici `.options-menu__row-control`, généralement en ligne pour aligner un intitulé et son contrôle), il
     faut le repasser en colonne EXPLICITEMENT pour lui aussi, sinon deux éléments qu'on croit empilés
     restent côte à côte, écrasés dans l'espace qui leur reste.** Vérifié par une VRAIE mesure de rectangles
     (`getBoundingClientRect`) sur les 4 graduations, pas par une simple relecture du CSS — le test échoue
     bien si le correctif est retiré (confirmé en le retirant temporairement).
  3. **"il en faut 4" : la vraie cause profonde, en amont du rendu.** Sur une machine dont la VRAM libre ne
     laisse de marge que pour les tout premiers doublements de l'échelle d'Ollama (4k, 8k, parfois 16k),
     `CONTEXT_LENGTH_STEPS.filter(s => s <= max)` (hardwareScan.ts) ne renvoyait parfois que 2 ou 3 valeurs
     — d'où le collage visuel ET un curseur qui ne servait presque à rien (2 crans). Ajouté
     `computeAvailableSteps(max)` : garde d'abord les paliers "ronds" de l'échelle d'Ollama qui tiennent,
     puis, s'il en manque pour atteindre 4, complète par des paliers INTERMÉDIAIRES (multiples de 1024, donc
     toujours un "Xk" propre avec `formatContextLength`) régulièrement espacés entre le plancher (4096) et
     `max` — jamais un seul ajouté au-dessus de `max` : compléter l'intervalle ne rend rien de MOINS sûr que
     ce que `max` autorisait déjà, contrairement à inventer un maximum plus optimiste (interdit depuis
     l'étape 114, toujours vrai ici). Exemple mesuré : max=8192 donnait avant `[4096, 8192]`, donne
     maintenant `[4096, 5120, 7168, 8192]`. Seul cas où 4 restent impossibles : `max` égal au plancher
     lui-même (4096, aucune marge du tout) — un seul choix existe alors réellement, rien à fabriquer.
  **Piège que ce correctif aurait pu créer, évité en écrivant le test AVANT de considérer le correctif
  fini** : corriger UNIQUEMENT le CSS (2) sans toucher au calcul (3) aurait laissé un curseur bien espacé
  mais toujours limité à 2 crans sur la machine de Léo — les deux bugs se ressemblaient dans son message
  mais avaient des causes complètement séparées (l'un dans le RENDU, l'autre dans le CALCUL en amont), et
  corriger le premier n'aurait rien réglé du second. Un test dédié à `computeAvailableSteps` (4 cas : au
  plancher, à 8192, à 16384, à 32768 et au-delà) vérifie le calcul indépendamment du rendu, et un test
  navigateur avec le résultat RÉEL de ce calcul (`[4096, 5120, 7168, 8192]`) vérifie que le CSS ne recasse
  pas ce que le calcul vient de réparer — les deux bouts de la chaîne, jamais un seul.
  Régression : `node --test scripts/test-context-length.mjs scripts/test-context-length-ui.mjs` (286 tests
  au total) — `computeAvailableSteps` testée directement (plancher, 8192, 16384, 32768, 262144), les 3 tests
  existants de `computeContextLengthOptions` mis à jour pour le nouveau nombre de paliers, un test d'ordre
  ("Longueur de mémoire" avant "Les paliers de configuration") et un test de non-chevauchement des
  graduations sur le cas RÉEL le plus serré (max=8192). Chaque nouvelle assertion vérifiée en réintroduisant
  temporairement le défaut correspondant (CSS ET calcul séparément) : les deux échouent bien chacun de son
  côté, sans faire échouer l'autre.

- **Étape 118, trois retours de Léo dans le même message : "1. enleve historique version 2. j'ai tester le
  palier 4 avec un amis il est bizare"** (avec, à l'appui, une capture montrant "Candidat rejeté
  [transcription] : 'Il est bizarre.'" et un échange incohérent : "Salut Jarvis je m'appelle Tom j'adore les
  fléchettes" a reçu une réponse qui salue Tom comme s'il était déjà venu, ignore les fléchettes, et enchaîne
  sur une question hors sujet à propos d'une "page de contact").
  1. **"Historique des versions" retiré complètement d'Options → Général**, sur simple demande, sans
     remplacement : `getReleaseHistory()` (appUpdater.ts, qui interrogeait `GET /repos/.../releases`),
     l'interface `ReleaseHistoryEntry`, le canal IPC, le bridge preload, le type `global.d.ts`, le bloc JSX et
     son CSS dédié (`.options-menu__changelog-*`) retirés ensemble — grep-sweep confirmant qu'aucune référence
     ne traînait plus nulle part (étape 3 de la checklist) avant de considérer le retrait terminé. Général
     garde la version installée en permanence (`getAppVersion`, jamais bloquée par le réseau), seul le bandeau
     "Mettre à jour" dépendait déjà du réseau.
  2. **Le "palier 4" bizarre : diagnostiqué en reliant un fait déjà documenté DANS CE MÊME FICHIER, pas
     deviné.** Le curseur de longueur de contexte (étape 117, livré juste avant) garantit maintenant au moins
     4 choix — mais sur une machine dont la VRAM laisse peu de marge, ce 4e choix pouvait tomber à 4096 ou une
     valeur interpolée proche. Or ce fichier documente déjà, pour une tout autre raison (le doublement de
     `OLLAMA_NUM_CTX` de 4096 à 8192, `config.ts`), que le système prompt + `TOOLS` (tools.ts) consomment À
     EUX SEULS environ 4200-4500 tokens avant même le premier message — 4096 ne peut donc même pas contenir le
     prompt système, laissant zéro place pour la conversation elle-même. C'est l'explication la plus probable
     du comportement halluciné de Tom (accueil incohérent, sujet perdu, question hors contexte) : PAS confirmé
     par une mesure sur sa machine (aucun accès à celle-ci), présenté comme hypothèse la mieux étayée plutôt
     que comme un fait, par honnêteté sur "vérifié" vs "déduit". Corrigé en retirant 4096 de
     `CONTEXT_LENGTH_STEPS` (hardwareScan.ts) : le plancher du curseur devient 8192, déjà le plancher retenu
     ailleurs pour la même raison — `roundDownToContextStep`/`computeAvailableSteps` n'ont pas eu à changer
     eux-mêmes (ils dérivent déjà leur plancher de `CONTEXT_LENGTH_STEPS[0]`), seuls leurs commentaires et les
     tests dépendants ont dû être recalculés à la main (nouvelles valeurs interpolées : 11264/13312 pour
     max=16384, 24576 pour max=32768). **Leçon générale : un fait déjà noté dans ce fichier pour une raison X
     peut expliquer un bug signalé plus tard pour une raison Y sans le moindre rapport apparent** — avant de
     supposer une nouvelle cause, relire si ce fichier ne documente pas déjà la contrainte exacte qui explique
     le symptôme.
  3. **La capture "Candidat rejeté [transcription]" : un vrai bug distinct, trouvé en investiguant plutôt
     qu'en la traitant comme un simple détail de la capture.** `voice_server.py` loggait déjà, pour CHAQUE
     candidat au mot d'activation rejeté par la confirmation locale, un message technique
     (`"Candidat rejeté (transcription : ...)."`) — ajouté à l'étape "confirmation par transcription"
     UNIQUEMENT pour ajuster `WAKE_NAME` (wake_confirmation.py) depuis de vraies transcriptions rejetées,
     jamais pensé pour l'utilisateur. Le problème : ce message partait par `emit({"event": "log", ...})`,
     EXACTEMENT le même canal stdout que les messages légitimes ("Chargement de la transcription…", "Mot Jaris
     confirmé…") — relayé sans filtre par voiceClient.ts -> voicePipeline.ts -> `broadcast(IPC_CHANNELS.log)`
     -> `window.jaris.onLog` -> `ChatPanel.tsx`, qui l'affiche comme texte de progression ("Jaris réfléchit…").
     Le détecteur de mot d'activation tourne EN PERMANENCE tant que le sidecar vocal écoute, y compris pendant
     que Chat est ouvert (seule la RÉACTION au mot est suspendue par `VoicePipeline.suspended`, étape 72 — pas
     le simple fait de logger un candidat rejeté) : n'importe quelle parole ambiante phonétiquement proche de
     "Jaris" pouvait donc faire apparaître ce texte de diagnostic interne en plein milieu du Chat, sans le
     moindre rapport avec ce qui s'y passait. Corrigé en séparant les deux canaux à la source plutôt qu'en
     filtrant côté renderer : nouvelle fonction `debug()` (voice_server.py, à côté d'`emit()`) qui écrit sur
     stderr — déjà capturé par voiceClient.ts en simple `console.error('[voice_server]', ...)`, jamais
     rediffusé au renderer — pour les deux messages purement diagnostiques ("Candidat rejeté…" et "Mot Jaris
     confirmé par la transcription locale.", ce dernier n'ajoutant rien pour Léo puisque l'évènement `wake`
     qui suit change déjà visuellement l'orbe). **Leçon générale, même famille que le bouton "Nouvelle
     conversation" resté gris ou le double cadre du composeur : un canal de diffusion PARTAGÉ (ici `emit(...,
     "event": "log")`, utilisé à la fois pour du vrai statut ET pour du diagnostic de développement) finit par
     mélanger les deux aux yeux de l'utilisateur — dès qu'un message n'a de sens que pour AJUSTER LE CODE,
     jamais pour lui, il ne doit jamais emprunter le canal qui remonte jusqu'à l'interface, même si ce canal
     existe déjà et semble pratique à réutiliser.**
  Régression : `npm test` (286 tests, aucune régression — les mocks `getContextLengthOptions` des tests UI
  existants mis à jour avec les nouvelles valeurs de `computeAvailableSteps`). Le changement Python n'a pas de
  test dédié dans ce dépôt (`scripts/test-wake-confirmation.py` ne teste que `wake_confirmation.py`, jamais
  `voice_server.py` — module numpy d'ailleurs absent de cet environnement, non vérifiable ici) : vérifié par
  relecture attentive du flux complet (stdout JSON vs stderr texte brut) et par l'absence de toute référence
  aux deux chaînes de log dans le reste du dépôt (aucun test/consommateur n'en dépendait). **Non vérifiable
  ici, à confirmer par Léo en usage réel** : que le "palier 4" redevienne cohérent une fois son plancher réel
  remonté à 8192 sur sa machine et celle de Tom, et que la capture "Candidat rejeté" ne réapparaisse plus dans
  le Chat.

- **Étape 119, suite immédiate de l'étape 118 : "et aussi jaris faisait rien, et mon ami regarde
  gestionnaire des tâches, ça mettait ollama serv et c'était 2000mo [corrigé ensuite en] 20 Go et ça
  saturait sa ram"** — puis, questions ciblées à l'appui (Tom : 32 Go de RAM, carte graphique DÉDIÉE) et
  "mais pourquoi ollama serv tournait à fond quand jaris était inactif aucune tâche" et "après le test
  Salut Jarvis" : diagnostic construit pas à pas à partir de faits, sans deviner, exactement comme la saga
  SearXNG plus haut recommande de le faire.
  **Ce qui a d'abord semblé contradictoire, et pourquoi ça ne l'était pas** : 32 Go de RAM + une carte
  graphique dédiée n'est PAS une machine faible — mon premier réflexe ("machine trop faible, pas de GPU")
  était donc faux. Le VRAI mécanisme, confirmé par la lecture du code plutôt que supposé : le palier
  "Puissant" (LARGE_RAM_OFFLOAD_MODELS, hardwareScan.ts) a le droit, À LA DEMANDE EXPLICITE DE LÉO documentée
  plus haut dans ce fichier ("un vrai grand modèle plus lent... plutôt qu'un petit modèle rapide"), de
  choisir un modèle dont le poids dépasse largement la VRAM disponible, en comptant sur un débordement sur
  la RAM normale (`ramOffloadBudgetGb = budgetGb + max(0, ramGb - RESOURCE_SAFETY_MARGIN_GB)`, marge de 8 Go
  à l'époque). Sur la carte de Tom (dédiée mais probablement peu de VRAM), un modèle d'environ 20 Go a donc
  été choisi pour le palier Puissant — la quasi-TOTALITÉ tournant sur sa RAM plutôt que sa carte graphique,
  bien plus lent que le "30 s de plus" attendu pour un débordement PARTIEL. Ollama garde ensuite ce modèle
  chargé ("au chaud") plusieurs minutes après chaque question pour répondre plus vite à la suivante — donc
  ces ~20 Go restent occupés (et le processeur peut rester très sollicité si une génération est encore en
  cours, un tour de la boucle d'outils de `converse()` pouvant reprendre plusieurs fois de suite sur un
  modèle aussi lent) bien après que Tom ait cru que "rien ne se passait", laissant Windows + le reste avec
  seulement ~12 Go sur les 32 — assez pour saturer la machine entière si quoi que ce soit d'autre tournait.
  **Piège dans mon PREMIER correctif proposé, corrigé avant de coder quoi que ce soit** : j'ai d'abord
  recommandé de vérifier la RAM VRAIMENT LIBRE au moment du calcul (même philosophie que `getLiveGpuStatus`
  pour la VRAM, déjà utilisée pour le curseur de longueur de contexte) — mais en y réfléchissant plus loin
  AVANT de l'implémenter : le choix du modèle Puissant est FIGÉ une seule fois par le scan de capacité
  (`computeModelPicks`, appelé par `runQuickSetup`), typiquement juste après l'installation, quand la
  machine est justement TRÈS libre. Une mesure "en direct" à CE moment précis n'aurait donc rien changé pour
  Tom (RAM libre ≈ RAM totale à cet instant) : le vrai problème n'est pas "la RAM était déjà occupée au
  moment du choix", c'est "le calcul autorise un modèle dont la quasi-totalité doit vivre en RAM, point final,
  peu importe quand on mesure". **Leçon générale : une technique qui a bien marché pour un problème (VRAM en
  direct plutôt que VRAM totale, étape 114) ne se transpose pas automatiquement à un problème qui semble
  similaire en surface — vérifier que le mécanisme du bug est vraiment le même avant de recopier la même
  solution.** Corrigé à la place en relevant `RESOURCE_SAFETY_MARGIN_GB`/`RAM_SAFETY_MARGIN_GB` (dupliquée
  volontairement dans scripts/benchmark-models.mjs, même raison que d'habitude) de 8 à 16 Go : réduit d'autant
  le plus gros modèle autorisé à déborder sur la RAM, sur TOUTES les machines. **Changement PARTAGÉ, annoncé à
  Léo AVANT de l'appliquer plutôt qu'en silence** : cette marge conditionne aussi SON PROPRE modèle Puissant
  (qwen3.5:35b/27b déjà en usage, documenté plus haut) — informé que ce changement pourrait aussi faire
  reculer son propre choix vers un modèle plus petit, il a confirmé vouloir l'augmentation quand même plutôt
  que de risquer le même blocage chez d'autres personnes à VRAM modeste.
  **Ce qui reste un compromis assumé, pas une solution complète** : une marge FIXE plus grande réduit le
  risque sans l'éliminer — une machine avec encore moins de RAM libre au moment de l'usage réel (beaucoup
  d'autres logiciels ouverts alors qu'aucun ne l'était au moment du scan) pourrait en théorie retomber dans
  le même problème à une échelle réduite. Une vérification de RAM réellement libre AU MOMENT DE CHAQUE
  RÉPONSE (pas seulement au moment du scan) résoudrait ça plus complètement, mais demanderait de pouvoir
  changer de modèle Puissant EN COURS DE ROUTE — un changement d'architecture plus large, pas engagé ici sans
  un nouveau signalement qui le justifierait.
  Régression : `npm test` (286 tests, sans changement de comportement testable — chaque test qui exerce ce
  calcul injecte déjà sa propre marge simulée, indépendante de la constante réelle, donc aucun ne dépendait
  de sa valeur par défaut). **Non vérifiable ici** : que ce changement empêche vraiment le blocage chez Tom
  (pas d'accès à sa machine), et quel modèle exact ce changement fait basculer côté Léo lui-même (pas d'accès
  non plus à sa VRAM/RAM réelles depuis cet environnement) — à confirmer par un futur "Lancer l'analyse" chez
  l'un comme chez l'autre.

- **Étape 120, Léo : "regarde qu'on clique sur déplacer, dans les options ça déplace bien tout les fichiers
  plus ollama et quand il y a une mise à jour c'est dans le dossier choisit"** — une demande de VÉRIFICATION
  du "Déplacer" (Options → Modèles, étape 44, `modelsLocation.ts`), qui n'avait JAMAIS eu le moindre test de
  régression avant cette session (grep confirmé avant d'écrire quoi que ce soit).
  **Ce qui était déjà correct, confirmé par un vrai test plutôt que par une simple relecture** : les modèles
  Ollama SONT bien l'une des 3 briques déplacées (`ollamaModelsLink()`, `.ollama\models`), pas seulement
  Python/HuggingFace comme on pourrait le craindre en lisant vite le nom de la fonctionnalité. Et le flux de
  mise à jour d'Ollama (`updateOllama`/`dependencyServices.ts`) ne touche JAMAIS au dossier des modèles
  lui-même — seulement à l'application Ollama (redémarrage, installeur officiel, winget) — donc un modèle
  téléchargé après une mise à jour continue de passer par la jonction NTFS déjà posée, sans rien à refaire :
  vérifié par un test STRUCTUREL qui échoue si un futur changement de ce flux referençait un jour le chemin
  des modèles ou tentait d'y supprimer quoi que ce soit.
  **VRAI BUG trouvé en écrivant le test, jamais en relisant le code** : `redirectFolder`
  (modelsLocation.ts) ne créait jamais le dossier PARENT du lien (`link`) avant d'appeler `createJunction`
  (`mklink /J`) — exactement comme un symlink Unix classique, `mklink` ne crée JAMAIS les dossiers parents
  manquants tout seul. Sur une machine où Ollama/Python/`huggingface_hub` n'ont encore JAMAIS tourné une
  seule fois (ex: `%USERPROFILE%\.cache` n'existe pas tant qu'aucun modèle de transcription/synthèse n'a
  été téléchargé), le déplacement échouait purement et simplement pour cette brique-là avec un simple
  "dossier introuvable" — empêchant de préparer un déplacement AVANT le tout premier usage, un cas
  pourtant tout à fait raisonnable (déplacer dès l'installation, avant de laisser Jaris télécharger quoi
  que ce soit sur le disque système par défaut). Corrigé en ajoutant `await mkdir(dirname(link), {recursive:
  true})` juste avant `createJunction` — idempotent et sans effet si le parent existe déjà, donc aucun
  risque pour le cas normal (déjà utilisé au moins une fois) qui fonctionnait déjà. Vérifié en retirant
  temporairement cette ligne : le test échoue bien avec exactement le même message d'erreur qu'attendu
  ("ENOENT... dossier introuvable"), confirmant qu'il mord vraiment.
  **Comment le test contourne l'absence de Windows dans cet environnement** : `createJunction` lance
  `cmd.exe`/`mklink /J`, injoignable ici — le `child_process.spawn` est mocké pour poser un VRAI lien
  symbolique Linux à la place (`fs.symlinkSync`), qui se comporte IDENTIQUEMENT du point de vue du reste du
  module (`lstat().isSymbolicLink()` + `readlink()`, utilisés par `currentRealDir`) — seule la commande
  Windows elle-même est feinte, tout le reste (cp/mkdir/rm/lstat/readlink) est du VRAI fs sur un VRAI
  dossier temporaire. `process` est shadowé (paramètre de la fonction wrapper du chargeur de module, pas le
  global Node) pour forcer `process.platform` à `'win32'` (sinon `moveModelsLocation` ressort
  immédiatement, "Windows pour l'instant") sans jamais toucher au vrai `process` du test lui-même — même
  principe que les autres modules chargés en `vm.runInThisContext` dans ce dépôt, étendu ici au-delà de
  `require`/`exports`/`module` pour couvrir aussi `process`.
  Régression : `node --test scripts/test-models-location.mjs` (4 tests : les 3 briques dont Ollama sont bien
  déplacées avec leur contenu réel, un échec isolé sur une seule brique n'empêche pas les deux autres de
  réussir, un déplacement AVANT tout premier téléchargement pose quand même la jonction, et le flux de mise
  à jour d'Ollama ne référence jamais le dossier des modèles). **Non vérifiable ici, à confirmer par Léo en
  usage réel** : le comportement d'une VRAIE jonction NTFS Windows (par opposition au symlink Linux simulé
  ici) à travers un VRAI cycle complet déplacement -> mise à jour -> nouveau téléchargement, en particulier
  si l'installeur OFFICIEL d'Ollama (code que Jaris ne contrôle pas) fait un jour quelque chose d'inhabituel
  avec `.ollama\models` lors d'une réinstallation — invérifiable depuis ce dépôt, seul un usage réel avec
  Léo (ou Tom) peut le confirmer.

- **Étape 121, deux retours de Léo dans la foulée : "sa doit déplacer tout" (le bouton "Déplacer") et une
  capture d'un ami (Tom) montrant des accents cassés : "◆a marche pas. Ah si, c'est bon. Salut Charisse,
  ◆a va ?"** — soit "Ça marche pas... ça va ?", chaque "ç" arrivé à l'écran en caractère de remplacement.
  1. **"Déplacer" ne bougeait que les téléchargements lourds.** Léo l'a constaté ("le fichier jaris avec
     conversation cache ne change pas quand on clique sur déplacer"), et quand je lui ai demandé POURQUOI
     déplacer quelques Ko de JSON alors que la fonctionnalité vise des dizaines de Go, la réponse a été sans
     ambiguïté : "sa doit déplacer tout". Demande de COMPLÉTUDE, pas de place disque — et quand une demande
     explicite contredit le périmètre noté ici, c'est la demande qui gagne (même convention qu'à l'étape 96).
     **Mécanisme DIFFÉRENT des trois briques existantes, à dessein — le point le plus important de cette
     étape.** modelsLocation.ts pose une JONCTION NTFS sur le dossier habituel, transparente pour tout le
     monde (Ollama et Python ne savent rien de Jaris). Impossible de faire pareil ici : `app.getPath('userData')`
     héberge AUSSI les fichiers internes de Chromium (Cache, GPUCache, Local Storage, Network Persistent
     State...), ouverts en permanence par le process Electron EN TRAIN DE TOURNER — les copier/supprimer/
     rediriger pendant que Jaris tourne exposerait à une copie prise en plein milieu d'une écriture, ou à une
     suppression refusée par Windows, sur les seules données IRREMPLAÇABLES du programme (un modèle, ça se
     retéléécharge ; une conversation, non). Nouveau module `dataLocation.ts` : on ne touche JAMAIS au dossier
     userData lui-même, on copie uniquement ce que JARIS écrit lui-même (conversations, profil, mémoire,
     applications générées, rappels — de simples JSON/markdown ouverts-écrits-fermés à chaque fois, vérifié :
     aucun `createWriteStream`/`openSync` dans ces stores), et on laisse un petit MARQUEUR dans userData qui
     dit où ils vivent désormais. userData reste l'ancrage FIXE décidé par Windows : c'est là que Jaris
     cherche toujours ce marqueur au démarrage.
     **Les originaux ne sont JAMAIS supprimés**, contrairement aux trois autres briques — même politique que
     l'ancien `conversation-history.json` conservé à l'étape 96, pour la raison que Léo avait lui-même
     exprimée ("j'ai peur que plus on avance plus tu vas perdre des données"). Au pire il reste une copie
     périmée de quelques Mo à l'ancien emplacement, que plus rien ne lit une fois le marqueur écrit.
     **Jaris se relance tout seul après un déplacement réussi** (`app.relaunch()`, main.ts, avec `quitting =
     true` AVANT — sans quoi la fenêtre intercepte sa propre fermeture et se replie en widget, piège déjà
     documenté à l'étape 109) : les stores calculent leur chemin UNE fois au chargement du module, donc
     copier les fichiers ne suffit pas à leur faire lire le nouvel emplacement. Les services (Ollama, voix)
     ne sont PAS redémarrés dans ce cas — l'instance suivante les relance elle-même à son démarrage normal,
     les redémarrer pour les tuer une seconde plus tard n'aurait servi à rien.
     **Piège déjà écrit dans ce fichier, revécu quand même** : ajouter l'import de `dataLocation` aux 5 stores
     a fait échouer 29 tests d'un coup ("Cannot read properties of undefined (reading 'getDataRoot')") — les
     faux ponts des tests EXISTANTS (`test-codegen-*.mjs`, `test-conversations.mjs`) ne fournissaient pas ce
     nouveau module. Le réflexe à garder, pour de bon : après avoir ajouté un `import` à un module déjà chargé
     par des tests, `grep` TOUS les faux ponts avant de lancer la suite.
  2. **Les accents cassés : cause REPRODUITE, jamais supposée.** Python 3.12 (la série embarquée par Jaris,
     `PYTHON_SERIES` dans pythonRuntime.ts) choisit l'encodage de `sys.stdout` d'après la PAGE DE CODES
     Windows quand la sortie est un tube, PAS UTF-8. Sur un Windows français ordinaire (cp1252),
     `json.dumps(..., ensure_ascii=False)` écrit donc "ça" en UN octet 0xE7, alors que Node lit toujours de
     l'UTF-8 : le caractère devient "�". Vérifié pour de vrai avant d'écrire la moindre ligne de correctif —
     un script Python minimal lancé avec `PYTHONIOENCODING=cp1252`, lu par le même `readline` que
     voiceClient.ts, a rendu EXACTEMENT la capture de Tom : `�a marche pas. Salut Charisse, �a va ?`.
     Corrigé par `sys.stdout.reconfigure(encoding="utf-8")` (+ stderr, qui porte les diagnostics français de
     `debug()`) en tête des DEUX sidecars — voice_server.py ET tts_server.py, tous deux concernés (leçon de
     l'étape 112 : lister tous les appelants du même motif, pas seulement celui qui a été signalé).
     **Pourquoi Léo ne l'avait jamais vu** : sa page de codes est déjà en UTF-8 (option Windows "Bêta :
     utiliser UTF-8"), donc chez lui ça marchait par chance. C'est un bug qui n'apparaît QUE sur la machine de
     quelqu'un d'autre — d'où l'intérêt d'un vrai test plutôt que d'un essai local. **Leçon générale : ne
     jamais laisser l'encodage d'un flux au réglage de la machine ; un sidecar doit imposer son UTF-8, sinon
     il marche chez le développeur et casse chez l'utilisateur.**
     **Deuxième défaut du même symptôme, côté Node, corrigé au passage** : la lecture de la liste des micros
     accumulait `chunk.toString()` morceau par morceau — un caractère accentué (2 octets en UTF-8) tombant à
     cheval sur deux morceaux se serait cassé en deux "�" MÊME avec un flux parfaitement valide. Les noms de
     micros Windows en sont pleins ("Microphone (Réseau)"). Corrigé par `setEncoding('utf8')`, qui garde
     l'octet incomplet pour le morceau suivant. Le flux principal, lui, passait déjà par `readline` (qui gère
     ça correctement) — d'où un seul endroit à corriger, trouvé en relisant les DEUX lectures de stdout.
  Régression : `node --test scripts/test-data-location.mjs scripts/test-sidecar-encoding.mjs` (302 tests au
  total). Le test d'encodage est COMPORTEMENTAL, pas seulement structurel : il relance vraiment Python avec
  `PYTHONIOENCODING=cp1252` et vérifie que "Ça marche pas. Salut Charisse, ça va ?" traverse le tube intact —
  vérifié en retirant le `reconfigure` du script généré, le test échoue alors avec `actual: '�a marche pas.
  Salut Charisse, �a va ?'`, mot pour mot la capture de Tom. Ignoré avec une raison explicite si Python manque
  (la CI l'installe APRÈS `npm test`), jamais silencieusement vert. **Non vérifiable ici, à confirmer par Léo
  en usage réel** : que "Déplacer" relance bien Jaris sur sa vraie machine Windows et qu'il retrouve toutes
  ses conversations au nouvel emplacement.

- **Étape 119 : refonte visuelle de la page Options à partir d'une vraie maquette (`prompt-design-jaris.md` +
  `Options Jaris.dc.html`, handoff Claude Design), PAS une nouvelle plainte de Léo cette fois — la refonte
  précédente (étapes 115-118) avait déjà posé `SettingRow`/`SettingGroup`, les deux catégories de navigation
  et les regroupements Voix/Modèles/Général. Décision de périmètre prise AVANT de coder : garder ces
  fondations (elles répondent déjà, dans le code, à la même demande "tout se ressemble" que documente la
  maquette) plutôt que de tout réécrire à partir de zéro — seuls les écarts RÉELS entre le rendu compilé et
  la maquette ont été corrigés, pas une réécriture "au cas où elle diffère ailleurs".**
  1. **Interrupteur à coins coupés, remplace la case à cocher native** (les 4 réglages "Bips d'interface",
     "+", "clic sur l'orbe", "mot d'activation") : nouveau composant `Toggle` (OptionsMenu.tsx) rendu en
     `<button role="switch" aria-checked>`, jamais un `<input type="checkbox">` stylé — impossible d'obtenir
     un rail + curseur en deux calques `clip-path` indépendants sur l'apparence d'une case native
     (`accent-color`/`appearance` ne composent pas, ils remplacent l'apparence en bloc). Nouvelles classes
     `.options-menu__switch`/`.options-menu__switch--on`/`.options-menu__switch-knob` (index.css),
     `.options-menu__toggle` (case 18x18, seule commande de tout l'écran encore en coins arrondis) retirée —
     plus aucun consommateur en JSX, vérifié par grep avant suppression.
  2. **Équerres d'angle ajoutées à `.options-menu__group`** (les cartes "Son", "Micro et haut-parleur",
     "Comment déclencher l'écoute"...) : seule famille de panneaux de la page encore "plate" (juste bordure +
     fond, sans les deux coins lumineux) au milieu d'un thème où c'est justement CE détail qui fait lire
     "instrument" plutôt que "site web" (voir le commentaire de tête de la section "COUCHE HUD" du fichier).
     Ajoutée à la même liste de sélecteurs que `.options-menu__model-group`/`.capacity-scan__tier`/etc.,
     jamais un second bloc de règles dupliqué à côté.
  3. **"Emplacement des modèles" déplacé de Général vers Modèles, fusionné avec Ollama dans un nouveau
     panneau "Fichiers et moteur local"** — la maquette (et la mission-design, section 1 : "Modèles (...
     mise à jour d'Ollama, emplacement des modèles)") les regroupe tous les deux sous Modèles, pas sous
     Général : ce ne sont pas des réglages de l'application Jaris elle-même, mais des fichiers/moteurs locaux
     qu'elle fait tourner. La lecture de `getModelsLocationStatus()` (déjà existante, aucun nouveau canal
     IPC) se déclenche donc maintenant à l'ouverture de l'onglet Modèles, plus à celle de Général. **Effet de
     bord volontaire, documenté plutôt que caché** : la ligne "Ollama" est désormais visible même quand
     Ollama est à jour (avant : rien ne s'affichait tant qu'aucune mise à jour n'était trouvée) — seule la
     MISE EN FORME de `ollamaVersionStatus` (déjà lu par un appel IPC existant) change, pas la logique.
  4. **Pas touché, à dessein** : `HardwareTierPreview.tsx` (déjà réutilisé tel quel, comme demandé par la
     mission-design — "reuse it, don't reinvent the table" — même s'il affiche TOUS les paliers avec le
     courant en évidence plutôt que le seul palier courant de la maquette, à la demande explicite antérieure
     de Léo documentée plus haut dans ce fichier), `JarisOrb` (déjà réutilisé avec sa prop `color`, jamais un
     rond CSS), la colonne de contrôle des lignes (`.options-menu__row-control`) reste en largeur automatique
     plutôt que la colonne fixe de 240px de la maquette — écart cosmétique mineur laissé de côté pour ne pas
     rouvrir le calcul de largeur de TOUTES les lignes (menus déroulants, boutons doubles de l'historique...)
     dans ce même commit.
  **Bug pré-existant repéré en écran étroit (760px), PAS corrigé ici** : le libellé "Retester la
  configuration" (onglet Modèles) s'enroule mot par mot sur une douzaine de lignes à 760px, poussé par le
  bouton voisin qui ne rétrécit pas — confirmé pré-existant (même symptôme capturé sur le code d'AVANT ce
  commit, avant de toucher quoi que ce soit) et sans rapport avec les changements de cette étape : laissé
  volontairement pour une prochaine étape plutôt que d'élargir le périmètre de celle-ci.
  Régression : `npm test` (303 tests) — `scripts/test-options-reorganization-ui.mjs` mis à jour pour la
  nouvelle liste de titres (Général : `['Mise à jour', 'Historique des conversations']`, sans "Emplacement
  des modèles" ; nouveau test dédié vérifiant que Modèles affiche bien `['Longueur de mémoire', 'Les paliers
  de configuration', 'Fichiers et moteur local']` et que le dossier des modèles y est bien présent), vérifié
  mordant en réintroduisant temporairement l'ancien groupe dans Général (le test échoue bien avec le titre en
  trop) avant de confirmer qu'il passe sur le nouveau rendu. Vérifié par capture d'écran réelle du rendu
  compilé (bundle esbuild + vrai CSS) sur les onglets Voix et Modèles, à 1280px et 760px : aucun défilement
  horizontal aux deux largeurs (`scrollWidth` mesuré égal à la largeur de la fenêtre), l'interrupteur porte
  bien le `clip-path` réel (mesuré par `getComputedStyle`, pas relu dans le CSS), et `.options-menu__group`
  porte bien ses équerres (`::before`/`::after` avec `content: '""'` mesurés).

- **Étape 120 : le rapport de l'étape 119 surestimait la fidélité réelle à la maquette — repéré par Léo, PAS
  par une relecture interne.** Léo a comparé le rendu réel à la maquette (`Options Jaris.dc.html`) après le
  commit de l'étape 119 et a demandé confirmation ("mais tu a pas fait totalement comme claude design ?"). En
  reconstruisant le composant réel (esbuild + vrai CSS compilé) plutôt qu'en relisant le résumé du commit
  précédent : deux écarts RÉELS avaient été manqués, malgré l'étape 119 qui affirmait n'avoir laissé que des
  écarts "cosmétiques mineurs".
  1. **"Son" était encore un groupe à UNE SEULE ligne** (juste le bip d'interface), séparé de "Micro et
     haut-parleur" — exactement la "carte à une seule ligne" que la maquette dit d'éliminer, et que l'étape
     119 prétendait déjà résolue par les étapes 115-118. Fusionnés en un seul groupe "Son et périphériques"
     (copie exacte de la maquette), qui contient maintenant : bip d'interface, micro, haut-parleur, test du
     micro.
  2. **Le sélecteur de voix était le SEUL bloc de tout l'écran sans bordure/équerres ni titre de section** —
     un flottant au milieu de panneaux titrés partout ailleurs, alors que la maquette le présente comme un
     panneau "La voix de Jaris" comme les autres. `SettingGroup` accepte n'importe quel enfant (pas seulement
     des `SettingRow`), donc l'envelopper a suffi sans toucher à sa mise en page interne (centrée).
  3. **Titres de section pas alignés sur la copie exacte de la maquette**, alors que Léo l'avait fournie mot
     pour mot : "Comment déclencher l'écoute" → "Déclencher l'écoute", "Longueur de mémoire" → "Mémoire de
     conversation", "Les paliers de configuration" → "Ce que ta machine fait tourner".
  **Toujours pas touché, à dessein (mêmes raisons qu'à l'étape 119)** : la colonne de contrôle en largeur
  auto plutôt que 240px fixe, le bug de retour à la ligne de "Retester la configuration" à 760px, et
  "Historique des conversations" qui affiche la VRAIE liste des échanges (comportement existant, précieux)
  plutôt que le simple compteur "128 échanges" de la maquette (qui ne pouvait représenter que des données
  factices, faute d'accès aux vraies).
  **Leçon générale, à ne pas oublier** : après avoir livré une refonte visuelle face à une maquette de
  référence, RE-VÉRIFIER par un rendu réel (pas relire le diff ni faire confiance au résumé déjà écrit) que
  chaque panneau de la maquette a un équivalent structurel dans le rendu compilé — un résumé de commit qui
  affirme "tous les écarts réels corrigés" peut lui-même en avoir raté, surtout pour un élément qui n'a
  jamais eu besoin de changer de CLASSE CSS (comme le sélecteur de voix, jamais cassé, juste jamais habillé
  comme le reste) et qui passe donc facilement inaperçu d'un simple diff de code.
  Régression : `npm test` (303 tests) — `scripts/test-options-reorganization-ui.mjs` et
  `scripts/test-context-length-ui.mjs` mis à jour pour les nouveaux titres, vérifié mordant. Vérifié par
  capture d'écran réelle du rendu compilé (bundle esbuild + vrai CSS) sur les 3 onglets Voix/Modèles/Général
  à 1280px, et par mesure `scrollWidth`/`clientWidth` à 760px (aucun défilement horizontal).

- **Deux sessions Claude ont travaillé EN PARALLÈLE sur ce même correctif (design importé, Voix/Modèles/
  Général) sans le savoir, chacune sur sa propre branche — v0.14.6/v0.14.7 sur CETTE branche
  (session_01QcAbDpze6PJcbfsRPEtacY) et v0.14.6 sur `claude/admiring-ride-ow6t1v`
  (session_01F7US6NdL4t2QGBZ4iSs5LC) — toutes deux parties du même commit v0.14.5.** Léo a envoyé une
  capture du mockup ET une capture de son app réelle (v0.14.7, donc CETTE branche) côte à côte : "c'est pas
  pareil les 2 et j'ai la version 14.7" — deux vrais écarts restaient malgré les commits v0.14.6/v0.14.7
  déjà livrés ici :
  1. **Ordre des lignes dans "Son et périphériques"** : le code avait "Bips d'interface" EN PREMIER (hérité
     de l'ancien groupe "Son" séparé, jamais réordonné en fusionnant), le mockup montre Micro/Haut-parleur/
     Bips/Tester. Réordonné pour correspondre exactement.
  2. **Texte de "Déclencher l'écoute"** : le TITRE avait bien été aligné sur le mockup, mais pas la
     DESCRIPTION du groupe — restée à "Les trois façons d'activer Jaris sont indépendantes : décoche celles
     dont tu ne veux pas." (formulation négative) au lieu de "Les trois façons sont indépendantes : garde
     celles que tu utilises." (formulation positive du mockup) — un titre qui correspond ne garantit pas que
     tout le texte du bloc correspond aussi.
  **Sur `claude/admiring-ride-ow6t1v` (l'autre session), une refonte BEAUCOUP plus large avait été faite en
  parallèle** (vue compacte "ton palier" au lieu des ~10 empilés, GPU/VRAM/RAM réellement détectés affichés,
  "Emplacement des données" avec un nouveau canal IPC, historique remplacé par un simple compteur) — mais
  son tag de release (v0.14.6) est entré en COLLISION avec celui déjà publié par CETTE branche
  (`gh release view $tag` réussit -> "rien à faire", voir le workflow) : ce travail n'a donc JAMAIS été
  publié nulle part, et Léo n'a jamais pu le voir. Reconcilié en portant ICI uniquement les deux corrections
  ponctuelles ci-dessus (celles que Léo montrait concrètement), pas la refonte plus large de l'autre
  session — hors périmètre de ce signalement précis, et cette branche-ci avait explicitement choisi de GARDER
  la vraie liste d'historique plutôt que le simple compteur du mockup ("comportement existant précieux",
  v0.14.7) : un choix déjà fait sciemment, pas un oubli à corriger.
  **Leçon générale, pour la prochaine fois que deux sessions travaillent le même dépôt sans le savoir** : le
  workflow de release (`build-installer.yml`) skip silencieusement une release dont le tag existe déjà — un
  push réussi et un build vert NE PROUVENT PAS que le travail a été publié quelque part d'accessible à
  l'utilisateur. Avant de conclure qu'un correctif est "livré", vérifier que la Release GitHub correspond
  VRAIMENT au commit qu'on vient de pousser (`target_commitish`), pas seulement que le tag existe.
  Régression : `npm test` (303 tests, inchangé — aucun test n'asserte l'ordre des lignes dans un groupe ni
  le texte exact de cette description, donc rien à mettre à jour). Vérifié par capture d'écran réelle du
  rendu compilé (bundle esbuild + vrai CSS) de l'onglet Voix, comparée directement à la capture du mockup
  envoyée par Léo — ordre et texte identiques.

- **v0.14.8 toujours "pareil" pour Léo malgré l'ordre et le texte corrigés (v0.14.9) : le VRAI écart
  restant n'était pas dans ce que j'avais déjà comparé.** Après la correction précédente, Léo a renvoyé une
  capture de sa propre app avec juste "c'est toujours pareil" — la capture montrait en réalité déjà le bon
  ordre ET le bon texte de "Déclencher l'écoute", donc rien de ce que le commit précédent visait n'était
  encore en cause. Comparée ligne par ligne à la capture ORIGINALE du mockup (celle qui montrait toute la
  page, pas seulement le panneau recadré envoyé après) : "Micro utilisé" et "Haut-parleur utilisé" ont
  chacun une phrase d'aide PERMANENTE dans le mockup ("Changer de micro relance l'écoute : quelques
  secondes." / "Là où Jaris parle.") — le code n'affichait RIEN sous ces deux lignes en usage normal
  (`description={... : undefined}` pour le micro, aucune prop `description` du tout pour le haut-parleur).
  Deux lignes plus courtes que le mockup, silencieusement, depuis le tout premier commit de cette série —
  jamais repéré parce que les comparaisons précédentes s'étaient concentrées sur les titres/l'ordre/le texte
  DÉJÀ signalés, pas sur une relecture complète ligne par ligne de tout le panneau contre le mockup.
  Corrigé en donnant à "Micro utilisé" cette phrase comme repli par défaut (au lieu de `undefined`, les deux
  cas dynamiques — aucun micro détecté, changement en cours — restent prioritaires) et en ajoutant la
  description manquante à "Haut-parleur utilisé".
  **Leçon générale, qui rejoint celle déjà tirée sur la vérification écran par écran plus haut** : corriger
  les écarts qu'un signalement précédent a explicitement nommés ne garantit pas d'avoir tout trouvé — un
  utilisateur qui dit "c'est toujours pareil" après un vrai correctif ciblé signale souvent un AUTRE écart
  resté invisible parce que jamais explicitement pointé, pas que le correctif précédent a échoué. Toujours
  reprendre la comparaison mockup-contre-rendu-réel depuis le début (chaque ligne, chaque description), pas
  seulement re-vérifier ce qui a déjà été corrigé.
  Régression : `npm test` (303 tests, inchangé). Vérifié par capture d'écran réelle du rendu compilé,
  comparée ligne par ligne à la capture originale du mockup — les deux phrases d'aide sont maintenant
  identiques, texte et position.

- **v0.14.9 encore "pas compris" (v0.14.10) : la vraie cause de tous les allers-retours précédents — je
  comparais des CAPTURES RECADRÉES sur les cartes, jamais la page COMPLÈTE.** Léo, après v0.14.9 : "non tu a
  pas compris ma demande, voici se qu'on a et se que je veut en plus normalement je t'ai envoyer le prompt de
  claude design" — avec DEUX captures cette fois, l'une de la page COMPLÈTE (en-tête inclus), l'autre du
  panneau recadré comme les fois précédentes. Comparaison faite pour de vrai contre l'image complète, pas
  seulement les cartes :
  1. **Un titre + sous-titre de PAGE manquait entièrement, invisible dans toutes mes captures précédentes**
     (toujours recadrées sur `.options-menu__voice-picker` en premier plan). Chacun des 3 onglets de réglages
     a dans le mockup un `<h3>` + une phrase d'intro AU-DESSUS de la première carte : "Voix" / "La voix de
     Jaris, les périphériques qu'il utilise, et les façons de le réveiller." (idem Modèles/Général, textes
     exacts en commentaire de `TAB_META`, OptionsMenu.tsx). Ajouté un objet `TAB_META` + un bloc rendu juste
     après `.options-page__content`, PAS pour "Ce que Jaris sait faire" (capacites) qui garde sa propre intro
     déjà dans sa section depuis l'étape 111.
  2. **Trois écarts de texte fins, jamais remarqués avant une comparaison mot à mot** : "Bips d'interface" se
     terminait par ", un scan..." (absent du mockup, qui s'arrête à "un clic.") ; le bouton "Tester le micro"
     était en toutes lettres au lieu du court "Tester"/"Arrêter" du mockup (le libellé de LIGNE reste "Tester
     le micro", seul le texte du BOUTON change) ; les guillemets français « » du mockup ("Touche « + » du
     pavé numérique", "Dire « Jaris » à voix haute") étaient restés en guillemets droits `"..."` dans le code.
  3. **Le long paragraphe sous "Déclencher l'écoute"** (avertissement complet sur "Jarvis"/"il a ri") n'existe
     PAS dans le mockup, qui porte à la place une description COURTE directement sous la ligne "Dire « Jaris »
     à voix haute" : "Pas toujours parfait : « Jarvis » peut aussi le réveiller." Remplacé le paragraphe par
     cette description de ligne — `.options-menu__model-overview-hint` retirée du CSS, plus aucun consommateur.
  **Pourquoi ces 4 écarts avaient survécu à 3 sessions de correctifs successives (v0.14.6 à v0.14.9, deux
  branches)** : chaque comparaison précédente prenait une capture qui commençait DIRECTEMENT sur la première
  carte (`.options-menu__voice-picker`), jamais la page entière — un titre de page au-dessus des cartes ne
  pouvait tout simplement pas apparaître dans le cadrage utilisé pour vérifier. Et les 3 écarts de texte fins
  demandaient une comparaison caractère par caractère, jamais faite jusqu'ici (les comparaisons visaient des
  écarts STRUCTURELS — cartes manquantes, ordre, titres de section — pas le contenu exact de chaque phrase).
  **Leçon générale, qui prolonge celle de v0.14.9 : "toujours pareil" après plusieurs correctifs ciblés
  successifs signifie souvent que la MÉTHODE de comparaison elle-même est incomplète, pas seulement qu'un
  écart de plus reste à corriger.** Ici, le cadrage des captures (jamais la page complète) et la profondeur
  de la comparaison (structure seulement, jamais le texte mot à mot) limitaient systématiquement ce qui
  POUVAIT être trouvé, quel que soit le soin apporté à chaque correctif individuel — corrigé en prenant
  systématiquement une capture PLEINE PAGE (en-tête compris) et en comparant le texte de CHAQUE ligne, pas
  seulement les titres de carte et l'ordre.
  Régression : `node --test scripts/test-options-reorganization-ui.mjs` (304 tests au total) — nouveau test
  dédié qui vérifie le texte RÉEL affiché du titre + sous-titre pour les 3 onglets de réglages ET l'absence
  de ce gabarit sur "Ce que Jaris sait faire", vérifié mordant en désactivant temporairement `TAB_META` (le
  test échoue bien, confirmé avant de le committer). Vérifié en plus par capture d'écran réelle des 3 onglets
  (en-tête inclus cette fois) comparée directement aux deux captures envoyées par Léo.

- **v0.14.10 encore "pas compris" (v0.14.11) : cette fois le problème n'était PAS le texte, c'était toute la
  DISPOSITION de la carte "La voix de Jaris" — jamais remise en cause depuis les étapes 76-78.** Léo, capture
  RECADRÉE sur cette seule carte, sans ambiguïté possible cette fois : "tu a toujours pas compris que c'etais
  ça que faut changer, je veut que ça ressemble a ça". La capture montrait une carte COMPACTE en une seule
  bande horizontale — orbe (petit, ~100px) + flèches à GAUCHE, "M3 Autoritaire, confiante" sur une seule
  ligne à DROITE, points en dessous, une phrase d'aide en dessous — alors que le code affichait depuis
  l'étape 78 une grande carte centrée VERTICALEMENT (orbe à 320px, nom centré dessous, description centrée
  encore dessous), occupant plus de 600px de haut à elle seule.
  **Pourquoi cet écart avait survécu à 4 sessions de correctifs (v0.14.6 à v0.14.10)** : toutes les
  comparisons précédentes (y compris la capture pleine page de v0.14.10) montraient cette carte suffisamment
  PETITE à l'écran pour que sa disposition verticale centrée ne saute pas aux yeux — il a fallu une capture
  RECADRÉE SUR ELLE SEULE, en gros plan, pour que la différence de forme devienne évidente. Aucune des
  comparaisons "ligne par ligne" de v0.14.10 n'aurait pu la détecter : le TEXTE de chaque élément (nom,
  description, points) était déjà correct, seul leur AGENCEMENT relatif était faux.
  **Contredit explicitement une décision écrite à l'étape 78** ("je veut la meme taille que dans l'aceuille
  la meme" — Léo avait alors demandé la MÊME taille que l'orbe de l'écran d'accueil, 320px, pour CETTE carte
  précise) : cette exigence est abandonnée ici pour cette carte, remplacée par la disposition compacte de la
  maquette — même convention que l'étape 96 face à l'étape 47, la demande la plus récente et la plus précise
  (une capture recadrée, sans ambiguïté) l'emporte sur une décision plus ancienne. L'écran d'accueil (App.tsx,
  mode 'voice'), qui n'a jamais été mis en cause dans aucun de ces échanges, garde lui son orbe à 320px —
  seule CETTE carte du menu Options change.
  Restructuré en deux blocs flex côte à côte : `.options-menu__voice-nav` (flèches + orbe, `size={100}`,
  inchangé côté logique) à gauche, un nouveau `.options-menu__voice-info` (nom+descripteur sur une ligne,
  points, phrase d'aide) à droite — la phrase d'aide elle-même ("Chaque voix est écoutée dès qu'elle est
  choisie. Le cercle prend sa couleur pour que tu la reconnaisses d'un coup d'œil.") était elle aussi
  entièrement absente du code jusqu'ici, encore un texte de la maquette jamais transcrit.
  **Leçon générale, qui complète celle de v0.14.10 sur le cadrage des captures** : une capture pleine page
  suffit pour repérer des éléments STRUCTURELS manquants (un titre de page entier, par exemple), mais peut
  masquer un écart de DISPOSITION au sein d'un même élément si celui-ci reste petit à l'échelle de la page —
  il faut alors une capture RECADRÉE, en gros plan, sur l'élément précis en cause. Les deux cadrages (pleine
  page ET recadré) sont complémentaires, aucun des deux ne suffit seul à tout détecter.
  Régression : `node --test scripts/test-options-reorganization-ui.mjs` (305 tests) — nouveau test dédié qui
  mesure les rectangles réels de l'orbe et du nom ("M3" doit être à côté de l'orbe, pas dessous, et la carte
  doit rester sous 250px de haut), vérifié mordant en forçant temporairement `flex-direction: column` sur
  `.options-menu__voice-picker` (le test échoue bien, confirmé avant de le committer). Vérifié en plus par
  capture d'écran réelle RECADRÉE sur cette seule carte, comparée directement à celle envoyée par Léo.

- **v0.14.11 corrigeait bien la disposition de "La voix de Jaris", mais Léo a ensuite pointé un défaut de
  RESPIRATION resté partout (v0.14.12), capture annotée de traits rouges cette fois plutôt qu'une phrase
  seule.** "augmente un peut la taille des carre la ou j'ai entourée entre la barre et le texte et la fin du
  rectangle pour tout les rectangle dans option" — les traits entouraient le dessous du titre de CHAQUE carte
  ("la barre", le trait qui suit le titre de section) ET le bas de la première carte, juste avant le bord.
  **Cause exacte, mesurée avant de corriger** : `.options-menu__group` (la carte commune à TOUS les groupes
  de réglages, Voix/Modèles/Général) n'avait AUCUN `gap` entre son titre et son contenu — le seul espace
  visible entre le titre et le premier réglage venait du `padding-top` PROPRE de `.options-menu__row` (14px),
  jamais d'un espacement au niveau de la carte elle-même ; pareil en bas, où seul le `padding-bottom` de la
  carte (14px, déjà cumulé avec le padding-bottom du dernier `.options-menu__row`) donnait de l'air. Mesuré
  avec Playwright AVANT toute correction (`getBoundingClientRect` sur le titre, la première ligne et le bas
  de la carte) : 14px en haut comme en bas — exactement ce que Léo montrait comme trop serré.
  **Piège dans mon premier réglage, corrigé avant de livrer** : `gap: 14px` (la même valeur que le padding
  d'une ligne) semblait un choix naturel, mais ce `gap` s'AJOUTE au padding-top de 14px déjà présent sur la
  première ligne, doublant l'écart réel à 28px — bien plus que "un peu" demandé. Redescendu à `gap: 8px`
  (mesuré : 14px -> 22px, +8px, un vrai "un peu") et le padding bas de la carte relevé de 14px à 24px
  (14px -> 25px mesuré, la ligne garde son propre padding inchangé). Le `gap` est posé sur `.options-menu__group`
  lui-même (titre / description optionnelle / bloc des lignes), donc il n'ajoute RIEN entre les lignes
  individuelles À L'INTÉRIEUR d'une carte (gérées par leur propre padding, jamais touché) — seulement entre le
  titre et le premier contenu, exactement le périmètre demandé.
  **"Pour tout les rectangle dans option" couvert par construction** : `.options-menu__group` est la classe
  PARTAGÉE par les 8 `SettingGroup` de l'app (Voix, Modèles, Général) — un seul correctif dans cette classe
  s'applique automatiquement partout, sans avoir à toucher chaque onglet séparément (le composant `SettingRow`/
  `SettingGroup`, étape 116, existe justement pour ça : une seule source de vérité pour l'apparence de toutes
  les cartes de réglages).
  Régression : `node --test scripts/test-options-reorganization-ui.mjs` (306 tests) — nouveau test dédié qui
  mesure les VRAIS écarts en pixels (titre -> premier réglage, dernier réglage -> bas de carte) sur une carte
  réelle et exige qu'ils dépassent 18px (contre 14px avant) sans dépasser 40px (pour éviter l'excès inverse),
  vérifié mordant en remettant temporairement l'ancien padding/gap (le test échoue bien, confirmé avant de le
  committer). Vérifié en plus par capture d'écran réelle pleine page, comparée à la disposition demandée par
  Léo.

- **Étape 122, Léo : "deplace Fichiers et moteur local avec dossier etc... dans général" (capture de l'onglet
  Général montrant seulement "Mise à jour", pour montrer où la carte manquait).** La carte "Fichiers et
  moteur local" (Ollama + dossier des modèles) avait rejoint Modèles à l'étape 119 en suivant la maquette
  "Options Jaris.dc.html" — demande explicite de Léo pour la remettre dans Général, qui l'emporte sur le
  choix de la maquette (même convention que l'étape 96 face à l'étape 47, ou l'étape 121 face à l'étape 119).
  Bloc JSX déplacé tel quel (SettingGroup "Fichiers et moteur local") de la section `tab === 'modeles'` vers
  `tab === 'general'`, entre "Mise à jour" et "Historique des conversations" — l'ordre historique de Général
  avant l'étape 119 (Mise à jour/Stockage/Historique, étape 115).
  **Piège trouvé en lançant `npm test`, pas en relisant le JSX** : les deux lectures IPC qui remplissent
  cette carte (`getOllamaVersionStatus`, `getModelsLocationStatus`) étaient armées par un `useEffect` gaté
  sur `tab === 'modeles'` (logique de l'étape 119, jamais retouchée en déplaçant le JSX) — la carte se
  serait donc affichée FIGÉE, sans jamais recevoir ses données, dès qu'on ouvrait Général en premier. Un test
  Playwright existant (`Général regroupe VRAIMENT...`) a échoué exactement là-dessus ("la liste des
  emplacements doit être présente"), pas une intuition. Corrigé en déplaçant ces deux appels dans le bloc
  `if (tab === 'general')` du même effet, à côté de `getAppVersionStatus`/`getAppVersion` déjà là. **Leçon
  générale, déjà rencontrée sous d'autres formes dans ce fichier (le "+" gaté d'un seul côté, le check WSL
  dans la mauvaise branche) : déplacer un bloc de RENDU (JSX) ne déplace pas avec lui la logique qui le
  NOURRIT (l'effet qui charge ses données) — les deux doivent être cherchés et déplacés ensemble.**
  Deux tests mis à jour dans `test-options-reorganization-ui.mjs` : celui de Général vérifie maintenant les 3
  titres dans l'ordre (`Mise à jour`, `Fichiers et moteur local`, `Historique des conversations`) et que le
  contenu (dossier des modèles, liste des emplacements) y est bien présent ; celui de Modèles vérifie
  l'inverse (seulement `Mémoire de conversation`/`Ce que ta machine fait tourner`, et que "Dossier des
  modèles" en a bien disparu — pas seulement qu'il reste ailleurs, mais qu'il n'est plus dupliqué ici).
  Vérifié par capture d'écran réelle de l'onglet Général (bundle esbuild + vrai CSS compilé) : les 3 cartes
  s'affichent dans le bon ordre, avec de vraies données (version Ollama, chemins des dossiers), avant de
  considérer le déplacement terminé — pas seulement le passage des tests.
  Régression : `npm test` (306/306, `Fichiers et moteur local` déplacé de Modèles vers Général dans les deux
  tests concernés).

- **Étape 123, Léo : "tu vois quand on va sur chat code agent vocal et on part de jaris il se met en inactif
  en widget et peut être appelé, je veux que quand on se met dans chat, et on part on peut faire plus comme
  pour le vocal et ça met une barre de texte en haut au centre comme le widget vocal, et on peut lui
  demander une question sans aller directement sur l'application. As-tu bien compris ? avant de commencer".**
  Question posée AVANT de coder (il le demandait explicitement) : 3 choix simples, qui ont chacun changé le
  périmètre. Réponses : (1) "comme pour le vocal en inactif, sauf qu'à la place d'avoir un cercle, et qui
  écoute, une barre de texte pour le chat" — donc la barre REMPLACE le cercle, et Jaris n'écoute plus ;
  (2) "comme pour le widget vocal mais à la place une barre" — la réponse s'affiche DANS le widget, sans
  rouvrir l'application ; (3) mode Code : "ça doit rien faire aucun widget". Sans ces 3 réponses j'aurais
  implémenté un cercle + une barre côte à côte, avec l'écoute toujours active et la même forme en Code.
  **Le repli dépend maintenant du mode actif, et d'une seule source.** `activeMode` (main.ts) est retenu par
  le handler `setActiveMode` qui existait déjà pour suspendre l'écoute ; `currentWidgetMode()` en dérive la
  forme, et la taille NATIVE de la fenêtre comme le contenu DESSINÉ en découlent tous les deux. C'est la
  leçon de l'orbe rogné en fine bande (étape 85) appliquée d'emblée : deux composants qui décident séparément
  du même état finissent toujours par se contredire. Retenu côté main plutôt que redemandé au renderer au
  moment du repli : la fenêtre est déjà en train de perdre le focus à cet instant, un aller-retour IPC
  arriverait trop tard pour choisir la taille AVANT d'afficher.
  **L'écoute ne reprend plus au repli que depuis le mode voix** (`applyListeningForActiveMode`). Ça
  CONTREDIT volontairement le `setListeningSuspended(false)` forcé de l'étape 72, et pour une raison qui
  n'existe que maintenant : ce forçage était là parce que le widget était TOUJOURS le widget vocal, donc un
  utilisateur qui ne voyait plus que le cercle n'avait aucune raison de deviner pourquoi Jaris ne répondait
  plus à sa voix. Désormais la forme du widget dit elle-même dans quel état on est (barre = écrit, cercle =
  voix), donc l'ambiguïté qui justifiait le forçage a disparu. **Leçon générale : un garde posé pour lever
  une ambiguïté peut devenir inutile — voire nuisible — quand l'interface lève cette ambiguïté toute seule ;
  le retirer demande de vérifier que la raison d'origine ne tient plus, pas seulement que le code compile.**
  **Deux pièges CSS de ce fichier retombés dessus, tous les deux attrapés par une MESURE, pas en relisant.**
  (1) `.app--widget-chat { padding: 4px 6px }` écrit avec le reste du widget texte était silencieusement
  écrasé par `.app--widget { padding: 0 }`, déclaré plus bas — à spécificité égale, la dernière règle du
  fichier gagne (piège de l'étape 95, déjà documenté). Repéré parce que la mesure renvoyait `padding: 0px`
  alors qu'il était bien déclaré. (2) La règle générale `input, ... { border/background !important }` aurait
  redessiné un cadre carré à l'intérieur de la pilule arrondie : `.chat-widget__input` est donc exclu comme
  `.composer__input` et `.options-menu__context-slider` l'étaient déjà, dans la règle elle-même plutôt qu'avec
  un `!important` concurrent. Un 3e piège de la même famille évité en le sachant à l'avance :
  `.app--widget` met TOUTE la fenêtre en `-webkit-app-region: drag` (pour attraper le widget), ce qui rend
  un champ de saisie posé dedans impossible à remplir — d'où `no-drag` explicite sur la barre, vérifié par un
  vrai clic Playwright puis par la mesure du style calculé.
  **Hauteur de la fenêtre MESURÉE sur le contenu réel, pas fixe.** Première version : une hauteur dépliée
  fixe (400px), comme le widget vocal. Défaut vu sur la capture : une réponse courte laissait ~230px de
  fenêtre transparente qui, elle, avale quand même les clics en haut de l'écran — supportable pour le widget
  vocal (il se replie tout seul après quelques secondes), pas pour celui-ci qui reste ouvert tant qu'on ne
  l'a pas fermé. Le renderer renvoie donc sa hauteur (`setChatWidgetHeight`), bornée côté main.
  **Fausse piste dans ce correctif, écartée par la mesure** : `document.documentElement.scrollHeight`
  semblait le plus simple pour "la hauteur totale du contenu" — il renvoie en réalité le MAXIMUM entre le
  contenu et la fenêtre, donc la hauteur actuelle de la fenêtre dès que le contenu est plus court (mesuré :
  400 renvoyé pour 169 de contenu réel, soit exactement la valeur qu'on cherchait à corriger). Remplacé par
  le `bottom` du nœud + le padding du bas. **Leçon générale : `scrollHeight` n'est jamais la hauteur du
  contenu seul — il ne descend jamais en dessous de la taille de l'élément/fenêtre.**
  **Désynchronisation anticipée plutôt que découverte** : une question posée depuis le widget part par le
  MÊME `sendChatMessage` que le mode Chat, donc dans la même conversation — mais la fenêtre de réglages
  n'est jamais détruite (juste cachée), donc son fil serait resté figé sur ce qu'il affichait avant le repli
  et l'échange fait depuis le widget n'y serait jamais apparu. `ChatPanel` relit donc son fil sur
  `visibilitychange`. Même famille que les deux historiques court terme voix/chat désynchronisés (étape 47).
  `renderFormattedText` sorti de ChatPanel.tsx vers `src/lib/formatReply.tsx` plutôt que recopié : les deux
  écrans rendent la même donnée.
  Régression : `node --test scripts/test-widget-mode.mjs scripts/test-chat-widget-ui.mjs
  scripts/test-widget-transition.mjs` (325 tests au total). Structurel côté main (aucun widget en mode Code,
  écoute reprise seulement en voix, émotion vocale qui ne touche jamais au widget texte, forme dérivée d'une
  seule source) ; dans un VRAI navigateur côté widget (barre présente et jamais le cercle, frappe possible
  malgré la zone de déplacement, pas de double cadre, réponse affichée avec son gras, hauteur mesurée
  inférieure à la fenêtre, rien de coupé à la hauteur demandée, boutons réellement habillés par le CSS
  compilé) ; et dimensions natives de la barre dans le faux pont de `test-widget-transition.mjs` — qui
  plantait d'ailleurs sur `currentWidgetMode is not defined` tant que ses globaux injectés n'ont pas été mis
  à jour, **le même réflexe que pour les faux ponts preload : après avoir ajouté une dépendance à un module
  déjà chargé par des tests, mettre à jour leurs bouchons avant de lancer la suite.** Chaque assertion
  vérifiée mordante en réintroduisant son défaut (y compris une injection de défaut qui n'avait rien changé
  du tout au premier essai — un défaut qu'on croit injecté sans l'avoir vérifié ne prouve rien).
  **Non vérifiable ici, à confirmer par Léo en usage réel** : qu'une fenêtre Electron `alwaysOnTop` +
  `skipTaskbar` prenne bien le focus clavier au clic sur Windows (il n'y a ni Windows ni vraie fenêtre
  Electron dans cet environnement) — tout le reste est prouvé par les mesures ci-dessus, pas ça.

- **"Inactif" ne veut pas dire "invisible" pour le widget permanent.** Correction v0.15.2 de la mauvaise
  interprétation v0.15.1 : après l'onboarding, la grande fenêtre reste cachée mais le widget est affiché dès
  `ready-to-show`. En Vocal, `idle` le replie vers le petit orbe sans `hide()` ; en Chat, le repli affiche un
  petit indicateur distinct (`chat-idle`) et + le remplace par la barre (`chat`). Le mode Code reste la seule
  absence de widget. Garder la forme dessinée, la taille native et la région `setShape` dérivées du même état.
- **Un test qui remplace une jonction Windows par un vrai lien doit rester exécutable sur Windows.** Un
  `symlinkSync()` sans type fonctionne dans le runner Linux, mais demande un privilège spécial sur Windows et
  faisait échouer `npm test` avec `EPERM` sans défaut du code testé. Utiliser le type `junction` sur Windows,
  qui reproduit justement `mklink /J` et ne demande pas ce privilège, puis garder le symlink classique ailleurs.
- **Une ombre CSS dans une fenêtre Electron transparente est coupée par les limites NATIVES.** Une pilule
  avec `box-shadow: 0 0 12px` placée à 4px du bord ne peut jamais montrer un fondu complet, même si son CSS
  est correct : réserver au moins 14px transparents dans les bounds et dans `setShape`. Pour le Chat ouvert
  par +, `onMouseLeave` doit prévenir le main par IPC afin que contenu, bounds et région cliquable reviennent
  ensemble à `chat-idle` ; changer seulement le JSX laisserait une grande fenêtre invisible au-dessus du bureau.
- **`mouseleave` peut être perdu au bord d'une `BrowserWindow` transparente.** Constaté en usage réel : le
  Chat se repliait la plupart du temps, mais restait parfois ouvert quand le pointeur quittait vite la fenêtre.
  Garder l'évènement renderer pour le chemin immédiat et le compléter par un relevé natif temporaire de
  `screen.getCursorScreenPoint()`. Armer ce filet seulement après une vraie entrée dans la surface visible :
  sinon une barre ouverte au clavier alors que la souris se trouve ailleurs se refermerait instantanément.
  Comparer à la surface dessinée, sans compter la marge transparente réservée au halo, et arrêter le minuteur
  dès le repli ou le masquage afin qu'il ne tourne jamais pendant l'état inactif.
- **Le repli automatique d'une saisie flottante doit distinguer une barre vide d'un brouillon.** Une sortie
  de souris ou un `blur` natif peut replier immédiatement une barre vide, mais dès le premier caractère
  (même un espace) le renderer doit signaler cet état au main pour bloquer TOUS les chemins de repli. Sinon
  cliquer ailleurs détruit visuellement une saisie en cours. Pour une fenêtre Electron, écouter aussi `blur`
  fournit la réaction immédiate au clic extérieur que le seul suivi périodique du pointeur ne garantit pas.
  La protection ne doit PAS être calculée sur le champ seul : l'envoi vide normalement ce champ avant que la
  réponse arrive. Elle doit rester vraie tant qu'une question/réponse est affichée, sinon le widget disparaît
  pendant la réflexion et l'utilisateur entend ou devine une réponse qu'il ne peut plus lire.
- **Une règle globale `:focus-visible` peut redessiner un rectangle dans une pilule.** Le champ Chat reçoit
  le focus automatiquement après + ; la règle générale des champs lui ajoutait alors `box-shadow` et bordure
  par-dessus le contour arrondi de la pilule. Ajouter une exception après la règle globale, avec `box-shadow:
  none` et bordure transparente, puis mesurer le style calculé sur un vrai focus : compter les déclarations
  CSS ne prouve pas quel sélecteur gagne réellement.

- **Étape 124, Léo : "Qui a créé ChatGPT ?" a reçu comme réponse un texte confus décrivant une décision de
  ne pas appeler d'outil, au lieu de la vraie réponse.** Diagnostiqué en lisant le code, pas deviné, et
  vérifié avec le vrai regex avant de corriger. Deux bugs empilés dans la boucle de `converse()`
  (assistant.ts) :
  1. **Faux positif de `PROMISE_WITHOUT_ACTION`.** Le modèle avait très probablement déjà donné la bonne
     réponse, juste précédée d'un préambule poli ("Je vais vous répondre : ChatGPT a été créé par OpenAI.").
     Le regex ne regardait jamais ce qui suit "je vais [verbe]" dans la MÊME phrase — testé avant de
     corriger : `PROMISE_WITHOUT_ACTION.test("Je vais vous répondre : ChatGPT a été créé par OpenAI.")` →
     `true`, alors que la réponse était déjà complète et correcte.
  2. **La relance corrective aggrave au lieu de réparer.** Ce faux positif déclenche une relance ("tu as
     décrit une action sans l'exécuter, corrige ta réponse") — sur une réponse pourtant déjà bonne, le petit
     modèle local ne sait pas quoi "corriger" et a fini par PARAPHRASER la consigne de correction elle-même
     comme si c'était sa réponse. Comme cette relance n'a droit qu'à un seul essai (`nudgedForNoAction`),
     aucune vérification ne rattrape ce texte confus : il part tel quel à l'écran.
  **Le vrai problème est le n°1**, et il ne peut pas se corriger avec un simple ajustement du motif
  grammatical (contrairement aux 3 généralisations précédentes de ce même détecteur, toutes purement
  grammaticales) : "je vais envoyer le mail" (une vraie promesse sèche) et "je vais vous répondre : ChatGPT
  a été créé par OpenAI" (un préambule suivi d'une vraie réponse) ont EXACTEMENT la même forme grammaticale
  — seule la SUBSTANCE de ce qui suit le verbe les distingue (rien ou presque pour une promesse sèche,
  plusieurs mots de contenu pour une vraie réponse). `PROMISE_WITHOUT_ACTION` devient donc une FONCTION
  plutôt qu'un simple regex exporté : elle itère sur tous les matches possibles du motif (regex global) et
  ne considère que c'est une promesse sèche si, pour CHAQUE match, ce qui suit compte moins de 5 mots de
  contenu — sinon (au moins un match suivi d'une vraie réponse substantielle), ce n'est plus une promesse
  sans suite. Seul appelant du module (`converse()`) mis à jour (`PROMISE_WITHOUT_ACTION(message.content)`
  au lieu de `.test(...)`).
  **Deuxième filet, prompt-level** : la consigne de relance corrective précise maintenant explicitement, pour
  le cas où aucune action n'est nécessaire, de répondre "directement et uniquement à la question d'origine
  ... sans mentionner cette consigne, les outils, ni le fait que tu corriges quoi que ce soit" — pour réduire
  le risque qu'un modèle confus paraphrase encore la consigne au lieu de simplement répondre, même si un
  futur cas échappe au correctif n°1. **Non vérifié en usage réel** (pas d'accès à Ollama ni au petit modèle
  local dans cet environnement) : seul le comportement du détecteur est prouvé par test, l'efficacité de ce
  second filet reste à confirmer par Léo.
  **Limite assumée, pas résolue** : une réponse très COURTE après un préambule ("Je vais répondre : Paris.")
  reste indiscernable d'une promesse sèche par ce seul critère de longueur (3 mots de contenu < 5) — seul le
  cas réellement rapporté (une réponse avec plusieurs mots de contenu, le cas réaliste pour "qui a créé X ?")
  est couvert, faute de pouvoir observer la vraie sortie du petit modèle local pour affiner plus précisément.
  Régression : `node --test scripts/test-promise-detection.mjs` (27 tests, dont 3 nouveaux cas de préambule
  suivi d'une vraie réponse — jamais une promesse — et 1 cas qui reste bien une promesse sèche même précédé
  d'un tour de phrase poli). Chaque nouvelle assertion vérifiée mordante : revenue temporairement à l'ancien
  comportement (`.test()` sur le regex simple), les 3 nouveaux cas de faux positif échouent bien, les 24
  autres (déjà établis) continuent de passer.

- **Étape 125, Léo (juste après la 124) : "fait en sorte qu'il regarde tout le temps sur le web".** Question
  posée avant de coder (le sujet du "tout le temps" était ambigu — commandes comprises ?) : réponse "Toute
  les information, il ne doit pas rechercher dans sa base de données car les modèles sont trop vieux" — donc
  toute question de CONNAISSANCE, pas les commandes d'action ni la discussion.
  **Ce qui existait déjà** : le prompt système forçait déjà `search_web` avant de répondre, mais UNIQUEMENT
  pour "des commerces, lieux, personnes ou entités réels" — une catégorie bien plus étroite que "qui a créé
  ChatGPT" (une question de culture générale, pas une entité locale à chercher). Élargi à TOUTE question
  factuelle ou de connaissance, avec une exception explicite pour ce qui n'en a pas besoin (Jaris lui-même,
  une info déjà dans la conversation/la mémoire locale, la date/l'heure déjà données plus haut dans le
  prompt) — sans cette dernière exception, "quelle heure est-il ?" aurait aussi déclenché une recherche.
  **Même leçon que l'étape 124 : une consigne seule ne suffit pas à un petit modèle local.** Exactement comme
  `wantsEmailSent` force déjà une relance vers `computer_use_task` quand un mail est demandé sans jamais être
  envoyé, `looksLikeKnowledgeQuestion` (assistant.ts) détecte qu'une question RESSEMBLE à une demande
  d'info (mot interrogatif en tête, "?" final, ou impératif du type "trouve-moi"/"cherche-moi" — repris
  directement de l'exemple déjà présent dans le prompt système, "trouve trois boulangeries") et force une
  relance corrective d'un tour vers `search_web` si le modèle répond sans l'avoir appelé. Même mécanique que
  `wantsEmailSent`/`PROMISE_WITHOUT_ACTION` : un seul essai de relance, suivi mécaniquement (`searchCalledThisTurn`,
  posé à `true` dès qu'un appel à `search_web` a vraiment lieu ce tour-ci).
  **Piège attrapé par le test avant de livrer** : la première version de `looksLikeKnowledgeQuestion` ne
  détectait que les vraies QUESTIONS (mot interrogatif ou "?") — "Trouve-moi une boulangerie ouverte près de
  chez moi" (une demande à l'impératif, sans "?") passait au travers. Repéré en testant le cas EXACT déjà
  cité comme exemple dans le prompt système lui-même : si l'exemple du prompt ne matche pas le détecteur
  censé forcer ce même comportement, quelque chose cloche. Corrigé en ajoutant l'alternance des impératifs
  d'info ("trouve(-moi)", "cherche(-moi)", "recherche", "dis-moi", "donne-moi").
  **Limite assumée, pas résolue, comme pour PROMISE_WITHOUT_ACTION (étape 124)** : ce détecteur reste un
  filet MÉCANIQUE de dernier recours, pas une vraie compréhension du langage — une question de connaissance
  formulée sans mot interrogatif ni "?" ni impératif reconnu (rare en pratique) resterait non détectée ; la
  vraie ligne de défense reste la consigne système élargie, ce filet ne fait que rattraper les cas où elle
  ne suffit pas.
  Régression : `node --test scripts/test-knowledge-question.mjs` (21 tests, dont le cas réel rapporté par
  Léo et l'exemple "boulangerie" du prompt système lui-même) — chaque assertion vérifiée mordante en
  désactivant temporairement le détecteur (`return false`) : les 11 cas positifs échouent bien, les 10 cas
  négatifs restent corrects. **Non vérifié en usage réel** (pas d'accès à Ollama/au petit modèle local dans
  cet environnement) : le mécanisme est prouvé par test, son efficacité réelle chez Léo reste à confirmer —
  notamment si `search_web` échoue ou renvoie un résultat non concluant, où le modèle pourrait encore
  répondre à côté malgré la relance.

- **Étape 126, Léo : "et aussi quand on envoie un message dans le widget chat, ça réponse doit disparaitre
  apres sa doit varier selon la longueur de la réponse".** Jusqu'ici, une fois une réponse affichée dans le
  widget Chat (ChatWidget.tsx), elle restait ouverte indéfiniment tant que Léo ne cliquait pas sur "Fermer"
  (ou n'appuyait pas sur Échap) — `setChatWidgetKeepOpen(input.length > 0 || expanded)` bloque en effet tout
  repli automatique par survol tant qu'une réponse est affichée (`expanded` ne redevient `false` qu'via
  `dismiss()`), un mécanisme déjà en place pour une tout autre raison (ne pas perdre une réponse qu'on est en
  train de lire simplement parce que la souris a glissé hors du widget).
  **`computeReplyDismissDelayMs`** (ChatWidget.tsx, fonction pure exportée pour être testable sans attendre
  le vrai délai) calcule un délai calé sur une vitesse de lecture moyenne (~200 mots/min, donc 300ms/mot),
  borné aux deux extrémités : plancher de 4s (une réponse d'un seul mot garde quand même quelques secondes à
  l'écran) et plafond de 25s (une réponse très longue ne bloque pas le widget ouvert indéfiniment — elle
  reste de toute façon consultable dans le vrai Chat via "Ouvrir le Chat"). Un nouvel état `hovering` (posé
  par les handlers `onMouseEnter`/`onMouseLeave` déjà existants du widget) suspend ce délai tant que la
  souris survole le widget ou qu'un brouillon est en cours de saisie — même logique que
  `setChatWidgetKeepOpen` : le but même de ce délai est de laisser le temps de lire, le couper pendant que
  Léo est justement en train de lire ou de composer une suite serait contre-productif. Ne se déclenche QUE
  sur une réponse reçue avec succès (`!sending`, `!error`) : un message d'erreur reste affiché jusqu'à une
  action explicite, rien à "laisser le temps de lire" dans un texte d'échec qui appelle une action de Léo.
  **Piège de test, le plus coûteux de cette étape — deux fausses pistes avant la vraie cause.** Le délai réel
  (4 à 25s) est trop lent à attendre littéralement dans un test.
  1. Première tentative : l'horloge simulée de Playwright (`page.clock.install`/`runFor`). A fini par geler
     tout le fichier de tests jusqu'à un SIGKILL externe après ~85s, malgré `{ polling: 100 }` explicite sur
     les `waitForFunction` (le polling par défaut, `'raf'`, reste gelé sous une horloge virtuelle). Abandonné
     après plusieurs cycles de débogage infructueux (un script de diagnostic isolé avec journalisation
     synchrone n'a jamais réussi à capturer où exactement ça bloquait, et `pkill` par motif de nom a
     lui-même échoué à tuer le process node/chromium bloqué — `ps aux` + `kill -9` sur les PID exacts a été
     nécessaire pour nettoyer avant de changer d'approche).
  2. Deuxième tentative, en remplacement : de VRAIES attentes bornées (`page.waitForTimeout`), en s'appuyant
     sur le fait que la réponse simulée du test (8 mots) plafonne exactement au plancher (4000ms) — donc une
     attente réelle de quelques secondes reste raisonnable. Toujours un blocage identique (le fichier entier
     gelait à nouveau jusqu'à SIGKILL), qui a fait CROIRE un instant que `page.clock` n'était pas le vrai
     coupable. Diagnostiqué correctement cette fois en isolant méthodiquement : un script autonome (hors
     `node --test`) reproduisant EXACTEMENT la même séquence Playwright s'est exécuté sans blocage en ~5
     secondes — la même séquence, réintégrée dans un `test()` de `node:test`, bloquait quand même. Le
     dénominateur commun, trouvé par une dernière isolation ciblée : `assert.equal(handle, null, message)`
     où `handle` est un VRAI `ElementHandle` Playwright (retourné par `page.$(...)`) **ne rend jamais la main
     si l'assertion échoue** — `node:assert` tente de formater l'objet dans le message d'erreur, et un
     `ElementHandle` référence toute la connexion CDP sous-jacente (objets circulaires, promesses en
     attente), dont la sérialisation par `util.inspect()` ne se termine jamais. Confirmé par un test minimal
     dédié (`assert.equal(handle, null)` sur un `ElementHandle` bien réel et non-null : aucune erreur levée,
     aucune sortie, même après 20s). **La vraie cause de l'échec de l'assertion, une fois ce piège de test
     lui-même écarté** : une assertion que j'avais moi-même mal écrite — `.chat-widget__input` (la barre de
     saisie) n'est JAMAIS retirée du DOM par `dismiss()` (qui ne fait que replier la RÉPONSE, `expanded =
     false`) ; seule la pilule minuscule pilotée par le prop `inactive` (lui-même piloté par main.ts quand la
     souris quitte VRAIMENT le widget) fait disparaître la barre. Cette assertion était donc fausse à la fois
     dans son attente ET dans sa façon de comparer un ElementHandle — corrigée sur les deux plans : l'attente
     inversée (la barre doit RESTER visible, prête pour la question suivante) et la comparaison passée par un
     booléen explicite (`(await page.$(sélecteur)) === null`) plutôt que le handle brut.
  **Leçon générale, la plus utile de cette étape : ne jamais passer un ElementHandle/JSHandle Playwright
  directement à `assert.equal`/`assert.deepEqual` — toujours comparer un booléen ou une valeur primitive
  dérivée (`=== null`, `.textContent`, etc.).** Si l'assertion réussit, rien ne se voit ; si elle échoue,
  `node:assert` tente de sérialiser l'objet entier pour le message d'erreur et le processus reste bloqué
  sans la moindre erreur ni sortie — un piège d'autant plus vicieux qu'un test AVEC cette même forme
  (`assert.equal(await page.$(...), null, ...)`) peut très bien passer pendant des mois si l'assertion
  n'échoue jamais en pratique, puis geler silencieusement le jour où elle échoue enfin pour une vraie raison —
  ce qui explique aussi pourquoi ce piège n'avait jamais été repéré dans les 15 tests déjà existants de ce
  même fichier (leur comparaison à `null` a toujours réussi jusqu'ici).
  Régression : `node --test scripts/test-chat-widget-ui.mjs` (18 tests, dont les 2 nouveaux — "la réponse
  disparaît toute seule après le délai calculé, sans survol" et "survoler le widget suspend la disparition
  automatique" — vérifiés mordants en désactivant temporairement l'effet de disparition : le premier échoue
  bien, proprement et rapidement (~4,6s, pas de blocage), sans faire échouer les 17 autres). **Non vérifié en
  usage réel** (pas d'accès à une vraie fenêtre Electron dans cet environnement) : le mécanisme est prouvé
  par un vrai navigateur avec le vrai CSS compilé, son ressenti exact (le bon moment pour disparaître, ni
  trop tôt ni trop tard) reste à confirmer par Léo — même réserve que pour tout jugement de "qualité perçue"
  déjà documenté dans ce fichier (Kokoro, le rendu de l'orbe).

- **Un filet mécanique qui classe toute phrase terminée par `?` comme question factuelle doit exclure les
  échanges sociaux adressés à l'assistant.** Constaté avec « tu vas bien ? » : la relance corrective vers
  `search_web` transformait une salutation en recherche en ligne absurde. Garder une exclusion ancrée sur la
  phrase entière (`SOCIAL_CHECK_IN`) pour ne pas masquer une vraie question telle que « Pourquoi ça va mal
  dans l'économie ? ». Régression : `scripts/test-knowledge-question.mjs`.

## Idées à explorer (pas encore commencées)

Backlog de pistes discutées avec Léo après des recherches sur les avancées 2026 pertinentes pour Jaris —
aucune des cinq n'est codée, à reprendre seulement si Léo donne le feu vert à l'une d'elles. Classées par
ordre d'ampleur du chantier (la plus lourde en premier), pas par priorité.

1. **Voix full-duplex (interruption en temps réel).** Pouvoir parler PAR-DESSUS Jaris pour l'interrompre en
   pleine réponse (façon GPT-Live d'OpenAI, lancé en juillet 2026, "barge-in") au lieu du cycle actuel
   strictement séquentiel (écoute -> transcription -> réponse -> synthèse, un tour après l'autre,
   voir `voicePipeline.ts`). **Ne change PAS la voix elle-même** (Supertonic resterait identique) —
   uniquement le minutage : il faudrait une détection vocale (VAD) qui tourne en continu MÊME pendant que
   Jaris parle, capable de couper la synthèse en cours dès qu'une vraie voix reprend. Chantier lourd : toute
   la boucle vocale actuelle suppose un tour à la fois, du début à la fin, sans jamais s'interrompre.
2. **Migrer Electron → Tauri.** Gains mesurés ailleurs sur des applis comparables : ~80 Mo de RAM et ~0,8s
   de démarrage contre 600 Mo/2,5s pour un Electron équivalent, binaire ~30 Mo au lieu de 150-200 Mo. Le prix :
   réécrire tout le process main (aujourd'hui Node/TypeScript dans `electron/main.ts`) en Rust — fenêtres,
   IPC, sidecars Python, raccourcis globaux, tout serait à refaire. Chantier de plusieurs mois, pas une étape.
3. **Jaris en hub MCP (Model Context Protocol).** Transformer `tools.ts` en client MCP pour consommer les
   plus de 200 serveurs communautaires déjà publiés (GitHub, Docker, Slack...) sans coder chaque outil à la
   main. Changement d'architecture des outils, mais éviterait de tout réinventer à chaque nouvelle idée
   d'intégration future.
4. **Mode Code : exécution sandboxée type WebContainer.** Techno derrière StackBlitz/Bolt/Claude Artifacts en
   2026 (Node.js + npm compilés en WebAssembly, tourne DANS le navigateur, démarrage <1s, zéro serveur).
   Permettrait de sortir du principe actuel "un seul fichier HTML autonome" (`codeGenerator.ts`) pour générer
   de vraies applications multi-fichiers avec de vraies dépendances npm, tout en restant 100% local. L'iframe
   isolée déjà en place pour l'aperçu (`jaris-preview:`, CSP dédiée, voir `generatedAppPreview.ts`) est un bon
   point de départ, mais ça veut dire refaire tout le pipeline génération + aperçu. Chantier lourd.
5. **Mode Code : boucle de réparation qui EXÉCUTE vraiment le code généré, pas seulement une relecture
   textuelle.** `validateGeneratedHtml` (codeGenerator.ts) analyse aujourd'hui le HTML comme du TEXTE (motifs
   cherchés à l'aveugle : balises non appariées, JS hors `<script>`...), jamais en le faisant tourner pour de
   vrai. Faire tourner le code généré dans un vrai navigateur headless (même technique que les tests
   Playwright déjà utilisés dans ce dépôt) pour capturer les VRAIES erreurs JS/console avant de les redonner
   au modèle à corriger serait plus fiable qu'un motif de texte. Changement ciblé sur `codeGenerator.ts`, pas
   une refonte — prolonge la passe de relecture/réparation déjà en place plutôt que de la remplacer.

- **Étape 127, Léo (capture d'écran à l'appui) : "regarde les palier tout le monde a les meme model pour les
  palier... pour le palier 4 par exemple" — plusieurs paliers consécutifs du tableau "Ce que ta machine fait
  tourner" affichaient EXACTEMENT les 5 mêmes modèles (Rapide/Médium/Puissant/Vision/Code), et le tout premier
  s'intitulait "(moins de 0 Go)", une étiquette absurde (aucune machine n'a moins de 0 Go).**
  Diagnostiqué en relisant `previewVramSteps`/`previewHardwareTiers` (hardwareScan.ts), pas deviné. Chaque
  VALEUR de `previewVramSteps` est bien une frontière VRAIE où au moins un candidat devient/cesse d'être
  atteignable — mais ça ne garantit PAS que ce changement soit VISIBLE dans les 5 colonnes affichées :
  1. **Le repli "aucun candidat ne rentre encore" (`pickForBudget` dans `computeModelPicks`) peut déjà
     afficher le même modèle qu'une fois son propre seuil réellement atteint.** Exemple concret : sur une
     machine sans assez de VRAM pour AUCUN candidat Médium, Jaris retombe sur le plus petit (`qwen3.5:0.8b`,
     dernier de `MEDIUM_CANDIDATES`) — bien AVANT que ce modèle "rentre" vraiment (son propre seuil réel,
     1,0+4,5=5,5 Go de VRAM totale). Résultat : la ligne à 0 Go et la ligne à 5,5 Go affichent le MÊME nom de
     modèle Médium, pour deux raisons complètement différentes (repli vs vrai calcul), sans que rien ne le
     distingue à l'écran.
  2. **Le tout premier palier peut légitimement valoir 0 Go.** Un candidat "Puissant" qui tolère de déborder
     sur la RAM (`LARGE_RAM_OFFLOAD_MODELS`) peut ne plus avoir besoin d'AUCUNE VRAM sur une machine avec
     assez de RAM (`totalVramNeededFor` plafonne à 0 via `Math.max(0, ...)`) — mais "moins de 0 Go" n'a alors
     aucun sens : il n'existe aucune machine avec MOINS que ça.
  **Corrigé sur les deux plans.** `previewHardwareTiers` fusionne maintenant les paliers CONSÉCUTIFS dont les
  5 modèles choisis sont RIGOUREUSEMENT identiques (`sameCombo`) : une seule ligne par combinaison vraiment
  distincte, gardant la frontière du PREMIER palier du groupe (celle où ce résultat apparaît réellement) et
  le statut "actuel" si N'IMPORTE LEQUEL des paliers fusionnés l'était. `formatVramRange`
  (HardwareTierPreview.tsx) affiche "(0 Go)" au lieu de "(moins de 0 Go)" quand la toute première frontière
  vaut exactement 0.
  **Pourquoi ne pas avoir touché `previewVramSteps` lui-même** : ses frontières restent mathématiquement
  correctes et nécessaires (elles servent aussi à `pickBestFrom`/`computeModelPicks` pour garantir que deux
  machines dans le même intervalle reçoivent le même modèle, étape 114/117) — le problème n'était que dans
  l'AFFICHAGE d'une ligne par frontière sans vérifier que le résultat affiché change vraiment.
  Régression : `node --test scripts/test-hardwarescan-preview-steps.mjs` — nouveau cas qui reproduit EXACTEMENT
  le bug de Léo (deux frontières réelles et distinctes, 0 et 5,5 Go, mais un résultat rigoureusement identique
  sur les 5 modèles) et vérifie qu'un seul palier reste affiché. Vérifié mordant : dédup temporairement
  désactivée, le test échoue bien (2 paliers reçus au lieu d'1), sans toucher aux 4 autres tests déjà
  existants de ce fichier (toujours au vert). `formatVramRange` exportée pour être testable directement (pas
  de test dédié écrit pour son cas "(0 Go)" — fonction .tsx avec JSX, testable seulement via un navigateur
  complet type Playwright pour un gain jugé trop faible ici vu la trivialité du correctif ; sa branche
  d'entrée, elle, EST prouvée réelle par le test ci-dessus qui produit bien un palier à `vramGb: 0`).
  **Non vérifié en usage réel** (pas d'accès à une vraie fenêtre Electron/à la machine de Léo dans cet
  environnement) : le mécanisme est prouvé par test avec des données simulées, son rendu exact sur SA machine
  reste à confirmer.
  **Note en marge, sans rapport avec ce correctif** : en creusant cette session, une branche orpheline
  (`claude/admiring-ride-ow6t1v`) a été repérée — un seul commit isolé (refonte Options/gpuName/RAM,
  v0.14.6) jamais fusionné dans cette branche, divergée juste après v0.14.5 et abandonnée depuis. Le vrai
  code de Léo (confirmé par sa capture d'écran, qui correspond au rendu SANS vue compacte) est bien celui de
  cette branche-ci (`claude/jaris-local-ai-assistant-a2drk4`) — l'autre ne contient rien d'utilisé en
  pratique, mais reste à supprimer ou réconcilier un jour si Léo le souhaite.
- **Étape 128, Léo : "cherche meilleur model et dit lui bien tout les palier" puis "oui" — 6 nouveaux
  candidats ajoutés aux listes de Jaris, après une recherche externe VÉRIFIÉE point par point avant d'y
  toucher, pas prise à sa parole.** Une IA externe (prompt de recherche fourni par ce fichier, incluant
  cette fois l'explication du mécanisme des paliers avec un exemple réel tiré de la machine de Léo) a proposé
  ministral-3:3b/8b/14b, gemma4:31b, qwen3-coder-next et devstral-2:123b, avec des bugs Ollama précis pour
  justifier l'exclusion d'autres modèles (qwen3.8:27b, gpt-oss:20b, toute la famille Gemma 4) des rôles à
  outils. **Chaque affirmation vérifiée indépendamment avant d'agir** : les 6 tags Ollama existent bien
  (`ollama.com/library/<tag>`, tailles confirmées par WebFetch direct des pages officielles) et les 4 bugs
  GitHub cités (#13750 response_format+tools, #17638 gpt-oss HTTP 500, #17825 qwen3.8:27b retry-hang,
  #18390/#17888/#15539 parsing Gemma 4) sont tous réels, récents (2026), et correspondent précisément aux
  descriptions données — rien d'halluciné, contrairement à d'autres propositions externes déjà rejetées dans
  ce fichier (llama3.2:1b présenté à tort comme récent, "Hermes 4 14B" introuvable en officiel...).
  **Une clarification propre à Jaris que l'IA externe ne pouvait pas connaître** : la réserve "Ministral perd
  ses outils si `response_format`/`format` est envoyé EN MÊME TEMPS que `tools`" ne s'applique PAS à Jaris —
  vérifié directement dans `ollama.ts` (`grep -n "format:"`) : Jaris n'envoie JAMAIS ce paramètre en même
  temps que des outils, sur aucun appel. Ministral 3 est donc un candidat sûr sans réserve pour Jaris, pas
  juste "sous condition" comme l'IA externe le présentait par prudence générique.
  **Découverte en ajoutant `ministral-3:3b` : il était déjà présent dans `scripts/benchmark-models.mjs`
  (MODELS/MODEL_SIZE_HINTS) sans jamais avoir été promu dans `hardwareScan.ts`** — et surtout déjà VÉRIFIÉ
  pour de vrai : `scripts/verified-tool-scores.md` contient déjà `| ministral-3:3b | 6/6 |`, mesuré sur la
  machine de Léo. Pas une simple entrée "informative en attente de test" comme les 5 autres ajouts de cette
  étape : celui-ci est déjà confirmé fiable en usage réel, pas seulement sur le papier.
  **Répartition finale, par catégorie** (voir hardwareScan.ts pour le détail complet de chaque ajout) :
  - Rapide : `ministral-3:3b` (3,0 Go, 6/6 déjà mesuré).
  - Médium : `ministral-3:14b` (9,1 Go), `ministral-3:8b` (6,0 Go) — pas encore testés pour de vrai.
  - Vision : `gemma4:31b` (20 Go, PAS ajouté en Médium/Puissant/Code à cause des bugs de parsing Gemma 4
    ouverts, mais Vision n'a pas cette exigence), `ministral-3:8b` (réutilisation, comme gemma4:e4b/qwen3.5:4b
    déjà présents des deux côtés).
  - Code : `devstral-2:123b` (75 Go) et `qwen3-coder-next` (52 Go), tous deux ajoutés à
    `LARGE_RAM_OFFLOAD_MODELS` (indispensable ici : aucun GPU grand public n'a assez de VRAM à lui seul pour
    les atteindre, seule la RAM système les rend joignables du tout).
  - Puissant : aucun ajout — aucun candidat n'a passé le filtre de fiabilité d'appel d'outils, conclusion de
    l'IA externe confirmée par la vérification des bugs GitHub.
  **`scripts/benchmark-models.mjs` mis à jour en miroir** (MODELS/MODEL_SIZE_HINTS/VISION_CANDIDATES/
  CODE_CANDIDATES/RAM_OFFLOAD_MODELS/FLASH_TIER_MODELS/MEDIUM_TIER_MODELS) pour que "Lancer l'analyse" puisse
  un jour mesurer pour de vrai les 5 candidats encore non testés — sans ce miroir, ils resteraient
  dormants indéfiniment dans `hardwareScan.ts`, jamais réellement sélectionnables.
  **Limite assumée, pas résolue** : aucun score MMLU-Pro ajouté à `INTELLIGENCE_MMLU_PRO` pour ces nouveaux
  modèles — les chiffres rapportés par l'IA externe (MMLU 70,7/76,1/79,4 pour ministral 3b/8b/14b) n'ont pas
  été retracés jusqu'à une fiche officielle Mistral avant d'écrire cette entrée, contrairement aux tags/
  tailles/bugs qui, eux, ont chacun été revérifiés à la source. Ne pas les ajouter au départage plutôt que de
  recopier un chiffre non confirmé.
  **CanIRun.ai (github.com/midudev/canirun.ai)**, proposé par Léo entre-temps comme outil de recoupement :
  vérifié comme un vrai outil (104 modèles, détection matérielle + API publique gratuite), utilisé pour
  recouper cette recherche — confirme gemma4:31b/qwen3-coder-next/devstral-small-2-24b, mais ne liste PAS
  encore ministral-3:8b ni devstral-2:123b dans son propre catalogue (trop récents pour leur curation, sans
  rapport avec leur existence réelle déjà vérifiée directement sur Ollama). Gardé comme source de recoupement
  ponctuelle pour de futures recherches, pas intégré à Jaris (resterait un appel réseau, contraire au principe
  "100% local").
  Régression : `npm run typecheck`, `npm run build`, `npm test` (378 tests, aucun nouveau test dédié — une
  addition de candidat n'introduit aucune logique nouvelle, déjà entièrement couverte par les tests existants
  de `pickBestFrom`/`computeModelPicks`). **Non vérifié en usage réel pour 5 des 6 ajouts** (pas d'accès à la
  machine de Léo) : seul `ministral-3:3b` a une preuve de fiabilité réelle (6/6 déjà mesuré) ; les 5 autres
  restent des candidats informatifs, à confirmer via "Lancer l'analyse" avant de leur faire pleinement
  confiance.
- **Étape 129, Léo : "dans model ajoute un bouton en dessou de tout les palier, tout les model et met tout
  les model qu'on a utiliser met le score apelle outil la vram necessaire pour le model, et le score sur
  canirun.ai".** Nouveau bouton "Tous les modèles" (Options → Modèles, sous les paliers de configuration),
  qui déplie une liste COMPLÈTE de tous les modèles candidats de Jaris — tous paliers confondus (Rapide/
  Médium/Puissant/Vision/Code), pas seulement celui réellement choisi pour la machine de l'utilisateur (déjà
  visible juste au-dessus). Chaque ligne : modèle, VRAM nécessaire, score d'appel d'outils (déjà connu de
  Jaris), score CanIRun.ai (nouveau).
  **Réutilise entièrement `getModelOverview` (hardwareScan.ts), déjà existant mais jusqu'ici consommé
  UNIQUEMENT par `ModelAnalysisProgress.tsx` pendant un run de "Lancer l'analyse" en cours** — la fonction
  produisait déjà exactement les groupes/colonnes demandés (vitesse, fiabilité, intelligence MMLU-Pro), il
  ne manquait qu'un endroit pour l'afficher en PERMANENCE plutôt que seulement pendant un run actif, et le
  score CanIRun.ai en plus. Nouveau composant `AllModelsOverview.tsx` (repose sur le même canal IPC déjà
  exposé, aucun nouveau canal créé), branché dans `OptionsMenu.tsx` juste après `<HardwareTierPreview>`.
  **Score CanIRun.ai : vérifié via leur VRAIE API avant d'écrire le moindre chiffre, pas deviné.** Requêté
  `canirun.ai/api/models/<id>` pour les 104 modèles de leur catalogue (le 20/09/2026) afin de retrouver les
  38 modèles candidats de Jaris par leur `ollamaId`. Résultat honnête : seuls 8/38 ont ce score chez eux
  (`CANIRUN_INTELLIGENCE_INDEX`, hardwareScan.ts) — leur catalogue reste incomplet sur ce champ précis pour
  la plupart des modèles récents. Les 30 autres affichent "—", jamais un chiffre inventé pour combler le
  vide (même discipline que `INTELLIGENCE_MMLU_PRO`/`toolCalling`, déjà établie dans ce fichier). Repéré au
  passage, sans conséquence pour Jaris : leur `ollamaId` pour Granite pointe vers `ibm/granite4.1:8b` —
  exactement le préfixe communautaire non officiel que ce projet avait déjà écarté pour cette même famille.
  **Piège technique rencontré en interrogeant leur API, à garder en tête pour toute future requête vers un
  service derrière Cloudflare** : un premier essai via `urllib.request` de Python (User-Agent par défaut,
  `Python-urllib/3.x`) s'est fait bloquer en 403 Forbidden sur les 104 requêtes sans exception — alors que
  les mêmes appels via `curl` passaient sans problème. Corrigé en fixant un User-Agent de navigateur
  classique sur les requêtes `urllib` — Cloudflare (qui sert leur site) bloque visiblement les User-Agents de
  bibliothèques HTTP par défaut, indépendamment de tout rate-limiting réel.
  **`ModelOverviewEntry` (shared/ipc.ts) gagne un champ `canirunIndex: number | null`, RENDU OBLIGATOIRE (pas
  optionnel)** : TypeScript a donc forcé la mise à jour des 4 endroits de hardwareScan.ts qui construisent ce
  type (`getModelOverview`/`buildEntry`, et les 2 branches de `pickBestFrom` dans `computeModelPicks`) — un
  filet gratuit qui aurait empêché d'en oublier un silencieusement si ce champ avait été optionnel.
  **Volontairement PAS intégré comme appel réseau live** : les 8 valeurs connues sont figées en dur dans le
  code (comme `INTELLIGENCE_MMLU_PRO`), pas récupérées à chaque ouverture de l'onglet Modèles — cohérent avec
  le principe "100% local" de Jaris et avec la réponse déjà donnée à Léo quand il a proposé CanIRun.ai comme
  outil d'intégration directe.
  Régression : `node --test scripts/test-options-reorganization-ui.mjs` (10 tests, dont 2 nouveaux — le
  bouton reste replié par défaut, un clic affiche les groupes/colonnes attendus avec un vrai "—" pour un
  modèle sans score CanIRun.ai, et le bouton est réellement habillé par le CSS de Jaris) ; vérifié mordant en
  cassant temporairement le repli "—" (`entry.canirunIndex` sans son `?? '—'`) : le test dédié échoue bien,
  sans faire échouer les 9 autres. `npm run typecheck`, `npm run build` et `npm test` (380 tests) au vert.
  Vérifié aussi par une capture d'écran réelle du rendu compilé (4 groupes, VRAM/score d'outils/score
  CanIRun.ai bien alignés, famille visuelle HUD respectée) avant de considérer la fonctionnalité terminée.
  **Non vérifié en usage réel** (pas d'accès à la machine de Léo) : le mécanisme est prouvé par un vrai
  navigateur avec des données simulées ; son utilité concrète avec les VRAIES données de sa machine (~38
  lignes réparties sur 5 groupes) reste à confirmer.

- **Étape 130, Léo, juste après avoir vu la première version : "quand on clique sur tout les models on doit
  ouvrire un page entierement pour ça et aussi pourquoi il ya pas beaucoup de score canirun.ai".** Deux
  retours dans le même message, sur "Tous les modèles" livré à l'étape 129.
  1. **Page plein écran, pas une liste dépliée sur place.** La liste (5 paliers, ~39 modèles) se dépliait
     jusqu'ici DANS la petite carte "Ce que ta machine fait tourner", tassée sous les paliers déjà affichés —
     jamais assez de place. Remplacé par une VRAIE page (`AllModelsOverview.tsx`), sur le même principe que
     la page Options elle-même : `createPortal` vers `document.body`, `position: fixed; inset: 0`, empilée
     PAR-DESSUS la page Options avec un z-index plus élevé (`.options-page--models`, z-index 25 contre 20)
     plutôt qu'un second onglet DANS Options — "Fermer" revient exactement là où on était (même onglet
     Modèles), sans jamais fermer la page Options elle-même en dessous. Pas de colonne de navigation à
     gauche comme la page Options (`.options-page__body--models { grid-template-columns: minmax(0, 1fr) }`) :
     un seul contenu, rien à onglet ici.
     **Piège attrapé PAR LE TEST avant de livrer, pas en relecture — la même faute déjà documentée deux fois
     dans ce fichier (étapes 95 et 117) : une règle CSS qui doit en réécrire une autre doit être ÉCRITE APRÈS
     elle dans le fichier, pas avant, même à spécificité égale.** Un premier essai avait placé
     `.options-page__body--models`/`.options-page--models` juste après la définition la plus ANCIENNE (et
     déjà supplantée) de `.options-page` (~ligne 315, celle qui n'a plus cours depuis la refonte "design
     importé" de l'étape 121) au lieu de la définition ACTIVE de `.options-page__body` (~ligne 3420, celle
     avec la vraie grille à 2 colonnes) — la règle à 1 colonne se faisait donc silencieusement écraser par
     la grille à 2 colonnes, plus bas dans le fichier. Un test dédié mesure maintenant le rectangle RÉEL du
     contenu (`.options-page__workspace`, doit démarrer près de x=0, pas décalé de ~200-250px comme si une
     colonne de navigation vide était encore réservée) — vérifié mordant en reproduisant l'erreur de
     placement exacte : le test échoue bien, corrigé en déplaçant la règle juste après la bonne définition de
     `.options-page__body`. Deux autres assertions nouvelles, mesurées plutôt que supposées : le rectangle de
     `.options-page--models` couvre pile tout le viewport (x=0, y=0, largeur/hauteur = celles de la fenêtre),
     et son z-index calculé est bien supérieur à celui de la page Options qu'il recouvre (2 éléments
     `.options-page` coexistent dans le DOM, jamais un seul).
  2. **"Pourquoi il n'y a pas beaucoup de score CanIRun.ai" : revérifié à la source, pas juste réexpliqué.**
     La première passe (étape 129) ne comparait que par nom EXACT du tag Ollama contre le champ `ollamaId` de
     CanIRun.ai — ratant les entrées où CanIRun catalogue le même modèle sous un autre nom SANS jamais
     renseigner `ollamaId` (ex: "gemma4-12b-it", `ollamaId: null` chez eux, mais un `intelligenceIndex` de 22
     qui s'applique bien au même modèle que `gemma4:12b` — "IT"/instruction-tuned est simplement le nom que
     CanIRun donne à la variante de conversation, celle que Jaris télécharge). Revérifié directement contre
     leur API (104 modèles listés, détail de chaque candidat plausible récupéré un par un) : 6 correspondances
     RÉELLES et sûres retrouvées ainsi (familles Gemma 4 et Ministral 3 — `gemma4:12b`=22, `gemma4:26b`=26,
     `gemma4:31b`=30, `gemma4:e4b`=12, `ministral-3:14b`=11, `ministral-3:3b`=7), portant la couverture de
     8/39 à 14/39. Le reste du constat de l'étape 129 tient toujours : pour la majorité des modèles restants,
     ce n'est PAS un problème de correspondance — CanIRun les catalogue bien (avec un `ollamaId` correct :
     `command-r:35b`, `north-mini-code-1.0`, `qwen3-coder-next`, `qwen3.5:27b`, `qwen3:1.7b`...) mais sans
     jamais renseigner `intelligenceIndex` pour eux : un vrai manque côté données de CanIRun, pas quelque
     chose que Jaris peut corriger.
     **Trois correspondances plausibles écartées explicitement, faute de certitude suffisante (jamais un
     score deviné)** : `mistral-small3.2:24b` (CanIRun ne liste que "Mistral Small 3.1 24B", une version
     PLUS ANCIENNE — l'écart figure noir sur blanc dans leur propre `name`) ; `devstral-2:123b` (CanIRun n'a
     que "Devstral Small 2 24B", une taille bien trop différente pour être le même modèle) ; `qwen3.5:35b`
     (CanIRun n'a que la variante MoE "35B-A3B", possiblement une architecture différente du tag dense de
     Jaris — non confirmé, donc non ajouté). `ministral-3:8b` reste aussi sans score : CanIRun le catalogue
     bien sous "ministral-8b" (`ollamaId` confirmé), mais sans `intelligenceIndex` chez eux non plus.
  Régression : `node --test scripts/test-options-reorganization-ui.mjs` (10 tests, le test "Tous les modèles"
  réécrit avec les 3 nouvelles mesures ci-dessus, vérifié mordant sur le placement CSS ET sur le z-index en
  réintroduisant chacun des deux défauts séparément). `npm run typecheck`, `npm run build` et `npm test`
  (380 tests) au vert. Vérifié aussi par capture d'écran réelle du rendu compilé (page plein écran, 5 groupes,
  scores CanIRun.ai visibles pour les nouvelles entrées) avant de considérer le correctif terminé.

- **Étape 131, suite du point 2 du message de Léo (le point 1, sur le tri des candidats par palier, reste en
  attente d'une clarification — voir la question posée avant ce correctif) : "il manque encore des score
  canirun et ajoute le bouton dans cette mis a jour pour que j'analyse et je te donne les appelle outils pour
  ceux que je peut".** Recherché AVANT de coder quoi que ce soit, par grep du dépôt entier plutôt que supposé :
  `useModelAnalysis` (le hook qui lance `scripts/benchmark-models.mjs` via l'IPC `runModelAnalysis` déjà
  fonctionnel de bout en bout — main.ts/preload.ts/shared/ipc.ts tous en place) et
  `ModelAnalysisProgress.tsx` (le tableau de suivi en direct qui va avec) n'étaient RENDUS NULLE PART dans le
  dépôt — ni `<ModelAnalysisProgress` ni `useModelAnalysis(` n'apparaissaient dans aucun composant. Pourtant
  le commentaire de `benchmarkRunner.ts` affirme depuis longtemps que "runModelAnalysis... reste disponible à
  la main depuis Options → Modèles" — le bouton qui l'appelait a dû disparaître au fil des refontes
  successives de l'onglet Modèles (étapes 115/116/121), remplacé par "Retester la configuration"
  (`handleRetestConfiguration`), qui ne fait qu'une chose différente (redétecter + télécharger les modèles
  déjà connus, sans jamais re-tester quoi que ce soit) — sans que personne ne remarque que l'ancien mécanisme
  de test comparatif restait orphelin, composants toujours présents, jamais nettoyés ni reconnectés.
  Restauré dans `AllModelsOverview.tsx` (la page "Tous les modèles" livrée à l'étape 129/130, l'endroit
  naturel : c'est justement là que la colonne "Appel d'outils" affiche le plus de "—") plutôt que recréé de
  zéro : un seul bouton "Lancer l'analyse" (scope `'all'`, Léo dit "LE bouton" au singulier) — le script
  sous-jacent saute déjà tout seul les modèles déjà connus (`verified-tool-scores.md`) ET ceux trop gros pour
  la VRAM/RAM détectée (badge "Ignoré"), donc `'all'` ne re-teste jamais ce qui est déjà su et ne télécharge
  jamais un modèle que la machine ne peut pas faire tourner — pas besoin d'un bouton par palier.
  **Discipline "un seul cadre" (déjà établie à l'étape 101) appliquée dès l'écriture, pas ajoutée après
  coup** : le tableau STATIQUE (colonnes VRAM/Appel d'outils/CanIRun.ai) et le tableau de SUIVI EN DIRECT
  (colonnes Fiabilité connue/Statut, rendu par `ModelAnalysisProgress`) ne s'affichent jamais en même temps —
  le premier est masqué tant que `analysis.benchmarking` est vrai. Après un run réussi, `getModelOverview()`
  est rappelé pour rafraîchir le tableau statique avec les VRAIS résultats fraîchement mesurés (sans ça,
  Léo aurait vu son run se terminer sans que rien ne change à l'écran).
  **Vérifié mordant avant de livrer** : un test retire temporairement le garde `!analysis.benchmarking` sur
  le tableau statique — le test dédié échoue bien (assertion sur les en-têtes de colonnes, qui distinguent
  sans ambiguïté les deux tableaux). Un second test vérifie le rafraîchissement réel après coup : le mock
  `getModelOverview` renvoie un score DIFFÉRENT à son second appel (simulant un vrai résultat de run), et le
  test confirme que la ligne concernée affiche bien ce nouveau score après la fin du run — pas juste que le
  tableau se réaffiche à l'identique.
  Régression : `node --test scripts/test-options-reorganization-ui.mjs` (11 tests, 1 nouveau). `npm run
  typecheck`, `npm run build` et `npm test` (381 tests) au vert. Vérifié aussi par capture d'écran réelle du
  rendu compilé, avant ET pendant un run simulé.
  **Non vérifié en usage réel** (pas d'accès à la machine de Léo) : que `scripts/benchmark-models.mjs`
  tourne bien de bout en bout sur sa configuration précise une fois qu'il clique vraiment sur ce bouton —
  seul le fil IPC/UI est prouvé ici, pas le script Node lui-même (déjà utilisé par ailleurs, jamais retouché
  dans ce correctif).

- **Étape 132, réponse au point 1 du message de l'étape 130 ("fait pour rapide etc... celui qui faut le moin
  de ram avec le plus pour tout"), tranché par une question à choix simple plutôt que deviné.** Trois lectures
  possibles avaient été identifiées (un simple tri d'affichage, une mise en avant du meilleur rapport VRAM/
  score, ou un changement du VRAI choix de modèle de Jaris pour tout le monde) — la dernière aurait changé un
  comportement réel, jamais à décider seul sur une phrase ambiguë. Léo a choisi la plus simple : trier chaque
  palier de "Tous les modèles" par VRAM CROISSANTE (le moins gourmand en tête).
  **Un tri PUREMENT d'affichage, prouvé sans effet sur le vrai choix de Jaris, pas juste affirmé.** Trié à la
  source (`getModelOverview`, hardwareScan.ts) plutôt que dans le composant React : les deux consommateurs
  (`AllModelsOverview.tsx` ET `ModelAnalysisProgress.tsx`, qui partagent les mêmes données) héritent du même
  ordre sans jamais avoir à le refaire séparément — éviter la duplication qui a déjà fait diverger deux
  écrans plusieurs fois dans ce fichier (composeur du Chat/Code avant l'étape 92, sélecteurs de voix...).
  `pickBestFrom` (computeModelPicks) lit directement `TIER_CANDIDATES`/`VISION_CANDIDATES`/`CODE_CANDIDATES`
  — jamais les groupes construits par `getModelOverview` — donc AUCUN risque qu'un tri d'affichage change
  quel modèle Jaris télécharge réellement : vérifié par un test dédié qui appelle le VRAI
  `pickBestModelsFromBenchmark()` juste après un appel à `getModelOverview()` dans le même test, pour
  confirmer que le second n'a pas perturbé le premier (pas seulement une relecture du code qui semble sûre).
  Le tri se fait sur une COPIE (`.map()` renvoie déjà un nouveau tableau, `.sort()` le trie en place sans
  toucher à l'original) : les tableaux `FLASH_CANDIDATES`/`MEDIUM_CANDIDATES`/etc. restent en ordre
  DÉCROISSANT de VRAM, l'ordre dont `pickBestFrom` a besoin — jamais mutés par ce correctif.
  Régression : `node --test scripts/test-model-overview-sort.mjs` (nouveau fichier, 3 tests sur le VRAI
  `getModelOverview()`, pas un mock : chaque palier réellement croissant, le premier modèle du palier Rapide
  change bien de `ministral-3:3b` à `qwen3.5:0.8b` — la preuve que le tri fait vraiment quelque chose, pas
  juste "déjà dans cet ordre" —, et `pickBestModelsFromBenchmark()` intact après coup). Vérifié mordant en
  retirant temporairement le tri : 2 des 3 tests échouent bien. `npm run typecheck`, `npm run build` et
  `npm test` (384 tests) au vert.

- **Étape 133, Léo répond au point 2 de l'étape 130 en envoyant deux captures d'écran réelles de "Tous les
  modèles" après avoir utilisé le bouton "Lancer l'analyse" restauré à l'étape 131, juste "tient" — les
  résultats promis pour qu'ils soient gardés pour tout le monde.** Avant de recopier le moindre chiffre dans
  `verified-tool-scores.md`, comparaison ligne par ligne avec ce qui y était déjà — et une anomalie a sauté
  aux yeux : `ministral-3:8b` affichait EXACTEMENT le même score "2/3" dans le palier Médium (conversation,
  qui devrait être sur 6) ET dans le palier Vision (correctement sur 3). Jamais pris pour argent comptant,
  creusé jusqu'à la cause exacte plutôt que simplement ignoré ou re-demandé à Léo.
  **Cause trouvée dans le code, pas devinée : `parseLocalBenchmark()` (hardwareScan.ts) lisait
  `benchmark-results.md` dans une seule Map plate par NOM DE MODÈLE, sans distinguer le palier.**
  `ministral-3:8b`, candidat À LA FOIS Médium (MEDIUM_CANDIDATES) ET Vision (VISION_CANDIDATES) depuis
  l'étape 128, vient d'être testé pour de vrai sous les DEUX rôles dans le MÊME run (le bouton restauré à
  l'étape 131) — `scripts/benchmark-models.mjs` écrivait bien deux lignes distinctes dans le fichier (un
  score de conversation sur 6, un score vision sur 3), mais `parseLocalBenchmark()` ne gardait que la
  DERNIÈRE ligne lue pour ce nom de modèle, écrasant silencieusement le score de conversation par le score
  vision testé juste après dans le script.
  **Le plus frappant : ce bug avait déjà été identifié et corrigé une fois — mais seulement à MOITIÉ.** Le
  commentaire de `parseVerifiedToolScores()` (hardwareScan.ts, fichier JUMEAU pour les scores COMMITÉS) dit
  littéralement "bug déjà rencontré une fois dans benchmark-results.md avant qu'on ne le corrige ici" — la
  correction (trois sections "## Conversation/Vision/Code" au lieu d'une liste plate) avait bien été
  appliquée à `verified-tool-scores.md`/`parseVerifiedToolScores` ET à `readVerifiedModels()` (déjà
  tier-aware dans benchmark-models.mjs, même commentaire), mais JAMAIS étendue au fichier LOCAL
  (`benchmark-results.md`) ni à `parseLocalBenchmark()`/`existingRows` (`alreadyDone`) qui le lisent — la
  même faille structurelle, oubliée sur son jumeau. **Deuxième conséquence, plus grave, trouvée en creusant
  `alreadyDone`** : comme il vérifiait juste "ce NOM DE MODÈLE a-t-il une ligne, peu importe laquelle",
  qu'un modèle multi-palier ait été testé pour UN SEUL de ses rôles suffisait à le faire sauter, À TORT,
  lors de TOUS ses futurs tests (`JARIS_RESUME=1`) — son rôle jamais réellement testé restait bloqué "déjà
  fait" pour toujours, sans qu'aucun run futur ne le corrige de lui-même.
  **Corrigé en appliquant EXACTEMENT le même correctif déjà validé pour le fichier jumeau, des deux côtés** :
  `parseLocalBenchmark()` renvoie désormais `Record<VerifiedTier, Map<...>>` (trois maps, comme
  `parseVerifiedToolScores`), relu par `buildEntry`/`resolveBenchmarkResult`/`computeModelPicks`/
  `previewVramSteps` avec le bon palier à chaque fois ; côté script, `existingRows`/`alreadyDone` et
  `persistResults()` écrivent/relisent désormais trois sections distinctes, chaque `perModel` porte son
  `role` depuis sa création (conversation/vision/code) pour savoir dans quelle section il va. Un ancien
  `benchmark-results.md` (avant ce correctif, sans section) se lit comme "rien de connu localement" plutôt
  que mal réparti — jamais un score qu'on ne peut plus garantir correct affiché comme s'il l'était ; le
  fichier se régénère proprement au prochain "Lancer l'analyse", `ministral-3:8b` y sera alors re-testé pour
  de vrai sous ses deux rôles, correctement séparés cette fois.
  **Vérifié pour de vrai avant de faire confiance au correctif** : un script jetable a rejoué le nouveau
  `persistResults()` avec deux résultats fictifs pour `ministral-3:8b` (5/6 conversation, 2/3 vision), écrit
  le markdown généré, puis le relit avec la logique du nouveau `parseLocalBenchmark()` — confirmé que les
  deux scores ressortent intacts et distincts, pas confondus. Un test dédié
  (`test-local-benchmark-tiers.mjs`) reproduit ensuite le même scénario sur le VRAI `getModelOverview()`,
  vérifié mordant en revenant temporairement à la lecture plate : le test échoue bien, avec le score vision
  (2/3) qui remonte à tort dans le palier Médium — exactement le symptôme de la capture de Léo.
  **Scores réellement nouveaux extraits des deux captures, ajoutés à `verified-tool-scores.md`** (tout le
  reste correspondait déjà à ce qui y était, une bonne confirmation de cohérence) : `mistral-small3.2:24b`
  (6/6, Conversation) et `ministral-3:8b` (2/3, Vision — SON score vision, correctement isolé, pas celui
  corrompu affiché à tort dans Médium). Le score de conversation de `ministral-3:8b` n'a PAS été recopié
  (2/3) : c'était précisément la valeur corrompue par ce bug, jamais fiable à commiter — il sera re-mesuré
  correctement par Léo au prochain "Lancer l'analyse", une fois ce correctif en place.
  Régression : `node --test scripts/test-local-benchmark-tiers.mjs` (nouveau fichier, 3 tests sur le vrai
  `getModelOverview()`/`parseLocalBenchmark()`, vérifiés mordants). `npm run typecheck`, `npm run build` et
  `npm test` (387 tests) au vert. `scripts/benchmark-models.mjs` vérifié par `node --check` (pas de test
  automatisé possible sans lancer un vrai run Ollama) et par la simulation jetable décrite ci-dessus.
  **Non vérifié en usage réel** (pas d'accès à la machine de Léo) : que son prochain "Lancer l'analyse"
  régénère bien `benchmark-results.md` dans le nouveau format et retest correctement `ministral-3:8b` sous
  ses deux rôles — le mécanisme est prouvé par le code et les tests, pas encore par un vrai run sur sa
  machine.

- **Étape 134, Léo, relayant un avis de ChatGPT : "enleve le bouton lancer l'analyse pour le public c'est
  pas bien".** Le bouton "Lancer l'analyse" (page "Tous les modèles", restauré à l'étape 131) peut déclencher
  le téléchargement de dizaines de Go de modèles candidats et un run de plusieurs dizaines de minutes — sans
  le moindre garde-fou pour quelqu'un qui clique dessus sans savoir ce qu'il fait, contrairement à Léo
  lui-même qui sait exactement ce qu'il déclenche. Retiré de `AllModelsOverview.tsx` (le bouton, sa phrase
  d'explication, `useModelAnalysis`/`ModelAnalysisProgress` ne sont plus importés ni rendus) — MAIS le canal
  IPC `runModelAnalysis` (main.ts/preload.ts), `benchmarkRunner.ts`, `ModelAnalysisProgress.tsx` et
  `useModelAnalysis.ts` restent tous intacts, aucune raison de les supprimer, juste de ne plus les exposer
  dans l'interface. `npm run benchmark:models` (déjà documenté dans "Commandes utiles" de ce fichier) reste
  la façon d'obtenir ces mesures : un geste délibéré depuis un terminal, jamais un bouton à portée de clic
  dans l'app livrée au public. CSS mort (`.options-menu__all-models-analysis`) retiré au passage, vérifié
  par grep avant suppression (CLAUDE.md, étape 3).
  Régression : `node --test scripts/test-options-reorganization-ui.mjs` (le test qui exerçait le bouton
  remplacé par un test qui vérifie son ABSENCE, vérifié mordant en réintroduisant temporairement un faux
  bouton "Lancer l'analyse" dans le JSX — le test échoue bien). `npm run typecheck`, `npm run build` et
  `npm test` (390 tests) au vert.

- **Étape 134 (suite), même message : "a la place de trouver un score sur Intelligence (Artificial Analysis)
  et vue qu'il n'on pas tout les model regarde huggin face... [3 leaderboards HF proposés par Gemini, un par
  palier : Open LLM Leaderboard pour Rapide/Médium/Puissant, Open VLM Leaderboard (opencompass) pour Vision,
  BigCode Models Leaderboard pour Code]".** Investigation menée AVANT tout code, en interrogeant les VRAIES
  sources de données derrière ces trois pages (jamais leur rendu Gradio, qui ne montre rien en HTML brut) —
  résultat : **les trois leaderboards proposés se sont révélés INUTILISABLES, moins complets que l'Artificial
  Analysis Index déjà en place, pas mieux comme le supposait la suggestion de départ.**
  - **BigCode Models Leaderboard** : son fichier de données (`data/code_eval_board.csv` dans le dépôt de
    l'Espace HF, récupéré directement) s'arrête à Qwen2.5-Coder-32B — sa page HF confirme d'ailleurs sa
    dernière vraie mise à jour en novembre 2024. Aucun des candidats Code de Jaris (qwen3-coder, qwen3.6:
    35b-a3b, devstral-small-2, north-mini-code-1.0, qwen3-coder-next, devstral-2) n'y figure : 0/9.
  - **Open LLM Leaderboard** : sa page ne sert que le HTML d'une appli React/Gradio (aucune donnée dans le
    HTML brut) — le vrai stockage est le jeu de données `open-llm-leaderboard/contents` sur Hugging Face
    (retrouvé via l'API HF), dont le `lastModified` remonte à mars 2025. Confirmé par une recherche ciblée
    dans ce jeu de données (API `datasets-server.huggingface.co`) : "gpt-oss" ne matche que "gpt2", "granite4"
    ne remonte que Granite 3.0/3.1 (jamais 4.x), "qwen3.5" ne remonte que Qwen1.5/Qwen2/Qwen2.5 — aucun des
    candidats Rapide/Médium/Puissant de Jaris (tous des familles Qwen3.5/3.6/3.8, Gemma4, Ministral-3,
    Granite4.x, plus récents que ce que ce jeu de données a jamais connu) n'y est mesuré.
  - **Open VLM Leaderboard (opencompass)** : son code source (`gen_table.py`/`meta_data.py`, lus directement
    depuis le dépôt de l'Espace HF) charge ses résultats depuis une URL externe
    (`opencompass.openxlab.space/assets/OpenVLM.json`) — récupérée directement : le fichier porte lui-même un
    horodatage `time: 20250917132916` (17 septembre 2025) et liste 285 modèles, mais AUCUN Qwen3-VL, AUCUN
    Ministral, AUCUN GLM-4.6V — seulement une ancienne "Gemma3-4B" (pas Gemma4). 0/9 candidats Vision de Jaris.
  **Aucun code changé pour ce point** : remplacer l'Artificial Analysis Index (15/40 candidats couverts,
  déjà en place) par ces trois leaderboards aurait fait RÉGRESSER la couverture à 0/40, l'inverse du but
  recherché. Signalé honnêtement à Léo plutôt que d'implémenter une suggestion qui aurait rendu la page pire
  — même discipline que la vérification systématique des sources externes déjà établie dans ce fichier
  (CanIRun.ai, chiffres MMLU-Pro tiers...) : une suggestion d'une autre IA (ici Gemini, relayée par Léo via
  ChatGPT) doit être vérifiée sur les VRAIES données avant d'être implémentée, jamais prise pour argent
  comptant parce qu'elle "a l'air" raisonnable en surface.

- **Étape 122, Léo : "je ne sais pas pourquoi tu a pas mis ces scores mais sur le site il ya des models que
  tu a mis non publier, mais au pire je le fait manuelement, fait moi un petit system pour que je note moi
  meme le score, et ajoute speed (Artificial Analysis)" — suite directe de plusieurs recherches de sources
  externes menées plus haut dans cette même session (les 3 leaderboards Hugging Face, Vellum AI, LiveBench.ai)
  et toutes rejetées faute de vraie couverture des 39 modèles candidats de Jaris.** Deux investigations
  supplémentaires, jamais documentées ici avant cette entrée, ont confirmé la même conclusion avant que Léo ne
  demande la correction manuelle : **Vellum AI** (leaderboard tourné vers les modèles commerciaux frontière,
  ~1/39 de recoupement réel avec les candidats de Jaris, aucun code changé) et **LiveBench.ai** (figé depuis
  ~2025, 0/39) — plus **Dubesor Benchtable**, une piste prometteuse par le NOM de ses modèles mais
  concrètement INACCESSIBLE depuis cet environnement (curl ET Playwright headless échouent tous deux de façon
  identique, `ws_closed_mid_exchange`/"upstream request failed" — un blocage réseau de l'environnement de
  développement, pas du site lui-même). Un tableau comparatif complet a été présenté à Léo (couverture réelle
  de chaque source), et un message prêt à envoyer à Artificial Analysis (24 modèles non couverts listés par
  famille) a été rédigé pour lui, sans aucun code changé sur ces points — Artificial Analysis n'a pas de
  robot conversationnel, seulement un formulaire de contact.
  **Décision de Léo, une fois ces pistes épuisées : "au pire je le fait manuelement".** La table figée
  (`ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX`, hardwareScan.ts) ne couvre que 15 modèles sur 39, et peut être
  fausse/datée (Léo a le site sous les yeux, un score peut y avoir changé) — plutôt que de continuer à
  chercher une SOURCE tierce parfaite (5 pistes déjà vérifiées et rejetées sur des données réelles), on donne
  à Léo le moyen de CORRIGER lui-même, pour de vrai, ce qu'il voit sur le site.
  **Architecture, trois couches, chacune pour une raison précise** :
  1. **`electron/services/externalScoresStore.ts`** (nouveau fichier) : un simple JSON dans `getDataRoot()`
     (userData, déplaçable avec le reste des données via "Déplacer", étape 121) — PAS commité dans le dépôt
     comme `verified-tool-scores.md`. Ces valeurs sont propres à ce que LÉO a lui-même relevé sur le site,
     jamais régénérées par `npm run build`, et un futur correctif de la table figée dans le code ne doit
     jamais les écraser silencieusement. `Record<string, ExternalScoreOverride>` avec `{intelligence?, speed?}`
     — un modèle -> deux champs modifiables INDÉPENDAMMENT (`setExternalScoreOverride(model, field, value)`,
     `value: null` efface CE champ précis, sans toucher à l'autre déjà enregistré pour le même modèle).
  2. **`hardwareScan.ts`** : `getModelOverview`/`computeModelPicks`/`pickBestFrom` fusionnent désormais
     `externalOverrides` — une correction manuelle prime TOUJOURS sur `ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX`
     pour ce modèle. Point décisif, pas seulement cosmétique : la fusion se fait aussi dans le VRAI départage
     (`pickBestFrom`, via un nouveau `artificialAnalysisFor(model)`), pas juste dans l'affichage de "Tous les
     modèles" — une correction de Léo peut donc réellement faire basculer le modèle choisi pour SA machine,
     exactement comme s'il avait corrigé la table figée elle-même. `externalOverrides` propagé aux 4 sites
     d'appel de `computeModelPicks` (`getModelOverview`, `pickBestModelsFromBenchmark`, `pickBestCodeModel`,
     `previewHardwareTiers`).
  3. **"Vitesse (Artificial Analysis)"** : un CHAMP ENTIÈREMENT NOUVEAU (`artificialAnalysisSpeed`), demandé
     par Léo mais sans le moindre équivalent dans le code existant — contrairement à `intelligence`, AUCUNE
     table figée n'a jamais été maintenue pour ce champ : `null` pour tout le monde tant que Léo ne l'a pas
     notée lui-même, jamais un chiffre deviné ou extrapolé d'un autre score.
  **Interface (`AllModelsOverview.tsx`)** : les deux colonnes Intelligence/Vitesse deviennent des `<input
  type="number">` cliquables directement dans le tableau (`EditableScore`), pas un formulaire à part — Léo
  voit déjà le tableau complet, corriger une case dedans est le geste le plus court. **Non contrôlé
  (`defaultValue`, pas `value`) à dessein** : la page entière se démonte/remonte à chaque fermeture/
  réouverture de "Tous les modèles" (`{open && createPortal(...)}`), donc `defaultValue` repart toujours
  d'une valeur fraîche sans jamais rester figée sur un ancien chiffre entre deux ouvertures — pas besoin de
  synchroniser un état contrôlé avec la prop à chaque frappe. `onBlur` déclenche l'enregistrement (pas
  `onChange` à chaque frappe, qui écrirait sur le disque à chaque caractère tapé) ; Entrée fait perdre le
  focus au champ pour déclencher le même chemin sans devoir cliquer ailleurs.
  **Piège déjà documenté dans ce fichier, retombé dessus une nouvelle fois en ajoutant l'import
  `./externalScoresStore` à `hardwareScan.ts`** : 5 tests vm-sandbox qui chargent ce fichier via un faux pont
  `require` (`test-context-length.mjs`, `test-hardwarescan-preview-steps.mjs`, `test-hardwarescan-tiebreak.mjs`,
  `test-local-benchmark-tiers.mjs`, `test-model-overview-sort.mjs`) ont échoué d'un coup ("Cannot find module
  './externalScoresStore'") tant que chacun n'a pas reçu le même stub `getExternalScoreOverrides: async () =>
  ({})`. Réflexe déjà écrit ici pour la même raison à plusieurs reprises (contextLength, capabilities,
  codegen-progress...) : après avoir ajouté un `import` à un module déjà chargé par plusieurs tests, `grep`
  TOUS les faux ponts avant de lancer la suite.
  **Piège trouvé dans MON PROPRE test navigateur (`test-options-reorganization-ui.mjs`), pas en relecture** :
  une assertion existante lisait `td.textContent?.trim()` pour vérifier l'Intelligence Index affiché — devenu
  un `<input>` avec cette étape, `textContent` y est TOUJOURS vide (la valeur d'un champ de saisie n'est
  jamais dans son `textContent`, ni son `placeholder`). Corrigé en lisant `input.value` (ou son `placeholder`
  entre crochets si vide) quand la cellule contient un champ, sinon le `textContent` comme avant — sans quoi
  ce test serait resté vert par accident (comparant `undefined`/chaîne vide à des valeurs elles-mêmes fausses)
  plutôt que de vérifier quoi que ce soit de réel.
  Régression : `node --test scripts/test-external-scores.mjs` (nouveau fichier, 7 tests sur un faux disque en
  mémoire — premier chargement sans fichier, indépendance RÉELLE des deux champs dans les deux sens, un champ
  vidé n'efface que lui-même, vider le dernier champ retire le modèle entier, deux modèles ne se mélangent
  jamais, relu depuis une seconde instance du module pour simuler un redémarrage) et 3 nouveaux tests dans
  `scripts/test-hardwarescan-tiebreak.mjs` (une correction manuelle remplace la table figée dans l'affichage
  ET dans le VRAI départage de `pickBestModelsFromBenchmark`, les deux champs coexistent sans se marcher
  dessus une fois lus par `hardwareScan.ts`, `artificialAnalysisSpeed` reste `null` sans donnée manuelle).
  Chaque assertion critique a été vérifiée en réintroduisant temporairement son défaut (le merge du
  départage réel, et l'indépendance des deux champs dans `externalScoresStore.ts`) : les deux échouent bien
  seuls avant correction. `npm test` : 400 tests, 0 échec.

- **Étape 123, suite immédiate de l'étape 122, deux demandes de Léo dans le même message : "1. j'ai
  commencer a remplir, tu peut les noter et enleve la possibilité de noter 2. termine recherche les model
  un part un sur le web".** Léo a testé le système d'édition manuelle livré à l'étape 122, rempli une bonne
  partie du tableau lui-même (2 captures d'écran envoyées), puis a demandé l'INVERSE de ce qui venait d'être
  livré : baker ses valeurs + finir la recherche pour les modèles restants, PUIS retirer la possibilité
  d'éditer. Le système d'édition manuelle (`externalScoresStore.ts`, `ExternalScoreOverride`, la fusion dans
  `pickBestFrom`, `EditableScore` dans AllModelsOverview.tsx) a donc vécu moins d'une journée avant d'être
  entièrement retiré — pas un échec du correctif précédent (il faisait ce qui était demandé), juste Léo qui a
  préféré, après l'avoir essayé, un tableau à nouveau simple à lire une fois la vraie recherche terminée
  plutôt que de garder la possibilité de le modifier lui-même.
  **Recherche menée un par un sur artificialanalysis.ai (jamais un agrégateur tiers), avant tout code** :
  couverture passée de 15/39 à 34/39 modèles candidats. Chaque chiffre vérifié par une VRAIE requête sur la
  fiche du modèle exact (jamais un rapprochement approximatif), avec deux leçons méthodologiques retenues en
  cours de route :
  - **Une synthèse de recherche web peut mélanger deux versions différentes de l'Intelligence Index (les
    scores sont retravaillés au fil des révisions de méthodologie, déjà documenté plus haut pour ce même
    index) sans le signaler** — repéré sur `qwen3:1.7b` (2 puis 5 selon la source), `north-mini-code-1.0`
    (27,6 puis 10) et `devstral-small-2:24b` (18 puis 8) : à chaque fois, une seconde lecture DIRECTE
    de la fiche du modèle (pas une synthèse de recherche) a donné un chiffre cohérent avec le reste de la
    table déjà vérifiée (échelle à un ou deux chiffres, jamais les anciens scores à deux chiffres d'une
    méthodologie antérieure recopiés par un tweet ou un article tiers). Toujours privilégié la lecture directe
    de la fiche sur toute synthèse qui ne cite pas la fiche elle-même.
  - **Deux corrections apportées aux valeurs entrées par Léo, trouvées en vérifiant plutôt qu'en recopiant** :
    (1) `qwen3.5:27b` : Léo avait noté 22, la fiche officielle donne 23 (confirmée deux fois, chiffre resté
    identique) — gardé 23. (2) `qwen3.6:35b`/`qwen3.5:35b` (les modèles DENSES que Jaris utilise vraiment,
    23-24 Go) : Léo avait noté 18/19, qui sont en réalité les scores de `qwen3.6:35b-a3b`/`qwen3.5:35b-a3b`
    (la variante MoE, un modèle DIFFÉRENT malgré le nom presque identique — Jaris a d'ailleurs déjà
    `qwen3.6:35b-a3b` comme candidat séparé dans CODE_CANDIDATES). Vérifié explicitement qu'aucune fiche
    Artificial Analysis dédiée n'existe pour la variante dense de ces deux familles avant de conclure — les
    deux restent donc "Non publié", la confusion de Léo n'a pas été reprise telle quelle.
  **Toutes les valeurs de Léo par ailleurs se sont révélées exactes une fois vérifiées** (granite4.1:3b,
  granite4.2:3b+vitesse, ministral-3:8b+vitesse, granite4.2:8b+vitesse, granite4.1:8b+vitesse,
  granite4.2:30b+vitesse, command-r:35b, ministral-3:3b+vitesse, ministral-3:14b+vitesse) — un signe que sa
  méthode (lire directement la fiche du site) était la bonne depuis le début.
  **Nouvelle table `ARTIFICIAL_ANALYSIS_SPEED`** (hardwareScan.ts), en plus de l'extension de
  `ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX` (15 -> 34 entrées) : même discipline (relevée le 21/09/2026,
  variante Reasoning, absence = jamais publiée). Contrairement à l'Intelligence Index, Artificial Analysis
  n'a pas de mesure de vitesse pour une partie des modèles même quand l'Intelligence Index est connu (fiche
  marquée "N/A" côté vitesse) : ces cas restent "—", jamais une estimation à la place d'une vraie mesure.
  **Revert complet du système d'édition manuelle de l'étape 122** (Léo : "enleve la possibilité de noter"),
  jamais un simple masquage côté interface — CLAUDE.md documente déjà pourquoi un code mort n'a aucune raison
  de rester après le retrait de son seul usage :
  - `electron/services/externalScoresStore.ts` supprimé en entier (le fichier, pas seulement ses appels).
  - `ExternalScoreOverride` (type), le canal IPC `setExternalScoreOverride` et sa fonction preload retirés de
    `shared/ipc.ts`/`electron/main.ts`/`electron/preload.ts`/`src/global.d.ts`.
  - `hardwareScan.ts` : `computeModelPicks`/`pickBestFrom`/`getModelOverview`/`previewHardwareTiers`/
    `pickBestModelsFromBenchmark`/`pickBestCodeModel` reviennent à une lecture DIRECTE des deux tables figées,
    sans la moindre couche de fusion — même simplicité qu'avant l'étape 122, juste avec beaucoup plus de
    modèles couverts et un second champ (vitesse).
  - `AllModelsOverview.tsx` : `EditableScore`/`saveScore` retirés, les deux colonnes redeviennent du texte
    simple (`entry.artificialAnalysisIndex ?? 'Non publié'`, `entry.artificialAnalysisSpeed ?? '—'`), comme
    le reste du tableau — la règle CSS dédiée à l'input (`.options-menu__score-input`) retirée avec.
  Régression : `scripts/test-external-scores.mjs` supprimé (plus rien de ce fichier à tester) ;
  `scripts/test-hardwarescan-tiebreak.mjs` mis à jour — la table "expose les Intelligence Index" couvre
  désormais les 34 modèles (avec une assertion dédiée qui vérifie que la variante dense `qwen3.6:35b` reste
  bien SANS score, contrairement à sa cousine A3B), un nouveau test couvre `artificialAnalysisSpeed`, les 3
  tests de départage par correction manuelle retirés (le mécanisme qu'ils testaient n'existe plus) ; les 5
  faux ponts `./externalScoresStore` retirés des tests qui n'en ont plus besoin (hardwareScan.ts ne l'importe
  plus) ; `scripts/test-options-reorganization-ui.mjs` : lecture des lignes du tableau revenue à un simple
  `textContent` (les cellules ne sont plus des `<input>`). `npm run typecheck`, `npm run build` et
  `npm test` (391 tests) au vert.
  **Leçon générale, qui rejoint et prolonge celle déjà tirée pour le bouton "Lancer l'analyse" (étape
  précédente) : une fonctionnalité livrée EXACTEMENT comme demandée peut quand même être retirée le jour
  même, une fois que l'utilisateur l'a réellement essayée et a changé d'avis en connaissance de cause** — ce
  n'est pas un signe que le correctif précédent était mal conçu, juste que certains choix (ici : éditer
  soi-même vs. avoir une recherche déjà faite) ne se jugent vraiment qu'à l'usage. Le retirer proprement
  (fichier supprimé, pas juste caché ; tests qui testaient le mécanisme retiré supprimés, pas laissés à
  vérifier du code mort) compte alors autant que l'avoir bien construit la première fois.

- **Étape 124, Léo, après avoir vu par lui-même ce qui restait sur le C une fois "Déplacer" utilisé (question
  posée : "mais je changer le dossier et je met le d mais il ya encore des choses de jaris dans le c",
  clarifié par une question à choix simple en "Petit (quelques Mo)") : "Je veut tout dans le dossier choisit
  TOUT".** Renverse explicitement le choix de l'étape 121 ("les originaux ne sont JAMAIS supprimés... même
  politique que l'ancien conversation-history.json conservé... parce que Léo s'était inquiété de perdre des
  données") — une demande explicite qui contredit un choix précédent l'emporte toujours (même convention déjà
  appliquée à l'étape 96 face à l'étape 47, puis à l'étape 121 elle-même face à l'étape 47 originale).
  **Vérifié avant de coder, pas supposé** : les 3 briques lourdes (`modelsLocation.ts`, modèles Ollama/
  environnement Python/cache HuggingFace) suppriment DÉJÀ leurs originaux une fois la copie confirmée
  (`redirectFolder`, `rm(real, ...)`) — seule la 4e brique, les données propres de Jaris (`dataLocation.ts`,
  conversations/profil/mémoire/applications générées/rappels), gardait volontairement un filet. C'est cette
  seule brique qui manquait la suppression, pas les 4.
  **`moveDataLocation` (dataLocation.ts) supprime maintenant les originaux, mais seulement APRÈS que la copie
  ET l'écriture du marqueur ont réussi** — jamais l'inverse, même garantie que `redirectFolder` : si la copie
  échoue en cours de route (disque plein, fichier verrouillé), rien n'a encore été supprimé, le message
  d'erreur existant ("elles restent à leur emplacement actuel, rien n'est perdu") reste donc vrai. Seules les
  entrées CONNUES (`OWNED_ENTRIES`) sont supprimées une par une, jamais `from` en bloc quand `from` est encore
  le vrai `userData` (premier déplacement) — userData héberge aussi les fichiers internes de Chromium (Cache,
  GPUCache, Network Persistent State...), qu'il ne faut jamais toucher, exactement la même règle qui empêchait
  déjà de les COPIER. Si `from` était un ancien dossier `jaris-data` (un déplacement précédent, ex: C -> D
  puis Léo redéplace D -> E), ce dossier entier est retiré une fois vide : sans ça, chaque nouveau
  déplacement laisserait une copie périmée de plus derrière lui, l'inverse exact de "TOUT dans le dossier
  choisi" pour quelqu'un qui déplace ses données plusieurs fois au fil du temps.
  **Compromis assumé, documenté plutôt que caché** : avant ce changement, débrancher le disque externe après
  un déplacement faisait retomber Jaris sur les VRAIES données d'origine (toujours là, jamais supprimées) —
  un vrai filet de sécurité. Depuis ce changement, `getDataRoot()` retombe toujours sur le même chemin par
  défaut en cas de disque manquant, mais ce chemin est désormais VIDE (les données ont vraiment déménagé) :
  Jaris repartirait de zéro tant que le disque n'est pas rebranché, plutôt que de retrouver les anciennes
  données. C'est le prix exact de "TOUT" que Léo a demandé en connaissance de cause (même mécanisme déjà
  accepté pour les 3 briques lourdes depuis le début) — pas un oubli.
  Régression : `scripts/test-data-location.mjs` — le test "les originaux ne sont JAMAIS supprimés" remplacé
  par son inverse ("les originaux SONT supprimés une fois la copie confirmée"), un nouveau test confirme que
  le cache Chromium reste intact même en supprimant les originaux connus autour de lui (le point le plus
  sensible de ce changement), et un nouveau test couvre un DEUXIÈME déplacement (D -> E) pour vérifier que
  l'ancien dossier `jaris-data` ne s'accumule pas. Les deux assertions critiques (suppression réelle,
  nettoyage au second déplacement) ont été vérifiées en retirant temporairement le bloc de suppression : les
  deux échouent bien avant correction, sans faire échouer les autres tests du fichier (dont celui qui protège
  le cache Chromium — jamais touché, avec ou sans ce bloc). `npm run typecheck`, `npm run build` et
  `npm test` (393 tests) au vert.
