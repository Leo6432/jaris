"""Sidecar vocal persistant pour Jaris.

Regroupe dans un seul process : écoute continue du micro, détection du mot
d'activation (openWakeWord), capture de l'énoncé qui suit jusqu'au silence,
puis transcription (Cohere Transcribe) — directement depuis les échantillons
en mémoire, sans passer par des fichiers WAV intermédiaires.

Aucune entrée attendue sur stdin : tout démarre dès le lancement. Une ligne
JSON par événement sur stdout :
  {"event": "ready", "wakeword_model": "..."}
  {"event": "wake"}
  {"event": "transcript", "text": "..."}
  {"event": "log", "message": "..."}       (non bloquant, ex: overrun micro)
  {"event": "error", "message": "..."}     (une transcription a échoué)
  {"event": "fatal", "message": "..."}     (démarrage impossible)

Lancé par electron/services/voiceClient.ts, jamais directement.
"""

import argparse
import json
import queue
import sys
import threading

import numpy as np

SAMPLE_RATE = 16000
CHUNK_SAMPLES = 1280  # 80 ms, taille recommandée par openWakeWord
SILENCE_RMS_THRESHOLD = 300
SILENCE_DURATION_MS = 900
MIN_UTTERANCE_MS = 400
MAX_UTTERANCE_MS = 12_000

# Formules "génériques" que les modèles de transcription peuvent halluciner sur
# du silence/bruit résiduel (héritées de leur entraînement sur des sous-titres).
# La détection de silence en amont filtre déjà la plupart des cas, ceci est un
# filet de sécurité supplémentaire.
HALLUCINATION_PATTERNS = [
    "sous-titres réalisés par la communauté d'amara.org",
    "sous-titrage st'",
    "merci d'avoir regardé cette vidéo",
    "abonnez-vous à la chaîne",
    "n'oubliez pas de vous abonner",
    "merci à tous et à bientôt",
]


def is_hallucination(text: str) -> bool:
    lowered = text.lower()
    return any(pattern in lowered for pattern in HALLUCINATION_PATTERNS)


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def rms(chunk: np.ndarray) -> float:
    return float(np.sqrt(np.mean(chunk.astype(np.float64) ** 2)))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--wakeword-model", required=True)
    parser.add_argument("--melspec-model", required=True)
    parser.add_argument("--embedding-model", required=True)
    parser.add_argument("--wakeword-threshold", type=float, default=0.5)
    parser.add_argument("--stt-model", default="CohereLabs/cohere-transcribe-03-2026")
    parser.add_argument("--stt-device", default="cpu")
    parser.add_argument("--stt-language", default="fr")
    parser.add_argument("--input-device", type=int, default=None)
    args = parser.parse_args()

    try:
        import sounddevice as sd  # lève OSError (pas ImportError) si PortAudio est absent
        from openwakeword.model import Model
        import torch
        from transformers import AutoProcessor, CohereAsrForConditionalGeneration
    except (ImportError, OSError) as exc:
        emit({"event": "fatal", "message": f"dépendance Python manquante ou inutilisable ({exc}). Lance : pip install -r python/requirements.txt"})
        sys.exit(1)

    emit({"event": "log", "message": "Chargement du modèle de mot d'activation (openWakeWord)…"})
    try:
        wake_model = Model(
            wakeword_models=[args.wakeword_model],
            melspec_model_path=args.melspec_model,
            embedding_model_path=args.embedding_model,
            inference_framework="onnx",
        )
        wake_model_name = next(iter(wake_model.models.keys()))
    except Exception as exc:
        emit({"event": "fatal", "message": f"échec de chargement du mot-clé openWakeWord : {exc}"})
        sys.exit(1)

    emit({"event": "log", "message": f"Chargement de la transcription '{args.stt_model}' (téléchargement HuggingFace au premier lancement, ~4 Go, peut prendre plusieurs minutes)…"})
    try:
        stt_dtype = torch.float16 if args.stt_device == "cuda" else torch.float32
        stt_processor = AutoProcessor.from_pretrained(args.stt_model)
        stt_model = CohereAsrForConditionalGeneration.from_pretrained(
            args.stt_model, dtype=stt_dtype, device_map=args.stt_device
        )
    except Exception as exc:
        hint = (
            " Ce modèle est protégé ('gated') : accepte les conditions sur "
            f"https://huggingface.co/{args.stt_model} puis lance `hf auth login` "
            "avec un compte Hugging Face gratuit."
            if "gated" in str(exc).lower() or "401" in str(exc) or "access" in str(exc).lower()
            else ""
        )
        emit({"event": "fatal", "message": f"échec de chargement de la transcription '{args.stt_model}': {exc}.{hint}"})
        sys.exit(1)

    audio_queue: "queue.Queue[np.ndarray]" = queue.Queue()

    def on_audio(indata: np.ndarray, _frames: int, _time_info, status) -> None:
        if status:
            emit({"event": "log", "message": str(status)})
        audio_queue.put(indata[:, 0].copy())

    manual_trigger = threading.Event()

    def stdin_listener() -> None:
        for raw_line in sys.stdin:
            if raw_line.strip() == "trigger":
                manual_trigger.set()

    threading.Thread(target=stdin_listener, daemon=True).start()

    emit({"event": "log", "message": "Ouverture du microphone…"})
    try:
        stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=CHUNK_SAMPLES,
            device=args.input_device,
            callback=on_audio,
        )
        stream.start()
    except Exception as exc:
        emit({"event": "fatal", "message": f"impossible d'ouvrir le micro : {exc}"})
        sys.exit(1)

    emit({"event": "ready", "wakeword_model": wake_model_name})

    mode = "wake"  # "wake" | "capture"
    capture_chunks: list[np.ndarray] = []
    silent_ms = 0.0
    captured_ms = 0.0

    while True:
        chunk = audio_queue.get()
        chunk_ms = (len(chunk) / SAMPLE_RATE) * 1000

        if mode == "wake":
            triggered = manual_trigger.is_set()
            if triggered:
                manual_trigger.clear()
            prediction = wake_model.predict(chunk)
            if triggered or prediction.get(wake_model_name, 0.0) > args.wakeword_threshold:
                mode = "capture"
                capture_chunks = []
                silent_ms = 0.0
                captured_ms = 0.0
                emit({"event": "wake"})
            continue

        # mode == "capture"
        capture_chunks.append(chunk)
        captured_ms += chunk_ms
        silent_ms = silent_ms + chunk_ms if rms(chunk) < SILENCE_RMS_THRESHOLD else 0.0

        utterance_done = (silent_ms > SILENCE_DURATION_MS and captured_ms > MIN_UTTERANCE_MS) or captured_ms > MAX_UTTERANCE_MS
        if not utterance_done:
            continue

        mode = "wake"
        wake_model.reset()  # évite un second déclenchement fantôme sur la fin de capture/silence
        audio = np.concatenate(capture_chunks).astype(np.float32) / 32768.0
        try:
            inputs = stt_processor(audio, sampling_rate=SAMPLE_RATE, return_tensors="pt", language=args.stt_language)
            inputs.to(stt_model.device, dtype=stt_model.dtype)
            with torch.no_grad():
                outputs = stt_model.generate(**inputs, max_new_tokens=256)
            text = stt_processor.decode(outputs[0], skip_special_tokens=True).strip()
            if is_hallucination(text):
                text = ""
            emit({"event": "transcript", "text": text})
        except Exception as exc:
            emit({"event": "error", "message": str(exc)})


if __name__ == "__main__":
    main()
