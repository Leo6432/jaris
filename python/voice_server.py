"""Sidecar vocal persistant pour Jaris.

Regroupe dans un seul process : écoute continue du micro, détection du mot
d'activation "Jaris" (chaque phrase entendue est transcrite localement, et seul le nom dans le texte
réveille Jaris — voir wake_confirmation.py, étape 179 ; déclenchement manuel via `trigger`/touche "+"
toujours possible) — capture
de l'énoncé qui suit jusqu'au silence, puis transcription (Parakeet v3,
en RAM, étape 158) — directement depuis les échantillons en mémoire, sans
passer par des fichiers WAV intermédiaires.

Léo trouvait le double clap utilisé avant (voir git log) "galère" et
voulait simplement dire "Jaris". Le détecteur openWakeWord utilisé ensuite (licence non commerciale, et « une
fois sur 20 » selon Léo) a été retiré à l'étape 179 au profit de la transcription seule.

Sur stdin, une ligne par commande :
  trigger        déclenche une capture manuellement (touche "+", voir App.tsx)
  test-mic       démarre le test micro (voir mic_test_* ci-dessous) — reste actif jusqu'à stop-mic-test,
                 pas de durée fixe : l'utilisateur active/désactive lui-même depuis Options → Micro
  stop-mic-test  arrête le test micro démarré par test-mic
  test-wake      démarre le test du mot « Jaris » (Options → Voix, étape 180) : chaque phrase entendue est
                 transcrite et renvoyée telle quelle (wake_test_heard), SANS réveiller Jaris — actif jusqu'à
                 stop-test-wake
  stop-test-wake arrête ce test
  pause-wake     arrête d'écouter « Jaris » (Chat, Code, Options : étape 183) — plus aucune phrase transcrite
  resume-wake    reprend l'écoute de « Jaris »

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
  {"event": "wake_test_heard", "text": "...", "matched": true|false, "tooShort": true|false, "peak": 0.0-1.0}

Avec --list-devices : ignore tous les autres arguments, n'ouvre aucun micro et ne charge aucun modèle —
imprime juste {"devices": [{"index": 0, "name": "..."}, ...]} (ou {"error": "..."}) et quitte. Utilisé par
Electron pour peupler la liste des micros dans le menu Options, sans lancer tout le sidecar pour ça.

Avec --wakeword-disabled (Options → Activation, étape 81) : aucune phrase n'est transcrite en attendant le
nom, seul `trigger` (touche "+"/clic sur l'orbe) déclenche une capture.

Lancé par electron/services/voiceClient.ts, jamais directement.
"""

import argparse
import json
import os
import queue
import sys
import threading
from math import gcd

import numpy as np

# Python 3.12 (la série embarquée par Jaris, voir PYTHON_SERIES dans pythonRuntime.ts) choisit l'encodage de
# stdout d'après la PAGE DE CODES Windows quand la sortie est un tube, PAS UTF-8 : sur un Windows français
# ordinaire, "ça" partait donc en cp1252 (un seul octet 0xE7) alors que Node lit toujours de l'UTF-8 —
# chaque caractère accentué arrivait à l'écran en "�". Constaté chez un ami de Léo (Tom), transcription
# affichée telle quelle : "◆a marche pas... Salut Charisse, ◆a va ?" pour "Ça marche pas... ça va ?".
# Invisible sur la machine de Léo (page de codes déjà en UTF-8 chez lui), d'où un bug qui n'apparaît que
# chez quelqu'un d'autre. Forcé ici plutôt que laissé au réglage Windows de chacun : le sidecar écrit
# TOUJOURS de l'UTF-8, quelle que soit la machine. stderr aussi (les diagnostics de debug() sont en français).
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

from wake_confirmation import WakeSegmenter, contains_wake_name, remove_wake_prefix

SAMPLE_RATE = 16000
CHUNK_SAMPLES = 1280  # 80 ms : le pas du découpage des phrases (voir WakeSegmenter, wake_confirmation.py)
SILENCE_RMS_THRESHOLD = 300
SILENCE_DURATION_MS = 900
MIN_UTTERANCE_MS = 400
MAX_UTTERANCE_MS = 12_000

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


