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
`benchmark-models.mjs` (`TEST_CASES`/`VISION_TEST_CASES`/`CODE_TEST_CASES`, 17/3/3 au moment d'écrire ces
lignes) — même convention que la colonne "Fiabilité" de `benchmark-results.md`.

## Conversation (rapide / médium / puissant) — appel d'outils

Analyse complète de Léo du 25/09/2026 (v0.16.23, test de conversation version 3) : 17 questions par modèle,
13 où il faut appeler le bon outil avec le bon contenu, 4 où il faut répondre sans outil (remerciement,
question sur lui-même, heure déjà connue, négation « n'éteins pas »). Fenêtre de contexte de 8192, comme dans
Jaris.

Trois scores sont CORRIGÉS à la main par rapport au fichier brut de ce run, en relisant les réponses écrites
dans ce même fichier (section « à juger toi-même ») : le script comptait juste toute réponse sans outil aux
4 questions sans outil, y compris une réponse VIDE ou un appel d'outil écrit en texte (que Jaris lirait à
voix haute tel quel). command-r:35b 6 → 2 (trois réponses vides + « Action : ```json … »), granite4.1:3b
13 → 12 (`{"name": "get_system_stats", …}` écrit en texte), phi4-mini 4 → 3 (`look_at_screen{…}` en texte).
Le script compte désormais ces réponses comme fausses (isCorrectAnswer, benchmark-cases.mjs).

functiongemma:270m : ses 4 points viennent uniquement des 4 questions sans outil (réponses de refus, dont une
en anglais) — aucun appel d'outil réussi.

| Modèle | Appel d'outils |
|---|---|
| qwen3.5:0.8b | 9/17 |
| qwen3.5:2b | 13/17 |
| qwen3.5:2b-q4_K_M | 10/17 |
| qwen3.5:4b | 15/17 |
| qwen3.5:9b | 16/17 |
| qwen3.5:27b | 17/17 |
| qwen3.5:35b | 17/17 |
| qwen3.6:27b | 17/17 |
| qwen3.6:35b | 17/17 |
| qwen3.8:27b | 17/17 |
| qwen3:1.7b | 15/17 |
| phi4-mini | 3/17 |
| functiongemma:270m | 4/17 |
| gemma4:e4b | 17/17 |
| gemma4:12b | 17/17 |
| gemma4:26b | 17/17 |
| gemma4:31b | 16/17 |
| granite4:1b | 15/17 |
| granite4.1:3b | 12/17 |
| granite4.1:8b | 17/17 |
| granite4.2:3b | 16/17 |
| granite4.2:8b | 17/17 |
| granite4.2:30b | 17/17 |
| nemotron-3-nano:4b | 12/17 |
| ministral-3:3b | 17/17 |
| ministral-3:8b | 17/17 |
| ministral-3:14b | 14/17 |
| gpt-oss:20b | 16/17 |
| mistral-small3.2:24b | 17/17 |
| glm-4.7-flash:q4_K_M | 17/17 |
| nemotron-3.5-lightning:30b | 17/17 |
| hf.co/bartowski/ai9stars_G9v3-3B-GGUF | 12/17 |
| hf.co/inclusionAI/Ling-3.0-tiny-GGUF:Q4_K_M | 16/17 |
| hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M | 15/17 |

nemotron-3.5-lightning:30b et G9v3-3B : mesurés le 26/09/2026 par le bouton « Tester les modèles sans score »
(test version 4, même machine), après la mise à jour d'Ollama qui répare les téléchargements depuis Hugging Face.
G9v3-3B : 12/17 — son ancien 6/6 (ancien test à 6 questions, consignes coupées) était donc bien trop flatteur.

Ling 3.0 Tiny (Q4_K_M, GGUF officiel d'inclusionAI) : mesuré le 02/10/2026 par Léo avec le bouton « Tester les
modèles sans score » (test version 4), 16/17. Ses 4 réponses sans outil relues : aucune vide, aucun appel d'outil
écrit en texte, et il n'éteint pas l'ordinateur sur la négation. Une seule est maladroite (« je n'ai pas de
microphone »), mais elle n'est pas fausse au sens du test.

MiniCPM5-2B (Q4_K_M, GGUF officiel d'OpenBMB) : mesuré le 03/10/2026 par Léo avec le même bouton (test version 4),
15/17. Ses 4 réponses sans outil relues : aucune vide, aucun appel d'outil écrit en texte, et il n'éteint pas
l'ordinateur sur la négation. Mais il dit « 11:31 du soir » à 11:31 du matin, et prétend pouvoir « allumer » la
machine. Intelligence 12,5, mais l'appel d'outils passe avant : granite4.2:3b (16/17) et ministral-3:3b (17/17)
restent devant lui.

LFM2.5-1.2B et MiniCPM5-1B (imports Hugging Face, plus dans la liste de Jaris) n'ont pas de score : leurs anciens
scores venaient de l'ancien test à 6 questions.

## Vision — compréhension d'image

Mesurés par l'analyse complète de Léo du 25/09/2026 (étape 163) — la fenêtre de contexte y était déjà la bonne,
contrairement aux questions de conversation de ce même run (voir CONVERSATION_TEST_VERSION, benchmark-cases.mjs).

| Modèle | Fiabilité |
|---|---|
| gemma4:31b | 3/3 |
| gemma4:e4b | 1/3 |
| qwen3-vl:8b | 3/3 |
| gemma4:12b | 3/3 |
| hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M | 3/3 |
| ministral-3:8b | 2/3 |
| qwen3-vl:4b | 3/3 |
| qwen3.5:4b | 3/3 |
| qwen3-vl:2b | 3/3 |

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
