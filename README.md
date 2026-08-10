# Jaris

Assistant IA personnel vocal, inspiré de J.A.R.V.I.S. — **100% local, 0€/mois**.
Electron + React + TypeScript, aucun appel à une API payante : tout le pipeline
(voix → réflexion → réponse) tourne sur la machine.

## État actuel

- ✅ Étape 1 — Projet Electron + React + TS (Vite / electron-vite) initialisé
- ✅ Étape 2 — Visage animé (`JarisFace`) avec 5 états d'émotion : veille,
  écoute, réflexion, content, surpris
- ✅ Étape 3 — Pipeline vocal local : mot d'activation (openWakeWord),
  transcription (faster-whisper), synthèse vocale (Piper). **Testé de bout
  en bout avec un vrai micro** (voir plus bas)
- ✅ Étape 4 — Connexion Ollama : Jaris comprend vraiment ce que tu dis et
  répond avec un LLM local (`qwen3.5:9b` par défaut, configurable)
- ✅ Étape 5 — Tool calling : Jaris peut ouvrir des applications et
  programmer des rappels vocaux (persistés, survivent à un redémarrage de
  Jaris avant l'échéance) — voir plus bas
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

Zéro compte, zéro clé à créer : tout se télécharge directement.

> **Mot d'activation : "Hey Jarvis" (en anglais), pas "Jaris".**
> openWakeWord (le moteur 100% local et gratuit, sans compte) ne fournit pas
> de mot-clé "Jaris" prêt à l'emploi — le plus proche livré nativement est
> "Hey Jarvis", qu'on utilise donc par défaut. Un vrai mot-clé "Jaris"
> demanderait d'entraîner un modèle maison (notebook fourni par
> openWakeWord, plus de travail) ; ce n'est pas fait pour l'instant.

### 1. Environnement Python (mot d'activation + reconnaissance vocale)

Un seul process Python à côté d'Electron gère le micro, la détection du mot
d'activation et la transcription.

```bash
python -m venv python/venv
python/venv/Scripts/activate   # (Windows) — python/venv/bin/activate sur Mac/Linux
pip install -r python/requirements.txt
python python/download_wakeword_models.py   # télécharge les modèles openWakeWord (~5 Mo) dans models/wakeword/
```

Renseigne dans `.env` :
- `PYTHON_BIN` → chemin vers `python/venv/Scripts/python.exe`
- `WHISPER_MODEL` → `small` (rapide) ou `medium` (plus précis) pour le français
- `WHISPER_DEVICE=cuda` sur la RTX 3070 (nécessite les DLL CUDA/cuDNN livrées
  avec `pip install nvidia-cublas-cu12 nvidia-cudnn-cu12` si `ctranslate2` ne
  les trouve pas), sinon `cpu`
- `WAKEWORD_THRESHOLD` si le mot d'activation se déclenche trop souvent/pas
  assez (0 à 1, défaut 0.5)

### 2. Synthèse vocale (Piper)

1. `mkdir -p bin/piper models/tts`
2. Télécharge le binaire Windows sur les
   [releases GitHub de Piper](https://github.com/rhasspy/piper/releases)
   (`piper_windows_amd64.zip`), dézippe dans `bin/piper/`.
3. Télécharge une voix française, par exemple `fr_FR-siwis-medium`, depuis le
   [dépôt de voix Piper](https://huggingface.co/rhasspy/piper-voices/tree/main/fr/fr_FR)
   (les deux fichiers `.onnx` et `.onnx.json`) dans `models/tts/`.
4. Vérifie que `.env` pointe bien vers ces chemins (`PIPER_BIN_PATH`,
   `PIPER_VOICE_PATH`).

### Vérifier

`npm run dev` : dis "Hey Jarvis" près du micro, Jaris doit s'illuminer,
transcrire ce que tu dis ensuite, puis le redire à voix haute pour confirmer
qu'il a compris — c'est la preuve que toute la chaîne audio fonctionne, avant
de brancher un vrai raisonnement à l'étape 4.

> Pipeline testé de bout en bout avec un vrai micro sur une machine Windows
> (RTX 3070) : mot d'activation, capture, transcription et synthèse vocale
> fonctionnent tous en conditions réelles.
>
> Deux pièges rencontrés en conditions réelles, déjà corrigés dans le code :
> le périphérique micro par défaut du système n'est pas forcément le bon
> (ex: un micro virtuel type Voice Changer/Voicemod) — utilise
> `python -m sounddevice` pour lister les micros et choisir le bon index via
> `WAKEWORD_INPUT_DEVICE` ; et Whisper peut halluciner du texte plausible sur
> du silence (le pipeline filtre déjà ça via la détection de voix intégrée).
>
> Un raccourci clavier **+** (dans la fenêtre Jaris) déclenche aussi l'écoute
> manuellement, sans dire le mot d'activation — pratique pour tester ou en
> environnement bruyant.

## Mettre en place Ollama (étape 4)

1. Installe [Ollama](https://ollama.com/) (installeur Windows classique)
2. Télécharge le modèle de raisonnement :
   ```
   ollama pull qwen3.5:9b
   ```
3. Vérifie dans `.env` que `OLLAMA_HOST` (`http://127.0.0.1:11434` par
   défaut) et `OLLAMA_MODEL` (`qwen3.5:9b` par défaut) sont corrects — le nom
   du modèle est entièrement configurable, pas besoin de toucher au code pour
   en changer

Ollama doit être lancé (il tourne en arrière-plan une fois installé) pour que
Jaris puisse réfléchir. S'il n'est pas joignable, Jaris le dit à voix haute au
lieu de planter.

> Le modèle a par défaut une fenêtre de contexte énorme (131072 tokens pour
> qwen3.5), ce qui peut le faire déborder de la VRAM et tourner en partie sur
> le CPU (très lent). `OLLAMA_NUM_CTX` dans `.env` (4096 par défaut) évite ça
> — vérifie avec `ollama ps` que la colonne PROCESSOR affiche bien ~100% GPU.

## Ouvrir des applications et programmer des rappels (étape 5)

Jaris peut maintenant exécuter deux actions pendant la conversation :
ouvrir une application, ou programmer un rappel vocal ("rappelle-moi de
sortir le linge dans 10 minutes").

**Ouvrir des applications** : aucune configuration nécessaire. Jaris
interroge directement le menu Démarrer de Windows (classiques et Store) pour
trouver l'application dont le nom se rapproche le plus de ce que tu as dit,
puis la lance — toute application installée sur ta machine est utilisable
sans liste à maintenir.

**Rappels** : dis simplement "Jaris, rappelle-moi de [...] dans [x] minutes"
— pas de configuration nécessaire, c'est un outil intégré. Les rappels sont
sauvegardés sur disque : si tu fermes Jaris avant l'échéance, le rappel se
déclenche dès que tu relances l'app (ou immédiatement s'il est en retard).

## Prérequis pour les prochaines étapes (IA 100% locale)

- `ollama pull qwen3-vl:8b` pour la vision d'écran (étape 6)
- Docker, pour lancer [SearXNG](https://github.com/searxng/searxng) en local
  (recherche web, étape 7)

Aucune clé API payante n'est nécessaire à aucune étape.
