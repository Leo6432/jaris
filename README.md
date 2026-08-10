# Jaris

Assistant IA personnel vocal, inspiré de J.A.R.V.I.S. — **100% local, 0€/mois**.
Electron + React + TypeScript, aucun appel à une API payante : tout le pipeline
(voix → réflexion → réponse) tourne sur la machine.

## État actuel

- ✅ Étape 1 — Projet Electron + React + TS (Vite / electron-vite) initialisé
- ✅ Étape 2 — Visage animé (`JarisFace`) avec 5 états d'émotion : veille,
  écoute, réflexion, content, surpris
- ✅ Étape 3 — Pipeline vocal local : mot d'activation "Jaris" (Porcupine),
  transcription (faster-whisper), synthèse vocale (Piper). Jaris confirme à
  voix haute ce qu'il a compris ; la vraie compréhension (LLM) arrive à
  l'étape 4
- ⬜ Étape 4 — Connexion Ollama (conversation + tool calling)
- ⬜ Étape 5 — Ouverture d'applications + rappels
- ⬜ Étape 6 — Vision d'écran (qwen3-vl)
- ⬜ Étape 7 — Recherche web (SearXNG)
- ⬜ Étape 8 — Envoi de mails

## Démarrer en développement

```bash
npm install
cp .env.example .env   # puis remplis les valeurs, voir ci-dessous
npm run dev
```

Sans configuration vocale, la fenêtre s'ouvre quand même : un bandeau indique
ce qui manque, et les boutons sous le visage permettent de tester les 5
émotions manuellement.

## Mettre en place le pipeline vocal (étape 3)

Trois choses à installer, dans l'ordre. Rien de payant — juste des comptes/
téléchargements gratuits.

### 1. Mot d'activation "Jaris" (Porcupine)

1. Crée un compte gratuit sur [console.picovoice.io](https://console.picovoice.io/)
   (pas de carte bancaire).
2. Récupère ta clé dans **AccessKey** → colle-la dans `.env` sous
   `PICOVOICE_ACCESS_KEY`.
3. Va dans **Porcupine → Create Wake Word**, tape "Jaris", choisis
   **Windows** comme plateforme, entraîne (~2 min) puis télécharge le
   fichier `.ppn`.
4. `mkdir -p models/wakeword` puis place-le dans
   `models/wakeword/Jaris_windows.ppn` (chemin par défaut, modifiable via
   `PORCUPINE_KEYWORD_PATH` dans `.env`).

### 2. Reconnaissance vocale (faster-whisper)

Tourne dans un petit process Python à côté d'Electron.

```bash
python -m venv python/venv
python/venv/Scripts/activate   # (Windows) — python/venv/bin/activate sur Mac/Linux
pip install -r python/requirements.txt
```

Renseigne dans `.env` :
- `PYTHON_BIN` → chemin vers `python/venv/Scripts/python.exe`
- `WHISPER_MODEL` → `small` (rapide) ou `medium` (plus précis) pour le français
- `WHISPER_DEVICE=cuda` sur la RTX 3070 (nécessite les DLL CUDA/cuDNN livrées
  avec `pip install nvidia-cublas-cu12 nvidia-cudnn-cu12` si `ctranslate2` ne
  les trouve pas), sinon `cpu`

### 3. Synthèse vocale (Piper)

1. `mkdir -p bin/piper models/tts`
2. Télécharge le binaire Windows sur les
   [releases GitHub de Piper](https://github.com/rhasspy/piper/releases)
   (`piper_windows_amd64.zip`), dézippe dans `bin/piper/`.
3. Télécharge une voix française, par exemple `fr_FR-siwis-medium`, depuis le
   [dépôt de voix Piper](https://huggingface.co/rhasspy/piper-voices/tree/main/fr/fr_FR)
   (les deux fichiers `.onnx` et `.onnx.json`) dans `models/tts/`.
3. Vérifie que `.env` pointe bien vers ces chemins (`PIPER_BIN_PATH`,
   `PIPER_VOICE_PATH`).

### Vérifier

`npm run dev` : dis "Jaris" près du micro, Jaris doit s'illuminer (écoute),
transcrire ce que tu dis, puis le redire à voix haute pour confirmer qu'il a
compris — c'est la preuve que toute la chaîne audio fonctionne, avant de
brancher un vrai raisonnement à l'étape 4.

> Le service wake word (`electron/services/wakeword.ts`) est écrit contre le
> SDK officiel Porcupine/PvRecorder et a été relu attentivement, mais n'a pas
> pu être testé avec un vrai micro dans cet environnement de développement —
> vérifie-le en premier sur ta machine. Les services STT (`sttClient.ts`) et
> TTS (`tts.ts`) ont eux été testés bout en bout (synthèse → transcription).

## Prérequis pour les prochaines étapes (IA 100% locale)

- [Ollama](https://ollama.com/) avec `ollama pull qwen3.5:9b` pour le
  raisonnement, et `ollama pull qwen3-vl:8b` pour la vision d'écran — le nom
  du modèle est déjà configurable via `OLLAMA_MODEL` dans `.env`
- Docker, pour lancer [SearXNG](https://github.com/searxng/searxng) en local
  (recherche web)

Aucune clé API payante n'est nécessaire à aucune étape.
