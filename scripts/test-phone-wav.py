"""Étape 214 : lecture des messages vocaux du téléphone par voice_server.py, sans micro ni modèle.

La page du téléphone convertit l'enregistrement en WAV PCM 16 bits mono 16 kHz ; le sidecar le relit pour la
transcription. Tout autre format doit être refusé clairement, jamais transcrit de travers.
"""
import json
import os
import struct
import sys
import tempfile
import wave
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
import voice_server as vs  # noqa: E402

folder = tempfile.mkdtemp()
path = os.path.join(folder, "message vocal Léo.wav")

with wave.open(path, "wb") as w:
    w.setnchannels(1)
    w.setsampwidth(2)
    w.setframerate(16000)
    w.writeframes(struct.pack("<4h", 0, 16384, -16384, 32767))
audio = vs.read_wav_16k_mono(path)
assert str(audio.dtype) == "float32", audio.dtype
assert audio.tolist() == [0.0, 0.5, -0.5, 32767 / 32768], audio.tolist()

for channels, rate in [(2, 16000), (1, 44100)]:
    with wave.open(path, "wb") as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\0" * 8)
    try:
        vs.read_wav_16k_mono(path)
    except ValueError:
        pass
    else:
        raise AssertionError(f"format {channels} voie(s) / {rate} Hz accepté à tort")

# La commande envoyée par Node : un chemin avec accents et espaces doit ressortir intact.
command = "transcribe-file " + json.dumps({"id": "x1", "path": path}, ensure_ascii=False)
request = json.loads(command[len("transcribe-file "):])
assert request == {"id": "x1", "path": path}

print("Messages vocaux du téléphone : WAV 16 kHz mono lu, autres formats refusés.")
