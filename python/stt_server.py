"""Sidecar STT persistant pour Jaris.

Charge un modèle faster-whisper une seule fois puis transcrit des fichiers
WAV à la demande. Protocole : une requête JSON par ligne sur stdin
`{"id": "...", "audio_path": "...", "language": "fr"}`, une réponse JSON par
ligne sur stdout `{"id": "...", "event": "result", "text": "..."}` ou
`{"id": "...", "event": "error", "message": "..."}`.

Lancé par electron/services/sttClient.ts, jamais directement par l'utilisateur.
"""

import argparse
import json
import sys


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small")
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    parser.add_argument("--language", default="fr")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        emit({"event": "fatal", "message": "faster-whisper non installé (pip install -r python/requirements.txt)"})
        sys.exit(1)

    try:
        model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    except Exception as exc:  # modèle introuvable, CUDA absent, etc.
        emit({"event": "fatal", "message": f"échec de chargement du modèle '{args.model}': {exc}"})
        sys.exit(1)

    emit({"event": "ready", "model": args.model, "device": args.device})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue

        request_id = request.get("id")
        audio_path = request.get("audio_path")
        language = request.get("language", args.language)

        if not audio_path:
            emit({"id": request_id, "event": "error", "message": "audio_path manquant"})
            continue

        try:
            segments, _info = model.transcribe(audio_path, language=language, beam_size=5)
            text = "".join(segment.text for segment in segments).strip()
            emit({"id": request_id, "event": "result", "text": text})
        except Exception as exc:
            emit({"id": request_id, "event": "error", "message": str(exc)})


if __name__ == "__main__":
    main()
