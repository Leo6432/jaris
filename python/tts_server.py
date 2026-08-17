"""Sidecar de synthèse vocale persistant pour Jaris (Supertonic HD).

Charge le modèle une seule fois au démarrage, puis synthétise à la demande :
une ligne JSON sur stdin = une synthèse, ex: {"text": "...", "voice": "M3"}.
Les styles de voix sont mis en cache après leur premier usage (changer de
voix d'une requête à l'autre ne recharge pas le modèle). Écrit le WAV dans
un fichier temporaire et répond par une ligne JSON sur stdout :
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
    parser.add_argument("--voice", default="M3")
    parser.add_argument("--language", default="fr")
    args = parser.parse_args()

    try:
        from supertonic import TTS
    except ImportError as exc:
        emit({"event": "fatal", "message": f"dépendance Python manquante ({exc}). Lance : pip install -r python/requirements.txt"})
        sys.exit(1)

    try:
        tts = TTS(auto_download=True)
        voice_styles = {args.voice: tts.get_voice_style(voice_name=args.voice)}
    except Exception as exc:
        emit({"event": "fatal", "message": f"échec de chargement de Supertonic : {exc}"})
        sys.exit(1)

    emit({"event": "ready"})

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            text = request["text"]
            voice = request.get("voice") or args.voice
            if voice not in voice_styles:
                voice_styles[voice] = tts.get_voice_style(voice_name=voice)

            wav, _duration = tts.synthesize(
                text=text,
                lang=args.language,
                voice_style=voice_styles[voice],
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
