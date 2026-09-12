import sys, unittest
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from wake_confirmation import WakeConfirmation, contains_wake_name, remove_wake_prefix

class ConfirmationTests(unittest.TestCase):
    def test_name_boundaries(self):
        # Graphies réellement observées avec Cohere Transcribe sur 25 échantillons TTS "Jaris" (voir
        # wake_confirmation.py) : une liste figée en ratait 33-40%, d'où le motif généralisant
        # \bjari\w*\b (préfixe "jari", pas "jaris" -- "Jarice" ne le contient pas) -- accepte donc aussi
        # "jarisien" ci-dessous (aucun vrai mot français ne commence par "jari-", le risque de faux positif
        # sur un mot RÉEL non lié est donc nul en pratique).
        for text in ('Jaris', 'Jarice, ouvre YouTube.', 'Bonjour Jarisse !', 'Jarissa.', 'Jariste.', 'Jarisses.', 'jarisien'):
            self.assertTrue(contains_wake_name(text))
        for text in ('Paris', 'Jarvis', 'Le rendez-vous est demain.', "J'arrive.", "J'arrise.", '', 'Voici la météo.'):
            self.assertFalse(contains_wake_name(text))

    def test_retains_audio_until_word_complete(self):
        gate = WakeConfirmation()
        chunk = np.ones(1280, dtype=np.int16)
        self.assertIsNone(gate.push(chunk, True))
        for _ in range(7):self.assertIsNone(gate.push(chunk, True))
        audio = gate.push(chunk, False)
        self.assertEqual(len(audio), 9)
        self.assertEqual(sum(len(x) for x in audio), 9 * 1280)
        self.assertEqual(remove_wake_prefix('Jaris, ouvre YouTube maintenant.'), 'ouvre YouTube maintenant.')
        self.assertEqual(remove_wake_prefix('Jaris.'), '')

    def test_manual_cancels_pending_and_stale_name(self):
        gate = WakeConfirmation()
        gate.push(np.ones(1280, dtype=np.int16), True)
        gate.clear()
        for _ in range(10):self.assertIsNone(gate.push(np.zeros(1280, dtype=np.int16), False))
        self.assertEqual(len(gate.history), 10)

    def test_bounded_memory_and_retry(self):
        gate = WakeConfirmation()
        chunk = np.zeros(1280, dtype=np.int16)
        gate.push(chunk, True)
        for _ in range(8):gate.push(chunk, False)
        for _ in range(38):self.assertIsNone(gate.push(chunk, True))
        self.assertIsNone(gate.push(chunk, True))
        for _ in range(7):self.assertIsNone(gate.push(chunk, True))
        self.assertEqual(len(gate.push(chunk, False)), 38)

if __name__ == '__main__':unittest.main()
