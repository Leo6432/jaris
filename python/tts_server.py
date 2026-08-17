"""Sidecar de synthèse vocale persistant pour Jaris (Supertonic HD).

Charge le modèle une seule fois au démarrage, puis synthétise à la demande :
une ligne de texte sur stdin = une synthèse. Écrit le WAV dans un fichier
temporaire et répond par une ligne JSON sur stdout :
  {"event": "ready"}
  {"event": "speech", "path": "..."}   (fichier WAV à lire puis supprimer)
  {"event": "error", "message": "..."} (une synthèse a échoué)
  {"event": "fatal", "message": "..."} (démarrage impossible)

Lancé par electron/services/ttsClient.ts, jamais directement.
"""

import argparse
import json
import os
import sys
import tempfile

def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--voice", default="M1")
    parser.add_argument("--language", default="fr")
    args = parser.parse_args()

    try:
        from supertonic import TTS
    except ImportError as exc:
        emit({"event": "fatal", "message": f"dépendance Python manquante ({exc}). Lance : pip install -r python/requirements.txt"})
        sys.exit(1)

    try:
        tts = TTS(auto_download=True)
        voice_style = tts.get_voice_style(voice_name=args.voice)
    except Exception as exc:
        emit({"event": "fatal", "message": f"échec de chargement de Supertonic : {exc}"})
        sys.exit(1)

    emit({"event": "ready"})

    for raw_line in sys.stdin:
        text = raw_line.strip()
        if not text:
            continue
        try:
            wav, _duration = tts.synthesize(
                text=text,
                lang=args.language,
                voice_style=voice_style,
                total_steps=8,
                speed=1.05,
            )
            fd, path = tempfile.mkstemp(suffix=".wav", prefix="jaris-tts-")
            os.close(fd)
            tts.save_audio(wav, path)
            emit({"event": "speech", "path": path})
        except Exception as exc:
            emit({"event": "error", "message": str(exc)})


if __name__ == "__main__":
    main()
