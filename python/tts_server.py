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

# Même piège que voice_server.py (voir son commentaire détaillé) : sur Python 3.12, stdout vers un tube prend
# la page de codes Windows et non UTF-8, donc tout accent ressortait en "�" côté Node. Les messages d'erreur
# de ce sidecar sont en français, et le texte à synthétiser lui-même revient parfois dans un message : le
# forcer en UTF-8 ici aussi, jamais laissé au réglage Windows de la machine.
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")
# stdin aussi (étape 214, reproduit) : le texte à prononcer arrive en UTF-8 depuis Node ; lu avec la page de
# codes Windows (cp1252), « Ça va, Léo ? » devenait « Ã‡a va, LÃ©o ? » — prononcé tel quel par la voix.
sys.stdin.reconfigure(encoding="utf-8")


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def real_model_dir(default_dir: str) -> str | None:
    """Étape 513 (journal de Léo, version Store : « Failed to download model from Supertone/supertonic-3 … Cannot call
    rmtree on a symbolic link ») : Jaris range le modèle de la voix ailleurs par une jonction (~/.cache/supertonic3 ->
    son dossier de données, étape 155). Supertonic 1.3.1 (loader.download_model) télécharge dans un dossier temporaire
    voisin, puis EFFACE le dossier du modèle par shutil.rmtree avant de mettre le nouveau à sa place — et Python
    (3.12+) refuse rmtree sur un lien ou une jonction : le téléchargement échouait à chaque démarrage, la voix ne
    marchait jamais sur une installation neuve. On donne donc à Supertonic le VRAI dossier (cible de la jonction) :
    mêmes fichiers, rien de retéléchargé, et un rmtree permis. `None` quand le dossier n'est pas un lien."""
    real = os.path.realpath(default_dir)
    if os.path.normcase(real) == os.path.normcase(os.path.abspath(default_dir)):
        return None
    return real


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
        from supertonic.config import DEFAULT_MODEL, get_model_cache_dir

        tts = TTS(model_dir=real_model_dir(str(get_model_cache_dir(DEFAULT_MODEL))), auto_download=True)
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

            # Étape 293 (24 langues) : la langue vient de chaque demande (celle choisie dans Jaris), --language
            # n'est plus qu'un repli pour une demande qui n'en donne pas.
            wav, _duration = tts.synthesize(
                text=text,
                lang=request.get("lang") or args.language,
                voice_style=voice_styles[voice],
                # 8 -> 12 (borne haute recommandée par Supertonic) : Léo a comparé les 3 échantillons
                # (niveaux 1/5/12 générés et envoyés en usage réel) et préféré 12, malgré le coût mesuré
                # pour de vrai (~35-40% de temps de synthèse en plus, ~0,5s de plus par réponse sur une
                # machine de test) — pas de VRAM/GPU supplémentaire nécessaire, seulement un peu plus de
                # calcul CPU à chaque réponse.
                total_steps=12,
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
