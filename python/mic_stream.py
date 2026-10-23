"""Ouverture et suivi du micro pour voice_server.py (étape 346).

Trois défauts trouvés par la chasse aux bugs, tous liés au micro lui-même :
- un micro USB ou un casque Bluetooth débranché laissait Jaris sourd jusqu'au redémarrage : la boucle attendait un
  bloc de son qui ne venait plus jamais, et ne traitait même plus la touche « + » ni les messages du téléphone ;
- le micro choisi était retenu par son NUMÉRO dans la liste de PortAudio, qui change quand on branche un casque :
  Jaris pouvait écouter un autre micro, ou s'arrêter sur un numéro devenu invalide ;
- un casque Bluetooth utilisé comme micro reste en mode « mains libres » (son de téléphone pour TOUT le PC) tant que le
  micro est ouvert, même hors du mode Agent vocal.

Aucun import de sounddevice ici : le module est passé en paramètre, pour être testé sans micro.
"""

import time

# Plus aucun bloc de son depuis ce temps : le micro a disparu (débranché, pilote arrêté).
SILENT_STREAM_SECONDS = 3.0
# Sans micro, nouvel essai d'ouverture à ce rythme (un micro peut être rebranché).
RETRY_SECONDS = 5.0

# Un casque Bluetooth utilisé comme micro passe en profil « mains libres » (HFP) : son nom l'annonce sous Windows.
HANDS_FREE_MARKERS = ("hands-free", "hands free", "handsfree", "mains libres", "mains-libres", "freisprech", "manos libres", "vivavoce")


def is_hands_free(name: str) -> bool:
    lowered = (name or "").lower()
    return any(marker in lowered for marker in HANDS_FREE_MARKERS)


def find_input_device(devices, hostapis, name):
    """Numéro actuel du micro nommé `name` (WASAPI d'abord, comme la liste d'Options), ou None s'il n'est plus là."""
    if not name:
        return None
    wanted = name.strip().lower()
    matches = [
        index
        for index, device in enumerate(devices)
        if device.get("max_input_channels", 0) > 0 and str(device.get("name", "")).strip().lower() == wanted
    ]
    if not matches:
        return None
    wasapi = next((i for i, api in enumerate(hostapis) if "wasapi" in str(api.get("name", "")).lower()), None)
    preferred = [index for index in matches if wasapi is not None and devices[index].get("hostapi") == wasapi]
    return (preferred or matches)[0]


def is_input_device(devices, index) -> bool:
    return isinstance(index, int) and 0 <= index < len(devices) and devices[index].get("max_input_channels", 0) > 0


class Microphone:
    """Le flux du micro : ouverture (micro choisi par son nom, sinon micro par défaut), fermeture, réouverture."""

    def __init__(self, sd, make_callback, sample_rate, chunk_samples, debug, device_index=None, device_name=None, clock=time.monotonic):
        self.sd = sd
        self.make_callback = make_callback
        self.sample_rate = sample_rate
        self.chunk_samples = chunk_samples
        self.debug = debug
        self.device_index = device_index
        self.device_name = device_name
        self.clock = clock
        self.stream = None
        self.label = ""
        self.hands_free = False
        self.last_error = ""
        self.last_audio_at = clock()

    @property
    def is_open(self) -> bool:
        return self.stream is not None

    def choose_device(self):
        """Le micro choisi s'il est encore là (retrouvé par son NOM), sinon None = micro par défaut de Windows."""
        try:
            devices = list(self.sd.query_devices())
            hostapis = list(self.sd.query_hostapis())
        except Exception:
            return None
        if self.device_name:
            found = find_input_device(devices, hostapis, self.device_name)
            if found is None:
                self.debug(f"Micro « {self.device_name} » introuvable : micro par défaut.")
            return found
        if self.device_index is not None:
            if is_input_device(devices, self.device_index):
                return self.device_index
            self.debug(f"Micro n°{self.device_index} introuvable : micro par défaut.")
        return None

    def _stamped(self, callback):
        def on_audio(*args):
            self.last_audio_at = self.clock()
            callback(*args)

        return on_audio

    def _open_on(self, device):
        """Ouvre `device` à 16 kHz, ou à son débit natif (rééchantillonné) s'il refuse 16 kHz."""
        try:
            stream = self.sd.InputStream(
                samplerate=self.sample_rate,
                channels=1,
                dtype="int16",
                blocksize=self.chunk_samples,
                device=device,
                callback=self._stamped(self.make_callback(self.sample_rate)),
            )
            stream.start()
            return stream
        except Exception as exc:
            # PaErrorCode -9997 : certains micros (USB, Bluetooth...) n'acceptent que leur propre débit.
            if "Invalid sample rate" not in str(exc):
                raise
        index = device if device is not None else self.sd.default.device[0]
        native_rate = int(round(self.sd.query_devices(index, "input")["default_samplerate"]))
        self.debug(f"Ce micro n'accepte pas 16 kHz directement, ré-échantillonnage depuis {native_rate} Hz…")
        stream = self.sd.InputStream(
            samplerate=native_rate,
            channels=1,
            dtype="int16",
            blocksize=max(1, round(self.chunk_samples * native_rate / self.sample_rate)),
            device=device,
            callback=self._stamped(self.make_callback(native_rate)),
        )
        stream.start()
        return stream

    def open(self) -> bool:
        """Ouvre le micro choisi, sinon celui par défaut. Faux (raison dans last_error) si aucun ne s'ouvre."""
        self.close()
        device = self.choose_device()
        candidates = [device] if device is None else [device, None]
        for candidate in candidates:
            try:
                self.stream = self._open_on(candidate)
            except Exception as exc:
                self.last_error = str(exc)
                continue
            self.last_audio_at = self.clock()
            try:
                info = self.sd.query_devices(candidate if candidate is not None else self.sd.default.device[0], "input")
                self.label = str(info.get("name", ""))
            except Exception:
                self.label = self.device_name or ""
            self.hands_free = is_hands_free(self.label)
            self.last_error = ""
            return True
        return False

    def close(self) -> None:
        stream, self.stream = self.stream, None
        if stream is None:
            return
        for method in ("stop", "close"):
            try:
                getattr(stream, method)()
            except Exception:
                pass

    def went_silent(self) -> bool:
        """Ouvert, mais plus aucun bloc de son depuis SILENT_STREAM_SECONDS : le micro a disparu."""
        return self.stream is not None and self.clock() - self.last_audio_at > SILENT_STREAM_SECONDS
