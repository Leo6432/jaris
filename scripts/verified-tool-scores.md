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

Même test du 03/10/2026 : 6 images posées 3 fois, soit 18 réponses. Corrigé à la main : gemma4:26b et
gemma4:e4b 16 → 18 — « Le code affiché est 4821. » et « Quatre huit deux un » étaient comptés faux par un
bug de la vérification, corrigé depuis. ministral-3:8b reste à 17 : il a vraiment répondu « Vert » pour un
carré bleu.

| Modèle | Fiabilité |
|---|---|
| gemma4:31b | 18/18 |
| gemma4:26b | 18/18 |
| qwen3.8:27b | 18/18 |
| gemma4:e4b | 18/18 |
| qwen3-vl:8b | 18/18 |
| gemma4:12b | 18/18 |
| hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M | 18/18 |
| ministral-3:8b | 17/18 |
| qwen3-vl:4b | 18/18 |
| qwen3.5:4b | 18/18 |
| qwen3-vl:2b | 18/18 |

## Code — génération de code

Même analyse (25/09/2026), qwen2.5-coder:32b remesuré en entier le soir même (3/3 : la mesure précédente,
2/2, était incomplète). qwen2.5-coder:14b : mesuré le 26/09/2026 (bouton « Tester les modèles sans score »).
qwen3-coder-next (3/3) retiré des candidats le 02/10/2026 : 9,2 chez Artificial Analysis pour 52 Go.

| Modèle | Fiabilité |
|---|---|
| qwen3.6:35b-a3b | 3/3 |
| qwen3-coder:30b | 3/3 |
| north-mini-code-1.0 | 3/3 |
| qwen2.5-coder:32b | 3/3 |
| devstral-small-2:24b | 3/3 |
| qwen2.5-coder:14b | 3/3 |
| qwen2.5-coder:7b | 3/3 |
