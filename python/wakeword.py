"""Détection du mot d'activation "Jaris" en flux continu, à partir d'un modèle openWakeWord dédié
(voir scripts/train_jaris_wakeword.py pour l'entraînement, jamais exécuté par l'appli elle-même).

Réimplémentation MINIMALE (numpy + onnxruntime seulement, déjà une dépendance de Supertonic — voir
requirements.txt) du pipeline de `openwakeword.utils.AudioFeatures` (Apache-2.0, réimplémentation autorisée
par la licence — même logique que la copie non protégée du modèle Cohere Transcribe, voir voice_server.py) :
le paquet PyPI `openwakeword` lui-même ne peut PAS être installé sur Windows/Python récent, sa dépendance
`tflite-runtime` n'a aucune roue disponible pour ce couple plateforme/version (vérifié sur PyPI). Trois
modèles ONNX (melspectrogram.onnx, embedding_model.onnx : partagés par tous les modèles openWakeWord,
génériques, pas spécifiques à "Jaris" ; jaris.onnx : le classifieur entraîné pour ce mot précis) sont commités
directement dans python/models/ (quelques Mo au total) plutôt que téléchargés au premier lancement : pas de
dépendance réseau ni de service tiers pour une détection qui doit rester 100% locale.

Les trois modèles attendent des chunks de 1280 échantillons (80 ms @ 16 kHz) exactement, comme déjà utilisé
par CHUNK_SAMPLES dans voice_server.py : `process_chunk()` ci-dessous suppose cet appel régulier, pas une
API générique multi-tailles comme l'originale.
"""

import os
from collections import deque

import numpy as np
import onnxruntime as ort

MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")

SAMPLE_RATE = 16000
CHUNK_SAMPLES = 1280  # doit rester identique à voice_server.py : le pipeline suppose ce pas fixe
MELSPEC_HISTORY_SAMPLES = CHUNK_SAMPLES + 160 * 3  # fenêtre glissante donnée au modèle de melspectrogramme
MELSPEC_WINDOW_FRAMES = 76  # nombre de frames de melspectrogramme consommées par le modèle d'embedding
MELSPEC_BUFFER_MAX_FRAMES = 970  # ~10 s d'historique de melspectrogramme (10 * 97 frames/s), comme l'original


class JarisWakeWordDetector:
    """Détecteur à état, un chunk de 1280 échantillons à la fois (voir process_chunk)."""

    def __init__(self, threshold: float = 0.995, debounce_chunks: int = 15, minimum_rms: float = 300):
        sess_options = ort.SessionOptions()
        sess_options.inter_op_num_threads = 1
        sess_options.intra_op_num_threads = 1
        providers = ["CPUExecutionProvider"]

        self._melspec_session = ort.InferenceSession(
            os.path.join(MODELS_DIR, "melspectrogram.onnx"), sess_options=sess_options, providers=providers
        )
        self._embedding_session = ort.InferenceSession(
            os.path.join(MODELS_DIR, "embedding_model.onnx"), sess_options=sess_options, providers=providers
        )
        self._classifier_session = ort.InferenceSession(
            os.path.join(MODELS_DIR, "jaris.onnx"), sess_options=sess_options, providers=providers
        )
        self._classifier_input_name = self._classifier_session.get_inputs()[0].name
        # Nombre de frames d'embedding attendues par le classifieur (dépend de la durée des clips
        # d'entraînement, voir scripts/train_jaris_wakeword.py) : lu dans le modèle plutôt que codé en dur,
        # pour ne jamais désynchroniser wakeword.py d'un futur ré-entraînement avec une durée différente.
        self._n_feature_frames = self._classifier_session.get_inputs()[0].shape[1]
        self._feature_buffer_max_frames = self._n_feature_frames * 2

        # Le classifieur peut donner un score élevé au silence. Exiger un signal audible
        # récent, au même seuil que la capture de parole, sans couper la fin du mot.
        self.minimum_rms = minimum_rms
        self._recent_rms = deque(maxlen=self._n_feature_frames)
        self.threshold = threshold
        # Ignore les nouveaux déclenchements pendant ce nombre de chunks après un premier déclenchement :
        # une seule prononciation de "Jaris" peut faire dépasser le seuil sur plusieurs chunks consécutifs
        # (comme le double clap ne comptait qu'UN déclenchement pour deux pics rapprochés).
        self.debounce_chunks = debounce_chunks
        self._chunks_since_trigger = debounce_chunks  # autorise un déclenchement dès le premier chunk utile

        self._raw_buffer: deque = deque(maxlen=SAMPLE_RATE * 10)
        self._melspec_buffer = np.ones((MELSPEC_WINDOW_FRAMES, 32), dtype=np.float32)
        self._feature_buffer = np.zeros((1, 96), dtype=np.float32)  # remplacé dès le premier chunk réel

    def _melspectrogram(self, samples: np.ndarray) -> np.ndarray:
        x = samples.astype(np.float32)[None, :]
        spec = self._melspec_session.run(None, {"input": x})[0]
        spec = np.squeeze(spec)
        return spec / 10 + 2  # transform empirique d'openwakeword pour rapprocher l'onnx du modèle TF d'origine

    def _embed(self, melspec_window: np.ndarray) -> np.ndarray:
        batch = melspec_window[None, :, :, None].astype(np.float32)
        return self._embedding_session.run(None, {"input_1": batch})[0].squeeze()

    def process_chunk(self, chunk: np.ndarray) -> float:
        """Traite un chunk de 1280 échantillons int16, renvoie le score de détection (0-1) de ce chunk."""
        self._recent_rms.append(float(np.sqrt(np.mean(chunk.astype(np.float64) ** 2))))
        self._raw_buffer.extend(chunk.tolist())

        recent = np.array(list(self._raw_buffer)[-MELSPEC_HISTORY_SAMPLES:], dtype=np.int16)
        new_melspec_rows = self._melspectrogram(recent)
        self._melspec_buffer = np.vstack((self._melspec_buffer, new_melspec_rows))
        if self._melspec_buffer.shape[0] > MELSPEC_BUFFER_MAX_FRAMES:
            self._melspec_buffer = self._melspec_buffer[-MELSPEC_BUFFER_MAX_FRAMES:]

        if self._melspec_buffer.shape[0] < MELSPEC_WINDOW_FRAMES:
            return 0.0  # pas encore assez d'historique (tout début de l'écoute)

        embedding = self._embed(self._melspec_buffer[-MELSPEC_WINDOW_FRAMES:])
        self._feature_buffer = np.vstack((self._feature_buffer, embedding[None, :]))
        if self._feature_buffer.shape[0] > self._feature_buffer_max_frames:
            self._feature_buffer = self._feature_buffer[-self._feature_buffer_max_frames:]

        features = self._feature_buffer[-self._n_feature_frames:][None, :, :].astype(np.float32)
        if features.shape[1] < self._n_feature_frames:
            return 0.0

        score = float(self._classifier_session.run(None, {self._classifier_input_name: features})[0].squeeze())

        self._chunks_since_trigger += 1
        return score

    def should_trigger(self, score: float) -> bool:
        """À appeler avec le score renvoyé par process_chunk(). Applique le seuil + le anti-rebond."""
        audible = bool(self._recent_rms) and max(self._recent_rms) >= self.minimum_rms
        if audible and score >= self.threshold and self._chunks_since_trigger >= self.debounce_chunks:
            self._chunks_since_trigger = 0
            return True
        return False
