"""Sidecar de synthèse vocale persistant pour Jaris (Kokoro-82M).

Charge le modèle une seule fois au démarrage, puis synthétise à la demande :
une ligne JSON sur stdin = une synthèse, ex: {"text": "..."}. Écrit le WAV
dans un fichier temporaire et répond par une ligne JSON sur stdout :
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

# Kokoro ne propose qu'UNE seule voix par langue en dehors de l'anglais (voir VOICES.md du modèle,
# huggingface.co/hexgrad/Kokoro-82M) : pas de choix à faire, contrairement à Supertonic HD qui en
# proposait 10 (M1-M5/F1-F5, retirés du menu Options avec ce changement). Le français passe par le
# repli espeak-ng de Kokoro (pas de G2P dédié comme l'anglais/japonais/mandarin) : espeakng-loader
# fournit le binaire espeak-ng directement dans le paquet pip, sans installation système séparée à
# demander à l'utilisateur (règle de l'étape 16 : rien à installer à la main).
KOKORO_LANG_CODES = {"fr": "f", "en": "a"}
KOKORO_VOICES = {"fr": "ff_siwis", "en": "af_heart"}
SAMPLE_RATE = 24000


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--language", default="fr")
    args = parser.parse_args()

    try:
        import numpy as np
        import soundfile as sf
        import espeakng_loader
        from phonemizer.backend.espeak.wrapper import EspeakWrapper

        EspeakWrapper.set_library(espeakng_loader.get_library_path())
        EspeakWrapper.set_data_path(espeakng_loader.get_data_path())

        from kokoro import KPipeline
    except ImportError as exc:
        emit({"event": "fatal", "message": f"dépendance Python manquante ({exc}). Lance : pip install -r python/requirements.txt"})
        sys.exit(1)

    lang_code = KOKORO_LANG_CODES.get(args.language, "f")
    voice = KOKORO_VOICES.get(args.language, "ff_siwis")

    try:
        # device="cpu" explicite : Kokoro tourne très bien sans GPU (quelques centaines de ms par
        # phrase), et le budget VRAM de Jaris (STT_RESERVED_GB, hardwareScan.ts) ne réserve de la place
        # QUE pour le sidecar STT (Cohere Transcribe) — laisser Kokoro choisir seul son device aurait pu
        # lui faire prendre le GPU par défaut et dépasser silencieusement ce budget déjà calculé.
        pipeline = KPipeline(lang_code=lang_code, repo_id="hexgrad/Kokoro-82M", device="cpu")
    except Exception as exc:
        emit({"event": "fatal", "message": f"échec de chargement de Kokoro : {exc}"})
        sys.exit(1)

    emit({"event": "ready"})

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
            text = request["text"]

            # pipeline() renvoie un générateur (un item par phrase découpée en interne) : jamais de
            # synthèse tant qu'on ne l'a pas parcouru, contrairement à l'API synchrone de Supertonic.
            chunks = [audio for _gs, _ps, audio in pipeline(text, voice=voice)]
            wav = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)

            fd, path = tempfile.mkstemp(suffix=".wav", prefix="jaris-tts-")
            os.close(fd)
            sf.write(path, wav, SAMPLE_RATE)
            emit({"event": "speech", "path": path})
        except Exception as exc:
            emit({"event": "error", "message": str(exc)})


if __name__ == "__main__":
    main()
