import sys, unittest
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from mic_stream import SILENT_STREAM_SECONDS, Microphone, is_hands_free
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
        for text in ('Paris', 'Le rendez-vous est demain.', "J'arrive.", "J'arrive !", "j'arrive dans 5 minutes", '', 'Voici la météo.', 'Le jardin.', 'Un jarret de porc.'):
            self.assertFalse(contains_wake_name(text), text)

    def test_leo_real_voice(self):
        # Étape 181 : les 12 transcriptions RÉELLES du test d'Options (voix de Léo), dans l'ordre. 2 reconnues avant.
        heard = ['Jeis', 'Rice?', "J'ai ce", 'Jaris.', 'Jazz', 'Jaice.', 'Jaris.', 'Rice.', 'Jaice.', 'Nice.', 'Rice', 'Jais.']
        # 8 à l'étape 181, 11 depuis « Rice » (étape 183, demande de Léo).
        self.assertEqual(sum(contains_wake_name(t) for t in heard), 11)
        for text in ('Rice?', 'Rice.', 'Rice'):
            self.assertTrue(contains_wake_name(text), text)
            self.assertEqual(remove_wake_prefix(text), '')
        # « Nice » : la ville, un vrai mot — toujours refusé. « Rice » dans une phrase aussi.
        for text in ('Nice.', 'Du rice au curry.', 'Rice is good.'):
            self.assertFalse(contains_wake_name(text), text)

    def test_accents_ignored(self):
        # Étape 184 : réel, voix de Léo — « Jáis ».
        for text in ('Jáis.', 'Jàis', 'Jaïs !', 'JÁIS'):
            self.assertTrue(contains_wake_name(text), text)
            self.assertEqual(remove_wake_prefix(text), '')
        self.assertFalse(contains_wake_name("J'ai été là."))

    def test_cyrillic_transcription(self):
        # Étape 182 : réel, voix de Léo — Parakeet a pris le mot seul pour du russe.
        for text in ('Жайс.', 'Жарис', 'Жайс'):
            self.assertTrue(contains_wake_name(text), text)
            self.assertEqual(remove_wake_prefix(text), '')
        # Du vrai russe dans une phrase ne réveille pas Jaris pour autant.
        for text in ('Привет, как дела?', 'Жаль, что ты не пришёл.', 'Париж'):
            self.assertFalse(contains_wake_name(text), text)

    def test_name_in_every_voice_language(self):
        # Étape 293 (24 langues) : « Jaris » écrit comme on le prononce dans chaque alphabet et chaque orthographe
        # où le son « dj » prend plusieurs lettres. Sans ça, un Russe ou un Grec disait le nom sans jamais réveiller.
        for text in ('Джарис', 'Джарис, открой YouTube.', 'Τζάρις', 'Τζάρις, άνοιξε το YouTube.', 'Džaris',
                     'Džaris, otevři YouTube.', 'Dżaris', 'Dżaris, otwórz YouTube.', 'Dzsáris', 'Dzsáris, nyisd meg a YouTube-ot.',
                     'Джаріс', 'ДЖАРИС'):
            self.assertTrue(contains_wake_name(text), text)
        self.assertEqual(remove_wake_prefix('Джарис, открой YouTube.'), 'открой YouTube.')
        self.assertEqual(remove_wake_prefix('Τζάρις, άνοιξε το YouTube.'), 'άνοιξε το YouTube.')
        # De vrais mots de ces langues ne réveillent pas Jaris : le son « dj » seul ne suffit pas.
        for text in ('Джаз в клубе.', 'Τζάμι', 'Džem je sladký.', 'Dżem truskawkowy.', 'Παρίσι', 'Джерело води.'):
            self.assertFalse(contains_wake_name(text), text)

    def test_loose_forms_only_when_said_alone(self):
        # Dans une vraie phrase, seule la forme stricte compte : « j'ai ce livre » ne réveille jamais Jaris.
        for text in ("J'ai ce livre sur la table.", 'Jazz ce soir au club ?', 'Je sais pas.', "J'ai ce qu'il faut.", 'Jessica arrive.'):
            self.assertFalse(contains_wake_name(text), text)
        for text in ('Jaice.', 'Jais !', "J'ai ce.", 'Jazz', 'Hey Jaice.'):
            self.assertTrue(contains_wake_name(text), text)
            self.assertEqual(remove_wake_prefix(text), '', 'le nom dit seul ne laisse aucune demande')

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

    def test_short_sound_kept_aside_for_the_wake_test(self):
        # Étapes 180/186 : le test du mot « Jaris » doit pouvoir dire « trop court » au lieu de ne rien afficher.
        seg = WakeSegmenter()
        self.assertEqual(feed(seg, [(True, 2), (False, END_SILENCE_CHUNKS)]), [])
        self.assertIsNotNone(seg.dropped)
        seg.clear()
        self.assertIsNone(seg.dropped)

    def test_clear_forgets_a_phrase_in_progress(self):
        seg = WakeSegmenter()
        feed(seg, [(True, 5)])
        seg.clear()
        self.assertEqual(feed(seg, [(False, END_SILENCE_CHUNKS)]), [])