def debug(message: str) -> None:
    """Diagnostic pour AJUSTER le code (ex: WAKE_NAME depuis de vraies transcriptions rejetées), jamais pour
    l'utilisateur : contrairement à emit(..., "event": "log"), qui est diffusé jusqu'à l'interface (voir
    voiceClient.ts/voicePipeline.ts/ChatPanel.tsx), ceci n'écrit que sur stderr — capturé par voiceClient.ts
    en simple `console.error('[voice_server]', ...)`, jamais rediffusé au renderer. Séparation ajoutée après
    que Léo a vu "Candidat rejeté (transcription : 'Il est bizarre.')" s'afficher dans le Chat : ce texte
    n'a de sens que pour régler wake_confirmation.py, jamais pour lui.
    """
    print(message, file=sys.stderr, flush=True)


def rms(chunk: np.ndarray) -> float:
    return float(np.sqrt(np.mean(chunk.astype(np.float64) ** 2)))


# Étape 158 (Léo : « enlève le test, et on décale sur Parakeet v3 ») : la transcription passe de Cohere Transcribe
# (2 milliards de paramètres, 3,9 Go sur la carte graphique) à Parakeet TDT 0.6B v3 de NVIDIA, EN RAM. Mesuré sur
# la RTX 3070 de Léo avec le test de l'étape 156 (5 phrases dites par la voix de Jaris) : Parakeet en RAM 0,26 s
# pour 5 s de parole et 4,5 % de mots faux, contre 0,84 s et 9,1 % pour Cohere sur la carte — plus rapide, moins
# d'erreurs, et toute la carte graphique rendue au modèle de conversation (GPU_RESERVED_GB, hardwareScan.ts).
#
# Version ONNX de istupakov (format lu par onnx-asr), tirée des poids officiels de NVIDIA (licence CC-BY-4.0 :
# « Parakeet TDT 0.6B v3 », NVIDIA). Épinglée par identifiant de commit, comme l'était Cohere : un dépôt tiers
# pourrait sinon remplacer les fichiers d'un jour à l'autre et Jaris les téléchargerait sans broncher.
STT_REPO = "istupakov/parakeet-tdt-0.6b-v3-onnx"
STT_REVISION = "8f23f0c03c8761650bdb5b40aaf3e40d2c15f1ce"
STT_MODEL_TYPE = "nemo-parakeet-tdt-0.6b-v3"
# Version non compressée (≈ 2,5 Go, ≈ 2,5 Go de RAM) : mesurée plus juste que la compressée (4,5 % contre 6,8 %
# d'erreurs chez Léo) pour un écart de vitesse négligeable (0,26 s contre 0,22 s).
STT_FILES = ["config.json", "vocab.txt", "nemo128.onnx", "encoder-model.onnx", "encoder-model.onnx.data", "decoder_joint-model.onnx"]

# Ancien modèle (Cohere Transcribe, ~4 Go) : effacé du cache une fois Parakeet chargé — plus rien ne s'en sert.
OLD_STT_CACHE_DIR = "models--evewashere--cohere-transcribe-03-2026-ungated"


def load_parakeet():
    """Télécharge (première fois seulement) et charge Parakeet sur le processeur. Renvoie transcrire(audio)."""
    import onnx_asr
    from huggingface_hub import snapshot_download

    path = snapshot_download(STT_REPO, revision=STT_REVISION, allow_patterns=STT_FILES)
    # CPUExecutionProvider explicite : la transcription reste en RAM et ne prend rien sur la carte graphique,
    # même si une version GPU d'onnxruntime venait un jour à être installée.
    model = onnx_asr.load_model(STT_MODEL_TYPE, path, providers=["CPUExecutionProvider"])

    def transcribe(audio: np.ndarray) -> str:
        return str(model.recognize(audio, sample_rate=SAMPLE_RATE)).strip()

    return transcribe


