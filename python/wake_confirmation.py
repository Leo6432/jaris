"""Confirmation du nom par transcription locale avant toute activation vocale."""
from collections import deque
import re
import numpy as np

# Un test réel (25 échantillons TTS "Jaris" synthétiques transcrits par Cohere Transcribe, voir
# scripts/test-wake-confirmation.py) a révélé qu'une liste de graphies exactes ratait 33-40% des vraies
# activations : Cohere transcrit "Jaris" de façon très variable ("Jaris", "Jarisse", "Jarissa", "Jariste",
# "Jarisses", "Jarice"...). Le point commun à TOUTES ces graphies observées n'est pas "jaris" (qui rate
# "Jarice", déjà vu par Codex dans le premier essai) mais le préfixe "jari" seul, suivi de n'importe quelle
# terminaison — motif GÉNÉRALISANT plutôt qu'une énumération figée qu'il aurait fallu réenrichir à chaque
# nouvelle graphie découverte, même leçon que PROMISE_WITHOUT_ACTION dans assistant.ts (détecter le PATRON
# plutôt qu'un mot précis). Reste volontairement strict sur le PRÉFIXE lui-même : "jarvis" (préfixe "jarv")
# et "j'arrive"/"j'arrise" (préfixe "arriv"/"arris", pas "jari") ne matchent jamais — la confusion réelle et
# fréquente avec "j'arrive" (un vrai mot français très courant) n'est PAS ajoutée à la liste acceptée,
# risque trop élevé de fausse activation sur une phrase innocente ("j'arrive dans 5 minutes").
WAKE_NAME = re.compile(r'\bjari\w*\b', re.IGNORECASE)


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
