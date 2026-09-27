import sys, unittest
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from wake_confirmation import (END_SILENCE_CHUNKS, MAX_SEGMENT_CHUNKS, PRE_ROLL_CHUNKS, WakeSegmenter,
                               contains_wake_name, remove_wake_prefix)

class ConfirmationTests(unittest.TestCase):
    def test_name_boundaries(self):
        # Graphies réellement observées avec Cohere Transcribe sur 25 échantillons TTS "Jaris" (voir
        # wake_confirmation.py) : une liste figée en ratait 33-40%, d'où le motif généralisant
        # \bjari\w*\b (préfixe "jari", pas "jaris" -- "Jarice" ne le contient pas) -- accepte donc aussi
        # "jarisien" ci-dessous (aucun vrai mot français ne commence par "jari-", le risque de faux positif
        # sur un mot RÉEL non lié est donc nul en pratique).
        for text in ('Jaris', 'Jarice, ouvre YouTube.', 'Bonjour Jarisse !', 'Jarissa.', 'Jariste.', 'Jarisses.', 'jarisien'):
            self.assertTrue(contains_wake_name(text))
        # Étape 158 : graphies de Parakeet v3, mesurées sur 50 échantillons (voir wake_confirmation.py).
        for text in ('Jarry Stop.', 'Jarris.', 'Salut Jarry.', 'Dijaris, quelle heure est-il?', 'Jarisque.'):
            self.assertTrue(contains_wake_name(text), text)
        for text in ('Paris', 'Jarvis', 'Jerry.', 'Le rendez-vous est demain.', "J'arrive.", "J'arrise.", "j'arrive dans 5 minutes", '', 'Voici la météo.', 'Le jardin.', 'Un jarret de porc.'):
            self.assertFalse(contains_wake_name(text), text)

    def test_prefix_removed(self):
        self.assertEqual(remove_wake_prefix('Jaris, ouvre YouTube maintenant.'), 'ouvre YouTube maintenant.')
        self.assertEqual(remove_wake_prefix('Jaris.'), '')
        self.assertEqual(remove_wake_prefix('Jarry, ouvre YouTube.'), 'ouvre YouTube.')
        self.assertEqual(remove_wake_prefix('Dijaris, quelle heure est-il ?'), 'quelle heure est-il ?')


# Étape 179 : le détecteur openWakeWord (licence non commerciale, « une fois sur 20 » selon Léo) est remplacé
# par la transcription de chaque phrase entendue. WakeSegmenter découpe ces phrases dans le flux du micro.
LOUD = np.full(1280, 3000, dtype=np.int16)
QUIET = np.zeros(1280, dtype=np.int16)


def feed(seg, pattern):
    """pattern : suite de (fort?, nombre de morceaux). Renvoie toutes les phrases rendues."""
    out = []
    for loud, count in pattern:
        for _ in range(count):
            got = seg.push(LOUD if loud else QUIET, loud)
            if got is not None:
                out.append(got)
    return out


class SegmenterTests(unittest.TestCase):
    def test_silence_never_transcribed(self):
        self.assertEqual(feed(WakeSegmenter(), [(False, 500)]), [])

    def test_phrase_ends_after_short_silence_and_keeps_the_start(self):
        seg = WakeSegmenter()
        phrases = feed(seg, [(False, 10), (True, 8), (False, END_SILENCE_CHUNKS)])
        self.assertEqual(len(phrases), 1)
        # Le « J » souvent faible de « Jaris » : les morceaux juste AVANT le premier son fort sont gardés.
        self.assertEqual(len(phrases[0]), PRE_ROLL_CHUNKS + 8 + END_SILENCE_CHUNKS)
        self.assertEqual(seg.trailing_silence_chunks, END_SILENCE_CHUNKS)

    def test_short_pause_does_not_cut_the_sentence(self):
        # « Jaris, … ouvre YouTube » : une virgule (courte pause) ne coupe pas la phrase en deux.
        phrases = feed(WakeSegmenter(), [(True, 6), (False, END_SILENCE_CHUNKS - 2), (True, 10), (False, END_SILENCE_CHUNKS)])
        self.assertEqual(len(phrases), 1)

    def test_click_or_cough_ignored(self):
        self.assertEqual(feed(WakeSegmenter(), [(True, 2), (False, END_SILENCE_CHUNKS)]), [])

    def test_long_talk_is_cut_never_accumulated(self):
        phrases = feed(WakeSegmenter(), [(True, MAX_SEGMENT_CHUNKS * 3)])
        self.assertEqual(len(phrases), 3)
        self.assertTrue(all(len(p) <= MAX_SEGMENT_CHUNKS for p in phrases))

    def test_clear_forgets_a_phrase_in_progress(self):
        seg = WakeSegmenter()
        feed(seg, [(True, 5)])
        seg.clear()
        self.assertEqual(feed(seg, [(False, END_SILENCE_CHUNKS)]), [])


class VoiceServerWiringTests(unittest.TestCase):
    """voice_server.py ouvre un micro : son câblage est vérifié sur le texte source (aucun micro ici)."""
    source = (Path(__file__).resolve().parents[1] / 'python' / 'voice_server.py').read_text(encoding='utf-8')

    def test_old_detector_gone(self):
        self.assertNotIn('wakeword', self.source.replace('--wakeword-disabled', '').replace('wakeword_disabled', ''))
        for model in ('melspectrogram.onnx', 'embedding_model.onnx', 'jaris.onnx'):
            self.assertNotIn(model, self.source)

    def test_name_in_transcription_is_the_only_wake(self):
        self.assertIn('segmenter.push(chunk, rms(chunk) >= SILENCE_RMS_THRESHOLD)', self.source)
        self.assertIn('if contains_wake_name(heard):', self.source)
        # Option « Jaris » désactivée : aucune phrase transcrite en attendant le nom.
        self.assertIn('listen_for_name = not args.wakeword_disabled', self.source)
        self.assertIn('elif listen_for_name:', self.source)

    def test_overheard_speech_never_logged(self):
        # Chaque phrase de la pièce est transcrite : rien ne doit en sortir quand le nom n'y est pas.
        wake_block = self.source[self.source.index('if mode == "wake":'):self.source.index('# mode == "capture"')]
        self.assertNotIn('heard!r', wake_block)
        self.assertNotIn('debug(', wake_block)


if __name__ == '__main__':unittest.main()