def remove_old_stt_model() -> None:
    """Rend les ~4 Go de Cohere Transcribe, inutiles depuis l'étape 158. Silencieux si absent ou verrouillé."""
    try:
        import shutil
        from huggingface_hub.constants import HF_HUB_CACHE

        old = os.path.join(HF_HUB_CACHE, OLD_STT_CACHE_DIR)
        if os.path.isdir(old):
            shutil.rmtree(old, ignore_errors=True)
    except Exception:
        pass


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-device", type=int, default=None)
    parser.add_argument("--list-devices", action="store_true")
    # Options → Activation (étape 81) : quand Léo préfère la touche "+"/le clic sur l'orbe, aucune raison de
    # transcrire chaque phrase entendue en attendant le nom.
    parser.add_argument("--wakeword-disabled", action="store_true")
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
    except (ImportError, OSError) as exc:
        emit({"event": "fatal", "message": f"dépendance Python manquante ou inutilisable ({exc}). Lance : pip install -r python/requirements.txt"})
        sys.exit(1)

    emit({"event": "log", "message": "Chargement de la transcription (Parakeet v3 : ~2,5 Go à télécharger au premier lancement, peut prendre plusieurs minutes)…"})
    try:
        transcribe = load_parakeet()
    except Exception as exc:
        emit({"event": "fatal", "message": f"échec de chargement de la transcription (Parakeet v3) : {exc}"})
        sys.exit(1)
    remove_old_stt_model()

    audio_queue: "queue.Queue[np.ndarray]" = queue.Queue()

    def make_audio_callback(native_rate: int):
        """Le reste du pipeline (détection du mot d'activation, transcription) suppose du 16 kHz partout : si
        le micro ne peut être ouvert qu'à un autre débit (voir la retombée plus bas), ré-échantillonner ici,
        une seule fois à l'entrée, plutôt que de complexifier tout le reste en aval."""
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
            # scipy.signal.resample_poly sur un tableau int16 renvoie SILENCIEUSEMENT du silence total
            # (aucune erreur, aucun avertissement) : sa filtration polyphase interne suppose une entrée en
            # virgule flottante, un tableau entier y donne un résultat nul quel que soit le ratio ou le
            # contenu (vérifié : ton pur ET bruit aléatoire donnent 0 en int16, un résultat correct en
            # float64) — jamais détecté avant faute d'accès à un micro qui déclenche vraiment cette
            # retombée (débit natif ≠ 16 kHz) en usage réel. Convertir en float AVANT le ré-échantillonnage
            # corrige ça.
            resampled = scipy.signal.resample_poly(indata[:, 0].astype(np.float64), up, down)
            audio_queue.put(np.clip(resampled, -32768, 32767).astype(np.int16))

        return on_audio

    manual_trigger = threading.Event()
    mic_test_start_requested = threading.Event()
    mic_test_stop_requested = threading.Event()
    wake_test_on = threading.Event()
    wake_paused = threading.Event()

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
            elif line == "test-wake":
                wake_test_on.set()
            elif line == "stop-test-wake":
                wake_test_on.clear()
            elif line == "pause-wake":
                wake_paused.set()
            elif line == "resume-wake":
                wake_paused.clear()

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

    # Étape 179 : plus de détecteur à charger — le mot d'activation passe par la transcription déjà chargée.
    listen_for_name = not args.wakeword_disabled

    emit({"event": "ready"})

    segmenter = WakeSegmenter()
    voice_activated = False
    mode = "wake"  # "wake" | "capture"
    capture_chunks: list[np.ndarray] = []
    silent_ms = 0.0
    captured_ms = 0.0
    loud_ms = 0.0  # temps effectivement au-dessus du seuil de silence (≠ captured_ms, qui inclut le silence de fin qui a déclenché la coupure)

    mic_test_active = False
    mic_test_detected = False

    while True:
        chunk = audio_queue.get()
        chunk_ms = (len(chunk) / SAMPLE_RATE) * 1000

        # Lit le même flux que la détection de déclenchement, sans jamais interagir avec `mode` : le test
        # micro tourne "à côté" (voir docstring en tête de fichier), pas à la place du mot d'activation.
        # Pas de durée fixe : reste actif jusqu'à stop-mic-test, l'utilisateur active/désactive lui-même depuis
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

            # Étape 179 : chaque phrase entendue est transcrite, et seul le NOM dans le texte réveille Jaris.
            # Rien n'est envoyé ni affiché quand le nom n'y est pas : la transcription reste dans ce process.
            confirmed_audio = None
            trailing_silence_ms = 0.0
            if triggered:
                segmenter.clear()
                voice_activated = False
            elif wake_test_on.is_set():
                # Étape 180 (Léo : « ça marche 1 fois sur 3 ») : Léo, et lui seul, a demandé ce test depuis
                # Options — ce qui a été compris est donc renvoyé tel quel, pour savoir POURQUOI ça rate (son
                # trop faible ? mot mal compris ?) au lieu de deviner. Jaris ne se réveille jamais pendant ce test.
                segment = segmenter.push(chunk, rms(chunk) >= SILENCE_RMS_THRESHOLD)
                heard_audio = segment if segment is not None else segmenter.dropped
                if heard_audio is not None:
                    segmenter.dropped = None
                    peak = min(1.0, max(rms(part) for part in heard_audio) / MIC_TEST_LEVEL_DIVISOR)
                    text = ""
                    if segment is not None:
                        try:
                            text = transcribe(np.concatenate(segment).astype(np.float32) / 32768.0)
                        except Exception as exc:
                            emit({"event": "log", "message": f"Test du mot Jaris : transcription impossible ({exc})"})
                    emit({
                        "event": "wake_test_heard",
                        "text": text,
                        "matched": bool(text) and contains_wake_name(text),
                        "tooShort": segment is None,
                        "peak": round(peak, 3),
                    })
            elif wake_paused.is_set():
                # Étape 183 : hors du mode Agent vocal, rien n'est transcrit ; une phrase commencée est oubliée.
                segmenter.clear()
            elif listen_for_name:
                segment = segmenter.push(chunk, rms(chunk) >= SILENCE_RMS_THRESHOLD)
                if segment is not None:
                    audio = np.concatenate(segment).astype(np.float32) / 32768.0
                    try:
                        heard = transcribe(audio)
                        if contains_wake_name(heard):
                            triggered = True
                            voice_activated = True
                            confirmed_audio = segment
                            # « Jaris, ouvre YouTube » d'une traite : la demande est déjà là, le silence entendu
                            # après compte. « Jaris » seul : Léo attend souvent de voir l'orbe réagir avant de
                            # parler — le délai de silence repart de zéro pour lui laisser ce temps.
                            if remove_wake_prefix(heard).strip():
                                trailing_silence_ms = segmenter.trailing_silence_chunks * chunk_ms
                            segmenter.clear()
                    except Exception as exc:
                        # Une vérification échouée ne donne jamais une activation par défaut.
                        emit({"event": "log", "message": f"Écoute du mot Jaris impossible : {exc}"})

            if triggered:
                mode = "capture"
                # La phrase qui contenait le nom est gardée (« Jaris, ouvre YouTube » d'une traite), et le silence
                # déjà entendu après elle compte : si la demande était dans la même phrase, pas d'attente en plus.
                capture_chunks = confirmed_audio or []
                silent_ms = trailing_silence_ms
                captured_ms = len(capture_chunks) * chunk_ms
                loud_ms = sum(chunk_ms for part in capture_chunks if rms(part) >= SILENCE_RMS_THRESHOLD)
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
            text = transcribe(audio)
            if voice_activated:
                text = remove_wake_prefix(text)
            if is_hallucination(text):
                text = ""
            emit({"event": "transcript", "text": text})
        except Exception as exc:
            emit({"event": "error", "message": str(exc)})


if __name__ == "__main__":
    main()