class FakeStream:
    def __init__(self, sd, samplerate, device, callback):
        self.sd, self.samplerate, self.device, self.callback = sd, samplerate, device, callback
        self.started = self.closed = False

    def start(self):
        if self.device in self.sd.refused:
            raise RuntimeError(self.sd.refused[self.device])
        if self.samplerate == 16000 and self.device in self.sd.native_only:
            raise RuntimeError('Error opening InputStream: Invalid sample rate [PaErrorCode -9997]')
        self.started = True

    def stop(self):
        pass

    def close(self):
        self.closed = True


class FakeSd:
    """sounddevice simulé : une liste de micros, des micros qui refusent de s'ouvrir, un micro par défaut."""

    def __init__(self, devices, hostapis=(), default_index=0):
        self.devices, self.hostapis = list(devices), list(hostapis)
        self.default = type('Default', (), {'device': [default_index, 0]})()
        self.refused, self.native_only, self.opened = {}, set(), []

    def query_devices(self, index=None, kind=None):
        if index is None:
            return self.devices
        return {**self.devices[index], 'default_samplerate': self.devices[index].get('rate', 48000.0)}

    def query_hostapis(self):
        return self.hostapis

    def InputStream(self, samplerate, channels, dtype, blocksize, device, callback):
        stream = FakeStream(self, samplerate, device, callback)
        self.opened.append(stream)
        return stream


def mic_for(sd, clock=None, index=None, name=None):
    logs = []
    mic = Microphone(sd, lambda rate: (lambda *a: None), 16000, 1280, logs.append, index, name, clock=clock or (lambda: 0.0))
    return mic, logs


