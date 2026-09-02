# Scores vérifiés (sans téléchargement pour personne)

Contrairement à `scripts/benchmark-results.md` (généré localement par chaque installation de Jaris, jamais
commité — voir `.gitignore`), ce fichier-ci **est commité dans le dépôt** : il contient des scores de
fiabilité vérifiés une fois par Léo sur sa propre machine, valables pour tout le monde.

Pourquoi c'est possible : la fiabilité d'un modèle (répond-il avec le bon outil et les bons arguments,
comprend-il vraiment une image, génère-t-il du code valide) est une propriété du modèle lui-même, pas du
matériel qui le fait tourner — un score mesuré une fois reste valable sur n'importe quelle machine. La
**vitesse**, elle, dépend du matériel de chacun : jamais stockée ici, toujours recalculée par formule pour
la config de l'utilisateur (voir `estimateSpeedTokPerSec` dans `electron/services/hardwareScan.ts`).

`scripts/benchmark-models.mjs` saute le téléchargement et le test de tout modèle présent dans la bonne
section ci-dessous (voir `VERIFIED_MODELS` dans le script) : aucune installation nécessaire chez
l'utilisateur final pour ces modèles-là. Seuls les modèles ABSENTS (trop gros pour la machine de Léo,
jamais testés par lui) continuent d'être téléchargés et testés pour de vrai, sur la machine de qui a assez
de VRAM pour le faire.

**Trois sections séparées, jamais une seule liste par nom de modèle** : certains modèles (ex: `qwen3.5:4b`,
`gemma4:e4b`) sont candidats à la fois en Conversation et en Vision — leur score n'y est pas le même (l'un
teste l'appel d'outils, l'autre la compréhension d'image), donc chacun a sa propre ligne dans sa propre
section. Un modèle absent d'une section mais présent dans une autre reste testé pour de vrai dans celle où
il manque.

Format : un modèle par ligne dans sa section, score sur le nombre de questions posées pour ce palier par
`benchmark-models.mjs` (`TEST_CASES`/`VISION_TEST_CASES`/`CODE_TEST_CASES`, 6/3/3 au moment d'écrire ces
lignes) — même convention que la colonne "Fiabilité" de `benchmark-results.md`.

## Conversation (rapide / médium / puissant) — appel d'outils

| Modèle | Appel d'outils |
|---|---|
| qwen3.5:2b | 5/6 |
| qwen3.5:2b-q4_K_M | 4/6 |
| qwen3.5:9b | 6/6 |
| phi4-mini | 0/6 |
| granite4.1:3b | 6/6 |
| nemotron-3-nano:4b | 6/6 |
| ministral-3:3b | 6/6 |
| hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF | 0/6 |
| qwen3:1.7b | 6/6 |
| granite4:1b | 6/6 |
| qwen3.5:0.8b | 5/6 |
| functiongemma:270m | 1/6 |
| hf.co/openbmb/MiniCPM5-1B-GGUF | 2/6 |
| hf.co/bartowski/ai9stars_G9v3-3B-GGUF | 6/6 |
| qwen3.5:35b | 6/6 |
| qwen3.5:27b | 6/6 |
| qwen3.6:27b | 6/6 |
| gemma4:26b | 6/6 |
| gpt-oss:20b | 6/6 |
| command-r:35b | 3/6 |
| mistral-small:24b | 6/6 |
| glm-4.7-flash:q4_K_M | 6/6 |

## Vision — compréhension d'image

| Modèle | Fiabilité |
|---|---|
| hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M | 3/3 |
| qwen3-vl:4b | 3/3 |
| qwen3-vl:2b | 3/3 |
| qwen3.5:4b | 3/3 |

## Code — génération de code

| Modèle | Fiabilité |
|---|---|
| qwen3.6:35b-a3b | 3/3 |
| qwen3-coder:30b | 3/3 |
| north-mini-code-1.0 | 3/3 |
| qwen2.5-coder:32b | 2/2 |
| devstral-small-2:24b | 3/3 |
| qwen2.5-coder:7b | 3/3 |
