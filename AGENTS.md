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
- **Un import direct `hf.co/...` peut échouer à cause d'une version précise d'Ollama : traiter l'échec, pas
  retirer le modèle** : Ollama 0.34.2 refuse les redirections de Hugging Face vers son CDN avec `blocked
  redirect to a different host` (github.com/ollama/ollama/issues/18526, corrigé en v0.34.3, pré-version au
  22/09/2026), ce qui faisait échouer entièrement « Retester la configuration » dès que G9v3-3B était choisi.
  Une première correction (autre IA) avait retiré G9v3-3B et GLM-4.6V-Flash des paliers — et effacé au
  passage leurs scores RÉELLEMENT mesurés de `verified-tool-scores.md`. Léo a demandé de les remettre
  (étape 136) : `runQuickSetup` écarte maintenant, pour ce run seulement, tout import `hf.co/` dont le
  téléchargement échoue et retombe sur le meilleur modèle suivant (`pickBestModelsFromBenchmark(exclude)`),
  avec un message clair pour Léo. Une erreur sur un tag de la bibliothèque Ollama remonte toujours telle
  quelle. **Leçon générale : un bug d'une version d'un outil tiers ne justifie pas de dégrader le choix pour
  tout le monde ni d'effacer des mesures réelles — contenir l'échec là où il se produit.**
  Depuis l'étape 139, l'échec est même contourné : Jaris importe lui-même le modèle (huggingFaceImport.ts).

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

- **Étape 125, Léo, après avoir lu l'entrée de l'étape précédente : "mais on est d'accord que Qwen3.6 35B
  A3B c'est qwen3.6 35b ?"** J'avais conclu, à l'étape 122, que `qwen3.5:35b`/`qwen3.6:35b` (les tags DENSES
  utilisés par Jaris) étaient des modèles DIFFÉRENTS de `qwen3.6:35b-a3b`/`qwen3.5:35b-a3b` (la variante MoE),
  sur la seule base qu'aucune fiche Artificial Analysis dédiée au nom "dense" n'existait. Léo avait raison de
  douter — vérifié cette fois DIRECTEMENT sur `ollama.com/library/qwen3.6/tags` et
  `ollama.com/library/qwen3.5/tags`, en comparant le DIGEST du fichier plutôt que son nom : `qwen3.6:35b` et
  `qwen3.6:35b-a3b` partagent EXACTEMENT le même digest (`096fdbd02fe6`, 23 Go) — deux ÉTIQUETTES pour le
  MÊME fichier, jamais deux modèles. Même chose pour `qwen3.5:35b`/`qwen3.5:35b-a3b` (`3460ffeede54`, 24 Go).
  Il n'existe donc AUCUNE variante "dense" séparée à ces tailles chez Qwen3.5/3.6 : le tag court est un
  simple alias du tag complet, exactement comme Léo le pensait.
  **Cause de mon erreur initiale, pour ne pas la refaire** : j'avais vérifié "aucune fiche Artificial
  Analysis pour le NOM `qwen3.6:35b` (dense)" et conclu "donc c'est un modèle différent, non couvert" —
  un raisonnement qui aurait été correct SI un modèle dense distinct existait vraiment, mais faux ici car il
  n'en existe pas du tout : l'absence de fiche prouvait juste qu'Artificial Analysis ne nomme pas de variante
  "dense" (parce qu'aucune n'existe), pas que le tag de Jaris pointe vers un modèle non couvert. **Leçon
  générale : quand deux noms de tags très proches (`:35b` et `:35b-a3b`) pourraient désigner soit le même
  fichier soit deux fichiers différents, vérifier le DIGEST (l'identifiant unique du contenu réel), jamais
  seulement l'absence d'une fiche externe à l'un des deux noms — une source externe qui ne nomme qu'une seule
  variante ne prouve rien sur le nombre RÉEL de modèles distincts qui existent.** Repris directement au piège
  déjà documenté ici pour `gemma-4-26b-a4b`/le nom "a4b" (nombre de paramètres actifs, pas un tag à part) :
  toujours vérifier la source la plus PRIMAIRE possible (ici le registre Ollama lui-même, pas Artificial
  Analysis) avant de conclure que deux noms désignent deux choses différentes.
  Corrigé dans `ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX`/`ARTIFICIAL_ANALYSIS_SPEED` (hardwareScan.ts) :
  `qwen3.5:35b` (19, vitesse 148 — revérifiée directement sur la fiche A3B, chiffres identiques puisque même
  fichier) et `qwen3.6:35b` (18, vitesse 109) ajoutés, avec les mêmes valeurs que leurs alias `-a3b` déjà
  présents dans la table. Couverture Artificial Analysis : 34/39 -> 36/39 modèles candidats.
  Régression : `scripts/test-hardwarescan-tiebreak.mjs` — le test qui affirmait "qwen3.6:35b/qwen3.5:35b
  doivent rester sans score" (qui codait en dur l'erreur elle-même) est retiré ; la liste "Intelligence Index
  attendus" inclut désormais les deux ; le test de repli VRAM (qui reposait sur "aucun des deux n'a de score
  Artificial Analysis", plus vrai depuis cette correction) est reconstruit sur une VRAIE égalité stricte de
  score (mistral-small3.2:24b et qwen3.5:2b, tous deux à 7) plutôt que sur une absence. `npm run typecheck`,
  `npm run build` et `npm test` (393 tests) au vert.

- **Étape 126, Léo, après la correction de l'étape 125 : "1. je veut que tu reevérifie chaque score et je
  veut pas de faux score 2. vas sur le site https://artificialanalysis.ai/models/recommend... regarde si on
  a bien les meilleur model pour les palier".** Deux demandes distinctes, traitées séparément.
  **Point 1 : re-vérification complète des 36 entrées de `ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX`, cette
  fois avec une discipline plus stricte que lors de la recherche initiale (étape 122)** — chaque page relue
  directement via une requête qui exige une CITATION EXACTE de la phrase source ("quote exactly, word for
  word"), jamais une synthèse. Trois VRAIS faux scores trouvés et corrigés, tous originaires d'une synthèse
  de recherche (jamais d'une lecture directe de la fiche, exactement le piège déjà documenté 3 fois à l'étape
  122 pour qwen3:1.7b/north-mini-code-1.0/devstral-small-2:24b — la leçon n'avait pas été appliquée
  systématiquement à TOUTES les entrées, seulement à celles qui avaient semblé douteuses sur le moment) :
  - `mistral-small3.2:24b` : 7 -> 8 (vitesse 156 -> 146)
  - `qwen2.5-coder:32b` : 2 -> 7
  - `qwen2.5-coder:7b` : 4 -> 6
  Plus des ajustements mineurs de VITESSE (le chiffre publié par Artificial Analysis fluctue légèrement
  d'une lecture à l'autre — déjà observé à l'étape 122 pour qwen3-coder-next/qwen3-coder:30b — mis à jour
  vers la lecture la plus récente pour : gemma4:12b (113->114), gemma4:e4b (42->41), ministral-3:14b
  (89->87), ministral-3:3b (215->221), granite4.2:3b (220->218), ministral-3:8b (81->87), granite4.2:8b
  (90->94), qwen3-vl:8b (112->109), qwen3.6:35b/qwen3.6:35b-a3b (109->115). Aucun Intelligence Index n'a
  changé lors de cette relecture stricte hormis les 3 corrections ci-dessus — tous les autres étaient déjà
  exacts. **Leçon générale, cette fois vraiment retenue pour de bon : la synthèse d'un moteur de recherche
  n'est fiable NULLE PART dans ce genre de vérification, même pour une entrée qui n'a jamais semblé douteuse
  — systématiquement re-lire la fiche PRIMAIRE avec une citation exacte avant de faire confiance à un
  chiffre, sans exception pour les entrées "faciles".**
  **Point 2 : le comparateur interactif `/models/recommend` s'est révélé INACCESSIBLE depuis cet
  environnement** — c'est une application JavaScript qui ne rend rien via une simple requête HTTP (WebFetch),
  et une tentative via un navigateur headless (Playwright) s'est heurtée au même blocage réseau déjà rencontré
  pour Dubesor Benchtable plus tôt dans cette session (proxy de l'environnement, pas le site lui-même).
  **Contournement partiel, en cherchant plutôt les articles/annonces récents d'Artificial Analysis** : a
  révélé **Muse Glimmer** (Meta, 30B dense + encodeur vision ~1,8B, Apache 2.0, sorti le 10 août 2026,
  disponible sur Ollama — `muse-glimmer:30b`, 18 Go), un modèle candidat que Jaris ne connaît pas du tout
  aujourd'hui, explicitement optimisé pour l'usage agentique/appel d'outils local. **Piège évité de justesse
  ici aussi, même leçon que le point 1** : un article de blog Artificial Analysis annonçait "35" pour ce
  modèle, une comparaison de recherche synthétisée annonçait "38" pour qwen3.6:27b (alors que sa fiche directe
  donne 21, déjà vérifié 3 fois de façon cohérente) — la fiche DIRECTE du modèle, relue deux fois avec la même
  discipline de citation exacte, donne un score cohérent avec le reste de la table : 17 (vitesse 92 tok/s),
  proche mais légèrement EN DESSOUS de gemma4:31b (19) déjà candidat — pas le bond spectaculaire que
  suggérait l'article. **Non ajouté au code pour l'instant** : l'Intelligence Index n'est qu'un DÉPARTAGE
  dans `pickBestFrom` (hardwareScan.ts), jamais le critère principal — le critère principal est la fiabilité
  d'appel d'outils mesurée LOCALEMENT (`verified-tool-scores.md`/`benchmark-results.md`), qu'aucune recherche
  web ne peut fournir pour un modèle jamais testé par Jaris. Proposé à Léo comme candidat à ajouter puis à
  tester via `npm run benchmark:models` sur sa machine, plutôt que de l'ajouter à l'aveugle sans savoir s'il
  appelle vraiment les outils correctement.
  Régression : `scripts/test-hardwarescan-tiebreak.mjs` mis à jour avec les 3 corrections et les ajustements
  de vitesse ; le test de repli VRAM (qui reposait sur `mistral-small3.2:24b`/`qwen3.5:2b` À ÉGALITÉ de score,
  plus vrai depuis la correction 7->8) reconstruit sur une VRAIE égalité entre `granite4.2:30b` et
  `glm-4.7-flash:q4_K_M` (tous deux à 15). `npm run typecheck`, `npm run build` et `npm test` (393 tests)
  au vert.

- **Étape 127, Léo a relayé une réponse de ChatGPT ("bas fait un prompt a chatgpt lui il peut"), à qui
  j'avais rédigé un prompt pour ouvrir le comparateur interactif `/models/recommend`, inaccessible depuis
  cet environnement (étape 126).** ChatGPT a bien accédé au comparateur (avec des filtres d'URL précis :
  `?image=true&open=true&size=small` pour Vision, `?types=coding&open=true&size=small` pour Code) et a
  rapporté 6 points, chacun avec une citation censée venir de la fiche directe du modèle.
  **Deux des six citations rapportées se sont révélées FAUSSES en les revérifiant nous-mêmes avant d'y
  toucher** — même discipline que l'étape 126, appliquée cette fois à un rapport d'une AUTRE IA, pas
  seulement à mes propres recherches : "Gemma 4 31B (Reasoning) scores 15" (relu directement, deux fois : 19,
  jamais 15) et "Qwen3.6 35B A3B (Reasoning) scores 19" (relu directement : 18, jamais 19 — c'est très
  exactement le chiffre déjà en place dans la table, inchangé). Aucun des deux n'a donc bougé dans le code.
  **Leçon générale, qui étend celle de l'étape 126 : la consigne "cite la phrase exacte de la fiche" donnée à
  une autre IA ne suffit pas à garantir un chiffre exact — une citation qui SE PRÉSENTE comme exacte peut
  quand même être fausse (résumée par erreur, tirée d'une page de comparaison plutôt que de la fiche
  elle-même, ou simplement inventée avec un format convaincant). Un chiffre transmis par un tiers, humain ou
  IA, reste à revérifier soi-même sur la source primaire avant d'entrer dans le code — la consigne donnée en
  amont ne remplace jamais la vérification en aval.**
  **Les deux autres propositions, elles, ont résisté à la revérification et ont été ajoutées** :
  - **`granite4.2:3b` rejoint Rapide** (déjà candidat Médium, voir MEDIUM_CANDIDATES) : 2,2 Go, Intelligence
    Index 9 — au-dessus des 3 candidats Rapide déjà en place (qwen3.5:0.8b 6, ministral-3:3b/qwen3:1.7b 5).
  - **`qwen3.8:27b` rejoint Vision** (déjà candidat Puissant, voir LARGE_CANDIDATES) : support image confirmé
    directement sur sa fiche Ollama ("text, image, and video" en entrée, FAQ explicite), Intelligence Index 34
    contre 19 pour gemma4:31b, le meilleur candidat Vision jusqu'ici. Aucun poids supplémentaire à télécharger
    pour qui l'a déjà comme modèle Puissant.
  Les deux restent des candidats "réutilisation" (comme qwen3.5:4b/gemma4:e4b déjà partagés entre plusieurs
  paliers) : leur score Artificial Analysis ne les fait PAS gagner automatiquement — c'est un départage
  utilisé seulement à égalité de fiabilité d'appel d'outils, qui reste à mesurer localement
  (`npm run benchmark:models`) avant qu'ils ne soient réellement choisis pour une machine donnée.
  **Sur Code**, ChatGPT a vérifié que le comparateur (filtré coding + open + small) garde `qwen3.6:35b-a3b`
  devant `qwen3.8:27b` malgré son score général supérieur — cohérent avec le fait que Jaris l'a déjà comme
  seul vrai candidat Code de cette taille : rien à changer là.
  Régression : nouveau test dans `scripts/test-hardwarescan-tiebreak.mjs` qui confirme que les deux nouveaux
  modèles apparaissent bien dans leur palier respectif — vérifié en retirant temporairement les deux lignes
  ajoutées, le test échoue bien. `npm run typecheck`, `npm run build` et `npm test` (394 tests) au vert.

- **Étape 128, Léo : "ajoute pouvoir filtrer les models par la ram, par de la moin de vram a la plus, le plus
  rapide, le plus inteligent, le plus appelle outils un peut tout".** En réalité un TRI (pas un filtre qui
  masquerait des lignes) sur les 4 colonnes chiffrées déjà affichées dans "Tous les modèles" : VRAM nécessaire,
  Appel d'outils, Intelligence (Artificial Analysis), Vitesse (Artificial Analysis).
  **Titres de colonne cliquables** (`AllModelsOverview.tsx`) : un clic trie, un second clic sur la MÊME
  colonne inverse le sens (▲/▼ affiché à côté du titre actif). Changer de colonne repart d'un sens de
  lecture "utile" par défaut plutôt que de toujours repartir croissant : VRAM repart CROISSANTE (Léo : "de la
  moin de vram a la plus"), les 3 autres repartent DÉCROISSANTES — la meilleure valeur en tête ("le plus"
  rapide/intelligent/appelle outils). **Un SEUL état de tri partagé par les 5 tableaux** (un par palier,
  Rapide/Médium/Puissant/Vision/Code) : cliquer "VRAM nécessaire" trie les 5 en même temps, plutôt que gérer
  5 états de tri indépendants pour une même colonne qui existe identiquement dans chacun.
  **Piège identifié avant de coder, pas après** : une valeur ABSENTE (modèle jamais évalué par Artificial
  Analysis, "Non publié"/"—") doit toujours retomber en FIN de tri, quel que soit le sens choisi — un tri
  DÉCROISSANT naïf sur "Intelligence" ferait sinon remonter en tête tous les modèles jamais testés (souvent
  traités comme `null`, qui peut se comparer de façon incohérente selon le langage), l'exact inverse de ce
  qu'on cherche en triant "le plus intelligent en premier". `sortEntries` traite `null` comme un cas à part,
  toujours perdant, dans les deux sens.
  **Colonne "Appel d'outils"** (`toolCalling`, une chaîne "6/6"/"2/3", pas un nombre) : `toolScoreValue`
  extrait le numérateur pour trier, cohérent avec `parseToolScore` déjà utilisé côté serveur
  (hardwareScan.ts, `pickBestFrom`) pour la même comparaison — même logique, pas une seconde implémentation
  divergente à maintenir en parallèle.
  **Piège CSS attrapé avant de livrer, pas en relecture** : transformer le titre de colonne en `<button>`
  pour le rendre cliquable lui fait perdre l'héritage de la police d'affichage (Rajdhani) — un `<button>` a
  sa propre police par défaut dans la feuille de style du navigateur, qui ne s'hérite PAS automatiquement du
  `<th>` parent contrairement à `text-transform`/`letter-spacing`/couleur. `font: inherit` explicite sur
  `.options-menu__sort-button` (index.css) corrige ça — sans cette ligne, le bouton aurait détonné avec le
  reste de l'en-tête (police système au lieu de Rajdhani).
  Régression : nouveau test dans `scripts/test-options-reorganization-ui.mjs`, vrai navigateur — ordre par
  défaut, premier clic sur VRAM (croissant), second clic (inversé), clic sur Appel d'outils (décroissant,
  score absent toujours en fin de liste). Vérifié en cassant temporairement le basculement de sens : le test
  échoue bien. `npm run typecheck`, `npm run build` et `npm test` (395 tests) au vert.

- **Étape 129, Léo, sur la version livrée juste avant : "? mais je voit pas de truc pour filtrés dans tout
  les models"** — il était bien à jour (0.15.39 confirmée), donc pas un problème de version : le tri de
  l'étape 128 FONCTIONNAIT (son test le prouvait, clic + réordonnancement vérifiés dans un vrai navigateur),
  mais rien ne le SIGNALAIT à l'écran.
  **Diagnostic confirmé par une VRAIE capture du rendu compilé avant de toucher au code, pas supposé** : les
  4 titres de colonne cliquables (`<button>` avec `font: inherit; background: none; border: none`) étaient
  visuellement IDENTIQUES aux 2 titres non cliquables ("Modèle", "Utilisé par Jaris") — même police, même
  gris terne, même taille, aucune bordure, aucune icône. Le seul indice existant était une flèche ▲/▼ qui
  n'apparaissait qu'APRÈS avoir cliqué (donc invisible tant qu'on n'a pas deviné qu'il fallait cliquer), plus
  une phrase "Clique sur un titre de colonne pour trier" noyée en fin de paragraphe d'introduction en petit
  gris. Léo a donc regardé la page et conclu, à juste titre, qu'il n'y avait aucune commande.
  **Corrigé en rendant la commande VISIBLE, pas en ajoutant une explication de plus** : une barre "Trier par"
  au-dessus des tableaux, avec 5 pastilles évidemment cliquables (VRAM / Appel d'outils / Intelligence /
  Vitesse / Par défaut). Elles reprennent la famille visuelle des onglets d'Options (`.options-menu__tab` :
  pastille arrondie, bordure, fond cyan translucide quand active) — déjà comprise comme cliquable ailleurs
  dans l'app — plutôt qu'un style inventé à côté, même discipline que le bouton d'envoi du composeur et les
  actions du mode Code. La pastille active affiche son sens (▲/▼) et "Par défaut" ramène à l'ordre d'origine
  sans avoir à deviner quel tri annule quoi. Les titres de colonne restent cliquables (raccourci pour qui
  l'a compris) mais portent désormais un indicateur PERMANENT "↕" au repos, volontairement discret
  (`--hud-text-faint`) pour ne pas concurrencer la flèche vive de la colonne réellement active.
  **Leçon générale, déjà écrite deux fois dans ce fichier sous d'autres formes (le bouton resté gris de
  l'étape 97, "une vérification de layout ne dit rien de la qualité perçue" des étapes 69-71) et à retenir
  pour de bon : un test qui prouve qu'un mécanisme MARCHE ne prouve pas qu'il est TROUVABLE.** Le test de
  l'étape 128 cliquait directement le sélecteur CSS du bouton — il ne pouvait structurellement pas détecter
  que rien, à l'écran, n'invitait un humain à ce clic. Pour toute commande nouvelle, il faut une assertion
  distincte sur son AFFORDANCE (existe-t-elle visiblement ? a-t-elle une bordure, un curseur, une forme de
  bouton ?) en plus de celle sur son comportement — et une capture du rendu réel, qui aurait montré le
  problème en une seconde.
  Régression : nouveau test dans `scripts/test-options-reorganization-ui.mjs` qui vérifie que les 5 pastilles
  existent, qu'elles sont réellement habillées par le CSS (coins arrondis, bordure, `cursor: pointer`
  MESURÉS via `getComputedStyle`, pas juste présentes dans le DOM) et qu'une seule est active à la fois après
  un clic. Vérifié en retirant temporairement la barre : le test échoue bien. Une assertion PRÉ-EXISTANTE a
  dû passer d'une égalité stricte à une comparaison par sous-chaîne sur le texte des en-têtes, qui porte
  maintenant l'indicateur "↕" collé au titre. `npm run typecheck`, `npm run build` et `npm test` (396 tests)
  au vert, plus deux captures du rendu réel (avant/après) comparées.

- **Étape 130, Léo : "met dans : Ce que ta machine fait tourner, le score Intelligence (Artificial
  Analysis)".** La carte des paliers (`HardwareTierPreview.tsx`, partagée entre l'écran d'accueil et
  Options → Modèles) affichait par ligne : le rôle (Rapide/Médium/Puissant/Vision/Code), le modèle retenu, sa
  vitesse et son badge de fiabilité d'appel d'outils — mais pas l'Intelligence Index, pourtant visible juste
  à côté dans "Tous les modèles".
  **Rien à ajouter côté backend : la donnée arrivait DÉJÀ jusqu'au renderer.** Chaque emplacement de palier
  est un `ModelOverviewEntry` complet (voir `HardwareTierPreview` dans shared/ipc.ts), qui porte
  `artificialAnalysisIndex` depuis que la table existe — `previewHardwareTiers` étale déjà le résultat de
  `computeModelPicks` tel quel. Vérifié avant de coder plutôt que de supposer qu'il fallait un nouveau champ
  IPC : la correction se limite donc à afficher une valeur déjà transmise, pas à la faire transiter.
  **Libellé COLLÉ à la valeur ("Intelligence 34"), pas un nombre nu** : ce tableau-là n'a aucune ligne
  d'en-tête (contrairement à celui de "Tous les modèles", qui a des titres de colonne), donc un "34" seul
  posé entre une vitesse et un badge "6/6" n'aurait eu aucun moyen d'être compris. "—" quand Artificial
  Analysis n'a rien publié pour ce modèle exact — même convention que la colonne vitesse juste à gauche, et
  jamais "Non publié" (trop long pour cette ligne compacte, contrairement au tableau large).
  **Volontairement plus terne que ses deux voisines** (`--hud-text-faint`) : la vitesse et la fiabilité sont
  des mesures faites sur LA machine de l'utilisateur, l'Intelligence Index est un chiffre de contexte publié
  par un tiers — les mettre au même niveau visuel les ferait passer pour trois mesures de même nature.
  **Largeur revérifiée par capture réelle à 820/760/640/560 px** (cette carte apparaît aussi sur l'écran
  d'accueil, où la fenêtre peut être bien plus étroite que la page Options) : aucun débordement horizontal,
  le nom de modèle se tronque proprement comme il le faisait déjà — piège déjà documenté à l'étape 97
  ("ça ne se voit qu'en mesurant une fenêtre étroite, jamais sur la fenêtre de développement").
  Régression : nouveau `scripts/test-hardware-tier-preview-ui.mjs` (vrai navigateur, premier test dédié à ce
  composant — il n'en avait aucun jusqu'ici) : une cellule Intelligence par emplacement avec son libellé, "—"
  pour un modèle sans score publié, et aucun débordement à 560 px. Vérifié en retirant temporairement la
  colonne : les deux tests de contenu échouent bien. `npm run typecheck`, `npm run build` et `npm test`
  (399 tests) au vert, plus deux captures du rendu réel (avant/après) comparées.

- **Étape 131, Léo : "faut mieux garder 82.1 tok/s (estimé) ou score speed de artificalanalyse" puis, après
  ma réponse, "oui mais le score, te donne une idée, en faite enleve token suprimer et prend le score
  speed".** Ma recommandation initiale était de GARDER la vitesse locale estimée dans "Ce que ta machine fait
  tourner" (elle est calculée avec la carte graphique de l'utilisateur, donc elle répond à "ça va aller vite
  chez moi ?", là où Artificial Analysis mesure sur des serveurs). Léo a maintenu sa demande en donnant la
  raison qui tranche : "le score te donne une idée" — il veut un repère COMPARATIF entre modèles, pas une
  prédiction locale. Demande réaffirmée = demande qui gagne (même convention qu'aux étapes 96 et 21bis).
  **Ce que son choix corrige réellement, et que je n'avais pas mis dans la balance en recommandant l'inverse** :
  l'estimation locale reposait sur `GPU_MEMORY_BANDWIDTH_GBPS`, une table de 24 cartes NVIDIA grand public
  (RTX 30/40/50) écrite à la main — toute carte absente (professionnelle, portable, AMD, Intel, ou simplement
  une génération plus récente que la table) donnait `null`, donc "—" à l'écran. Un chiffre juste pour les
  cartes listées mais ABSENT pour les autres est un moins bon compromis qu'un chiffre toujours présent et
  honnêtement étiqueté : Artificial Analysis publie la même mesure pour tout le monde, et son absence ne
  dépend plus du matériel de qui regarde mais uniquement de ce que le site a publié pour ce modèle exact.
  **Le vrai risque du remplacement, traité DANS le code plutôt qu'en espérant que ça se devine** : "218 tok/s"
  posé dans une carte intitulée "Ce que ta machine fait tourner" se lit naturellement comme ce que SA machine
  va faire. D'où une légende, une seule fois sous toute la liste (jamais répétée dans chacune des ~10 cartes) :
  "Vitesse et Intelligence : mesures publiées par Artificial Analysis, identiques pour tout le monde — elles
  servent à comparer les modèles entre eux, pas à prédire la vitesse sur ta machine." Un test échoue si cette
  phrase disparaît ou cesse de nommer sa source — la mise en garde fait partie du correctif, pas du commentaire.
  **Nettoyage complet plutôt qu'un simple changement d'affichage** (CLAUDE.md, étape 3) : une fois la vitesse
  estimée retirée de l'écran, `estimateSpeedTokPerSec`, `detectGpuBandwidthGbps`, `MEMORY_BANDWIDTH_EFFICIENCY`
  et toute la table `GPU_MEMORY_BANDWIDTH_GBPS` n'avaient plus AUCUN consommateur — supprimés, ainsi que
  `speedTokPerSec`/`speedEstimated` de `ModelOverviewEntry` (shared/ipc.ts) et le paramètre `gpuName` devenu
  mort dans `computeModelPicks`/`previewVramSteps`/`resolveBenchmarkResult`. Vérifié AVANT de supprimer que
  la vitesse locale n'entrait dans AUCUNE décision (`pickBestFrom` départage par fiabilité -> Intelligence
  Index -> MMLU-Pro -> VRAM, jamais par vitesse) : c'était un affichage et rien d'autre, donc aucun modèle
  choisi ne change. `LocalBenchmarkEntry.speedTokPerSec` est en revanche GARDÉE : elle reste la colonne que
  `scripts/benchmark-models.mjs` écrit dans `benchmark-results.md`, un fichier lisible tel quel — arrêter de
  la lire aurait désynchronisé le parseur du format du fichier pour rien.
  **Piège de MON PROPRE correctif, attrapé par une capture d'écran du rendu compilé et pas en relecture** :
  en fusionnant les deux colonnes dans une seule règle CSS (`.capacity-scan__tier-intelligence,
  .capacity-scan__tier-speed { color: ... }`) pour leur donner la même teinte "chiffre de contexte", j'ai
  perdu au passage le `padding-right: 10px !important` que chacune portait séparément — "Intelligence 9" se
  retrouvait collé au badge "6/6" juste à droite. Invisible en relisant le CSS (les deux règles semblaient
  simplement regroupées), évident sur la capture. **Leçon générale : fusionner deux règles CSS qui se
  ressemblent n'est jamais un pur nettoyage — vérifier ce que CHACUNE déclarait avant de n'en garder qu'une,
  et regarder le rendu réel, pas seulement le fichier.**
  Régression : `node --test scripts/test-hardware-tier-preview-ui.mjs` (5 tests) — la vitesse affichée est
  bien celle d'Artificial Analysis pour chaque emplacement de palier, plus aucune mention "(estimé)", "—"
  quand rien n'est publié, et la légende existe en un seul exemplaire en nommant sa source. Les deux nouveaux
  tests ont été vérifiés en réintroduisant temporairement leur défaut (vitesse locale estimée remise, légende
  retirée) : chacun échoue bien seul. Capture du rendu compilé relue avant de livrer, pas seulement le JSX.

- **Étape 132, Léo : "on a un bon tableau avec score d'inteligence d'outils la les palier qu'on a, on a bien
  les meilleur model regarde bien"** — audit des 5 listes de candidats à l'aide du tableau désormais complet
  (fiabilité + Intelligence Artificial Analysis), suite directe de la question précédente sur `G9v3-3B`.
  **Trouvaille concrète, pas un simple "tout va bien"** : en vérifiant précisément ce modèle après ma
  réponse précédente ("à surveiller, pas à adopter"), j'ai découvert que `scripts/verified-tool-scores.md`
  contient DÉJÀ une ligne `hf.co/bartowski/ai9stars_G9v3-3B-GGUF | 6/6` — un score RÉEL, mesuré sur la
  machine de Léo le 12/09/2026 (présent dans `scripts/benchmark-models.mjs` comme candidat exploratoire
  depuis cette date), jamais promu dans `FLASH_CANDIDATES`/`MEDIUM_CANDIDATES` : un oubli, pas un choix
  délibéré. **Ma réponse précédente était donc incomplète, corrigée ici plutôt que laissée telle quelle** :
  je n'avais vérifié que la fiche Artificial Analysis (Intelligence Index 11, confirmé) et une bibliothèque
  Ollama tierce peu fiable (`schien/g9v3-3b`, 43 téléchargements) — sans chercher si ce modèle précis avait
  déjà été testé dans le dépôt lui-même par une session précédente, via l'import `hf.co/bartowski/...`
  (quantifieur reconnu de la communauté Ollama/llama.cpp, à partir du dépôt OFFICIEL ai9stars/G9v3-3B) —
  un mécanisme OFFICIEL d'Ollama, PAS le même risque que le réupload communautaire que j'avais écarté à
  raison. **Leçon générale : avant de juger un modèle "pas encore fiable", vérifier si le dépôt lui-même n'a
  pas déjà une mesure LOCALE vérifiée pour lui — `grep` du nom exact dans `verified-tool-scores.md` ET
  `benchmark-models.mjs`, pas seulement une recherche web externe.**
  Sur cette base vérifiée (6/6 en appel d'outils, Intelligence 11, 1,9 Go — plus léger ET meilleur sur les
  deux scores que `granite4.2:3b`, le meilleur candidat Rapide jusqu'ici), promu dans `FLASH_CANDIDATES` ET
  `MEDIUM_CANDIDATES` (même raisonnement que `granite4.2:3b`, déjà candidat dans les deux paliers). **Vérifié
  par une vraie simulation de `previewHardwareTiers()` avant de considérer ça fini** (pas seulement en
  relisant le code) : ce modèle gagne désormais le palier Rapide pour tout budget ≥ 1,9 Go, et le palier
  Médium pour tout budget entre 1,9 et 3,4 Go (en dessous de `qwen3.5:4b`) — sans changer aucun autre palier
  ni aucune machine déjà sur un budget plus large (`qwen3.5:4b`/`qwen3.5:9b` continuent de gagner Médium dès
  qu'ils tiennent, inchangé).
  **Reste du passage en revue** : aucune autre lacune trouvée dans Médium/Puissant/Vision/Code — les scores
  Artificial Analysis + fiabilité déjà en place départagent correctement partout ailleurs (vérifié par la
  même simulation, palier par palier), et la revue de familles majeures manquantes (étape 113/126) reste à
  jour à ce jour.
  Régression : `npm test` (401 tests, aucun cassé par cet ajout — `test-model-overview-sort.mjs` vérifie déjà
  que le plus petit candidat Rapide affiché reste `qwen3.5:0.8b`, toujours vrai puisque le nouveau candidat
  est plus gros que lui).

- **Étape 133, trois questions de Léo dans le même message après la promotion de G9v3-3B.**
  1. **"met pas ai9stars_G9v3-3B mais G9v3-3B"** — le nom de dépôt choisi par bartowski pour sa
     requantification GGUF embarque le nom de l'organisation d'origine ("ai9stars_G9v3-3B-GGUF"),
     que l'algorithme générique de `formatModelName.ts` (qui ne fait que retirer le suffixe "-GGUF") ne peut
     pas deviner être un préfixe à couper — un modèle appelé légitimement "Org_Quelquechose" existe tout
     aussi bien. Corrigé par une table d'exceptions EXPLICITE (un identifiant exact -> son nom d'affichage),
     jamais une règle générique ("retirer tout ce qui précède un underscore") qui couperait mal un futur
     import au nom légitimement composé d'un underscore. Première fois que `formatModelName` a un vrai test
     de régression (`scripts/test-format-model-name.mjs`) — jusqu'ici jamais testé directement.
  2. **"pourquoi je voit que 4 palier pas 9"** — pas un bug d'affichage, la conjonction de deux causes
     réelles, vérifiées par une vraie simulation de `previewHardwareTiers()` (pas devinée) :
     - Le relèvement de `RESOURCE_SAFETY_MARGIN_GB` (8 -> 16 Go, une session précédente, pour empêcher un
       modèle Puissant de saturer la RAM d'un ami de Léo) avait DÉJÀ fait chuter le nombre de paliers
       distincts de ~11 à 7 sur une machine simulée avec les mêmes 32 Go de RAM que Léo — un effet de bord
       jamais remarqué jusqu'ici, silencieux puisqu'aucune erreur ne peut signaler "moins de lignes que
       prévu".
     - La promotion de G9v3-3B (ce message) a réduit encore la diversité dans la tranche basse de VRAM : il
       gagne maintenant Rapide ET Médium simultanément sur une large plage, là où deux modèles différents se
       partageaient ces deux paliers avant — le mécanisme de fusion des lignes consécutives strictement
       identiques (`previewHardwareTiers`, déjà en place et voulu par Léo lui-même à une étape antérieure
       pour éviter des doublons visuels) en absorbe donc plusieurs de plus.
     Le nombre de paliers n'a jamais été un compte FIXE (contrairement au minimum de 4 crans du curseur de
     contexte) : il varie avec la qualité réelle des candidats connus — moins de paliers ici, précisément
     parce qu'un même modèle est maintenant le meilleur choix sur une plage plus large, pas un défaut.
     **Non vérifiable ici avec certitude à l'exact chiffre 4 de Léo** (le compte dépend aussi de son propre
     `benchmark-results.md` local, invérifiable depuis cet environnement) : le mécanisme est prouvé et
     honnête, sa valeur exacte chez lui ne l'est que par lui.
  3. **"pour mon palier on a changer de model comment on fait ça me réinstalle pas les nouveaux model direct
     et désinstalle l'ancien"** — un vrai gap trouvé en lisant le code plutôt que deviné : `runQuickSetup`
     (le chemin RAPIDE de "Retester la configuration", Options → Modèles) téléchargeait bien les nouveaux
     modèles choisis, mais ne supprimait JAMAIS ceux qu'ils remplacent — contrairement à `runModelAnalysis`
     (l'analyse comparative complète), qui a TOUJOURS eu ce nettoyage (`cleanupUnselectedModels` + un
     nettoyage dédié pour le modèle vision). Le mécanisme existait déjà dans le même fichier, jamais repris
     dans le chemin le plus emprunté (celui que "Retester la configuration" utilise) : même famille d'oubli
     que G9v3-3B, jamais promu malgré un score déjà vérifié.
     Corrigé en comparant, pour chacun des 5 rôles (Rapide/Médium/Puissant/Vision/Code), l'ANCIEN modèle du
     profil au NOUVEAU choix : si le nouveau a bien été téléchargé (pas dans `skippedModels`) et diffère de
     l'ancien, ET que l'ancien n'est utilisé par AUCUN autre rôle (ex: un même modèle repli sur Médium ET
     Puissant), l'ancien est supprimé via `deleteModel` (API HTTP `DELETE /api/delete` d'Ollama, déjà utilisée
     ailleurs) — jamais avant confirmation que le nouveau est bien là, pour ne jamais laisser un palier sans
     AUCUN modèle installé si le téléchargement du remplaçant échoue (VRAM/disque insuffisant).
     Un échec de suppression individuel (verrou antivirus, Ollama déjà occupé...) est journalisé en clair
     mais n'interrompt jamais le reste du run — même discipline que le reste de ce fichier pour tout ce qui
     n'est pas strictement nécessaire à la réussite globale.
     Répond littéralement à "comment on fait ça" : cliquer sur Options → Modèles → "Retester la
     configuration" (ou attendre le popup "nouveaux modèles disponibles" qui y renvoie déjà) suffit
     maintenant à la fois pour installer le nouveau ET désinstaller l'ancien, sans étape manuelle
     supplémentaire.
     Régression : `node --test scripts/test-benchmark-runner-cleanup.mjs` (5 cas : remplacement simple,
     modèle partagé entre deux rôles jamais supprimé, nouveau modèle ignoré -> ancien gardé sur le disque,
     aucun profil existant -> rien à supprimer, échec de suppression journalisé sans interrompre le run).
     Chacun vérifié en retirant temporairement le correctif : 2 des 5 échouent alors, confirmant qu'ils
     mordent vraiment.
  Régression complète : `npm test` (410 tests, 0 échec).

- **Étape 135, Léo : "je veut que les models soit pareil pour le palier 1, je veut pas des model différent
  entre un palier 1 et un palier 1"** (répété après une première réponse à côté de la plaque). Vérifié par
  simulation : à VRAM égale, Rapide/Médium étaient déjà identiques partout, mais Puissant/Code dépendaient
  de la RAM de la machine qui regarde (débordement RAM de `LARGE_RAM_OFFLOAD_MODELS`) — et comme leurs
  seuils entrent dans la liste des frontières, le NOMBRE et le CONTENU des paliers changeaient avec la RAM
  (32 Go : 7 paliers, 64 Go : 4 paliers, même code). `previewHardwareTiers` utilise maintenant une RAM de
  référence fixe, `RESOURCE_SAFETY_MARGIN_GB` (à cette valeur exacte le débordement vaut 0, aucune nouvelle
  constante) : le tableau est identique sur toute installation d'une même version. Le TÉLÉCHARGEMENT réel
  (`pickBestModelsFromBenchmark`) garde la vraie RAM : Léo voulait un tableau comparable, pas renoncer au
  Puissant plus fort permis par sa RAM. Régression : `scripts/test-hardwarescan-preview-steps.mjs` (16 Go et
  64 Go produisent le même tableau ; le test de fusion qui reposait sur la RAM a été refait sans elle).
  Piège revécu : `vm.runInNewContext` + `assert.deepEqual` → "same structure but not reference-equal",
  contourné en comparant des chaînes JSON.
- **Étape 136, Léo : "Rajoute les 2 model car pour regler le bug chatgpt les a envlever"** — voir l'entrée
  "Un import direct hf.co/..." plus haut. G9v3-3B et GLM-4.6V-Flash remis dans leurs paliers avec leurs
  scores vérifiés ; le test qui interdisait tout `hf.co/` remplacé par un test qui exige leur présence.
  Régression : `scripts/test-benchmark-runner-cleanup.mjs` (échec hf.co → repli sur le suivant, profil jamais
  enregistré avec un modèle non téléchargé, message expliqué ; échec sur un tag Ollama → toujours levé).
  Vérifié en désactivant le repli : le test échoue bien. **Non vérifiable ici** : le vrai échec sur la
  machine de Léo avec Ollama 0.34.2 (pas de Windows ni d'Ollama dans cet environnement).

- **Étape 137, Léo : "a la place de plalier 1 2 3 on vas faire un palier personnaliser a chacun, il ya plus
  de palier jaris regarde la vram les apelle outils Intelligence (Artificial Analysis) et choisit le meilleur
  model pour rapide etc..."** — fin du système de paliers de comparaison (étapes 114-135 : une dizaine de
  lignes "Palier N" calculées à des VRAM hypothétiques, la machine repérée parmi elles). Le choix lui-même
  n'a PAS changé : `pickBestFrom` (hardwareScan.ts) faisait déjà exactement ce que décrit Léo (ce qui tient
  dans la VRAM, puis fiabilité d'appel d'outils, puis Intelligence Artificial Analysis, puis taille). Seul
  l'affichage change : `getMyModelPicks` (remplace `previewHardwareTiers`/`previewVramSteps`/
  `previewLabelFor`, type `MyModelPicks` au lieu de `HardwareTierPreview`, canal IPC `getMyModelPicks`)
  renvoie le choix pour la VRAM ET la RAM réellement détectées, via le MÊME `computeModelPicks` que ce qui
  est téléchargé — ce qui s'affiche est donc toujours ce qui est installé (vérifié par un test sur plusieurs
  VRAM). `MyModelPicks.tsx` (remplace `HardwareTierPreview.tsx`) : une seule carte, matériel détecté + un
  modèle par rôle avec ses scores, sur l'écran d'accueil et dans Options → Modèles. La RAM de référence fixe
  de l'étape 135 disparaît avec les paliers : elle n'existait que pour rendre la liste identique d'un PC à
  l'autre ; un choix personnalisé doit au contraire tenir compte de la vraie RAM (débordement de Puissant/
  Code). CSS des flèches/badge/numéro de palier retiré, textes "tableau des paliers" reformulés (grep des
  chaînes visibles, pas seulement des identifiants). Relu sur capture : le titre "Choisis pour ta machine"
  se lisait comme un impératif, remplacé par "Modèles choisis pour ta machine". Régression :
  `scripts/test-hardwarescan-my-picks.mjs` (affiché = téléchargé, vraie RAM prise en compte, matériel non
  inventé) et `scripts/test-my-model-picks-ui.mjs` (une seule carte, aucun "Palier", scores libellés, "—"
  si non publié, pas de débordement à 560 px).

- **Étape 138, Léo : "dans le palier rapide j'ai G9v3-3B mais il utilise pas G9v3-3B ça a rien telecharger
  et sa a pas supprimer l'ancien model rapide ni telecharger"** — deux défauts de MON travail des étapes
  136-137, trouvés en relisant le chemin complet plutôt que le seul calcul : (1) avec Ollama 0.34.2, le
  téléchargement de G9v3-3B échoue, le repli de l'étape 136 retombe sur le modèle suivant — qui était DÉJÀ
  l'ancien modèle Rapide, donc rien téléchargé, rien supprimé — et le message qui l'expliquait ne partait que
  dans le journal `onLine`, que l'onglet Options n'affiche pas ; (2) la carte de l'étape 137 montrait le
  modèle IDÉAL (`computeModelPicks`) et non celui du PROFIL (celui que Jaris utilise réellement), alors que
  je l'avais présentée comme "ce qui s'affiche est ce qui est installé" — vrai seulement juste après un
  retest réussi. Corrigé : `getMyModelPicks(profile)` affiche pour chaque rôle le modèle du profil, et signale
  à part (`upgrades`) le meilleur choix quand ce n'est pas lui, avec la raison s'il est bloqué ;
  `runQuickSetup` mémorise les imports bloqués dans `profile.blockedModels` (oubliés dès qu'un téléchargement
  du même modèle réussit) et les renvoie (`blockedModels`, affiché aussi en fin d'installation). Relu sur
  capture : la raison brute ("pull model manifest: blocked redirect...") faisait quatre lignes illisibles
  pour Léo — remplacée par une phrase courte, l'erreur brute restant dans le journal. **Leçon générale : une
  carte qui dit "ce que Jaris utilise" doit lire la source que Jaris utilise VRAIMENT (le profil), pas
  recalculer ce qu'il devrait utiliser — et un repli silencieux n'est acceptable que si l'écran que
  l'utilisateur regarde le dit.** Régression : `test-hardwarescan-my-picks.mjs` (profil affiché, meilleur
  signalé, raison de blocage), `test-benchmark-runner-cleanup.mjs` (blocage mémorisé puis oublié),
  `test-my-model-picks-ui.mjs` (ligne sous le rôle concerné). **Non vérifiable ici** : l'échec réel sur la
  machine de Léo ; G9v3-3B ne sera réellement utilisé qu'une fois Ollama 0.34.3 sorti en version stable.

- **Étape 139, Léo : "oui" (au contournement pour que G9v3-3B soit VRAIMENT utilisé malgré Ollama 0.34.2)** —
  `electron/services/huggingFaceImport.ts`, appelé par `pullModelIfMissing` (ollama.ts) quand `ollama pull
  hf.co/...` échoue pour une autre raison qu'un manque de place : Jaris refait le pull lui-même — manifeste du
  registre Ollama de Hugging Face, envoi de chaque GGUF (modèle + projecteur de vision) directement de
  Hugging Face vers Ollama (`POST /api/blobs/<sha256>`, en flux, sans fichier temporaire), puis `POST
  /api/create` sous le même nom avec le gabarit et les paramètres du manifeste. Cause racine VÉRIFIÉE, pas
  supposée : `https://hf.co/v2/...` répond 307 vers `https://huggingface.co/v2/...`, redirection entre hôtes
  que 0.34.2 bloque. Comportement de `/api/create` vérifié dans le CODE SOURCE d'Ollama (server/create.go :
  plusieurs GGUF acceptés, projecteur reconnu par `isProjectorGGUF`), la doc officielle ne le disant pas.
  **Vérifié de bout en bout ICI, pour la première fois sur ce dépôt avec un vrai Ollama** : binaire Linux
  officiel d'Ollama 0.34.2 lancé sur un port isolé → bug reproduit à l'identique (`blocked redirect to a
  different host`) → import réel de G9v3-3B (1,9 Go) et GLM-4.6V-Flash (6,2 Go + 1 Go de projecteur) →
  couches installées identiques au manifeste Hugging Face (modèle, projecteur, gabarit ; paramètres identiques
  au contenu près de l'échappement JSON) → VRAI appel d'outil `open_app({app_name: "Google Chrome"})` avec
  G9v3-3B, VRAIE description d'image ("un carré rouge et un cercle bleu") avec GLM-4.6V-Flash, et parcours
  complet `pullModelIfMissing` (échec du pull → import → installé ; second appel en 4 ms). **Deux défauts
  trouvés par cette vérification réelle, jamais visibles en relecture** : (1) une coupure réseau à 70 % d'un
  fichier de 6 Go faisait tout recommencer — reprise ajoutée (en-tête HTTP Range, jusqu'à 5 fois, dans le
  même flux envoyé à Ollama, qui revérifie l'empreinte à la fin) ; (2) `pullModelIfMissing` ne reconnaissait
  pas un modèle sans tag listé `:latest` par Ollama et le retentait à chaque retest — corrigé (`withTag`).
  Le test a aussi trouvé que `hf.co/../etc` passait la validation (`..`) : resserrée. Message d'état raccourci
  (l'erreur brute d'Ollama contenait une URL de plusieurs centaines de caractères). **Leçon générale : quand
  un outil tiers peut tourner dans l'environnement de dev (ici le binaire Linux d'Ollama), le lancer pour de
  vrai vaut mieux que n'importe quel mock — deux des trois défauts de cette étape n'existaient pas dans les
  mocks.** Régression : `node --test scripts/test-huggingface-import.mjs` (nom/tag, modèle seul, modèle +
  projecteur, fichier déjà présent jamais retéléchargé, fichier corrompu jamais installé, trop gros refusé
  avant téléchargement, coupure reprise sans tout recommencer). **Non vérifiable ici** : la même chose sous
  Windows chez Léo.

- **Étape 140, Léo : "Je clique sur une nouvelle detection, et ça fait rien ça charge" puis "je veut etre sur
  que les model visbile sont réel et pas un autre model"** — (1) le retest d'Options télécharge parfois
  plusieurs Go (G9v3-3B : 1,9 Go, via l'import de l'étape 139), mais son avancement ne partait que sur le canal
  `modelBenchmarkLine`, qu'Options n'écoutait pas : le bouton restait sur "Nouvelle détection en cours..."
  sans rien montrer — même famille que l'étape 98 (toute action longue doit dire où elle en est). La
  dernière ligne d'avancement s'affiche maintenant sous le bouton. (2) La carte compare ce qu'elle affiche à
  la liste RÉELLE d'Ollama (`/api/tags`, `installCheck` dans `getMyModelPicks`) : "✓ Vérifié auprès d'Ollama"
  seulement si les 5 modèles sont vraiment installés, un rôle dont le modèle manque est signalé en rouge,
  les modèles installés mais utilisés par AUCUN rôle sont listés avec un bouton Supprimer (confirmation dans
  la ligne ; nom revérifié côté main par `isUnusedInstalledModel` avant tout effacement — un modèle utilisé
  n'est jamais supprimable, quoi que demande l'interface). Ollama injoignable : `null`, la carte dit
  "impossible de vérifier" au lieu de prétendre quoi que ce soit. Comparaison tolérante au `:latest"
  qu'Ollama ajoute aux noms sans tag. Piège attrapé par la suite de tests : un faux pont preload existant
  (Options) ne fournissait pas le nouveau champ, et la carte plantait sur une valeur ABSENTE — corrigé des
  deux côtés (faux pont complété, composant robuste à `undefined`), leçon déjà notée ici pour les canaux IPC
  et qui vaut aussi pour les CHAMPS ajoutés à une réponse existante. Régression :
  `test-hardwarescan-my-picks.mjs` (+5 cas) et `test-my-model-picks-ui.mjs` (+4 cas).

- **Étape 141, Léo : "ajoute dans chat code vocal, la possibilité de choisir le model ou faire auto, comme se
  qui se passe maintenant".** Un sélecteur de modèle par mode : dans la barre du champ de saisie du Chat et du
  mode Code (à côté de la pièce jointe, comme chez Claude/ChatGPT), et sous l'astuce de l'écran vocal. "Auto"
  = le comportement d'avant, STRICTEMENT inchangé (paliers Rapide/Médium/Puissant en Chat/Vocal,
  `profile.codeModel` en Code). Choix enregistré par mode dans `profile.modelChoices` — le choix du Chat ne
  s'applique pas à la voix, chacun a le sien.
  **Logique pure et testée à part** (`electron/services/modelChoice.ts`, aucun accès à Ollama ni au disque) :
  main.ts, assistant.ts et codeGenerator.ts lui passent la liste des modèles installés qu'ils ont déjà. Le
  nom choisi vient du renderer, donc il est revérifié côté main contre la liste RÉELLE d'Ollama avant d'être
  enregistré ; un modèle d'embedding n'est jamais proposé (il ne sait pas discuter). Un choix dont le modèle a
  été supprimé depuis retombe sur Auto (avec une ligne de journal) au lieu de faire échouer chaque réponse
  avec "modèle introuvable" — Léo n'aurait aucun moyen de comprendre pourquoi Jaris ne répond plus.
  **Un choix à la main n'est jamais défait en silence** : pas de repli VRAM automatique, pas de bascule vers
  le palier Médium après un appel d'outil — c'est un choix explicite. Le palier garde seulement son rôle pour
  l'effort de réflexion.
  **Piège évité en faisant le tour de ce qui SUPPRIME des modèles (leçon de l'étape 112 : lister tous les
  appelants)** : trois chemins effacent des modèles "inutilisés" — le nettoyage du retest (`runQuickSetup`),
  celui de l'analyse complète (`cleanupUnselectedModels`) et le bouton Supprimer de la carte des modèles
  (`isUnusedInstalledModel`). Aucun ne connaissait les choix à la main : un modèle choisi pour le Chat aurait
  été proposé à la suppression, ou effacé au prochain retest, sans prévenir. Les trois le comptent maintenant
  comme utilisé.
  **Défaut d'affichage trouvé par le test navigateur, pas en relecture** : Ollama liste un modèle sans tag
  sous `:latest`, donc G9v3-3B redevenait "ai9stars_G9v3-3B (latest)" dans la liste — `formatModelName`
  retire désormais `:latest` avant tout. Et la règle globale `select { ... !important }` (index.css) donnait
  au sélecteur un cadre plein de champ de saisie, aussi lourd que le bouton d'envoi : exclu de cette règle,
  comme `.composer__input`, vérifié par MESURE du style calculé.
  Régression : `test-model-choice.mjs` (9 cas), `test-assistant-history.mjs` (+5 : choix appliqué en Chat et
  en Vocal séparément, gardé après un appel d'outil, retour à Auto si supprimé), `test-codegen-generate.mjs`
  (+3), `test-hardwarescan-my-picks.mjs` et `test-benchmark-runner-cleanup.mjs` (+1 chacun : jamais supprimé),
  `test-model-picker-ui.mjs` (vrai navigateur : placement dans la barre, noms lisibles, VRAI identifiant
  envoyé, style discret). Chaque groupe vérifié en retirant temporairement le correctif correspondant.
  **Non vérifié ici** : le rendu du sélecteur sur l'écran vocal (même composant, capture faite seulement pour
  le Chat) et la liste native déroulée sous Windows — à confirmer par Léo.

- **Étape 142, Léo : "peut tu faire en sorte de pouvoir choisir le dossier où mettre Jaris quand tu
  l'installes la première fois car tu peux pas choisir".** L'installeur était "un clic" depuis l'étape 16
  (`oneClick: true`) : aucun écran, toujours `%LOCALAPPDATA%\Programs`. Dans electron-builder, seul
  l'installeur ASSISTÉ a l'écran "Dossier d'installation" (`oneClick: false` +
  `allowToChangeInstallationDirectory: true`). Il affiche aussi "Pour moi seulement / Pour tous les
  utilisateurs" (vérifié dans les gabarits NSIS d'app-builder-lib 26.15.3, `assistedInstaller.nsh` :
  `PAGE_INSTALL_MODE` n'est retiré qu'avec `perMachine: true`, qui imposerait l'UAC à chaque mise à jour) —
  gardé `perMachine: false`, "pour moi seulement" reste le choix par défaut, sans UAC.
  **Le piège évité, lu dans les gabarits avant de coder** : l'assistant se serait rouvert à CHAQUE mise à jour,
  puisque `updateApp` (appUpdater.ts) lançait l'installeur sans arguments — et il ne relance Jaris à la fin
  qu'avec une case à cocher. Les mises à jour passent maintenant `/S --updated --force-run` : silencieuses,
  dans le dossier déjà choisi (`InstallLocation`, relu dans le registre par `multiUser.nsh`), écran du
  dossier sauté (`skipPageIfUpdated`), Jaris relancé (`isForceRun` + `Silent` dans `installSection.nsh`).
  **Transition assumée** : une version ≤ 0.15.51 lance encore le nouvel installeur SANS arguments, donc la
  toute première mise à jour vers 0.15.52 montre l'assistant une fois (dossier actuel proposé par défaut) ;
  les suivantes sont silencieuses.
  Régression : `test-installer-config.mjs` (config assistée + arguments silencieux) et `test-app-updater.mjs`
  (arguments réellement passés au lancement), vérifiés en remettant l'ancienne config.
  **Non vérifiable ici (pas de Windows)** : le vrai déroulé de l'assistant et d'une mise à jour silencieuse —
  à confirmer par Léo.

- **Étape 143, Léo : "si il choisit dès l'installation le D tout est dans le D, ou si il veut changer dans
  les options ça doit tout déplacer, jamais une partie".** Inventaire fait AVANT de coder de tout ce que Jaris
  écrit sur C (grep de `LOCALAPPDATA`/`APPDATA`/`USERPROFILE`/`tmpdir()`/`getPath(`) : ses données, le cache
  interne de Chromium, les modèles, le programme ET les données d'Ollama (journaux + mises à jour de 1,5 Go,
  docs.ollama.com/windows), Python, le cache vocal, Docker, et les installeurs téléchargés dans %TEMP%.
  **Une racine unique** (`storageRoot.ts`) : le dossier choisi dans « Déplacer », ou — si le PROGRAMME est
  installé sur un autre disque que celui de Windows — `Jaris-data` à côté du dossier du programme (jamais
  dedans : chaque mise à jour efface le dossier du programme). Seul un fichier-repère reste dans %APPDATA%\Jaris.
  Le module s'exécute à son chargement, importé EN PREMIER dans main.ts : `app.setPath('userData')` (cache de
  Chromium) n'est pris en compte qu'avant `ready` et avant le verrou d'instance unique, et les stores calculent
  leur chemin à leur chargement — un test vérifie cet ordre d'import.
  **Tout ou rien** (`relocation.ts` + `modelsLocation.ts`), à la place de l'ancien "un échec isolé n'empêche
  pas les autres" : (1) vérifications sans rien toucher (place libre, Docker, installeur du programme
  téléchargé), (2) copie de tout, (3) bascule de tout — chaque dossier d'origine renommé en `.jaris-old` puis
  remplacé par une jonction, défait dans l'ordre inverse au moindre échec —, (4) effacement des anciens
  emplacements seulement à la fin. **Au démarrage**, ce qui n'est pas encore dans la racine y est rangé
  (`reconcileStorage`), AVANT de lancer Ollama et la voix : sur une machine neuve les jonctions existent
  avant qu'Ollama/Python ne s'installent, donc ils s'installent directement sur D ; un Ollama installé plus
  tard sur C est rapatrié (même leçon qu'à l'étape 103 : constater l'état réel au démarrage).
  **Piège trouvé en lisant le code d'installation de Python** : il faisait `rm(dossier)` puis `mkdir` —
  effacer une jonction puis recréer le dossier l'aurait remis sur C sans prévenir. Il vide maintenant le
  CONTENU. Même précaution pour retirer une jonction : `unlink`, jamais `rm -r` (qui viderait sa cible).
  **Docker** ne se redirige pas par jonction (programme machine + disque WSL enregistré) : installé avec les
  indicateurs officiels `--installation-dir` et `--wsl-default-data-root` (docs.docker.com, vérifié) ; déjà
  installé ailleurs, il est désinstallé (commande officielle, une autorisation Windows) puis réinstallé dans
  la racine au prochain besoin. Désinstaller EFFACE son contenu : refus du déplacement ENTIER, avant d'avoir
  touché à quoi que ce soit, si Docker contient autre chose que la recherche web de Jaris.
  **Le programme Jaris** ne peut pas se déplacer pendant qu'il tourne : son installeur (même version,
  téléchargé AVANT toute modification) le réinstalle après fermeture avec `/S --updated --force-run /D=…` —
  `/D=` l'emporte sur le dossier enregistré (gabarit `multiUser.nsh`), doit être le DERNIER argument sans
  guillemets (règle NSIS), d'où `windowsVerbatimArguments`. L'ancien dossier est effacé par l'installeur.
  **Garde-fou qui a mordu pendant l'écriture** : `test-ollama-update-progress.mjs` interdit tout
  `downloadToFile` sans avancement — mon téléchargement de l'installeur n'en avait pas.
  **Piège de sécurité évité** : une première version passait un script PowerShell encodé (`-EncodedCommand`)
  à une élévation administrateur pour effacer aussi les restes de Docker dans ProgramData — bloquée, à raison :
  un script opaque exécuté en administrateur est exactement ce qu'on ne veut jamais lire dans ce dépôt. Seul le
  désinstalleur officiel est élevé (chemin passé par variable d'environnement) ; les restes machine de Docker
  (quelques Mo dans ProgramData) sont laissés et dits tels quels.
  **Restent forcément sur C** : le fichier-repère, les raccourcis et entrées de registre de Windows, WSL
  lui-même (composant de Windows), les réglages machine de Docker, et un Docker installé sur C avant le choix
  de D tant que « Déplacer » n'est pas utilisé.
  Régression : `test-relocation.mjs` (tout ou rien de bout en bout sur un vrai dossier : Docker refusé,
  désinstallation refusée, dossier interdit, hors Windows), `test-models-location.mjs` (les 5 dossiers, bascule
  défaite en entier sur le 4e échec, copie ratée sans effet, second déplacement, machine neuve),
  `test-data-location.mjs` (démarrage, ancien repère, disque débranché jamais recréé vide, nettoyage),
  `test-docker-location.mjs`. Chaque garde-fou vérifié en le retirant temporairement.
  **Non vérifiable ici (pas de Windows)** : les vraies jonctions NTFS avec Ollama/Inno Setup, la
  désinstallation de Docker, la réinstallation du programme par `/D=` — à confirmer par Léo.
  **La CI (Windows) a refusé le premier envoi : deux de MES tests, écrits sous Linux, supposaient `/` comme
  séparateur** (une regex sur `D:/Jaris-data`, et un faux `isInside` en `startsWith(p + '/')`). Le code, lui,
  était juste — et le vrai garde-fou a même tenu sous Windows (copie refusée, « rien n'a été déplacé »).
  **Leçon générale : un test qui manipule des chemins doit passer par `path` (join/relative/sep), jamais par
  un `/` écrit en dur — le dépôt se teste sous Linux ici mais la CI tourne sous Windows.**

- **Suite de l'étape 143, trouvé en revérifiant pour répondre à Léo ("tout se déplace pour être sûr ?") :
  pip gardait une copie de chaque paquet dans `%LOCALAPPDATA%\pip\cache`** — sur C quoi qu'on ait choisi,
  torch en tête (~2,5 Go). Absent de l'inventaire initial parce que ce chemin n'apparaît nulle part dans le
  code de Jaris : c'est pip lui-même qui le décide. Corrigé par `--no-cache-dir` sur toutes les installations
  pip (`PIP_INSTALL`, pythonRuntime.ts), verrouillé par un test. Un cache pip DÉJÀ présent sur C n'est pas
  effacé : il peut servir à d'autres programmes Python que Jaris. **Leçon générale : un inventaire de « ce
  que Jaris écrit » fait par grep dans le code de Jaris rate ce que ses OUTILS écrivent d'eux-mêmes (caches
  de pip, de navigateurs, journaux) — passer aussi en revue chaque outil lancé et ses emplacements par défaut.**
  Restent aussi sur C, minuscules : les clés et l'historique d'Ollama (`%USERPROFILE%\.ollama`, hors
  `models`), les notes temporaires du Bloc-notes (%TEMP%).

- **Étape 144, Léo : "on voulait un design science-fiction et la cible c'était les personnes fortes en
  informatique, mais on change : je veux un design rassurant, car Jaris va être une application d'IA locale
  facile à installer, pour les personnes qui ne sont pas fortes en informatique".** Deux choix posés à Léo
  en questions simples AVANT de coder (goût, pas technique) : fond **clair** ; et pour l'ancien cercle au bord
  irrégulier, **carte blanche pour une petite mascotte** ("Grok a une petite mascotte").
  **Thème « doux »** (index.css) : les tokens `--hud-*` deviennent `--ui-*` avec des valeurs claires (fond
  blanc cassé chaud, cartes blanches, texte gris foncé, UN bleu doux pour ce qui se clique, ambre/vert/rouge
  seulement pour le sens). La « couche HUD » de fin de fichier est remplacée par une « couche douce » qui
  réhabille les mêmes classes sans toucher à la mise en page : coins arrondis, ombres légères, pastilles —
  plus de coins coupés (`clip-path`), d'équerres lumineuses, de grille ni de ligne de balayage, de lueurs, de
  capitales espacées. Une seule police, **Nunito** (ronde, lisible), embarquée via @fontsource comme avant
  (Rajdhani/Barlow retirées des dépendances) : Jaris reste 100 % hors ligne. ~100 couleurs sombres écrites en
  dur converties en tokens (script de remplacement, puis revue des restes un par un).
  **La mascotte** (`JarisOrb.tsx`, même nom et MÊMES réglages que l'ancien orbe pour que tous les écrans
  suivent sans modification) : un petit personnage rond, visage clair, grands yeux, antenne ; dessiné en SVG
  (net de 24 à 320 px), animé en CSS : flotte et cligne au repos, antenne verte qui pulse quand il écoute,
  regard en l'air + petits points quand il réfléchit, sourire ouvert qui suit la voix quand il parle, yeux
  ronds quand il est surpris. Sous 48 px (widget replié), seul le visage reste. Elle accueille aussi les écrans
  de premier lancement (prénom, installation, configuration), et la même mascotte est dessinée pixel par
  pixel (`shared/mascotPixels.ts`) pour l'icône de l'application ET celle de la barre système — un seul dessin
  pour les deux, repris du SVG.
  **Défauts trouvés sur CAPTURES du vrai rendu compilé (banc Playwright de tous les écrans), pas en relecture** :
  (1) Chromium ne fait PAS hériter la police aux boutons — onglets et boutons restaient en police système au
  milieu de Nunito ; corrigé par `button, input, select, textarea { font-family: inherit }` ; (2) une ligne
  d'erreur de l'installation était devenue quasi invisible : `--ui-danger-soft` (fond rose pâle) servait de
  couleur de TEXTE, pensée pour l'ancien fond noir. **Leçon générale : changer de thème clair/sombre inverse le
  rôle des couleurs « pâles » — une couleur de texte lisible sur fond sombre devient un fond sur fond clair ;
  relire chaque usage `color:` des tokens pâles, pas seulement leurs valeurs.** (3) « Cerveau de Jaris » passait
  sur deux lignes et « Options » gardait seul l'ancienne pastille (bouton rendu par un autre composant).
  Textes rendus cohérents avec la mascotte (« clique sur le cercle » → « clique sur lui », statut au repos
  « Prêt à t'aider » au lieu de « Jaris dort… »), couleurs du Cerveau (graphe 3D) et du balayage d'écran
  adoucies, couleurs des 10 voix passées à des teintes moyennes (le visage blanc reste lisible dessus).
  Tests : 7 tests UI vérifiaient l'ANCIEN style (dégradé, coins coupés, Rajdhani, `canvas`) — réécrits pour
  vérifier la même intention (« habillé par le CSS de Jaris ») avec le nouveau. Nouveaux :
  `test-soft-theme.mjs` (garde-fou : échoue si un motif science-fiction revient ; icône = mascotte, vérifiée
  pixel par pixel) et `test-mascot-ui.mjs` (vrai navigateur : chaque humeur change le visage, petite taille
  lisible, couleur de voix, clic). Garde-fou vérifié en réintroduisant une règle de l'ancien thème.
  **Non vérifiable ici** : le rendu dans la vraie fenêtre Windows (police, widget transparent sur le bureau) —
  à confirmer par Léo. Les écrans n'ont pas été réorganisés : seul l'habillage change ; simplifier les textes
  et parcours pour le grand public est une étape à part.

- **Étape 145, Léo : la première mascotte « ça va pas », puis une image de référence « comme ça » : une bulle
  bleue brillante avec deux petits yeux blancs ovales, sans bouche ni antenne.** Mascotte redessinée d'après
  CETTE image plutôt qu'une nouvelle interprétation libre : la carte blanche de l'étape 144 avait donné un
  personnage que Léo n'a pas reconnu comme le sien, et une référence visuelle tranche mieux qu'une
  description. Même leçon que le widget et le sélecteur de voix (étapes 69-76) : un jugement de goût ne se
  devine pas, on le reprend tel qu'il est montré.
  `JarisOrb.tsx` garde exactement les mêmes réglages (`emotion`, `size`, `audioElRef`, `onClick`, `color`),
  donc aucun écran n'a changé. Sans bouche, les humeurs passent par les yeux et la lumière : halo qui pulse
  quand Jaris écoute, regard vers le haut et bulles de pensée quand il réfléchit, yeux plissés en « ^ ^ »
  quand il répond (la bulle gonfle au rythme de la voix), yeux agrandis quand il est surpris. En petit
  (widget replié, icône de la barre système), les yeux sont agrandis : à 24-32 px, deux ovales de taille
  normale ne font plus qu'un point.
  **Un seul dessin pour le composant et les icônes** : `shared/mascotPixels.ts` reprend au pixel près les
  formes et couleurs du SVG (même repère 120 × 120), vérifié en regardant l'icône 256 px, l'icône de la
  barre système 32 px et le widget réellement rendus, pas seulement les tests.
  Régression : `test-mascot-ui.mjs` (vrai navigateur : halo seulement à l'écoute, yeux « ^ ^ » en réponse,
  bulles de pensée, taille minimale sans ombre, couleur de voix sur la bulle, clic) et `test-soft-theme.mjs`
  (icône : bulle bleue, deux yeux blancs DISTINCTS, coins transparents). Le test du halo a été vérifié en le
  retirant du CSS : il échoue bien. **Non vérifiable ici** : le rendu dans la vraie fenêtre Windows.

- **Étape 146, Léo sur la v0.16.1 : « mets le mode dark, pas blanc » et « c'est une catastrophe, c'est moche,
  les yeux doivent bouger des fois, tu as fait un rond 3D moche » — avec deux captures de la bulle voulue.**
  1. **Mode sombre.** Le thème doux de l'étape 144 passe en sombre sans rien changer d'autre : c'est le jeu de
     tokens `--ui-*` qui change, pas les règles — la preuve que « un seul jeu de tokens, jamais de valeur en
     dur » (étape 144) paie. Fond gris-bleu très sombre (jamais du noir pur), cartes un cran plus claires.
     **Piège évité en passant en revue chaque usage plutôt qu'en inversant les couleurs** : `--ui-ink-rgb`
     servait À LA FOIS aux traits (qui doivent devenir clairs sur fond sombre) et aux ombres (qui doivent
     rester noires — une ombre claire sur fond sombre fait un halo). Nouveau token `--ui-shadow-rgb` pour les
     ombres, le fond du dialogue modal et le bouton des interrupteurs. Trois valeurs claires écrites en dur
     trouvées par grep : le survol des boutons (`#dde7fc`), les liens du Cerveau de Jaris (encre sombre,
     invisibles sur fond noir) et `backgroundColor` de la fenêtre dans main.ts (sinon un éclair blanc à
     chaque ouverture, avant que le CSS ne charge). L'aperçu du mode Code garde volontairement son fond blanc :
     il montre la page générée telle qu'elle s'affichera, pas l'habillage de Jaris.
  2. **La bulle, refaite d'après l'image cette fois vraiment regardée.** Agrandies, ses deux captures montrent
     un bleu vif presque UNI dont c'est le BORD qui s'illumine — pas un gros reflet blanc en haut à gauche ni
     un ombrage sombre en bas, ce que j'avais ajouté en « interprétant » une bulle brillante et qui donnait
     l'effet « rond 3D » rejeté. Dégradé inversé (cœur bleu, bord clair), liseré clair en haut, lueur douce
     autour, yeux plus grands et centrés. **Leçon générale : une image de référence de quelques dizaines de
     pixels doit être AGRANDIE et comparée côte à côte avec le rendu, jamais « comprise » puis redessinée de
     mémoire** — les détails qui font le style (d'où vient la lumière) disparaissent à la taille d'origine.
  3. **Les yeux bougent.** Les deux captures de Léo montraient d'ailleurs deux regards différents (centré, puis
     en haut à droite) : au repos, un groupe `jaris-mascot__gaze` jette un coup d'œil en haut à droite puis à
     gauche, par mouvements rapides suivis d'arrêts, indépendamment du clignement (deux groupes imbriqués,
     deux animations). À l'écoute, le regard reste fixé sur l'utilisateur ; en réflexion, il monte vers les
     bulles de pensée.
  L'icône de l'application et celle de la barre système (`shared/mascotPixels.ts`) suivent le même dessin,
  vérifiées en les regardant rendues sur fond sombre.
  Régression : `test-soft-theme.mjs` (mode sombre annoncé, fond sombre mais pas noir, contraste WCAG de chaque
  niveau de texte sur chaque surface, fenêtre ouverte directement sur le fond sombre, icône à deux yeux
  distincts) et `test-mascot-ui.mjs` (vrai navigateur : l'animation est figée à plusieurs instants pour
  prouver que le regard va à droite puis à gauche au repos, reste fixe à l'écoute et monte en réflexion).
  Vérifiés en figeant le regard et en remettant le fond blanc de la fenêtre : chacun échoue bien.
  **Non vérifiable ici** : le rendu dans la vraie fenêtre Windows.

- **Étape 147, Léo après la v0.16.2 : « remets comme avant, en fait tout le design ».** Les étapes 144 à 146
  (thème doux clair puis sombre, mascotte bulle) sont annulées d'un bloc par `git revert` de leurs trois
  commits, plutôt qu'une réécriture à la main : le thème science-fiction (HUD, orbe déchiqueté, Rajdhani/
  Barlow) revient exactement tel qu'il était en v0.15.54, sans risque d'en oublier un morceau. Vérifié avant
  d'annuler que ces commits ne contenaient QUE du design (textes d'accueil, couleurs des voix, icônes, CSS,
  polices) — aucune fonctionnalité des étapes 138-143 (choix du modèle, installation sur D, « Déplacer »
  tout ou rien) n'est touchée. Les entrées 144-146 de ce fichier restent : leurs leçons valent toujours.
  La version AVANCE (0.16.3) au lieu de revenir à 0.15.54 : la mise à jour automatique ne propose qu'une
  version plus récente, un retour à un ancien numéro ne serait jamais installé.
  **Leçon générale, après trois versions de design refusées d'affilée : une refonte visuelle complète se
  valide sur des captures AVANT d'être livrée** — une maquette montrée à Léo (quelques images) coûte bien
  moins qu'une version publiée puis annulée. Pour un prochain changement de design, envoyer les captures et
  attendre son accord avant le moindre commit.
  Régression : `npm test` (476 tests ; les deux tests propres au thème doux, test-soft-theme.mjs et
  test-mascot-ui.mjs, partent avec lui). Capture du rendu compilé : accueil vocal et Chat en thème HUD.

- **Étape 148, déplacement vers un nouveau disque : créer le parent AVANT d'ouvrir un WriteStream.**
  `relocateEverything` préparait l'installeur Jaris sous `<nouvelle racine>/downloads`, mais ce dossier
  n'existait pas encore. `createWriteStream` émettait `ENOENT` sans listener et faisait planter le
  processus principal Electron, au lieu de renvoyer un échec lisible. Le téléchargeur partagé crée désormais
  le dossier parent et intercepte les erreurs du flux. Tester le premier téléchargement dans une racine
  totalement neuve, pas seulement dans un dossier `downloads` précréé. Lors d'un déplacement complet,
  Docker doit aussi être réinstallé tout de suite avec ses chemins programme et données sur la nouvelle
  racine ; si cela échoue, le message final doit dire explicitement que cette partie reste à faire.

- **Étape 149, installation d'Ollama sur un autre PC : ne jamais remplacer l'échec réel par « installe-le
  depuis le site ».** Le premier lancement renvoyait un booléen et finissait sur une phrase générique,
  impossible de savoir si le téléchargement, l'ouverture de l'exécutable ou l'installeur avait échoué. Les
  options silencieuses sont bien celles du script officiel d'Ollama. Si elles échouent, rouvrir le MÊME
  installeur en mode visible (sans télécharger encore 1,5 Go), garder le code de sortie et le journal Inno
  Setup, puis afficher ces détails dans le message d'échec final. Un succès n'est pas prouvé par la seule
  sortie de l'installeur : relire aussi l'état réel de l'installation.

- **Étape 150, Ollama sur D : Inno Setup refuse une jonction Jaris créée sans élévation (code 448).**
  Le journal réel du PC de l'ami de Léo montre `RedirectionGuard status: Enabled in enforcing mode`,
  puis `CreateFile failed; code 448` en créant `%LOCALAPPDATA%\\Programs\\Ollama\\unins000.dat` : ce chemin
  était une jonction Jaris vers `D:\\Jaris-data\\ollama-app`. La documentation primaire d'Inno Setup confirme
  ce code et recommande d'éviter les traversées non fiables. Passer `/DIR=<vrai dossier sur D>` à
  l'installeur officiel (option documentée par le script d'Ollama) ; ne permettre
  `/NOREDIRECTIONGUARD` qu'après vérification de sa signature Ollama Inc. et un premier journal qui
  confirme encore le code 448 sur une autre jonction Jaris. Tester la suite exacte : premier essai sûr,
  reprise ciblée, puis fenêtre visible si nécessaire — sans second téléchargement.

- **Étape 151, choisir D: ne déplace pas le dossier TEMP des installeurs et de pip.**
  Le journal réel d'Ollama après installation sur D: montre encore un dossier temporaire sous
  `C:\\Users\\happy\\AppData\\Local\\Temp\\is-...`. Inno Setup documente que son chargeur se copie dans
  le TEMP de l'utilisateur ; pip décompresse aussi les grosses roues PyTorch dans son TEMP malgré
  `--no-cache-dir` (qui ne désactive que le cache persistant). Fournir `TEMP` et `TMP` pointant vers la
  racine Jaris sur D: aux sous-processus d'installation Ollama/Docker, et `TEMP`/`TMP`/`TMPDIR` au Python
  géré par Jaris. Ne pas modifier les variables globales de Windows. Une baisse du libre sur C: pendant
  l'installation doit être vérifiée aussi APRÈS la fin, car des fichiers temporaires sont effacés.

- **Étape 152, `wsl --install` ajoute Ubuntu par défaut alors que Docker n'en a pas besoin.**
  Les docs Microsoft confirment que la commande installe WSL ET Ubuntu, et `--no-distribution` évite la
  distribution ; les docs Docker confirment qu'il utilise sa propre distribution `docker-desktop` sans
  demander Ubuntu. Sur une machine où Jaris prépare Docker depuis zéro, toujours utiliser
  `wsl --install --no-distribution` (y compris dans le message de dépannage) pour éviter une distribution
  supplémentaire persistante sur C:. Ne jamais supprimer une distribution déjà présente sans vérifier
  à qui elle appartient : elle pourrait contenir les données de l'utilisateur.

- **Étape 153, Léo : la mise à jour échouait avec « Échec de désinstallation des anciens fichiers
  d'application. Veuillez réessayer d'exécuter l'installeur.: 2 ».** Cause lue dans le CODE de l'installeur
  d'electron-builder (node_modules/app-builder-lib/templates/nsis), pas devinée : pendant une mise à jour,
  l'ancien désinstalleur DÉPLACE chaque fichier du dossier du programme (`un.atomicRMDir`) et abandonne
  (`Abort` = code de sortie 2) au premier fichier qu'il ne peut pas déplacer ; le nouvel installeur réessaie
  5 fois puis affiche ce message. Le « 2 » veut donc dire : un fichier du dossier du programme est resté occupé
  par quelque chose qui survit à la fermeture de Jaris.
  En passant en revue tout ce que Jaris lance, un seul candidat restait accroché à ce dossier : le conteneur
  SearXNG (recherche web). `docker compose up` était lancé DEPUIS le dossier des ressources du programme,
  qui montait `./searxng` dans le conteneur, et ce conteneur tourne en permanence
  (`restart: unless-stopped` : relancé à chaque démarrage de Docker, même Jaris fermé). Découvert au passage,
  un second défaut : les deux programmes Python (écoute, synthèse vocale) n'étaient arrêtés que dans
  'window-all-closed', que `app.quit()` ne déclenche pas (mise à jour, croix, « Quitter ») — ils survivaient à
  Jaris, micro ouvert. Corrigé en trois endroits :
  1. `searxngHome.ts` : SearXNG vit dans le dossier de DONNÉES (sur le disque choisi, jamais dans le
     programme), sous un nom de projet Compose fixe (`jaris-searxng`) ; le programme ne sert plus que de modèle
     (docker-compose.yml et settings.yml recopiés s'ils ont changé). Au démarrage, un conteneur mal placé est
     retiré puis recréé au bon endroit, constaté sur un fait (l'étiquette
     `com.docker.compose.project.working_dir` que Docker pose sur le conteneur) : l'ancien projet
     `resources`, ou le projet actuel créé depuis un ancien dossier de données après un « Déplacer » — dont
     l'ancien dossier `searxng-docker`, que le conteneur empêchait d'effacer, est effacé à ce moment-là.
  2. `main.ts` : les deux programmes Python sont arrêtés dans 'before-quit'.
  3. `installer/jaris.nsh` (`nsis.include`) : l'installeur de la NOUVELLE version retire l'ancien conteneur
     et les Python orphelins AVANT de lancer l'ancien désinstalleur (`customInit`, dans `.onInit`). C'est lui
     qui débloque la mise à jour depuis une version déjà installée : le code de l'ancienne version ne peut
     plus être corrigé. Commandes en clair, sans élévation, et ciblées sur ce qui est à Jaris (service
     `searxng` du projet `resources` ; Python qui exécutent voice_server.py/tts_server.py, et seulement si
     Jaris est déjà fermé). **Piège évité** : `customCheckAppRunning`, qui semblait le crochet naturel, fait
     disparaître l'inclusion de getProcessInfo.nsh et la variable `$pid` dont le contrôle par défaut a
     besoin (`!ifmacrondef customCheckAppRunning` dans allowOnlyOneInstallerInstance.nsh) — `customInit`
     n'a aucun effet de bord de ce genre. Compilé ici avec le makensis Linux d'electron-builder en
     `-WX` (avertissements = erreurs) ; la syntaxe PowerShell des deux commandes est vérifiée par le vrai
     analyseur PowerShell dans la CI Windows.
  **Honnêteté sur ce qui est prouvé** : le mécanisme du code 2 est prouvé par le code source de l'installeur ;
  que ce soit bien le conteneur qui tenait le fichier chez Léo est la cause la mieux étayée (seul processus
  lié au dossier du programme qui survit à Jaris), pas une mesure faite sur sa machine. Si l'erreur revenait
  avec cette version, quitter Docker Desktop avant de relancer la mise à jour trancherait.
  Régression : `node --test scripts/test-searxng-home.mjs` (SearXNG jamais lancé depuis le programme, ancien
  conteneur retiré et recréé, conteneur bien placé jamais recréé, ancien dossier effacé après un « Déplacer »,
  identifiants filtrés avant d'être réinjectés dans une commande, nettoyage de l'installeur présent et ciblé,
  syntaxe PowerShell sous Windows) et `scripts/test-quit-blur-guard.mjs` (arrêt des Python dans
  'before-quit'). Chaque assertion clé a été vérifiée en réintroduisant son défaut.
  **Trouvé en intégrant les commits poussés entre-temps par un autre outil (Codex, v0.16.4 à v0.16.9)** : 21
  tests navigateur (Chat, mode Code, image jointe) échouaient depuis le passage du sélecteur de modèle aux
  « rôles » — `info?.roles.map(...)` plantait quand la réponse n'avait pas de liste `roles` (faux ponts des
  tests plus anciens), et le composant ne se montait plus. La CI était pourtant verte : **ces tests sont
  IGNORÉS sur le runner Windows, où Playwright n'est pas installé** (skip explicite, étape 91). Rendu tolérant
  (`(info?.roles ?? []).map`), et le test du code 448 (`test-first-run-setup.mjs`) utilise désormais les
  chemins Windows quel que soit le système. **Leçon générale : une CI verte ne dit rien des tests qu'elle
  ignore — avant de pousser, lancer `npm test` là où Playwright existe (cet environnement) et lire le nombre
  de tests ignorés, pas seulement le mot « pass ».**

- **Étape 154, Léo (capture de Paramètres → Applications installées, filtre « C: ») : « tu peux voir Jaris
  sur le C, mais tout est dans le D ».** Sa liste Options → Modèles montrait pourtant chaque morceau sur D, le
  programme compris. Cause lue dans les modèles NSIS d'electron-builder, pas devinée : `registryAddInstallInfo`
  n'écrit `InstallLocation` que dans la clé propre à l'application (`Software\<appId>`), jamais dans la clé
  `…\CurrentVersion\Uninstall\…` que Windows lit pour lister les applications ; sans elle, Paramètres les range
  d'office sur le disque système. Seul l'AFFICHAGE était faux : les 355 Mo indiqués sont la taille estimée du
  programme (`EstimatedSize`), physiquement sur D. Corrigé par une macro `customInstall` (installer/jaris.nsh)
  qui écrit aussi `InstallLocation` dans la clé Uninstall, après `registryAddInstallInfo` ; la clé entière
  est déjà supprimée à la désinstallation. **Leçon générale : avant de chercher des fichiers égarés sur C,
  vérifier d'où vient le chiffre affiché — une liste de Windows peut ranger une application sur un disque
  d'après une valeur de registre absente, sans rien mesurer sur le disque.** Non vérifiable ici : le rendu
  exact dans Paramètres (à confirmer par Léo après la mise à jour ; l'entrée se met à jour à l'installation).
  Régression : `scripts/test-searxng-home.mjs` (macro présente et ciblée) ; compilé avec le makensis
  d'electron-builder en `-WX`.

- **Étape 155, Léo : « si je regarde le dernier fichier téléchargé : C:\Users\happy\.cache\supertonic3\onnx\
  vector_estimator.onnx — Supertonic, c'est pas Jaris ? ».** Si : c'est la voix de Jaris, et elle échappait
  au « tout sur D ». Vérifié dans le CODE de la bibliothèque réellement figée (`supertonic==1.3.1`, roue
  téléchargée et lue, pas supposé) : `get_model_cache_dir` range le modèle dans `~/.cache/<cache_dir>` du
  modèle par défaut (`DEFAULT_MODEL = "supertonic-3"` -> `supertonic3`), ou dans `SUPERTONIC_CACHE_DIR` s'il
  est défini — jamais dans le cache HuggingFace que Jaris déplaçait déjà. La liste des dossiers déplacés
  (`bricks()`, modelsLocation.ts) avait été établie d'après le seul cache HuggingFace, qu'on croyait commun à
  la transcription ET à la synthèse vocale.
  Corrigé en ajoutant `%USERPROFILE%\.cache\supertonic3` comme dossier déplacé (jonction), plutôt qu'en
  définissant `SUPERTONIC_CACHE_DIR` : la variable ne déplacerait pas le modèle DÉJÀ téléchargé sur C
  (il serait retéléchargé à côté, et l'ancien resterait), alors que la réconciliation du démarrage
  (`reconcileStorage`, avant le lancement de la voix) déplace l'existant tout ou rien, comme les autres ; et
  la variable s'appliquerait à tous les modèles Supertonic à la fois, avec les mêmes noms de fichiers d'un
  modèle à l'autre — un changement de modèle pourrait alors relire les fichiers de l'ancien. Le nom du
  dossier dépend de la version de Supertonic : un test échoue si requirements.txt change de version, pour
  forcer à revérifier ce nom.
  **Leçon générale : pour savoir où un logiciel écrit, lire SON code (sa fonction de chemin de cache), jamais
  supposer qu'il suit la convention d'un voisin** — ici « cache HuggingFace » pour tout ce qui vient de
  HuggingFace, alors que Supertonic télécharge depuis HuggingFace mais range ailleurs.
  Régression : `node --test scripts/test-models-location.mjs` (le modèle de la voix part avec le reste et
  reste lisible au même chemin ; garde-fou sur la version).

- **Étape 156, Léo : « la reconnaissance de la voix prend deux fois plus que le modèle, 4,5 Go sur la carte,
  c'est pas normal [...] fais un test de vitesse quand on la met sur la VRAM et sur la RAM, avec la RAM prise,
  la VRAM et la vitesse ».** Point de départ : sur une carte de 6 Go, les 4,5 Go réservés à la transcription
  (`STT_RESERVED_GB`, hardwareScan.ts) ne laissent que 1,5 Go au cerveau, donc qwen3.5:0.8b partout —
  simulé avec le vrai `pickBestModelsFromBenchmark` avant de répondre, pas supposé. Les 4,5 Go ne sont pas un
  gaspillage : Cohere Transcribe a 2 milliards de paramètres (4,13 Go en float16), plus que le cerveau.
  **Mesuré ici, pas estimé** (processeur 4 cœurs à 2,1 GHz, sans carte graphique ; mêmes versions figées que
  requirements.txt ; phrases dites par Supertonic) : Cohere en RAM 1,7-2,0 s pour 5 s de parole et ~12 Go de
  RAM ; Parakeet v3 (NVIDIA, 0,6 milliard de paramètres, via onnx-asr) 0,5 s, 2,5 Go, erreurs comparables ou
  moindres ; sa version compressée 0,55 s, 1,2 Go ; Whisper Turbo 5,7 s (trop lent sur processeur). La
  version compressée de Cohere (int8 dynamique) a été tuée faute de RAM lors d'un premier essai — la
  conversion copie le modèle : `inplace=True` obligatoire.
  **Impossible ici : la vitesse sur la carte graphique.** Plutôt que de l'estimer, un bouton Options → Voix
  « Tester la vitesse de la transcription » (python/stt_benchmark.py) mesure SUR le PC de l'utilisateur, pour
  chaque façon de comprendre la voix : temps pour 5 s de parole, RAM prise, VRAM prise, erreurs, et ce qui a
  été compris. Choix structurants :
  - **Un processus par configuration** (le script se relance avec `--config`) : la RAM se mesure proprement
    (mémoire maximale moins la mémoire avant chargement) — un allocateur ne rend jamais tout, la mesure
    suivante serait sinon faussée par la précédente.
  - **La carte est libérée avant le test** : la transcription de Jaris (4,5 Go) est arrêtée, et les modèles
    d'Ollama gardés « au chaud » sont déchargés (`unloadAllModels`, ollama.ts : `GET /api/ps` puis
    `keep_alive: 0`, API documentée d'Ollama) — sinon Cohere sur la carte manquerait de place ou serait mesuré
    à côté d'un autre modèle. La voix repart dans un `finally`, même si le test échoue.
  - **Phrases dites par Supertonic plutôt qu'au micro** : compter les erreurs exige le texte exact, et chaque
    configuration entend le même son. Aucune phrase ne contient de nombre (« 18 » contre « dix-huit » serait
    compté comme une erreur).
  - Cohere en RAM n'est tenté qu'avec ~10 Go de RAM libre ; une ligne non mesurable dit POURQUOI au lieu
    d'afficher des chiffres vides. Délai d'inactivité de 20 min, jamais de durée totale (étape 98 : le premier
    test télécharge jusqu'à 3 Go).
  - Parakeet sur la carte n'est pas mesuré : il faudrait la version GPU d'onnxruntime, pas installée par Jaris.
  `onnx-asr==0.12.0` figé dans requirements.txt après résolution de l'ensemble (`pip install --dry-run
  --report`, leçon librosa/scipy) : il ne dépend que de numpy, onnxruntime et huggingface_hub étant déjà figés.
  Aucun changement de comportement de Jaris lui-même à cette étape : le test sert à décider, avec les vrais
  chiffres de la carte de Léo, s'il faut déplacer la transcription en RAM ou changer de modèle.
  Régression : `node --test scripts/test-stt-benchmark.mjs scripts/test-stt-benchmark-ui.mjs` (lecture de la
  sortie du script, message lisible si le script s'arrête sans tableau, voix relancée dans un `finally`,
  taux d'erreurs au mot, version figée ; et dans un vrai navigateur : avancement affiché, bouton verrouillé
  pendant le test, tableau vitesse/RAM/VRAM/erreurs, ligne non mesurable expliquée, tableau habillé par le CSS
  compilé). Le script lui-même a tourné en entier ici (lignes RAM mesurées, ligne carte « non disponible »).

- **Étape 157, Léo (capture du test de l'étape 156 sur sa RTX 3070) : « RAM prise : 0 Go » sur chaque ligne —
  « règle le bug du tableau avec la RAM et aussi la VRAM ».** Deux défauts, corrigés à la source :
  1. **RAM à 0 : appel Windows déclaré sans ses types.** `ctypes.windll.kernel32.GetCurrentProcess()` et
     `GetProcessMemoryInfo` étaient appelés sans `restype`/`argtypes` : ctypes suppose alors un `int` 32 bits
     partout, le pseudo-handle du processus (-1, soit 0xFFFF…FFFF sur 64 bits) arrivait tronqué, l'appel
     échouait SANS erreur et les compteurs restaient à zéro. Types déclarés, retour vérifié, et une mesure
     ratée lève désormais une erreur → la case affiche « non mesuré », jamais « 0 Go » (qui se lit « ne prend
     rien »). **Leçon générale : avec ctypes, toujours déclarer `restype` et `argtypes` d'une fonction Windows
     qui prend ou rend un handle ou un pointeur — sans eux, un appel peut échouer silencieusement sur 64 bits.**
     Et vérifier le BOOL de retour : ici, c'était le seul signal que rien n'avait été mesuré.
  2. **VRAM : seulement ce que torch réservait.** `torch.cuda.max_memory_reserved()` ne compte que les
     tenseurs de torch, pas le contexte CUDA (plusieurs centaines de Mo). La VRAM est maintenant lue par
     `nvidia-smi` (mémoire utilisée de la carte avant chargement, puis modèle chargé), cherché aussi dans ses
     deux emplacements habituels hors du PATH ; repli sur torch si nvidia-smi est introuvable. Une
     configuration en RAM affiche « 0 Go » (elle ne touche pas la carte), plus un tiret ambigu.
  La RAM retenue est celle EN FONCTIONNEMENT (modèle chargé, après les transcriptions), plus le pic du
  chargement : Cohere transite par la RAM même quand il finit sur la carte, et ce pic ne dit rien de ce qu'il
  occupe ensuite.
  **Pourquoi la CI ne l'a pas vu : aucun test n'exerçait la mesure réelle.** Ajouté un test qui alloue 300 Mo
  dans un vrai Python et exige de les voir — lancé par la CI Windows (Python y est disponible pendant `npm
  test`, vérifié dans le journal de la CI : le test du taux d'erreurs y tourne), donc sur le vrai chemin ctypes.
  Régression : `node --test scripts/test-stt-benchmark.mjs scripts/test-stt-benchmark-ui.mjs` (mesure réelle
  de +300 Mo ; « non mesuré » affiché pour une mesure ratée, « 0 Go » pour la VRAM d'une configuration en RAM).
  Script relancé en entier ici : Cohere en RAM 12,1 Go, Parakeet v3 2,5 Go, compressé 1,1 Go.

- **Étape 158, Léo : « enlève le test, et on décale sur Parakeet v3 ».** Le test de vitesse de l'étape 156
  (Options → Voix, `stt_benchmark.py`/`sttBenchmark.ts`, ses canaux IPC et son tableau) est retiré en entier :
  il a rendu son verdict, et un bouton qui télécharge ~12 Go de modèles pour une mesure n'a pas sa place dans
  les réglages de tous les jours. La transcription passe de Cohere Transcribe (sur la carte graphique) à
  **Parakeet TDT 0.6B v3 en RAM** (onnx-asr 0.12.0, `CPUExecutionProvider`, dépôt
  `istupakov/parakeet-tdt-0.6b-v3-onnx` épinglé par commit, fp32, ~2,5 Go). Décidé sur les MESURES de Léo sur
  sa RTX 3070, pas sur un comparatif : Parakeet en RAM 0,26 s et 4,5 % de mots faux, contre Cohere sur la carte
  0,84 s, 9,1 % et 3,9 Go de VRAM. La version compressée (int8, 0,22 s, 6,8 %) n'a pas été retenue : 2 points
  d'erreur de plus pour 1,3 Go de RAM gagnés.
  **Conséquences, chacune traitée** :
  1. **La VRAM rendue au modèle de conversation.** `STT_RESERVED_GB = 4.5` (hardwareScan.ts) devient
     `GPU_RESERVED_GB = 1` (Windows, affichage, contexte). Simulé avec un faux `nvidia-smi` avant de livrer :
     sur 6 Go, Rapide/Médium passent de qwen3.5:0.8b à un 3B/qwen3.5:4b ; sur 8 Go, Médium passe de
     qwen3.5:4b à qwen3.5:9b. **Rien ne change tant que l'analyse n'est pas relancée** : les choix sont figés
     dans le profil par le dernier scan (`runQuickSetup`), jamais recalculés en direct.
  2. **torch, transformers, accelerate, sentencepiece et librosa retirés de requirements.txt** — ils ne
     servaient qu'à Cohere. Ensemble restant re-résolu depuis un environnement VIDE (`pip install --dry-run
     --report`), jamais version par version (leçon librosa/scipy). L'installation de torch depuis l'index CUDA
     (pythonRuntime.ts) disparaît avec. Le changement d'empreinte de requirements.txt fait réinstaller Python
     une fois, proprement, ce qui retire aussi les ~3 Go de torch des machines existantes.
  3. **L'ancien modèle effacé automatiquement** (`remove_old_stt_model`, voice_server.py) — seulement APRÈS
     que Parakeet s'est chargé, jamais avant : si le nouveau modèle échoue, rien n'est perdu. Silencieux si le
     dossier est absent ou verrouillé.
  4. **Le nom « Jaris » réécrit autrement par la nouvelle transcription.** Mesuré sur 50 échantillons (10 voix,
     5 tournures) AVANT de toucher au motif : Jaris 21, Jarry 16, Jarris 3, Dijaris 2, j'arrive 2, Jerry 1.
     L'ancien motif (`\bjari\w*`) aurait raté « Jarry » — un tiers des activations. Nouveau motif
     `\b(?:di)?jarr?[iy]\w*\b` ; toujours strict sur « Jerry », « j'arrive », « jardin », « jarret », « Jarvis ».
     **Leçon générale : changer le modèle de transcription change aussi tout ce qui lit sa sortie** — un motif
     calé sur les graphies d'un modèle ne vaut rien pour le suivant sans une nouvelle mesure.
  5. **Réglages `STT_*` supprimés** (`.env.example`, config.ts, arguments du sidecar) : il n'y a plus de
     modèle, de révision, d'appareil ni de langue à choisir — Parakeet v3 détecte la langue seul, et ne l'a
     jamais changée sur 15 phrases françaises courtes mesurées.
  Régression : `npm test` (494 tests), `python scripts/test-wake-confirmation.py` (vérifié en remettant
  l'ancien motif : 2 tests échouent). Sidecar lancé ici de bout en bout jusqu'à l'ouverture du micro :
  téléchargement épinglé, chargement, cache Cohere effacé. **Non vérifié en usage réel** : la reconnaissance
  sur le vrai micro de Léo, et les nouveaux modèles choisis après « Lancer l'analyse ».

- **Étape 159, Léo : « j'ai fait un prompt sur Code, il a fait ; j'ai refait un nouveau prompt pour corriger
  des trucs, ça met : Réponse vide d'Ollama (modèle 'qwen3.6:35b-a3b' bien installé ?) ».** Cause REPRODUITE
  avec un vrai Ollama (0.34.4, téléchargé dans le conteneur) et qwen3.5:0.8b, de la même famille que le
  modèle de Léo, avant d'écrire le correctif. Le mode Code utilisait une fenêtre de contexte FIXE de 16384.
  Or une modification y fait entrer le fichier actuel, doit en faire sortir le fichier modifié, et la
  réflexion cachée (`think: 'high'`) passe avant les deux. Mesuré : la réflexion remplit la fenêtre avant le
  premier caractère de code (`done_reason: "length"`, 0 caractère écrit). Les modèles qwen3.5/3.6 ne peuvent
  pas faire glisser leur contexte (couches récurrentes) : Ollama s'arrête net. qwen3 classique, lui, fait
  glisser le contexte et perd la consigne (11 000 tokens générés sans fin). **Deuxième défaut mesuré au
  passage** : une demande plus grande que la fenêtre est coupée sans prévenir par Ollama (2 500 tokens
  envoyés, 1 026 lus) — le modèle ne voit plus qu'une partie du code.
  Corrigé en trois points :
  1. **La fenêtre suit la demande** (`computeCodeNumCtx`, codeGenerator.ts) : demande + fichier attendu
     (+30 %) + réserve de réflexion, arrondi à 4096. 2,5 caractères par token, d'après une mesure faite avec
     le tokenizer qwen3.5 (CSS 2,9 ; JavaScript 3,6 ; français 3,8). Plancher 16384 : une NOUVELLE
     application retombe exactement sur l'ancienne fenêtre (vérifié par un test avec les vraies consignes),
     seules les modifications et relectures de gros fichiers reçoivent plus. Plafond 65536, abaissé à la
     limite du modèle (`*.context_length` de `/api/show`) quand elle est connue.
  2. **Une fenêtre pleine est reconnue comme telle** (`ContextFullError`, ollama.ts, lu sur `done_reason`) :
     l'ancien message « bien installé ? » envoyait sur une fausse piste — le modèle était installé et avait
     travaillé. Plus de second essai « sans think » dans ce cas : qwen3.5/3.6 réfléchissent quand même par
     défaut, il remplissait la même fenêtre pareil (c'est pour ça que Léo a vu l'erreur après DEUX essais).
  3. **Une seule nouvelle tentative avec une fenêtre doublée** si l'estimation reste trop juste, puis un
     message qui dit quoi faire (changement plus petit, ou nouvelle application).
  **Leçon générale : une fenêtre de contexte fixe convient à une demande de taille fixe, jamais à une
  demande qui contient un fichier de taille variable** — et avec un modèle qui réfléchit, la réflexion se
  paie dans la même fenêtre que la réponse. Même famille que le passage de `OLLAMA_NUM_CTX` de 4096 à 8192 :
  mesurer ce qui doit tenir dedans plutôt que garder un chiffre choisi pour un autre usage.
  Régression : `node --test scripts/test-codegen-context.mjs` (11 tests : fenêtre pleine reconnue en
  streaming et sans, pas de second essai inutile, fenêtre agrandie pour une grosse modification, inchangée
  pour une nouvelle application, plafonds, nouvelle tentative, message final). Vérifié en remettant
  l'ancien code : 3 tests échouent. Vérifié aussi contre le vrai Ollama : fenêtre de 2048 → `ContextFullError`,
  fenêtre de 8192 → 7 376 caractères de code. **Non vérifié en usage réel** avec qwen3.6:35b-a3b sur la
  machine de Léo (trop gros pour ce conteneur).

- **Étape 160, Léo : « ça sert à quoi d'avoir un modèle de code qwen3.6:35b-a3b moins fort que le puissant
  qwen3.8:27b ? » puis « que tous les modèles soient au même endroit, pas des modèles code, pas des modèles
  rapide : Jaris choisit le plus rapide dans tous les modèles, le meilleur pour le code, ça peut être des
  modèles puissants — il n'y a plus de catégorie, sauf pour que l'utilisateur voie quel modèle est rapide ».**
  Cause du constat : chaque rôle ne cherchait QUE dans sa propre liste (CODE_CANDIDATES pour Code), donc le
  modèle Code ne pouvait jamais être un modèle « Puissant », même bien plus intelligent (34 contre 18).
  Deux questions à choix posées avant de coder : Léo a répondu « le plus rapide, comme d'habitude mais dans
  tous les modèles » pour Rapide, et « le plus intelligent, même lent » pour Code — annoncé AVANT de coder que
  qwen3.8:27b, dense, déborde sur la RAM d'une carte de 8 Go et sera nettement plus lent (estimation ~5-6×).
  **Nouvelle règle** (`computeModelPicks`, hardwareScan.ts) : une liste unique `ALL_MODELS` (les anciennes
  listes restent le catalogue, avec l'historique de recherche de chaque modèle), et chaque rôle pose SA
  question à tous les modèles, toujours parmi les plus fiables à leur test :
  Rapide = le plus rapide (vitesse publiée par Artificial Analysis, repère choisi par Léo à l'étape 131), sur
  la carte seule ; Médium = le plus intelligent sur la carte seule ; Puissant = le plus intelligent, RAM
  comprise ; Code = pareil, avec le test de code quand le modèle l'a passé, sinon son test de conversation ;
  Vision = le plus intelligent parmi ceux qui lisent une image (seule restriction restante : une capacité
  réelle du modèle, pas une catégorie). Résultat simulé sur 8 Go : Rapide ministral-3:3b (221 tok/s publiés),
  Médium qwen3.5:9b, Puissant ET Code qwen3.8:27b — qwen3.6:35b-a3b (23 Go) n'est plus utilisé.
  **Deux pièges attrapés en le faisant :**
  1. **Des scores sur des échelles différentes** : le test de code est sur 3, celui de conversation sur 6.
     Comparés en nombre brut, n'importe quel 6/6 battait un 3/3 pourtant parfait. Comparés désormais en
     PROPORTION (`parseToolScore`, et le tri de « Tous les modèles » qui mélange maintenant les deux).
  2. **Le repli en direct (`pickSafeModel`) aurait saboté Rapide** : il prenait « le plus gros modèle installé
     qui tient dans la VRAM libre ». Avec des petites listes par rôle, ça restait dans le même genre de modèle ;
     dans une liste unique, Rapide aurait été remplacé par un gros modèle plus lent à CHAQUE question. Il garde
     maintenant le modèle choisi tant qu'il tient, et ne remplace que celui qui ne tient plus.
  **Leçon générale : quand on fusionne des listes séparées en une seule, toute règle qui disait « le plus
  gros » ou « le premier qui tient » change de sens** — elle était sûre DANS une petite liste homogène, elle
  choisit autre chose dans la grande. Relire chaque consommateur de l'ancienne liste, pas seulement le calcul
  principal.
  « Tous les modèles » : un seul tableau (plus un par palier), chaque modèle une fois, avec une colonne
  Catégorie (Rapide ≤ 3 Go, Moyen ≤ 10 Go, Puissant au-delà, « · lit les images » quand c'est le cas) —
  affichée seulement, jamais utilisée pour choisir.
  Régression : `node --test scripts/test-hardwarescan-single-pool.mjs` (sur les VRAIS scores du dépôt : Code
  = Puissant sur 8 Go, Rapide = le plus rapide, Rapide/Médium jamais sur la RAM même avec 128 Go, Médium peut
  être un gros modèle sur 24 Go, Vision seulement parmi les lecteurs d'image, 3/3 ≡ 6/6, repli qui garde le
  modèle qui tient, une seule ligne par modèle). Vérifié en remettant l'ancien code : les 8 échouent.
  **À faire par Léo** : relancer « Retester la configuration » pour que le profil prenne les nouveaux choix ;
  la vitesse réelle de qwen3.8:27b en mode Code sur sa carte n'est pas vérifiée ici.

- **Étape 161, Léo : « revois Rapide : il ne faut pas le plus rapide sans regarder l'intelligence, par
  exemple un modèle qui a 5 points d'intelligence en plus mais ne perd que 3 points de vitesse ».** La règle
  de l'étape 160 (Rapide = le plus rapide, point) ignorait l'intelligence dès qu'un modèle était un tout petit
  peu plus lent. Nouvelle règle (`fastEnoughThenSmartest`, hardwareScan.ts) : parmi les modèles les plus
  fiables, ceux qui gardent au moins 75 % de la vitesse publiée du plus rapide (`RAPIDE_MIN_SPEED_RATIO`, au
  plus un quart plus lent), puis le plus INTELLIGENT d'entre eux. Un modèle sans vitesse publiée ne peut pas
  prouver qu'il est rapide : écarté tant qu'un autre en a une.
  **Ce qui a été dit honnêtement à Léo plutôt que de lui laisser croire que ça changeait tout** : son exemple
  correspond exactement à granite4.2:3b face à ministral-3:3b (9 contre 5 d'intelligence, 218 contre 221 de
  vitesse) — mais granite4.2:3b n'avait PAS perdu à cause de la vitesse : il n'a que 5/6 au test d'appel
  d'outils, et la fiabilité passe toujours avant. Sur une carte de 8 Go, Rapide reste donc ministral-3:3b ;
  la nouvelle règle change le choix sur 16 Go et plus (gpt-oss:20b : 9 d'intelligence, 168 tok/s).
  **Leçon générale : quand l'utilisateur illustre une règle par un exemple, vérifier sur les vraies données
  pourquoi cet exemple précis a perdu** — ici la cause était une autre règle (la fiabilité), et la
  simulation avant/après sur plusieurs tailles de carte évite d'annoncer un changement qui n'aura pas lieu
  chez lui.
  Régression : `node --test scripts/test-hardwarescan-single-pool.mjs` (+4 d'intelligence pour −3 de vitesse
  gagne ; plus intelligent mais bien plus lent ne gagne jamais ; la fiabilité passe avant tout ; 8 Go reste
  ministral-3:3b). Vérifié en remettant l'ancien code : le test de l'exemple de Léo échoue.

- **Étape 162, Léo : « rajoute le test des appels d'outils pour que je le lance cet aprem ; c'est bizarre,
  gemma4:12b n'a pas de score alors qu'il n'est pas lourd et que granite4.2:30b en a un ; est-ce que les tests
  d'outils sont bien, ou on en rajoute pour un score fiable, et on refait l'analyse de tout ».**
  **gemma4:12b sans score : cause trouvée dans le script, pas devinée.** L'analyse n'autorisait à déborder sur
  la RAM que les modèles de `RAM_OFFLOAD_MODELS` (les gros « Puissant »). gemma4:12b pèse 7,6 Go, sa carte laisse
  7 Go au test : sauté à chaque analyse, alors que granite4.2:30b (18 Go, dans la liste) passait par la RAM.
  Réussir ou non une question ne dépend pas du matériel, seule la durée change : TOUS les modèles peuvent
  désormais déborder sur la RAM pendant le test.
  **Le test lui-même était faible, trois défauts trouvés en le relisant contre le vrai Jaris :**
  1. une copie PÉRIMÉE des outils — 7 au lieu des 14 réels, dont `send_email`, retiré de Jaris depuis longtemps ;
  2. des consignes simplifiées (4 lignes) au lieu des vraies, qui imposent search_web pour toute question
     factuelle — l'ancien test attendait « pas d'outil » pour « pourquoi le ciel est bleu », l'inverse de ce que
     Jaris demande réellement au modèle ;
  3. 6 questions notées (une par outil), sans regarder le contenu de l'appel : un rappel « dans 20 minutes »
     programmé à 2 minutes comptait juste, et beaucoup de modèles plafonnaient à 6/6.
  Nouveau test (`scripts/benchmark-cases.mjs`) : les 14 VRAIS outils et les VRAIES consignes (canal voix),
  copies exactes surveillées par un test qui échoue dès qu'elles divergent de `tools.ts`/`systemPrompt.ts` ;
  17 questions notées, dont 4 où il ne faut AUCUN outil (remerciement, question sur Jaris, heure, négation
  « n'éteins surtout pas ») ; chaque appel vérifié sur son contenu (délai du rappel, nom de l'application...).
  Pour que le script puisse reprendre les vraies consignes, `buildSystemPrompt` sort d'assistant.ts vers
  `systemPrompt.ts`, un module pur (les 4 faux ponts d'assistant.ts le chargent via `load-system-prompt.mjs`).
  **« Lancer l'analyse complète » revient dans « Tous les modèles »**, retiré à l'étape 134 (« pas bien pour le
  public ») : il passe maintenant par une confirmation qui annonce plusieurs heures de téléchargements et de
  tests — le garde-fou qui manquait. Il reteste TOUT (`JARIS_RETEST_ALL`, ignore verified-tool-scores.md, noté
  avec l'ancien test) et REPREND après une interruption (`JARIS_RESUME`) ; une ligne de l'ancien test (x/6)
  n'est jamais reprise, seulement une ligne notée sur les 17 questions actuelles.
  **Deux défauts de fond corrigés au passage, trouvés en suivant le chemin des résultats :**
  1. les résultats s'écrivaient à côté du script, dans le dossier du PROGRAMME : la mise à jour suivante les
     effaçait. Ils vont désormais dans le dossier de DONNÉES (`JARIS_RESULTS_PATH`, `localBenchmarkResultsPath`),
     l'ancien emplacement restant lu en repli ;
  2. quand la place manque, le tri par « champion de palier » n'avait plus de sens depuis l'étape 160 : chaque
     modèle téléchargé par l'analyse est supprimé après son DERNIER test, et Jaris retélécharge à la fin les
     modèles qu'il a choisis (`runModelAnalysis`).
  **Leçon générale : une copie « de référence » (outils, consignes) dans un script de test finit toujours par
  diverger de l'original — ici au point de tester un outil qui n'existait plus. Soit la copie est générée,
  soit un test la compare à l'original ; jamais une copie à la main laissée sans surveillance.**
  Régression : `node --test scripts/test-benchmark-cases.mjs` — copies fidèles, contenu des appels vérifié, et le
  VRAI script lancé de bout en bout contre un faux Ollama (vraies consignes et 14 outils reçus, scores attendus
  pour un modèle parfait, un modèle qui se trompe de délai et un modèle qui n'appelle jamais d'outil, reprise,
  « tout retester »). Chaque garde-fou vérifié en remettant l'ancien code. **Non vérifié ici** : l'analyse réelle
  sur la machine de Léo (durée, espace disque) ; ses résultats (`benchmark-results.md`, dossier de données)
  remplaceront ensuite verified-tool-scores.md pour tout le monde.

- **Étape 163, Léo envoie le `benchmark-results.md` de sa première analyse complète (v0.16.19).** Relu ligne par
  ligne AVANT d'enregistrer quoi que ce soit, et une partie des scores de conversation s'est révélée FAUSSE à
  cause de mon script, pas des modèles :
  - granite4.2:3b/8b/30b et G9v3-3B à **0/17** : la section « Erreurs » du fichier donnait la cause exacte —
    `request (4569 tokens) exceeds the available context size (4096 tokens)` ;
  - toute la famille qwen3.5/3.6/3.8 à **4-6/17**, soit exactement les 4 questions SANS outil et presque rien
    d'autre : même cause, mais ces modèles (moteur récent d'Ollama) coupent la demande au lieu de la refuser —
    les consignes et les outils arrivaient tronqués, sans la moindre erreur.
  Cause : la requête de conversation du script n'imposait pas `num_ctx`, donc Ollama prenait 4096, alors que les
  vraies consignes + 14 outils (étape 162) pèsent ~4 600 tokens. Jaris, lui, utilise au minimum 8192
  (`OLLAMA_NUM_CTX`). **Le passage aux vraies consignes a fait grossir la demande sans que je revérifie ce qui
  la contenait** — même leçon que le passage de 4096 à 8192 dans config.ts, retombée cette fois dans le script
  de test : quand ce qu'on envoie grossit, relire la fenêtre qui doit le contenir, partout où elle est fixée.
  Corrigé : `CONVERSATION_NUM_CTX = 8192` envoyé à chaque question ; une **version du test de conversation**
  (`CONVERSATION_TEST_VERSION = 2`) est écrite en tête du fichier de résultats. Un score de conversation d'une
  autre version (ou sans version, comme ce premier run) est refait par l'analyse, jamais recopié, et **ignoré
  par Jaris en attendant** (`LOCAL_CONVERSATION_TEST_VERSION`, parseLocalBenchmark) — sans ça, ces scores
  faussés auraient choisi les modèles de Léo (un qwen3.5:9b à 5/17 exclu de Médium, par exemple). Un test
  vérifie que les deux constantes restent égales.
  **Ce qui était bon dans ce run, et a été gardé** : les sections Vision et Code (fenêtre déjà imposée, 16384
  pour le code, prompts courts pour la vision) → reportées dans `verified-tool-scores.md` pour tout le monde
  (nouveau : gemma4:31b, qwen3-vl:8b, gemma4:12b à 3/3 en vision, gemma4:e4b à 1/3 ; qwen3-coder-next à 3/3 en
  code). À la relance, la reprise saute vision et code (déjà faits) et ne refait que la conversation.
  **Leçon générale : avant d'enregistrer des résultats de mesure, lire les erreurs et chercher les motifs
  suspects (ici, toute une famille bloquée exactement au nombre de questions sans outil) — un score très bas
  et uniforme accuse plus souvent le banc de test que les modèles.**
  Régression : `node --test scripts/test-benchmark-cases.mjs scripts/test-local-benchmark-tiers.mjs` — fenêtre
  réellement envoyée, place suffisante pour consignes + outils, version écrite, scores d'une version précédente
  refaits et non recopiés (avec le vrai fichier de Léo comme cas), et ignorés par Jaris. Chaque garde-fou
  vérifié en remettant l'ancien code.

- **Étape 163 (suite), Léo : « tu es sûr qu'il ne faut pas tout relancer ? regarde bien, je ne veux pas que tu
  me dises à la fin de refaire ».** Relecture complète du banc de test AVANT sa relance, et deux défauts de plus
  trouvés, corrigés dans la version 3 du test (`CONVERSATION_TEST_VERSION`/`LOCAL_CONVERSATION_TEST_VERSION`) :
  1. **une réponse coupée faute de place passait pour juste** : `done_reason: "length"` sans outil était lu comme
     « aucun outil appelé », donc réussi sur les 4 questions sans outil. C'est maintenant un échec, noté dans les
     erreurs avec la cause ;
  2. **des vérifications jugeaient la forme, pas le fond** : « BTC » au lieu de « bitcoin », « return » au lieu
     d'« Entrée », « guitar » au lieu de « guitare », « chef de l'État » au lieu de « président » comptaient faux.
  Revérifié et gardé tel quel : vision (demande de quelques dizaines de tokens, sans outils ni consignes — la
  fenêtre par défaut n'y était jamais atteinte) et code (fenêtre 16384, la même que Jaris pour une nouvelle
  application). Sur la relance, seule la conversation est refaite, pour TOUS les modèles.
  **Leçon générale : quand l'utilisateur doit relancer une mesure longue, relire tout le banc de test avant la
  relance plutôt qu'après — chaque défaut trouvé après coup coûte une relance de plus à quelqu'un d'autre.**
  Régression : `node --test scripts/test-benchmark-cases.mjs` (réponse coupée comptée comme échec — vérifié en
  retirant le garde-fou —, fond jugé plutôt que forme).

- **Étape 164, deuxième analyse de Léo (v0.16.21) : ministral-3:3b, granite4.1:8b, gemma4:26b et qwen3.5:2b-q4_K_M
  à 0/17, alors que les trois premiers avaient 17/17.** Son fichier de résultats donnait la cause : « fetch failed »
  sur TOUTES les questions — le script n'arrivait plus du tout à joindre Ollama (arrêté ou en train de redémarrer,
  par exemple pendant une mise à jour automatique). Les modèles n'y étaient pour rien ; le même script, lancé ici
  contre un vrai Ollama, donnait 10/10 à granite4.2:3b au même moment. Trois défauts du script, corrigés :
  1. **aucune réaction à une coupure** : chaque question en erreur de connexion comptait comme ratée. Désormais
     `postChat` attend qu'Ollama revienne (3 minutes max, en interrogeant `/api/tags`), repose la question, et
     s'il ne revient pas l'analyse S'ARRÊTE avec un message clair (`OllamaDownError`) sans enregistrer le modèle
     en cours — jamais un faux 0/17 ;
  2. **la reprise prenait ces faux 0/17 pour des scores** : c'est ce qui les laissait bloqués d'un lancement à
     l'autre. Une ligne sans AUCUNE réponse (latence « — ») est maintenant refaite ;
  3. **trouvé en relisant, pas encore arrivé** : `fetch` (undici) abandonne une requête après 5 minutes sans
     en-têtes de réponse, et sans streaming Ollama n'en envoie qu'une fois la réponse entière prête. Un gros
     modèle qui tourne dans la RAM peut réfléchir plus longtemps (qwen2.5-coder:32b : 4 min 30 en moyenne chez
     Léo, à 30 secondes du seuil). Les questions passent donc par `http.request`, sans délai maximal.
  **Leçon générale : dans une mesure longue, une panne de l'OUTIL de mesure (ici le serveur Ollama) ne doit jamais
  s'enregistrer comme un résultat de la chose mesurée** — la distinguer (erreur de connexion vs vraie réponse
  d'erreur), attendre, et sinon s'arrêter sans rien écrire. Et une reprise ne doit reprendre que de vrais
  résultats : « une ligne existe » ne veut pas dire « une mesure a eu lieu ».
  Régression : `node --test scripts/test-benchmark-cases.mjs` — faux Ollama qui coupe VRAIMENT la connexion
  (socket détruit) : coupure passagère → vrai score noté ; coupure durable → arrêt sans score enregistré ; ligne
  sans aucune réponse refaite à la reprise ; plus aucune question posée avec `fetch`. Chaque garde-fou vérifié
  en remettant l'ancien code.
  **Suite (Léo : « les modèles qu'on ne reteste pas, tu es sûr que leur score n'est pas faux ? »)** : relu un par un.
  Vision (9 modèles) : demande de quelques dizaines de tokens + une petite image, sans consignes ni outils, aucune
  erreur dans son fichier — valables. Code : fenêtre 16384 (celle de Jaris), aucune erreur SAUF qwen2.5-coder:32b,
  noté « 2/2 » : une de ses trois générations avait planté (très probablement le délai de 5 minutes de fetch,
  sa moyenne était à 4 min 30). Une mesure INCOMPLÈTE n'est plus jamais reprise, en vision et en code comme en
  conversation (total ≠ nombre de questions → refaite). Vérifié de bout en bout avec un vrai Ollama ici :
  qwen3.5:0.8b, qui plafonnait à 4/17 avec les consignes coupées, appelle maintenant de vrais outils avec le bon
  contenu (ses ratés restent de vraies erreurs d'un modèle de 0,8 Md de paramètres).

- **Ouvrir Jaris au démarrage de Windows (étape 165, Léo : « dès que le PC démarre on voit la fenêtre Jaris et
  pas le fond d'écran, et pour l'activer/désactiver »).** Interrupteur dans Options → Général → Démarrage.
  **La seule source de vérité est l'entrée de démarrage de Windows** (`app.setLoginItemSettings`, clé Run),
  jamais un champ du profil : l'entrée peut être retirée ou désactivée depuis le Gestionnaire des tâches, et un
  champ à part afficherait alors « activé » à tort. L'état est RELU après chaque bascule et à chaque ouverture
  de l'onglet ; une entrée présente mais désactivée par Windows (`executableWillLaunchAtLogin === false`) est
  signalée au lieu d'être montrée comme active. Refusé hors version installée (en développement, l'entrée
  pointerait vers `electron.exe` sans l'application).
  **La commande enregistrée porte `--launched-at-login`** : c'est ce qui distingue « Windows vient d'ouvrir la
  session » (afficher la fenêtre en grand) d'un démarrage normal (rester discret en widget, inchangé). Sur
  Windows, `getLoginItemSettings` doit recevoir les MÊMES arguments pour retrouver l'entrée — une seule
  constante sert aux deux appels.
  **Piège anticipé, pas encore constaté** : pendant l'ouverture de session, l'Explorateur et les autres
  programmes de démarrage prennent le focus tour à tour. Le handler 'blur' (repli en widget) aurait replié la
  fenêtre aussitôt — retour au fond d'écran, exactement ce que Léo ne veut pas. D'où un délai de 30 s après un
  lancement au démarrage pendant lequel 'blur' ne replie rien (4e garde sur ce handler, après `dialogOpen`,
  `quitting`, `optionsOpen`). La fenêtre passe aussi brièvement « toujours au premier plan » : Windows peut
  refuser le focus à un programme de démarrage, et elle resterait derrière les autres.
  Régression : `node --test scripts/test-launch-at-startup.mjs scripts/test-options-reorganization-ui.mjs`
  (faux `app` qui imite l'entrée Run, arguments identiques exigés, blocage par Windows signalé, rien
  d'enregistré en développement ; branchement main.ts ; vrai clic sur l'interrupteur). Les gardes de main.ts
  vérifiés en les retirant. **Non vérifiable ici** : une vraie ouverture de session Windows — à confirmer par
  Léo au prochain redémarrage.

- **Analyse des modèles retirée, scores de Léo recopiés (étape 166, comme convenu : « après je peux te donner
  les scores et après on va enlever l'analyse »).** Son analyse complète du 25/09/2026 (v0.16.23, test v3,
  17 questions) est dans `scripts/verified-tool-scores.md`, devenu la SEULE source des scores : bouton,
  confirmation, suivi en direct, IPC `runModelAnalysis`, `spawnBenchmarkScript`/`cleanupUnselectedModels` et
  la lecture de `benchmark-results.md` local sont retirés ; le script reste un outil de développement (plus
  embarqué dans l'installeur). **Pourquoi ne plus lire le fichier local** : sans bouton, il ne pourrait plus
  jamais être remis à jour, et il prime sur les scores vérifiés — un vieux fichier (ex : vision/code mesurés
  avec l'ancien délai de 5 min de fetch) aurait choisi les modèles pour toujours, en silence.
  **Relu ligne par ligne AVANT de recopier, pas copié tel quel** : aux 4 questions sans outil, le script
  comptait juste toute réponse sans appel d'outil, y compris une réponse VIDE ou un appel d'outil écrit en texte
  (que Jaris lirait à voix haute). Trois scores corrigés à la main depuis les réponses écrites dans le même
  fichier : command-r:35b 6→2, granite4.1:3b 13→12, phi4-mini 4→3 ; le script compte désormais ces cas faux
  (`isRealReply`, test v4). **Leçon générale : un score « juste » sur une question sans outil ne prouve rien si
  le critère est « aucun outil appelé » — le silence et le texte cassé passent aussi ; vérifier que la réponse
  est une vraie réponse.**
  **Piège attrapé en recalculant les choix de modèles avant de livrer** : les trois imports Hugging Face
  n'avaient pas pu être remesurés et gardaient leur score de l'ANCIEN test à 6 questions (celui qui coupait les
  consignes). Le 6/6 de G9v3-3B passait alors devant qwen3.5:4b (15/17) comme Médium/Puissant/Code sur une carte
  de 6 Go. Scores retirés : un score d'un autre test n'est pas comparable, même converti en proportion. Test
  permanent : tout score de conversation doit être sur 17, vision/code sur 3.
  Choix obtenus (règles inchangées, fiabilité d'abord) : 8 Go/32 Go → Rapide ministral-3:3b, Médium
  granite4.2:8b (17/17, devant qwen3.5:9b 16/17), Puissant et Code qwen3.8:27b.
  Régression : `node --test scripts/test-verified-scores.mjs scripts/test-benchmark-cases.mjs
  scripts/test-options-reorganization-ui.mjs` ; chaque garde-fou vérifié en réintroduisant son défaut.

- **Nemotron 3.5 Lightning ajouté + qwen2.5-coder:14b rendu testable (étape 167).** Léo : « ajoute-le, car
  moi ça tient pas dans ma carte mais un autre utilisateur peut-être ». `nemotron-3.5-lightning:30b` (NVIDIA,
  30B MoE / 3B actifs, tools+thinking, 25 Go — vérifié sur ollama.com/library ; Intelligence Index 13 et
  264 tokens/s vérifiés sur la fiche Artificial Analysis, pas sur un résumé de recherche qui donnait aussi
  « 24 » pour une autre version de l'index). Sa force est la vitesse (candidat Rapide sur une carte de 32 Go+),
  pas l'intelligence (13, comme qwen3.5:4b). **Sans score d'appel d'outils, il n'est choisi nulle part**
  (vérifié jusqu'à 48 Go de VRAM) : trop gros pour être testé dans cet environnement (15 Go de RAM, 21 Go de
  disque), jamais un score deviné.
  **Défaut de ma part trouvé en répondant à Léo** : qwen2.5-coder:14b était un modèle de Jaris mais manquait
  dans la COPIE des listes de `benchmark-models.mjs` — jamais testé lors de son analyse, sans que rien ne le
  signale. Test permanent `scripts/test-benchmark-candidates-sync.mjs` : tout modèle de Jaris doit être
  testable par le script, avec la même règle de débordement RAM (vérifié en retirant chaque ajout). **Leçon
  générale : une liste recopiée à la main entre deux fichiers qui ne peuvent pas s'importer finit toujours par
  diverger — un test qui compare les deux copies coûte moins cher qu'une analyse de plusieurs heures qui
  oublie un modèle.**

- **Bouton « Tester les modèles sans score » (étape 168, Léo : « remets le bouton pour Lightning et
  qwen2.5-coder:14b »).** Tout modèle ajouté après le retrait de l'analyse (étape 166) n'avait plus aucun moyen
  d'être mesuré, alors que Jaris ne choisit jamais un modèle sans score. Le bouton (Tous les modèles) ne teste
  QUE `getUnscoredModels()` — les modèles de Jaris sans aucun score (aujourd'hui G9v3-3B, qwen2.5-coder:14b,
  nemotron-3.5-lightning:30b, devstral-2:123b) — via `JARIS_ONLY_MODELS`, et ne choisit rien à la fin : le
  fichier `benchmark-nouveaux-modeles.md` (dossier de données) est envoyé par Léo et recopié à la main dans
  verified-tool-scores.md, la seule source des scores. Suivi volontairement réduit (barre, étape en cours, une
  ligne par modèle terminé) : l'ancien tableau listait les ~40 modèles « En attente » et faisait croire à Léo
  que tout allait être retéléchargé.
  **Piège évité en recalculant le budget avant de livrer** : la marge RAM du script (16 Go) laissait 8 + 32 -
  16 = 24 Go sur la machine de Léo, et Lightning pèse 25 Go — il aurait été « sauté (trop gros) » par le bouton
  même créé pour lui. Marge de 12 Go pour ce seul test ponctuel (la confirmation demande de fermer le reste) ;
  l'usage quotidien garde 16.
  **Piège dans mon propre test, attrapé en vérifiant qu'il mordait** : le premier test du filtre passait AUSSI
  sans le filtre — les autres modèles installés avaient déjà un score et étaient sautés de toute façon. Ajout
  d'un modèle installé sans score et non demandé : le test échoue bien sans le filtre.
  Régression : `node --test scripts/test-benchmark-cases.mjs scripts/test-hardwarescan-single-pool.mjs
  scripts/test-options-reorganization-ui.mjs`.

- **« sauté (trop gros ou téléchargement impossible) » ne disait pas lequel des deux (étape 169).** Léo : pour
  devstral-2:123b c'est normal, mais G9v3-3B (1,9 Go) « il y a assez de place ». Le script connaissait la vraie
  cause (message d'Ollama) mais ne la transmettait pas : le bouton affichait une phrase générique qui couvrait
  deux causes opposées. `##MODEL_SKIPPED## <modèle> <raison>` porte maintenant la vraie raison (« trop gros pour
  ce PC (~75 Go, 28 Go disponibles) » ou « téléchargement impossible : <message d'Ollama> »), affichée telle
  quelle et écrite dans une section « Modèles non testés » du fichier de résultats — même principe que pour les
  outils : relayer le vrai message plutôt qu'un résumé qui cache la cause. Cause probable pour G9v3-3B (import
  hf.co/) : Ollama 0.34.2, dont le téléchargement depuis Hugging Face est cassé (corrigé en 0.34.3, sortie le
  19/09/2026) — pas confirmé tant que Léo n'a pas relancé avec le message affiché.
  Régression : `node --test scripts/test-benchmark-cases.mjs` (téléchargement refusé par le faux Ollama : la raison
  suit le nom du modèle et figure dans le fichier ; vérifié en retirant la raison, le test échoue) et
  `scripts/test-options-reorganization-ui.mjs` (la raison s'affiche dans le suivi).

- **Après la mise à jour d'Ollama, le bandeau « Mettre à jour » restait jusqu'au redémarrage (étape 170, Léo :
  « ça fait la mise à jour mais le message ne se supprime pas et on peut refaire la mise à jour »).** Le chemin
  qui marche en pratique est l'installeur officiel : Jaris le lance, puis l'installation se termine PLUS TARD,
  dans la fenêtre d'Ollama. Or la page Options relisait le statut une seule fois, juste après le lancement —
  donc toujours « pas à jour » — et plus rien ne le relisait ensuite. Corrigé côté main :
  `watchOllamaInstallerCompletion` interroge la version locale toutes les 5 s (30 min max, minuteur `unref` pour
  ne jamais retenir Jaris) et relit le statut dès qu'elle change ; chaque nouveau statut est diffusé à l'écran
  (`onOllamaVersionStatus` → IPC `ollamaVersionStatusChanged`). Côté écran, `installerPending` masque le bouton
  pendant l'installeur (Léo le relançait, croyant que rien ne s'était passé) et affiche « Ollama est à jour
  (x.y.z) » à la fin — ou « n'a pas abouti » si l'installeur a été fermé sans installer, bouton rendu.
  **Leçon générale : une action qui se termine HORS de Jaris (installeur, élévation, autre fenêtre) ne peut pas
  être suivie d'une seule relecture juste après son lancement — il faut attendre l'effet réel (ici, la version
  qui change) et le diffuser, sinon l'écran affirme un état périmé jusqu'au redémarrage.**
  **Piège dans mon propre test** : le minuteur `unref` laissait Node s'arrêter PENDANT l'attente du test
  (« Promise resolution is still pending but the event loop has already resolved ») ; le test garde un minuteur
  normal actif le temps de l'attente.
  Régression : `node --test scripts/test-ollama-update-progress.mjs` (version qui change → statut diffusé ;
  installeur fermé → « pas à jour » revient ; `installerPending` renvoyé) et
  `scripts/test-options-reorganization-ui.mjs` (pas de second bouton pendant l'installeur, « à jour » sans
  redémarrer). Vérifiés en retirant chaque correctif.

- **Scores des modèles sans score, mesurés par Léo (étape 171, bouton « Tester les modèles sans score »,
  26/09/2026, test v4).** nemotron-3.5-lightning:30b 17/17, G9v3-3B 12/17, qwen2.5-coder:14b 3/3 en code ;
  devstral-2:123b sauté (75 Go, 59 Go disponibles). Réponses sans outil relues avant de recopier : toutes de
  vraies phrases (celles de G9v3-3B sont maladroites — « Je t'appelle Jaris » — mais comptent). Le 12/17 de
  G9v3-3B confirme le retrait de son ancien 6/6 (étape 166) : l'ancien test était bien trop flatteur.
  Effet sur les choix (règles inchangées) : Lightning devient Rapide sur les cartes de 32 Go et plus (264 tokens/s
  publiés, 17/17) ; aucun changement jusqu'à 24 Go — rien ne change pour la machine de Léo.
  **Piège évité** : le test du filtre `JARIS_ONLY_MODELS` utilisait Lightning et qwen2.5-coder:14b, sans score au
  moment de l'écrire ; une fois leurs scores recopiés, ils étaient sautés d'office et le test ne mesurait plus le
  filtre. Il force maintenant `JARIS_RETEST_ALL` pour ne plus dépendre du contenu de verified-tool-scores.md
  (vérifié : il échoue toujours sans le filtre).

- **Bouton « Tester les modèles sans score » retiré (étape 172, Léo : « enlève test »)**, comme l'analyse complète à
  l'étape 166 : ses résultats (étape 171) sont recopiés dans verified-tool-scores.md, seule source des scores.
  Retirés : UnscoredModelsTest.tsx et son CSS, les 3 canaux IPC, `testUnscoredModels`/`unscoredResultsPath`
  (benchmarkRunner.ts), `getUnscoredModels` (hardwareScan.ts), et le script de test de l'installeur. Gardés dans
  le script (outil de développement) : `JARIS_ONLY_MODELS`, la vraie raison des modèles sautés, la marge RAM
  réglable — tous couverts par test-benchmark-cases.mjs. Un test d'interface vérifie qu'aucun bouton « Tester »
  ni « analyse » ne revient dans « Tous les modèles ».

- **Génération d'images en local (étape 173, Léo : « existe-t-il des modèles locaux image » puis « oui » à
  stable-diffusion.cpp + FLUX.2 [klein] 4B)**. Licences vérifiées AVANT de choisir : sd.cpp MIT, FLUX.2 klein 4B
  Apache 2.0 ; Wan2GP écarté par Léo (« il vont devoir avoir une licence »), Qwen-Image-2.1 écarté après
  vérification (licence réservée à la recherche). Nouveau `imageGenerator.ts` : sd-cli.exe Vulkan (NVIDIA/AMD/
  Intel sans CUDA, 32 Mo) + 3 fichiers de modèle (~5 Go), téléchargés au premier dessin avec avancement dans le
  journal. **Tout est figé** : tag exact du programme, révision exacte de chaque fichier Hugging Face (jamais
  `main`), empreinte SHA-256 recalculée sur le fichier reçu AVANT de le mettre à son nom final — un fichier
  présent sous son nom final est donc toujours complet et vérifié (la taille suffit ensuite). Décompression par
  `tar.exe` de Windows via execFile, description passée en UN argument de `spawn` (jamais un shell), chevrons
  retirés (sd.cpp lit `<lora:…>` dans le texte comme un fichier à charger). La carte graphique est libérée AVANT
  le dessin (`unloadOllamaModels` : `/api/ps` puis `keep_alive: 0`, méthode documentée d'Ollama), et le résultat
  court-circuite la conversation comme look_at_screen : recharger le modèle de conversation sur la carte qu'on
  vient de libérer, pour une phrase, serait absurde. Chat : l'image s'affiche en grand sous la réponse et se
  réaffiche après un redémarrage (seul son NOM de fichier est écrit dans l'historique, relu uniquement dans
  `generated-images` — jamais un chemin venu du disque). Voix : l'image s'ouvre dans la visionneuse de Windows.
  Les images suivent les données de Léo (`OWNED_ENTRIES`), le moteur suit « Déplacer » (nouvelle brique).
  **Vérifié POUR DE VRAI avant d'écrire le code** (sd.cpp compilé pour processeur sur le conteneur, fichiers
  réellement téléchargés, empreintes conformes) : la commande documentée produit bien une image (6 min sur
  processeur en 512 px). **Et une vraie surprise** : « un chat roux assis sur un canapé bleu » en FRANÇAIS a
  dessiné un CHIEN. D'où la description demandée en ANGLAIS au modèle (paramètre de l'outil + consignes).
  **Leçon générale : un modèle « multilingue » sur le papier ne l'est pas forcément dans un usage précis —
  essayer la vraie phrase de l'utilisateur, dans sa langue, avant de décider du format d'entrée.**
  Conséquence assumée : l'outil s'ajoute aux copies d'outils/consignes du script de test des modèles (15 outils
  au lieu de 14) ; les scores existants ont été mesurés avec 14 outils — écart jugé minime, pas de remesure.
  Piège revécu : le test d'interface du Chat lit le CSS COMPILÉ (`out/renderer`) — sans `npm run build` avant,
  il vérifie l'ancien style et échoue (ou pire, passe) sur un état qui n'est plus le code.
  **Non vérifiable ici, à confirmer par Léo** : la vitesse et la mémoire réelles sur sa carte (Vulkan, 1024 px),
  et la qualité perçue. Régression : `node --test scripts/test-image-generation.mjs` (+ chat-session-restore,
  chat-conversations-ui, models-location) ; chaque garde vérifiée en réintroduisant son défaut.

- **Ligne « Image » dans Options → Modèles (étape 174, Léo : « dans model ajoute image et met le seul image, et
  si pas assez de puissance met aucun model »)**. Un seul modèle d'image (FLUX.2 klein 4B), affiché sous Code,
  ou « Aucun modèle » avec la raison en une phrase. Décision dans un module PUR partagé (`shared/imageModel.ts`,
  `pickImageModel`) : la MÊME fonction décide de l'affichage (canal IPC getMyModelPicks, sur le matériel déjà
  détecté pour les autres rôles) et du refus dans `generateImage` — deux copies du seuil auraient fini par
  diverger (leçon de l'étape 72/82 : un même état décidé à deux endroits se contredit toujours un jour). Le refus
  arrive AVANT tout téléchargement : 5 Go pour une machine qui ne pourra jamais dessiner seraient perdus.
  **Seuils CALCULÉS, pas mesurés** (aucune carte ici) : avec `--offload-to-cpu`, un seul morceau monte à la fois
  sur la carte (~2,5 Go + calculs 1024 px, ~4 Go au plus fort) → 6 Go de VRAM minimum ; ~5 Go de poids en RAM
  pendant le dessin → 16 Go de RAM. Seuils posés à 5,5/15 parce que Windows lit une carte « 6 Go » à 5,8-6 et
  un PC « 16 Go » à ~15,8 : un seuil écrit avec le chiffre de la boîte refuserait exactement les machines visées.
  Limite connue : seul nvidia-smi détecte la carte, donc une carte AMD donne « Aucun modèle » alors que Vulkan
  saurait l'utiliser — même limite que le choix des autres modèles, pas corrigée ici. « Pas géré par Ollama :
  téléchargé au premier dessin » tant que les fichiers ne sont pas sur le disque (`isImageModelInstalled`) : le
  message « vérifié auprès d'Ollama, bien installés » juste dessous ne doit pas laisser croire le contraire.
  Pas de vitesse/intelligence/fiabilité sur cette ligne (« — ») : ces mesures ne concernent que les modèles de
  texte. `detectGpu` (hardwareScan.ts) est désormais exporté pour ce refus. Régression :
  `node --test scripts/test-image-generation.mjs scripts/test-options-reorganization-ui.mjs`.

- **Le modèle d'image s'installe avec les autres, plus jamais au premier dessin (étape 175, Léo : « il doit pas
  s'installer au premier dessin mais dans la page model comme tout les model si pas présent »)**. REMPLACE ce
  que disaient les étapes 173-174 (« téléchargé au premier dessin »). `installImageModel` (imageGenerator.ts) est
  appelé par `runQuickSetup` — écran d'accueil ET « Retester la configuration » —, juste après les modèles
  Ollama, seulement si `pickImageModel` dit que la machine le fait tourner. `generateImage` ne télécharge plus
  RIEN : modèle absent → message qui renvoie vers Options → Modèles → « Retester la configuration ». La ligne
  « Image » affiche le même « Pas installé sur ce PC pour l'instant — clique « Retester la configuration » »
  que les modèles Ollama absents. Un échec d'installation de l'image ne fait jamais échouer le reste de la
  configuration (les modèles de conversation passent avant) : il est rapporté à part (`CapacityScanResult.image.error`),
  jamais mélangé aux `skippedModels` dont le texte (« Jaris utilisera un repli moins bon ») serait faux pour
  l'image — il n'y a pas de repli. `isImageModelInstalled` vérifie maintenant aussi le MOTEUR (bonne version),
  pas seulement les trois fichiers : une nouvelle version de Jaris qui change de moteur redemande l'installation
  au lieu de lancer l'ancien. **Leçon générale : « comme tous les modèles » veut dire le MÊME chemin
  d'installation, pas seulement la même ligne à l'écran — un modèle affiché comme les autres mais installé
  autrement (au premier usage) surprend exactement au pire moment, en pleine demande.** Piège attrapé en
  lançant la suite : une boucle d'attente non bornée dans un test (`while (!lastSpawn)`) tournait à l'infini dès
  que le code refusait de dessiner — toute attente dans un test doit être bornée et échouer avec un message.
  Régression : `node --test scripts/test-image-generation.mjs scripts/test-benchmark-runner-cleanup.mjs
  scripts/test-options-reorganization-ui.mjs`, chaque garde vérifiée en réintroduisant son défaut.

- **Le petit Jaris n'apparaissait que par le bouton « réduire » (étape 176, Léo : « si je clique sur une autre
  application il disparaît sans widget, si je clique sur une autre application en bas il disparaît sans widget,
  si je fais raccourci capture d'écran il disparaît sans widget… il montre le widget que quand je diminue la page
  avec le bouton »)**. Il a fallu TROIS questions à choix simples pour arriver à cette phrase : ma première
  lecture (« widget invisible car pas redessiné ») était fausse — la réduction, qui affiche le MÊME widget par le
  MÊME code, marchait. **Leçon générale : quand un chemin marche et un autre non, et qu'ils appellent le même
  code, la cause est dans ce qui les DIFFÉRENCIE (ici le moment de l'appel), pas dans le code partagé — chercher
  la différence avant de corriger le code commun.** Différence ici : 'blur' arrive EN PLEIN changement de fenêtre
  active de Windows (l'autre appli prend la main) ; 'minimize' non. Le widget, affiché à cet instant avec `show()`
  (qui tente de prendre le focus), entrait en conflit avec la bascule. Corrigé : la grande fenêtre se cache tout
  de suite, le widget s'affiche 80 ms plus tard (`revealWidgetAfterLeaving`), avec `showInactive()` (ne reprend
  jamais le focus à l'appli cliquée ; la barre Chat, qui a besoin du clavier, garde `show()` + `focus()`), puis
  on VÉRIFIE 400 ms après qu'il est bien visible et on le réaffiche une fois sinon — un widget absent laisse
  Jaris joignable seulement près de l'horloge. « Toujours au-dessus » réaffirmé à chaque affichage. Rien si la
  grande fenêtre est revenue entre-temps, ni en mode Code (aucun widget, à dessein). **Non vérifiable ici (pas
  de Windows) : que ce soit bien la cause exacte — le mécanisme est déduit de la seule différence entre les deux
  chemins, à confirmer par Léo en usage réel.** Régression : `node --test scripts/test-widget-mode.mjs`
  (structurel), vérifié en remettant l'affichage direct puis `show()`.

- **Suite de l'étape 176 : toujours aucun widget après Windows + Maj + S sur la page Agent vocal, en v0.16.35
  (étape 177)**. Le report de 80 ms + `showInactive` ne suffisait donc pas (ou n'était pas la cause). Hypothèse
  retenue, cohérente avec TOUS les faits donnés par Léo (réduire marche ; clic sur une autre appli, barre des
  tâches, capture d'écran non ; « rien nulle part ») : Chromium calcule lui-même si une fenêtre est RECOUVERTE
  (`CalculateNativeWinOcclusion`) et arrête de la dessiner ; le widget, affiché au moment où l'écran figé de la
  capture ou l'appli cliquée le recouvre, était marqué « recouvert » — et une fenêtre TRANSPARENTE non dessinée est
  invisible, sans se redessiner une fois découverte. Réduire ne met rien par-dessus : seul chemin qui marchait.
  Corrigé par trois gardes complémentaires : commutateur `disable-features=CalculateNativeWinOcclusion` posé
  avant `ready` (Jaris n'a que deux fenêtres, ce calcul ne lui apporte rien), `backgroundThrottling: false` sur
  le widget, et `webContents.invalidate()` à chaque affichage. **Leçon générale : pour une fenêtre transparente,
  « pas dessinée » et « pas affichée » se voient pareil — chercher aussi du côté du moteur de rendu quand Windows
  dit que la fenêtre est bien là.** Toujours NON vérifié sur Windows.
  Même étape, demande de Léo : « dans code et option il y a aucun widget, ça veut dire qu'ils doivent pas
  disparaître dès que je fais moins… pour le rouvrir on doit aller à côté de l'horloge ». `hasWidgetToShow()`
  (mode ≠ Code et Options fermées) garde maintenant 'minimize' ET 'blur' : sans widget pour le remplacer, Jaris
  se réduit comme une application normale et reste dans la barre des tâches ; `showFullWindow` restaure une
  fenêtre réduite (show() seul ne la rouvre pas). **Leçon : une fenêtre ne doit disparaître de la barre des tâches
  que si quelque chose la remplace à l'écran — sinon l'utilisateur la croit fermée.** Régression :
  `node --test scripts/test-widget-mode.mjs scripts/test-quit-blur-guard.mjs`, gardes vérifiées en les retirant.

- **Capture d'écran (Windows + Maj + S) : le widget disparaissait encore, et ne revenait jamais (étape 178)**.
  En v0.16.36 tout le reste marchait (réduire, autre appli, barre des tâches, Code/Options). Deux réponses à choix
  simples de Léo : pendant la capture il voit encore la page Jaris (l'écran figé est une PHOTO prise avant), et
  après la capture le widget ne revient jamais, même en cliquant ailleurs. Après deux hypothèses sur la cause
  (report hors de la bascule de focus, calcul de recouvrement de Chromium) qui ont réglé les autres chemins mais
  pas celui-ci, pas de 3e hypothèse invérifiable sans Windows : `watchWidgetPresence` CONSTATE l'état réel chaque
  seconde — grande fenêtre cachée + widget attendu (`hasWidgetToShow`) → widget absent : remis ; « visible »
  pour Windows : réaffiché sans voler le focus (`showInactive`), remis au premier plan, redessiné (sans effet
  quand tout va bien). **Leçon générale, même famille que SearXNG (étape 103) et le rangement du stockage : quand
  un état peut être cassé par un chemin qu'on ne voit pas (ici un outil de Windows, sans évènement côté Jaris),
  un contrôle périodique de l'état réel vaut mieux qu'une hypothèse de plus sur l'évènement manquant.** La cause
  exacte reste inconnue ; le correctif ne dépend pas d'elle. Non vérifié sur Windows. Régression :
  `node --test scripts/test-widget-mode.mjs` (surveillance lancée au démarrage, jamais en Code/Options, jamais
  par-dessus la grande fenêtre, jamais de vol de focus).

- **Licences, mot d'activation et command-r (étape 179, Léo : « supprime command-r:35b en plus il est nul ;
  devstral-2:123b on le garde, on va pas faire plus de 20 millions ; pour le mot d'activation trouve une autre
  alternative, et le hey Jaris marche une fois sur 20 »)**. Audit des licences fait sur les fiches Hugging Face
  (API `huggingface.co/api/models/<dépôt>`, champ `cardData.license`), pas de mémoire : quasiment tout est
  Apache 2.0/MIT ; command-r = CC-BY-NC 4.0 (retiré : candidats, index d'intelligence, script de test, scores) ;
  devstral-2 = MIT modifiée (> 20 M$/mois interdit, gardé sur décision de Léo) ; Parakeet v3 = CC-BY 4.0 ;
  Supertonic = OpenRAIL ; **les deux modèles openWakeWord livrés (melspectrogram, embedding) = CC BY-NC-SA 4.0**
  selon le README d'openWakeWord (« All of the included pre-trained models »), non commerciaux.
  **Le mot d'activation ne passe plus par aucun détecteur** : chaque phrase entendue est découpée
  (`WakeSegmenter`, wake_confirmation.py : départ au premier son fort avec 320 ms gardés avant, fin après 560 ms
  de silence, rien sous 240 ms de son, 6 s au plus) puis transcrite par Parakeet, déjà chargé ; seul le NOM dans
  le texte (`WAKE_NAME`) réveille Jaris. Le détecteur supprimé était le premier des DEUX filtres en série, strict
  (0,995) et entraîné sur des voix de synthèse ; la transcription reconnaissait déjà 46 « Jaris » sur 50 (voix de
  synthèse, étape 158) — goulot DÉDUIT, pas mesuré sur la voix de Léo. **Leçon générale : quand deux filtres sont
  en série, le taux de réussite est le PRODUIT des deux — un second filtre fiable ne rattrape jamais un premier
  qui laisse passer une fois sur vingt ; supprimer le mauvais vaut mieux que régler les deux.** « Jaris, ouvre
  YouTube » d'une traite : la phrase et son silence final comptent déjà, pas d'attente en plus ; « Jaris » seul :
  le délai de silence repart de zéro (Léo attend l'orbe). Rien n'est journalisé des phrases sans le nom : toute
  la pièce est transcrite, localement, et ça ne doit laisser aucune trace. Coût assumé : chaque phrase entendue
  est transcrite (Parakeet sur processeur, ~0,26 s pour 5 s de parole mesurés à l'étape 158) ; l'option
  « En disant Jaris » d'Options l'arrête complètement. Supprimés : wakeword.py, python/models/*.onnx, le filtre
  `models/*.onnx` d'electron-builder.yml, check-packaged-wakeword.py (remplacé par check-packaged-voice.py, qui
  échoue si un .onnx est encore livré). **Non vérifié sur la voix réelle de Léo** : à confirmer en usage réel.
  Régression : `python scripts/test-wake-confirmation.py` (découpage + câblage de voice_server.py, aucune phrase
  sans le nom journalisée), vérifié en retirant le pré-roll puis le seuil de son minimal.

- **Test du mot « Jaris » dans Options → Voix (étape 180, Léo : « ça marche vraiment mieux mais on peut pas
  améliorer, ça marche 1 fois sur 3 »)**. De 1 sur 20 à 1 sur 3 avec l'étape 179 ; pour aller plus loin, il faut
  savoir POURQUOI les deux autres ratent, et deux causes très différentes sont possibles : le son n'est même pas
  retenu comme une phrase (trop court/trop faible pour `WakeSegmenter`), ou Parakeet écrit autre chose que ce que
  `WAKE_NAME` accepte. Aucune n'est devinable d'ici, et « Candidat rejeté » n'est plus journalisé depuis
  l'étape 179 (confidentialité). Plutôt qu'une 3e retouche à l'aveugle d'un seuil : un test déclenché par Léo
  lui-même (bouton « Tester le mot « Jaris » »), qui renvoie pour chaque phrase entendue ce qui a été compris,
  si le nom a été reconnu, le volume, et « trop court » quand le son a été écarté (`WakeSegmenter.dropped`) —
  sans jamais réveiller Jaris pendant le test. Commandes sidecar `test-wake`/`stop-test-wake`, évènement
  `wake_test_heard`, canal IPC `wakeTestHeard`. Les phrases ne sont montrées QUE pendant ce test demandé,
  jamais en écoute normale. **Leçon générale, même que la saga SearXNG : quand un correctif améliore sans
  suffire et que la cause restante n'est pas observable, construire l'outil qui la rend observable avant de
  toucher un seuil de plus.** Prochaine étape selon les résultats de Léo : élargir `WAKE_NAME` (texte mal compris)
  ou assouplir `MIN_LOUD_CHUNKS`/`SILENCE_RMS_THRESHOLD` (son écarté). Régression :
  `python scripts/test-wake-confirmation.py` (test jamais réveillant, son court gardé à part),
  `node --test scripts/test-options-reorganization-ui.mjs` (lignes, compte, arrêt réel).

- **« Jaris » dit seul : formes proches acceptées, mesurées sur la VRAIE voix de Léo (étape 181)**. Premier
  résultat du test d'Options (étape 180) : 12 « Jaris », volume 100 % à chaque fois (le son n'était PAS en cause),
  2 reconnus. Parakeet écrivait « Jeis », « Rice? », « J'ai ce », « Jazz », « Jaice. » ×2, « Rice. », « Nice. »,
  « Rice », « Jais. » : un mot isolé si court n'a aucun contexte, et sonne comme de l'anglais. `SHORT_WAKE_NAME`
  accepte « J + a/ai/e/ei + R/S/Z/C/X + 0 à 3 lettres », mais UNIQUEMENT quand toute la phrase, compactée (sans
  espaces ni apostrophes ni ponctuation), se réduit à ce mot : « j'ai ce livre sur la table » ne réveille jamais
  Jaris, `WAKE_NAME` strict reste seul juge dans une phrase. 8 sur 12 sur ses propres transcriptions (2 avant).
  « Rice »/« Nice » (J perdu) volontairement refusés : sans J, rien ne les distingue de vrais mots. Conséquence
  assumée : « Jarvis », « Jerry », « Jardin » DITS SEULS réveillent aussi Jaris (déjà annoncé pour Jarvis dans
  Options) ; « J'arrive ! » seul reste refusé. **Leçon générale : pour une reconnaissance sur une voix précise,
  une seule série de VRAIES mesures vaut mieux que toutes les voix de synthèse — les 50 échantillons TTS de
  l'étape 158 donnaient 46/50, la voix réelle 2/12 avec la même règle.** Régression :
  `python scripts/test-wake-confirmation.py` (les 12 transcriptions réelles, et jamais dans une phrase), vérifié
  en laissant la forme souple s'appliquer au premier mot d'une phrase.

- **« Jaris » transcrit en cyrillique (étape 182, Léo : « il met souvent Compris « Жайс. » »)**. Parakeet v3 devine
  seul la langue ; un mot isolé si court est parfois pris pour du RUSSE et écrit en cyrillique — il échappait
  alors à toute comparaison (aucune lettre latine). « Жайс » se lit « jaïs », forme déjà acceptée à l'étape 181 :
  les lettres cyrilliques sont ramenées à leur son en lettres latines, à la française (Ж → « j »), avant la
  comparaison uniquement — jamais dans le texte transcrit lui-même. Du vrai russe dans une phrase ne réveille
  toujours pas Jaris. **Leçon générale : un modèle de transcription multilingue qui devine la langue peut changer
  d'ALPHABET sur un mot court — toute comparaison de texte en aval doit d'abord ramener l'écriture à celle qu'on
  attend.** Régression : `python scripts/test-wake-confirmation.py` (vérifié en retirant la conversion).

- **Le détecteur de « Jaris » n'écoute plus qu'en mode Agent vocal, Options fermées ; « Rice » accepté (étape 183,
  Léo : « le détecteur de voix doit être actif que quand on est en vocal, et pas chat ni code ni option, et ajoute
  Rice »)**. Depuis l'étape 72, Chat/Code ne faisaient qu'IGNORER les évènements côté Electron (`suspended`) : le
  sidecar, lui, transcrivait toujours chaque phrase entendue (étape 179) — du travail processeur et une écoute
  que Léo ne veut pas. `setListeningSuspended` envoie maintenant `pause-wake`/`resume-wake` au sidecar, qui ne
  transcrit plus rien en pause (une phrase commencée est oubliée). Les Options comptent aussi
  (`activeMode !== 'voice' || optionsOpen`, réappliqué à chaque ouverture/fermeture). Le test du mot « Jaris »
  d'Options passe AVANT la pause dans voice_server.py : il marche donc pendant que les Options sont ouvertes.
  **Piège évité** : un sidecar redémarré (changement de micro, option « En disant Jaris ») repartait en écoute —
  `VoiceClient` retient l'état et le réécrit dès le lancement (les lignes attendent dans le tube jusqu'à la fin du
  chargement). **Leçon générale : « ignorer » un résultat n'est pas « arrêter » le travail qui le produit — quand
  l'utilisateur demande qu'une écoute soit inactive, couper la source, pas seulement le bout de la chaîne.**
  « Rice » dit seul rejoint `SHORT_WAKE_NAME` (sa transcription la plus fréquente après « Jaice », 4 sur 12) :
  11 sur 12 sur ses transcriptions réelles ; « Nice » (la ville) et « Rice » dans une phrase restent refusés.
  Régression : `python scripts/test-wake-confirmation.py`, `node --test scripts/test-widget-mode.mjs`.

- **Accents ignorés pour « Jaris », test d'Options retiré (étape 184, Léo : « ajoute Jáis, et enlève le test de
  Jaris »)**. « Jáis » : plutôt que d'ajouter une graphie de plus, les accents sont retirés avant la comparaison
  (`unicodedata`, décomposition NFD), comme l'alphabet cyrillique à l'étape 182 — « Jáis », « Jàis », « Jaïs »
  redeviennent « jais », déjà accepté. **Même leçon que PROMISE_WITHOUT_ACTION : ramener le texte à une forme
  commune bat l'ajout de variantes une par une.** Le test du mot « Jaris » (étape 180) a rempli son rôle — il a
  donné les vraies transcriptions (Jaice, Jais, Rice, Жайс, Jáis) — et il est retiré partout : bouton et liste
  d'Options, canaux IPC `testWakeWord`/`stopTestWakeWord`/`wakeTestHeard`, `WakeTestHeardPayload`, commandes
  `test-wake`/`stop-test-wake` et évènement `wake_test_heard` du sidecar, `WakeSegmenter.dropped` qui n'existait
  que pour lui. Les entrées 180-183 plus haut restent : elles décrivent ce qui a été mesuré avec. Régression :
  `python scripts/test-wake-confirmation.py` (accents, test absent du sidecar), `node --test
  scripts/test-options-reorganization-ui.mjs` (plus de ligne « Tester le mot »).

- **Icône « Télécharger » sur les images dessinées (étape 185, Léo : « met une petite icône à côté des images
  générées pour la télécharger et ça demande où télécharger »)**. Bouton posé dans le coin haut-droit de l'image
  (`.chat-panel__save-image`, `DownloadIcon` dans icons.tsx), qui ouvre la fenêtre « Enregistrer sous » de Windows
  (`dialog.showSaveDialog`, canal `saveGeneratedImage`), dossier Images proposé, nom daté. Le renderer envoie
  l'image qu'il AFFICHE (data URL) — il n'a jamais besoin du chemin sur le disque — et le main n'accepte qu'un
  vrai PNG (préfixe ET signature des 8 premiers octets, `imageSave.ts`, pur et testé) ; c'est Léo qui choisit
  où écrire. Même garde `dialogOpen` que `pickImageFile` (sinon la fenêtre de Windows fait perdre le focus et
  replie Jaris en widget, étape 93) : test-native-dialog-guard.mjs vérifie désormais aussi `showSaveDialog`.
  ✓ affiché 2 s seulement si l'image a VRAIMENT été écrite — une annulation n'affiche rien, un échec
  d'écriture affiche son message. **Piège attrapé par le test de mise en page, pas en relecture** : l'image de
  test faisait 8 px, trop petite pour contenir le bouton — le test fabrique maintenant un vrai PNG de 256 px
  (zlib), taille réaliste, plutôt que d'assouplir la vérification. Régression : `node --test
  scripts/test-image-save.mjs scripts/test-native-dialog-guard.mjs scripts/test-chat-conversations-ui.mjs`.

- **Test du mot « Jaris » remis dans Options → Voix (étape 186, Léo : « remets le test de Jaris pour tester »)**,
  retiré à l'étape 184. Restauré en appliquant à l'envers la partie « retrait » du commit de l'étape 184
  (`git diff <commit>^ <commit> -- <fichiers>` puis `git apply -R --3way`), fichier par fichier — et PAS par un
  `git revert` du commit entier, qui aurait aussi défait la suppression des accents faite dans le même commit.
  **Leçon générale : quand un commit mélange deux changements et qu'un seul doit être annulé, inverser le diff
  des seuls fichiers concernés (puis reprendre à la main les fichiers mixtes) plutôt que réécrire de mémoire** —
  le code rétabli est exactement celui qui avait été testé. Le test garde tout ce qui a été ajouté depuis :
  accents, cyrillique, « Rice », et il passe AVANT la pause d'écoute (il marche Options ouvertes). Régression :
  `python scripts/test-wake-confirmation.py`, `node --test scripts/test-options-reorganization-ui.mjs`.

- **Test du mot « Jaris » : tableau regroupé (étape 187, Léo : « fais un tableau avec par exemple réussi 10, Jain
  5 fois, Onal 10 fois »)**. La liste d'une ligne par essai (12 dernières) devient un tableau : « Reconnu » avec le
  nombre de réussites, puis chaque mot mal compris avec son nombre de fois, le plus fréquent d'abord, puis « Son
  trop court » / « Rien compris ». `groupWakeHeard` (OptionsMenu.tsx, pur) regroupe sans tenir compte de la
  ponctuation finale ni de la casse (« Rice. », « Rice? », « rice » = une ligne). Plus de coupure à 12 essais
  (plafond de 500) : un test long doit compter TOUS les essais, sinon les chiffres seraient faux. **Leçon : pour
  décider quoi corriger, le classement des ratés par fréquence vaut mieux qu'un fil chronologique — c'est le mot
  le plus fréquent qui mérite d'être accepté en premier.** Régression : `node --test
  scripts/test-options-reorganization-ui.mjs` (regroupement, ordre, couleurs, arrêt).

- **Test micro muet chez un ami de Léo (étape 188 : « son micro n'est pas détecté, il parle, Jaris n'entend
  rien » — le test audio d'Options, pas le test du mot « Jaris »)**. Cause exacte chez lui non confirmée (pas
  d'accès à sa machine) : plutôt qu'une hypothèse de plus, le test DIT maintenant ce qui se passe. Deux angles
  morts réels, trouvés en relisant le chemin du test : (1) le test était envoyé au programme d'écoute sans vérifier
  qu'il tournait — au premier lancement il télécharge encore la transcription (~2,5 Go), ou il a pu s'arrêter sur
  « impossible d'ouvrir le micro » ; la commande restait alors sans réponse et l'écran affichait des barres vides,
  exactement comme un micro muet. `VoiceClient` suit maintenant son état (chargement/prêt/échec/arrêté) et le test
  (micro ET mot « Jaris ») renvoie la raison, avec le VRAI message d'erreur relayé tel quel ; (2) « Rien capté »
  ne distinguait pas un micro trop faible d'un flux VIDE : un vrai micro a toujours un léger souffle, jamais des
  zéros parfaits — un test entièrement à zéro (≥ 400 ms, `silentStream`) désigne Windows (micro coupé, ou accès
  refusé aux applications de bureau dans Confidentialité → Microphone). **Leçon : une commande envoyée à un
  process qui ne répond pas encore doit vérifier son état AVANT, sinon « aucune réponse » se lit comme « rien
  entendu » — et quand la cause est inconnue chez un tiers, livrer un diagnostic qui la nomme vaut mieux qu'un
  correctif deviné.** Régression : `node --test scripts/test-voice-listening-status.mjs
  scripts/test-options-reorganization-ui.mjs` (états suivis, vrai message relayé, arrêt voulu ≠ échec ; à l'écran :
  raison affichée, bouton non bloqué, messages silence total / trop faible / détecté), chacun vérifié en
  réintroduisant le défaut. Non vérifiable ici : la partie Python (numpy absent) — relue et syntaxe vérifiée.

- **Montage vidéo avec Remotion (étape 189, Léo : « un bouton montage à gauche qui n'est pas installé par
  défaut, faut cliquer et il te dit que c'est lourd, et ça fait avec Remotion »).** Nouveau mode « Montage »
  dans la colonne de gauche. Tant qu'il n'est pas installé, l'écran dit ce qu'il fait, ce qu'il pèse (mesuré :
  ~85 Mo de paquet + ~100 Mo de navigateur téléchargés, ~520 Mo sur le disque, annoncés « environ 200 Mo /
  600 Mo ») et la licence de Remotion (vérifiée sur son LICENSE.md : gratuite pour un particulier ou une
  entreprise de 3 personnes au plus, PAS un logiciel libre) — rien n'est téléchargé sans clic.
  **Architecture, décidée par une contrainte : Léo n'a ni Node ni npm.** Remotion est un ensemble de paquets npm
  avec des programmes natifs (compositeur + FFmpeg, esbuild, rspack). La CI Windows installe donc le paquet exact
  (`montage/package-lock.json`, Remotion figé à 4.0.529 — la constante, le paquet et le lockfile sont vérifiés
  identiques par un test), le zippe et le publie avec chaque Release (`Jaris-Montage-remotion-X.zip`) ; Jaris le
  télécharge depuis la Release de SA version, puis Remotion télécharge son propre navigateur. Le rendu tourne avec
  le Node embarqué dans Electron (`process.execPath` + `ELECTRON_RUN_AS_NODE=1`) via `montage/render.cjs`, livré
  avec Jaris (extraResources) : il reçoit sa tâche par un fichier JSON, jamais par la ligne de commande, et
  répond une ligne JSON par évènement. **La CI fabrique une vraie vidéo avec Jaris.exe avant de publier** : un
  paquet qui ne sait pas filmer n'est jamais mis en ligne.
  **Deux pièges de Remotion trouvés en le faisant tourner pour de vrai ici** : (1) webpack ne cherche les modules
  qu'en remontant depuis le fichier importé — un projet rangé dans les données de Léo ne trouve ni `remotion` ni
  `react` sans `webpackOverride` qui ajoute le dossier du paquet à `resolve.modules` ; (2) Remotion range son
  navigateur dans `node_modules/.remotion` du premier dossier PARENT du dossier courant qui a un package.json —
  le rendu doit donc démarrer dans le dossier du paquet, avec son package.json, sinon il ne retrouve pas le
  navigateur déjà téléchargé.
  **Génération** : le modèle du mode Code écrit une composition Remotion (TSX). Le moteur d'étapes du mode Code
  (`createModelStepRunner`, extrait de `generateApp` pour être partagé plutôt que recopié) donne le même bandeau
  d'avancement et le même bouton « Arrêter ». Avant le rendu, les défauts mécaniques sont nommés au modèle
  (imports autres que remotion/react — aussi une question de sécurité, webpack embarquerait sinon n'importe quel
  fichier du disque —, URL, Math.random/Date/setTimeout, animations CSS que Remotion ne filme pas). Après une
  VRAIE erreur de Remotion, sa ligne utile (sans chemins du disque ni pile) est renvoyée au modèle, deux fois au
  plus. Une vidéo ratée ou arrêtée ne reste pas dans la liste. **Défaut attrapé par mon propre test** : après une
  correction, le second rendu s'affichait « étape 4 sur 3 » (même règle que le mode Code : un rendu de plus est
  une étape de plus, compté au moment où il arrive).
  **Leçon générale : quand une dépendance ne peut pas être installée chez l'utilisateur de la façon normale (ici
  npm), la construire là où elle peut l'être (la CI, sur le bon système), la publier comme un artefact figé, ET
  la faire réellement tourner dans la CI avec le même exécutable que l'utilisateur — sinon rien ne prouve que
  le paquet publié marche une fois hors de la machine qui l'a construit.**
  Régression : `node --test scripts/test-montage.mjs` (dont un rendu Remotion RÉEL de bout en bout, modèle
  simulé qui écrit d'abord un code cassé : l'erreur réelle est renvoyée, le code corrigé, un vrai MP4 fabriqué ;
  et « Arrêter » pendant le rendu ; ignorés avec leur raison si le paquet n'est pas installé localement, comme en
  CI avant sa construction) et `scripts/test-montage-panel-ui.mjs` (vrai navigateur : aucune installation sans
  clic, poids et licence affichés, avancement, lecteur vidéo, bouton habillé par le CSS, pas de bouton image,
  désinstallation confirmée dans la page). Non vérifié en usage réel : la vitesse du rendu et la qualité des
  vidéos écrites par le modèle Code sur la machine de Léo.

- **Monter SES vidéos dans le Montage (étape 190, Léo : « on peut pas lui envoyer une vidéo pour qu'il la
  monte… comme Claude Code avec Remotion : prendre la vidéo, cut, mettre animation, du texte »).** Bouton
  « Vidéos » dans le champ du Montage (dialogue Windows ouvert par le main, sous le garde `dialogOpen`, plusieurs
  fichiers mp4/mov/m4v/webm/mkv/avi). **Le chemin ne quitte jamais le main** : l'écran ne reçoit qu'un
  identifiant, et la fabrication n'accepte que des identifiants sortis de ce dialogue — un chemin venu de l'écran
  aurait permis de faire copier n'importe quel fichier du disque dans un projet. Chaque vidéo est mesurée par le
  compositeur de Remotion (`getVideoMetadata`, nouvelle tâche `probe` de render.cjs), puis COPIÉE dans le projet
  (`public/clipN.ext`, nom choisi par Jaris) : le fichier de Léo n'est jamais modifié ni déplacé, et une
  modification reprend les vidéos du projet précédent sans qu'il les rejoigne (`montage.json`). Le modèle reçoit
  nom, durée et format de chaque vidéo, et la façon exacte de couper (`OffthreadVideo` + `trimBefore`/`trimAfter`,
  les noms actuels — `startFrom`/`endAt` sont dépréciés dans cette version de Remotion, vérifié dans ses types).
  `staticFile` n'est accepté que pour les vidéos réellement jointes, sous leur nom exact. Vidéo de téléphone
  (portrait) : montage vertical 1080x1920. Durée maximale portée de 60 s à 5 min.
  **Limite dite à Léo, pas cachée** : le modèle ne voit PAS les images de la vidéo (seulement sa durée et son
  format) — c'est Léo qui dit quels passages garder ; écrit sur l'écran d'installation, dans l'intro et dans « Ce
  que Jaris sait faire ».
  **Deux défauts de présentation trouvés sur capture, pas en relecture** : les pastilles des vidéos jointes
  flottaient en haut de l'écran, loin du champ avec lequel elles partent (le champ est poussé en bas par
  `margin-top: auto` : les pastilles doivent prendre ce `auto` à sa place) ; et l'intro parlait d'un bouton
  « Vidéos » qui n'était qu'une icône sans libellé.
  **La CI monte aussi une vraie vidéo sur Windows** (lecture de sa durée, puis coupe + texte par-dessus avec
  OffthreadVideo, fixture `scripts/fixtures/montage-clip`) : c'est le compositeur Windows qui extrait les images,
  un chemin que le rendu d'animation seul n'exerce pas.
  Régression : `node --test scripts/test-montage.mjs` (dont un montage RÉEL : durée lue, vidéo coupée à 1,5 s,
  fichier source intact, vidéo reprise à la modification, ancienne version gardée) et
  `scripts/test-montage-panel-ui.mjs` (pastille avec durée, identifiant envoyé et jamais un chemin, vidéo
  reprise au montage, retrait avant envoi).

- **Champ de saisie façon ChatGPT + effort de réflexion (étape 191, Léo : « change présentation comme chatgpt,
  pas exactement… mais même présentation, et ajoute effort et modèle »).** Le champ (Chat, Code, Montage) a
  désormais le texte en haut et une rangée en bas : « + » à gauche (menu « Ajouter » : image, ou vidéos en
  Montage), puis le sélecteur « Modèle · Effort » et un bouton d'envoi rond à droite. Le sélecteur ouvre un
  panneau avec un curseur à 5 crans (Aucune → Maximale), le nom du modèle (clic → liste « Par défaut » + rôles)
  et un retour à Auto. `ModelPicker.tsx` (menu déroulant de l'étape 141) est remplacé par `ModelEffortPicker.tsx`.
  **Le vrai défaut trouvé en préparant l'effort** : Jaris envoyait `think: "high"` à TOUS les modèles. Or chaque
  modèle a SES niveaux (vérifié sur les fiches officielles : qwen3.8 = off/low/medium/xhigh, défaut xhigh ;
  gpt-oss = low/medium/high ; granite4.2 = off/low/high ; la plupart = avec ou sans ; certains ne réfléchissent
  pas), et un niveau inconnu retombe sur le DÉFAUT du modèle — qwen3.8 réfléchissait donc au maximum sans que
  personne l'ait demandé, ce qui explique une partie des montages de 18 minutes de Léo. **Leçon générale : le
  badge « thinking » d'un modèle ne dit pas QUELS niveaux il accepte ; un paramètre commun envoyé à tous les
  modèles doit être traduit vers ce que chacun annonce (`/api/show` : `capabilities` + `thinking.values`),
  jamais supposé.** `shared/effort.ts` (pur, testé) traduit le cran choisi vers le niveau réel le plus proche
  (à égalité le plus haut ; « Aucune » = le plus bas niveau pour un modèle qui ne sait pas couper). Ollama muet
  ou choix Auto : rien n'est imposé (comportement d'avant), sauf « Aucune » qui coupe la réflexion, toujours
  sûr. Réglage enregistré par mode (`profile.effortChoices`), appliqué par la conversation, le mode Code et le
  Montage.
  **Piège déjà écrit ici, revécu** : `ollama.ts` importait `shared/effort` en TYPE seul (effacé à la
  compilation), puis en VALEUR une fois `parseModelThinking` déplacé dedans — les faux ponts de
  `test-codegen-context.mjs` et `test-montage.mjs` ne le fournissaient pas et 14 tests ont échoué d'un coup.
  Passer d'un `import type` à un import de valeur ajoute une dépendance réelle : `grep` les faux ponts.
  **Non vérifié ici** : contre un vrai Ollama (téléchargement bloqué dans cet environnement) — le calcul repose
  sur la documentation officielle de `/api/show` et les fiches des modèles ; le premier essai de Léo tranchera.
  Régression : `node --test scripts/test-effort.mjs` (niveaux réels de qwen3.8/gpt-oss/granite4.2, modèle sans
  réflexion intact, lecture tolérante de `/api/show` ; vérifié en réintroduisant l'envoi de « high » à tous) et
  `scripts/test-model-picker-ui.mjs` (vrai navigateur : disposition, menu « + », curseur, liste des modèles,
  niveaux réels affichés, curseur désactivé pour un modèle qui ne réfléchit pas).

- **« Pourquoi un petit éclair ? » + « faut d'abord choisir le modèle… on peut choisir un modèle qui a rien et
  choisir max » (Léo, étape 192) — le curseur commun de l'étape 191 était FAUX, et c'est lui qui l'a vu.**
  Une échelle commune à cinq crans (Aucune → Maximale) affichait des choix qui n'existent pas sur le modèle :
  « Maximale » sur un modèle qui ne réfléchit pas du tout, par exemple. Traduire vers le niveau le plus proche
  ne rendait pas le choix vrai, ça le rendait juste silencieusement différent de ce qui était affiché. L'éclair,
  lui, était une décoration sans aucun sens. **Leçon générale : un réglage ne doit proposer que ce que la chose
  réglée accepte vraiment ; une échelle « universelle » traduite en coulisses montre des choix qui n'existent
  pas, et l'utilisateur ne peut pas savoir lesquels.**
  Refait dans l'ordre demandé : le panneau montre d'abord « Modèle » (Auto + rôles), puis « Think · <modèle> »
  avec les SEULS choix que ce modèle annonce dans `/api/show` — ses niveaux (qwen3.8 : Auto · off · low ·
  medium · xhigh), ou off/on (qwen3.5, gemma4), ou une phrase et aucun bouton s'il ne réfléchit pas. En
  Chat/Vocal Auto, le modèle change selon la question : on dit de choisir un modèle d'abord. En Code, Auto est
  un seul modèle connu, ses vrais choix sont donc proposés.
  **Le réglage est lié au modèle pour lequel il a été choisi** (`profile.thinkChoices[mode] = {model, think}`,
  remplace `effortChoices`) : changer de modèle le remet en Auto (main.ts), et même un réglage resté en place
  n'est appliqué qu'au modèle d'origine et seulement s'il l'accepte encore (`chosenThink`). Le main revérifie
  aussi la valeur reçue de l'écran contre `/api/show` avant de l'enregistrer.
  Régression : `node --test scripts/test-effort.mjs` (un modèle sans réflexion n'a AUCUN choix, qwen3.8 n'a ni
  « high » ni « max », réglage ignoré sur un autre modèle ; vérifié en faisant tout accepter : 5 tests échouent)
  et `scripts/test-model-picker-ui.mjs` (vrai navigateur : plus d'éclair ni de curseur, « Modèle » avant
  « Think », vrais choix par modèle, « off » envoie false, changer de modèle efface la réflexion, choix sur une
  seule ligne et habillés par le CSS). **Non vérifié contre un vrai Ollama ici** (téléchargement bloqué).

- **Retour au panneau façon ChatGPT, mais honnête (étape 193, Léo, capture de ChatGPT à l'appui : « ça doit
  être un peu comme ça mais dès le début il y a le modèle, et si le modèle a think tu mets le petit icône
  raisonnement à la place de l'éclair, et s'il a des levels mettre la barre »).** L'étape 192 avait bien
  corrigé le fond (plus de choix inventés) mais changé la FORME que Léo voulait garder : une liste de modèles
  puis des pastilles. Le panneau reprend la forme de l'étape 191 (icône à gauche, niveau en titre, modèle en
  lien « › » en dessous, ↻ à droite, barre à crans), avec le fond de l'étape 192 :
  - le modèle est affiché dès l'ouverture (« Puissant · qwen3.8:27b › ») ; un clic ouvre la liste ;
  - modèle à niveaux → icône de raisonnement + barre, UN CRAN PAR NIVEAU RÉEL (qwen3.8 : off · low · medium ·
    xhigh — 4 crans, pas 5) ;
  - modèle avec ou sans → icône de raisonnement + interrupteur « Réfléchir avant de répondre », pas de barre ;
  - modèle qui ne réfléchit pas, ou Chat/Vocal en Auto → ni icône, ni barre, une phrase qui dit pourquoi.
  **Leçon générale : quand l'utilisateur critique un détail (« pourquoi un éclair », « on peut choisir max sur
  un modèle qui n'a rien »), corriger CE détail sans jeter la forme qu'il avait validée ; une refonte complète
  en réponse à une remarque ponctuelle répond à une question qu'il n'a pas posée.** Le backend de l'étape 192
  (réglage lié au modèle, revérifié par le main) est inchangé.
  Deux défauts vus sur capture, pas en relecture : l'icône de raisonnement, dans la couleur pâle de l'éclair,
  était presque invisible (passée en couleur d'accent) ; un nom de modèle long (hf.co/…) coupait la flèche
  « › » au lieu de se raccourcir lui-même (le nom a maintenant sa propre coupure, la flèche ne rétrécit plus).
  Régression : `scripts/test-model-picker-ui.mjs` (vrai navigateur : modèle affiché dès l'ouverture, icône
  seulement si le modèle réfléchit, barre avec exactement les niveaux réels, interrupteur pour avec/sans, rien
  pour un modèle sans réflexion, « off » envoie false, ↻ revient à Auto, barre habillée par le CSS).

- **« Mets pas un truc à cocher pour raisonnement mais cliquer directement sur le cerveau » + « les levels ça
  doit remplir avant, parce que c'est qu'un cercle » (Léo, étape 194, capture de ChatGPT à l'appui).**
  1. Modèle « avec ou sans » (gemma4, qwen3.5) : l'interrupteur de l'étape 193 est retiré, le CERVEAU lui-même
     est le bouton (`aria-pressed`) — allumé (accent + halo) = réflexion activée, éteint = coupée. Une phrase
     dit quoi faire (« Clique sur le cerveau… »), puisque rien d'autre n'indique qu'une icône est cliquable.
  2. La barre à niveaux se remplit de la gauche jusqu'au cran choisi, comme ChatGPT : un `::before` dont la
     largeur suit `--fill` (rang du cran / nombre de crans − 1), calculée pour s'arrêter pile au bord du disque
     choisi ; les points déjà passés deviennent clairs. En Auto (aucun cran choisi), rien n'est rempli.
  **Vu sur capture, pas en relecture** : le disque clair se perdait sur un remplissage cyan plein (deux
  couleurs trop proches) ; le remplissage est passé à l'accent à 55 %, le disque ressort.
  **Leçon générale : quand l'utilisateur montre une capture de référence, reproduire aussi l'ÉTAT visuel (ici :
  la partie déjà « acquise » de la barre), pas seulement les éléments — un curseur à un seul cercle ne dit pas
  « jusqu'où » on est, c'est le remplissage qui le dit.**
  Régression : `scripts/test-model-picker-ui.mjs` (vrai navigateur : aucun interrupteur/case pour un modèle
  avec/sans, un clic sur le cerveau envoie true puis false et son allure change ; le remplissage mesuré
  s'arrête au cran choisi pour low, medium et xhigh, et rien n'est rempli en Auto).

- **Trois retours sur le panneau de réflexion (étape 195, Léo, captures à l'appui) : « améliore encore un peu la
  barre », « quand le mode think n'est pas dispo enlève le cerveau », « ça met le nom complet du modèle, c'est
  bizarre ».**
  1. **La barre** reprend vraiment l'allure de ChatGPT : piste sombre SANS bordure, remplissage bleu PLEIN
     (`--hud-accent-deep`, déjà dans la palette) jusqu'au bord du disque choisi, disque BLANC pur avec une
     ombre. Le disque « presque blanc » (#e6f7ff) sur du cyan de l'étape 194 manquait de contraste : deux
     clairs l'un sur l'autre.
  2. **Le cerveau** : ma question à choix (« dans quel cas ? ») était mal posée — Léo : « faut juste mettre le
     cerveau quand le modèle peut raisonner ou pas… pour le Puissant il y a des levels mais il y a le
     cerveau ». Le cerveau veut dire « réfléchit ou pas » : il n'apparaît plus QUE pour un modèle avec/sans
     (où il est le bouton). Un modèle à niveaux a déjà sa barre, un modèle sans réflexion n'a rien. **Leçon :
     une question de clarification doit reprendre les mots de l'utilisateur et proposer des cas qu'il peut
     reconnaître à l'écran ; trois hypothèses techniques qu'il n'a pas formulées l'ont juste perdu.**
  3. **Le nom du modèle** : `formatModelName` (src/lib, étape 133) existait déjà et servait dans Options, mais
     le sélecteur affichait l'identifiant brut (« hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M »). Branché, avec
     une option `{ quant: false }` pour ne garder que « GLM-4.6V-Flash » dans ce petit panneau ; l'identifiant
     complet reste en infobulle. **Même famille que « vérifier si un mécanisme existe déjà » : un formateur
     d'affichage existant doit être utilisé par TOUT nouvel écran qui montre la même donnée.**
  Régression : `scripts/test-model-picker-ui.mjs` (pas de cerveau pour un modèle à niveaux, nom court sans
  hf.co/GGUF avec l'identifiant complet en infobulle, remplissage mesuré jusqu'au bord du disque, disque
  blanc) et `scripts/test-format-model-name.mjs` (option sans quantification, tag Ollama officiel inchangé).

- **« Enlève le petit texte "Ce modèle ne réfléchit pas : rien à régler" » + « on peut ajouter K2 Horizon 3.7B ?
  il est le meilleur sur les benchmarks » (Léo, étape 196).**
  1. Phrase retirée : pour un modèle sans réflexion, le titre « Sans réflexion » suffit. Les deux autres
     phrases restent (Chat/Vocal en Auto, Ollama muet) : elles disent quoi faire, pas une redite du titre.
  2. **K2 Horizon 3.7B : vérifié puis PAS ajouté, et dit tel quel à Léo.** Le modèle existe (IFM/MBZUAI,
     Apache 2.0, GGUF officiel `hf.co/IFM/K2-Horizon-3.7B-GGUF`, Q4_K_M 3,16 Go, Intelligence Index 16 chez
     Artificial Analysis), mais les métadonnées du GGUF (API Hugging Face, champ `gguf.architecture`)
     déclarent une architecture NOUVELLE, `k2-horizon`, que le llama.cpp officiel ne charge pas encore
     (issues #28361 « unknown model architecture » et #29424, ouvertes) ; aucune note de version d'Ollama
     ne l'annonce. Un résumé de recherche web affirmait « Ollama day-zero support » : contredit par les
     sources primaires, écarté. **Leçon générale : avant d'ajouter un modèle récent, vérifier que le MOTEUR
     sait le charger (architecture déclarée dans le GGUF vs support de llama.cpp/Ollama), pas seulement que
     le modèle et ses benchmarks existent — sinon Jaris télécharge des gigaoctets pour un modèle qui ne
     démarre pas.** Consigné en commentaire dans FLASH_CANDIDATES (hardwareScan.ts) pour le revoir dès
     qu'une version d'Ollama le charge.

- **« Enlève "Clique sur le cerveau pour activer la réflexion" » (Léo, étape 197).** Phrase retirée (et sa
  variante « Réflexion activée : clique sur le cerveau pour la couper ») : le cerveau allumé/éteint et le
  titre (on/off) suffisent, l'infobulle du bouton garde l'explication. Même logique que l'étape 196 : pas de
  phrase qui répète ce que l'écran montre déjà. Léo a aussi confirmé en usage réel le diagnostic de l'étape
  196 sur K2 Horizon : `ollama run hf.co/IFM/K2-Horizon-3.7B-GGUF:Q4_K_M` échoue avec « unknown model
  architecture: 'k2-horizon' » — ne pas l'ajouter tant qu'une version d'Ollama ne le charge pas.

- **« Enlève "En Auto, le modèle change selon la question…" », « ça fait Auto / Vision · GLM-4.6V-Flash »,
  « pourquoi on peut choisir Vision, c'est pas un modèle pour la conversation », « ça fait auto auto, sans
  rien » (Léo, étape 198).**
  1. Plus aucune petite phrase dans le panneau (la dernière, « En Auto… », et celle d'Ollama muet).
  2. **Le titre ne dit plus « Auto » pour la RÉFLEXION** : « Auto » y désignait la réflexion laissée à Jaris,
     alors que juste en dessous « Auto » désignait le MODÈLE — même mot pour deux choses, d'où « Auto / Auto »
     et « Auto / Vision ». Le titre est maintenant le niveau quand on en a choisi un (« medium », avec
     « Puissant · qwen3.8:27b › » dessous), sinon le modèle lui-même (« Puissant », avec « qwen3.8:27b › »
     dessous) ; en Auto : « Auto » et « Choisir un modèle › ». La ligne du dessous ne répète jamais le titre.
     **Leçon générale : un même mot (« Auto ») ne doit pas désigner deux réglages différents dans le même
     petit panneau — l'utilisateur lit les deux lignes ensemble.**
  3. **Rôle Vision retiré du choix de modèle** (`ROLES`, modelChoice.ts) : il ne sert qu'à regarder l'écran ou
     une image, pas à discuter. Un ancien choix « role:vision » enregistré retombe sur Auto (modelForRole ne le
     connaît plus) au lieu de rester affiché comme « Personnalisé ».
  Régression : `scripts/test-model-choice.mjs` (plus de Vision dans la liste, ancien choix Vision → Auto et
  refusé à l'enregistrement) et `scripts/test-model-picker-ui.mjs` (jamais « Auto / Auto », titre = modèle
  sans niveau choisi, = niveau sinon, aucune petite phrase).

- **« La couleur de la barre, c'est pas la couleur de Jaris, tu as mis la couleur exacte de GPT » (Léo,
  étape 199).** À l'étape 195, j'avais recopié le bleu plein de la capture de ChatGPT (`--hud-accent-deep`)
  au lieu de transposer la FORME dans l'identité de Jaris. Remplissage passé au cyan de Jaris, en dégradé avec
  son halo (comme l'orbe et les boutons) ; le disque blanc garde un liseré couleur du fond pour ne pas se
  confondre avec le cyan (le défaut de contraste de l'étape 194). **Leçon générale, déjà vécue avec le cercle
  lisse du widget et du sélecteur de voix : une capture d'une autre appli donne la forme à suivre, jamais ses
  couleurs — Jaris garde toujours sa propre palette.** Régression : `scripts/test-model-picker-ui.mjs` (le
  remplissage mesuré contient le cyan de Jaris, rgb(61, 220, 255)).

- **« Ça doit être centré, là ça va à gauche » + « enlève Montage, on le remplace par Image comme ChatGPT »
  (Léo, étape 200).**
  1. **Panneau Modèle/réflexion centré sur son bouton** (il était aligné à droite, donc débordait vers la
     gauche). Centré en CSS (`left: 50%` + `translateX(-50%)`), plus un décalage `--shift` mesuré à
     l'ouverture (`useLayoutEffect`, avant d'être peint) qui le ramène dans la fenêtre quand le bouton est
     près d'un bord — un simple centrage coupait le panneau sur un bouton collé au bord.
  2. **Montage retiré en entier** (étapes 189-190) : écran, services, paquet Remotion construit par la CI et
     publié avec chaque Release, `montage/render.cjs` embarqué, fixtures, tests, capacités, brique
     « Déplacer ». Le paquet déjà installé chez Léo (~600 Mo) est effacé au démarrage
     (`legacyCleanup.ts`) — y compris sur l'autre disque s'il avait été déplacé : pour une jonction, le vrai
     dossier est effacé puis la jonction retirée par `unlink` (jamais un `rm -r` sur la jonction), et
     seulement si elle pointe vers un dossier « montage » (une jonction vers ailleurs n'est jamais suivie).
     **Les vidéos déjà fabriquées ne sont pas touchées** : `generated-videos` reste dans OWNED_ENTRIES et
     suit ses données comme avant. **Leçon générale : retirer une fonctionnalité qui a téléchargé quelque
     chose chez l'utilisateur, c'est aussi retirer ce qu'elle a installé — sinon des centaines de Mo restent
     sur son disque sans que plus rien ne les utilise ni ne puisse les désinstaller ; mais ce qu'il a CRÉÉ
     avec (ses vidéos) reste à lui.**
  3. **Mode Image** (bouton « Image » à gauche, `ImagePanel.tsx`) : même présentation que Chat/Code — liste
     à gauche, image au centre, champ en bas — et, sans image ouverte, les dernières images en vignettes comme
     la page Images de ChatGPT. Réutilise le moteur de dessin local de l'étape 173 (`generateImage`, FLUX.2
     klein) plutôt que d'en créer un : dessin avec barre d'étapes (« Dessin : étape 2 sur 4 »), « Arrêter »
     (le signal d'annulation existait déjà), Enregistrer (même dialogue gardé par `dialogOpen` que le Chat),
     Ouvrir le dossier, suppression avec confirmation dans la ligne. Les images dessinées depuis le Chat ou à
     la voix y apparaissent aussi (même dossier). Si le modèle de dessin manque, l'écran propose de
     l'installer avec sa taille ; si le PC n'est pas assez puissant, il donne la raison (même décision
     qu'Options → Modèles, `pickImageModel`). **Seul un NOM de fichier PNG voyage entre l'écran et le main**
     (`isGeneratedImageFileName`, revérifié côté main avant toute lecture ou SUPPRESSION) : jamais un chemin.
  **Défaut attrapé par le test navigateur, pas en relecture** : les vignettes étaient chargées (chaque image
  entière par l'IPC) même derrière l'écran d'installation. Elles ne le sont plus que quand la galerie est
  réellement affichée. **Piège déjà écrit ici, revécu une fois de plus** : le nouvel import de
  `shared/imageGallery` dans imageGenerator.ts manquait au faux pont de `test-image-generation.mjs` —
  14 tests rouges d'un coup, sans message clair.
  Régression : `scripts/test-image-gallery.mjs` (noms refusés : chemins, `..`, non-PNG),
  `scripts/test-legacy-cleanup.mjs` (vraie jonction : paquet et vrai dossier effacés, vidéos intactes,
  jonction vers ailleurs jamais suivie — vérifié en retirant ce garde), `scripts/test-image-generation.mjs`
  (liste et suppression refusant tout chemin), `scripts/test-image-panel-ui.mjs` (vrai navigateur :
  vignettes, avancement, arrêt, enregistrement, suppression confirmée, installation, PC trop faible) et
  `scripts/test-model-picker-ui.mjs` (panneau centré et jamais coupé — vérifié en remettant l'ancien CSS).
  **Non vérifié ici** : un vrai dessin (moteur Windows + carte graphique) et l'effacement réel du paquet
  Montage sur la machine de Léo.

- **« Petit bug » (texte « Auto » surligné en bleu), « dans Code on ne peut pas choisir le modèle, c'est
  toujours Code, comme Image avec le modèle Image », « dans Chat et Vocal on ne doit pas avoir Code » (Léo,
  étape 201).**
  1. **Le surlignage** : un double-clic sur « Auto » sélectionnait le texte du bouton comme du texte de page
     (capture de Léo). `user-select: none` sur le sélecteur. Sur la même capture, la liste sortait par le haut
     de la fenêtre : la hauteur du panneau est maintenant bornée à l'espace au-dessus du bouton (le reste
     défile) — test vérifié en retirant la borne, mais SEULEMENT après avoir réduit la fenêtre de test à 240 px
     (à 330 px le test passait sans la borne : il ne mordait pas).
  2. **Code : plus de choix de modèle** (étape 141 retirée pour ce mode). Le sélecteur affiche « Code » et le
     modèle, sans flèche ni liste ; `resolveCodeModel` ignore tout ancien choix enregistré et prend toujours le
     modèle Code du profil (comme le mode Image avec son modèle de dessin). Ma question à choix (« il manque
     des choix ? la liste est coupée ? ») était à côté : Léo voulait qu'il n'y ait AUCUN choix. **Leçon : quand
     l'utilisateur dit « ça ne doit pas être possible », c'est une suppression, pas un réglage — ne pas
     proposer d'amélioration du réglage.**
  3. **Chat et Vocal : plus de rôle Code** (`ROLES_BY_MODE`, modelChoice.ts) : Rapide, Médium, Puissant
     seulement. Le rôle Code n'a aucun sens pour discuter. Un ancien « role:code » enregistré en Chat retombe
     sur Auto, et l'enregistrement d'un choix en mode Code est refusé côté main (jamais fait confiance à
     l'écran).
  Régression : `scripts/test-model-choice.mjs` (Code ne se choisit pas, ancien choix ignoré, refus
  d'enregistrement), `scripts/test-codegen-generate.mjs` (un ancien choix à la main est ignoré, remplace les
  deux tests de l'étape 141 devenus faux) et `scripts/test-model-picker-ui.mjs` (Code affiché sans bouton ni
  liste, Chat sans Code ni Vision, texte non sélectionnable, panneau jamais coupé par le haut).

- **« Si je fais un prompt à Code, je pars dans Chat ou Vocal et je reviens dans Code, c'est vide et ça
  travaille encore sur mon processeur » + « quand on ouvre Jaris on ne peut pas changer de modèle, c'est grisé,
  je dois aller sur Chat et revenir sur Vocal » (Léo, étape 202). Deux bugs, une même famille : un état qui
  ne vit que dans un composant React disparaît ou se fige selon le moment où ce composant est (re)créé.**
  1. **Écran détruit en changeant d'onglet.** `{appMode === 'code' && <CodePanel />}` (App.tsx) DÉTRUISAIT
     l'écran Code à chaque changement d'onglet, avec son état (génération en cours, avancement, résultat),
     alors que la génération continuait dans le main process (d'où le processeur occupé). Au retour, un écran
     neuf ne savait rien, et la réponse arrivait sur un composant qui n'existait plus : perdue. Même chose
     pour le Chat et le mode Image. Corrigé par `KeepAlive` (src/components/KeepAlive.tsx) : l'écran est
     monté à sa première ouverture (rien n'est chargé pour un onglet jamais visité), puis seulement CACHÉ
     (`display: none`, et `display: contents` quand il est visible pour ne rien changer à la mise en page).
     **Leçon générale : un écran qui lance un travail long (génération, dessin, envoi) ne doit jamais être
     détruit tant que ce travail tourne ailleurs — sinon le travail continue sans personne pour recevoir le
     résultat ni montrer l'avancement.**
  2. **Sélecteur de modèle grisé au lancement.** Le sélecteur demande la liste des modèles une seule fois, en
     se montant. Au lancement de Jaris, Ollama ne répond pas encore : `installed: null`, bouton grisé, et
     plus rien ne redemandait — seul un changement d'onglet, qui recréait le composant (justement le
     comportement corrigé au point 1 pour d'autres écrans), le « réparait ». Il redemande maintenant toutes
     les 3 s tant qu'Ollama n'a pas répondu, puis s'arrête. **Leçon générale : une donnée lue une seule fois
     au montage auprès d'un service qui démarre en même temps que l'appli doit être relue tant qu'elle manque —
     sinon l'écran reste figé sur l'état « pas encore prêt ».**
  Régression : `scripts/test-keep-alive-ui.mjs` (vrai écran Code dans un navigateur : l'avancement survit à un
  aller-retour d'onglet, un résultat arrivé pendant l'absence s'affiche au retour, un onglet jamais ouvert ne
  charge rien, App.tsx garde les trois écrans en vie — vérifié en remettant « détruire si inactif » : 2 tests
  échouent) et `scripts/test-model-picker-ui.mjs` (Ollama absent puis présent : le bouton se dégrise tout
  seul — vérifié en coupant la relance).

- **Mode Vidéo avec Wan 2.2 TI2V 5B (Léo, étape 203 : « et pour finir ajoute vidéo : Wan 2.2-TI2V-5B »).**
  Même présentation que le mode Image (liste à gauche, vidéo au centre, champ en bas), même moteur :
  stable-diffusion.cpp en `-M vid_gen`. **Aucun nouveau moteur à installer** : le sd-cli figé (SD_ENGINE) contient
  déjà la vidéo ET l'écriture WebM — vérifié dans le binaire lui-même (webm.dll + chaîne « WebM muxer »), pas
  supposé. Sans WebM compilé, sd-cli aurait écrit un AVI sous un nom `.webm`, illisible par l'écran.
  **Fichiers vérifiés sur les sources primaires** : les trois recommandés par docs/wan.md de sd.cpp À LA MÊME
  VERSION que le moteur (GGUF QuantStack Q4_K_M, VAE wan2.2 — le VAE wan2.1 ne marche PAS avec ce modèle —, UMT5
  city96), Apache 2.0, figés à une révision exacte avec leur SHA-256 lue sur l'API Hugging Face puis recalculée
  après un vrai téléchargement ici (identique pour les trois). ~8,5 Go : jamais installé avec les autres
  modèles, seulement sur « Installer le modèle vidéo », et l'écran le dit (taille + plusieurs minutes par vidéo).
  **Essai RÉEL ici, sur processeur** (sd-cli Linux de la même version, les trois vrais fichiers, les mêmes
  options que `buildVideoArgs` mais en tout petit : 320x192, 5 images, 10 étapes) : un vrai `.webm` produit,
  relu dans Chromium comme le fait l'écran (blob + `<video>`), avec une scène enneigée et une forme rousse qui
  bouge d'une image à l'autre. Refait SANS `--vae-tiling` : images identiques (mêmes mesures de luminosité), donc
  le découpage du décodeur, gardé pour économiser la VRAM, n'altère pas le résultat. Le message `gguf_init_from_reader: tensor 'patch_embedding.weight' has invalid
  number of dimensions: 5 > 4` s'affiche au chargement mais N'EST PAS bloquant : sd.cpp retombe sur son propre
  lecteur GGUF et reconnaît bien « Wan2.2-TI2V-5B » — ne pas le prendre pour la cause d'un futur problème sans
  autre indice. **Non vérifié** : la qualité et la durée aux vrais réglages (832x480, 49 images, 20 étapes) sur
  une vraie carte graphique — aucune ici, et le seuil 8 Go de VRAM / 16 Go de RAM est déduit de la taille des
  fichiers, pas mesuré. À confirmer par Léo sur sa RTX 3070.
  **Un seul calcul à la fois sur la carte graphique** : le verrou d'imageGenerator.ts est devenu PARTAGÉ
  (`claimEngine`/`releaseEngine`) — deux verrous séparés auraient laissé une image et une vidéo se lancer
  ensemble et se disputer 8 Go de VRAM. Relâché dans un `finally` (test vérifié en le retirant : échoue).
  **Image → vidéo** : une image jointe avec le « + » est écrite en fichier temporaire (`.depart-…`, jamais un
  nom de vidéo valide donc jamais listé) et effacée dans le `finally`. Seuls des NOMS de fichier traversent
  l'IPC, revérifiés côté main (`isGeneratedVideoFileName`) ; description passée en UN argument, jamais un shell.
  **Piège de test, encore** : un sd-cli simulé qui ne se termine jamais (`holdEngine`) garde vivante la minuterie
  « plus de signe de vie » de `runEngine` — tout test qui en lance un doit l'arrêter lui-même à la fin, sinon
  `node --test` ne rend jamais la main et n'affiche aucun échec.
  Régression : `node --test scripts/test-video-generation.mjs scripts/test-video-panel-ui.mjs` (seuils, commande
  officielle, texte piégé resté inerte, verrou partagé image/vidéo, arrêt réel, image de départ effacée, liste
  qui refuse tout chemin ; et dans un vrai navigateur : avancement, lecteur, image jointe transmise, arrêt,
  écran d'installation) + `test-keep-alive-ui.mjs`/`test-widget-mode.mjs` étendus au mode Vidéo.

- **Durée d'une vidéo au choix, « comme l'effort » (Léo, étape 204).** Un bouton horloge dans le champ du mode
  Vidéo ouvre le même panneau que la réflexion : une barre de 1 à 5 secondes, remplie jusqu'au cran choisi.
  Borne haute vérifiée sur le README officiel de Wan 2.2 (« a 5-second 720P video », 24 images/s), pas devinée ;
  `videoFramesFor` donne 24 images par seconde + 1, donc toujours 4n + 1 comme l'exige le modèle (5 s → 121).
  La durée venue de l'écran est revérifiée côté main (`normalizeVideoSeconds`) : toute autre valeur → 2 s,
  jamais passée telle quelle à sd-cli. Dernière durée gardée dans localStorage (simple confort, lecture et
  écriture protégées : la page de test l'interdit, et l'écran fonctionne quand même).
  **Placement du panneau extrait dans `usePickerPanel` (src/lib)** plutôt que recopié : centrage sur le bouton,
  jamais coupé par un bord, fermeture au clic dehors/Échap — deux copies du même calcul auraient divergé
  (même leçon que les deux composeurs de l'étape 92). Les 14 tests du sélecteur de modèle passent inchangés.
  **Piège de capture d'écran** : une capture prise juste après un clic sur la barre montre la transition
  (0,18 s) à mi-course — bouton blanc sur l'ANCIEN cran, remplissage à moitié. Ce n'est pas un bug : attendre la
  fin de l'animation avant de juger un rendu.
  **Non vérifié** : le temps réel d'une vidéo de 5 s sur la RTX 3070. Le calcul croît plus vite que la durée
  (attention sur toutes les images à la fois), et une vidéo longue demande aussi plus de mémoire vidéo.
  Régression : `scripts/test-video-generation.mjs` (1 à 5 s, 121 images à 5 s, valeur hors limites ramenée à
  2 s jusqu'à la ligne de commande) et `scripts/test-video-panel-ui.mjs` (vrai clic sur la barre, durée envoyée
  avec la vidéo, reprise à la prochaine ouverture, valeur abîmée → 2 s ; vérifié en ne transmettant plus la
  durée : le test échoue).

- **Qualité de la vidéo Q4 · Q6 · Q8, limitée à ce que la machine peut faire tourner (Léo, étape 205 : « une
  barre d'effort Q4, Q6 ou Q8, et si une personne ne peut que Q6 elle n'a que Q4 et Q6 »).** Un cran = le modèle
  vidéo ET le lecteur de description au même niveau de compression (le décodeur n'existe qu'en original, il est
  commun). Fichiers Q6/Q8 pris dans les MÊMES dépôts et aux MÊMES révisions figées que Q4, tailles et SHA-256 lues
  sur l'API Hugging Face, licence Apache 2.0 des deux dépôts vérifiée. Les noms Q4 n'ont pas changé : une
  installation v0.21.x reste valable telle quelle.
  **Seuils déduits des tailles, pas mesurés** (`VIDEO_QUALITIES`, shared/videoModel.ts) : carte = modèle vidéo +
  ~2,5 Go de calcul, sur une carte dont Windows occupe déjà ~0,5 Go ; RAM = les trois fichiers + ~5 Go. D'où Q4
  et Q6 sur 8 Go de carte, Q8 à partir de 10 Go ; Q4 dans 16 Go de RAM, Q6/Q8 à partir de 24 Go. **Correction
  d'une affirmation faite à Léo juste avant** : je lui avais annoncé Q8 « juste » sur sa RTX 3070 à partir de la
  seule taille du modèle (5,4 Go) ; en comptant la marge de calcul et ce que Windows occupe, il ne reste plus de
  marge — Q8 n'est donc pas proposé sur 8 Go, et je le lui ai dit plutôt que de laisser l'ancienne réponse.
  Le plancher reste 8 Go (étape 203) : rien ici ne permet de le descendre sans mesure.
  **La qualité venue de l'écran est revérifiée côté main** (`isVideoQuality`, puis `assertQualityFits` dans
  installVideoModel ET generateVideo) : une qualité hors de la machine est refusée avec une phrase claire AVANT
  tout téléchargement ou calcul. Chaque qualité se télécharge à la demande, depuis l'écran d'installation (choix
  avant de télécharger) ou depuis le panneau de qualité (bouton « Télécharger (taille) »), jamais toutes d'un coup
  (~29 Go). La taille affichée ne recompte ni le moteur ni le décodeur déjà présents.
  **SliderPicker** (src/components) : bouton + panneau à barre, partagé par la durée et la qualité — le même
  panneau écrit deux fois aurait divergé (leçon de l'étape 92).
  Régression : `scripts/test-video-generation.mjs` (crans par machine, Q6 après Q4 = 2 fichiers seulement, Q8
  refusé sur 8 Go sans rien télécharger, qualité absente, fichiers utilisés par sd-cli, empreintes figées ;
  vérifié en retirant le contrôle machine à l'installation : 2 tests échouent) et `scripts/test-video-panel-ui.mjs`
  (choix de qualité avant installation, barre limitée à la machine, téléchargement depuis le panneau avec bandeau,
  envoi bloqué si la qualité manque, qualité envoyée avec la vidéo et gardée, choix gardé devenu impossible
  ignoré ; vérifié en ne transmettant plus la qualité : le test échoue).

- **1 h 05 pour 5 s de vidéo, et un rendu granuleux : Wan 2.2 5B de base remplacé par FastWan (Léo, étape 206,
  captures de sa PREMIÈRE vraie vidéo à l'appui : « attendre 1h05 pour ça c'est chiant »).** Chaque étape de Wan
  de base coûtait DEUX passages (CFG 6 : description + prompt négatif) × 20 étapes = 40 passages. FastWan est le
  MÊME Wan 2.2 TI2V 5B distillé par FastVideo (Apache 2.0) pour 3 étapes en CFG 1, soit 3 passages. Piste trouvée
  dans une discussion de sd.cpp sur le même rendu « poubelle » du 5B de base (leejet/stable-diffusion.cpp#1243),
  où un contributeur de sd.cpp donne la commande (`--cfg-scale 1 --steps 3 --scheduler lcm --flow-shift 3.0`) —
  puis **MESURÉE ici avant de changer quoi que ce soit** : même processeur, même description, même graine,
  calcul de la vidéo 214 s (Wan, 10 étapes) → 41 s (FastWan, 3 étapes), et en 832x480 un chat roux net dans la
  neige, sans grain. `--scheduler lcm` vérifié présent dans la version figée du moteur (`sd-cli --help`).
  **Écarté, et pourquoi** : Wan2.2-TI2V-5B-Turbo (4 étapes) — sa copie GGUF se dit Apache 2.0, mais le dépôt
  d'origine est sous CC BY-NC-SA (non commercial) : toujours lire la licence du dépôt D'ORIGINE, pas celle
  recopiée sur une conversion. Le moteur CUDA (au lieu de Vulkan) existe mais pèse ~900 Mo et son gain est
  invérifiable ici sans carte NVIDIA : pas changé sans mesure.
  **Ce qui reste long** : le décodeur (VAE), inchangé — ici, en 832x480, 3 min de calcul de vidéo pour 16 min de
  décodage sur processeur. Sur une vraie carte, la part exacte reste à mesurer chez Léo.
  FastWan n'existe qu'en Q6 et Q8 (GGUF de Green-Sky, contributeur de sd.cpp) : plus de Q4. Seuils inchangés
  (Q6 sur 8 Go de carte, Q8 à partir de 10 Go ; 24 Go de RAM). Les fichiers de l'ancien Wan de base (jusqu'à
  ~15 Go) sont effacés au démarrage par NOM exact (`removeObsoleteVideoFiles`), jamais autre chose du dossier.
  **Leçon générale : face à un modèle lent ET médiocre, chercher d'abord une version distillée du MÊME modèle
  (moins d'étapes, sans CFG) avant d'optimiser le moteur — le nombre de passages domine tout le reste.**
  Régression : `scripts/test-video-generation.mjs` (commande FastWan, crans Q6/Q8, anciens fichiers effacés et
  seulement eux, empreintes figées) et `scripts/test-video-panel-ui.mjs`.

- **Correcteur de ce que Léo dit, « un peu comme Apple » (étape 207).** Question à choix d'abord (le mot
  « correcteur » pouvait désigner 4 choses : correction silencieuse, texte à corriger soi-même, isolation de la
  voix, orthographe du Chat) — Léo a choisi « corriger ce que j'ai dit », tout seul, avant la réponse.
  `transcriptCorrector.ts` : une passe par le modèle du palier Rapide, sortie STRUCTURÉE (schéma JSON à un seul
  champ, `structuredChat` dans ollama.ts, température 0, sans réflexion), puis trois verrous — la correction
  doit rester très proche de l'original (`acceptCorrection` : distance d'édition ≤ 30 %, au plus un mot de
  plus ou de moins), délai de 6 s, et au moindre échec la phrase ENTENDUE est gardée. Une annulation (nouvelle
  phrase captée pendant la réflexion) remonte comme pour la réflexion elle-même. Réglage Options → Voix
  « Corriger ce que je dis » (actif par défaut), relu à chaque phrase.
  **Mesuré avec de vrais modèles dans Ollama, pas supposé** — et en évitant un biais repéré à la première
  mesure : 3 des 10 phrases testées étaient aussi les EXEMPLES écrits dans la consigne, que le modèle pouvait
  recopier ; refait sur 10 phrases jamais vues. ministral-3:3b : 10/10 (« spotifaille » → Spotify, « ouatsap »
  → WhatsApp, « Jariste » → Jaris), jamais de réponse à la place de la phrase, négations gardées. qwen3.5:0.8b
  (le plus petit Rapide) : 8/10, jamais de réponse, mais il a tourné « envoie » en « envoyez » et abîmé
  « Squeezie » — règle ajoutée (garder le tutoiement, ne pas toucher un nom propre bien écrit). ~1,5 à 2,5 s
  par phrase sur le processeur d'ici ; sur la carte de Léo, non mesuré. **Leçon générale : quand on évalue une
  consigne à exemples, ne jamais tester sur les exemples eux-mêmes — un résultat parfait peut n'être qu'une
  recopie.**
  **Piège trouvé par les tests** : `AbortSignal.timeout` ne retient pas la boucle d'évènements de Node — un
  délai pouvait ne jamais se déclencher si rien d'autre ne tournait (4 tests annulés, « Promise resolution is
  still pending »). Remplacé par un vrai `setTimeout` relié à un AbortController.
  **Vidéo, cran « Original »** (Léo : « Q6 … jusqu'à l'original, comme l'effort ») : FastWan bf16 (10,0 Go,
  dépôt Kijai — la conversion d'où viennent les GGUF de Green-Sky) + lecteur UMT5 fp16 (11,4 Go, Comfy-Org,
  Apache 2.0). Lisibilité par sd.cpp vérifiée sans tout télécharger : la table des tenseurs (en-tête
  safetensors, lu par requête HTTP Range) est IDENTIQUE à celle du Wan 2.2 5B officiel cité par la doc de sd.cpp
  (825 tenseurs, mêmes noms, mêmes formes, seul bf16/fp16 change). Seuils déduits : carte de 16 Go, 32 Go de
  RAM. Pas de Q4 : il ne servirait qu'aux cartes de moins de 8 Go, sous le plancher. Non exécuté ici (22,8 Go
  de fichiers, plus que la RAM de ce conteneur).
  **Test rendu fiable au passage** : deux tests attendaient le lancement de sd-cli en comptant 1000 tours de
  boucle — sous la charge de la suite complète, ça passait avant la fin des lectures disque (échec sans défaut du
  code, réussi 3 fois sur 3 seul). Attente remplacée par une durée réelle (5 s max).
  **Piège de manipulation, deux fois dans cette session** : `pkill -f "motif"` tue aussi le shell dont la ligne
  de commande contient ce motif — la commande entière s'arrête (code 144) au milieu. Tuer par PID, ou choisir un
  motif absent de sa propre commande.
  Régression : `scripts/test-transcript-corrector.mjs` (verrous : réponse, reformulation, ajout refusés ;
  délai, panne, JSON illisible → phrase entendue ; annulation qui remonte ; pipeline qui répond à la phrase
  corrigée) et `scripts/test-video-generation.mjs` / `test-video-panel-ui.mjs` (cran Original).

- **Une carte AMD passait pour « pas de carte du tout » (Léo, étape 208, capture du Gestionnaire des tâches
  d'un ami : AMD Radeon RX 7600, 8 Go — « aucune carte graphique NVIDIA détectée, mais j'en ai assez ? »).**
  `detectGpu` ne demandait qu'à `nvidia-smi`, qui n'existe QUE sur les cartes NVIDIA : sur une AMD ou une Intel,
  l'échec était lu comme « aucune carte » — vidéo et image refusées alors que leur moteur (sd.cpp Vulkan) marche
  sur AMD, ET paliers Ollama choisis comme pour une machine sans carte. Repli ajouté, seulement quand
  nvidia-smi échoue et seulement sous Windows : la mémoire de chaque carte, toutes marques, lue dans le registre
  de la classe des cartes graphiques (`HardwareInformation.qwMemorySize`, 64 bits). **Écarté exprès** :
  `Win32_VideoController.AdapterRAM`, limité à 32 bits, qui plafonne à 4 Go et aurait annoncé 4 Go pour cette
  carte de 8 Go. La carte la plus grosse gagne ; moins de 1 Go (intégrée seule) compte comme « pas de carte ».
  Messages « NVIDIA » retirés. Les relevés en direct (VRAM libre, température) restent NVIDIA seulement :
  sur une autre marque, ils répondent « inconnu », comme avant.
  **Script PowerShell vérifié pour de vrai, pas seulement relu** : PowerShell 7.5 installé ici, script exécuté
  avec une lecture du registre simulée (une carte, plusieurs, mémoire en nombre ou en octets, carte sans
  mémoire) et par le chemin réel `-EncodedCommand`. Le test garde ce contrôle : sur le runner Windows de la CI,
  c'est Windows PowerShell 5.1 — celui de Léo — qui exécute le vrai script. **Non vérifiable ici** : la valeur
  réellement écrite par le pilote AMD sur la machine de l'ami.
  **Ce qui reste refusé chez cet ami, à juste titre** : sa RAM semble être de 16 Go (8 Go de mémoire GPU
  partagée = la moitié de la RAM, règle de Windows) ; la vidéo demande 24 Go de RAM, donc elle restera refusée,
  mais avec la VRAIE raison (« pas assez de RAM ») au lieu d'une fausse.
  **Leçon générale : un outil propre à un fabricant (nvidia-smi) ne dit rien de l'ABSENCE de matériel — son
  échec veut dire « pas une carte de CE fabricant », jamais « pas de carte ».**
  Régression : `node --test scripts/test-gpu-detection.mjs`.

- **Cran vidéo « Léger » pour les PC à 16 Go de RAM (Léo, étape 209, suite du PC AMD de son ami).** Une fois la
  carte AMD détectée (étape 208), la vidéo restait refusée chez cet ami, à juste titre : sd.cpp charge les trois
  fichiers en RAM, Q6 en fait 10,3 Go, soit ~15,3 Go avec Windows et Jaris sur 16 Go. Tableau montré à Léo, choix
  fait par lui : le MÊME modèle vidéo que Q6 (FastWan Q6, fichier partagé, jamais téléchargé deux fois) avec le
  lecteur de description en Q4 (3,7 Go au lieu de 4,7) → 9,3 Go de fichiers, ~14,3 Go de RAM. Le lecteur ne
  travaille qu'une fois par vidéo ; la perte de qualité n'a pas été mesurée. Écarté : convertir FastWan en Q4 sur
  le PC (il aurait fallu télécharger le Q8 puis le convertir).
  **Piège évité avant de coder, pas après** : `umt5-xxl-encoder-Q4_K_M.gguf` figurait dans OBSOLETE_VIDEO_FILES
  depuis l'étape 206 (fichiers de l'ancien Wan de base, effacés au démarrage). En le réutilisant sans le retirer
  de cette liste, Jaris l'aurait effacé à CHAQUE démarrage et retéléchargé à chaque usage. Retiré, et un test
  vérifie désormais qu'aucun fichier d'une qualité actuelle ne figure parmi les « anciens » (vérifié en le remettant
  dans la liste : le test échoue). **Leçon générale : quand un fichier déclaré obsolète redevient utile, chercher
  d'abord s'il est sur une liste de nettoyage — un nettoyage automatique n'avertit jamais qu'il efface un fichier
  encore utilisé.**
  Régression : `scripts/test-video-generation.mjs` (Léger réutilise le modèle Q6, PC à 16 Go de RAM : Léger
  proposé et Q6 refusé avec la vraie raison, lecteur Q4 jamais effacé au démarrage).

- **Mêmes mots que Claude partout : Faible · Moyen · Élevé · Extra (Léo, étape 210 : « enlève les Léger, les Q6,
  et aussi dans les modèles conversation, mets comme Claude : faible, moyen, élevé, et pour l'original extra »).**
  Qualité vidéo : Léger → Faible, Q6 → Moyen, Q8 → Élevé, Original → Extra (seuls les LIBELLÉS changent ; les
  identifiants internes light/q6/q8/original restent, donc un choix déjà enregistré reste valable). Réflexion des
  modèles de conversation : `thinkLabel` traduit les niveaux d'Ollama (low → Faible, medium → Moyen, high →
  Élevé, xhigh → Extra, off/on → Désactivée/Activée) — dans le titre, le bouton ET les crans de la barre
  (`thinkOptions`, oubliés au premier passage, repérés par les tests). Seul l'affichage change : la valeur
  envoyée à Ollama reste « medium », « xhigh »… Un niveau inconnu garde son nom, jamais deviné.
  Régression : `scripts/test-effort.mjs`, `test-model-picker-ui.mjs`, `test-video-generation.mjs`.
  **Suite (Léo : « dans chat et vocal je vois encore Rapide etc. »)** : les rôles de modèle de conversation
  Rapide · Médium · Puissant deviennent Faible · Moyen · Élevé partout où ils s'AFFICHENT — sélecteur Chat/Vocal
  (`modelChoice.ts`), Options → Modèles (`MyModelPicks`, `CapacityScan`, liste « Tous les modèles » : colonne
  catégorie et « utilisé en »). Les valeurs internes (clés flash/medium/large, catégorie `ModelCategory` de
  hardwareScan.ts) ne changent pas : un choix enregistré reste valable. Premier passage trop étroit (seulement le
  sélecteur) : c'est la recherche des mêmes mots dans tout `src/` qui a trouvé les 4 autres écrans. **Leçon
  générale : un renommage demandé pour un écran vaut pour TOUS les endroits qui montrent la même chose — chercher
  le mot partout avant de livrer, sinon l'utilisateur voit deux noms pour le même modèle.**

- **Première vidéo FastWan chez Léo : sd-cli s'arrête net, code 3221226505, juste après « loading tensors
  completed » (étape 211).** 3221226505 = 0xC0000409 : Windows a arrêté le programme d'un coup (assertion interne,
  corruption de pile…), SANS que le moteur écrive la moindre erreur. La cause n'est PAS établie : la même commande
  FastWan a produit une vidéo ici (processeur, Linux), et Wan de base avait tourné chez Léo en Vulkan (1 h 05).
  Pas de correctif spéculatif à l'aveugle (leçon SearXNG) : le message d'échec est rendu exploitable d'abord —
  « vidéo » au lieu d'« image » (le texte était celui des images), code affiché en hexadécimal (cherchable),
  « arrêt brutal, sans message du moteur » dit comme tel, et les lignes d'ERREUR des 20 dernières reprises au
  lieu de la seule dernière ligne (souvent celle du chargement, qui n'explique rien). Question posée à Léo sur la
  qualité et la durée choisies pour réduire les hypothèses. Étoile retirée du bouton de qualité (demande de Léo :
  l'icône n'avait pas de sens).
  Régression : `scripts/test-video-generation.mjs` (message d'échec vidéo).

- **Arrêt brutal 0xC0000409 de la vidéo juste après « loading tensors completed » (Léo, étape 212, Faible,
  3-4 s) : ma première piste était FAUSSE, et c'est la reproduction qui l'a montré.** J'avais comparé les
  en-têtes GGUF et supposé que FastWan, qui compresse aussi ses poids de normalisation en q6_K, faisait
  planter Vulkan. Le code source de sd.cpp dément déjà cette hypothèse : ces poids sont déclarés en f32 par le
  modèle et convertis au chargement. Reproduit ensuite pour de vrai, avec le build Linux Vulkan de sd.cpp au même
  commit sur lavapipe (Vulkan logiciel ; `GGML_VK_VISIBLE_DEVICES=0` est obligatoire, sinon ggml écarte un
  périphérique de type CPU et tout tourne sur le processeur sans rien dire). Le plantage tombe au même endroit
  que chez Léo : sd.cpp charge chaque modèle juste avant de s'en servir, donc la dernière ligne « loading
  tensors completed » était celle du LECTEUR DE DESCRIPTION (UMT5), pas celle de FastWan. Assertion obtenue :
  `pre-allocated tensor (text_encoders.t5xxl.transformer.shared.weight) in a buffer (Vulkan0) that cannot run
  the operation`. Sa table de vocabulaire fait 861 Mo, au-delà de la limite de tampon de cette carte
  (maxStorageBufferRange = 128 Mo sur lavapipe).
  Corrigé par `--backend te=cpu` : le lecteur tourne sur le processeur (42 s ici sur 4 cœurs, une seule fois
  par vidéo), tandis que FastWan et le décodeur restent sur la carte. Vérifié de bout en bout sur ce Vulkan
  émulé : vidéo produite. FastWan a lui-même tourné sur Vulkan, ce qui écarte définitivement la piste des
  poids de normalisation.
  **Non vérifié à 100 %** : la limite exacte de la carte de Léo n'est pas celle de lavapipe. C'est le même
  point de plantage et le même type de refus, mais sa carte reste à tester en usage réel.
  Au passage, une assertion ggml s'écrit « fichier.cpp:930: message », sans le mot « error » : elle n'était
  jamais reprise dans le message d'échec. C'est maintenant le cas, et l'échec ne dit plus « sans message du
  moteur » quand le moteur en a laissé un.
  **Leçon générale : avec un chargement paresseux, la dernière ligne « chargé » désigne le DERNIER modèle
  chargé, pas le modèle principal.** Il faut situer le plantage par une vraie reproduction avant d'accuser le
  fichier qu'on vient de changer. **Une hypothèse tirée d'une différence réelle (q6_K au lieu de f16) reste une
  hypothèse** tant que le code qui lit ces poids n'a pas été consulté.
  Régression : `node --test scripts/test-video-generation.mjs` (lecteur sur le processeur, assertion ggml
  reprise telle quelle ; les deux vérifiés en retirant le correctif).

- **L'accueil Vidéo restait vide alors que celui d'Image montre une galerie (Léo, étape 213 : « sur image on
  peut voir toutes les images, mais sur vidéo on voit rien »).** Les deux écrans partagent la même présentation
  depuis l'étape 203, mais seule la galerie d'Image avait été faite. L'écran Vidéo affiche maintenant ses 8
  dernières vidéos en vignettes, au format vidéo et non en carré. Chaque vignette montre la première image de sa
  vidéo et se lance au survol, sans le son. Un symbole « lecture » la distingue d'une simple image. Un clic ouvre
  la vidéo.
  Chaque vidéo traverse l'IPC en entier et devient une adresse blob: locale. Elle est libérée quand la vidéo est
  supprimée ou que l'écran se ferme, sinon chaque passage par l'onglet garderait toutes ces vidéos en mémoire.
  **Leçon générale : quand deux écrans sont annoncés comme « la même présentation », vérifier qu'ils ont
  vraiment les MÊMES éléments, pas seulement la même mise en page.** C'est le contenu de l'accueil qui
  manquait, pas la structure.
  Vérifié dans un vrai navigateur avec une vraie vidéo WebM produite par sd.cpp : la première image s'affiche
  dans les 5 vignettes. Régression : `scripts/test-video-panel-ui.mjs` (une vignette par vidéo, format vidéo
  mesuré sur le CSS compilé, muette, un clic ouvre, la suppression retire la vignette).

- **Parler à Jaris depuis son téléphone (Léo, étape 214 : « on va faire parler depuis son téléphone »,
  partout ET confidentiel, puis « pas faut installer l'application à côté »).** Choix faits avec Léo, questions
  à choix simples à l'appui. Bot Telegram écarté : les bots ne sont pas chiffrés de bout en bout, Telegram
  peut les lire. Page Wi-Fi seule écartée : elle ne marche qu'à la maison. Retenu : **Tailscale embarqué dans
  Jaris** (`tunnel/`, Go + tsnet, compilé par la CI en `jaris-tunnel.exe`) avec **Funnel**, qui publie une
  adresse `https://jaris.<réseau>.ts.net`. Le chiffrement TLS se termine sur le PC et le relais de Tailscale
  ne fait que transporter des octets chiffrés (vérifié dans la documentation de Funnel et dans le code de
  tsnet). Sur le téléphone, aucune appli : une page web à ajouter à l'écran d'accueil (`phone/`). Seule
  démarche : un compte Tailscale gratuit, une fois, puis un clic pour autoriser l'adresse. Jaris ouvre ces
  pages tout seul juste après un clic sur « Activer », jamais au démarrage.
  **Confidentialité** : tsnet envoie par défaut ses journaux techniques aux serveurs de Tailscale, coupé avec
  l'option officielle (`envknob.SetNoLogsNoSupport` + `logtail.Disable`) avant tout démarrage. Lu dans le code
  de tsnet (`startLogger`), jamais supposé.
  **Sécurité**, puisque l'adresse est joignable depuis internet :
  - le serveur de Jaris n'écoute que sur 127.0.0.1 ;
  - code d'appairage à 8 chiffres, 10 minutes, usage unique, 5 essais par code et 10 essais par minute ;
  - un jeton par téléphone, révocable, gardé sur le PC sous forme d'empreinte seulement ;
  - aucun fichier servi hors d'une liste fixe ;
  - tailles bornées ;
  - CSP stricte, sans script en ligne ;
  - le code du QR voyage après « # » : il n'est jamais envoyé dans une requête.

  **Outils** : choix de Léo, « tout sauf le risqué ». C'est une LISTE BLANCHE (`phoneAccess.ts`) : un outil
  ajouté plus tard reste interdit depuis le téléphone tant que personne ne l'a déclaré sans risque. Deux
  barrières : les outils interdits ne sont pas donnés au modèle, et un appel inventé quand même est refusé avant
  exécution, réponse = le refus lui-même. La commande directe du Bloc-notes (qui écrit sur le PC) est refusée
  elle aussi : elle contournait les outils.
  **Même conversation que le Chat** : `chatSession.send(..., PHONE_RESTRICTIONS)`, et le Chat du PC se met à
  jour en direct (`chatHistoryChanged`).
  **Messages vocaux** : le téléphone décode lui-même son enregistrement (webm ou mp4 selon la marque) et le
  convertit en WAV 16 kHz mono. Le PC le transcrit avec le modèle DÉJÀ chargé pour le micro
  (`transcribe-file` dans `voice_server.py`, traité dans la boucle qui possède le modèle), sans seconde copie
  en mémoire. Vérifié de bout en bout dans Chromium avec un faux micro : enregistrement → WAV → serveur →
  transcription → réponse.
  **Défaut existant trouvé et reproduit en passant** : les sidecars Python ne forçaient UTF-8 que sur
  stdout/stderr, pas sur stdin. Sous cp1252, « Ça va, Léo ? » envoyé à la voix arrivait en « Ã‡a va, LÃ©o ? ».
  Invisible chez Léo, dont le Windows est déjà en UTF-8. Corrigé dans les deux sidecars.
  **Pièges rencontrés** :
  - `server.close()` attend la fin des connexions gardées ouvertes : sans `closeAllConnections()`,
    « Désactiver » pouvait ne jamais aboutir tant qu'un téléphone restait sur la page.
  - Une ancre `#code=` ouverte sur une page déjà chargée ne la recharge pas : il faut écouter `hashchange`.
  - Une redirection `cat > "a b.ts"` mal citée a laissé un fichier VIDE `phoneAccess` sans extension.
    Rollup l'a résolu AVANT `phoneAccess.ts` (« phoneStatusFromLog is not exported »). **Leçon générale :
    un fichier vide portant le nom d'un module sans extension masque le vrai module pour le bundler,
    sans erreur claire.**
  - Le test existant de voiceClient a sa propre liste de modules autorisés : tout nouvel `import` doit y
    être ajouté (même leçon que les faux ponts preload).
  - Sous PowerShell, un bloc `run:` multi-lignes peut masquer l'échec d'une commande du milieu : une
    commande Go par étape dans la CI.
  - electron-builder ne signale pas un fichier `extraResources` manquant : une étape vérifie que le tunnel
    et la page sont bien dans l'installeur.

  **Vérifié ici** : connexion réelle à Tailscale jusqu'à l'adresse de connexion (`login.tailscale.com/a/…`),
  le serveur, la page en vrai navigateur et l'onglet Options. **Non vérifié** : Funnel de bout en bout sur un
  vrai compte (il faut se connecter), et la page sur un vrai iPhone/Android (micro, ajout à l'écran d'accueil).
  Léo doit tester en usage réel.
  Régression : `node --test scripts/test-phone-server.mjs scripts/test-phone-page-ui.mjs
  scripts/test-phone-tab-ui.mjs scripts/test-phone-restrictions.mjs scripts/test-phone-tunnel.mjs
  scripts/test-voice-listening-status.mjs scripts/test-sidecar-encoding.mjs`, `go test ./...` (tunnel/),
  `python scripts/test-phone-wav.py`. Les tests de sécurité du serveur et des restrictions ont été vérifiés en
  réintroduisant chaque faille une par une.

- **« démarrage de Tailscale impossible : tsnet: creating state directory: Access is denied » (Léo, v0.22.0,
  dès l'activation de l'accès téléphone).** La cause a été trouvée dans le CODE SOURCE de Tailscale, pas
  devinée. `paths.ensureStateDirPermsWindows` réécrit le propriétaire, le groupe et les droits de tout dossier
  d'état nommé EXACTEMENT « tailscale » : c'est prévu pour le service Tailscale, qui tourne en SYSTEM. Le
  dossier de Jaris s'appelait justement `userData\tailscale`, et un programme lancé sans droits
  d'administrateur n'a pas le droit de faire ce changement. La création du dossier, elle, avait réussi : c'est
  ce réglage de droits qui échouait, sous le même message.
  Corrigé des deux côtés :
  - Jaris utilise `phone-tunnel` et efface le dossier `tailscale` à moitié créé par la v0.22.0 (des journaux
    seulement) ;
  - le tunnel refuse lui-même ce nom (`stateDirFor`, tunnel/main.go), au cas où un futur appelant
    l'utiliserait.

  Le module TPM de Tailscale (même message) n'est pas compilé dans le tunnel : vérifié par `go list -deps`.
  **Pourquoi aucun test ne l'a vu** : le développement tourne sous Linux (ce code est propre à Windows) et le
  runner Windows de la CI tourne EN ADMINISTRATEUR, où ce changement de droits réussit. **Leçon générale :
  une bibliothèque tierce peut avoir un comportement spécial déclenché par un simple NOM de dossier ou de
  fichier. Avant de nommer un dossier d'après l'outil qui l'utilise, chercher ce nom dans le code de l'outil.
  Et un test en CI ne prouve rien sur ce qui demande des droits : la CI est administrateur, Léo non.**
  Régression : `go test ./...` (tunnel/, vérifié en retirant le garde) et `scripts/test-phone-tunnel.mjs`
  (le nom n'est jamais « tailscale », des deux côtés).

- **ERR_SSL_PROTOCOL_ERROR sur le téléphone en scannant le QR code (Léo, v0.22.1), et RIEN de visible côté
  PC.** Le tunnel avait bien publié l'adresse (le téléphone l'atteignait), mais la connexion sécurisée
  échouait. Cause exacte NON confirmée, faute de journaux : la v0.22.0 jetait tous les messages de tsnet.
  Plutôt qu'une hypothèse de plus (leçon de la saga SearXNG), le tunnel teste maintenant le comportement
  réel et rend les erreurs visibles :
  1. il obtient le certificat HTTPS AVANT d'annoncer l'adresse (`lc.CertPair`, jusqu'à 4 min). La première
     fois, Let's Encrypt peut prendre une minute : un téléphone arrivé avant tombait sur l'échec ;
  2. il fait lui-même une vraie requête HTTPS vers l'adresse publique, par internet et le relais Funnel,
     comme le téléphone. L'adresse n'est donnée qu'une fois cette requête réussie. Une adresse neuve peut
     mettre plusieurs minutes à exister sur internet. Au-delà de 10 min, l'adresse est donnée quand même,
     avec la vraie erreur affichée ;
  3. toute erreur de certificat pendant une connexion remonte à l'écran (`tls_error`, au plus toutes les 30 s) ;
  4. le journal de tsnet est gardé SUR LE PC (`phone-tunnel/jaris-tunnel.log`, 2 Mo max), jamais envoyé.

  **Leçon générale : couper complètement les journaux d'une bibliothèque réseau pour raison de
  confidentialité rend le premier échec réel indiagnostiquable. Couper l'ENVOI, pas l'écriture locale.**
  Régression : `go test ./...` (tunnel/ : alerte de certificat transmise une seule fois avec le vrai message,
  vérification qui exige une vraie réponse de Jaris), `scripts/test-phone-tunnel.mjs` et
  `scripts/test-phone-tab-ui.mjs` (étapes de préparation et avertissement affichés).

- **Téléphone : Chat sans dictaphone, plus Vocal, Image et Vidéo (étape 215, Léo : « enleve le dictaphone
  dans le telephone, et ajoute image vidéo, et vocal »).** Choix de Léo par questions : Vocal « comme l'Agent
  vocal du PC », Image/Vidéo « créer + voir la galerie ». Barre d'onglets en bas de la page (`phone/`).
  - **Vocal** : on touche l'orbe, on parle ; l'envoi part à la pause (mesure du volume) ou au second toucher.
    `POST /api/talk` transcrit sur le PC, répond avec le canal `'voice'` (`chatSession.send(..., channel)`,
    pas de listes ni de gras puisque lu à voix haute), puis `synthesizeSpeech` produit le WAV, servi par
    `GET /api/jobs/:id/audio` avec le jeton. Une voix en échec ne transforme JAMAIS la réponse en erreur :
    elle reste écrite. **Piège iPhone, non vérifiable ici** : un son ne peut démarrer que pendant un geste ;
    le lecteur `<audio>` est donc « ouvert » avec un silence au moment du toucher, et c'est ce MÊME lecteur
    qui joue la réponse ensuite. Chromium (tests) garde l'activation de la page, il ne distingue donc pas un
    oubli de ce déverrouillage : seul l'essai de Léo sur iPhone le confirme. Repli prévu : « Écouter la
    réponse » si le téléphone refuse la lecture.
  - **Image/Vidéo** : le téléphone n'installe et ne télécharge RIEN ; `studio()` (main.ts) ne propose que ce
    qui est déjà prêt sur le PC (qualités vidéo INSTALLÉES seulement), et sinon la raison en français. Durée
    et qualité revérifiées côté serveur contre cette liste (un `"2"` texte est refusé, pas converti). Deux
    files de travaux indépendantes (conversation / création) : une vidéo de plusieurs minutes ne bloque pas
    le Chat. Arrêter = vrai `AbortSignal` ; un arrêt demandé finit en `cancelled`, jamais en erreur rouge.
  - **Les travaux EN COURS ne sont jamais oubliés** par le plafond de 20 travaux gardés : avant, l'éviction
    supprimait le plus ancien quel qu'il soit, donc une vidéo longue pouvait disparaître du suivi après une
    vingtaine de messages. Test dédié, vérifié en remettant l'ancienne éviction.
  - **Fichiers** : seuls des NOMS voyagent (`/api/images/:nom`, `/api/videos/:nom`), filtrés par un motif
    strict AVANT même d'appeler le PC, puis revérifiés par `generatedImagePath`/`generatedVideoPath`. La page
    les récupère avec le jeton et les affiche par `blob:` (jamais une adresse publique du fichier). Vignettes
    d'images réduites côté PC (`nativeImage`, JPEG 360 px) : un PNG 1024 px pèse plus d'1 Mo, une galerie
    entière en 4G aurait coûté des dizaines de Mo.
  - **Vidéos WebM** : lisibles par Chromium/Android ; sur iPhone, ça dépend de la version d'iOS (non vérifié
    ici). Si le navigateur répond non à `canPlayType('video/webm')`, la page le dit et propose d'enregistrer,
    au lieu d'afficher un cadre noir.
  - Les galeries du PC se rechargent quand le téléphone crée quelque chose (`studioGalleryChanged`).
  Régression : `node --test scripts/test-phone-server.mjs scripts/test-phone-page-ui.mjs` (vrai serveur, vrai
  navigateur au format téléphone, faux micro de Chromium). Vérifiés en réintroduisant le défaut : garde des
  noms de fichiers, éviction des travaux en cours, lecture de la voix.

- **Premier essai réel sur iPhone de l'onglet Vocal (étape 216, Léo, capture à l'appui) : « ça bloque sur
  Envoi à ton PC », plus « on peut pas choisir les modèles, pas comme le PC » et « l'icône Chat est coupée ».**
  - **Bloqué sur « Envoi à ton PC… » : cause exacte NON confirmée** (pas d'iPhone ici). Ce qui est sûr en
    relisant le code : après l'arrêt de l'enregistrement, trois étapes pouvaient ne jamais finir sans rien
    afficher. `MediaRecorder.onstop` qui ne vient pas, des morceaux vides ignorés par un simple `return`, et
    une conversion `decodeAudioData`/`OfflineAudioContext` qui ne répond jamais. Dans les trois cas, l'écran
    restait figé. Le son du micro est maintenant lu directement (`ScriptProcessor` sur l'`AudioContext` créé
    pendant le toucher), ramené à 16 kHz et mis en WAV dans la page : plus de MediaRecorder ni de décodage.
    Chaque étape a désormais une fin visible :
    - micro muet après 3 s → message ;
    - enregistrement trop court → message ;
    - envoi sans réponse en 60 s → message ;
    - puis les étapes du PC.
    Si ça bloque encore, le message affiché dira OÙ. **Leçon générale : une étape asynchrone qui peut ne
    jamais répondre doit avoir une issue visible (délai, message), sinon un bug d'un navigateur précis se lit
    comme « ça ne fait rien ».** Chromium (tests) ne reproduit pas le blocage de l'iPhone : seul l'essai de
    Léo tranche.
  - **Modèle et réflexion sur le téléphone** : le même sélecteur que le PC, et le même réglage (Chat et Vocal
    séparés, comme sur le PC). Les trois handlers IPC du PC sont devenus `readModelChoice`,
    `saveModelChoice` et `saveThinkChoice` (main.ts), partagés par l'IPC et le téléphone : deux copies de
    cette logique auraient divergé. Le mode Code est refusé côté téléphone. Les refus du PC (modèle pas
    installé…) arrivent tels quels. Le sélecteur du PC se recharge quand le téléphone change le réglage
    (`modelChoiceChanged`).
  - **Icône Chat coupée** : le tracé SVG commençait en (4,4) mais son dernier arc finissait en (6,4), et le
    contour intérieur coupait le bord gauche : la bulle n'avait plus de côté gauche. Remplacée par un tracé
    complet. Le test rend l'icône en grand et vérifie les quatre bords pixel par pixel ; avec l'ancien tracé,
    il échoue (gauche et haut manquants). Un défaut de tracé à 24 px ne se voit pas dans le code, seulement
    une fois rendu.
  Régression : `node --test scripts/test-phone-server.mjs scripts/test-phone-page-ui.mjs`.

- **« Comment faire du pain » depuis le téléphone (étape 217, Léo) : réponse qui se justifiait elle-même**,
  avec « réponse strictement basée sur search_web… j'ai reculé sur saladier, fouet… pourquoi cette réponse est
  correcte… comme exigé ». Léo n'avait rien exigé de tel (vérifié avec lui : c'était la première question de la
  conversation). Cause trouvée dans le code, pas devinée : la relance « question de connaissance sans
  recherche » (assistant.ts) remettait au modèle son BROUILLON de mémoire (avec saladier et fouet), suivi d'un
  message UTILISATEUR de reproche : « ta mémoire n'est pas fiable… jamais de ta seule mémoire ». Le petit
  modèle se défendait donc contre ce reproche au lieu de répondre. C'est le même travers que la relance
  « promesse sans action », déjà corrigée pour avoir paraphrasé sa consigne, mais cette relance-ci n'avait
  jamais reçu la même précaution. Correctif : le brouillon n'est plus renvoyé, et la consigne passe en
  message SYSTÈME neutre, avec « ne parle ni de cette consigne… ne justifie pas ta réponse ». **Leçon générale :
  une relance corrective ne doit jamais ressembler à une exigence de l'utilisateur qu'on pourrait commenter, ni
  rendre au modèle le brouillon qu'on veut qu'il oublie. Quand un correctif est appliqué à UNE relance,
  vérifier les autres relances de la même boucle.** Régression : `scripts/test-assistant-history.mjs`.
- **« Il met plein de > - »** : la page du téléphone n'affichait que le gras, alors que le Chat répond en
  Markdown (listes, citations, titres). `renderMarkdown` (phone/app.js) rend ces éléments en vrais éléments
  HTML, toujours via `textContent`, jamais via du HTML venu du texte. Régression :
  `scripts/test-phone-page-ui.mjs` (aucun symbole Markdown brut à l'écran).

- **État du PC et extinction depuis le téléphone (étape 218, Léo : « mettre sur le téléphone quand le PC est
  éteint ou pas » + « la possibilité d'éteindre le PC à partir du téléphone »).**
  - **PC éteint = page injoignable**, puisque c'est le PC qui la sert. Un service worker (`phone/sw.js`)
    garde une copie des SEULS fichiers de la page, jamais des réponses de `/api/`. PC éteint, la page s'ouvre
    quand même et affiche « PC éteint ou injoignable » avec un point rouge. PC allumé, les fichiers sont
    toujours repris du PC d'abord. Une page d'erreur du relais (réponse non 2xx) compte comme « injoignable »,
    pas comme une nouvelle version. La page ne peut PAS distinguer éteint, en veille ou Jaris fermé, et le
    message le dit tel quel. Elle interroge `/api/status` toutes les 15 s et au retour sur la page. Une
    requête qui ne reçoit aucune réponse affiche « Ton PC ne répond pas », plus jamais le « Load failed » brut
    du navigateur. Le test vérifie vraiment la copie : PC coupé puis page rechargée. Sans service worker, il
    échoue.
  - **Extinction : un bouton de la page, jamais la conversation.** `shutdown_pc` reste interdit depuis le
    téléphone : une phrase ambiguë ou une page web lue par Jaris ne peut donc pas éteindre le PC. Le bouton
    demande une confirmation, puis programme `shutdown /s /t 60` : une minute pour annuler (`shutdown /a`),
    avec un compte à rebours visible. Un second appui ne relance pas le compte à rebours, et un refus de
    Windows arrive lisible. Le refus du modèle au téléphone renvoie vers ce bouton au lieu de dire
    « impossible ». Le téléphone ne peut pas RALLUMER le PC (rien n'écoute quand il est éteint), et la page le
    dit.
  - `sw.js` est ajouté à la vérification d'empaquetage de la CI : un fichier manquant dans `extraResources` ne
    fait pas échouer electron-builder.
  Régression : `node --test scripts/test-phone-server.mjs scripts/test-phone-page-ui.mjs`.

- **Ling 3.0 Tiny ajouté (étape 219, Léo : « ajoute Ling 3.0 Tiny et Gemma 4 12B »).** Gemma 4 12B était DÉJÀ
  là (Médium, Vision, 17/17), et il n'y avait rien à refaire. Ling 3.0 Tiny n'est pas dans la bibliothèque
  officielle d'Ollama, donc import `hf.co/inclusionAI/Ling-3.0-tiny-GGUF:Q4_K_M` (GGUF OFFICIEL du créateur,
  4,82 Go), jamais le réupload communautaire `maternion/`. Son architecture est NOUVELLE (`bailingmoe3`),
  comme K2 Horizon, qui avait été refusé faute de prise en charge. Ici, elle est vérifiée par trois FAITS :
  - la PR llama.cpp #26608 a été fusionnée le 17/08/2026 ;
  - un signalement Ollama montre le modèle tournant sous 0.33.3 ;
  - je l'ai téléchargé et chargé moi-même avec Ollama 0.35.0, et `/api/show` annonce `tools` et `thinking`.
  Score Artificial Analysis 11 et 58 tokens/s : seule la variante Reasoning a une fiche. **Règle confirmée
  par Léo : quand un modèle a un mode raisonnement et un mode sans, on prend le score Reasoning** (déjà la
  règle écrite au-dessus de ARTIFICIAL_ANALYSIS_INTELLIGENCE_INDEX). **Le test d'appel d'outils, c'est Léo
  qui le fait, comme pour tous les modèles** (il l'a redit quand j'ai commencé à le lancer ici). Ne pas
  remplir verified-tool-scores.md à sa place : sans score, le modèle est candidat mais jamais choisi.
- **« Valable encore 11 min » au lieu de 10** (Options → Téléphone) : l'heure de référence était prise AVANT
  la création du code, et le moindre délai de l'aller-retour faisait arrondir à 11. Le test passait seulement
  quand le faux pont répondait dans la même milliseconde : un test « instable » de temps en temps cachait un
  vrai bug. Le faux pont attend maintenant 30 ms, comme le vrai aller-retour. **Leçon générale : un test qui
  échoue une fois sur trois mérite d'être lu avant d'être relancé ; ici, c'est l'écran qui mentait.**
- Piège d'environnement : un vrai Ollama lancé sur 127.0.0.1:11434 pendant `npm test` fait échouer
  `test-benchmark-cases.mjs`. Ne jamais garder un Ollama de mesure ouvert pendant la suite de tests.

- **Scores Artificial Analysis entièrement revérifiés (étape 220, Léo : « on a pris les scores raisonner ou
  non raisonner ? … regarde bien tous les scores, ils doivent être exacts »).** Relevés le 02/10/2026 sur les
  DONNÉES BRUTES de chaque fiche (champ `intelligenceIndex` de l'objet `currentModel` du HTML), jamais sur
  le résumé d'un outil de lecture de page. Celui-ci avait déjà inventé un 16,1 pour G9v3, et il annonçait
  encore deux chiffres contradictoires pour Qwen3.5 9B. **Règle confirmée par Léo : la variante raisonnement
  quand il y en a deux, à son effort le plus élevé publié.** Quatre valeurs étaient fausses :
  - qwen3.5:9b : 14 (ce n'était ni la variante Reasoning 11,2 ni la Non-reasoning 13,3) ;
  - gemma4:31b : 19 au lieu de 14,7 ;
  - qwen3-vl:8b et :4b : score de la variante Instruct, alors que ces tags Ollama sont les variantes
    THINKING (même digest que `8b-thinking`/`4b-thinking`). **Leçon : vérifier le DIGEST du tag Ollama
    pour savoir quelle fiche le décrit, jamais son seul nom.**
  Les scores sont maintenant stockés à UNE décimale, comme dans les données, et affichés « 13,1 »
  (`formatIntelligenceIndex`) : l'arrondi à l'entier créait des égalités artificielles. **Conséquence
  annoncée à Léo avant de livrer — et FAUSSE** : « avec 8 Go, Médium passe de qwen3.5:9b à qwen3.5:4b ». Voir
  l'étape 222 juste en dessous.
  Les vitesses ont été revérifiées sur la phrase de la fiche du modèle lui-même. Quatre modèles n'ont plus de
  vitesse publiée et elle est retirée : les chiffres présents sur leur page appartiennent aux modèles cités en
  comparaison. **Piège à retenir : une page Artificial Analysis contient les données de beaucoup d'AUTRES
  modèles (comparaisons). Ne lire que l'objet `currentModel`, ou une phrase qui commence par le nom exact
  du modèle.**

- **Bouton « Tester les modèles sans score » REMIS (étape 221, Léo : « rajoute le bouton analyse pour tester
  Ling-3.0-tiny (Q4_K_M) »).** Il avait été retiré à l'étape 172 (« enlève test ») une fois les scores de
  l'époque recopiés. Il est restauré par l'inverse exact du commit de retrait (f8d210f) : bouton dans « Tous
  les modèles », IPC, `testUnscoredModels`, et script embarqué dans l'installeur. Mêmes règles qu'avant :
  il ne teste QUE les modèles sans aucun score (aujourd'hui Ling 3.0 Tiny, puis devstral-2:123b, sauté
  d'office sur un PC trop petit avec sa raison) et ne choisit rien. Léo envoie le fichier, et le score est
  recopié à la main dans verified-tool-scores.md. **Rappel : retirer un bouton qui sert à mesurer les
  NOUVEAUX modèles revient à empêcher tout ajout de modèle d'être un jour choisi.** Si on le retire encore,
  prévoir d'abord un autre moyen de mesurer.
- **« On utilise Ling-3.0-tiny (Q4_K_M), ça change pas ? »** Le score Artificial Analysis est mesuré chez
  les fournisseurs en ligne du modèle (pleine précision ou 8 bits), jamais sur la version Q4_K_M que Jaris
  télécharge. C'est vrai pour TOUS les modèles de Jaris (Q4 par défaut sur Ollama) : la comparaison entre
  eux reste juste, mais chaque chiffre est un peu optimiste pour la version réellement utilisée. C'est pour
  ça que le choix repose d'abord sur le test d'appel d'outils, fait SUR la version Q4_K_M elle-même.

- **Score de Ling 3.0 Tiny reçu, et une erreur de ma part corrigée (étape 222).** Léo a mesuré Ling 3.0 Tiny
  (Q4_K_M) avec le bouton remis à l'étape 221 : 16/17, recopié dans verified-tool-scores.md après relecture
  de ses 4 réponses sans outil. En vérifiant ce que ce score change, j'ai trouvé que ma conclusion de l'étape
  220 était FAUSSE. J'avais annoncé (et demandé à Léo de valider) « avec 8 Go, Médium passe de qwen3.5:9b à
  qwen3.5:4b ». Je l'avais déduit d'un test à scores d'outils SIMULÉS identiques, jamais du vrai calcul. Or
  la fiabilité d'outils passe AVANT l'intelligence, et en vrai, Médium était et reste granite4.2:8b (17/17)
  à 8 Go. Recalculé avec un script qui charge le vrai hardwareScan.ts et le vrai verified-tool-scores.md
  (8/32, 6/16, 12/32 et 16/64 Go) : ni la correction des scores, ni Ling (16/17, battu partout par un 17/17
  qui tient) ne changent un seul choix. **Leçon générale : avant d'annoncer l'effet d'un changement sur les
  choix de modèles, le CALCULER avec les vraies données des deux côtés (avant/après), jamais le déduire d'un
  test unitaire qui simule une partie des données.**

- **Bouton « Tester les modèles sans score » retiré de nouveau (étape 223, Léo : « enlève le test analyse »)**,
  une fois Ling 3.0 Tiny mesuré. Retrait identique à celui de l'étape 172 (patch f8d210f réappliqué) : bouton,
  IPC, `testUnscoredModels`, scripts de test hors de l'installeur, et l'étape de vérification CI ajoutée à
  l'étape 221. Le script reste un outil de développement. **Schéma déjà vécu deux fois** : Léo veut le bouton
  quand un nouveau modèle arrive, puis le retire une fois le score obtenu. Pour la prochaine fois : il suffit
  de réappliquer à l'envers le patch de retrait (`git show f8d210f`) sur les mêmes fichiers.
- **« Ollama 0.35.1 fait jusqu'à 10 recherches par réponse, à quoi sert Docker Desktop ? »** Vérifié sur
  docs.ollama.com/capabilities/web-search : la recherche web d'Ollama est un service EN LIGNE d'ollama.com
  (`https://ollama.com/api/web_search`). Il exige un compte ollama.com et une clé d'API, et chaque question
  part sur leurs serveurs. SearXNG (dans Docker) tourne sur le PC et interroge les moteurs sans compte, et
  Jaris lit déjà jusqu'à plusieurs pages (`read_web_page`). Rien n'a été changé : remplacer SearXNG par le
  service d'Ollama irait contre le « 100 % local et confidentiel » de Jaris. À reproposer seulement si Léo
  préfère se passer de Docker en acceptant d'envoyer ses recherches à ollama.com.

- **« le logo de l'application bug » (Léo, étape 224) : fenêtre et barre des tâches montraient un carré
  bruité.** Cause : `createAppIcon` donnait aux fenêtres le logo recadré en 1008×1008 px, et Windows le
  réduisait lui-même en 16-32 px avec un rééchantillonnage grossier — les anneaux fins devenaient du bruit.
  Corrigé en donnant sous Windows le vrai .ico multi-tailles (`scripts/build-icon.mjs`, Lanczos, 16 à 256 px,
  petites tailles en bitmap 32 bits, 256 en PNG), copié hors de l'asar (`extraResources`) et lu via
  `resourcesRoot()`. `build/` est ignoré par Git : l'icône est fabriquée par `npm run dist`, jamais commitée —
  ne pas croire une icône locale de `build/` (la mienne datait d'un vieux test et m'a d'abord fait accuser le
  .exe à tort). **Leçon : une image fournie en très grand à un système qui la réduira à quelques pixels doit
  être réduite à l'avance, à chaque taille demandée.** Régression : `node --test scripts/test-app-icon.mjs`.
  Non vérifiable ici : le rendu réel dans la barre des tâches de Léo.

- **devstral-2:123b retiré des candidats Code (Léo, étape 225 : « même un modèle 8b est plus fort que lui »).**
  Vérifié avant de retirer, pas pris au mot : Artificial Analysis lui donne 8,6, sous granite4.2:8b (11,1)
  et qwen3.5:9b (11,2), pour 75 Go dense qui ne tourne qu'en débordant massivement sur la RAM. Retiré de
  CODE_CANDIDATES, LARGE_RAM_OFFLOAD_MODELS, de la table d'intelligence et de benchmark-models.mjs.

- **MiniCPM5-2B ajouté, et recherche dans « Tous les modèles » (Léo, étape 226).** MiniCPM5-2B vérifié avant
  l'ajout : GGUF officiel d'OpenBMB (`hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M`, 1,56 Go), architecture `llama`,
  réellement téléchargé et chargé ici par Ollama 0.35.1 (outils + réflexion annoncés, un outil réellement
  appelé), 12,5 chez Artificial Analysis (variante Reasoning, aucune vitesse publiée). Candidat Rapide et
  Médium comme G9v3 ; sans score d'outils, jamais choisi tant que Léo ne l'a pas mesuré. Pour tester Ollama
  ici sans 1,4 Go de bibliothèques GPU : `ollama-linux-amd64.tar.zst` depuis ollama.com/download, extrait
  sans `*cuda*`/`*rocm*`/`*vulkan*` (60 Mo), sur un port isolé — jamais 11434 pendant `npm test`.
  La recherche (`filterModels`, src/lib) ignore majuscules, accents et ponctuation, et cherche dans le nom
  affiché ET le tag complet. **Piège revécu, déjà noté ici : la règle générale des `input` impose des coins
  droits en `!important` — tout nouveau champ arrondi doit en être exclu explicitement.** Et les tests
  navigateur lisent le CSS COMPILÉ (`out/`) : relancer `npm run build` avant eux, sinon ils testent l'ancien
  style. Régression : `scripts/test-filter-models.mjs`, `scripts/test-options-reorganization-ui.mjs`.

- **Bouton « Tester les modèles sans score » remis pour MiniCPM5-2B, et qwen3-coder-next retiré (Léo, étape
  227 : « il est nul »).** Bouton restauré par `git revert --no-commit` du commit qui l'avait retiré (v0.23.8),
  seul conflit dans AllModelsOverview.tsx (la barre de recherche ajoutée depuis) ; notes et version gardées
  telles quelles. qwen3-coder-next vérifié avant retrait : 9,2 chez Artificial Analysis, deux fois moins que
  qwen3.6:35b-a3b (18,2) pour 52 Go contre 22. Son score 3/3 sort de verified-tool-scores.md avec une ligne
  qui explique pourquoi. Après le score de MiniCPM5-2B, le bouton pourra être retiré comme les fois précédentes.

- **MiniCPM5-2B mesuré par Léo : 15/17 (étape 228).** Recopié dans verified-tool-scores.md avec la relecture de
  ses 4 réponses sans outil (« 11:31 du soir » à 11:31 du matin, prétend pouvoir « allumer » la machine). Son
  intelligence 12,5 ne compense pas : l'appel d'outils passe avant, granite4.2:3b (16/17) et ministral-3:3b
  (17/17) restent devant. Plus aucun modèle sans score.

- **Nanbeige4.1-3B et LFM2.5-2.6B ajoutés, et le test d'outils n'est pas stable d'un passage à l'autre (Léo,
  étape 229).** Les deux vérifiés avant l'ajout : téléchargés et chargés ici par Ollama 0.35.1 (outils +
  réflexion annoncés), chacun a appelé `set_reminder` correctement. LFM2.5-2.6B : GGUF officiel de Liquid AI.
  Nanbeige4.1-3B : pas de GGUF du créateur, requantification mradermacher. 8,4 chez Artificial Analysis pour
  les deux (variante Reasoning). Rangés par VRAM décroissante dans les listes (Nanbeige 2,4 Go avant
  granite4.2:3b), ordre dont dépend le choix.
  **Mesure qui compte pour tous les scores du fichier** : granite4.2:3b relancé ici deux fois de suite, mêmes
  17 questions, même machine : 17/17 puis 15/17 (« Monte le son » → play_pause, « Appuie sur Entrée » → aucun
  outil) ; Léo avait mesuré 16/17. Chaque question n'est posée qu'une fois, sans température fixée : un écart
  d'un ou deux points entre deux modèles n'est donc pas significatif. 5 des 15 outils ne sont jamais testés
  (read_web_page, recall_memory, click_mouse, generate_image, shutdown_pc). Pour relancer un modèle déjà noté :
  `JARIS_RETEST_ALL=1 JARIS_ONLY_MODELS=<modèle>` ; `OLLAMA_HOST` doit contenir `http://`, et sans carte
  graphique ici, `JARIS_RAM_SAFETY_MARGIN_GB=2` (sinon budget 0 Go, modèle sauté) — ~1 min 45 par question.

- **Test d'outils version 5, pour retester tous les modèles (Léo, étape 230 : « je veux être sûr à 1000 % avant
  de lancer au moins 4 h de test »).** Trois défauts mesurés avant de toucher au test : 5 des 15 outils jamais
  testés (read_web_page, recall_memory, click_mouse, generate_image, shutdown_pc) ; chaque question posée une
  seule fois alors que granite4.2:3b fait 17/17 puis 15/17 sur deux passages identiques ; et seul le total
  enregistré, impossible de savoir quelle question un modèle rate. Corrigé : 24 questions (7 de plus, dont
  éteindre ET redémarrer, clic à une position ET clic droit), chacune posée 3 fois (72 réponses), avec le
  réglage d'échantillonnage par défaut du modèle, comme Jaris (jamais de température fixée en conversation).
  Deux questions se jouent dans un vrai contexte de Jaris : notes en mémoire (consignes identiques à
  systemPrompt.ts avec des titres, vérifié par test) et un search_web déjà fait dans le tour (question, PUIS
  appel et résultat au format de webSearch.ts — j'avais d'abord mis le résultat AVANT la question, repéré à la
  relecture). Le fichier de résultats a une section par modèle : questions ratées (n/3 et ce qu'il a fait à la
  place) et réponses sans outil, gardée à la reprise.
  **Pièges trouvés en vérifiant, à garder** :
  - le contrôle de synchronisation des listes ne vérifiait que la présence du NOM dans le script : gemma4:26b et
    qwen3.8:27b, candidats Vision, n'étaient que dans la liste de conversation du script — jamais testés en
    vision. Le test compare maintenant chaque liste à SA liste ;
  - `cleanupUnselectedModels` (benchmarkRunner.ts) n'existe plus depuis longtemps : hors disque serré, aucun
    modèle téléchargé par le test n'était supprimé (~290 Go pour un re-test complet), malgré le commentaire qui
    disait le contraire. `JARIS_DELETE_AFTER_TEST=1` + un registre `<résultats>.telecharges.json` (sinon un
    modèle téléchargé juste avant une coupure était pris pour un modèle de Léo à la reprise) ;
  - fermer Jaris n'arrêtait pas le test (un process enfant survit sous Windows) : relancer en faisait tourner
    deux sur le même fichier. `stopModelTest()` dans before-quit, second lancement refusé ;
  - un test du faux Ollama dépendait du disque libre de la machine (marge de 5 Go) : réussi puis raté selon
    l'espace restant. `JARIS_DISK_SAFETY_MARGIN_GB` pour les tests.
  Un score de conversation sur un autre total que 72 (`CONVERSATION_TEST_TOTAL`, hardwareScan.ts) compte comme
  à refaire, dans Jaris comme dans le script : le bouton relance les 30 modèles de conversation, avec reprise.
  En attendant, Jaris garde les anciens scores sur 17 ; ne jamais mélanger les deux une fois les nouveaux reçus.
  **Suite, même étape (test version 6, vision refaite), avant tout lancement par Léo** : 2 questions de chat
  de plus (« Je vais éteindre mon PC ce soir » ne doit RIEN éteindre ; corriger « ma voiture » = remember avec
  replace: true), soit 26 × 3 = 78. Le test de vision ne posait que 3 questions de couleurs et de formes, une
  seule fois, sans les consignes de look_at_screen : presque tous les modèles faisaient 3/3. Il pose maintenant
  6 questions × 3 = 18, dont 3 de LECTURE de texte à l'écran (fenêtre d'erreur, bouton, code) dessinées avec
  une police bitmap 5×7 intégrée au script (aucune bibliothèque d'image dans l'appli installée), avec
  VISION_SYSTEM_PROMPT et la fenêtre de contexte de vision.ts. Totaux dupliqués dans hardwareScan.ts
  (CONVERSATION_TEST_TOTAL 78, VISION_TEST_TOTAL 18) et vérifiés par test ; un score sur un autre total est à
  refaire. **Piège attrapé avant de lancer quoi que ce soit** : `VERIFIED_MODELS` était lu tout en haut du
  script, avant `VISION_TOTAL` (déclaré plus bas avec les images) — zone morte temporelle, le script aurait
  planté au démarrage. Toute constante utilisée par une lecture faite au chargement du module doit être
  déclarée AVANT cette lecture. Le dessin (FLUX) n'a pas de test : un seul modèle proposé, et la qualité
  d'une image ne se note pas automatiquement.
  Contrôle réel (un seul passage, aucun score noté) : qwen3-vl:2b lit correctement les 6 images, y compris
  « FICHIER INTROUVABLE », « VALIDER » et « 4821 ». granite4.2:3b corrige bien la note voiture, mais ÉTEINT le PC
  sur « Je vais éteindre mon PC ce soir » : la question n'est pas trop dure, elle attrape un vrai danger.
  **Dernier contrôle avant lancement, à refaire à chaque changement du test** : simuler le bouton de bout en
  bout contre un faux Ollama qui répond tout de suite, avec la VRAIE liste `getUnscoredModels()` et les vrais
  scores, puis compter les questions reçues par modèle et par épreuve. C'est ce qui a montré que gemma4:31b
  (candidat Vision seulement) passait aussi les 78 questions de conversation, pour rien : retiré de MODELS du
  script, et un test vérifie qu'aucun modèle de vision seule n'y revient.
  Vision : le fichier de résultats recopie TOUTES les réponses (« compté juste / compté faux »), pas seulement les
  ratées — la vérification par mots-clés peut se tromper dans les deux sens, Léo corrige alors le score à la main.
  Puis la conversation aussi (même demande) : chaque réponse des 78, avec « compté juste / compté faux ».

- **Relire TOUTES les réponses d'un test avant de recopier ses scores (03/10/2026, test version 6)** : la
  vérification automatique se trompait dans les deux sens. Faux justes : `shutdown_pc[ARGS]{}` écrit en texte
  (format d'outil Mistral, ministral-3:14b) et « je vais mettre mon ordinateur hors ligne maintenant »
  (annonce d'une action non faite). Faux faux : la vision retirait les espaces avant de chercher `\b4821\b`,
  donc « est4821 » n'avait plus de limite de mot — « Le code affiché est 4821. » comptait faux. Et deux
  questions jugeaient mal un test à UN seul tour : relire la note « Voiture » avant de la corriger est la
  première étape demandée par le prompt de Jaris, et noter « éteindre ce soir » en mémoire est sans danger.
  Corrigé par `alsoAccept`/`replyCheck` par question (benchmark-cases.mjs), le rejet des `[ARGS]`/`[TOOL_CALLS]`
  dans isRealReply, une vérification du code en chiffres OU en lettres, et les réponses en erreur ajoutées à la
  liste complète. Scores corrigés à la main dans verified-tool-scores.md, sans relancer le test.
  **Leçon générale : `replace(/\s+/g, '')` puis `\b` détruit justement la limite de mot qu'on cherche — normaliser
  un texte AVANT un motif doit garder ce que le motif utilise.** Régression : test-benchmark-cases.mjs.

- **Ligne Code de « Mes modèles » à « — » alors que le modèle a un score (03/10/2026, Léo : « qwen3.8:27b 46
  tok/s Intelligence 33,7 — »)** : le calcul du Code accepte un modèle de conversation (repli `code` puis
  `conversation`, étape 160), mais `entryForModel` ne lisait que la table du rôle (`code`). Le défaut ne se voyait
  que quand le modèle du profil n'était plus l'idéal — ici après que qwen3.5:27b (78/78) est passé devant. Les
  rôles portent maintenant la même liste de tables que le calcul. **Leçon générale : un affichage qui relit un
  score doit suivre le MÊME repli que le calcul qui a choisi le modèle.** Régression :
  test-hardwarescan-my-picks.mjs.

- **Choix des modèles : fiabilité ET intelligence mises en balance, plus « le meilleur score exact d'abord »
  (03/10/2026, Léo : « on choisit qwen3.5:35b qui a 78/78 et 19 d'intelligence et pas qwen3.8:27b qui a 77/78 et
  33 », puis « une vraie analyse, pas un calcul bête qui autorise 1-2 points d'écart »).** Exiger le taux de
  réussite maximal exact faisait perdre un modèle bien plus intelligent pour UNE réponse sur 78. Une tolérance
  fixe (« 2 points d'écart = égalité ») a été écrite puis refusée par Léo : elle déplace juste la frontière.
  Remplacé par une note : intelligence (Artificial Analysis) × réussite^N, soit la chance de réussir N actions de
  suite multipliée par la qualité des réponses (`TOOL_CHAIN_LENGTH` = 5 en conversation et code, 1 en vision,
  qui ne fait qu'une lecture par demande). Rapide garde son plancher de vitesse, calculé sur les modèles les plus
  fiables pour qu'un petit modèle rapide et peu fiable ne relève pas la barre. Sans intelligence publiée pour
  personne, retour à l'ancienne règle. **Leçon générale : quand deux critères comptent, les combiner dans une
  formule qui dit ce qu'elle mesure vaut mieux qu'un ordre strict (l'un écrase l'autre) ou qu'un seuil arbitraire
  (une frontière déplacée).** Régression : test-hardwarescan-single-pool.mjs (1 erreur sur 78 ne fait pas
  perdre qwen3.8:27b ; 18 erreurs sur 78 le font perdre).

- **Ligne « Vidéo » dans « Mes modèles » + RAM arrondie (04/10/2026, Léo : « ajoute vidéo et le modèle vidéo »)** :
  `pickVideoModel` (shared/videoModel.ts) reprend `availableVideoQualities` et garde la meilleure qualité possible,
  ajouté au canal `getMyModelPicks` comme l'image. Le modèle vidéo ne s'installe que depuis le mode Vidéo, d'où un
  message qui y renvoie (pas « Retester la configuration »). La RAM détectée arrive en Go fractionnaires
  (« 63.161624908447266 Go de RAM » sur la capture de Léo) : arrondie à l'affichage. Régression :
  test-video-generation.mjs, test-options-reorganization-ui.mjs.

- **Rôle « Pilotage d'écran » : UI-TARS 1.5 7B (étape 231, Léo : « oui pour nouveau rôle… comme image vidéo le
  mettre seul, si l'utilisateur n'a pas assez on met pas le rôle et il fait comme maintenant »)**. Choisi sur une
  MESURE faite ici, pas sur une réputation : fausse fenêtre Windows 1280x720, 4 consignes « clique sur… » — UI-TARS
  3/4 en plein sur le bouton, qwen3.5:4b (le modèle Vision de Léo) 0/4. Pas de test dans « Tester ces modèles » :
  un seul modèle, comme Image/Vidéo (`shared/pilotModel.ts`, carte de 8 Go minimum, seuil déduit des tailles
  réelles 4,7 + 0,9 Go, pas mesuré sur une vraie carte). Installé par « Retester la configuration » ; un échec ne
  fait jamais échouer le reste, et une carte trop petite = pas de rôle, le modèle Vision pilote comme avant.
  **UI-TARS a son propre format** (« Thought: … Action: click(start_box='(x,y)') ») : lui imposer le JSON de
  computerUse.ts gâcherait ce qui le rend bon à viser. `uiTars.ts` reprend sa consigne officielle (réduite aux
  actions que Jaris exécute) et traduit sa réponse ; son action brute lui revient dans l'historique.
  **Repère des positions vérifié, pas supposé** : sur une image 1280x1024, le bouton OK centré en (1100, 908) a
  été visé en (1117, 920) — repère de l'image arrondie à des multiples de 28 (1288x1036), pas une version réduite
  à 1 Mpx par Ollama (qui aurait donné ~(962, 794)). D'où `smartResize` puis l'échelle de la capture.
  Ajouts nécessaires à ses actions : défilement (molette) et combinaisons de touches (`pressHotkey`, liste FERMÉE
  de touches comme KEY_CODES) dans inputControl.ts ; le C# a été compilé ici avec mono pour vérifier sa syntaxe
  (son exécution reste invérifiable sans Windows). Le modèle de pilotage est compté comme « utilisé » : jamais
  proposé à la suppression dans « Mes modèles ». **Piège déjà noté, revécu** : ajouter un import à
  benchmarkRunner.ts a cassé 12 tests dont le faux chargeur ne connaissait pas le nouveau module. **Piège
  d'environnement** : un test de benchmark échouait sur « 0,0 Go disponibles » — les modèles téléchargés pour
  l'essai avaient rempli le disque de la session ; supprimer les modèles d'essai avant `npm test`.
  Observé en vrai et sans conséquence : UI-TARS écrit parfois son raisonnement en chinois (jamais affiché, seule
  l'action compte). Non corrigé, signalé à Léo : qwen3.5:4b a répondu y=948 sur une image de 720 de haut — il
  compte peut-être de 0 à 1000 ; ses autres réponses étaient fausses dans les deux repères, donc rien de
  prouvé. Régression : test-ui-tars.mjs (vraies réponses d'UI-TARS), test-computer-use.mjs (chemin pilotage et
  repli sur la vision), test-benchmark-runner-cleanup.mjs, test-my-model-picks-ui.mjs.
  **Non vérifiable ici** : vitesse et justesse sur la vraie carte de Léo, sur de vrais écrans Windows.

- **Tests des modèles refaits pour un DERNIER lancement complet (étape 232, Léo : « je veux que quand je lance le
  test, tout soit bon… pas qu'à la fin tu me dises qu'il faut rajouter une chose »)**. Trois épreuves nouvelles,
  vérifiées sur de vrais modèles ICI, avec le programme Jaris construit (son Node, ELECTRON_RUN_AS_NODE, mêmes
  variables que testUnscoredModels) avant d'être confiées à Léo :
  1. **Demandes complètes** (scripts/benchmark-scenarios.mjs, 24 demandes × 2 graines = /48) : copie de la boucle
     de converse() avec des outils SIMULÉS qui gardent un état et renvoient les MÊMES textes que les vrais outils
     (vérifié par test sur les sources), mêmes courts-circuits, historique entre tours = phrases + réponses
     finales seulement. Jugé sur l'état final et les réponses, pas sur une séquence imposée ; un appel en trop qui
     agit sur le PC fait rater. Les 78 questions restent (non-régression), jamais rejouées pour un modèle noté.
     **Tout est enregistré** (appels, arguments, résultats, réponses entières, graine) : `rejudge` rejuge le
     fichier si un jugement est corrigé plus tard — jamais besoin de relancer des heures de test pour ça.
  2. **Vision v2** (benchmark-vision.mjs, 10 vraies captures 1280x720 × 2 = /20) : rendues par Chromium
     (make-vision-tests.mjs, PNG commités et embarqués). L'ancien test (aplats, gros pixels) : 10 modèles sur 11
     à 18/18, il ne départageait plus rien.
  3. **Code v2** (benchmark-code.mjs, 5 applications = /5) : chaque application générée est OUVERTE dans le
     navigateur de la machine (Edge, installé avec Windows ; Chrome à défaut), piloté en invisible par CDP et le
     WebSocket de Node (benchmark-browser.mjs, aucune dépendance), avec les règles de l'aperçu de Jaris (même
     CSP, alertes muettes, localStorage refusé), puis utilisée : vrais clics souris au centre des boutons,
     défilement À LA MOLETTE (une page bloquée en overflow:hidden ne bouge pas — le bug vécu par Léo). Vérification
     préalable sur une application connue AVANT tout téléchargement : un souci de navigateur se voit en secondes.
  **Trois vrais bugs de Jaris trouvés en construisant ces tests**, corrigés : (a) l'aperçu du mode Code n'avait
  pas `allow-forms` — un formulaire généré ne réagissait JAMAIS au clic, l'évènement submit n'est même pas
  déclenché (vérifié dans un vrai navigateur : « rien » sans, « Merci ! » avec ; form-action 'none' bloque
  toujours tout envoi réel) ; (b) chatWithOllama relayait « does not support thinking » au lieu de la vraie erreur
  quand un modèle sans réflexion (ministral, granite) échouait ensuite pour une autre raison (vu en vrai : appel
  d'outil mal formé, 500) ; (c) la même chose dans le script de test.
  **Pièges trouvés en relisant CHAQUE verdict du vrai essai (ministral-3:3b 36/48)**, pas en relisant le code :
  deux jugements trop larges — une correction « Clio » AJOUTÉE à côté de « Peugeot 208 » sans replace comptait
  juste ; des titres de vidéos et des nombres de vues inventés après une recherche YouTube comptaient juste. Les
  11 autres échecs étaient de vraies erreurs du modèle (Entrée jamais pressée, date d'anniversaire inventée,
  rappel inventé à 30 min au lieu de demander quand, « la musique commence » sans l'avoir lancée, 10 recherches
  en boucle). **Piège de mon propre test de code** : `scrollIntoView` faisait défiler une page bloquée, ce qu'un
  humain ne peut pas faire — remplacé par la molette (Input.dispatchMouseEvent mouseWheel). **Piège
  d'environnement** : Chromium refuse de démarrer en administrateur sous Linux sans --no-sandbox (jamais ajouté
  sous Windows). **Piège d'empaquetage attrapé par un test existant** : le nouveau module n'était pas dans le
  filtre extraResources — vérifié ensuite en construisant vraiment l'application (electron-builder --dir).
  Le choix des modèles par Jaris n'utilise pas encore ces scores : il sera revu avec les résultats de Léo, sans
  relancer de test (toutes les données nécessaires sont dans le fichier). Régression : test-benchmark-scenarios,
  test-benchmark-vision, test-benchmark-code (vrai navigateur ; Edge sur la CI Windows), test-ollama-think-fallback,
  test-generated-preview, test-benchmark-cases.
- **Relecture du protocole par ChatGPT avant le lancement (étape 233)** — faite AVANT que Léo lance, parce que
  changer le prompt, la boucle ou les résultats simulés oblige à tout relancer, alors que changer le barème non.
  1. **La boucle du test est maintenant celle de Jaris EN ENTIER, prouvée par un test croisé** : relances
     correctives (mail, recherche, promesse/nom d'outil), réflexion gardée entre deux appels (canal voix), historique
     plafonné à 12, réponse nettoyée comme à la voix. Les MÊMES réponses de modèle passent dans le VRAI converse()
     (assistant.ts chargé avec des outils simulés) et dans la copie : requêtes, réponses et état final doivent être
     identiques (~110 situations). Vérifié en introduisant 4 écarts : les 4 sont détectés (le plafond d'historique
     seulement après avoir ajouté une trace qui le dépasse — un test qui n'exerce pas une règle ne la protège pas).
     **Leçon générale : pour une copie de logique de production, comparer les SORTIES sur des traces partagées,
     pas relire la copie.** Les relances de Jaris sur-déclenchent parfois (une question finissant par « ? » exige
     une recherche web même après get_system_stats) : c'est le comportement réel, le test le mesure et le note.
  2. **Simulateur aligné sur les vrais outils** : format exact des notes (titre, horodatage, insensible à la casse
     comme Windows), messages d'erreur complets (listes de touches/actions), URL refusées, échec de saisie qui
     n'interrompt pas, échec qui LÈVE (court-circuit « Échec de l'outil »). **Vrai bug de Jaris trouvé au
     passage** : `Boolean("false")` vaut vrai — `replace: "false"` effaçait une note, `restart: "false"`
     redémarrait. Corrigé par `toolFlag` (tools.ts).
  3. **40 demandes différentes + 8 rejouées** (même coût que 24 × 2), dont : sans outil (merci, blague, heure),
     échec en cours de route, clarification suivie de la réponse, délai à calculer, résultats qui CHANGENT au 2e
     passage (prix, météo : on lit, on ne se souvient pas). Réussite moyenne PAR demande d'abord.
  4. **Tout ce qui ne se reconstruit pas est enregistré** dans `<résultats>.traces.jsonl` (ajouté au fil de
     l'eau) : requêtes exactes, réponses brutes (réflexion, done_reason, tokens, durées de chargement et de
     génération), réflexion réellement envoyée, temps jusqu'au 1er outil, état final, configuration /api/show
     (réglages, niveaux de réflexion, modèle de prompt), part carte graphique/processeur (/api/ps), empreinte
     du code du test, version de Jaris. Vérifié sur le vrai Ollama : pour un modèle « avec/sans » (qwen3),
     `think: "medium"` donne exactement la même réponse que `true`.
  5. **Vision : négations refusées (« ce n'est pas 14 ») et 7 cas de VISÉE** — une vraie étape de
     computer_use_task (prompt, message et lecture de l'action exportés de computerUse.ts, copies vérifiées) :
     le clic doit tomber dans l'élément (boîtes mesurées en fabriquant les captures, vision-tests/cibles.json),
     et « fini » seulement quand c'est fini. Des coordonnées sur 1000 (habitude de certains modèles) ratent : c'est
     ce que ferait Jaris. **Code** : une 2e valeur par application (une réponse écrite en dur échoue) et les
     boutons-icônes retrouvés (titre SVG, nom dans le code, icône seule à cet endroit).
  Régression : test-benchmark-scenarios, test-benchmark-vision, test-benchmark-code, test-benchmark-cases.

- **Étape 234 — bêta de Jaris par Claude pendant le pilote des tests de modèles (Léo : « tu vas bêta tester
  jaris et trouve des bugs »).** Méthode, à réutiliser : le VRAI paquet (`electron-builder --linux dir`, dans un
  dossier À PART de celui qu'utilise un test en cours — reconstruire par-dessus écraserait ses scripts), lancé par
  Playwright `_electron` sous Xvfb, avec un faux Ollama scripté qui journalise chaque requête et un petit serveur
  HTTP pour envoyer des commandes à l'appli. Ce que ça a trouvé, et que les tests de composants isolés ne
  voyaient pas :
  1. **Une exception dans UN écran vidait TOUTE la fenêtre** (menu compris, seule issue : redémarrer). Cas réel :
     « Cerveau de Jaris » sans WebGL (pilote, machine virtuelle) — `new ForceGraph3D()` lève « Error creating
     WebGL context ». La vue 3D est maintenant dans un try/catch avec une LISTE des notes à la place, et chaque
     écran (Chat, Code, Image, Vidéo, vocal, Options, Cerveau) est entouré d'un `ErrorBoundary` qui affiche
     l'erreur à SA place, avec « Réessayer » (et « Fermer » pour le Cerveau, plein écran). **Leçon : sans
     ErrorBoundary, React démonte tout l'arbre à la première erreur de rendu ou d'effet — un écran secondaire
     peut rendre l'application entière inutilisable.**
  2. **La fiche d'une note du Cerveau tombait hors de l'écran, même en 3D** : la famille de panneaux à équerres
     (écrite plus bas dans index.css) remettait `position: relative` sur `.memory-brain__note`, `absolute` à
     l'origine — à spécificité égale, la dernière règle gagne (même piège que l'étape 95). « 2 notes » pour une
     seule : le nœud central (l'utilisateur) était compté.
  3. **Écran d'installation** : un échec s'affichait deux fois (ligne d'état ET liste), et la barre continuait
     d'animer une fois tout arrêté — ce qui se lit « ça travaille encore ».
  4. **Le budget de téléchargement des modèles** recommandés au premier lancement ne suivait pas la même formule
     que le choix des modèles : il pouvait proposer un modèle que le contrôle de faisabilité refusait ensuite
     (`downloadBudgetGb`, systemResources.ts, partagée). Écran de capacité : lignes « manquant » masquées avant
     toute installation (rien n'est encore installé, ce n'est pas un défaut), carte graphique « non détectée »
     au lieu d'un vide, ligne Code ajoutée.
  5. **Textes qui renvoyaient à rien** : « voir le README » (aucun fichier livré), « pipeline vocal »,
     « sidecar », « docker compose up -d » (SearXNG), des onglets d'Options qui n'existent plus — un test vérifie
     maintenant que tout « Options → X » affiché désigne un onglet réel.
  6. **Chat** : blocs de code affichés avec leurs « ``` » ; l'avertissement « machine chargée » collé d'un espace
     à la réponse écrite (il cassait un bloc de code placé en tête) — paragraphe à part à l'écrit, espace à voix
     haute.
  7. **Rappels** : relancés deux fois au démarrage (deux minuteries, deux annonces) et seulement si la voix
     démarrait ; un rappel posé depuis le Chat ou le téléphone ne prévenait que par la voix. Un seul
     `fireReminder` (main.ts) : notification Windows + journal + annonce vocale si elle tourne.
  8. **Version d'Ollama** : rien n'était enregistré quand Ollama ne répondait pas ou que GitHub était
     injoignable, donc Options affichait « Vérification de la version… » sans fin — un résultat partiel est
     maintenant gardé et expliqué ; interface locale dupliquée de `OllamaVersionStatus` (piège déjà noté :
     grep `interface NomDuType`). **Python** : téléchargement sans délai ni avancement, et un 403 de
     GitHub (60 lectures/heure sans compte) affiché « HTTP 403 » — message clair, et `downloadToFile` partagé.
  Régression : test-error-boundary-ui (Chromium lancé avec `--disable-3d-apis`), test-runtime-setup-ui,
  test-download-budget, test-options-references, test-format-reply, test-reminders, test-python-download,
  test-assistant-history. Chacun vérifié en réintroduisant le défaut. **Non vérifiable ici** : Image et Vidéo
  (Windows seulement), la voix (pas de micro), et le rendu WebGL réel sur la machine de Léo.
  **Deux pièges revécus au premier passage en CI** (aucun installeur publié) : (1) un motif sur plusieurs lignes
  (`\n`) contre un fichier source lu tel quel — la CI extrait le dépôt sous Windows en CRLF, normaliser
  `\r\n` AVANT (déjà écrit plus haut, et oublié quand même) ; pour le reproduire ici :
  `git -c core.autocrlf=true worktree add --detach <dossier> HEAD`, puis `npm test` dedans. (2) Un test de
  minuterie à 120 ms en temps RÉEL échouait sur une machine chargée (le rappel sonnait avant d'être réarmé) :
  horloge simulée (`t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })`), jamais une attente réelle courte.
  (3) `new URL('../', import.meta.url).pathname` comme dossier : « /D:/... » sous Windows, donc « D:\\D:\\... » une
  fois passé à `join` — toujours `fileURLToPath(...)`. Ces trois-là ne se voient PAS sous Linux : seule la CI
  Windows les attrape, d'où l'intérêt de la copie CRLF avant de pousser.

- **Étape 235 — deuxième relecture ChatGPT avant la grande campagne (v0.28.2).** Trois remarques, toutes
  vérifiées dans le code avant d'y toucher, toutes justes :
  1. **Une demande en erreur perdait tout ce qui s'était passé avant** : la trace n'était écrite qu'à la fin, et
     une erreur d'Ollama au 2e appel (après une première action) laissait `turns: []` et `calls: []`.
     `runScenario` reçoit maintenant `onEvent` : chaque requête est écrite AVANT l'envoi (`demande-requete`),
     chaque réponse (`demande-reponse`) et chaque résultat d'outil (`demande-outil`) dès qu'ils arrivent ; une
     erreur inattendue emporte avec elle ce qui a déjà été joué (`err.partial`), gardé dans la trace et dans les
     données brutes. Même défaut corrigé au passage dans le test de CODE : si l'ouverture dans le navigateur
     plantait après la génération, le HTML généré était perdu.
  2. **Des dates contradictoires dans les résultats simulés** : l'horloge dit « dimanche 4 octobre 2026, 10 h »,
     mais le cinéma annonçait « samedi 4 octobre » puis « dimanche 5 », le Bitcoin « ce samedi », la météo de
     « demain » un « dimanche 5 octobre ». Un modèle attentif aurait pu être pénalisé pour l'avoir remarqué.
     ChatGPT n'en avait relevé qu'une : un `grep` de tous les jours et dates du fichier a trouvé les deux
     autres. Un test vérifie maintenant chaque « <jour> <date> », « ce <jour> » et « demain… <jour> » contre
     l'horloge (commentaires exclus, ils citent justement les anciennes erreurs). SCENARIO_TEST_VERSION 2 → 3.
  3. **Aucun délai maximal par appel** (choix volontaire, pour les gros modèles lents) : une
     génération figée bloquait toute la campagne, sans surveillance, pendant des jours. Délai de 20 minutes par
     appel (`JARIS_CALL_TIMEOUT_MIN`), quatre fois le plus long jamais mesuré chez Léo. Un dépassement est un
     échec DU MODÈLE noté à part (`timeout: true`, « délais dépassés » dans le résumé) — Ollama est interrogé
     juste après : s'il ne répond plus, c'est le chemin « Ollama tombé » habituel (arrêt propre, aucun faux
     score). Le modèle est déchargé après un dépassement, n'est jamais retenté « sans réflexion » (ce serait 20
     minutes de plus), et après 3 dépassements de suite ses tests restants de la partie sont notés « non joué »
     (`skipped: true`) au lieu de coûter 20 minutes chacun.
  **Leçon générale : pour un test long sans surveillance, tout ce qui peut attendre indéfiniment doit avoir une
  borne, et tout ce qui ne se reconstruit pas doit être écrit AVANT l'étape qui peut échouer, jamais après.**
  Et quand une relecture signale UNE occurrence d'un défaut de données, chercher toutes les autres avant de
  corriger. Régression : test-benchmark-scenarios (erreur au 2e appel avec un faux Ollama, modèle figé avec un
  délai de 0,6 s, cohérence des dates), chacun vérifié en réintroduisant le défaut.
  **Suite (v0.28.3)** : ma correction du test de code ne couvrait que l'erreur ORDINAIRE du navigateur — une panne
  complète (`BrowserDownError`, qui arrête le test) ou un PC éteint pendant la vérification perdait encore la
  génération. Elle est maintenant écrite (`code-generation`) AVANT d'ouvrir le navigateur. **Leçon : « écrire avant
  l'étape qui peut échouer » vaut pour TOUS les chemins de sortie, y compris ceux qui relancent l'erreur sans passer
  par le code de récupération.** Régression : test-benchmark-cases (navigateur qui marche à la vérification
  préalable puis ne démarre plus).

- **Étape 236 — répétition générale des tests de modèles sur ce serveur (sans carte graphique), avant la grande
  campagne de Léo.** Le programme de test lancé pour de vrai, sur de vrais modèles (ministral-3:3b pour les
  demandes, qwen3-vl:2b pour la vision, qwen2.5-coder:7b pour le code) : chaque verdict relu à la main. 23
  demandes, 14 cas de vision et 2 applications : AUCUNE erreur de jugement du test. Les ratés étaient de vrais
  échecs des modèles (date d'anniversaire inventée au lieu de lire la note, correction ajoutée sans `replace`,
  délai de rappel inventé, `click_element` demandé alors que le message dit explicitement qu'aucun élément n'est
  disponible…). Raccourcie en cours de route à la demande de Léo (trop lente sur processeur) : demandes non
  rejouées, vision faite une fois, code sur 2 applications sur 5.
  Ce qu'elle a apporté :
  1. **qwen3-vl:2b réfléchit malgré `think: false`** (8 000 à 28 000 caractères de réflexion pour un clic), et
     une fois jusqu'à remplir toute la fenêtre (8 192 tokens) sans rien répondre. Le verdict « réponse vide » était
     juste mais muet sur la cause : vision et code disent maintenant « réponse coupée : fenêtre de contexte
     pleine » (`cutNote`), comme les questions et les demandes le faisaient déjà. C'est aussi ce qui arriverait
     dans Jaris (même appel) : la campagne mesurera ce temps sur la vraie carte.
  2. **Journal des gestes du test de code** (Léo : « on ne sait pas s'il l'a vraiment fait ou pas ») : chaque
     bouton cherché (trouvé par son texte, son nom dans le code ou comme seule icône, cliqué à quel point), chaque
     saisie, chaque lecture de l'écran, chaque erreur JavaScript, dans l'ordre — dans les traces (`steps`) et
     dans le détail lisible. Un verdict « juste » se revérifie sans relancer : sur la répétition, le compteur
     généré lève une erreur (localStorage interdit par l'aperçu, comme dans Jaris) APRÈS avoir mis l'affichage à
     jour — le journal le montre, et le verdict « juste » est confirmé à la relecture.
  3. **Engagement pris auprès de Léo** : après sa campagne, il envoie les DEUX fichiers
     (`benchmark-nouveaux-modeles.md` et `.traces.jsonl`, dossier de données de Jaris) et je vérifie TOUT — chaque
     réponse, justes comprises, et chaque application, rouverte et testée moi-même — pas seulement les ratés.
  **Leçon générale : une estimation de durée faite sur un serveur sans carte graphique doit compter les cas
  lents (plusieurs tours, réflexion cachée), et ne pas lancer d'autres tâches lourdes en parallèle** : annoncer
  « 1 h 30 » puis « 3-4 h » a coûté la confiance de Léo deux fois de suite.
  Régression : test-benchmark-code (journal des gestes, vérifié en le retirant), test-benchmark-cases (réponse
  coupée en lecture et en visée).
  **Suite (v0.28.5), en revérifiant partie par partie « est-ce que TOUT est enregistré ? » dans le CODE, pas de
  mémoire** : deux trous trouvés. La requête exacte des questions de LECTURE en vision n'était pas écrite (seule la
  question, la visée l'était déjà) ; la liste exacte des OUTILS envoyés aux modèles ne figurait nulle part dans le
  fichier brut (seule l'empreinte du code permettait de la retrouver). Les deux y sont maintenant. **Leçon : à la
  question « tout est-il enregistré ? », relire chaque appel au modèle et comparer ce qui est ENVOYÉ à ce qui est
  ÉCRIT — une réponse de mémoire avait déjà dit « oui » avec ces deux trous.**
  **Suite (v0.28.6) : la VEILLE de Windows.** Rien n'empêchait le PC de s'endormir pendant 1,5 à 3 jours sans
  surveillance : au réveil, une requête coupée en pleine génération passait pour un modèle figé (délai dépassé)
  ou un Ollama arrêté (arrêt du test). `testUnscoredModels` (benchmarkRunner.ts) tient maintenant
  `powerSaveBlocker.start('prevent-app-suspension')` (PC éveillé, écran libre de s'éteindre) du lancement jusqu'à
  la fin du test, y compris quand Jaris l'arrête (`release()` sur 'close' et 'error'). **Leçon : avant un long
  traitement sans surveillance, se demander ce que fait le SYSTÈME pendant ce temps (veille, mises à jour,
  redémarrages), pas seulement le programme.** Régression : test-benchmark-runner-cleanup.

- **Étape 237 — pendant la grande campagne de Léo (fichier brut relu au fil de l'eau), quatre changements gardés
  EN LOCAL jusqu'à la fin** : publier une version pendant le test aurait proposé une mise à jour à Léo, donc
  l'aurait invité à interrompre 1,5 à 3 jours de mesures.
  1. **Deux jugements trop stricts** (benchmark-scenarios.mjs, rejugés sur le fichier brut sans rien relancer) :
     la météo « pluie faible » refusait « il pleut » (motif élargi à pleu/pluv/averse) ; « YouTube + guitare »
     comptait faux un modèle qui regardait l'écran pour vérifier (look_at_screen ajouté aux appels permis).
  2. **Vrai bug de Jaris trouvé dans ces réponses** (assistant.ts) : après une réponse tirée de la MÉMOIRE
     (recall_memory) ou de l'état du PC (get_system_stats), la relance « cherche sur internet » se déclenchait
     quand même — seule une recherche web comptait comme « déjà cherché ». Liste commune `LOOKUP_TOOLS`, copiée
     dans le simulateur et vérifiée identique par un test. À la vérification finale, les demandes touchées
     (memoire-vive, stats-chaleur, anniversaire, soeur-inconnue...) sont rejugées sur la réponse d'AVANT la relance.
  3. **Seuils de vitesse décidés par Léo** (hardwareScan.ts) : Rapide 50 %, Médium 20 %, Puissant/Vision/Code
     sans minimum, de la vitesse Artificial Analysis du plus rapide parmi les meilleurs aux outils. Un modèle sans
     vitesse publiée est exclu de Rapide mais reste candidat en Médium. **Piège évité de justesse** : monter
     Médium pour qu'il diffère de Puissant le rendait identique à Rapide — Léo l'a relevé ; vérifier les TROIS
     rôles ensemble après tout changement de seuil, pas seulement celui qu'on vise.
  4. **Rejeu des délais dépassés** (Léo : « bon c'est bon, faux c'est faux, et dès qu'il n'a pas eu le temps, on
     refait… on teste tout »). Seulement les cas arrêtés par le délai (ou « non joués » après 3 délais) — demandes,
     vision ET code : une panne de TEMPS. Jamais une mauvaise réponse, ni un appel d'outil mal formé : les rejouer
     jusqu'à ce qu'ils passent fausserait le score. `replayTimedOut` (benchmark-models.mjs) : même graine, même
     variante, même image, délai porté à 120 min ; nouvelle ligne `replay: true` dans le fichier brut (le tableau .md
     n'est PAS recalculé — le score final se fait sur le fichier brut). Jaris lance toujours le test en reprise : le
     rejeu se fait donc à la FIN du même test, puis à chaque nouveau clic tant qu'un cas reste en délai. Garde-fou :
     3 délais de suite au rejeu arrêtent ce modèle (ses dizaines de cas « non joués » coûteraient sinon 2 h chacun).
     **Pièges des tests** : un modèle qui n'a répondu à RIEN est déjà retesté en entier à la reprise (ligne « — »),
     donc un faux modèle entièrement figé ne testait pas le rejeu ; et le faux Ollama de test-benchmark-cases ne
     répondait pas à `/api/version`, que le script consulte après un délai pour distinguer « modèle figé » de
     « Ollama arrêté » — sans lui, tout délai y passait pour une panne d'Ollama. Régression : test-benchmark-scenarios
     et test-benchmark-cases (vérifiés en coupant le rejeu, le garde-fou, puis en rejouant aussi les ratés).
  5. **Un modèle sauté n'était noté nulle part dans le fichier brut** : GLM-4.6V-Flash (vision) n'a laissé AUCUNE
     ligne pendant la campagne de Léo — sa raison n'existait que dans le fichier de résultats et dans le suivi en
     direct. Chaque modèle sauté écrit maintenant une ligne `modèle-sauté` (phase, raison). Sans score, il est de
     toute façon retenté au lancement suivant (Léo : « aucun modèle ne doit passer à cause d'un petit bug »).
     **Leçon : « tout est dans le fichier brut » se vérifie aussi pour ce qui N'A PAS eu lieu** — un cas sauté est
     une donnée, pas une absence de donnée. Régression : test-benchmark-cases (vérifié en retirant la ligne).
  6. **Les cas PLANTÉS sont rejoués aussi** (Léo, devant le tableau des modèles : « on va retester »). Une ligne
     « erreur : … » qui n'est pas un délai (appel d'outil qu'Ollama ne sait pas lire — XML mal fermé chez
     qwen3.5:0.8b/35b, échappement `\'` invalide chez ministral-3:8b/14b —, moteur tombé…) est rejouée UNE fois, à
     l'identique. Si elle replante au rejeu, c'est bien le modèle : elle reste comptée fausse et n'est plus retentée
     (sinon on la relancerait à l'infini). Les réponses vides ou coupées (fenêtre pleine pendant la réflexion) ne
     sont PAS des plantages : le modèle a répondu, mal, exactement comme il le ferait dans Jaris. Régression :
     test-benchmark-scenarios (vérifié en ne rejouant pas les plantages, puis en les rejouant sans fin).
  7. **La VÉRIFICATION d'une application pouvait planter, et passer pour une erreur du modèle** (fin de campagne) :
     « Cannot read properties of undefined (reading 'map') » sur la liste de tâches de qwen2.5-coder:14b et 32b.
     Le bouton « Supprimer » d'une ligne précise se cherchait à partir d'une FEUILLE contenant le texte de la
     tâche ; « <li>Acheter du pain<button>Supprimer</button></li> » (texte posé à côté du bouton, sans balise à
     lui) n'a aucune feuille de ce genre, et le cas « ligne introuvable » renvoyait un objet sans `seen`, lu ensuite
     sans garde. Corrigé (élément le plus profond qui contient le texte, `seen` toujours renvoyé). Les 35
     applications de la campagne revérifiées avec le test corrigé : seules ces deux-là changent, et passent justes.
     Au rejeu, un code dont SEULE la vérification a planté est revérifié tel quel (`recheck: true`) : le regénérer
     donnerait une autre application, ce ne serait plus le même test. **Leçon : une exception levée par le code de
     VÉRIFICATION doit se distinguer d'une erreur du modèle — sinon un bug du test se compte comme une faute du
     modèle.** Régression : test-benchmark-code (ligne sans balise, vérifiée en remettant l'ancienne recherche) et
     test-benchmark-cases (revérification sans regénération).
  8. **Le bouton « Tester les modèles » proposait les 42 modèles** après la campagne : il ne lisait que
     verified-tool-scores.md, pas encore mis à jour. `campaignCompletion` (hardwareScan.ts) lit le fichier brut
     de la campagne avec la même règle que le rejeu du script (dernière ligne de chaque cas ; délai dépassé, ou
     plantage pas encore rejoué = à refaire) : sur le vrai fichier de Léo, le bouton propose exactement les 8
     modèles à reprendre. Versions des tests recopiées côté Jaris, vérifiées identiques aux scripts par un test.
     **Piège rencontré, déjà connu** : un nouvel import (`fs`, `campaignCompletion`) dans benchmarkRunner.ts
     cassait les faux modules de test-benchmark-runner-cleanup — tous les tests du fichier tombaient sur « module
     non simulé ».

- **Étape 238 — vérification complète de la campagne de Léo, scores écrits, et un vrai bug de Jaris trouvé (v0.28.8).**
  1. **Demandes complètes : rejouées « à blanc »** (scripts de vérification hors dépôt) : chaque demande repasse
     dans le simulateur ACTUEL avec les réponses EXACTES enregistrées du modèle. 0 différence de messages sur
     1 440 : le simulateur reproduit fidèlement la campagne. **Leçon : quand toutes les réponses d'un modèle sont
     enregistrées, une correction de jugement ou de boucle se vérifie sur la campagne entière sans rien relancer —
     et la même méthode prouve en passant que le simulateur n'a pas dérivé.**
  2. **Jugements trop stricts ou trop laxistes, trouvés en lisant les réponses et pas en relisant le code** :
     `\b10\b` refusait « 10h » (pas de frontière de mot entre 0 et h) — 5 horaires de piscine justes comptés
     faux ; « 1,69 € » et « environ 61 200 € » (arrondis) refusés ; « pas de lait de viande » lu comme une viande
     proposée ; « je ne me souviens pas » non reconnu comme un aveu ; et dans l'autre sens, des titres YouTube
     inventés (« Voici quelques résultats… chaîne… ») et une non-blague comptés justes. En vision, un prix écrit
     en lettres refusé alors que les consignes de Jaris demandent une réponse « comme à l'oral ». **Leçon : relire
     aussi les réponses comptées JUSTES — un jugement laxiste ne se voit jamais dans la liste des ratés.**
  3. **VRAI BUG DE JARIS : les clics du pilotage d'écran tombaient à côté.** La consigne demandait des pixels,
     mais les modèles de vision (Qwen3-VL, Qwen3.5, Gemma 4 26B/31B, GLM-4.6V) répondent sur une échelle 0–1000
     — leur convention d'entraînement, plus forte que la consigne. Repéré parce que presque TOUS les modèles
     cliquaient au même endroit faux avec le même décalage : relus en 0–1000, qwen3.8:27b passe de 3 à 9 clics
     justes sur 10, gemma4:26b de 3 à 10. Corrigé dans computerUse.ts (`fromThousandths`) : consigne en 0–1000,
     ramenée aux pixels de l'image puis à l'écran ; une valeur au-delà de 1000 reste lue en pixels. **Leçon : une
     erreur commise IDENTIQUEMENT par des modèles différents vient presque toujours de nous, pas d'eux.** La visée
     doit être remesurée (test de vision version 4) : seuls les 11 modèles de vision repassent.
  4. **Ce qui n'a PAS été changé, en connaissance de cause** : « regarde l'écran » en pleine tâche arrête le tour
     dans Jaris (62 demandes comptées fausses, 2-3 par modèle, donc sans effet sur le classement) — défaut de
     conception de Jaris, pas du test ; l'écran simulé ne montre pas l'application ouverte (sans effet sur les
     verdicts). Deux applications de code restent fausses à raison (tâches gardées dans le stockage du navigateur,
     interdit dans l'aperçu : la liste reste vide).
  5. **Scores écrits** (verified-tool-scores.md) : demandes complètes des 30 modèles, code des 7 sur 5. Le choix des
     modèles ne change pas sur la machine de Léo. Au rejeu : plus de retéléchargement pour revérifier un code déjà
     écrit, et chaque modèle rejoué s'affiche dans le suivi (« N cas refaits », jamais présenté comme un score).
     **Piège revécu** : écrire de vrais scores casse les tests qui lisaient le fichier réel en supposant « rien de
     noté » — leur donner explicitement les scores d'avant au lieu de compter sur l'état du dépôt.
  Régression : test-benchmark-scenarios, test-benchmark-vision, test-computer-use, test-benchmark-cases,
  test-unscored-models-ui, test-verified-scores (chacun vérifié en retirant la correction qu'il protège).

- **Étape 239 — remesure de la vision après le correctif 0–1000 (v0.28.9) : le correctif est confirmé en usage réel.**
  Test de vision version 4 lancé par Léo avec Jaris 0.28.8 : 374 réponses, aucune erreur, aucun modèle sauté. La
  visée bondit pour les modèles qui visaient en 0–1000 : qwen3.8:27b 7/14 → 14/14, gemma4:26b 5 → 12, gemma4:31b
  5 → 11, qwen3-vl:4b 5 → 11, qwen3.5:4b 3 → 9. Les modèles déjà imprécis le restent (gemma4:e4b 2, qwen3-vl:2b 3)
  — la preuve que la conversion ne « donne » pas des points, elle lit juste correctement ce que le modèle vise.
  Chaque réponse fausse relue : une seule mal jugée (« 14 37 » pour 14:37, la bonne heure sans « h »), corrigée.
  Scores de vision écrits (sur 34) ; le choix des modèles ne change pas sur la machine de Léo (qwen3.8:27b, 34/34).
  **Piège de test revécu** : `assert.deepEqual(x, [])` sur un tableau créé dans un `vm.runInNewContext` échoue
  (« same structure but not reference-equal ») — comparer la longueur. Régression : test-benchmark-vision (horloge),
  test-verified-scores (vision sur 34, 11 modèles).

- **Étape 240 — relecture une à une des ~900 réponses comptées JUSTES aux demandes complètes (v0.28.10).** Léo a
  demandé si tout avait vraiment été vérifié : seules les réponses FAUSSES l'avaient été en détail. Relire les justes
  a trouvé 26 réponses comptées justes à tort, toutes dans des juges trop larges qui ne testaient qu'un mot-clé :
  « 47 » passait pour « 47 Go » (au lieu de 47 %), « guitar » pour un chat ASSIS sur une guitare, « 14 mars » pour
  « TON anniversaire est le 14 mars », la présence de farine/œufs/lait pour une recette inventée SANS recherche ou
  avec 5 litres de lait, le bon prix du gazole même attribué au SP95, la bonne météo même précédée de « il n'y a pas
  de prévision pour demain ». Aussi : note retenue sans titre (Jaris la range sous « note », introuvable ensuite),
  « Citroën Clio » mémorisée, délai de rappel inventé au lieu de demander quand, « ne l'éteins pas » sans réponse
  claire, une réponse entière en anglais et une avec des caractères chinois (nouvelle règle commune : la réponse
  lue à voix haute doit être en français). Chaque juge resserré a été vérifié sur TOUTES les réponses : un cas trop
  strict trouvé et corrigé avant de livrer (« par exemple, dans 30 minutes ? » proposé dans une question n'est pas
  un délai inventé). Les 11 meilleurs modèles ne perdent rien ; le choix des modèles sur la machine de Léo ne
  change pas. **Leçon : un juge qui cherche un mot-clé dans la réponse laisse passer toute phrase qui CONTIENT ce
  mot en disant autre chose — relire aussi les réponses comptées justes, pas seulement les fausses, avant de
  déclarer des scores vérifiés.** Petites erreurs secondaires laissées justes, en connaissance de cause (la
  réponse à la question reste bonne) : mauvais jour de la semaine à côté de la bonne date, « mesuré hier soir »,
  nom d'outil prononcé dans une réponse. Régression : test-benchmark-scenarios (« relecture des réponses comptées
  justes », chaque vraie réponse fautive ET une voisine correcte).

- **Étape 241 — les demandes complètes comptent dans le choix des modèles (v0.28.11).** Léo : « oui », puis « tu
  les fusionnes ? ». Les deux tests sont MULTIPLIÉS dans la note des rôles Rapide/Médium/Puissant : intelligence ×
  (réussite aux 78 questions)^5 × (réussite aux 48 demandes). Les 78 questions mesurent chaque appel d'outil isolé,
  les demandes la tâche entière : un modèle doit être bon aux deux. **Mesuré avant de choisir, sur 8
  configurations (0 à 24 Go de VRAM, 16 à 64 Go de RAM)** : multiplier ne change aucun choix aujourd'hui (garde-fou
  pour les modèles futurs) ; REMPLACER la fiabilité par les seules demandes (sans puissance) choisissait
  MiniCPM5-2B (35/48) au lieu de granite4.2:3b (44/48) sur 4 Go, sur sa seule intelligence — écarté. Vision et Code
  ne regardent pas les demandes (elles mesurent autre chose). Un modèle sans score de demandes du test ACTUEL est
  estimé par son taux aux 78 questions, jamais compté parfait (sinon un modèle non testé passerait devant les
  modèles testés). Choix sur la machine de Léo inchangés. Régression : test-hardwarescan-single-pool (« demandes
  complètes : multipliées… », vérifié en retirant le facteur puis l'estimation : le test échoue les deux fois).

- **Étape 242 — « regarder l'écran » en pleine tâche n'arrête plus Jaris, et relecture des réponses justes de vision
  (v0.28.12).** Deux points laissés ouverts à l'étape 240, faits à la demande de Léo (« fait le 1 et 2 »).
  1. **Le court-circuit de look_at_screen arrêtait les tâches.** assistant.ts renvoyait TOUJOURS la description de
     l'écran comme réponse finale (pour éviter de recharger le modèle de conversation après la vision). En pleine
     tâche, c'était faux : 67 demandes de la campagne de Léo, dont 31 fois « ouvre Discord et écris… » — l'écriture
     échoue, le modèle regarde l'écran pour comprendre, et Jaris répondait par la description de l'écran sans jamais
     dire que l'écriture avait échoué. Désormais, le court-circuit ne vaut que si la demande porte sur l'écran
     (`isScreenQuestion`, hardwareScan.ts) ET que c'est le tout premier outil de la demande ; sinon le résultat
     repart au modèle, comme n'importe quel outil. Le simulateur suit (copie vérifiée par le test croisé avec le
     VRAI converse(), qui échoue si on remet l'ancien court-circuit), et son écran simulé montre enfin ce que les
     actions y ont mis (application ouverte, texte écrit, champ resté vide après un échec) — avant, toujours
     Chrome, même juste après « Discord a été lancé ». Regarder l'écran pour vérifier une action À L'ÉCRAN est
     permis dans le jugement ; pour une question de météo ou de mémoire, il reste un appel non prévu.
     **Pas de rejugement possible à blanc** : les réponses du modèle APRÈS le regard n'ont jamais existé. Les 67
     demandes (22 modèles) sont donc marquées « à refaire » (`lookStoppedTask`, même règle dans Jaris et dans le
     script) et proposées par le bouton « Tester les modèles » ; une demande refaite après le correctif ne peut plus
     avoir cette forme, elle n'est donc jamais refaite deux fois. Rejeu à blanc des 1 373 autres : aucune
     différence. Les scores des demandes restent ceux d'avant tant que Léo n'a pas refait ces 67 demandes.
  2. **Vision : les 207 réponses de lecture comptées justes sont toutes bonnes.** Côté clics, chaque clic juste a
     été DESSINÉ sur sa vraie capture (pas seulement recalculé) : 5 tombaient 1 à 3 px AU-DESSUS de la barre de
     recherche YouTube et ne passaient que grâce à une marge de 4 px autour des cibles. Les boîtes viennent du rendu
     même de la capture et leur bord fait déjà partie de l'élément : marge retirée (gemma4:31b 31→29, gemma4:26b
     32→30, gemma4:12b 25→24 ; le choix Vision reste qwen3.8:27b partout). **Leçon : une tolérance « pour être
     gentil » sur un critère précis transforme des ratés en réussites — vérifier visuellement les cas qui ne passent
     QUE grâce à elle avant de la garder.**
  Régression : test-benchmark-scenarios (regard en pleine tâche, test croisé), test-hardwarescan-single-pool
  (demandes à refaire), test-benchmark-vision (clic juste à côté de la cible = faux, sur son bord = juste).

- **Étape 243 — le score des demandes complètes est affiché (v0.28.13).** Léo : « il y a seulement les questions
  visibles le score et pas le score de demandes » (puis, après avoir hésité à additionner les deux : « non en
  fait continue, ajoute un autre score »). Depuis l'étape 241 ce score compte dans le choix, mais aucun écran ne le
  montrait. Ajouté `demands` à ModelOverviewEntry (lu dans verified-tool-scores.md, seulement sur le total du test
  actuel) et affiché : (1) dans « Modèles utilisés sur ta machine », deux badges NOMMÉS pour Faible/Moyen/Élevé
  (« Questions 77/78 », « Demandes 45/48 ») — jamais deux nombres nus côte à côte, indiscernables ; Vision et Code
  gardent leur seul score, nommé d'après son total (« Images 30/34 », « Code 5/5 »), car les demandes ne comptent
  pas dans leur choix ; (2) dans « Tous les modèles », une colonne « Demandes complètes » triable. **Piège attrapé
  par une MESURE, pas à l'œil** : deux badges sur une ligne qui ne passe jamais à la ligne (`white-space: nowrap` de
  la table) faisaient déborder la carte à 420 px (515 px de tableau pour 378 px de carte) ; laisser passer à la ligne
  sans condition empilait les deux badges même en grand, parce que la colonne du modèle (`width: 100%`) prend toute
  la place restante. Corrigé par une requête de conteneur (`@container`, carte de moins de 540 px) : côte à côte
  quand il y a la place, l'un sous l'autre sinon. Le test vérifie les deux (même ligne en grand, aucun débordement
  à 420 et 480 px) et échoue bien sans la règle. Régression : test-my-model-picks-ui, test-options-reorganization-ui,
  test-hardwarescan-single-pool.

- **Étape 244 — le bouton « Tester les modèles » ne proposait pas les 67 demandes à refaire (v0.28.14).** Léo : « je
  vois pas tester les modèles avec la dernière version ». Le marquage « à refaire » de l'étape 242 était correct,
  mais deux filtres plus anciens l'écrasaient : côté Jaris, `getUnscoredModels` considérait fini tout modèle dont le
  score sur 48 est déjà recopié dans verified-tool-scores.md ; côté script, le rejeu ne regardait que les modèles
  SANS score recopié (`SCOPED_SCENARIO_MODELS`). Les 22 modèles concernés avaient tous un score recopié : ni proposés,
  ni rejoués. Corrigé des deux côtés : `campaignCompletion` renvoie aussi les modèles qui ont un cas à refaire
  (`todo`), proposés même avec un score recopié, et le rejeu prend tout modèle de conversation demandé. Vérifié
  avec le VRAI fichier de campagne de Léo : exactement les 22 modèles. **Leçon : mes tests de l'étape 242 passaient
  parce que leurs données n'avaient AUCUN score recopié — l'état réel de Léo (scores déjà écrits) n'était jamais
  testé. Un test de « ce qui reste à faire » doit partir de l'état réel, pas d'un état vierge.** Régression :
  test-benchmark-scenarios (vrai script, score déjà recopié), test-hardwarescan-single-pool (vrai fichier de scores).

- **Étape 245, journal des demandes (Léo : « ouvre Firefox et cherche une recette de tiramisu » à la voix → ~2 min
  avant Firefox, puis plus rien de visible).** Avant tout correctif, MESURER sur sa machine plutôt qu'une 4e
  hypothèse (leçon SearXNG) : `requestJournal.ts` écrit `journal-demandes.txt` dans le dossier de données (suit un
  « Déplacer », OWNED_ENTRIES). Chaque demande voix/Chat/téléphone : en-tête, chaque ligne déjà envoyée à `onLog`
  (outils et étapes du pilotage compris) avec le temps écoulé, et pour CHAQUE appel au modèle ce qu'Ollama dit
  lui-même (chargement du modèle, lecture, écriture, caractères de réflexion), plus la fin (réponse/erreur/annulée).
  À la voix, la durée de correction de la transcription est notée juste avant. Options → Général → « Journal des
  demandes » : ouvrir le fichier, ou le montrer pour l'envoyer. Choix : `converse()` devient une enveloppe autour de
  `conversation(journal, …)` (une seule entrée, tous les `return` couverts sans en toucher un seul) ; les mesures
  passent par un callback `onMetrics` de `chatWithOllama` — jamais un champ ajouté au message, qui repartirait
  dans l'historique envoyé à Ollama. Le journal n'échoue jamais (écriture en file + catch) et se coupe à une demande
  ENTIÈRE au-delà de 512 Ko. Les mesures du modèle ne vont QUE dans le fichier, l'écran reste identique.
  **Piège revécu, déjà noté ici** : le nouvel import dans assistant.ts a fait échouer ~40 tests dont les faux ponts
  ne connaissaient pas `./requestJournal` — penser au `grep` des faux ponts AVANT de lancer la suite.
  Régression : `node --test scripts/test-request-journal.mjs` (vraie boucle converse, vrai fichier ; chaque
  assertion vérifiée en réintroduisant son défaut). **Non vérifié ici** : les vraies durées sur le PC de Léo —
  c'est justement ce que ce journal doit apporter.

- **Étape 246, les 67 demandes refaites par Léo (06/10/2026), vérifiées avant d'écrire les scores.** Trois
  constats AVANT de juger quoi que ce soit : (1) le `.md` envoyé était identique octet pour octet à celui de la
  veille — normal, le rejeu n'écrit QUE dans les traces (« le tableau de résultats n'est pas recalculé ») ; ne pas
  conclure à un mauvais fichier ; (2) traces coupées en deux par Léo (> 30 Mo) : recollées, et le début vérifié
  identique au fichier de la veille, ligne pour ligne ; (3) empreinte du code de test = celle de la v0.28.14
  (`harness` de la ligne `campagne`) — attention, elle est calculée sur le fichier Windows en CRLF : recalculer
  avec des fins de ligne CRLF avant de croire à un code différent. 67 lignes `replay`, aucun délai, aucun
  plantage, aucune n'a plus la forme « arrêtée par le regard ». **Les anciennes lignes portent le jugement de
  l'époque** (`ok`) : les scores se calculent en rejouant les 1 440 réponses dans le simulateur ACTUEL, jamais en
  lisant `ok`. Lecture des 67 réponses une à une : 4 erreurs de JUGE, toutes nées du correctif de l'étape 242
  (le modèle continue désormais après avoir regardé l'écran, cas jamais vus avant) : titres YouTube inventés
  APRÈS avoir regardé l'écran (« le regard a eu lieu » suffisait au juge) ; clic dans Discord pour réessayer
  d'écrire compté faux (absent de `allow`) ; « je n'arrive pas à écrire » non reconnu ; « dans quelle conversation
  veux-tu que j'écrive ? » compté fausse réussite alors que la demande ne dit pas à qui. Ma première règle YouTube
  (le mot « titre ») attrapait « si vous avez un titre en tête ? » : vu en relisant CHAQUE verdict changé, pas en
  comptant. **Leçon : un correctif de comportement de Jaris crée des réponses que les juges n'ont jamais vues —
  relire les réponses refaites, pas seulement leur score.** Choix de modèles inchangés à toutes les tailles de
  carte (4 à 32 Go). Régression : test « relecture des 67 demandes refaites (étape 246) », chaque correctif vérifié
  en le retirant seul.

- **Étape 247, les 266 réponses comptées FAUSSES relues une par une (Léo : « tu me dis j'ai pas relu une par une,
  bah fais-le »).** Les justes avaient été relues aux étapes 241 et 246, pas les fausses : un juge trop SÉVÈRE ne se
  voit qu'en relisant ce qu'il refuse. Méthode : trier d'abord les échecs mécaniques (33 boucles de 10 allers-retours,
  20 réponses vides, 3 erreurs d'Ollama rejouées une fois, 5 réponses pas en français) — vérifiés en bloc mais
  vérifiés quand même (la recette « pas en français » d'ai9stars contenait bien « sur la表单 ») — puis lire les 205
  autres demande par demande, juge sous les yeux. 4 erreurs de juge, 10 réponses rendues justes : musique Spotify
  lancée par le pilotage d'écran (absent de `allow`, 6 modèles) ; « sans cette adresse, je ne peux pas envoyer le
  mail » lu comme un refus — la règle ne regarde plus que la phrase qui refuse SANS parler de l'adresse (2) ; « une
  Clio, pas Peugeot 208 comme je l'avais dit précédemment » — « précédemment » ne contient pas « précédent » (1) ;
  `get_system_stats` (lecture seule, instantanée) compté comme une action en trop, désormais parmi les outils sans
  effet ; `look_at_screen` reste exclu hors des demandes à l'écran (étape 242, il charge le modèle de vision) (1).
  **Leçon : un mot-clé de refus (« ne peux pas envoyer ») ou de date (« précédent ») teste un mot, pas un sens —
  relire la phrase entière autour avant d'en faire une règle.** Gardés faux après réflexion, et pourquoi : « 1 742 € »
  pour 1,742 € (lu à voix haute « mille sept cent… ») ; remplir l'adresse via le carnet d'adresses au 1er tour puis
  renvoyer le mail au 2e (destinataire jamais vérifié, mail en double). Choix de modèles inchangés de 4 à 32 Go.
  Régression : test « relecture des réponses comptées fausses (étape 247) », chaque correctif vérifié en le retirant
  seul ; et piège rencontré en l'écrivant : une demande de mail sans envoi déclenche la relance de Jaris — le script
  du test doit prévoir la seconde réponse, sinon il consomme le mauvais pas et passe ou échoue par hasard.

- **Étape 248, Firefox : le journal des demandes a tranché (« il ouvre les fichiers, il clique sur Google, il arrive
  vraiment pas »).** Deux causes MESURÉES, aucune devinée : (1) la réflexion de granite4.2:8b — 2 min 06 s et 13 741
  caractères de réflexion avant de simplement décider `open_app` (les « 2 minutes » de Léo), encore 40 à 60 s par
  décision ensuite ; (2) le pilotage d'écran — clic en (96, 1302) dans la barre des tâches, texte tapé au mauvais
  endroit puis « c'est fait » ; avec qwen3.8:27b, clic sur la croix en (2340, 58) puis « mauvais navigateur, j'ai
  fermé Firefox et ouvert Chrome ». Changer de modèle ou de navigateur par défaut (essayé par Léo) ne pouvait rien
  régler. Correctif : `browserSearch.ts` — « ouvre <Firefox|Chrome|Edge|le navigateur|Google|YouTube> et cherche X »
  ouvre DIRECTEMENT la page de résultats (Google, ou YouTube), sans modèle ni pilotage. Le navigateur nommé est trouvé
  dans « App Paths » du registre (HKCU puis HKLM, `reg query` sans aucune donnée de l'utilisateur) et reçoit
  l'adresse en ARGUMENT (`spawn`, jamais de shell) ; sinon le navigateur par défaut (`shell.openExternal`), en le
  DISANT. Recherche encodée par `encodeURIComponent` (test avec « & " | # \ »). Réponse honnête : « envoyée à
  Firefox », jamais « affichée » (même limite que open_app). Laissé au modèle : questions (« cherche sur internet
  qui est… » doit être répondu, pas ouvert), simple ouverture, suite d'actions (« … puis lance la première vidéo »).
  **Conséquence pour les tests de modèles** : « Va sur YouTube et cherche un tuto… » (demande youtube-guitare) est
  désormais prise par ce raccourci dans le vrai Jaris ; la demande reste dans la campagne (scores déjà mesurés, elle
  mesure la délégation au pilotage pour les formulations hors raccourci), et le test des raccourcis l'affirme
  explicitement au lieu de l'ignorer. **Non résolu ici et dit à Léo : la lenteur de réflexion du modèle pour TOUTES
  les autres demandes**, et le pilotage d'écran qui vise mal — à traiter séparément, avec le journal. Régression :
  `node --test scripts/test-browser-search.mjs` (phrases de Léo, refus des autres, adresse encodée, registre FR/EN,
  repli annoncé, voix + Chat sans appel au modèle, refus depuis le téléphone ; chaque garde vérifiée en la retirant).

- **Étape 249, duel des pilotes d'écran sur le VRAI écran (Léo : « on le teste contre l'autre en vraie
  situation »).** UI-TARS 1.5 7B (pilote actuel, ScreenSpot-Pro 49,6 %) contre MAI-UI 8B (Alibaba, Apache 2.0,
  73,5 % selon ses auteurs). Options → Modèles → « Duel des pilotes d'écran » : Jaris se cache 5 s, photographie
  l'écran, et Windows (UI Automation) donne la VRAIE position de chaque bouton — la vérité, pas un modèle ; chaque
  pilote vise chaque bouton avec SA consigne officielle (UI-TARS : celle du vrai pilotage ; MAI-UI : sa consigne
  de visée), avec et sans zoom (2e regard sur la moitié de l'écran autour du 1er point, appliqué aux deux pour être
  juste). **Aucun clic réel.** Rapport : `duel-pilotes/resultat-duel-pilotes.md` du dossier de données.
  **Faits vérifiés AVANT d'écrire le code, sur la source et pour de vrai** : (1) le mode « pilote complet » de
  MAI-UI est fait pour ANDROID (action `mobile_use`, boutons retour/accueil, applis Android — `src/prompt.py` de
  son dépôt) : sur Windows, son point fort est la VISÉE, d'où un duel de visée et pas un remplacement direct ;
  (2) le GGUF « winterSAT » n'a PAS de fichier de vision (mmproj) — celui de mradermacher l'a, même éditeur que
  le UI-TARS déjà utilisé, et Ollama 0.35.1 (installé ici, CPU) le charge bien (architecture qwen3vl + projecteur) ;
  (3) **coordonnées sur 0–999** (SCALE_FACTOR de son code) et non en pixels, comme le laissait croire son script
  d'évaluation — tranché sur une page de test aux positions connues. Essai du VRAI code du duel ici avec le vrai
  modèle : MAI-UI 7/10 au 1er regard, **10/10 avec le zoom** (les 3 ratés : boutons de 28 px, toujours visés un peu
  trop bas). **Piège de repère évité par construction** : capture ET rectangles pris par LE MÊME processus
  PowerShell, déclaré DPI-aware avant tout — Electron capture en pixels logiques, UI Automation en pixels réels :
  mélangés, chaque cible serait décalée de 25 à 50 % sur un écran à 125-150 %, sans que rien ne le signale. Le CI
  Windows exécute vraiment la capture (image écrite, liste lisible) et vérifie la syntaxe PowerShell — rien de
  plus n'est vérifiable sans le PC de Léo. **Pièges de session** : `pkill -f "motif"` tue aussi la commande
  shell qui CONTIENT ce motif (deux essais arrêtés par erreur) — tuer par PID ou `pgrep -x` ; et un test du dépôt
  (« un modèle sauté donne sa VRAIE raison ») échoue si le disque de l'environnement a moins de 5 Go libres
  (marge de sécurité de téléchargement) : vérifié sur HEAD propre, c'était le modèle de 6 Go téléchargé pour
  l'essai, pas le code. **Décision du pilote : APRÈS le duel de Léo**, jamais sur les chiffres des auteurs ni sur
  ma page de test. Régression : `node --test scripts/test-pilot-duel.mjs` (cibles, consignes, échelle 0–999,
  repère UI-TARS, zoom reconverti, pilote injoignable, rapport ; chaque garde vérifiée en la retirant) et le test
  de l'onglet Modèles (`test-options-reorganization-ui.mjs`).
- **Étape 250, le 1er duel de Léo était FAUSSÉ — corrigé avant toute décision (UI-TARS 0/30, MAI-UI 4/30 puis
  6/30 avec zoom).** Relu cible par cible avant de conclure quoi que ce soit : **14 cibles sur 30 étaient des
  boutons de Jaris lui-même** (« AGENT VOCAL », « NOUVELLE VIDÉO », « CAPTURE DANS 5 S… »), absents de la photo
  puisque Jaris s'était caché — `GetForegroundWindow` renvoyait encore sa fenêtre cachée comme « fenêtre active ».
  La fenêtre Discord de Léo n'a jamais été visée. Sur les 16 cibles valides : MAI-UI 4/16 puis 6/16, UI-TARS 0/16.
  **Trois corrections, chacune pour une cause lue dans le rapport, pas devinée** : (1) la fenêtre visée est la
  fenêtre VISIBLE la plus haute dans l'ordre Z qui n'appartient PAS au processus de Jaris (`JARIS_PID`), n'est ni
  réduite, ni masquée par Windows (« cloaked », DWM 14), ni transparente aux clics/d'outil, ni sans titre, ni
  minuscule, ni le bureau/la barre des tâches — et son titre est écrit dans le rapport et affiché dans l'écran du
  duel, pour que Léo voie tout de suite si c'est la bonne ; une capture sans AUCUN bouton dans la fenêtre est
  refusée avec un message clair (une capture « barre des tâches seulement » ne teste pas ce qu'il utilise).
  Chromium (Discord, Chrome, Edge…) ne construit son arbre d'accessibilité qu'au 1er client qui le demande : si
  la 1re lecture rend moins de 5 éléments, on relit une fois après 1,5 s. (2) Les noms de la barre des tâches
  contiennent des mots INVISIBLES à l'écran (« épinglé », « - 1 fenêtre en cours d'exécution », 2e ligne de
  l'horloge) : nettoyés (`cleanName`) avant de servir de consigne, et au plus 2 cibles de barre des tâches par
  capture. (3) UI-TARS recevait la consigne de NAVIGATION du vrai pilotage : il « réfléchissait » en chinois,
  répondait `finished` (« bouton introuvable ») ou faisait défiler — il perdait sur la consigne, pas sur la visée.
  Il reçoit maintenant la consigne de VISÉE de son dépôt officiel (une seule action, `click`, sans « Thought »),
  comme MAI-UI a la sienne ; la forme `point='<point>x y</point>'` de la version la plus récente de cette
  consigne est lue au même titre que `start_box`. **Leçon générale : avant de tirer une conclusion d'un banc
  d'essai, relire les cibles une par une — un score de 0/30 dit autant « le test est cassé » que « le modèle est
  mauvais », et ici c'était d'abord le test.** Non vérifiable ici : que la fenêtre choisie soit bien la bonne sur
  le PC de Léo (le CI Windows n'a pas de fenêtre ouverte) — c'est justement pour ça que son titre s'affiche.
  Régression : `node --test scripts/test-pilot-duel.mjs` (noms nettoyés, 2 cibles de barre des tâches au plus,
  homonymes écartés après nettoyage, consigne de visée d'UI-TARS réellement envoyée, les deux formes de point,
  fenêtre choisie hors Jaris, titre dans le rapport ; chaque garde vérifiée en la retirant) et
  `test-options-reorganization-ui.mjs` (titre de la fenêtre affiché).
- **Étape 251, UI-TARS retiré, MAI-UI 8B devient le viseur du pilotage d'écran (Léo : « oui, on enlève
  UI-TARS »).** Décidé sur le 2e duel de Léo, le valide (06/10/2026, ses vraies fenêtres : Explorateur, YouTube,
  Firefox, Discord ; vérité donnée par Windows, aucun clic) : 1er regard 14/40 contre 13/40, **avec zoom 30/40
  contre 22/40**, mais 28 s par bouton contre 7. Au 1er regard ils se valent ; la différence vient de la FORME de
  leurs erreurs — MAI-UI rate juste à côté (le zoom le rattrape), UI-TARS part souvent à l'autre bout de
  l'écran. **Nouvelle répartition des rôles** (computerUse.ts) : MAI-UI ne sait PILOTER que sous Android (son
  dépôt), il ne fait donc que VISER. Le modèle de vision décide toujours de l'action, avec la liste Windows des
  éléments (un clic par le nom reste exact et ne sollicite pas le viseur) ; pour un clic par position, il décrit
  sa cible (`target`, en anglais comme au duel) et MAI-UI la vise avec son zoom, sur UNE capture pleine
  résolution (`captureScreenForPilot`, vision.ts) dont la version réduite part au modèle de vision — deux
  captures prises à des instants différents ne montreraient pas forcément le même écran. **Le viseur est une
  précision en plus, jamais une condition** : réponse illisible, Ollama injoignable ou délai dépassé, la
  position estimée par le modèle de vision sert de secours et la raison est écrite dans l'historique ; seule une
  annulation arrête tout, sans clic. `SYSTEM_PROMPT` est resté identique (sa copie sert au test des modèles de
  vision) : la règle `target` ne s'ajoute que si le viseur est installé. **Piège évité en lisant le code
  voisin** : le modèle de vision choisit sa taille selon la mémoire vidéo LIBRE (`resolveVisionModel`) — avec
  MAI-UI encore chargé (6 Go), il serait passé sur un modèle plus petit à l'étape suivante ; le viseur est donc
  déchargé (`keep_alive: 0`) après chaque visée. **Migration** : un profil qui cite encore UI-TARS n'a PAS de
  viseur (UI-TARS ne comprend pas la consigne de MAI-UI), une bannière « MAI-UI 8B (pilotage d'écran) » invite à
  « Retester la configuration », qui installe MAI-UI et supprime UI-TARS avec la bonne raison. Taille vérifiée
  sur le dépôt Hugging Face (modèle 5,0 Go + lecteur d'images 1,2 Go) : seuil de 8 Go inchangé, le duel a tourné
  sur la carte de 8 Go de Léo. Retirés : uiTars.ts, le duel (écran, IPC, capture, rapport — son travail est
  fait), et le défilement/les combinaisons de touches ajoutés pour UI-TARS seul (inputControl.ts redevient
  identique à avant l'étape 231, vérifié par diff). **Non vérifié ici** : une tâche ENTIÈRE pilotée par MAI-UI
  sur le PC de Léo (le duel ne mesure que la visée), ni le temps total d'une tâche avec les changements de
  modèle sur une carte de 8 Go. Régression : `node --test scripts/test-mai-ui.mjs scripts/test-computer-use.mjs`
  (zoom reconverti à travers la vraie boucle, 1er regard volontairement faux corrigé par le zoom, secours sur
  réponse illisible et viseur injoignable, annulation sans clic, clic par le nom sans viseur, profil UI-TARS
  sans viseur et consigne intacte, déchargement après visée ; chaque garde vérifiée en la retirant),
  `test-benchmark-runner-cleanup.mjs` (UI-TARS remplacé et supprimé) et `test-my-model-picks-ui.mjs`.
- **Étape 252, « j'ai attendu 1 min sans rien, il doit soit nous dire ce qu'il fait, soit il bug » (Léo, à la
  voix : « Clique sur la première vidéo de la page »).** Le journal des demandes a tranché en une ligne, sans
  hypothèse : seule « Modèle choisi : granite4.2:8b (réflexion : medium) » était écrite — **le pilotage, et donc
  MAI-UI, n'avait même pas commencé**. Les entrées précédentes du même journal montraient le modèle de conversation
  réfléchir 40 s à 2 min 18 s (jusqu'à 13 741 caractères de réflexion) avant de simplement choisir un outil. Deux
  défauts distincts, corrigés séparément : (1) **attendre la réflexion pour une action évidente** — une phrase qui
  COMMENCE par « clique/clic/double-clique sur|dans… » part directement au pilotage, la phrase entière servant
  d'objectif (`directScreenTask`, assistant.ts, même principe que `directAppRequest` et `directBrowserSearch`) ;
  « sur/dans » doit suivre le verbe, donc « ne clique pas… », « clique pas sur… », « comment cliquer… » restent à la
  conversation (testé, et chaque garde vérifiée en la retirant). (2) **rien à l'écran en voix pendant ce temps** :
  une ligne sous la phrase entendue (écran vocal ET widget) dit ce que Jaris fait — « Je réfléchis… 45 s »,
  « Étape 2 : je vise the "Play" button… » — avec un compteur qui avance chaque seconde, la seule preuve qu'il
  n'est pas figé. Les lignes techniques du journal sont traduites en phrases courtes (`shared/voiceActivity.ts`,
  pur et testé) ; rien n'est lu à voix haute, conformément au choix déjà noté (raconter chaque étape serait
  pénible). La ligne est effacée dans le `finally` de la demande : une erreur ou une annulation ne peut pas la
  laisser affichée. **Non corrigé, volontairement** : la longueur de réflexion du modèle pour les AUTRES demandes
  (baisser la réflexion de la voix changerait la fiabilité des appels d'outils mesurée par les tests de modèles —
  à décider avec Léo, mesures à l'appui, pas en passant). Régression : `node --test scripts/test-voice-activity.mjs
  scripts/test-assistant-history.mjs`.
- **Étape 253, « dès qu'il y a un peu de conversation en historique, il se focalise sur les anciennes : il me parle
  de la recette de tiramisu quand je lui demande de cliquer sur la vidéo » (Léo).** Le journal donnait l'écart : la
  recette datait de 18 h, la vidéo de 21 h 34. Cause lue dans le code, pas devinée : `conversationSession.ts`
  envoyait au modèle les 6 derniers échanges QUEL QUE SOIT leur âge — et les rechargeait du disque au démarrage
  (choix de l'étape 47, pensé pour la continuité) ; un petit modèle local s'accroche à ce qu'il voit. Corrigé dans
  le code plutôt que par une consigne (leçon déjà notée : une consigne « ne fais pas X » ne tient pas face à un
  petit modèle) : **à la voix, seuls les échanges des 10 dernières minutes partent au modèle**
  (`VOICE_CONTEXT_MAX_AGE_MS`), chaque échange gardant désormais son heure. Une suite rapprochée garde donc son
  contexte (« et demain ? » après la météo), une demande faite des heures plus tard repart propre. Rien n'est
  effacé : le disque, l'écran et l'historique des Options restent identiques. **Le Chat n'est pas concerné, à
  dessein** : son fil est affiché, l'utilisateur voit ce qu'il continue (même logique que ChatGPT/Claude). Piège
  rencontré en écrivant le test : ajouter un échange AVANT la première lecture le faisait écraser par le
  chargement du disque — sans effet en vrai (chaque tour lit l'historique avant d'en ajouter un), mais le test
  doit reproduire cet ordre. Régression : `node --test scripts/test-voice-context-age.mjs` (vérifié en retirant le
  filtre : 2 tests échouent).
- **Étape 254, « tous les modèles ne sont pas installés sauf vidéo et image », même après « Retester » et un
  redémarrage (Léo).** Diagnostic par trois commandes en lecture seule envoyées à Léo, jamais deviné : `ollama
  list` VIDE ; ses modèles bien présents (36,3 Go) dans D:\jaris\ollama-models, derrière la jonction
  %USERPROFILE%\.ollama\models que Jaris pose ; mais la variable Windows **OLLAMA_MODELS = D:\ollama-models**. Ollama
  obéit à cette variable AVANT l'emplacement habituel : il lisait un autre dossier, et les modèles retéléchargés par
  « Retester » y atterrissaient aussi, invisibles. Jaris n'écrit jamais cette variable (vérifié par grep) : c'est le
  réglage « emplacement des modèles » de l'appli Ollama qui l'écrit. **Leçon générale : une jonction ne protège que
  les logiciels qui passent par l'emplacement habituel — une variable d'environnement qui désigne un autre dossier
  l'emporte silencieusement. Avant de conclure qu'un modèle « n'existe pas », regarder ce qu'Ollama LUI-MÊME voit
  (`ollama list`) et où il le cherche.** Corrigé au démarrage, avant de lancer Ollama
  (`alignOllamaModelsVariable`, ollamaModelsVariable.ts) : si la variable désigne un dossier qui contient MOINS de
  modèles (un fichier de manifeste par modèle) que celui de Jaris, elle est remise sur le dossier de Jaris, la
  variable du processus Jaris suit (le Ollama qu'il démarre en hérite), et Ollama est relancé — il ne relit ses
  variables qu'au démarrage. Jamais l'inverse : un dossier choisi et au moins aussi rempli est un choix de
  l'utilisateur. Variable posée pour toute la machine : prévenir seulement (droits administrateur). Rien n'est
  déplacé ni effacé. Même sans correction, Jaris réaligne sa propre copie de la variable sur Windows : corrigée à la
  main pendant qu'il tournait, il aurait sinon lancé Ollama avec l'ancienne valeur. Écriture par PowerShell, la
  valeur passant par une variable d'environnement, jamais dans le script. Piège dans mon test, attrapé en vérifiant
  qu'il mordait : le cas « même dossier, casse différente » passait AUSSI avec une comparaison stricte, parce que
  les deux dossiers comptaient 0 modèle — il faut que le mauvais choix change le résultat pour que le test prouve
  quelque chose. **Non vérifiable ici** : que l'appli Ollama ne réécrive pas sa variable à son lancement depuis
  ses propres réglages ; si c'était le cas, Jaris la recorrigerait à chaque démarrage et le dirait dans le journal.
  Régression : `node --test scripts/test-ollama-models-variable.mjs` (la machine de Léo, même dossier via casse/
  jonction, dossier choisi mieux rempli, variable machine, écriture refusée, vrai dossier de manifestes, ordre au
  démarrage ; lecture réelle de la variable sur la CI Windows).
- **Étape 255, « Échec de l'outil : Impossible de joindre le modèle de vision : The operation was aborted due to
  timeout » (Léo : « Sur YouTube, clique sur la barre de recherche… »).** Son modèle de vision est qwen3.8:27b
  (17 Go, sur une carte de 8 Go, donc en partie en mémoire vive) : le charger puis lire une capture d'écran dépassait
  la limite FIXE de 45 s de chaque étape du pilotage — le modèle travaillait, il n'était pas bloqué. **Même leçon que
  l'étape 98, appliquée cette fois aux appels de modèle** : une durée qui dépend de la machine se surveille par
  l'INACTIVITÉ, jamais par une durée totale. Le modèle de vision et le viseur répondent maintenant en continu
  (`streamOllamaChat`, computerUse.ts) : jusqu'à 3 min pour le PREMIER morceau (chargement + lecture de l'image),
  puis abandon seulement après 45 s sans le moindre morceau — tout morceau compte, même la réflexion cachée. Le
  message d'échec dit en français ce qui s'est passé (« il n'a rien répondu en 3 min », « il s'est arrêté de
  répondre pendant 45 s ») au lieu de l'anglais brut de Node. Le compteur de l'écran vocal (étape 252) montre
  l'attente en direct. Au passage, la phrase réelle de Léo commençait par un lieu (« Sur YouTube, clique… ») et
  ratait le raccourci de l'étape 252 : un lieu suivi d'une virgule est maintenant accepté devant le verbe (« Sur
  YouTube, ne clique pas… » reste à la conversation). **Non corrigé, à signaler à Léo** : avec un modèle de vision
  de 27 milliards de paramètres sur 8 Go, chaque étape du pilotage restera lente (une à plusieurs minutes, model
  swap avec MAI-UI compris) — c'est le choix de modèle, pas un bug. Régression : `node --test
  scripts/test-computer-use.mjs scripts/test-assistant-history.mjs` (minuteries pilotées : 3 min avant le premier
  morceau et plus 45 s, abandon après 45 s de silence seulement une fois la réponse commencée ; chaque garde
  vérifiée en la retirant).

- **Étape 256, pilotage d'écran et vitesse, après lecture du code d'Hermes Agent (Léo : « fait le 1 / 2 / 3 / 4 »).**
  1. **La liste des boutons venait de la fenêtre ACTIVE (`GetForegroundWindow`)** : quand Léo parlait depuis la
     fenêtre de Jaris, c'étaient les boutons de Jaris qui étaient listés, et la capture montrait Jaris par-dessus la
     page visée. Le duel des pilotes (étape 249) avait déjà corrigé ce choix de fenêtre, mais SEULEMENT dans son
     propre script : le vrai pilotage gardait l'ancien. **Leçon : un correctif fait dans un outil de mesure à côté
     ne corrige pas le chemin réel — reporter le correctif là où le bug vit vraiment.** La capture
     (`screenMarks.ts`/`markedCapture.ts`) prend maintenant la fenêtre visible la plus haute qui n'est pas Jaris
     (ordre Z, mêmes filtres que le duel, éprouvés chez Léo). Et Jaris s'écarte pendant la tâche
     (`pilotWindows.ts`, gestes fournis par main.ts) : la grande fenêtre se replie comme quand on clique ailleurs
     et NE revient PAS seule (elle couvrirait le résultat demandé) ; le widget reste affiché mais
     `setContentProtection` (invisible aux captures, comme l'animation de scan) et `setIgnoreMouseEvents`
     (transparent aux clics) le temps de la tâche.
  2. **Boutons numérotés sur la capture (Set-of-Marks, méthode d'Hermes)** : chaque élément que Windows connaît est
     encadré et numéroté sur l'image ; le modèle répond `{"action":"click_element","id":12}` et Jaris clique au
     centre du rectangle donné par Windows. Capture ET rectangles pris par LE MÊME processus PowerShell déclaré
     sensible au DPI (pixels réels), et le clic fait dans ce même repère (`clickMouse(..., physicalPixels)`,
     `SetProcessDPIAware` avant `SetCursorPos`). **Piège évité en lisant la doc, pas en testant (pas de Windows
     ici)** : UI Automation donne des pixels réels, l'ancien lecteur et l'ancien clic tournaient dans des processus
     non sensibles au DPI — sur un écran à 125 %, repères différents. Les numéros sont dessinés en TypeScript pur
     sur l'image brute (`drawMarks`, police de chiffres 3x5 intégrée) sur l'image RÉDUITE envoyée au modèle, pas
     sur la pleine résolution : dessinés en grand puis réduits, ils devenaient illisibles. Le viseur (MAI-UI) garde
     l'image PROPRE. Sans réponse de Windows, retour à la capture d'Electron d'avant, sans numéros (dit une fois
     dans le journal). Une ligne et le lien qu'elle contient (même rectangle) n'ont qu'un numéro. `SYSTEM_PROMPT`
     reste identique à sa copie du test de vision : la règle « clique par numéro » (`MARKS_RULE`) s'y ajoute
     seulement quand il y a des numéros, comme `PILOT_TARGET_RULE`. **Limite à dire à Léo** : le test des modèles
     de vision n'a pas été refait avec des captures numérotées.
  3. **Planifier sans image** (mode « ax » d'Hermes) : avec au moins 5 boutons listés, le modèle Médium du profil
     (souvent déjà chargé) choisit l'action d'après la liste numérotée et le titre de la fenêtre, réponse imposée
     en JSON (`format`), sans capture — le modèle de vision ne sert que s'il répond `look`, invente un numéro, ou
     dit « fini » alors que rien n'a été fait (sans image ce serait une supposition). Deux `look` ou une erreur du
     modèle rapide : on ne le resollicite plus pour cette tâche (éviter de recharger deux modèles à chaque étape).
  4. **La date à la minute près était au DÉBUT des consignes** : Ollama ne réutilise ce qu'il a déjà lu que si le
     début du texte envoyé est identique, donc il relisait ~4 300 tokens de consignes et d'outils à CHAQUE demande.
     Mesuré ici avec Ollama sur les vraies consignes et les vrais outils : 18,8 s → 0,8 s (qwen3:0.6b, attention
     classique) et 18,7 s → 5,5 s (qwen3.5:0.8b, modèle hybride : gain partiel, son état ne se reprend pas à
     n'importe quel point). La date est maintenant devant la question (`dateTimeNote`, « (Nous sommes le …) »),
     jamais dans l'historique, et les consignes disent au modèle de n'en parler que si on le lui demande. **Leçon :
     tout ce qui change d'une demande à l'autre va à la FIN de ce qu'on envoie au modèle, jamais au début** — un
     test vérifie que les consignes ne dépendent plus de l'heure. Copie du banc de test suivie (benchmark-cases,
     scénarios) ; **piège retrouvé dans mes propres tests** : les faux Ollama reconnaissaient chaque demande à son
     texte EXACT — la date en tête les a fait chercher un scénario inexistant, planter dans le gestionnaire de
     requête et laisser `node --test` bloqué sans message. `withoutDateTimeNote` les rend indépendants de la date.
     **Prudence** : les scores des modèles ont été mesurés avec la date dans les consignes ; le changement est
     petit (la même phrase, déplacée) mais pas remesuré.
  **Rien de ceci n'est vérifié en usage réel** (pas de Windows ici) : le choix de fenêtre et la capture sont repris
  d'un script qui a tourné chez Léo, mais les numéros dessinés, le clic sensible au DPI, `setContentProtection` sur
  le widget et la planification sans image ne le sont que par les tests et un rendu sur une vraie page dense.
  Régression : `node --test scripts/test-screen-marks.mjs scripts/test-computer-use.mjs scripts/test-pilot-windows.mjs
  scripts/test-ui-automation.mjs scripts/test-benchmark-vision.mjs scripts/test-benchmark-cases.mjs
  scripts/test-assistant-history.mjs scripts/test-voice-activity.mjs` (chaque nouvelle garde vérifiée en la retirant).

- **Étape 257, duel vidéo FastWan contre Kandinsky 6.0 Video Lite (Options → Général → Développeur).** Léo voulait
  savoir s'il existe mieux que FastWan 2.2 5B ; ChatGPT citait deux modèles que j'avais ratés. Vérifiés à la source :
  SANA-Video 2.0 5B est sous licence NON COMMERCIALE (CC BY-NC-ND 4.0, lu dans son papier) — inutilisable dans un
  Jaris vendu, ce que ChatGPT n'avait pas vu ; Kandinsky 6.0 Video Lite 3B (MIT, avec le son) n'a AUCUN chiffre publié
  pour sa version Lite. **Leçon : un modèle « plus petit » en paramètres n'est pas forcément plus léger à faire
  tourner** — Kandinsky 6 Lite (3B) compresse l'image 8 fois là où le décodeur de Wan 2.2 la compresse 16 fois : ~4
  fois plus de points à calculer à chaque étape, et 10 étapes contre 3. Et son lecteur de description (Qwen2.5-VL 7B,
  16,6 Go) pèse plus que le modèle vidéo lui-même. Comparer la taille annoncée ne suffit jamais : regarder aussi le
  décodeur, le nombre d'étapes et le lecteur de texte.
  Léo a préféré juger lui-même, chez lui : un bouton lance les mêmes 3 descriptions (humain, paysage, chat ; 2 s ;
  832×480 ; graine 42) avec les deux modèles, chronomètre chaque vidéo et enregistre son choix. **Jugement à
  l'aveugle** : vidéo A / vidéo B dans un ordre tiré au hasard, nom et temps révélés seulement après le choix — la
  vitesse de FastWan et les noms influenceraient sinon le regard. FastWan passe par le VRAI chemin de Jaris
  (generateVideo, même moteur, meilleure qualité déjà téléchargée) ; Kandinsky par python/video_duel.py dans un
  environnement Python À PART (torch 2.14.1 cu126 + diffusers de développement figé à un commit, ensemble résolu par
  pip une fois et figé dans video-duel-requirements.txt) : la voix n'utilise plus PyTorch, lui imposer ces versions
  risquait de la casser. Le lecteur de description reste sur le processeur (16,6 Go ne tiennent pas dans 8 Go), le
  modèle vidéo va sur la carte, et repart couche par couche si la mémoire vidéo déborde.
  **Vérifié ici pour de vrai, pas seulement par les tests** : script lancé de bout en bout sur le processeur
  (lecture des 3 descriptions, puis 3 mini-vidéos 224×128 avec le son ; fichiers H.264 + AAC 44,1 kHz relus) ; ma
  lecture des descriptions SANS remplissage (6 fois moins de jetons) comparée au pipeline officiel : similarité
  0,99993, écarts d'arrondi seulement ; le simple tokenizer donne les mêmes jetons que le « processeur » Qwen, qui
  exigeait torchvision. **Non vérifiable ici** : le passage sur une vraie carte NVIDIA (PyTorch CUDA, 8 Go, repli
  couche par couche) et l'installation sous Windows — c'est le premier essai de Léo qui le dira, et le duel enregistre
  la mémoire vidéo réellement utilisée et le mode de passage pour le savoir.
  Pièges rencontrés en route : un téléchargement lancé en arrière-plan avec `( … &)` s'est arrêté sans message après
  4 Go (25 minutes perdues) — les tâches longues se lancent avec `setsid nohup … < /dev/null & disown` ; `pkill -f`
  sur un motif présent dans la ligne de commande du shell lui-même tue ce shell — viser un numéro de processus.
  Le style « choisi » du bouton était écrasé par la règle de survol de la famille de boutons (plus spécifique) : même
  famille que le bouton resté gris de l'étape 97, attrapé par une mesure du style calculé, pas en relisant.
  Régression : `node --test scripts/test-video-duel.mjs scripts/test-video-duel-service.mjs scripts/test-video-duel-ui.mjs`
  (lignes RÉELLES du script, noms de fichiers sans chemin possible, enchaînement complet sur un vrai dossier,
  préparation une seule fois, carte graphique rendue même en cas d'échec, arrêt, aveugle avant le choix ; chaque garde
  vérifiée en la retirant).

- **Étape 258, duel vidéo RETIRÉ après le verdict de Léo : « FastWan 2.2 5B est mieux, il fait pareil que l'autre pour
  20 fois plus rapide ».** Le duel de l'étape 257 a rempli son rôle : un jugement de rendu tranché par Léo lui-même,
  chez lui, sur sa carte — pas par des chiffres. FastWan 2.2 TI2V 5B reste le modèle vidéo de Jaris (publié sur
  Hugging Face le 2 août 2025, d'après la date du premier commit de FastVideo/FastWan2.2-TI2V-5B-FullAttn-Diffusers).
  Code retiré par `git revert` des deux commits du duel (isolés et les plus récents, même méthode que Kokoro à
  l'étape 75), mais les notes et la version sont gardées : même convention que KDE Connect et Mobile connecté — le
  CODE part, l'HISTORIQUE reste (la leçon « un modèle plus petit en paramètres n'est pas forcément plus léger », le
  jugement à l'aveugle, le lancement des tâches longues avec `setsid nohup`).
  **Retirer le bouton ne libère pas le disque** : le duel avait téléchargé ~31 Go chez Léo (environnement Python +
  Kandinsky), et le bouton « Effacer les fichiers » partait avec le reste. `removeLeftoverVideoDuel`
  (legacyCleanup.ts, même endroit que le paquet du Montage retiré à l'étape 200) efface ces parties lourdes une fois
  au démarrage ; le dossier `resultats` (ses 6 vidéos et ses choix, quelques Mo) est gardé, ce sont ses données.
  **Leçon générale, déjà vraie pour le Montage : retirer une fonctionnalité qui a téléchargé quelque chose ne
  s'arrête pas au code — penser aux fichiers qu'elle a déjà posés sur la machine de l'utilisateur.**
  Régression : `node --test scripts/test-legacy-cleanup.mjs` (parties lourdes effacées, vidéos et choix gardés,
  deuxième démarrage et duel jamais lancé sans erreur).

- **Étape 259, « calcule 7 plus 5 » sur la Calculatrice : le pilote cliquait « 1 » en boucle jusqu'à la 20e étape
  (Léo, usage réel, v0.28.28).** Reproduit ici AVANT de corriger, avec le vrai code du pilote (consigne, message,
  lecture de la réponse) et un vrai modèle moyen (granite4.2:8b), sur la liste RÉELLE des boutons de la Calculatrice
  française (noms tirés de microsoft/calculator, Resources.resw fr-FR) : il cliquait « Deux » puis « Sept » huit fois
  de suite. Deux causes distinctes :
  1. **Windows nomme les touches en toutes lettres** (« Sept », « Plus », « Est égal à »). Le modèle devait traduire
     7 en « Sept » PUIS reprendre le numéro de la liste — deux nombres qui se mélangent (le chiffre voulu et le
     numéro de l'élément). Corrigé en écrivant le symbole à côté du nom (`keySymbol`, uiAutomation.ts :
     « 21. [Button] Sept « 7 » »), pour un nom ENTIER seulement (« Un article » reste tel quel). Mesuré sur la même
     simulation : 7, +, 5, = puis « fini » du premier coup.
  2. **Sans image, le planificateur ne voit pas l'effet d'un clic** (l'affichage de la Calculatrice n'est pas un
     bouton, donc absent de la liste) : il peut reprendre indéfiniment le même bouton. Au 3e clic identique
     d'affilée (`MAX_SAME_TEXT_CLICKS`), la vision reprend la main pour le reste de la tâche : elle, voit le
     résultat. Un 3e clic voulu (« tape 111 ») coûte seulement le passage à la vision, jamais un mauvais clic.
  **Non corrigé, à dessein** : donner au planificateur le texte affiché par la fenêtre (« L'affichage est 12 »)
  l'aide à conclure (mesuré dans la simulation), mais demande de modifier le script PowerShell de capture, que rien
  ne peut exécuter ici — pas un 3e changement non vérifiable en même temps. Mesuré aussi : sur « 9 fois 3 », le
  modèle moyen se trompe encore parfois de touche ; le garde-fou en limite l'effet, il ne rend pas le modèle plus
  juste. Les 2 minutes avant l'ouverture de la Calculatrice ne sont pas expliquées : pas de journal de sa machine.
  **Leçon générale : quand un modèle doit choisir un NUMÉRO dans une liste dont les éléments représentent eux-mêmes
  des nombres, écrire la valeur à côté du nom — sinon il confond le numéro de la ligne et le nombre voulu.**
  Régression : `node --test scripts/test-ui-automation.mjs scripts/test-computer-use.mjs` (noms réels français et
  anglais, nom partiel ignoré ; 3 clics identiques -> vision, clics non consécutifs -> rien ; le garde-fou retiré ou
  mal compté fait échouer les tests).

- **Étape 260, deuxième essai de Léo sur la Calculatrice (v0.28.29) : une minute à regarder l'écran, puis « action
  inexécutable » sans rien ouvrir.** Le message d'erreur contenait la réponse exacte du modèle de vision
  (qwen3.8:27b) : `{"action":"click","x":"396","y":"973","target":"…Rechercher… in the taskbar"}`. Deux causes :
  1. **Des nombres écrits entre guillemets** (`"396"`). `extractStep` exigeait le type nombre et rejetait toute la
     tâche après une minute d'analyse. Un test de l'étape 32 refusait même exprès `"x":"12"` : ce choix strict ne
     protégeait de rien (une chaîne de chiffres n'a qu'un sens) et a coûté la tâche entière en usage réel. Les chaînes
     de chiffres sont lues comme des nombres ; « 12px » ou « douze » restent refusés. Copie du test des modèles de
     vision (benchmark-vision.mjs) alignée — un exemple de « mauvaise » réponse y supposait l'ancien refus.
  2. **Ouvrir une application coûtait une capture par geste** : le modèle de vision passait par la recherche de la
     barre des tâches (clic, frappe, Entrée, vérification), soit environ une minute chacun avec un gros modèle de
     vision en partie en mémoire vive. Nouvelle action du pilote `open_app` (vision ET planificateur sans image) :
     Windows ouvre l'application en une étape, par le même `openApp` que l'outil de la conversation. Un nom introuvable
     n'est pas fatal (noté dans l'historique, le modèle peut repasser par le menu Démarrer). Règle ajoutée À PART
     (`OPEN_APP_RULE`, comme `MARKS_RULE`) : SYSTEM_PROMPT reste la copie exacte de celle du test des modèles de vision.
  **Leçon générale : une validation stricte d'une sortie de modèle doit refuser ce qui est AMBIGU, pas ce qui est
  seulement mal typé — refuser `"396"` ne protège de rien et transforme une petite imprécision en échec complet.**
  **Non vérifié ici** : le comportement réel de qwen3.8:27b avec la nouvelle action (trop gros pour cette machine) —
  vérifié par les tests sur ses réponses réelles, à confirmer par Léo en usage réel.
  Régression : `node --test scripts/test-computer-use.mjs scripts/test-benchmark-vision.mjs` (la réponse réelle de
  Léo exécutée au bon endroit ; ouverture par la vision et par le planificateur ; application introuvable non fatale).

- **Étape 261, « Reformule ce mail : … » pris pour une demande d'ENVOI.** Trouvé en préparant la démo comparée à
  Claude demandée par Léo (le cas d'usage qui revient partout dans l'étude MiroFish). Mesuré sur le VRAI `converse()` :
  le modèle répond le mail réécrit, puis `hasUnnegatedMailIntent` — déclenché par le seul mot « mail » — relance le
  modèle (« tu n'as pas encore appelé computer_use_task alors qu'un envoi de mail était demandé ») ; la réponse
  affichée devient celle d'après la relance (une demande d'adresse, voire un pilotage pour envoyer), pas le mail
  reformulé. Corrigé en exigeant un VERBE d'envoi (envoie, envoyer, expédier…) dans la CONSIGNE seulement — le texte
  avant le premier « : », « « » ou retour à la ligne : un mail collé qui contient « merci de m'envoyer le devis » ne
  doit pas compter. « Reformule ce mail et envoie-le à paul@… : … » garde sa relance. Même correction dans la copie du
  simulateur (benchmark-scenarios.mjs, comparée par le test croisé).
  **Leçon générale, déjà vue avec les négations : un mot-clé d'objet (« mail ») ne dit pas l'action voulue ; pour
  détecter une intention d'agir, chercher le VERBE de l'action, et seulement dans la consigne, jamais dans le
  contenu que l'utilisateur colle à traiter.**
  Régression : `node --test scripts/test-assistant-history.mjs scripts/test-benchmark-scenarios.mjs` (réécriture sans
  relance, voix et écrit ; vraie demande d'envoi relancée ; le test échoue si la consigne n'est plus isolée).

- **Étape 262, un mail RÉDIGÉ qui contient « je vais… » pris pour une promesse d'action non tenue.** Vu en mesurant les
  mails de la démo (granite4.2:8b, sans réflexion cachée) : la relance « promesse sans action » est partie sur la
  réponse au client mécontent, et la réponse finale a commencé par « Je n'ai pas décrit d'action… » avant le mail.
  Vérifié ensuite avec le vrai `PROMISE_WITHOUT_ACTION` : « … Je vais personnellement suivre son acheminement.
  Cordialement, Marc » déclenche bien (la formule de politesse fait moins de 5 mots, donc la phrase passe pour une
  promesse sèche). Corrigé par `isWritingRequest` : une CONSIGNE de rédaction (reformule, rédige, corrige, traduis,
  rends ce mail…, aide-moi à répondre, réponds à ce…, écris un mail/message/lettre…) — lue avant « : », « « » ou un
  retour à la ligne, sans accents — coupe ce filet-là seulement ; le filet « nom d'outil cité » et la relance d'envoi
  de mail restent actifs. « Écris bonjour dans le bloc-notes » n'est PAS une rédaction (action, filet gardé). Copie du
  simulateur (benchmark-scenarios.mjs) alignée. **Mesuré au passage, à ne pas refaire : couper la réflexion cachée pour
  aller plus vite sur les mails dégrade nettement le résultat** (raisonnement écrit dans la réponse, outil de mémoire
  appelé sans raison, tu/vous mélangés, faits inventés) — la vitesse doit venir d'ailleurs.
  **Leçon générale : un filet qui lit le texte du modèle pour y deviner une action doit savoir quand ce texte est un
  CONTENU demandé (un mail, une lettre) plutôt que la parole de Jaris — sinon il juge les phrases du mail comme si
  Jaris les disait.**
  Régression : `node --test scripts/test-assistant-history.mjs scripts/test-benchmark-scenarios.mjs` (mail rédigé rendu
  tel quel, voix et écrit ; vraie action annoncée relancée ; rédaction reconnue sur 7 phrases, 5 actions écartées).

- **Étape 263 (v0.29.0), pilotage en ARRIÈRE-PLAN (Léo : « on ne peut pas faire autre chose à côté, il faut être dans
  la calculatrice et attendre qu'il clique »).** Le pilote agissait avec la vraie souris et le vrai clavier, fenêtre
  devant : Léo ne pouvait plus se servir de son PC pendant une tâche. Désormais, sous Windows :
  - la fenêtre visée est **gardée d'une étape à l'autre** (poignée Windows) et **capturée seule** (PrintWindow, même
    cachée derrière celle de Léo) ; Jaris ne se replie plus et n'affiche plus l'animation plein écran ;
  - les clics par numéro passent par **l'accessibilité de Windows** (Invoke, Toggle, Select, ExpandCollapse) et le
    texte par **ValuePattern** dans le champ choisi juste avant (`backgroundControl.ts`) — aucune souris, aucun clavier ;
  - ce qui ne peut pas se faire ainsi (clic par position, touche, élément sans geste) **emprunte la souris un instant** :
    la fenêtre passe devant (AttachThreadInput, sans simuler Alt qui ouvrirait le menu de certaines applis), le geste
    est fait, puis la fenêtre de Léo revient. Si Windows refuse de la mettre devant, **rien n'est cliqué** (le clic
    tomberait chez Léo) et le pilotage d'avant reprend, annoncé ;
  - un délai dépassé sur Invoke (un bouton qui ouvre une fenêtre modale bloque l'appel) n'est **jamais recliqué** à la
    souris : l'action a peut-être eu lieu ;
  - après l'ouverture d'une application, Jaris suit la **nouvelle** fenêtre (liste des fenêtres prise juste avant),
    jamais celle où Léo travaille ; une **boîte de dialogue** de la fenêtre gardée (GW_ENABLEDPOPUP) est capturée et
    pilotée à sa place ; si la fenêtre gardée **se ferme**, Jaris ne pioche jamais une autre fenêtre en silence : il
    reprend l'écran, en le disant.
  Sans capture de fenêtre possible (hors Windows, ou PrintWindow refusé), le pilotage d'avant, inchangé.
  **Vérifié ici** : 60 tests de la vraie boucle (dont 11 nouveaux : 7 + 5 sur la Calculatrice sans un clic de souris,
  champ + texte, emprunt et restitution, refus de premier plan, délai, touche, repère de la fenêtre, nouvelle fenêtre,
  dialogue, fenêtre fermée), chaque garde-fou vérifié en le retirant ; les 4 scripts passés au **vrai parseur de
  PowerShell** (pwsh 7.4 ici, `powershell` 5.1 sur la CI Windows : `scripts/test-background-control.mjs`) et leurs blocs
  C# compilés. **Non vérifiable ici** : le comportement réel des applis de Léo (accessibilité exposée ou non, PrintWindow
  sur chaque appli) — c'est son usage réel qui le dira.
  **Leçons générales** : (1) PowerShell s'installe sous Linux (archive officielle) et son parseur
  (`[System.Management.Automation.Language.Parser]::ParseFile`) vérifie un script sans l'exécuter — une faute de syntaxe
  dans une chaîne TypeScript ne se voyait jusqu'ici que chez Léo ; (2) un accent grave (backtick) dans un commentaire
  PowerShell placé dans un gabarit JavaScript ferme le gabarit : le typecheck l'attrape, la relecture non ; (3) quand une
  automatisation garde une cible, elle doit savoir que la cible a DISPARU plutôt que d'en prendre une autre « au plus
  proche » — en arrière-plan, la plus proche est souvent la fenêtre de l'utilisateur.

- **Étape 265 (v0.31.1), revue du design v2 (Léo, capture à l'appui : « il y a plein de petits bugs, améliore tout le
  design »).** La capture montrait « Ouvrir le dossier » et « Fermer » SOUS les boutons réduire/agrandir/fermer de
  Windows : le Cerveau s'ouvrait en calque plein écran (`position: fixed; inset: 0`), alors que le design v2 cache la
  barre native et laisse Windows poser ses vrais boutons par-dessus, en haut à droite (titleBarOverlay, 3 x 46 px sur
  40 px). **Méthode, à réutiliser pour toute revue visuelle** : photographier TOUS les écrans du rendu compilé (clair,
  sombre, 480 px, 1000 px, 1600 px) avec de faux boutons Windows dessinés à leur place, puis MESURER au lieu de juger à
  l'œil : éléments sous ces boutons, texte rogné, contraste, boutons qui se chevauchent, sorties de fenêtre. Sept vrais
  défauts trouvés ainsi, dont cinq invisibles à la relecture du code :
  1. Cerveau sous les boutons de Windows → c'est maintenant un écran de la zone principale, comme Options (on en sort
     par le rail). L'aide de navigation en anglais de la vue 3D est masquée (`showNavInfo(false)`). L'ancien mode
     « calque » (props `overlay`/`onClose` d'ErrorBoundary, `.error-panel--overlay`) est supprimé, plus aucun usage.
  2. Les écrans du premier lancement (bienvenue, installation, configuration) n'avaient AUCUNE barre de titre : la barre
     native étant cachée, la fenêtre ne pouvait plus être déplacée avant la fin de l'installation.
  3. Des textes à 8,7-11 px (anciennes tailles en rem calculées sur 14 px) : remontés au minimum de Windows 11, 12 px
     (intitulés de réglages 14 px). Le widget, réglé avec Léo en usage réel, n'a pas été touché.
  4. Contrastes sous 4,5:1 en clair (gris discret #868686 → #6b6b6b) et phrases d'exemple bleues à 3:1 en sombre.
  5. Liste de la colonne : la date coincée à droite du titre, cassée sur deux lignes en 9,5 px → le titre seul, comme
     ChatGPT.
  6. Fenêtre étroite : la liste écrasait la conversation à 160 px → elle se pose par-dessus et se referme au choix.
  7. Grand écran : les réglages s'étalaient sur 1 300 px → colonne de 880 px, comme les Paramètres de Windows.
  **Piège dans mon propre test, attrapé en remettant le défaut exprès** : `page.addInitScript` ne s'applique PAS à
  `page.setContent` (aucune navigation) — les réglages qui devaient afficher les écrans du premier lancement n'étaient
  jamais lus, et le test passait sans rien vérifier. Les réglages sont maintenant écrits dans la page elle-même.
  **Une décision déjà prise avec Léo, rappelée par un test** : j'avais donné à « Ce que Jaris sait faire » le même
  titre de page que les réglages ; `test-options-reorganization-ui.mjs` le refuse (étape 111 : cette page garde sa
  propre intro). Annulé : un test qui échoue sur un choix documenté est un rappel, pas un obstacle à contourner.
  Régression : `node --test scripts/test-window-chrome-ui.mjs` (aucun écran du rail sous les boutons de Windows,
  barre de titre au premier lancement, liste par-dessus en fenêtre étroite, aucun texte sous 12 px) ; chaque
  assertion vérifiée en remettant son défaut. **Non vérifié ici** : le rendu sur la vraie machine de Léo (Mica,
  vrais boutons de Windows, police réelle).

- **Étape 266 (v0.32.0), style ChatGPT à la place du style Windows 11 (Léo : « ça fait trop application Windows
  avec la couleur violet, fais une vraie application stylée ChatGPT »).** Le violet venait de Jaris lui-même : le
  design v2 recopiait la couleur d'accent de Windows (`systemPreferences.getAccentColor`), violette chez Léo, dans
  le rail, la barre de saisie, les interrupteurs, les barres de progression. Mesuré sur sa capture : le reste de la
  teinte venait du fond Mica, qui laisse deviner le fond d'écran. Retirés tous les deux (main.ts, `WindowChrome`
  réduit à `titleBar`, canal `windowChrome` supprimé) : des gris neutres identiques sur toutes les machines, et
  « l'accent » devient la couleur du texte (boutons pleins blancs en sombre, noirs en clair, comme ChatGPT).
  Ce qui faisait aussi « Windows », remplacé par le vocabulaire de ChatGPT : libellés sous les icônes du rail
  (icônes seules, libellé gardé pour l'infobulle et les lecteurs d'écran), barre colorée à gauche de l'élément
  actif (fond gris à la place), zone principale posée comme un calque à coins arrondis (plus de cadre), coins à
  4-6 px (pilules pour les boutons, 28 px pour la barre de saisie, 10 px pour les lignes), police Segoe UI (Geist,
  déjà embarquée, passe devant), « Nouvelle conversation » en ligne sous le titre de la colonne, et la question
  d'accueil + la barre de saisie centrées ensemble sur une conversation vide (seulement si la fenêtre fait au moins
  700 px de haut : à 600 px, le bloc centré poussait la barre hors de l'écran — trouvé par le banc de captures).
  **Les cartes des Options sont gardées**, simplement plus arrondies : j'avais commencé à les remplacer par des
  lignes nues « comme ChatGPT », et `test-options-reorganization-ui.mjs` l'a refusé — l'air en haut et en bas des
  cartes est une demande explicite de Léo (étape 116). Une nouvelle demande de style n'efface pas les demandes
  précises déjà faites : les tests qui les gardent sont là pour le rappeler.
  Neuf tests vérifiaient les valeurs exactes du design v2 (coins de 6 px, bleu Windows) : mis à jour aux nouvelles
  valeurs. Régression ajoutée dans `scripts/test-window-chrome-ui.mjs` : aucune couleur vive dans la fenêtre, en
  clair comme en sombre (seuls le logo et le point vert « Local » sont permis) — vérifié en remettant un accent
  violet : le test échoue. **Non vérifié ici** : le rendu sur la vraie machine de Léo.
  **Travail en parallèle avec Codex sur la même branche** : pendant ce temps, Codex (OpenAI) a poussé sa propre
  réponse à la même demande — le rail et la colonne réunis en UNE barre latérale à libellés, façon ChatGPT — et
  mon envoi a été refusé (« non fast-forward »). Jamais de `--force` sur le travail d'un autre agent : fusion
  (`git merge`), sa disposition gardée (barre latérale `app-sidebar`), mes couleurs neutres par-dessus, et mes
  règles devenues sans objet (rail à icônes seules, ancienne colonne `.panel`) retirées. **Piège de la fusion** :
  les deux versions AJOUTAIENT un bloc en fin de `index.css`, et Git a entrelacé les deux blocs ligne à ligne en
  croyant aligner des lignes communes (`/* ====`, lignes vides) — résultat illisible. Reconstruit à la main :
  ma version + le bloc ajouté par Codex, recopié tel quel (vérifié : sa version = l'ancêtre commun + un ajout en
  fin de fichier, rien d'autre). Le banc de captures a ensuite trouvé un défaut dans le résultat : à 600 px de
  haut, la liste de conversations de la nouvelle barre était coupée à zéro, sans défilement — la barre latérale
  ouverte défile désormais en entier, avec Cerveau/Widget/Options collés en bas.

- **Étape 267 (v0.32.1), Agent vocal : l'orbe du logo, seul (Léo : « vocal il est nul, un bouton mal fait avec
  l'orbe, c'est moche », puis « utilise l'orbe classique, pourquoi changer avec un cercle, l'orbe du logo »).**
  Le design v2 posait le logo dans un bouton rond entouré d'anneaux. J'ai d'abord proposé une sphère lisse façon
  mode voix de ChatGPT : refusée aussitôt — même leçon que les étapes 69-70 et 76, déjà écrite ici : **la
  signature de Jaris est son orbe animé au bord irrégulier (`JarisOrb`), pas un cercle ni une sphère générique ;
  quand Léo demande « plus beau », on garde cette forme et on change ce qui l'entoure**. Retenu : `JarisOrb` en
  grand (taille selon la fenêtre, 140 à 340 px), sans aucun cadre ; ce qui se dit en dessous comme des
  sous-titres (plus de carte encadrée) ; « Parler à Jaris » et le choix du modèle en bas, le bouton restant en
  place mais estompé pendant l'écoute et la réponse (rien ne saute). Au repos, « Que puis-je faire pour toi ? »
  au lieu de « Parle à Jaris », que le bouton juste en dessous disait déjà. Les règles CSS de l'ancien bouton rond
  et des anneaux (plus aucun usage) sont supprimées. Le skill « frontend-design » demandé par Léo n'existe pas
  dans cet environnement (ni installé, ni proposé à l'ajout) : utilisé à la place « apple-design ».
  Régression : `scripts/test-window-chrome-ui.mjs`, l'Agent vocal affiche l'orbe (canvas `.jaris-orb`), sans cadre
  rond autour, et à au moins 200 px sur une fenêtre normale.

- **Étape 268 (v0.32.2), galeries Image/Vidéo et barre latérale (Léo : « c'est mal fait les vidéos créées et
  images » ; « quand je clique sur Code ça reste pareil, mais sur Vocal ça met directement l'icône et ça enlève le
  texte »).** Deux défauts, constatés sur captures du vrai rendu avant correction :
  1. **Galeries** : la grille des créations récentes était posée sous l'état vide, dont les marges automatiques
     (centrage vertical) la repoussaient tout en bas de l'écran, alignée à gauche, avec une dernière rangée
     incomplète (un ou deux éléments orphelins). Elle devient une section titrée (« Tes dernières images » /
     « Tes dernières vidéos »), centrée sur la même largeur que les suggestions, juste en dessous, sur UNE seule
     rangée (4 images ou 3 vidéos, moins en fenêtre étroite) : un aperçu des dernières créations, pas un
     explorateur de fichiers. **Leçon générale : un élément ajouté sous un bloc centré par `margin: auto` hérite
     de tout l'espace restant au-dessus de lui — le centrer avec lui, pas le laisser en dessous.**
  2. **Barre latérale** : elle n'était dépliée que si l'écran avait une liste (`hasPanel && panelOpen`), donc elle
     se repliait toute seule en icônes sur Vocal, Options et Cerveau. Elle reste maintenant comme Léo l'a laissée
     sur tous les écrans ; seule la liste (conversations, projets…) dépend de l'écran. Le bouton « Réduire » a
     quitté l'en-tête de la liste (absente en Vocal, donc inatteignable) pour la ligne du nom « Jaris ». En
     fenêtre étroite, la barre ouverte recouvre le contenu : choisir un écran la referme, comme un menu.
     **Leçon générale : un état choisi par l'utilisateur (barre ouverte/fermée) ne doit pas être recalculé par
     l'écran affiché — sinon naviguer donne l'impression que l'application change de mise en page toute seule.**
  Régression : `scripts/test-window-chrome-ui.mjs` (la barre reste ouverte, noms compris, sur Chat, Vocal, Code,
  Options et Cerveau ; se replie et se rouvre) et `scripts/test-image-panel-ui.mjs` (une seule rangée titrée,
  juste sous les suggestions, centrée). Les deux vérifiés en réintroduisant le défaut.

- **Étape 269 (v0.32.3), barre d'icônes et liste en deux colonnes, façon Codex (Léo, capture de Codex : « fais
  comme ça, ne mets pas les conversations dans la même barre »).** Les modes (Chat, Vocal, Code, Image, Vidéo) et
  les outils (Cerveau, Widget, Options) sont maintenant une colonne d'icônes fixe (`.app-rail`, 56 px, le nom en
  bulle et pour les lecteurs d'écran) ; la liste (« Nouvelle conversation », « Récents ») est une colonne à part
  à côté (`.app-sidebar`, 260 px, coin arrondi), repliable. Trois décisions :
  1. **La colonne de liste ne change jamais de forme d'un écran à l'autre** (suite directe de l'étape 268). Un
     écran sans liste à lui y montre celle qui a un sens : l'Agent vocal montre les conversations du Chat (la voix
     continue la conversation active, étape 96), le Cerveau garde celle de l'écran d'où l'on vient. Pour ça,
     « écran affiché » et « liste montrée » sont deux notions séparées : `KeepAlive` reçoit `ownsSidebar`
     (contexte `SidebarOwnerContext`), Workspace met sa liste dans la colonne quand il en est propriétaire, même
     caché, et son titre dans l'en-tête seulement quand il est affiché. Un écran propriétaire est monté même s'il
     n'a jamais été ouvert — sinon, Jaris s'ouvrant sur l'Agent vocal, la colonne serait restée vide.
  2. **Choisir un élément d'une liste montrée depuis un autre écran ouvre cet écran** (clic sur une conversation
     depuis Vocal → le Chat, sur cette conversation) ; sinon le clic surlignerait la ligne sans rien changer de
     visible.
  3. **Options met ses sections dans la colonne**, comme les Paramètres de Codex : avec la liste des
     conversations à côté de sa propre colonne de sections, les réglages étaient écrasés sur une fenêtre de
     1000 px. `OptionsMenu` reçoit `navSlot` et y envoie ses sections par portail quand la colonne est ouverte ;
     repliée (ou fenêtre étroite), elles reviennent dans la page.
  **Piège évité en remplaçant au lieu d'empiler** : les anciennes règles de la barre unique ciblaient
  `.app-sidebar:not(.app-sidebar--expanded)` ; la classe `--expanded` disparaissant, elles se seraient
  appliquées à la nouvelle colonne (alignement centré, noms cachés, boutons de 48 px). Elles sont supprimées,
  pas surchargées. **Leçon générale : quand une classe d'état disparaît, chercher les règles en `:not(.classe)` —
  elles s'appliquent alors partout, sans la moindre erreur.**
  Régression : `scripts/test-window-chrome-ui.mjs` (deux colonnes ; la barre d'icônes et la liste gardent
  exactement la même place sur Chat, Vocal, Code, Image, Options et Cerveau ; Vocal montre les conversations ;
  Options n'a plus de seconde colonne de sections ; repli et réouverture ; une conversation choisie depuis Vocal
  s'ouvre dans le Chat). Vérifiés en réintroduisant les défauts (colonne vide en Vocal, clic sans effet, colonne
  masquée sur Options).

- **Étape 270 (v0.32.4), pas de liste à gauche en Vocal, et Vocal en tête de la barre d'icônes (Léo : « pourquoi
  j'ai une conversation dans le mode vocal, faut pas ça à gauche » ; « mets l'icône vocal tout en haut, c'est le
  premier »).** Annule les décisions 1 et 2 de l'étape 269 : j'avais fait montrer les conversations du Chat à
  l'Agent vocal pour que la colonne de liste ne change jamais de forme (la plainte de l'étape 268). Mais cette
  plainte visait la barre qui perdait ses NOMS en se repliant, pas la liste : depuis que les modes sont une
  barre d'icônes qui ne bouge jamais, un écran sans liste à lui (Agent vocal, Cerveau) n'a simplement pas de
  colonne de liste, ni de bouton pour l'afficher. **Leçon générale : avant d'étendre un correctif à un cas
  voisin, revérifier ce que la plainte d'origine visait vraiment — ici les noms des modes qui disparaissaient,
  pas la liste elle-même ; deux plaintes proches ne demandent pas forcément la même règle.** Le mécanisme ajouté
  pour ça (`ownsSidebar` dans KeepAlive, `SidebarOwnerContext`, ouverture de l'écran au clic sur un élément
  d'une liste d'un autre écran) n'a plus d'usage : retiré, pas laissé en code mort. Options garde ses sections
  dans la colonne. Ordre de la barre : Vocal, Chat, Code, Image, Vidéo.
  Régression : `scripts/test-window-chrome-ui.mjs` (Vocal en premier ; aucune liste ni bouton de liste en Vocal
  et dans le Cerveau ; la liste garde sa place sur Chat, Code, Image et Options), vérifié en remettant la liste
  en Vocal puis Vocal en second.

- **Étape 271 (v0.32.5), lecteur vidéo : plein écran bloqué et vidéo minuscule dans un grand cadre (Léo : « c'est
  mal présenté les vidéos, et on ne peut pas cliquer sur agrandir »).** Deux défauts sans rapport :
  1. **Plein écran : refusé par Jaris lui-même.** `session.setPermissionRequestHandler` (main.ts) n'accordait que
     `media` (le micro) et refusait TOUT le reste — y compris `fullscreen`, par lequel Electron fait passer le
     bouton plein écran du lecteur vidéo. Le clic ne faisait rien, sans la moindre erreur. **Cause trouvée en
     reproduisant avec le vrai Electron (binaire téléchargé, écran virtuel Xvfb), pas en devinant** : une
     fenêtre aux mêmes options que Jaris passe en plein écran ; la même avec la règle de Jaris, non (la
     permission demandée s'affiche : `fullscreen`) ; avec `fullscreen` autorisé, oui. La barre de titre
     personnalisée (titleBarOverlay), premier suspect, était innocente. La règle vit maintenant dans
     `electron/services/permissions.ts` (`isPermissionAllowed`), testable sans Electron. **Leçon générale : un
     gestionnaire de permissions qui refuse « tout sauf X » refuse aussi des fonctions qu'on ne range pas
     d'instinct parmi les permissions (plein écran, presse-papiers…) — quand un bouton natif de Chromium ne fait
     rien dans Electron, regarder ce gestionnaire en premier.** Non vérifiable ici : le comportement exact sous
     Windows (l'essai a tourné sous Linux).
  2. **Présentation** : la vidéo restait à sa taille d'origine (832 px) au milieu d'un grand cadre vide, sous un
     titre déjà donné par l'en-tête. `max-width`/`max-height: 100%` ne font que RÉDUIRE, jamais agrandir. Les
     proportions réelles, lues au chargement (`mediaRatio`, src/lib/mediaRatio.ts), passent au CSS
     (`--media-ratio`) qui calcule la plus grande taille qui tient dans la zone (`container-type: size` +
     `min(100cqw, 100cqh × ratio)`). Plus de cadre ni de titre répété : les actions seules au-dessus, à droite.
     Même lecteur pour les images (mêmes classes).
  Régression : `scripts/test-permissions.mjs` ; `scripts/test-video-panel-ui.mjs` lit une VRAIE petite vidéo
  (320x180, fabriquée dans la page par MediaRecorder) et vérifie qu'elle est agrandie, à ses proportions, sans
  dépasser, sans cadre ; `scripts/test-image-panel-ui.mjs` idem pour l'image. Vérifiés en remettant l'ancienne
  règle et en retirant l'agrandissement. **Piège rencontré : ces tests lisent le CSS COMPILÉ (`out/renderer`) —
  après une modification d'index.css, `npm run build` avant de les lancer, sinon ils testent l'ancien style.**

- **Étape 272 (v0.32.6), « Arrêter » comme ChatGPT, et boutons collés à la vidéo (Léo : « pouvoir interrompre
  l'IA comme sur ChatGPT », capture du bouton carré ; « pourquoi les boutons Enregistrer et Ouvrir le dossier sont
  aussi écartés de la vidéo »).**
  1. **Arrêter** : pendant une réponse, le bouton d'envoi devient un bouton « Arrêter » (rond plein, carré au
     centre), au même endroit — dans le Chat ET en Code, Image et Vidéo (prop `onStop` du Composer ; ces trois
     écrans avaient déjà un « Arrêter » dans leur bandeau, le Chat n'avait RIEN). Côté Chat, le signal
     d'annulation existait déjà dans `converse()` (la voix s'en sert pour une nouvelle phrase) : chatSession.ts lui
     passait juste `undefined`. Il lui passe maintenant un AbortController par réponse, que `cancelChat` (IPC)
     interrompt. Comme ChatGPT, le texte déjà écrit est GARDÉ, suivi d'une petite mention « Réponse arrêtée. »,
     sans son ni message d'erreur ; il rejoint l'historique comme un échange normal (le modèle le voit au tour
     suivant) — rien d'écrit, rien n'est enregistré. **Piège évité : certains outils ne lèvent pas d'erreur quand
     on les arrête, ils RÉPONDENT (« Recherche annulée. », assistant.ts) ; l'arrêt est donc détecté par le signal
     lui-même (`signal.aborted`), jamais par le type d'erreur ni par le texte reçu.** Les réponses venues du
     téléphone ne sont pas concernées (leur propre écran). Non vérifié en usage réel : la vitesse à laquelle Ollama
     s'arrête vraiment sur la machine de Léo.
  2. **Boutons du lecteur** : à l'étape 271 ils étaient alignés sur le bord de la ZONE, pas de la vidéo — loin
     d'elle dès qu'elle est plus étroite que la zone (écran large, vidéo limitée par la hauteur). Ils sont
     maintenant dans une `figure` qui fait la largeur du média, collés à son coin haut-droit. La rangée a une
     hauteur fixe (32 px) pour que le calcul de taille du média (`100cqh - 40px`) soit exact.
     **Leçon générale, apprise en vérifiant que le test mordait : un test de mise en page ne voit un défaut que
     dans le cas où il se produit.** Dans la fenêtre de test d'origine, la vidéo remplissait toute la largeur :
     boutons au bord de la zone ou au bord de la vidéo, c'était pareil, et le test passait avec le défaut remis.
     Il mesure maintenant dans une fenêtre large et basse (la vidéo y est plus étroite que la zone), et échoue si
     ce cas n'est plus atteint.
  Régression : `scripts/test-chat-session-restore.mjs` (arrêt avec début gardé et enregistré ; arrêt avant tout
  texte, outil qui « répond » à l'arrêt ; bornés à 5 s), `scripts/test-chat-conversations-ui.mjs` (bouton
  « Arrêter » actif et habillé par le CSS, cancelChat appelé, début gardé, retour à « Envoyer »),
  `scripts/test-video-panel-ui.mjs` (vidéo centrée, boutons collés à son bord). Chacun vérifié en réintroduisant
  son défaut ; `AbortController` a dû être fourni au contexte `vm.runInNewContext` du test (piège déjà noté ici).

- **Étape 273 (v0.32.7), bouton Widget retiré et recherches web dépliables façon Claude (Léo : « enlève le bouton
  widget en bas à gauche » ; « quand il recherche sur le web, tu peux pas faire comme Claude, une petite flèche
  pour voir ce qu'il recherche ? »).**
  1. **Widget** : le bouton du bas de la barre d'icônes est retiré, ainsi que son canal IPC `minimizeToWidget`
     (il n'avait pas d'autre utilisateur, vérifié par grep) — réduire la fenêtre replie toujours Jaris en widget.
  2. **Recherches web** : au-dessus d'une réponse du Chat, une ligne repliée (« A cherché sur le web », « A fait 2
     recherches sur le web et lu 1 page ») avec une petite flèche ; dépliée, chaque recherche, son nombre de
     résultats et les pages trouvées (titre + site, cliquables, ouvertes dans le navigateur de Windows), et
     chaque page lue. Pendant la réponse, la même ligne dit en direct ce qui est cherché (« Recherche : « … » »).
     Repliée par défaut : la réponse reste la première chose lue. Les recherches sont signalées par l'outil
     lui-même (`createToolExecutor`, nouveau rappel `onWebActivity`), le SEUL endroit par où passent toutes les
     recherches — échecs compris, une recherche ratée doit se voir autant qu'une recherche réussie. Elles sont
     jointes à la réponse, enregistrées avec l'échange (`ConversationEntry.web`) et reviennent après un
     redémarrage. Seules les adresses http(s) deviennent des liens (`javascript:`, `file:` restent du texte).
     Le canal vocal n'a pas de bloc (rien à déplier à l'oral).
  **Piège CSS retrouvé (déjà noté aux étapes 95/117) : la règle des liens d'une réponse, `.chat-panel__body a`
  (classe + balise), battait `.web-activity__source` (classe seule) bien qu'écrite plus haut — les liens du bloc
  sortaient soulignés et colorés. Corrigé en reprenant la même forme (`.chat-panel__body a.web-activity__source`),
  et vérifié par le style calculé dans le test, pas à l'œil.**
  **Piège déjà noté (étape 96), appliqué d'avance cette fois : le Chat s'abonne à un nouveau canal au montage
  (`onChatWebActivity`) ; les trois faux ponts de tests qui fournissent `onChatStreamToken` ont reçu le nouveau
  canal AVANT de lancer la suite, sinon le composant ne se monte plus et les tests expirent sans message.**
  Régression : `scripts/test-web-activity.mjs` (libellés, pages gardées par la recherche, signalement par l'outil
  succès ET échec), `scripts/test-chat-session-restore.mjs` (joint, relayé, enregistré, réaffiché),
  `scripts/test-chat-conversations-ui.mjs` (replié par défaut, au-dessus de la réponse, dépliable, liens non
  soulignés qui s'ouvrent dans le navigateur, version en direct) et `scripts/test-window-chrome-ui.mjs` (plus
  de bouton Widget). Chacun vérifié en réintroduisant son défaut.

- **Étape 274 (v0.32.8), bloc des recherches web pendant la réponse (Léo : « il est mal fait », capture : le bloc
  posé à CÔTÉ de « Recherche sur internet… », écrasé sur trois lignes à droite).** Trois défauts :
  1. **Mise en page** : la règle `display: flex; flex-direction: row` qui aligne « … Jaris réfléchit » était
     posée sur TOUT le corps du message en cours ; le bloc ajouté à l'étape 273 y est devenu un élément de la
     rangée, à côté de l'indicateur. La rangée est maintenant un élément à part (`.chat-panel__thinking`), le
     bloc au-dessus. **Leçon générale (même famille que l'étape 101) : ajouter un élément dans un conteneur
     existant hérite de SA mise en page — vérifier comment le parent dispose ses enfants avant d'y glisser un
     nouvel élément, surtout un état transitoire qu'on ne voit qu'en usage réel (ici : pendant une recherche).**
     Mes captures de l'étape 273 ne montraient que la réponse terminée, jamais l'état « en cours ».
  2. **Doublon** : le bloc disait la recherche, l'indicateur aussi (« Recherche sur internet… »). Pendant une
     recherche, seul le bloc reste ; une fois terminée, l'indicateur revient en dessous (« Jaris réfléchit… »).
  3. **Trop tard** : la recherche n'était signalée qu'avec ses résultats. Elle l'est maintenant dès son début
     (`pending`, la question seule), puis terminée ; la version terminée REMPLACE celle en cours
     (`mergeWebActivity`) au lieu de s'ajouter à côté, et seule elle est gardée avec la réponse.
  Régression : `scripts/test-chat-conversations-ui.mjs` (bloc AU-DESSUS de l'indicateur, texte sur une ligne,
  pas d'indicateur pendant la recherche, une seule recherche après sa fin), `scripts/test-web-activity.mjs`
  (fusion en cours → terminée, signalement au début puis à la fin), `scripts/test-chat-session-restore.mjs`.
  Vérifié en remettant l'ancienne règle CSS et l'indicateur pendant la recherche : le test échoue bien.

- **Étape 275 (v0.32.9), le widget ne se déplace plus (Léo : « si on prend le bout du widget on peut le
  déplacer », puis, question à choix à l'appui : « il ne doit pas bouger »).** Toute la fenêtre du widget était
  en zone de déplacement (`-webkit-app-region: drag` sur `.app--widget`, depuis l'étape 19), avec des exceptions
  « no-drag » pour l'orbe, la pilule, la barre de saisie, la réponse… Attrapé par son bord transparent, il se
  laissait traîner ailleurs, puis revenait en haut au centre au premier changement d'état de Jaris
  (`positionWidgetWindow` recalcule toujours cette place). La zone de déplacement est retirée, et avec elle les
  cinq exceptions qui n'existaient que pour la contrer ; la fenêtre est en plus `movable: false`, pour que
  Windows lui-même refuse de la déplacer. Seule zone de déplacement restante : la barre de titre de la fenêtre
  principale. La phrase de Léo pouvait vouloir dire « c'est un bug » ou « je veux pouvoir le déplacer » —
  tranché par une question à choix plutôt que deviné.
  Régression : `scripts/test-chat-widget-ui.mjs` (aucun élément du widget en zone de déplacement ; la seule règle
  CSS qui en déclare une est `.titlebar` ; la fenêtre du widget a `movable: false`). Vérifié en remettant la zone
  de déplacement, puis en retirant `movable: false`. Non vérifiable ici : le comportement exact sous Windows.

- **Étape 276 (v0.32.10), le micro du champ de saisie devient une dictée (Léo : « quand on clique sur le micro
  dans le Chat, ça ne doit pas aller en vocal, ça doit enregistrer et transcrire en texte »).** Le micro du champ
  (Composer.tsx, donc Chat, Code, Image et Vidéo) basculait sur l'Agent vocal et lançait l'écoute. Maintenant : un
  clic enregistre (bouton plein qui respire, compteur 0:07), un second arrête ; le son est ramené en WAV 16 kHz
  mono et transcrit par le modèle DÉJÀ chargé pour le micro (`transcribeDictation`, même chemin que les messages
  vocaux du téléphone — `transcribeWav` partagé dans main.ts) ; le texte s'AJOUTE au champ, séparé par une
  espace, sans rien envoyer : Léo relit puis envoie. Arrêt automatique avant la limite de 5 Mo (2 min 30). Le
  contexte `VoiceLaunchContext` et `launchVoice` (App.tsx), qui ne servaient qu'à ce bouton, sont retirés. Le micro
  utilisé est celui par défaut de Windows (pas encore celui choisi dans Options → Voix).
  **Choix de sécurité** : ce qui arrive du renderer passe le même contrôle que le téléphone avant d'être écrit
  dans un fichier temporaire (`isExpectedWav` : WAV PCM 16 bits mono 16 kHz, 5 Mo au plus) ; un test vérifie que
  le WAV produit par le champ est accepté TEL QUEL par ce contrôle — deux fichiers, une seule forme attendue.
  Régression : `scripts/test-dictation.mjs` (rééchantillonnage, WAV accepté par isExpectedWav, ajout au texte) et
  `scripts/test-dictation-ui.mjs` (vrai navigateur avec le FAUX micro de Chromium,
  `--use-fake-device-for-media-stream` : enregistrement réel, WAV 16 kHz mono transmis, texte ajouté au champ,
  jamais envoyé, plus aucune bascule vers l'Agent vocal ; erreur affichée sans le préfixe « Error invoking remote
  method »). **Piège : `getUserMedia` n'existe pas sur `about:blank` (page de `setContent`) — la page de test
  est servie depuis http://localhost par `page.route`.** Vérifiés en remettant un envoi automatique et le message
  d'erreur brut. Non vérifiable ici : la qualité de la transcription sur le vrai micro de Léo.

- **GitHub dans le mode Code (étape 277, Léo : « pouvoir connecter Jaris à GitHub pour Code », « travailler sur
  mes dépôts », connexion « la plus facile pour les utilisateurs »).** Bouton GitHub dans le champ du mode Code
  (`GithubPicker.tsx`, même famille que le sélecteur de modèle) → choix d'un dépôt → la demande part à un AGENT
  (`repoAgent.ts`) qui lit les fichiers et prépare des changements, affichés ligne par ligne (`RepoChanges.tsx`,
  `shared/lineDiff.ts`) avant le seul bouton qui écrit : « Enregistrer sur GitHub ». Choix structurants :
  connexion par code (device flow documenté par GitHub : code déjà copié, page déjà ouverte, AUCUN secret
  embarqué) ; jeton chiffré par Windows (`safeStorage`) et jamais envoyé au renderer ; API REST uniquement (pas de
  `git` à installer) ; un enregistrement = UN commit via la Git Data API, branche déplacée avec `force: false`
  (si elle a bougé, GitHub refuse et rien n'est écrasé) ; changements gardés en mémoire côté main (fermer Jaris
  les abandonne, comme un éditeur non sauvegardé) ; changer de branche refusé tant qu'il reste des changements.
  **Tout est masqué tant que `config.github.clientId` est vide** : il faut l'identifiant PUBLIC d'une OAuth App
  créée par Léo avec « Enable Device Flow » cochée — jamais celui d'une autre application (ce serait se faire
  passer pour elle).
  **Quatre défauts trouvés en faisant tourner l'agent avec un VRAI modèle ici (Ollama 0.40.2 sur CPU,
  qwen2.5-coder:7b, le plus petit modèle du mode Code), aucun visible avec un faux modèle :** (1) le modèle écrit
  ses appels d'outils EN TEXTE (`{"name": "read_file", ...}`) au lieu de vrais appels : l'agent s'arrêtait sans
  rien faire → `extractTextToolCalls` (JSON seul, une ligne par appel, bloc ```json, balises `<tool_call>`),
  limité aux noms des outils de l'agent ; (2) passage recopié avec un saut de ligne en trop → introuvable, et le
  modèle réessayait la même chose en boucle → nouvel essai sans les blancs de début/fin, et arrêt net après 3
  échecs IDENTIQUES ; (3) **fausse confirmation** : lecture + modification + « finish » envoyés d'un coup, la
  modification échoue (passage deviné avant d'avoir lu)… et le résumé annonçait « J'ai ajouté 'oeufs' » → un
  « finish » envoyé dans le même message qu'un appel raté est refusé ; (4) réponse commençant par le mot « finish »
  seul → retiré. Et l'écran compte les fichiers RÉELLEMENT changés (« aucun fichier n'a été changé ») au lieu de
  croire le résumé du modèle. **Leçon générale : une boucle d'agent testée seulement avec un faux modèle qui
  appelle proprement ses outils ne prouve rien sur un petit modèle local — le faire tourner une fois avec un vrai
  modèle a trouvé quatre défauts en dix minutes.** Même famille que les fausses confirmations des étapes 87-90.
  Pièges de test : `scripts/load-ts-module.mjs` (nouveau) charge un module dans le realm courant et lève une
  erreur QUI NOMME l'import manquant au lieu d'un `undefined` silencieux ; le bouton GitHub interroge
  `githubStatus` au montage → les 3 faux ponts qui montent CodePanel ont dû l'ajouter (piège de l'étape 96) ; le
  garde « aucun texte affiché ne renvoie vers un README » refuse aussi une suggestion qui parle du README de
  l'UTILISATEUR → reformulée. Régression : `node --test scripts/test-github-api.mjs scripts/test-github-session.mjs
  scripts/test-repo-agent.mjs scripts/test-line-diff.mjs scripts/test-github-ui.mjs` (chaque garde vérifiée en la
  retirant). **Non vérifié ici** : une vraie connexion GitHub (il manque l'identifiant de l'application), le
  chiffrement réel de Windows, et la qualité des plus gros modèles Code sur la machine de Léo.
  **Premier passage en CI raté par MON test, pas par le code** : le test du jeton cherchait le fichier sous
  « /donnees/github-token.bin » écrit en dur, alors que le module construit ce chemin avec `path.join` — qui donne
  « \donnees\github-token.bin » sous Windows (la CI). Reproduit ici en remplaçant `join` par `path.win32.join`
  dans une copie du test, puis corrigé en calculant le chemin attendu avec le même `join`. **Un chemin attendu
  par un test se calcule comme le code le calcule, jamais en dur : la CI tourne sous Windows.**

- **Identifiant de l'application GitHub ajouté (étape 278)** : `config.github.clientId` vaut maintenant celui de
  l'OAuth App créée par Léo (« Enable Device Flow » cochée), ce qui fait apparaître le bouton GitHub du mode Code.
  Cet identifiant est PUBLIC par conception : il ne donne accès à aucun compte. L'accès n'existe que si une
  personne tape le code sur SON compte GitHub et clique « Authorize ». Le « client secret », lui, ne doit jamais
  être créé ni partagé : le device flow n'en a pas besoin. Une seule application sert tous les utilisateurs de
  Jaris, chacun se connecte avec son propre compte. **Non vérifiable ici** : le proxy de cet environnement bloque
  github.com/login/* (« sessions are bound to their configured repositories ») et exige des corps JSON. La
  première vraie connexion de Léo est donc le premier test réel de l'identifiant.

- **Dépôt GitHub vide (étape 279, Léo : « pourquoi on peut pas même sans rien dans le dépôt »)** : la v0.33.0
  refusait un dépôt tout neuf (« Ce dépôt est vide : ajoute au moins un premier fichier… »). Le refus venait de
  MON code, pas de GitHub : un dépôt sans commit n'a aucune branche, et j'avais traité ce cas comme une erreur au
  lieu de le gérer. Corrigé en deux temps. (1) À l'ouverture, si la branche principale est introuvable, Jaris
  demande la liste des commits. GitHub répond 409 « Git Repository is empty » pour un dépôt vide, qui s'ouvre
  alors vide (`commitSha: null`). Sinon, c'est une vraie branche manquante, avec son propre message. (2) Au
  premier enregistrement, l'API d'arbres et de commits ne peut rien écrire tant qu'il n'existe aucun commit. Le
  premier fichier passe donc par l'API « créer un fichier » (`PUT contents/…`, ce que fait github.com sur un
  dépôt vide), et les suivants dans un second commit posé dessus, sans forcer. L'agent est prévenu que le dépôt
  est vide (sinon un petit modèle cherche des fichiers qui n'existent pas). L'accueil propose de créer, pas
  d'expliquer. Vérifié avec le vrai modèle qwen2.5-coder:7b : `index.html` créé en 2 tours. **Non vérifié ici** :
  la réponse réelle de GitHub sur un vrai dépôt vide. La doc ne la décrit pas, et ce comportement connu n'a pas
  pu être testé (le proxy limite cette session au dépôt jaris). **Leçon générale : un cas limite (dépôt vide,
  liste vide, premier usage) traité comme une erreur « pour être sûr » devient un blocage dès le premier essai
  réel — c'est souvent exactement le cas que l'utilisateur teste en premier.**

- **Dépôt et branche dans le champ, comme ChatGPT (étape 280, Léo, capture à l'appui : « enlève dépôt vide et la
  branche mets pas en haut mais en bas comme le dépôt »)** : l'en-tête du dépôt (nom, « Privé », sélecteur de
  branche, « Dépôt vide » / « N fichiers ») est retiré. La branche devient un bouton du champ de saisie
  (`BranchPicker.tsx`), juste après le dépôt, dans la même famille que les autres boutons. Le panneau du dépôt
  n'apparaît plus qu'avec quelque chose à montrer (réponse, changements, enregistrement) : un dépôt tout juste
  ouvert affiche donc l'accueil centré avec le champ, comme une nouvelle discussion. Deux boutons voisins ne
  portent plus le même dessin : le dépôt a une icône de classeur, la branche garde l'icône de branche. Quand des
  changements attendent, le panneau des branches EXPLIQUE pourquoi on ne peut pas en changer, au lieu d'un bouton
  grisé muet. CSS mort de l'ancien en-tête retiré (vérifié par grep). Régression : `scripts/test-github-ui.mjs`
  (boutons sur la même ligne DANS le champ, aucun panneau ni « Dépôt vide » en haut, changement de branche
  réellement transmis et affiché, explication quand des changements attendent).

- **« rien reçu du modèle depuis 3 min » pendant le travail sur un dépôt (étape 281, Léo, qwen3.8:27b) : l'agent
  n'était pas bloqué, il était MUET.** Mesuré ici avec un vrai modèle (Ollama 0.40.2, qwen3.5:0.8b) : avec des
  outils déclarés à Ollama, la réflexion arrive au fil de l'eau (18 s), puis plus rien jusqu'à 289 s, où
  `write_file` tombe d'un bloc avec tout le jeu dedans. Ollama ne transmet un appel d'outil qu'une fois ENTIÈREMENT
  écrit. Or un fichier entier écrit dans un appel, c'est justement l'essentiel du travail. Danger en plus : le fetch
  de Node (undici) coupe une réponse muette au bout de 5 minutes (`bodyTimeout`/`headersTimeout` = 300 s, vu ici :
  connexion fermée à 5 min 01). Sur une machine lente, l'écriture d'un gros fichier se serait terminée en erreur.
  **Corrigé : plus aucun outil déclaré à Ollama dans l'agent de dépôt.** Les appels sont demandés EN TEXTE, dans un
  bloc ```` ```action ```` contenant le JSON. Ce texte arrive au fil de l'eau, l'écran compte les caractères écrits,
  et la connexion n'est jamais muette (plus long silence mesuré : 27 s avec qwen2.5-coder:7b, le temps de lire les
  consignes, contre 270 s avant). Les résultats repartent en messages « user » (« Résultat de read_file : … »), car
  sans outils déclarés certains modèles ignorent le rôle « tool ».
  **Piège n°2, trouvé seulement en essayant pour de vrai : PAS de balises `<tool_call>`.** Ollama les intercepte
  chez les modèles Qwen MÊME sans outils déclarés. Son analyseur attend le format XML propre à Qwen, ne transmet
  rien, puis coupe la réponse : erreur « EOF » dans le flux, « qwen3.5 tool call parsing failed » dans ses
  journaux. **Leçon générale : un balisage que le moteur d'inférence connaît lui-même ne doit jamais servir de
  protocole maison — il le capture.**
  Lecture rendue tolérante, d'après les vrais défauts vus : JSON avec de vrais retours à la ligne dans une chaîne
  (`parseLenientJson`), ouverture « ``` » oubliée (vue avec qwen3.5). Un appel illisible (guillemet non échappé)
  n'est plus jamais affiché comme résumé : on demande au modèle de le réécrire, et on s'arrête après 3 essais.
  Vérifié avec les vrais modèles : Snake dans un dépôt vide avec qwen2.5-coder:7b (1 tour, 264 s, plus long silence
  27 s) et modification de app.js (3 tours, 29 s). **Non vérifié** : qwen3.8:27b sur la machine de Léo (trop gros
  pour la mémoire de cet environnement). **Leçon générale : un indicateur « rien reçu depuis X » ne distingue pas
  « bloqué » de « muet par construction » — avant de chercher pourquoi un modèle « ne répond pas », mesurer CE QUI
  ARRIVE et QUAND sur le flux réel.**