class MicrophoneTests(unittest.TestCase):
    """Étape 346 : micro retrouvé par son nom, micro disparu rouvert, casque Bluetooth reconnu."""

    devices = [
        {'name': 'Micro (Realtek)', 'max_input_channels': 2, 'hostapi': 0},
        {'name': 'Haut-parleurs', 'max_input_channels': 0, 'hostapi': 0},
        {'name': 'Micro USB', 'max_input_channels': 1, 'hostapi': 0},
        {'name': 'Micro USB', 'max_input_channels': 1, 'hostapi': 1},
    ]
    hostapis = [{'name': 'MME'}, {'name': 'Windows WASAPI'}]

    def test_choice_found_by_name_even_when_numbers_moved(self):
        sd = FakeSd(self.devices, self.hostapis)
        # Le micro choisi portait le numéro 2 ; un casque branché depuis a décalé la liste.
        mic, _ = mic_for(sd, index=0, name='micro usb')
        self.assertTrue(mic.open())
        self.assertEqual(sd.opened[-1].device, 3)  # même nom, version WASAPI préférée, comme la liste d'Options

    def test_unplugged_choice_falls_back_to_default(self):
        sd = FakeSd(self.devices, self.hostapis)
        mic, logs = mic_for(sd, name='Casque Bluetooth')
        self.assertTrue(mic.open())
        self.assertIsNone(sd.opened[-1].device)
        self.assertTrue(any('introuvable' in line for line in logs))

    def test_invalid_number_never_opened(self):
        sd = FakeSd(self.devices, self.hostapis)
        for index in (1, 9):  # une sortie, puis un numéro qui n'existe plus
            mic, _ = mic_for(sd, index=index)
            self.assertTrue(mic.open())
            self.assertIsNone(sd.opened[-1].device)

    def test_refused_choice_tries_the_default(self):
        sd = FakeSd(self.devices, self.hostapis)
        sd.refused[3] = 'Device unavailable [PaErrorCode -9985]'
        mic, _ = mic_for(sd, name='Micro USB')
        self.assertTrue(mic.open())
        self.assertEqual([stream.device for stream in sd.opened], [3, None])

    def test_no_microphone_reports_why_without_raising(self):
        sd = FakeSd(self.devices, self.hostapis)
        sd.refused[None] = 'Error querying device -1'
        mic, _ = mic_for(sd)
        self.assertFalse(mic.open())
        self.assertFalse(mic.is_open)
        self.assertIn('-1', mic.last_error)

    def test_native_rate_used_when_16k_refused(self):
        sd = FakeSd(self.devices, self.hostapis)
        sd.native_only.add(None)
        mic, _ = mic_for(sd)
        self.assertTrue(mic.open())
        self.assertEqual(sd.opened[-1].samplerate, 48000)

    def test_silent_stream_detected_then_cleared_by_sound(self):
        now = [0.0]
        sd = FakeSd(self.devices, self.hostapis)
        mic, _ = mic_for(sd, clock=lambda: now[0])
        self.assertTrue(mic.open())
        now[0] = SILENT_STREAM_SECONDS - 0.5
        self.assertFalse(mic.went_silent())
        sd.opened[-1].callback(None, 0, None, None)  # un bloc de son arrive
        now[0] += SILENT_STREAM_SECONDS - 0.5
        self.assertFalse(mic.went_silent())
        now[0] += 1.0
        self.assertTrue(mic.went_silent())
        mic.close()
        self.assertFalse(mic.went_silent())  # fermé exprès : jamais pris pour un micro disparu

    def test_reopen_closes_the_previous_stream(self):
        sd = FakeSd(self.devices, self.hostapis)
        mic, _ = mic_for(sd)
        mic.open()
        first = sd.opened[-1]
        mic.open()
        self.assertTrue(first.closed)

    def test_bluetooth_hands_free_recognised(self):
        self.assertTrue(is_hands_free('Casque (WH-1000XM4 Hands-Free AG Audio)'))
        self.assertTrue(is_hands_free('Écouteurs (Mains libres)'))
        self.assertFalse(is_hands_free('Micro (Realtek High Definition Audio)'))
        sd = FakeSd([{'name': 'Casque (AirPods Hands-Free)', 'max_input_channels': 1, 'hostapi': 0}])
        mic, _ = mic_for(sd)
        mic.open()
        self.assertTrue(mic.hands_free)


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

    def test_pause_stops_all_transcription(self):
        # Étape 183 : en pause (Chat, Code, Options), la branche d'écoute du nom n'est jamais atteinte.
        wake_block = self.source[self.source.index('elif wake_paused.is_set():'):self.source.index('elif listen_for_name:')]
        self.assertNotIn('transcribe(', wake_block)
        self.assertIn('elif line == "pause-wake":', self.source)
        self.assertIn('elif line == "resume-wake":', self.source)

    def test_wake_test_never_wakes_jaris(self):
        # Étape 186 (Léo : « remets le test de Jaris pour tester ») : de retour, toujours sans jamais réveiller Jaris.
        test_block = self.source[self.source.index('elif wake_test_on.is_set():'):self.source.index('elif wake_paused.is_set():')]
        self.assertIn('"event": "wake_test_heard"', test_block)
        self.assertNotIn('triggered = True', test_block)
        self.assertIn('elif line == "test-wake":', self.source)
        self.assertIn('elif line == "stop-test-wake":', self.source)
        # Le test d'Options passe AVANT la pause : il marche pendant que les Options sont ouvertes.
        self.assertLess(self.source.index('elif wake_test_on.is_set():'), self.source.index('elif wake_paused.is_set():'))

    def test_overheard_speech_never_logged(self):
        # Chaque phrase de la pièce est transcrite : rien ne doit en sortir quand le nom n'y est pas.
        wake_block = self.source[self.source.index('if mode == "wake":'):self.source.index('# mode == "capture"')]
        self.assertNotIn('heard!r', wake_block)
        self.assertNotIn('debug(', wake_block)

    def test_lost_microphone_never_blocks_the_loop(self):
        # Étape 346 : un micro débranché n'envoie plus rien — la boucle n'attend jamais sans fin.
        self.assertIn('chunk = audio_queue.get(timeout=', self.source)
        self.assertNotIn('chunk = audio_queue.get()', self.source)
        loop = self.source[self.source.index('while True:\n        # Étape 346'):]
        # Les messages du téléphone passent AVANT le test « pas de son » : ils sont traités même sans micro.
        self.assertLess(loop.index('while not file_requests.empty():'), loop.index('if chunk is None:'))
        self.assertIn('if mic.went_silent():', loop)

    def test_no_microphone_is_not_fatal(self):
        opening = self.source[self.source.index('mic = Microphone('):self.source.index('segmenter = WakeSegmenter()')]
        self.assertNotIn('"fatal"', opening)
        self.assertNotIn('sys.exit', opening)
        self.assertIn('"event": "mic_status"', opening)
        self.assertIn('args.input_device_name', self.source)

    def test_bluetooth_closed_only_during_pause(self):
        loop = self.source[self.source.index('wants_closed = ('):self.source.index('if mic.went_silent():')]
        for condition in ('wake_paused.is_set()', 'mic.hands_free', 'not manual_trigger.is_set()', 'not mic_test_active'):
            self.assertIn(condition, loop)



if __name__ == '__main__':unittest.main()
