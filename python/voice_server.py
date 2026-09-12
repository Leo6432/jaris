"""Sidecar vocal persistant pour Jaris.

Regroupe dans un seul process : écoute continue du micro, détection du mot
d'activation "Jaris" (modèle openWakeWord dédié, entraîné spécifiquement
pour ce mot — voir wakeword.py et scripts/train_jaris_wakeword.py ;
déclenchement manuel via `trigger`/touche "+" toujours possible) — capture
de l'énoncé qui suit jusqu'au silence, puis transcription (Cohere
Transcribe) — directement depuis les échantillons en mémoire, sans passer
par des fichiers WAV intermédiaires.

Léo trouvait le double clap utilisé avant (voir git log) "galère" et
voulait simplement dire "Jaris" — remplacé ici par un modèle dédié plutôt
que par le mot "Hey Jarvis" (anglais) qu'imposait openWakeWord avant son
retrait initial, faute de mot-clé "Jaris" pré-entraîné.

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
from math import gcd

import numpy as np

from wakeword import JarisWakeWordDetector

SAMPLE_RATE = 16000
CHUNK_SAMPLES = 1280  # 80 ms : le pas fixe attendu par JarisWakeWordDetector (voir wakeword.py)
SILENCE_RMS_THRESHOLD = 300
SILENCE_DURATION_MS = 900
MIN_UTTERANCE_MS = 400
MAX_UTTERANCE_MS = 12_000

# Plus bas que SILENCE_RMS_THRESHOLD : le test micro veut juste détecter un signal (souffle, voix, tape sur
# le micro), pas exiger une vraie parole comme la capture d'énoncé.
MIC_TEST_RMS_THRESHOLD = 150
# Normalise le RMS en 0..1 pour la jauge de la UI (empirique : une voix normale dépasse largement ce seuil).
MIC_TEST_LEVEL_DIVISOR = 3000.0

# Seuil de détection du mot d'activation "Jaris" (score du modèle, 0-1) et anti-rebond (en nombre de chunks
# de 80 ms) — voir wakeword.py et scripts/train_jaris_wakeword.py pour comment ce modèle a été entraîné et
# évalué. 0.995 (pas 0.5, le seuil "par défaut" d'un classifieur binaire) choisi après un vrai test sur des
# phrases JAMAIS vues à l'entraînement : à 0.5, "Paris", "chariot" ou une phrase quelconque contenant "a ri"
# déclenchaient parfois Jaris par erreur. À 0.995, tout ce qui a été testé fonctionne SAUF deux confusions
# phonétiques réellement difficiles ("Jarvis", l'ancien nom, et une phrase contenant "a ri" comme "il a ri
# très fort") qui restent élevées (score > 0.99) même après un corpus négatif volontairement élargi sur ces
# cas précis — un rappel de 97,2% sur nos propres échantillons de test à ce seuil, contre 87-88% à un seuil
# encore plus strict qui n'aurait pas réglé ces deux confusions de toute façon (leur score dépasse déjà
# 0.99). Ces deux mots restent un vrai risque de faux déclenchement connu, pas un compromis choisi à
# l'aveugle : voir CLAUDE.md pour le détail des mesures.
WAKEWORD_THRESHOLD = 0.995
WAKEWORD_DEBOUNCE_CHUNKS = 15  # ~1,2s : couvre la durée d'un "Jaris" dit une fois, sans bloquer trop longtemps après

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


# Copie non protégée du modèle de transcription officiel (CohereLabs/cohere-transcribe-03-2026), dont
# l'accès demande un compte Hugging Face et l'acceptation de conditions en ligne. Ce compte est exactement
# ce que l'étape 16 du roadmap interdit ("aucun compte Hugging Face à créer, même pour un débutant
# complet") : sans ça, la reconnaissance vocale ne démarre tout simplement pas sur une machine fraîchement
# installée.
#
# Ce ne sont pas d'autres poids, ni une version allégée : le fichier model.safetensors de cette copie a
# exactement la même empreinte SHA256 que l'officiel (987bd3e141c7bfdb5a78f5db11397ee7737308357e6cc0a3f36a4979b158137a,
# 4 131 862 976 octets), vérifié via l'API Hugging Face. La licence Apache 2.0 du modèle autorise
# explicitement cette redistribution.
DEFAULT_STT_MODEL = "evewashere/cohere-transcribe-03-2026-ungated"

# Version exacte (identifiant de commit) plutôt que la dernière en date : un dépôt tiers pourrait sinon
# remplacer les poids par n'importe quoi d'un jour à l'autre, et Jaris le téléchargerait sans broncher.
# Un identifiant de commit, lui, est immuable — c'est ce qui rend l'usage d'une copie tierce sûr.
DEFAULT_STT_REVISION = "29b9036c65620e1a148127c6147543b52358da6a"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stt-model", default=DEFAULT_STT_MODEL)
    parser.add_argument("--stt-revision", default=DEFAULT_STT_REVISION)
    # "auto" plutôt que "cpu" : c'est torch, une fois chargé, qui sait si une carte graphique est
    # réellement utilisable (voir plus bas). Un défaut "cpu" ferait tourner la transcription sur le
    # processeur sur une machine équipée d'un GPU — des secondes au lieu d'une fraction de seconde.
    parser.add_argument("--stt-device", default="auto")
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
        # Résolu ici et pas plus tôt : seul torch peut dire si CUDA est vraiment disponible (carte
        # présente ET pilote compatible ET version GPU de torch installée — voir pythonRuntime.ts, qui
        # installe la version GPU quand une carte NVIDIA est détectée, mais retombe sur la version
        # processeur si cette installation échoue).
        stt_device = args.stt_device
        if stt_device == "auto":
            stt_device = "cuda" if torch.cuda.is_available() else "cpu"
            emit({"event": "log", "message": f"Transcription sur {stt_device}."})
        stt_dtype = torch.float16 if stt_device == "cuda" else torch.float32
        # La révision n'est épinglée que pour le modèle par défaut : un modèle choisi explicitement par
        # l'utilisateur (STT_MODEL du .env) n'a évidemment pas les mêmes identifiants de commit.
        revision = args.stt_revision if args.stt_model == DEFAULT_STT_MODEL else None
        stt_processor = AutoProcessor.from_pretrained(args.stt_model, revision=revision)
        stt_model = CohereAsrForConditionalGeneration.from_pretrained(
            args.stt_model, revision=revision, dtype=stt_dtype, device_map=stt_device
        )
    except Exception as exc:
        hint = (
            f" Le modèle '{args.stt_model}' est protégé ('gated') : accepte les conditions sur "
            f"https://huggingface.co/{args.stt_model} puis lance `hf auth login`, ou laisse STT_MODEL "
            f"vide dans le .env pour utiliser le modèle par défaut, qui lui ne demande aucun compte."
            if "gated" in str(exc).lower() or "401" in str(exc) or "access" in str(exc).lower()
            else ""
        )
        emit({"event": "fatal", "message": f"échec de chargement de la transcription '{args.stt_model}': {exc}.{hint}"})
        sys.exit(1)

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
            # corrige ça : c'est déjà le format attendu par les modèles ONNX de melspectrogramme en aval.
            resampled = scipy.signal.resample_poly(indata[:, 0].astype(np.float64), up, down)
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

    try:
        detector = JarisWakeWordDetector(threshold=WAKEWORD_THRESHOLD, debounce_chunks=WAKEWORD_DEBOUNCE_CHUNKS, minimum_rms=SILENCE_RMS_THRESHOLD)
    except Exception as exc:
        stream.stop()
        stream.close()
        emit({"event": "fatal", "message": f"impossible de charger le détecteur du mot Jaris : {exc}"})
        sys.exit(1)

    emit({"event": "ready"})

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

            # Toujours nourri, même si `triggered` est déjà vrai (touche "+") : sinon les tampons internes
            # du détecteur (voir wakeword.py) accumuleraient un trou dès qu'un déclenchement manuel survient.
            score = detector.process_chunk(chunk)
            # Diagnostic (même esprit que le "Pic candidat" du double clap) : un score qui approche le seuil
            # sans le dépasser aide à ajuster WAKEWORD_THRESHOLD à partir de vraies mesures plutôt qu'à
            # l'aveugle, sans noyer les logs sur du bruit de fond ordinaire (score proche de 0 en permanence).
            if score >= WAKEWORD_THRESHOLD * 0.6:
                emit({"event": "log", "message": f"Score mot d'activation : {score:.2f} (seuil {WAKEWORD_THRESHOLD:.2f})."})
            if not triggered and detector.should_trigger(score):
                triggered = True
                emit({"event": "log", "message": f"Mot d'activation détecté (score {score:.2f})."})

            if triggered:
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
