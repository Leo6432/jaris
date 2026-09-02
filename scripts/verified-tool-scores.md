# Scores d'appel d'outils vérifiés

Contrairement à `scripts/benchmark-results.md` (généré localement par chaque installation de Jaris, jamais
commité — voir `.gitignore`), ce fichier-ci **est commité dans le dépôt** : il contient des scores de
fiabilité d'appel d'outils vérifiés une fois par Léo sur sa propre machine, valables pour tout le monde.

Pourquoi c'est possible : la fiabilité d'appel d'outils d'un modèle (répond-il avec le bon outil et les
bons arguments) est une propriété du modèle lui-même, pas du matériel qui le fait tourner — un score
mesuré une fois reste valable sur n'importe quelle machine. La **vitesse**, elle, dépend du matériel de
chacun : jamais stockée ici, toujours recalculée par formule pour la config de l'utilisateur (voir
`estimateSpeedTokPerSec` dans `electron/services/hardwareScan.ts`).

`scripts/benchmark-models.mjs` saute le téléchargement et le test de tout modèle présent ici (voir SCOPE
et `VERIFIED_TOOL_SCORES` dans le script) : aucune installation nécessaire chez l'utilisateur final pour
ces modèles-là. Seuls les modèles ABSENTS de ce fichier (trop gros pour la machine de Léo, jamais testés
par lui) continuent d'être téléchargés et testés pour de vrai, sur la machine de qui a assez de VRAM pour
le faire.

Format : un modèle par ligne, score sur `TEST_CASES.length` de `benchmark-models.mjs` (6 au moment
d'écrire ces lignes) — même convention que la colonne "Appel d'outils" de `benchmark-results.md`.

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
