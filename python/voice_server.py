"""Sidecar vocal persistant pour Jaris.

Regroupe dans un seul process : écoute continue du micro, détection du mot
d'activation (openWakeWord), capture de l'énoncé qui suit jusqu'au silence,
puis transcription (Cohere Transcribe) — directement depuis les échantillons
en mémoire, sans passer par des fichiers WAV intermédiaires.

Sur stdin, une ligne par commande :
  trigger     déclenche une capture comme si le mot d'activation venait d'être détecté
  test-mic    lance un test micro de quelques secondes (voir mic_test_* ci-dessous)

Une ligne JSON par événement sur stdout :
  {"event": "ready", "wakeword_model": "..."}
  {"event": "wake"}
  {"event": "transcript", "text": "..."}
  {"event": "log", "message": "..."}       (non bloquant, ex: overrun micro)
  {"event": "error", "message": "..."}     (une transcription a échoué)
  {"event": "fatal", "message": "..."}     (démarrage impossible)
  {"event": "mic_test_started"}
  {"event": "mic_test_level", "level": 0.0-1.0}
  {"event": "mic_test_done", "detected": true|false}

Avec --list-devices : ignore tous les autres arguments, n'ouvre aucun micro et ne charge aucun modèle —
imprime juste {"devices": [{"index": 0, "name": "..."}, ...]} (ou {"error": "..."}) et quitte. Utilisé par
Electron pour peupler la liste des micros dans le menu Options, sans lancer tout le sidecar pour ça.

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

MIC_TEST_DURATION_MS = 3000
# Plus bas que SILENCE_RMS_THRESHOLD : le test micro veut juste détecter un signal (souffle, voix, tape sur
# le micro), pas exiger une vraie parole comme la capture d'énoncé.
MIC_TEST_RMS_THRESHOLD = 150
# Normalise le RMS en 0..1 pour la jauge de la UI (empirique : une voix normale dépasse largement ce seuil).
MIC_TEST_LEVEL_DIVISOR = 3000.0

# Formules "génériques" que les modèles de transcription peuvent halluciner sur
# du silence/bruit résiduel (héritées de leur entraînement sur des sous-titres).
# La détection de silence en amont filtre déjà la plupart des cas, ceci est un
# filet de sécurité supplémentaire.
HALLUCINATION_PATTERNS = [
    "sous-titres réalisés par la communauté d'amara.org",
    "sous-titrage st'",
    "radio-canada",  # "Sous-titrage/Sous-titré (Société) Radio-Canada" et ses variantes
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
    parser.add_argument("--wakeword-model")
    parser.add_argument("--melspec-model")
    parser.add_argument("--embedding-model")
    parser.add_argument("--wakeword-threshold", type=float, default=0.5)
    parser.add_argument("--stt-model", default="CohereLabs/cohere-transcribe-03-2026")
    parser.add_argument("--stt-device", default="cpu")
    parser.add_argument("--stt-language", default="fr")
    parser.add_argument("--input-device", type=int, default=None)
    parser.add_argument("--list-devices", action="store_true")
    args = parser.parse_args()

    if args.list_devices:
        # Mode one-shot : pas d'événements JSON-par-ligne ici, juste un objet JSON unique en sortie, lu une
        # seule fois par Electron (voir voiceClient.ts). N'importe et n'ouvre rien d'autre que PortAudio.
        try:
            import sounddevice as sd
        except (ImportError, OSError) as exc:
            print(json.dumps({"error": f"PortAudio indisponible ({exc})"}, ensure_ascii=False))
            sys.exit(1)
        try:
            devices = sd.query_devices()
            inputs = [
                {"index": idx, "name": dev["name"]}
                for idx, dev in enumerate(devices)
                if dev.get("max_input_channels", 0) > 0
            ]
            print(json.dumps({"devices": inputs}, ensure_ascii=False))
        except Exception as exc:
            print(json.dumps({"error": str(exc)}, ensure_ascii=False))
            sys.exit(1)
        return

    if not args.wakeword_model or not args.melspec_model or not args.embedding_model:
        parser.error("--wakeword-model, --melspec-model et --embedding-model sont requis (sauf avec --list-devices)")

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
    mic_test_requested = threading.Event()

    def stdin_listener() -> None:
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if line == "trigger":
                manual_trigger.set()
            elif line == "test-mic":
                mic_test_requested.set()

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
    loud_ms = 0.0  # temps effectivement au-dessus du seuil de silence (≠ captured_ms, qui inclut le silence de fin qui a déclenché la coupure)

    mic_test_remaining_ms = 0.0
    mic_test_detected = False

    while True:
        chunk = audio_queue.get()
        chunk_ms = (len(chunk) / SAMPLE_RATE) * 1000

        # Lit le même flux que la détection de mot d'activation, sans jamais interagir avec `mode` : le test
        # micro tourne "à côté" (voir docstring en tête de fichier), pas à la place du wake word.
        if mic_test_requested.is_set():
            mic_test_requested.clear()
            mic_test_remaining_ms = MIC_TEST_DURATION_MS
            mic_test_detected = False
            emit({"event": "mic_test_started"})

        if mic_test_remaining_ms > 0:
            level = rms(chunk)
            if level >= MIC_TEST_RMS_THRESHOLD:
                mic_test_detected = True
            emit({"event": "mic_test_level", "level": min(1.0, level / MIC_TEST_LEVEL_DIVISOR)})
            mic_test_remaining_ms -= chunk_ms
            if mic_test_remaining_ms <= 0:
                emit({"event": "mic_test_done", "detected": mic_test_detected})

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
                loud_ms = 0.0
                emit({"event": "wake"})
            continue

        # mode == "capture"
        capture_chunks.append(chunk)
        captured_ms += chunk_ms
        chunk_is_loud = rms(chunk) >= SILENCE_RMS_THRESHOLD
        silent_ms = 0.0 if chunk_is_loud else silent_ms + chunk_ms
        if chunk_is_loud:
            loud_ms += chunk_ms

        utterance_done = (silent_ms > SILENCE_DURATION_MS and captured_ms > MIN_UTTERANCE_MS) or captured_ms > MAX_UTTERANCE_MS
        if not utterance_done:
            continue

        mode = "wake"
        wake_model.reset()  # évite un second déclenchement fantôme sur la fin de capture/silence

        # Si rien n'a jamais dépassé le seuil de silence (l'utilisateur active Jaris puis ne dit rien),
        # inutile d'envoyer ce silence au modèle de transcription : il "hallucine" souvent une phrase
        # plausible (générique de sous-titrage TV, formule de fin de vidéo...) plutôt que de reconnaître
        # une absence de parole, hérité de son entraînement sur des sous-titres. Voir aussi
        # HALLUCINATION_PATTERNS ci-dessus, en filet de sécurité pour les cas où il y a bien un peu de son
        # (bruit ambiant, toux...) mais pas de vraie parole.
        if loud_ms < MIN_UTTERANCE_MS:
            emit(
                {
                    "event": "log",
                    "message": (
                        f"Rien d'assez fort détecté ({loud_ms:.0f} ms au-dessus du seuil RMS "
                        f"{SILENCE_RMS_THRESHOLD} sur {captured_ms:.0f} ms captés, minimum requis "
                        f"{MIN_UTTERANCE_MS} ms) : transcription ignorée pour éviter une hallucination."
                    ),
                }
            )
            emit({"event": "transcript", "text": ""})
            continue

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
