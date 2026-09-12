"""Vérifie le vrai détecteur depuis un dossier de ressources empaquetées, sans micro."""
import math
from pathlib import Path
import sys
import numpy as np

resources = Path(sys.argv[1]).resolve()
for name in ('melspectrogram.onnx', 'embedding_model.onnx', 'jaris.onnx'):
    model = resources / 'models' / name
    if not model.is_file() or model.stat().st_size < 1000:
        raise RuntimeError(f'Modèle vocal absent ou vide : {model}')
sys.path.insert(0, str(resources))
from wakeword import JarisWakeWordDetector
from wake_confirmation import WakeConfirmation, contains_wake_name
assert not contains_wake_name("Voici la météo à Paris.")
assert contains_wake_name("Jaris, bonjour.")

detector = JarisWakeWordDetector()
for _ in range(50):
    score = detector.process_chunk(np.zeros(1280, dtype=np.int16))
    assert math.isfinite(score) and 0 <= score <= 1, score
    assert not detector.should_trigger(score), f'Déclenchement sur silence : {score}'
rng = np.random.default_rng(42)
for _ in range(50):
    chunk = rng.integers(-40, 41, 1280, dtype=np.int16)
    score = detector.process_chunk(chunk)
    assert not detector.should_trigger(score), f'Déclenchement sur bruit faible : {score}'
print('Trois modèles empaquetés chargés et 4 secondes de silence traitées sans déclenchement.')
