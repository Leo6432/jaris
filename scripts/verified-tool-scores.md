# Scores vérifiés (sans téléchargement pour personne)

**Seule source des scores de fiabilité de Jaris** (étape 166) : l'analyse des modèles a été retirée de
l'application une fois l'analyse complète de Léo du 25/09/2026 recopiée ici — plus aucun fichier
`benchmark-results.md` local n'est lu. `scripts/benchmark-models.mjs` reste un outil de développement pour
remesurer un modèle (`npm run benchmark:models`), dont on recopie ensuite le résultat ici à la main.

Pourquoi c'est possible : la fiabilité d'un modèle (répond-il avec le bon outil et les bons arguments,
comprend-il vraiment une image, génère-t-il du code valide) est une propriété du modèle lui-même, pas du
matériel qui le fait tourner — un score mesuré une fois reste valable sur n'importe quelle machine, à quelques
points près (étape 322 : un modèle ne répond pas exactement pareil d'un essai à l'autre, et un autre matériel ajoute
un peu de cette variation ; voir « À remesurer » en fin de fichier). La
**vitesse**, elle, dépend du matériel de chacun : jamais stockée ici. Jaris affiche à la place la vitesse
publiée par Artificial Analysis (`ARTIFICIAL_ANALYSIS_SPEED` dans `electron/services/hardwareScan.ts`),
identique pour tout le monde et présentée comme un repère comparatif, jamais comme une prédiction locale.

**Trois sections séparées, jamais une seule liste par nom de modèle** : certains modèles (ex: `qwen3.5:4b`,
`gemma4:e4b`) sont candidats à la fois en Conversation et en Vision — leur score n'y est pas le même (l'un
teste l'appel d'outils, l'autre la compréhension d'image), donc chacun a sa propre ligne dans sa propre
section. Un modèle absent d'une section n'a pas de score dans ce rôle.

Format : un modèle par ligne dans sa section, score sur le nombre de questions posées pour ce palier par
`benchmark-models.mjs` (78 en conversation, 18 en vision, 3 en code). Un score sur un autre total (ancien
test) est ignoré par Jaris : le modèle est alors proposé au bouton « Tester ces modèles ».

## Conversation (rapide / médium / puissant) — appel d'outils

Test complet de Léo du 03/10/2026 (test version 6) : 26 questions posées 3 fois, soit 78 réponses par modèle.
Fenêtre de contexte de 8192, comme dans Jaris. Toutes les réponses ont été relues une par une dans le fichier
de résultats, et les scores ci-dessous sont CORRIGÉS à la main sur ces relectures :

