"""Confirmation du nom par transcription locale avant toute activation vocale."""
from collections import deque
import re
import numpy as np

# Graphies observées avec Cohere sur les voix de test françaises. Aucun rapprochement
# flou : Paris, Jarvis et les sous-chaînes dans d'autres mots ne sont pas acceptés.
WAKE_NAME = re.compile(r'\b(?:jaris|jarice|jarisse)\b', re.IGNORECASE)


def contains_wake_name(text: str) -> bool:
    return WAKE_NAME.search(text) is not None


def remove_wake_prefix(text: str) -> str:
    match = WAKE_NAME.search(text)
    return text[match.end():].lstrip(' ,.!?:;—-') if match else text


class WakeConfirmation:
    """Mémoire bornée de 3 s ; attend 640 ms après le candidat pour finir le mot."""
    def __init__(self):
        self.history = deque(maxlen=38)
        self.remaining = None
        self.cooldown = 0

    def clear(self):
        self.history.clear()
        self.remaining = None
        self.cooldown = 0

    def push(self, chunk: np.ndarray, candidate: bool):
        self.history.append(chunk.copy())
        if self.remaining is not None:
            self.remaining -= 1
            if self.remaining == 0:
                self.remaining = None
                self.cooldown = 38
                return list(self.history)
        elif self.cooldown:
            self.cooldown -= 1
        elif candidate:
            self.remaining = 8
        return None
