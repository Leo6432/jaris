"""Télécharge une seule fois les modèles openWakeWord (mot-clé + features)
dans models/wakeword/, à côté du reste du projet. À lancer manuellement :

    python python/download_wakeword_models.py
"""

from pathlib import Path

from openwakeword.utils import download_models

TARGET_DIR = Path(__file__).resolve().parent.parent / "models" / "wakeword"

if __name__ == "__main__":
    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    download_models(model_names=["hey_jarvis"], target_directory=str(TARGET_DIR))
    print(f"Modèles téléchargés dans {TARGET_DIR}")
