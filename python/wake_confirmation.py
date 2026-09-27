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


# Étape 181 : 12 « Jaris » dits par Léo avec le test d'Options (volume à 100 % à chaque fois : le son n'était pas
# en cause), seuls 2 reconnus. Parakeet écrivait, pour le mot dit SEUL : « Jeis », « Rice? », « J'ai ce », « Jazz »,
# « Jaice. » (×2), « Rice. », « Nice. », « Rice », « Jais. » — un mot isolé si court n'a aucun contexte, et sonne
# comme de l'anglais. Point commun de 6 des 10 ratés : un J, puis a/ai/e/ei, puis un son en R, S, Z ou C.
# SHORT_WAKE_NAME l'accepte, mais UNIQUEMENT quand toute la phrase se réduit à ce mot (« J'ai ce » compacté en
# « jaice ») : dans une vraie phrase, « j'ai ce livre » ne doit jamais réveiller Jaris — WAKE_NAME, strict, reste
# seul juge. « Nice » (J perdu) n'est PAS accepté : sans J, rien ne le distingue d'un vrai mot (la ville).
# Étape 183 : « Rice » dit seul, lui, est ajouté à la demande de Léo — sa transcription la plus fréquente après
# « Jaice » (4 sur 12), et un mot anglais qu'on ne prononce pas seul en français.
# « j'arrive » dit seul reste refusé (vrai mot courant, déjà écarté à l'étape 158).
SHORT_WAKE_NAME = re.compile(r'^(?:hey|dis|di)?(?:j(?!arriv)(?:ai|ei|ay|a|e|é)[rszcçx]\w{0,3}|rice)$')


# Étape 182 (Léo : « il met souvent Compris « Жайс. » ») : Parakeet v3 devine lui-même la langue, et un mot seul
# si court est parfois pris pour du russe — écrit en cyrillique, il échappait à toute comparaison. « Жайс » se
# lit pourtant « jaïs » : les lettres cyrilliques sont ramenées à leur son en lettres latines, à la française
# (Ж = « j » de « jour »), AVANT la comparaison. Seul le TEXTE COMPARÉ change, jamais ce qui est transcrit.
CYRILLIC_TO_LATIN = str.maketrans({
    'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ё': 'e', 'ж': 'j', 'з': 'z', 'и': 'i', 'й': 'i',
    'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n', 'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'ou', 'ф': 'f',
    'х': 'h', 'ц': 'ts', 'ч': 'tch', 'ш': 'ch', 'щ': 'ch', 'ъ': '', 'ы': 'y', 'ь': '', 'э': 'e', 'ю': 'iou', 'я': 'ia',
})


def _latin(text: str) -> str:
    return text.lower().translate(CYRILLIC_TO_LATIN)


def _compact(text: str) -> str:
    return re.sub(r"[\s'’.,!?;:«»\"—-]+", '', _latin(text))


def contains_wake_name(text: str) -> bool:
    return WAKE_NAME.search(_latin(text)) is not None or SHORT_WAKE_NAME.match(_compact(text)) is not None


def remove_wake_prefix(text: str) -> str:
    if SHORT_WAKE_NAME.match(_compact(text)):
        return ''
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
