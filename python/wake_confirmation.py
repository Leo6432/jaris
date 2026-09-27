"""Mot d'activation « Jaris » par transcription locale (étape 179).

Avant : un détecteur openWakeWord (modèles sous licence NON commerciale CC BY-NC-SA 4.0, entraîné sur des voix de
synthèse, seuil 0,995) proposait un candidat, puis la transcription le confirmait. Léo : « le hey Jaris marche une
fois sur 20 ». Le goulot le plus probable (déduit, pas mesuré sur sa voix) : le détecteur, strict et entraîné sur
des voix de synthèse — alors que sur 50 « Jaris » (voix de synthèse, étape 158), Parakeet v3 écrivait un nom
reconnu par WAKE_NAME 46 fois. Le détecteur est donc
supprimé : chaque phrase entendue est découpée par WakeSegmenter puis transcrite localement, et seul le NOM dans la
transcription réveille Jaris. Plus aucun modèle non commercial, un filtre en moins.
"""
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
#
# Étape 158 : avec Parakeet v3 (qui remplace Cohere), mesuré sur 50 échantillons « Jaris » (10 voix, 5 tournures) :
# « Jaris » 21 fois, « Jarry » 16, « Jarris » 3, « Dijaris » 2 (« Dis Jaris » collé), « j'arrive » 2, « Jerry » 1…
# L'ancien motif n'en reconnaissait que 24 sur 50. Élargi au PATRON observé — « jar », un « r » doublé ou non,
# puis « i » ou « y » — plus le « di » collé de « Dis Jaris » : 46 sur 50. Toujours pas « j'arrive » (vrai mot
# courant, faux réveil sur « j'arrive dans 5 minutes »), ni « Jarvis », « Jerry » ou « Paris ».
WAKE_NAME = re.compile(r'\b(?:di)?jarr?[iy]\w*\b', re.IGNORECASE)


def contains_wake_name(text: str) -> bool:
    return WAKE_NAME.search(text) is not None


def remove_wake_prefix(text: str) -> str:
    match = WAKE_NAME.search(text)
    return text[match.end():].lstrip(' ,.!?:;—-') if match else text


# Découpage d'une phrase dans le flux du micro (morceaux de 80 ms) : commence au premier morceau assez fort, se
# termine après un court silence. Assez court pour réagir vite après « Jaris », assez long pour ne pas couper
# « Jaris, ouvre YouTube » à la virgule.
PRE_ROLL_CHUNKS = 4       # 320 ms gardés AVANT le premier son fort : le « J » de « Jaris » est souvent faible
END_SILENCE_CHUNKS = 7    # 560 ms de silence = fin de phrase
MIN_LOUD_CHUNKS = 3       # moins de 240 ms de son fort : un claquement, une toux — rien à transcrire
MAX_SEGMENT_CHUNKS = 75   # 6 s au plus : une longue conversation dans la pièce est découpée, jamais accumulée


class WakeSegmenter:
    """Découpe le flux du micro en phrases. Pur (aucun modèle) : testé sans micro ni transcription."""

    def __init__(self):
        self.pre_roll = deque(maxlen=PRE_ROLL_CHUNKS)
        self.segment: list[np.ndarray] | None = None
        self.loud = 0
        self.silence = 0
        # Dernier son écarté car trop court (test du mot « Jaris », étape 180) : dire « trop court » vaut mieux
        # que ne rien afficher du tout quand Léo parle trop doucement ou trop vite.
        self.dropped: list[np.ndarray] | None = None

    def clear(self):
        self.pre_roll.clear()
        self.segment = None
        self.loud = 0
        self.silence = 0
        self.dropped = None

    @property
    def trailing_silence_chunks(self) -> int:
        return self.silence

    def push(self, chunk: np.ndarray, is_loud: bool):
        """Renvoie la phrase (liste de morceaux) quand elle se termine et contient assez de son, sinon None."""
        if self.segment is None:
            if not is_loud:
                self.pre_roll.append(chunk.copy())
                return None
            self.segment = list(self.pre_roll)
            self.pre_roll.clear()
            self.loud = 0
            self.silence = 0
        self.segment.append(chunk.copy())
        if is_loud:
            self.loud += 1
            self.silence = 0
        else:
            self.silence += 1
        if self.silence < END_SILENCE_CHUNKS and len(self.segment) < MAX_SEGMENT_CHUNKS:
            return None
        segment, loud = self.segment, self.loud
        self.segment = None
        if loud >= MIN_LOUD_CHUNKS:
            return segment
        self.dropped = segment
        return None
