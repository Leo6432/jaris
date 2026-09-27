"""Vérifie le dossier Python réellement empaqueté (étape 179), sans micro ni modèle.

Le mot « Jaris » passe désormais par la transcription : plus aucun modèle openWakeWord (licence non commerciale)
ne doit être livré, et le découpage des phrases doit s'importer depuis les ressources empaquetées.
"""
from pathlib import Path
import sys

resources = Path(sys.argv[1]).resolve()
for name in ('voice_server.py', 'wake_confirmation.py', 'tts_server.py', 'requirements.txt'):
    if not (resources / name).is_file():
        raise RuntimeError(f'Fichier absent de l’installeur : {resources / name}')
leftovers = sorted(p.name for p in resources.rglob('*.onnx'))
if leftovers:
    raise RuntimeError(f'Modèles non commerciaux encore livrés : {leftovers}')
if (resources / 'wakeword.py').exists():
    raise RuntimeError('wakeword.py (ancien détecteur) encore livré')
sys.path.insert(0, str(resources))
from wake_confirmation import WakeSegmenter, contains_wake_name
assert contains_wake_name('Jaris, bonjour.') and not contains_wake_name('Voici la météo à Paris.')
WakeSegmenter()
print('Écoute du mot Jaris par transcription : fichiers présents, aucun ancien modèle livré.')
