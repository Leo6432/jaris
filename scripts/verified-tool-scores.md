# Scores vérifiés (sans téléchargement pour personne)

**Seule source des scores de fiabilité de Jaris** (étape 166) : l'analyse des modèles a été retirée de
l'application une fois l'analyse complète de Léo du 25/09/2026 recopiée ici — plus aucun fichier
`benchmark-results.md` local n'est lu. `scripts/benchmark-models.mjs` reste un outil de développement pour
remesurer un modèle (`npm run benchmark:models`), dont on recopie ensuite le résultat ici à la main.

Pourquoi c'est possible : la fiabilité d'un modèle (répond-il avec le bon outil et les bons arguments,
comprend-il vraiment une image, génère-t-il du code valide) est une propriété du modèle lui-même, pas du
matériel qui le fait tourner — un score mesuré une fois reste valable sur n'importe quelle machine. La
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
(phi4-mini, functiongemma:270m, granite4:1b, nemotron-3-nano:4b, qwen3.5:2b-q4_K_M) n'ont plus de score.
gemma4:31b n'est candidat qu'en vision.

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

## Vision — compréhension d'image

Test de vision version 4, mesuré par Léo le 05/10/2026 (Jaris 0.28.8) : 10 questions de lecture et 7 visées (une
étape de pilotage de l'écran), posées 2 fois, soit 34 réponses. La visée est notée sur l'échelle 0–1000 que les
modèles utilisent (consigne de Jaris depuis 0.28.8) : lus en pixels, leurs clics tombaient à côté. Chaque réponse
fausse a été relue ; « 14 37 » pour l'horloge (qwen3.5:4b) était juste et est compté juste. Relecture des réponses
justes (05/10/2026) : les 207 lectures sont bonnes ; 5 clics comptés justes grâce à une marge de 4 px tombaient 1 à
3 px AU-DESSUS de la barre de recherche YouTube (gemma4:31b ×2, gemma4:26b ×2, gemma4:12b) — comptés faux, la
marge est retirée.

| Modèle | Fiabilité |
|---|---|
| gemma4:31b | 29/34 |
| gemma4:26b | 30/34 |
| qwen3.8:27b | 34/34 |
| gemma4:e4b | 17/34 |
| qwen3-vl:8b | 29/34 |
| gemma4:12b | 24/34 |
| hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M | 27/34 |
| ministral-3:8b | 23/34 |
| qwen3-vl:4b | 30/34 |
| qwen3.5:4b | 28/34 |
| qwen3-vl:2b | 21/34 |

## Code — génération de code

Campagne de Léo du 04-05/10/2026 (test de code version 3) : 5 applications générées par modèle, chacune ouverte
dans un vrai navigateur avec les règles de l’aperçu de Jaris et utilisée comme le ferait Léo (clics, saisie,
lecture de l’écran). Toutes revérifiées après la campagne : la liste de tâches de qwen2.5-coder:14b et 32b avait
fait planter la VÉRIFICATION (bug du test, corrigé) et passe juste ; qwen3.6:35b-a3b et north-mini-code-1.0 la
ratent vraiment (tâches gardées dans le stockage du navigateur, interdit dans l’aperçu : la liste reste vide).

| Modèle | Fiabilité |
|---|---|
| qwen3.6:35b-a3b | 4/5 |
| qwen3-coder:30b | 5/5 |
| north-mini-code-1.0 | 4/5 |
| qwen2.5-coder:32b | 5/5 |
| devstral-small-2:24b | 5/5 |
| qwen2.5-coder:14b | 5/5 |
| qwen2.5-coder:7b | 5/5 |

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
| gemma4:26b | 47/48 |
| granite4.2:30b | 47/48 |
| granite4.2:8b | 47/48 |
| nemotron-3.5-lightning:30b | 47/48 |
| qwen3.8:27b | 47/48 |
| gemma4:12b | 46/48 |
| qwen3.5:9b | 46/48 |
| glm-4.7-flash:q4_K_M | 45/48 |
| qwen3.5:35b | 45/48 |
| granite4.2:3b | 44/48 |
| gemma4:e4b | 43/48 |
| gpt-oss:20b | 43/48 |
| granite4.1:8b | 43/48 |
| hf.co/LiquidAI/LFM2.5-2.6B-GGUF:Q4_K_M | 43/48 |
| qwen3.5:4b | 42/48 |
| qwen3.6:35b | 42/48 |
| mistral-small3.2:24b | 41/48 |
| ministral-3:8b | 39/48 |
| hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M | 37/48 |
| hf.co/mradermacher/Nanbeige4.1-3B-GGUF:Q4_K_M | 36/48 |
| ministral-3:14b | 34/48 |
| ministral-3:3b | 34/48 |
| qwen3.5:2b | 32/48 |
| qwen3:1.7b | 28/48 |
| hf.co/bartowski/ai9stars_G9v3-3B-GGUF | 26/48 |
| hf.co/inclusionAI/Ling-3.0-tiny-GGUF:Q4_K_M | 26/48 |
| granite4.1:3b | 25/48 |
| qwen3.5:0.8b | 13/48 |
