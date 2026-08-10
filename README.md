# Jaris

Assistant IA personnel vocal, inspiré de J.A.R.V.I.S. — **100% local, 0€/mois**.
Electron + React + TypeScript, aucun appel à une API payante : tout le pipeline
(voix → réflexion → réponse) tourne sur la machine.

## État actuel

- ✅ Étape 1 — Projet Electron + React + TS (Vite / electron-vite) initialisé
- ✅ Étape 2 — Visage animé (`JarisFace`) avec 5 états d'émotion : veille,
  écoute, réflexion, content, surpris
- ⬜ Étape 3 — Pipeline vocal local (wake word, faster-whisper, Piper/Kokoro)
- ⬜ Étape 4 — Connexion Ollama (conversation + tool calling)
- ⬜ Étape 5 — Ouverture d'applications + rappels
- ⬜ Étape 6 — Vision d'écran (qwen3-vl)
- ⬜ Étape 7 — Recherche web (SearXNG)
- ⬜ Étape 8 — Envoi de mails

## Démarrer en développement

```bash
npm install
npm run dev
```

Une fenêtre Electron s'ouvre avec le visage de Jaris. Les boutons sous le
visage permettent de tester manuellement les 5 émotions en attendant le
pipeline vocal (étape 3).

## Prérequis pour les prochaines étapes (IA 100% locale)

- [Ollama](https://ollama.com/) avec `ollama pull gpt-oss:20b` (ou
  `qwen3.6:14b`, quantifié Q4) pour le raisonnement, et
  `ollama pull qwen3-vl:8b` pour la vision d'écran
- Docker, pour lancer [SearXNG](https://github.com/searxng/searxng) en local
  (recherche web)
- Modèles voix FR : [Piper](https://github.com/rhasspy/piper) ou Kokoro (TTS),
  et [faster-whisper](https://github.com/SYSTRAN/faster-whisper) modèle
  `small`/`medium` (STT)
- Un modèle de wake word local (Porcupine ou openWakeWord) pour "Jaris"

Aucune clé API payante n'est nécessaire à aucune étape.