- ministral-3:14b 59 → 56 : à « Je vais éteindre mon PC ce soir », il écrit `shutdown_pc[ARGS]{}` en texte
  (format d'outil Mistral non reconnu par Ollama) — Jaris le lirait à voix haute. Compté juste par erreur.
- qwen3.5:0.8b 41 → 40 : « Je vais mettre mon ordinateur hors ligne maintenant. » compté juste par erreur.
- Question « ma voiture n'est plus une Peugeot, c'est une Clio » : relire d'abord la note « Voiture »
  (recall_memory) avant de la corriger est ce que demande le prompt de Jaris ; le test, à un seul tour, ne
  voyait que cette première étape et la comptait fausse. Comptée juste désormais.
- Question « je vais éteindre mon PC ce soir » : noter ce plan en mémoire (remember) est sans danger ; seul
  éteindre, ou dire qu'il éteint, est faux.

Les modèles de l'ancien test (17 questions) qui n'ont pas été retestés et ne sont plus proposés par Jaris
(phi4-mini, functiongemma:270m, granite4:1b, nemotron-3-nano:4b, qwen3.5:2b-q4_K_M) n'ont plus de score. phi4-mini
redevient candidat à l'étape 316 (demande de Léo) : il repasse tous les tests actuels.
gemma4:31b n'était candidat qu'en vision ; depuis l'étape 376, tous les modèles passent aussi l'appel d'outils.

Étape 312 : K2 Horizon 3.7B mesuré par Claude avec ce même script, sans carte graphique, sous Ollama 0.40.4-rc1
(le score ne dépend pas du matériel, seule la durée change). Ses 2 erreurs aux questions sont relues et réelles
(rappel à 75 min au lieu de 90, « clic droit » pris pour la flèche droite) ; code 5/5 (le formulaire, coupé une
fois par le délai, rejoué) ; demandes complètes 33/48, dont une demande coupée par un redémarrage de la machine
et comptée ratée (au mieux 34/48). Ses réponses justes n'ont pas été relues une à une.

Étape 323 : K2 Horizon 3.7B remesuré sur le PC de Léo le 17/10/2026 (Jaris 0.34.29, Ollama 0.40.5, RTX 3070), avec
les mêmes tests ; ce sont ces scores qui comptent désormais. Questions 76/78, comme chez Claude ; les 2 erreurs sont
relues et réelles (« dans une heure et demie » devenu 1,5 minute, PC éteint sur « je vais éteindre mon PC ce soir »).
Demandes 31/48, toutes relues, justes comprises : le juge corrigé donne 32 (voir la section des demandes), et la
blague, sans aucun sens (« il fait un grand chokri… c'est un poète du Moyen Âge »), est comptée fausse, comme le
texte incohérent de la 0.9B. Code 2/5 (5/5 chez Claude), chaque échec ouvert et cliqué : le convertisseur réaffiche
le nombre tapé (« 100.0 °F » pour 100 °C), la liste ne garde qu'une tâche sur deux, et la confirmation du formulaire
reste cachée même après un envoi valide. Un premier essai interrompu, sur le même PC, avait réussi le convertisseur :
la dernière ligne compte, comme pour tous les modèles.

Étape 314 : K2 Horizon 0.9B, 7B et 32B mesurés par Léo le 14/10/2026 (Jaris 0.34.20, Ollama 0.40.4, RTX 3070).
Toutes les réponses relues une à une, justes comprises, et corrigées à la main :
- 0.9B 49 → 46 : une réponse en anglais, « Appellez shutdown_pc » (nom d'outil lu à voix haute, et il annonce
  qu'il éteint), « Je vais le faire maintenant » à « je vais éteindre mon PC ce soir ». Demandes 0/48 : 29
  réponses vides, le reste en anglais ou incohérent (même une fois la réflexion fuitée retirée).
- 7B demandes 40 → 35 : taille de RAM inventée (« 4,3 Go sur 9 Go » au lieu d'un %), délai faux jusqu'à
  l'anniversaire de maman (et un 14 mars 2027 donné pour un lundi), rappel dans 90 min annoncé « demain matin »,
  heure dictée illisible (« dix vingt trente »), et un prénom et une sœur inventés. « </ifm|think> Ton code wifi
  est TROMPETTE-42. » reste juste : Jaris retire désormais cette balise (et la réflexion qui la précède) avant
  d'afficher ou de lire une réponse. La demande coupée par le délai, refaite le 17/10/2026, est juste (reprise par
  le pilotage d'écran, permise pour cette demande) : 36/48. Ses 2 erreurs
  aux questions (YouTube cherché sur internet au lieu d'être ouvert) sont réelles.
- 32B : 78/78 et 42/48, aucune correction (« ouvert du lundi au vendredi » vient bien du résultat de recherche).
Code des trois pas encore mesuré : Léo a arrêté pendant le code de la 32B, qui écrit à 2,5 mots par seconde sur
8 Go de mémoire vidéo (8 à 15 min par application). Le prochain clic sur « Tester ces modèles » le reprend.

Étape 317 : phi4-mini (Phi-4-mini-instruct) mesuré par Léo le 17/10/2026 (Jaris 0.34.23, Ollama 0.40.5), toutes
les réponses relues une à une. Il n'a fait AUCUN vrai appel d'outil sur les 78 questions : il écrit ses appels en
texte, sous des formes changeantes (`look_at_screen{...}`, `media_control({...})`, JSON), que Jaris lirait à voix
haute. Questions 9 → 7 : « en tant qu'IA, je n'ai pas la capacité de fournir le moment actuel » à « Quelle heure
est-il ? » (l'heure est dans les consignes), et « Comment tu t'appelles ? » sans son nom (« Cherchi des
informations… »). Demandes 4 → 2 : « Regardez l'écran, s'il vous plaît. » à un merci, et la phrase de Tom recopiée
comme si c'était lui. Code 5/5, chaque appli utilisée pour de vrai : il écrit du code, pas des appels d'outils.

Étape 334 : Ornith 1.5 (9B et 35B) et Muse Glimmer mesurés par Léo le 19/10/2026 (Jaris 0.34.43, Ollama 0.40.5),
toutes les réponses relues une à une, justes comprises. Questions : Ornith 9B et 35B 78/78, Muse Glimmer 76/78 (2 fois
« je m'en occupe, je vais sur YouTube » sans rien lancer : vraies erreurs). Demandes : la seule correction est la blague,
sans aucun sens chez les deux Ornith (« Regardez le cadavre qu'elle a fait ! », « pas de café pour le bébé »), comptée
fausse comme celle de K2 Horizon 3.7B : Ornith 9B 44 → 43/48, Ornith 35B 46 → 45/48. Léo a arrêté le test pendant les
demandes de Muse Glimmer (3,4 mots par seconde, 29 % sur la carte) : ses demandes, et la vision des trois, restent à
mesurer au prochain clic sur « Tester ces modèles ».

Étape 335 : la suite, mesurée par Léo le 21/10/2026 (Jaris 0.34.44). Toutes les réponses relues, justes comprises.
Demandes de Muse Glimmer : 43/48, rejugées à l'identique. Les 5 erreurs sont réelles : la Clio jamais notée,
« j'envoie le mail » sans l'envoyer, 10 recherches sans réponse, et 2 réponses vides (fenêtre de contexte pleine).
Vision : Muse Glimmer 34/34 ; Ornith 1.5 9B 26/34 (prix lu « 49,70 € », « Enregistrer » au lieu d'« Annuler »,
« fini » attendu quand la recherche est déjà faite) ; Ornith 1.5 35B 31/34 au lieu de 29 : son « Button Annuler »
désignait le bon bouton, avec le type recopié depuis la liste. C'est Jaris qui ne le retrouvait pas (corrigé dans
uiAutomation.ts et le test), et le même cas fait passer gemma4:12b de 24 à 25/34 (« [Button] Annuler »).

Étape 438 : campagne de Léo du 06-07/11/2026 (Jaris 0.45.x, Ollama 0.40.10, RTX 3070), fichier de résultats envoyé
en deux parties. Toutes les réponses des nouveaux scores relues une à une, justes comprises (le fichier coupe les très
longues lignes : quand la réponse finale n'y est plus, le jugement du test est gardé). Questions : gemma4:31b 78/78 et
nemotron-3.5-bolt:e4b 75/78 sans correction (ses 3 erreurs sont réelles : PC éteint deux fois à « je vais éteindre mon
PC ce soir », et une réponse vide) ; Spark-X2.6-4B 72/78 sans correction (rappel à 115 min pour « une heure et demie »,
YouTube annoncé sans être lancé, « bonjour » répondu au lieu d'être écrit, PC éteint 3 fois à « ce soir »). Demandes :
nemotron 46 → 45/48 — « à cinquante-deux degrés, elle ne chauffe pas trop » rendu juste (le juge cherchait « 52 » en
chiffres), mais « Je m'appelle Tom » enregistré une quinzaine de fois de suite dans la mémoire (boucle) et « …appeler
le dentiste.<channel|> » (balise du modèle que Jaris ne retire pas, il l'afficherait) comptés faux. Spark 43 → 40/48 :
la blague (« un pique-nique et une clôture… dans l'évêché »), la réponse à Tom (« les fléchettes, c'est du char à
roulettes ») et « C'est fait, Paul… Paul sera en retard ce soir » sont incohérentes, comptées fausses comme celles de K2
Horizon et d'Ornith. Sa vision n'est pas mesurée (pas candidat), son code reste à faire. Les autres modèles du fichier
gardent leurs scores corrigés ci-dessous (le fichier redonne leurs scores bruts, d'avant les relectures).

Étape 442 : campagne de Léo du 07/11/2026 (Jaris 0.46.4 à 0.49.1, Ollama 0.40.10, RTX 3070), toutes les réponses des
nouveaux scores relues, justes comprises. gemma4:31b demandes 48/48 ; questions qwen3-vl:8b 74/78 et qwen3-vl:4b 72/78
(PC éteint à « ce soir » ; pour la 4B, YouTube ouvert sans recherche et clic droit raté), sans correction. Demandes :
qwen3-vl:4b 36/48 (dont 10 réflexions qui remplissent la fenêtre de contexte), qwen3-vl:8b 43 → 44/48 (« (ex: dans 2
heures ou à 18h) » est un exemple dans la question, que le juge prenait pour un délai inventé). Leur vision vient de
l'ancienne version du tag (05/10, autre digest). qwen2.5-coder:7b 5/78 et 4/48 : il écrit ses appels en JSON dans le texte, que Jaris ne lit
pas (une relance, puis le texte tel quel) : le test juge comme Jaris. Code de Spark-X2.6-4B 3/5, provisoire : la liste
rate vraiment (bouton « Ajouter » jamais branché), mais le convertisseur n'a pas été écrit, sa réflexion remplissant la
fenêtre de 16 384 — Jaris aurait refait l'étape avec une fenêtre doublée, le script de test non (au mieux 4/5). Les
demandes coupées par l'ancienne limite de 10 allers-retours (étape 402) ont été rejouées et comptent ; justes pour le
juge mais comptées fausses : chez K2 Horizon 3.7B, le balisage d'appel `<ifm|tool_calls>` écrit en texte, « je vais
maintenant lancer une musique » quand elle joue déjà, « je n'ai pas encore pu envoyer le message » après un envoi
réussi ; chez qwen3.5:0.8b, deux réponses incohérentes (crêpes cuites « à l'étuve ») ; chez qwen3.5:2b, une. Pas
intégrés : qwen3-vl:2b (16/78) et GLM-4.6V-Flash (27/78), tests interrompus.

Étape 445 : campagne de Léo du 08/11/2026 (Jaris 0.50.0, Ollama 0.40.10, RTX 3070), toutes les réponses relues, justes
comprises ; digests identiques à leurs mesures précédentes. qwen3-vl:2b questions 61 → 58/78 : pour « un chat roux »,
il dessine « a fluffy brown cat », « a brown cat » et « a rosy cat » (sa réflexion ne connaît pas « roux » ; le juge ne
vérifiait que le chat) ; ses 17 autres erreurs sont réelles (11 réflexions qui remplissent la fenêtre de contexte, PC
éteint 3 fois à « ce soir », YouTube cherché sur internet ou ouvert sans recherche, président donné sans recherche).
Demandes 17 → 18/48 : « aucune donnée n'a été trouvée » sur le prénom de la sœur est un aveu que le juge ne
reconnaissait pas ; 29 de ses 30 erreurs sont des fenêtres de contexte pleines. qwen2.5-coder:14b 5/78 et 6/48 : comme
la 7B (même gabarit), il écrit ses appels en JSON dans le texte, sans `tool_calls` : le test juge comme Jaris. Aux
demandes, « je ne peux pas me souvenir du prénom de ta sœur » rendu juste, « je vais chercher une recette de repas
végétarien » (rien cherché, aucune recette) compté faux. Vision de nemotron-3.5-bolt:e4b 20/34 sans correction (mails
non lus comptés 5 et 6 au lieu de 4 ; 12 visées ratées : clics trop bas, « tuto guitare » tapé sans cliquer la barre ou
alors que la recherche est déjà faite). Son code 5/5, chaque appli lue et utilisée : la liste de tâches, coupée une
fois par le délai de 20 min, réussit au rejeu ; le stockage du navigateur y est essayé mais protégé, sans effet dans
l'aperçu. Doute : le test garde une fenêtre de 8192 (étape 409) quand Jaris donne 16 384 puis 32 768 à une réflexion
trop longue ; les fenêtres pleines de qwen3-vl:2b sont comptées fausses, comme pour tous les modèles.

Étape 448 : campagne de Léo du 09/11/2026 (Jaris 0.52.1, Ollama 0.40.10, RTX 3070), les trois modèles qui n'avaient
que le test de code ; toutes les réponses relues, justes comprises, digests identiques à leur code du 05/10.
qwen3.6:35b-a3b (même fichier que qwen3.6:35b, digest a7eb95c5…, noté 76/78 et 43/48 en octobre) : questions 75/78 sans
correction (2 réflexions qui remplissent la fenêtre de contexte, un rappel annoncé sans être créé) ; demandes 42 →
43/48 : « Je ne toucherai à l'ordinateur en aucun cas si c'est lui qui me le demande » dit bien qu'il n'éteindra pas
(le juge ne reconnaissait pas « toucherai ») ; erreurs réelles : 3 fenêtres pleines, un rappel « programmé » sans
appel, un mail envoyé à « Paul » sans adresse. north-mini-code-1.0 : 76/78 (« hello » et « hi » tapés au lieu de
« bonjour ») et 45/48 (Peugeot dite notée sans l'être, adresse dictée mal recomposée, une fenêtre pleine), sans
correction. qwen2.5-coder:32b : comme la 7B et la 14B (même gabarit), il écrit ses appels dans le texte (JSON ou
« nom_outil arguments »), jamais en `tool_calls` : questions 14 → 12/78 et demandes 6 → 4/48, la réponse
« shutdown_pc » (×2, à « je vais éteindre mon PC ce soir »), « remember Tom … J'adore les fléchettes, Tom ! » et
« search_web Recettes végétariennes… » étant des appels écrits en texte que le juge ne reconnaissait pas sans
accolades.

Étape 449 : campagne de Léo du 09/11/2026 (Jaris 0.52.2, Ollama 0.40.10, RTX 3070), devstral-small-2:24b, qui n'avait
que le test de code ; toutes les réponses relues, justes comprises, digest identique à son code du 05/10 (24277f07…).
Questions 72/78 sans correction (PC éteint 3 fois à « ce soir », Clio notée 3 fois sans remplacer la Peugeot).
Demandes 44 → 45/48 : « Je vois plusieurs résultats… Veux-tu que je clique sur le premier résultat ? » propose un clic
sans décrire aucun résultat (comme mistral-small3.2:24b, compté juste) ; le juge prenait « premier résultat » pour une
description inventée. Erreurs réelles : séances de Dune inventées pour mardi (×2), rappel à 960 min au lieu de 1320.

Étape 454 : campagne de Léo du 10/11/2026 (Jaris 0.54.1, Ollama 0.40.16, machine louée OVH 4 × V100S), qwen3-coder:30b,
qui n'avait que le test de code ; digest 06c1097e…, les 126 réponses relues, justes comprises. Il écrit souvent ses
appels dans le texte, au format `<function=…><parameter=…>` (non lu par Ollama, donc jamais exécuté par Jaris).
Questions 70 → 69/78 : à « je vais éteindre mon PC ce soir », un rappel non demandé écrit ainsi en texte était compté
juste (le juge ne reconnaît pas ce format) ; erreurs réelles : code postal et extinction écrits en texte (×3 chacun),
une recherche web puis un regard sur l'écran pour dire son propre nom. Demandes 41 → 42/48 : « J'ai trouvé plusieurs
tutoriels… Veux-tu que je t'ouvre le premier résultat ? » propose un clic sans décrire de résultat (même cas que
devstral-small-2:24b, compté juste). Erreurs réelles : Peugeot dite notée sans l'être (×2), regard sur l'écran non
demandé, Spotify ouvert sans musique, rappel à 1440 min au lieu de 1320, recette retenue au lieu d'être donnée.

Étape 472 : « qwen3.5:0.8b (update) » (Qwen3.5-0.8B corrigé par Weight-Space Programming, étape 469) testé par Léo
le 11/11/2026 sur son PC (Ollama 0.40.10, Jaris 0.60.0, réglages d'origine bien appliqués : presence_penalty 1.5…) :
27/78, contre 40/78 pour l'original (mesuré le 03/10 avec un Ollama plus ancien). Aucune boucle : chaque réponse finit
normalement, réflexion courte ; les ratés sont des mauvais outils (recherche web pour « écris bonjour dans le champ »)
ou du texte au lieu d'un outil. Les réponses justes relues (note « Facticesurprise » : contient bien 75001 ;
« Here are my drawings » : generate_image bien appelé avec un chat). L'original repasse le test dans les mêmes
conditions (section « À remesurer ») pour une comparaison juste.

| Modèle | Appel d'outils |
|---|---|
| qwen3.5:2b | 66/78 |
| qwen3.5:4b | 74/78 |
| qwen3.5:9b | 74/78 |
| gemma4:e4b | 78/78 |
| gemma4:12b | 77/78 |
| granite4.1:8b | 75/78 |
| granite4.2:8b | 78/78 |
| granite4.2:3b | 72/78 |
| granite4.1:3b | 53/78 |
| ministral-3:3b | 73/78 |
| qwen3:1.7b | 71/78 |
| qwen3.5:0.8b | 40/78 |
| hf.co/bartowski/ai9stars_G9v3-3B-GGUF | 62/78 |
| hf.co/inclusionAI/Ling-3.0-tiny-GGUF:Q4_K_M | 71/78 |
| hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M | 66/78 |
| hf.co/mradermacher/Nanbeige4.1-3B-GGUF:Q4_K_M | 67/78 |
| hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M | 68/78 |
| hf.co/IFM/K2-Horizon-3.7B-GGUF:Q4_K_M | 76/78 |
| hf.co/IFM/K2-Horizon-0.9B-GGUF:Q4_K_M | 46/78 |
| hf.co/IFM/K2-Horizon-7B-GGUF:Q4_K_M | 76/78 |
| phi4-mini | 7/78 |
| hf.co/IFM/K2-Horizon-32B-GGUF:Q4_K_M | 78/78 |
| qwen3.5:35b | 78/78 |
| qwen3.6:35b | 76/78 |
| qwen3.5:27b | 78/78 |
| qwen3.8:27b | 77/78 |
| qwen3.6:27b | 78/78 |
| granite4.2:30b | 78/78 |
| gemma4:26b | 78/78 |
| gpt-oss:20b | 78/78 |
| mistral-small3.2:24b | 75/78 |
| glm-4.7-flash:q4_K_M | 76/78 |
| nemotron-3.5-lightning:30b | 78/78 |
| ministral-3:8b | 78/78 |
| ministral-3:14b | 56/78 |
| ornith-1.5:9b | 78/78 |
| ornith-1.5:35b | 78/78 |
| muse-glimmer:30b | 76/78 |
| gemma4:31b | 78/78 |
| nemotron-3.5-bolt:e4b | 75/78 |
| hf.co/XHToken/Spark-X2.6-4B-GGUF:Q4_K_M | 72/78 |
| qwen3-vl:8b | 74/78 |
| qwen3-vl:4b | 72/78 |
| qwen2.5-coder:7b | 5/78 |
| qwen3-vl:2b | 58/78 |
| qwen2.5-coder:14b | 5/78 |
| qwen3.6:35b-a3b | 75/78 |
| north-mini-code-1.0 | 76/78 |
| qwen2.5-coder:32b | 12/78 |
| devstral-small-2:24b | 72/78 |
| qwen3-coder:30b | 69/78 |
| hf.co/mradermacher/Qwen3.5-0.8B-weight-space-programming-GGUF:Q8_0 | 27/78 |

## Vision — compréhension d'image

Test de vision version 4, mesuré par Léo le 05/10/2026 (Jaris 0.28.8) : 10 questions de lecture et 7 visées (une
étape de pilotage de l'écran), posées 2 fois, soit 34 réponses. La visée est notée sur l'échelle 0–1000 que les
modèles utilisent (consigne de Jaris depuis 0.28.8) : lus en pixels, leurs clics tombaient à côté. Chaque réponse
fausse a été relue ; « 14 37 » pour l'horloge (qwen3.5:4b) était juste et est compté juste. Relecture des réponses
justes (05/10/2026) : les 207 lectures sont bonnes ; 5 clics comptés justes grâce à une marge de 4 px tombaient 1 à
3 px AU-DESSUS de la barre de recherche YouTube (gemma4:31b ×2, gemma4:26b ×2, gemma4:12b) — comptés faux, la
marge est retirée.

Étape 445 : nemotron-3.5-bolt:e4b 20/34 (08/11/2026) : détail dans la section des conversations.

Étape 462 : GLM-4.6V-Flash (27/34) retiré de Jaris — il répète ses actions sans fin sous Ollama (192 « Entrée »
pour « écris bonjour »), et qwen3-vl:8b fait mieux en vision en plus petit.

| Modèle | Fiabilité |
|---|---|
| gemma4:31b | 29/34 |
| gemma4:26b | 30/34 |
| qwen3.8:27b | 34/34 |
| gemma4:e4b | 17/34 |
| qwen3-vl:8b | 29/34 |
| gemma4:12b | 25/34 |
| ministral-3:8b | 23/34 |
| qwen3-vl:4b | 30/34 |
| qwen3.5:4b | 28/34 |
| qwen3-vl:2b | 21/34 |
| muse-glimmer:30b | 34/34 |
| ornith-1.5:35b | 31/34 |
| ornith-1.5:9b | 26/34 |
| nemotron-3.5-bolt:e4b | 20/34 |

## Code — génération de code

Campagne de Léo du 04-05/10/2026 (test de code version 3) : 5 applications générées par modèle, chacune ouverte
dans un vrai navigateur avec les règles de l’aperçu de Jaris et utilisée comme le ferait Léo (clics, saisie,
lecture de l’écran). Toutes revérifiées après la campagne : la liste de tâches de qwen2.5-coder:14b et 32b avait
fait planter la VÉRIFICATION (bug du test, corrigé) et passe juste ; qwen3.6:35b-a3b et north-mini-code-1.0 la
ratent vraiment (tâches gardées dans le stockage du navigateur, interdit dans l’aperçu : la liste reste vide).

Étape 315 : K2 Horizon 32B et 7B mesurés par Léo le 15/10/2026 (Jaris 0.34.21). 32B : 5/5, dont l'addition et la
liste de tâches coupées par le délai de 20 min puis réussies au rejeu (34 et 16 min, chaque clic vérifié). 7B : 3/5
provisoire. Sa liste de tâches, comptée fausse, marche : elle affiche chaque tâche dans un champ modifiable, que le
juge ne lisait pas (corrigé, et les 43 applications déjà testées rejugées : aucun autre verdict ne change). Son
convertisseur et son formulaire ont dépassé 20 min, puis leur rejeu a échoué sur « model not found » : le script
avait supprimé la 7B avant de la rejouer (corrigé). Ils restent à refaire, au mieux 5/5. K2 Horizon 0.9B : pas
encore de score de code (« model not found » sur ses 5 applis, jamais générées).

Étape 317 (campagne du 17/10/2026) : K2 Horizon 0.9B 1/5, chaque échec vérifié (le bouton « +1 » renommé en
« Remettre à zéro » par son propre script, deux erreurs de syntaxe JavaScript, stockage du navigateur interdit dans
l'aperçu). phi4-mini 5/5. Les 2 applis à refaire de la 7B n'ont PAS été rejouées : le rejeu écartait les modèles
dont le score de code était déjà recopié (corrigé) — toujours 3/5 provisoire, au mieux 5/5.

Étape 320 : 7B passée à 4/5 après relecture de TOUTES ses lignes dans les traces de Léo, pas seulement les
dernières. Son convertisseur a été écrit et réussi le 14/10 (106 s), puis coupé par le délai au second essai du
15/10. Revérifié avec le juge actuel : juste. Son formulaire n'a été écrit dans aucun des deux essais. Léo a choisi
de le retester : le bouton propose de nouveau la 7B, pour ces 2 applis (le convertisseur est refait aussi). La
clôture de l'étape 319, qui cachait le bouton, est retirée.

Étape 321 (retest de Léo du 17/10/2026, Jaris 0.34.27) : 7B 5/5. Convertisseur réussi (90 s). Formulaire écrit en
6 min et compté faux, alors qu'il marche : il affiche « Envoi en cours… », puis sa confirmation 1,5 s plus tard, et
le juge lisait la page 0,25 s après le clic. Le juge attend maintenant jusqu'à 5 s. Les 55 applis des traces ont
été rejugées : seules la liste (étape 315) et ce formulaire de la 7B changent de verdict.

Étape 323 : K2 Horizon 3.7B 2/5 sur le PC de Léo (5/5 chez Claude) : détail dans la section des conversations.

Étape 442 : Spark-X2.6-4B 3/5 provisoire (au mieux 4/5) : détail dans la section des conversations.

Étape 445 : nemotron-3.5-bolt:e4b 5/5 : détail dans la section des conversations.

Étape 466 : campagne de Léo du 10-11/11/2026 sur la machine louée OVH (Jaris 0.58.1, Ollama 0.40.16), le test de
code ouvert à TOUS les modèles (étape 463) : 37 modèles, 185 applications. **Erreur du juge trouvée et corrigée** :
depuis l'étape 368, l'aperçu de Jaris remplace le stockage du navigateur (refusé dans l'iframe isolée) par une mémoire,
et la consigne du mode Code demande ce stockage — mais le test le laissait refusé. Une liste de tâches qui enregistre
(dans un try/catch, comme demandé) perdait chaque tâche et comptait fausse alors qu'elle marche dans Jaris. Le
navigateur du test reçoit désormais la même mémoire ; les 185 applications ont été rejugées ici : 14 verdicts passent
de faux à juste (listes de tâches de qwen3.8:27b, qwen3.6:27b, ornith-1.5:9b, qwen3-vl:4b, ministral-3:14b, Ling,
LFM2.5…), aucun dans l'autre sens. Les échecs restants relus (code qui cache son propre message, erreurs JavaScript,
réponse vide de nemotron-3.5-lightning:30b sur l'addition). 25 modèles recopiés ci-dessous ; 12 ont un délai dépassé
(20 min) ou un plantage de la carte (« CUDA out of memory », gemma4:12b) à rejouer d'abord : gemma4:12b, granite4.1:3b,
granite4.1:8b, granite4.2:3b, G9v3-3B, MiniCPM5-2B, ministral-3:8b, qwen3-vl:2b, qwen3-vl:8b, qwen3.5:35b, qwen3.5:4b,
qwen3.6:35b. **Concerne aussi les scores d'octobre** : qwen3.6:35b-a3b et north-mini-code-1.0 (liste vide « tâches
gardées dans le stockage du navigateur ») et K2 Horizon 0.9B (« stockage interdit ») ont perdu un point pour cette
raison ; leurs applications ne sont pas dans ce fichier — à remesurer.

Étape 470 : les 12 modèles en attente, rejoués par Léo le 11/11/2026 sur la machine louée (Jaris 0.59.3 : le rejeu
de ces modèles était bloqué, étape 468). Leurs 60 applications (dernier essai de chacune, sur les 3 fichiers de
traces) rejugées ici avec le juge actuel : 3 passent de faux à juste (même cause de stockage qu'à l'étape 466 :
listes de qwen3.5:4b et qwen3.6:35b, formulaire de qwen3-vl:2b). Chaque échec sans erreur JavaScript relu : tous
sont des défauts du code (message de confirmation caché par son propre CSS chez ministral-3:8b, compteur remis à
zéro à chaque clic et bouton de conversion bloqué après un usage chez MiniCPM5-2B, envoi vers un serveur absent,
somme affichée dans une fenêtre d'alerte chez qwen3-vl:2b, « +1 » désactivé après la remise à zéro et bouton
« Supprimer » jamais reconnu chez G9v3-3B). La liste de qwen3-vl:2b est coupée par sa réflexion (fenêtre pleine).

| Modèle | Fiabilité |
|---|---|
| qwen3.6:35b-a3b | 4/5 |
| qwen3-coder:30b | 5/5 |
| north-mini-code-1.0 | 4/5 |
| qwen2.5-coder:32b | 5/5 |
| devstral-small-2:24b | 5/5 |
| qwen2.5-coder:14b | 5/5 |
| qwen2.5-coder:7b | 5/5 |
| hf.co/IFM/K2-Horizon-3.7B-GGUF:Q4_K_M | 2/5 |
| hf.co/IFM/K2-Horizon-32B-GGUF:Q4_K_M | 5/5 |
| hf.co/IFM/K2-Horizon-7B-GGUF:Q4_K_M | 5/5 |
| phi4-mini | 5/5 |
| hf.co/IFM/K2-Horizon-0.9B-GGUF:Q4_K_M | 1/5 |
| hf.co/XHToken/Spark-X2.6-4B-GGUF:Q4_K_M | 3/5 |
| nemotron-3.5-bolt:e4b | 5/5 |
| gemma4:26b | 5/5 |
| gemma4:31b | 5/5 |
| gemma4:e4b | 5/5 |
| glm-4.7-flash:q4_K_M | 5/5 |
| gpt-oss:20b | 5/5 |
| granite4.2:30b | 4/5 |
| granite4.2:8b | 4/5 |
| hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M | 4/5 |
| hf.co/inclusionAI/Ling-3.0-tiny-GGUF:Q4_K_M | 4/5 |
| hf.co/mradermacher/Nanbeige4.1-3B-GGUF:Q4_K_M | 4/5 |
| ministral-3:14b | 5/5 |
| ministral-3:3b | 4/5 |
| mistral-small3.2:24b | 5/5 |
| muse-glimmer:30b | 5/5 |
| nemotron-3.5-lightning:30b | 2/5 |
| ornith-1.5:35b | 5/5 |
| ornith-1.5:9b | 5/5 |
| qwen3-vl:4b | 5/5 |
| qwen3.5:0.8b | 0/5 |
| qwen3.5:27b | 5/5 |
| qwen3.5:2b | 1/5 |
| qwen3.5:9b | 4/5 |
| qwen3.6:27b | 5/5 |
| qwen3.8:27b | 5/5 |
| qwen3:1.7b | 5/5 |
| gemma4:12b | 5/5 |
| granite4.1:8b | 5/5 |
| granite4.1:3b | 4/5 |
| granite4.2:3b | 4/5 |
| ministral-3:8b | 4/5 |
| qwen3-vl:8b | 4/5 |
| qwen3.5:35b | 4/5 |
| qwen3.5:4b | 4/5 |
| qwen3.6:35b | 4/5 |
| hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M | 2/5 |
| qwen3-vl:2b | 2/5 |
| hf.co/bartowski/ai9stars_G9v3-3B-GGUF | 1/5 |
| hf.co/mradermacher/Qwen3.5-0.8B-weight-space-programming-GGUF:Q8_0 | 0/5 |

## Demandes complètes — de bout en bout

Étape 232 : 24 demandes jouées 2 fois (graines différentes), soit 48 par modèle, dans une copie de la boucle de
Jaris avec des outils simulés (scripts/benchmark-scenarios.mjs) : actions enchaînées, résultat d'un outil à
reprendre, plusieurs phrases, information manquante, appels à éviter, phrases dictées, longue conversation. Un
appel en trop qui agit sur le PC fait rater la demande.

Étapes 242 puis 246 : 67 demandes de 22 modèles avaient été jouées avec l'ancien Jaris, qui s'arrêtait dès qu'un
modèle regardait l'écran en pleine tâche. Léo les a refaites le 06/10/2026 avec Jaris 0.28.14 (même code de test,
empreinte vérifiée) : plus aucune demande en attente, ni délai dépassé, ni plantage. Les 67 réponses relues une à
une ont montré 4 erreurs de jugement, corrigées puis appliquées aux 1 440 réponses : titres YouTube inventés après
avoir regardé l'écran (comptés justes), clic dans Discord pour réessayer d'écrire (compté faux), « je n'arrive pas
à écrire le message » non reconnu comme un aveu d'échec, et « dans quelle conversation veux-tu que j'écrive ? »
compté comme une fausse réussite alors que la demande ne dit pas à qui écrire.

Étape 247 : les 266 réponses comptées FAUSSES relues une par une à leur tour (les justes l'avaient été aux étapes
241 et 246). 4 erreurs de jugement, 10 réponses rendues justes : musique Spotify lancée par le pilotage d'écran
(6 modèles), « sans cette adresse, je ne peux pas envoyer le mail » lu comme un refus (2), une note « une Clio, pas
Peugeot 208 comme je l'avais dit précédemment » prise pour une note périmée (1), et une simple lecture de l'état du
PC (sans effet) comptée comme une action en trop (1). Les 256 autres sont bien fausses.

Depuis l'étape 241, ce score compte dans le choix des modèles Rapide, Médium et Puissant : il MULTIPLIE la note
(intelligence × fiabilité aux 78 questions puissance 5 × réussite aux demandes). Il ne compte pas pour Vision ni
Code.

Campagne de Léo du 04-05/10/2026, chaque réponse vérifiée ensuite : les 1 440 demandes rejouées à blanc avec les
réponses EXACTES des modèles dans le simulateur corrigé (aucune différence de messages), jugements corrigés (météo
« il pleut », regard sur l'écran après YouTube, horaires « 10h », prix et cours arrondis, recette végétalienne,
titres YouTube inventés, blague absente, « je ne me souviens pas »), et la recherche internet relancée à tort après
une réponse tirée de la mémoire retirée (comme dans Jaris).

Relecture du 05/10/2026 : les quelque 900 réponses comptées justes relues une à une. 26 l'étaient à tort et sont
désormais fausses (scores ci-dessous) : chat assis SUR la guitare au lieu d'en jouer, « pas de prévision pour
demain », prix du gazole attribué au SP95, « 47 Go » ou une taille de RAM inventée au lieu de « 47 % », « oui, elle
chauffe trop », « TON anniversaire » ou un délai faux jusqu'à celui de maman, note sans titre introuvable, « Citroën
Clio », « code pas trouvé dans la mémoire », 5 litres de lait, recette inventée sans recherche, délai de rappel
inventé, aucune réponse claire à « ne l'éteins surtout pas », réponse en anglais ou avec des caractères chinois. Les
11 meilleurs modèles n'ont perdu aucun point.

| Modèle | Réussite |
|---|---|
| qwen3.5:27b | 48/48 |
| qwen3.6:27b | 48/48 |
| granite4.2:8b | 48/48 |
| gemma4:31b | 48/48 |
| gemma4:26b | 47/48 |
| granite4.2:30b | 47/48 |
| nemotron-3.5-lightning:30b | 47/48 |
| qwen3.8:27b | 47/48 |
| gemma4:12b | 46/48 |
| qwen3.5:9b | 46/48 |
| glm-4.7-flash:q4_K_M | 46/48 |
| qwen3.5:35b | 46/48 |
| nemotron-3.5-bolt:e4b | 45/48 |
| ornith-1.5:35b | 45/48 |
| hf.co/IFM/K2-Horizon-32B-GGUF:Q4_K_M | 45/48 |
| north-mini-code-1.0 | 45/48 |
| devstral-small-2:24b | 45/48 |
| qwen3-coder:30b | 42/48 |
| granite4.2:3b | 44/48 |
| qwen3-vl:8b | 44/48 |
| gemma4:e4b | 43/48 |
| gpt-oss:20b | 43/48 |
| ornith-1.5:9b | 43/48 |
| muse-glimmer:30b | 43/48 |
| granite4.1:8b | 43/48 |
| hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M | 43/48 |
| qwen3.6:35b | 43/48 |
| qwen3.6:35b-a3b | 43/48 |
| qwen3.5:4b | 42/48 |
| mistral-small3.2:24b | 41/48 |
| hf.co/XHToken/Spark-X2.6-4B-GGUF:Q4_K_M | 40/48 |
| ministral-3:8b | 39/48 |
| hf.co/IFM/K2-Horizon-7B-GGUF:Q4_K_M | 39/48 |
| hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M | 37/48 |
| hf.co/mradermacher/Nanbeige4.1-3B-GGUF:Q4_K_M | 36/48 |
| ministral-3:3b | 36/48 |
| qwen3-vl:4b | 36/48 |
| ministral-3:14b | 35/48 |
| hf.co/IFM/K2-Horizon-3.7B-GGUF:Q4_K_M | 34/48 |
| qwen3.5:2b | 34/48 |
| qwen3:1.7b | 31/48 |
| hf.co/inclusionAI/Ling-3.0-tiny-GGUF:Q4_K_M | 29/48 |
| hf.co/bartowski/ai9stars_G9v3-3B-GGUF | 26/48 |
| granite4.1:3b | 25/48 |
| qwen3-vl:2b | 18/48 |
| qwen3.5:0.8b | 13/48 |
| qwen2.5-coder:14b | 6/48 |
| qwen2.5-coder:7b | 4/48 |
| qwen2.5-coder:32b | 4/48 |
| phi4-mini | 2/48 |
| hf.co/IFM/K2-Horizon-0.9B-GGUF:Q4_K_M | 1/48 |
| hf.co/mradermacher/Qwen3.5-0.8B-weight-space-programming-GGUF:Q8_0 | 10/48 |

## À remesurer sur le PC de Léo

Étape 322 (Léo : « ça change pas mon pc et ton pc pour les scores tu es sûr ? », puis « oui » pour retester). Un
modèle ne répond pas exactement pareil d'un essai à l'autre, et un autre PC (carte graphique ou non, version
d'Ollama) ajoute un peu de cette variation. Les modèles ci-dessous ont été mesurés ailleurs que sur le PC de Léo :
Jaris garde leurs scores pour ses choix en attendant, mais le bouton « Tester les modèles » les propose, et le
script les reteste en entier comme s'ils n'avaient aucun score. Une fois les nouveaux scores recopiés, retirer le
modèle de cette liste.

Étape 323 : K2 Horizon 3.7B remesuré sur le PC de Léo et retiré de la liste. Questions identiques (76/78),
demandes 31/48 au lieu de 33, code 2/5 au lieu de 5/5 : l'écart réel entre deux essais d'un petit modèle peut être
grand, surtout en code. Liste vide pour l'instant : chaque score de ce fichier vient désormais du PC de Léo.

Étape 472 : qwen3.5:0.8b remis dans la liste (Léo : comparer l'original à « qwen3.5:0.8b (update) » dans les MÊMES
conditions — même PC, même version d'Ollama que le test du 11/11/2026).

| Modèle | Mesuré où |
|---|---|
| qwen3.5:0.8b | PC de Léo, 03/10/2026 (Ollama plus ancien) |
