"""Sidecar vocal persistant pour Jaris.

Regroupe dans un seul process : écoute continue du micro, détection d'un
double clap franc rapproché (voir CLAP_RMS_THRESHOLD plus bas, seuils
empiriques à ajuster après un vrai test micro, comme SILENCE_RMS_THRESHOLD)
— seul déclenchement automatique désormais, plus de mot d'activation parlé
(openWakeWord retiré, déclenchement manuel via `trigger`/touche "+" toujours
possible) — capture de l'énoncé qui suit jusqu'au silence, puis transcription
(Cohere Transcribe) — directement depuis les échantillons en mémoire, sans
passer par des fichiers WAV intermédiaires.

Sur stdin, une ligne par commande :
  trigger        déclenche une capture manuellement (touche "+", voir App.tsx)
  test-mic       démarre le test micro (voir mic_test_* ci-dessous) — reste actif jusqu'à stop-mic-test,
                 pas de durée fixe : l'utilisateur active/désactive lui-même depuis Options → Micro
  stop-mic-test  arrête le test micro démarré par test-mic

Une ligne JSON par événement sur stdout :
  {"event": "ready"}
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
import time
from math import gcd

import numpy as np

SAMPLE_RATE = 16000
CHUNK_SAMPLES = 1280  # 80 ms : granularité suffisante pour la détection de clap (RMS) sans surcharger le CPU
SILENCE_RMS_THRESHOLD = 300
SILENCE_DURATION_MS = 900
MIN_UTTERANCE_MS = 400
MAX_UTTERANCE_MS = 12_000

# Plus bas que SILENCE_RMS_THRESHOLD : le test micro veut juste détecter un signal (souffle, voix, tape sur
# le micro), pas exiger une vraie parole comme la capture d'énoncé.
MIC_TEST_RMS_THRESHOLD = 150
# Normalise le RMS en 0..1 pour la jauge de la UI (empirique : une voix normale dépasse largement ce seuil).
MIC_TEST_LEVEL_DIVISOR = 3000.0

# Déclenchement alternatif au mot d'activation : DEUX claps francs rapprochés (pas un seul, pour éviter
# qu'une porte qui claque ou un objet qui tombe déclenche Jaris par accident — même logique que les
# interrupteurs "clap on/clap off"). Valeurs empiriques, à ajuster après un vrai test micro (comme
# SILENCE_RMS_THRESHOLD ci-dessus) : CLAP_RMS_THRESHOLD nettement plus haut que SILENCE_RMS_THRESHOLD, un
# clap est un pic bien plus fort et bien plus bref qu'une voix normale.
CLAP_RMS_THRESHOLD = SILENCE_RMS_THRESHOLD * 4
CLAP_MIN_INTERVAL_MS = 150.0
CLAP_MAX_INTERVAL_MS = 1200.0

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
            # PortAudio expose le même micro physique une fois par API hôte (MME, DirectSound, WASAPI,
            # WDM-KS sur Windows...), donc sd.query_devices() brut liste souvent 3-4x le même micro. WASAPI
            # (l'API moderne, la plus fiable) suffit à couvrir tous les vrais périphériques : s'y limiter
            # élimine ces doublons plutôt que de les afficher tous à l'utilisateur. Filet de sécurité : si
            # aucune API WASAPI n'est trouvée (Linux/Mac), on retombe sur la liste complète, dédupliquée par
            # nom au cas où d'autres API se recoupent aussi.
            hostapis = sd.query_hostapis()
            wasapi_index = next((i for i, api in enumerate(hostapis) if "wasapi" in api.get("name", "").lower()), None)

            devices = sd.query_devices()
            seen_names: set[str] = set()
            inputs = []
            for idx, dev in enumerate(devices):
                if dev.get("max_input_channels", 0) <= 0:
                    continue
                if wasapi_index is not None and dev.get("hostapi") != wasapi_index:
                    continue
                name = dev["name"]
                key = name.strip().lower()
                if key in seen_names:
                    continue
                seen_names.add(key)
                inputs.append({"index": idx, "name": name})
            print(json.dumps({"devices": inputs}, ensure_ascii=False))
        except Exception as exc:
            print(json.dumps({"error": str(exc)}, ensure_ascii=False))
            sys.exit(1)
        return

    try:
        import sounddevice as sd  # lève OSError (pas ImportError) si PortAudio est absent
        import scipy.signal
        import torch
        from transformers import AutoProcessor, CohereAsrForConditionalGeneration
    except (ImportError, OSError) as exc:
        emit({"event": "fatal", "message": f"dépendance Python manquante ou inutilisable ({exc}). Lance : pip install -r python/requirements.txt"})
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

    def make_audio_callback(native_rate: int):
        """Le reste du pipeline (détection de clap par RMS, transcription) suppose du 16 kHz partout : si le micro
        ne peut être ouvert qu'à un autre débit (voir la retombée plus bas), ré-échantillonner ici, une
        seule fois à l'entrée, plutôt que de complexifier tout le reste en aval."""
        if native_rate == SAMPLE_RATE:
            def on_audio(indata: np.ndarray, _frames: int, _time_info, status) -> None:
                if status:
                    emit({"event": "log", "message": str(status)})
                audio_queue.put(indata[:, 0].copy())

            return on_audio

        divisor = gcd(SAMPLE_RATE, native_rate)
        up, down = SAMPLE_RATE // divisor, native_rate // divisor

        def on_audio(indata: np.ndarray, _frames: int, _time_info, status) -> None:
            if status:
                emit({"event": "log", "message": str(status)})
            resampled = scipy.signal.resample_poly(indata[:, 0], up, down)
            audio_queue.put(np.clip(resampled, -32768, 32767).astype(np.int16))

        return on_audio

    manual_trigger = threading.Event()
    mic_test_start_requested = threading.Event()
    mic_test_stop_requested = threading.Event()

    def stdin_listener() -> None:
        for raw_line in sys.stdin:
            line = raw_line.strip()
            if line == "trigger":
                manual_trigger.set()
            elif line == "test-mic":
                mic_test_stop_requested.clear()
                mic_test_start_requested.set()
            elif line == "stop-mic-test":
                mic_test_start_requested.clear()
                mic_test_stop_requested.set()

    threading.Thread(target=stdin_listener, daemon=True).start()

    emit({"event": "log", "message": "Ouverture du microphone…"})
    try:
        stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="int16",
            blocksize=CHUNK_SAMPLES,
            device=args.input_device,
            callback=make_audio_callback(SAMPLE_RATE),
        )
        stream.start()
    except sd.PortAudioError as exc:
        # PaErrorCode -9997 : certains micros (USB, Bluetooth...) n'exposent que leur propre débit natif
        # (souvent 44100/48000 Hz) et refusent qu'on leur demande directement du 16 kHz. Retombe sur le
        # débit par défaut du périphérique plutôt que d'abandonner : make_audio_callback ré-échantillonne
        # en 16 kHz avant de mettre en file, donc le reste du pipeline ne voit jamais la différence.
        if "Invalid sample rate" not in str(exc):
            emit({"event": "fatal", "message": f"impossible d'ouvrir le micro : {exc}"})
            sys.exit(1)
        try:
            device_index = args.input_device if args.input_device is not None else sd.default.device[0]
            native_rate = int(round(sd.query_devices(device_index, "input")["default_samplerate"]))
            emit({"event": "log", "message": f"Ce micro n'accepte pas 16 kHz directement, ré-échantillonnage depuis {native_rate} Hz…"})
            blocksize = max(1, round(CHUNK_SAMPLES * native_rate / SAMPLE_RATE))
            stream = sd.InputStream(
                samplerate=native_rate,
                channels=1,
                dtype="int16",
                blocksize=blocksize,
                device=args.input_device,
                callback=make_audio_callback(native_rate),
            )
            stream.start()
        except Exception as exc2:
            emit({"event": "fatal", "message": f"impossible d'ouvrir le micro : {exc2}"})
            sys.exit(1)
    except Exception as exc:
        emit({"event": "fatal", "message": f"impossible d'ouvrir le micro : {exc}"})
        sys.exit(1)

    emit({"event": "ready"})

    mode = "wake"  # "wake" | "capture"
    capture_chunks: list[np.ndarray] = []
    silent_ms = 0.0
    captured_ms = 0.0
    loud_ms = 0.0  # temps effectivement au-dessus du seuil de silence (≠ captured_ms, qui inclut le silence de fin qui a déclenché la coupure)

    mic_test_active = False
    mic_test_detected = False

    # Horodatage (time.monotonic(), pas un compteur de chunks) du dernier pic assez fort pour être un
    # premier clap candidat, en attente d'un second clap dans la fenêtre CLAP_MIN/MAX_INTERVAL_MS -
    # time.monotonic() plutôt qu'un compteur incrémenté par chunk : robuste même si le traitement prend
    # occasionnellement plus de 80 ms (surcharge CPU), ce qu'un simple compteur de chunks supposerait à tort
    # régulier.
    first_clap_at: float | None = None

    while True:
        chunk = audio_queue.get()
        chunk_ms = (len(chunk) / SAMPLE_RATE) * 1000

        # Lit le même flux que la détection de mot d'activation, sans jamais interagir avec `mode` : le test
        # micro tourne "à côté" (voir docstring en tête de fichier), pas à la place du wake word. Pas de
        # durée fixe : reste actif jusqu'à stop-mic-test, l'utilisateur active/désactive lui-même depuis
        # Options → Micro (voir OptionsMenu.tsx) plutôt que d'attendre un minuteur.
        if mic_test_start_requested.is_set():
            mic_test_start_requested.clear()
            mic_test_active = True
            mic_test_detected = False
            emit({"event": "mic_test_started"})

        if mic_test_stop_requested.is_set():
            mic_test_stop_requested.clear()
            if mic_test_active:
                mic_test_active = False
                emit({"event": "mic_test_done", "detected": mic_test_detected})

        if mic_test_active:
            level = rms(chunk)
            if level >= MIC_TEST_RMS_THRESHOLD:
                mic_test_detected = True
            emit({"event": "mic_test_level", "level": min(1.0, level / MIC_TEST_LEVEL_DIVISOR)})

        if mode == "wake":
            triggered = manual_trigger.is_set()
            if triggered:
                manual_trigger.clear()

            # Double clap : voir CLAP_RMS_THRESHOLD ci-dessus. Un chunk assez fort après un premier candidat
            # encore "chaud" (dans la fenêtre MIN/MAX_INTERVAL_MS) déclenche directement.
            now = time.monotonic()
            if rms(chunk) >= CLAP_RMS_THRESHOLD:
                if first_clap_at is None:
                    first_clap_at = now  # premier clap candidat
                else:
                    interval_ms = (now - first_clap_at) * 1000
                    if interval_ms < CLAP_MIN_INTERVAL_MS:
                        pass  # trop rapproché : probablement la suite du même clap (chunk voisin), ignoré
                    elif interval_ms <= CLAP_MAX_INTERVAL_MS:
                        triggered = True
                        emit({"event": "log", "message": f"Double clap détecté ({interval_ms:.0f} ms d'écart)."})
                        first_clap_at = None
                    else:
                        first_clap_at = now  # précédent trop ancien : ce pic devient le nouveau premier clap
            elif first_clap_at is not None and (now - first_clap_at) * 1000 > CLAP_MAX_INTERVAL_MS:
                first_clap_at = None  # premier clap trop ancien, sans second clap dans les temps : oublié

            if triggered:
                mode = "capture"
                capture_chunks = []
                silent_ms = 0.0
                captured_ms = 0.0
                loud_ms = 0.0
                first_clap_at = None
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
