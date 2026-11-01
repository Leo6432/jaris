# Jaris — instructions pour toute IA travaillant sur ce dépôt

Assistant IA vocal 100 % local (Electron + React + TypeScript, LLM via Ollama). Développé pour Léo, seul
utilisateur/testeur. Léo n'est pas très technique : préférer des questions à choix simples, jamais lui
demander d'interpréter des logs.

Ce fichier est volontairement COURT (il est chargé à chaque conversation). L'historique complet de toutes les
étapes (1 à 404), avec le détail de chaque bug et de chaque décision, est dans `docs/historique.md`.
**Avant de toucher à une fonctionnalité, chercher son nom dans `docs/historique.md`** (grep) : la plupart des
pièges y sont déjà documentés. Ajouter chaque nouvelle étape À LA FIN de `docs/historique.md`, jamais ici —
ici, seulement une nouvelle règle générale si elle est vraiment importante.
`CLAUDE.md` et `AGENTS.md` doivent rester identiques (seule l'attribution des commits diffère).

## À vérifier après CHAQUE changement, avant de le considérer terminé

1. `npm run typecheck` — sans erreur (node ET web).
2. `npm run build` — sans erreur. Les tests navigateur lisent le CSS COMPILÉ (`out/`) : rebuild avant eux.
3. `npm test` — et lire le nombre de tests IGNORÉS : la CI Windows ignore les tests Playwright, donc les
   lancer ici avant de pousser.
4. Fichier supprimé/renommé : grep de tout le dépôt (imports, canaux IPC, préférences, textes affichés).
5. Bump de version dans `package.json` (patch pour un correctif, minor pour un gros changement), puis
   `npm install --package-lock-only`.
6. Juste avant le bump : `git fetch` et relire la version distante (plusieurs IA publient sur la même branche).
7. Commit en français expliquant le POURQUOI, avec l'attribution de l'outil utilisé.
8. Push (vérifier que `origin` pointe bien vers `https://github.com/Leo6432/jaris.git`).
   **Tout push sur la branche de travail PUBLIE une Release** : ne rien pousser avant la fin des tests, et
   changer de numéro de version avant chaque nouvel envoi à publier (un tag existant fait sauter la Release).
9. Vérifier la CI (`Installeur Windows`) ET que la Release `Jaris-Setup-X.Y.Z.exe` correspond bien au commit
   poussé. Échec réseau `ECONNRESET` = relancer le job, pas un nouveau commit.
10. Confirmer à Léo en une ligne courte une fois la Release publiée, jamais avant.

Toujours distinguer « vérifié par le build/les tests » et « vérifié en usage réel » (pas de Windows ici).

## Commandes utiles

```
npm run typecheck   # tsc, node + web
npm test            # tests de régression (scripts/test-*.mjs), aussi lancés par la CI
npm run build       # electron-vite build
npm run dist        # installeur .exe (normalement laissé à la CI)
python scripts/test-wake-confirmation.py   # mot d'activation
```

## Règles générales (les plus importantes, tirées de l'historique)

**Diagnostic**
- Ne jamais enchaîner des correctifs spéculatifs sur un symptôme flou : mesurer, reproduire, ou poser une
  question ciblée à Léo. Quand un même symptôme revient malgré un correctif, remettre en cause le composant
  qu'on croit en cause (saga SearXNG, widget pris pour la fenêtre principale).
- Vérifier sur la SOURCE PRIMAIRE (code source, doc officielle, registre), jamais sur un résumé de recherche
  web ni sur la parole d'une autre IA. Une citation « exacte » rapportée par un tiers peut être fausse.
- Quand un outil tiers peut tourner ici (Ollama, PowerShell, Electron sous Xvfb), le lancer pour de vrai plutôt
  que le simuler : la plupart des vrais défauts n'existaient pas dans les mocks.
- Quand la cause reste invisible, construire l'outil qui la rend observable (journal, test, diagnostic affiché)
  plutôt qu'un correctif deviné.
- Un mot de l'utilisateur qui ressemble au nom d'une fonctionnalité ne désigne pas forcément celle-là.

**Code**
- Les erreurs d'outils/Ollama remontent avec leur VRAI message, rédigé pour un humain, jamais un message
  générique. Un échec d'outil court-circuite le modèle (il ne le reformule pas).
- Quand une consigne « ne fais pas X » échoue face à un petit modèle, rendre X impossible dans le code.
- Détecter un PATRON (grammatical, structurel) plutôt qu'un mot-clé précis ; vérifier les négations ;
  chercher le VERBE d'action dans la CONSIGNE seulement, jamais dans un contenu collé à traiter.
- Une même action atteignable par plusieurs chemins doit être gardée sur TOUS les chemins (touche +, check
  WSL, réparation Ollama, garde de navigation). Poser une règle à UN endroit par où tout passe.
- Déplacer un bloc de rendu, c'est aussi déplacer la logique qui le nourrit.
- Un état décidé à deux endroits finit par se contredire : une seule source de vérité.
- Un état qui décrit UN élément doit être effacé par TOUS les chemins qui changent l'élément affiché.
- Ne jamais supprimer un état difficile à recréer (jeton, travail en cours) sur un seul signal d'échec.
- Écritures de données : fichier temporaire + fsync + renommage (`atomicFile.ts`). Tout nouveau fichier dans
  `getDataRoot()` doit être ajouté à `OWNED_ENTRIES` (sinon « Déplacer » le perd). Jamais de chemin absolu
  comme clé.
- Toute attente de durée variable se surveille par INACTIVITÉ, jamais par durée totale. Toute action longue
  dit où elle en est (signe de vie, compteur).
- `Boolean("false")` vaut vrai : utiliser `toolFlag`. `"x".includes("")` vaut vrai : écarter les requêtes vides.
- ctypes Windows : toujours déclarer `restype`/`argtypes`. Caster en float avant tout traitement DSP.
  Les sidecars Python imposent UTF-8 sur stdin/stdout/stderr.
- Tout ce qui change d'une requête à l'autre (date, heure) va à la FIN de ce qu'on envoie au modèle, jamais au
  début (cache d'Ollama).
- Toutes les demandes au même modèle doivent avoir la même fenêtre de contexte (sinon rechargement silencieux).
- Ollama : donner le VRAI chemin des modèles (pas une jonction). « Téléchargé » ne veut pas dire « relisible » :
  vérifier avant de mesurer.
- Un réglage passé à une bibliothèque peut être accepté sans erreur puis ignoré (`readonly` de node:sqlite,
  délai caché de 10 min de LiteLLM) : vérifier qu'il AGIT, pas seulement qu'il est envoyé.
- Pour savoir où un logiciel écrit (cache, modèles), lire SON code, jamais supposer (voix Supertonic, pip).
- Retirer une fonctionnalité, c'est aussi effacer ce qu'elle a installé chez l'utilisateur (fichiers,
  conteneurs et images Docker) — en gardant ses données à lui (`legacyCleanup.ts`).
- Sécurité : jamais de shell avec une donnée utilisateur (`execFile`/`spawn` avec tableau d'arguments, valeurs
  par variable d'environnement) ; les chemins venus de l'écran sont revérifiés côté main.

**Interface**
- Toujours vérifier un changement visuel par une MESURE dans un vrai navigateur (style calculé,
  `getBoundingClientRect`, vrai clic) ET une capture du rendu compilé — à plusieurs largeurs (760 px au moins).
- CSS : à spécificité égale, la dernière règle gagne ; la règle générale des `input` utilise `!important`
  (exclure explicitement tout nouveau champ) ; `flex-direction: column` ne s'hérite pas ; conteneur flex
  horizontal = `min-width: 0` ; enfant en `overflow: hidden` dans une colonne qui défile = `flex: 0 0 auto`.
- Un test qui prouve qu'un mécanisme MARCHE ne prouve pas qu'il est TROUVABLE : tester aussi son affordance.
- Ajouter un affichage, c'est aussi retirer celui qu'il remplace, et gérer qui le fait disparaître.
- Garder l'identité de Jaris : l'orbe au bord irrégulier (`JarisOrb`), sa palette. Une capture d'une autre
  appli donne la forme, jamais les couleurs. Refonte visuelle : montrer des captures à Léo AVANT de livrer.
- Fenêtres : un handler `'blur'` doit ignorer fermeture, dialogue natif, Options ouvertes. Ouvrir la nouvelle
  fenêtre AVANT de fermer l'ancienne. Dialogue natif = via le main (garde `dialogOpen`).
- Tout texte affiché passe par le catalogue `shared/i18n` (24 langues, `t()`/`tn()`), pluriels via
  `Intl.PluralRules`, espaces de bord comprises. L'image et la vidéo partent toujours en anglais.

**Tests**
- Après un nouvel `import` ou un nouveau canal IPC consommé au montage : mettre à jour TOUS les faux ponts des
  tests existants avant de lancer la suite (sinon expirations muettes).
- Vérifier qu'un test MORD : réintroduire le défaut, le test doit échouer pour la bonne raison.
- La CI tourne sous Windows en CRLF : motifs avec `\r?$` (drapeau `m`), chemins via `path.join`, jamais un `/`
  en dur ; `fileURLToPath`, jamais `.pathname`. Tester sur une copie CRLF (`git -c core.autocrlf=true
  worktree add`).
- Ne jamais passer un ElementHandle Playwright à `assert.equal` (bloque sans message) : comparer une valeur
  primitive. `vm.runInNewContext` casse `deepEqual` et `instanceof`.
- Horloge simulée : faire avancer l'horloge pendant toute attente d'écriture réelle.
- Un faux service doit reproduire les transitions d'état du vrai, pas seulement ses réponses.
- Ne jamais garder un Ollama de mesure sur le port 11434 pendant `npm test`.

**Modèles**
- Jaris ne choisit jamais un modèle sans score : les scores vérifiés sont dans `scripts/verified-tool-scores.md`
  (seule source). Relire TOUTES les réponses d'un test (justes comprises) avant de recopier un score.
- Taille d'un modèle : lue dans le registre, jamais de mémoire. Vérifier licence, architecture supportée par
  Ollama, et digest du tag avant d'ajouter un modèle. Après tout changement, comparer les choix sur une grille
  de machines types.
- Les vitesses d'Artificial Analysis changent souvent : tests de règles avec des vitesses fictives.
- Les listes recopiées entre `hardwareScan.ts` et `scripts/benchmark-models.mjs` sont vérifiées par test.

**Travail avec Léo**
- Ne jamais dire « terminé » avant la Release publiée. Ne jamais lui demander de relancer un long test sans
  avoir calculé ce que ça changerait.
- Pour une demande simple, répondre directement, sans lancer plusieurs agents (coût). Garder agents et relecture
  adverse pour ce qui touche aux données ou à l'architecture.
- Une demande explicite récente de Léo l'emporte sur un choix noté dans l'historique : l'écrire dans l'historique.
