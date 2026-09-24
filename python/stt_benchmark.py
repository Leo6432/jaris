"""Test de vitesse de la transcription (étape 156, Options → Voix) : sur la machine de l'utilisateur, mesure pour
chaque façon de comprendre la voix le temps pour une phrase de 5 secondes, la RAM et la VRAM prises, et le
taux d'erreurs.

Léo : « la reconnaissance de la voix prend 4,5 Go sur la carte, [...] fais un test de vitesse quand on la met sur
la VRAM et sur la RAM, avec la RAM prise, la VRAM et la vitesse ».

Chaque configuration tourne dans son PROPRE processus (ce script relancé avec --config) : la RAM se mesure alors
proprement (mémoire maximale du processus moins ce qu'il occupait avant de charger le modèle), sans que la
configuration précédente fausse la suivante — un allocateur ne rend jamais toute la mémoire au système.

Les phrases sont dites par la voix de Jaris (Supertonic, déjà installée) plutôt qu'au micro : pour compter les
erreurs, il faut connaître le texte exact prononcé, et toutes les configurations entendent ainsi exactement le
même son. Aucun chiffre ne contient de nombre, pour ne pas compter « 18 » contre « dix-huit » comme une erreur.

Sortie : une ligne JSON par évènement sur stdout ({"event": "progress"} puis {"event": "result"}).
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unicodedata

# Même raison que voice_server.py/tts_server.py (étape 121) : sans UTF-8 imposé, un Windows en page de codes
# cp1252 casse chaque accent de la sortie JSON lue par Node.
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

PHRASES = [
    ("Jaris, quel temps fera-t-il demain à Lyon ?", "M1"),
    ("Ouvre le bloc-notes et écris bonjour.", "F1"),
    ("Cherche une recette de crêpes sans lait.", "M3"),
    ("Explique-moi comment fonctionne une batterie de voiture électrique.", "F3"),
    ("Donne-moi des idées de cadeaux pour l'anniversaire de ma sœur.", "M5"),
]

COHERE_MODEL = "evewashere/cohere-transcribe-03-2026-ungated"
COHERE_REVISION = "29b9036c65620e1a148127c6147543b52358da6a"  # même version épinglée que voice_server.py
PARAKEET_MODEL = "nemo-parakeet-tdt-0.6b-v3"

# (identifiant, libellé affiché, emplacement)
CONFIGS = [
    ("cohere-vram", "Cohere (l'actuel) sur la carte graphique", "vram"),
    ("cohere-ram", "Cohere (l'actuel) en RAM", "ram"),
    ("parakeet-ram", "Parakeet v3 en RAM", "ram"),
    ("parakeet-ram-int8", "Parakeet v3 compressé en RAM", "ram"),
]

# Cohere en RAM décompresse ses 2 milliards de paramètres en float32 : environ 8 Go, plus le reste.
COHERE_RAM_NEEDED_GB = 10.0


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


# --- Mesures du système, sans dépendance supplémentaire ------------------------------------------------------

def _windows_process_memory():
    import ctypes
    from ctypes import wintypes

    class PMC(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    # Types déclarés EXPLICITEMENT (étape 157) : sans eux, ctypes suppose un `int` 32 bits partout. Le
    # pseudo-handle de GetCurrentProcess (-1, soit 0xFFFF…FFFF sur 64 bits) arrivait alors tronqué, l'appel
    # échouait SANS RIEN DIRE et les compteurs restaient à zéro : « RAM prise : 0 Go » sur chaque ligne chez Léo.
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.GetCurrentProcess.argtypes = []
    psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
    counters = PMC()
    counters.cb = ctypes.sizeof(PMC)
    if not psapi.GetProcessMemoryInfo(kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
        raise OSError(ctypes.get_last_error(), "GetProcessMemoryInfo a échoué")
    return counters.WorkingSetSize, counters.PeakWorkingSetSize


def process_memory_bytes():
    """(mémoire actuelle, mémoire maximale) du processus, en octets. Lève une erreur si la mesure échoue :
    jamais un zéro silencieux, qui se lirait « ne prend pas de RAM »."""
    if sys.platform == "win32":
        return _windows_process_memory()
    now = peak = 0
    with open("/proc/self/status") as status:
        for line in status:
            if line.startswith("VmRSS:"):
                now = int(line.split()[1]) * 1024
            elif line.startswith("VmHWM:"):
                peak = int(line.split()[1]) * 1024
    if not now:
        raise OSError("mémoire du processus illisible")
    return now, peak


def _nvidia_smi_candidates():
    yield "nvidia-smi"
    # Certains pilotes NVIDIA ne mettent pas nvidia-smi dans le PATH : ses deux emplacements habituels.
    system_root = os.environ.get("SystemRoot")
    if system_root:
        yield os.path.join(system_root, "System32", "nvidia-smi.exe")
    program_files = os.environ.get("ProgramFiles")
    if program_files:
        yield os.path.join(program_files, "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe")


def gpu_used_mb():
    """Mémoire utilisée sur la carte (Mo), TOUS processus confondus, lue par nvidia-smi — ce que la carte
    perd vraiment, contexte CUDA compris (torch ne compte que ses propres tenseurs). `None` sans nvidia-smi."""
    for exe in _nvidia_smi_candidates():
        try:
            out = subprocess.run(
                [exe, "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                capture_output=True, text=True, timeout=10,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if out.returncode == 0 and out.stdout.strip():
            try:
                return float(out.stdout.strip().splitlines()[0])
            except ValueError:
                return None
    return None


def available_ram_gb():
    if sys.platform == "win32":
        import ctypes

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        status = MEMORYSTATUSEX()
        status.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
        return status.ullAvailPhys / 1024 ** 3
    with open("/proc/meminfo") as meminfo:
        for line in meminfo:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) / 1024 ** 2
    return 0.0


# --- Taux d'erreurs ------------------------------------------------------------------------------------------

def normalize_words(text):
    text = unicodedata.normalize("NFC", text.lower()).replace("-", " ").replace("'", " ").replace("’", " ")
    return re.sub(r"[^\w\s]", " ", text).split()


def word_errors(reference, hypothesis):
    """(erreurs, mots de la référence) — distance d'édition au niveau des mots."""
    ref, hyp = normalize_words(reference), normalize_words(hypothesis)
    row = list(range(len(hyp) + 1))
    for i in range(1, len(ref) + 1):
        previous, row[0] = row[0], i
        for j in range(1, len(hyp) + 1):
            current = min(row[j] + 1, row[j - 1] + 1, previous + (ref[i - 1] != hyp[j - 1]))
            previous, row[j] = row[j], current
    return row[len(hyp)], len(ref)


# --- Une configuration (processus enfant) -------------------------------------------------------------------

def load_engine(config):
    """Renvoie (transcrire(audio) -> texte, mesure_vram() -> Go ou None)."""
    if config.startswith("cohere"):
        import torch
        from transformers import AutoProcessor, CohereAsrForConditionalGeneration

        device = "cuda" if config == "cohere-vram" else "cpu"
        # Mêmes réglages que voice_server.py : float16 sur la carte, float32 sur le processeur.
        dtype = torch.float16 if device == "cuda" else torch.float32
        processor = AutoProcessor.from_pretrained(COHERE_MODEL, revision=COHERE_REVISION)
        model = CohereAsrForConditionalGeneration.from_pretrained(
            COHERE_MODEL, revision=COHERE_REVISION, dtype=dtype, device_map=device
        )

        def transcribe(audio):
            inputs = processor(audio, sampling_rate=16000, return_tensors="pt", language="fr")
            inputs.to(model.device, dtype=model.dtype)
            with torch.no_grad():
                outputs = model.generate(**inputs, max_new_tokens=256)
            if device == "cuda":
                torch.cuda.synchronize()
            return processor.decode(outputs[0], skip_special_tokens=True).strip()

        def vram_gb():
            return torch.cuda.max_memory_reserved() / 1024 ** 3 if device == "cuda" else 0.0

        return transcribe, vram_gb

    import onnx_asr

    model = onnx_asr.load_model(PARAKEET_MODEL, quantization="int8" if config.endswith("int8") else None)
    return (lambda audio: model.recognize(audio, sample_rate=16000)), (lambda: 0.0)


def run_config(config, clips_dir):
    import numpy as np
    import soundfile as sf

    refs = json.load(open(os.path.join(clips_dir, "refs.json"), encoding="utf-8"))
    clips = [sf.read(os.path.join(clips_dir, r["file"]), dtype="float32")[0] for r in refs]
    try:
        ram_before = process_memory_bytes()[0]
    except OSError:
        ram_before = None
    gpu_before = gpu_used_mb()
    started = time.perf_counter()
    transcribe, torch_vram_gb = load_engine(config)
    load_seconds = time.perf_counter() - started
    transcribe(clips[0])  # préchauffage : le tout premier passage n'est pas représentatif
    per_5s, errors, words, texts = [], 0, 0, []
    for ref, audio in zip(refs, clips):
        t = time.perf_counter()
        text = transcribe(np.asarray(audio, dtype=np.float32))
        per_5s.append((time.perf_counter() - t) / ref["seconds"] * 5)
        e, n = word_errors(ref["text"], text)
        errors += e
        words += n
        texts.append(text)
    # Mesures prises modèle toujours chargé, après les transcriptions : ce que la transcription occupe EN
    # FONCTIONNEMENT (pas le pic du chargement, où le modèle transite par la RAM même s'il finit sur la carte).
    try:
        ram_gb = round(max(0, process_memory_bytes()[0] - ram_before) / 1024 ** 3, 2) if ram_before is not None else None
    except OSError:
        ram_gb = None
    gpu_after = gpu_used_mb()
    if gpu_before is not None and gpu_after is not None:
        vram_gb = round(max(0.0, gpu_after - gpu_before) / 1024, 2)
    elif config == "cohere-vram":
        vram_gb = round(torch_vram_gb(), 2)  # repli : ce que torch a réservé (sans le contexte CUDA)
    else:
        vram_gb = 0.0  # en RAM, la transcription ne touche pas la carte (torch et onnxruntime en mode processeur)
    per_5s.sort()
    emit({
        "event": "row",
        "secondsPer5s": round(per_5s[len(per_5s) // 2], 2),
        "ramGb": ram_gb,
        "vramGb": vram_gb,
        "errorsPct": round(100 * errors / max(1, words), 1),
        "loadSeconds": round(load_seconds, 1),
        "sample": texts[0],
    })


# --- Orchestration (processus principal) --------------------------------------------------------------------

def make_clips(clips_dir):
    import numpy as np
    import scipy.signal
    import soundfile as sf
    from supertonic import TTS

    tts = TTS(auto_download=True)
    refs = []
    for index, (text, voice) in enumerate(PHRASES):
        wav, _ = tts.synthesize(text, voice_style=tts.get_voice_style(voice_name=voice), lang="fr")
        wav = np.asarray(wav, dtype=np.float64).reshape(-1)  # float64 AVANT resample_poly (étape 80)
        audio = scipy.signal.resample_poly(wav, 16000, tts.sample_rate).astype(np.float32)
        name = f"{index:02d}.wav"
        sf.write(os.path.join(clips_dir, name), audio, 16000)
        refs.append({"file": name, "text": text, "seconds": round(len(audio) / 16000, 2)})
    json.dump(refs, open(os.path.join(clips_dir, "refs.json"), "w", encoding="utf-8"), ensure_ascii=False)


def cuda_available():
    try:
        import torch

        return torch.cuda.is_available(), (torch.cuda.get_device_name(0) if torch.cuda.is_available() else None)
    except Exception:
        return False, None


def main():
    if "--config" in sys.argv:
        run_config(sys.argv[sys.argv.index("--config") + 1], sys.argv[sys.argv.index("--clips") + 1])
        return

    has_cuda, gpu_name = cuda_available()
    rows = []
    with tempfile.TemporaryDirectory() as clips_dir:
        emit({"event": "progress", "message": "Préparation des phrases de test (voix de Jaris)…"})
        make_clips(clips_dir)
        for config, label, where in CONFIGS:
            row = {"id": config, "label": label, "where": where}
            if where == "vram" and not has_cuda:
                rows.append({**row, "available": False, "reason": "Pas de carte NVIDIA utilisable par la transcription sur ce PC."})
                continue
            if config == "cohere-ram" and available_ram_gb() < COHERE_RAM_NEEDED_GB:
                rows.append({**row, "available": False, "reason": f"Il faudrait environ {COHERE_RAM_NEEDED_GB:.0f} Go de RAM libre (seulement {available_ram_gb():.1f} Go)."})
                continue
            emit({"event": "progress", "message": f"Test : {label} (premier essai : téléchargement du modèle si besoin)…"})
            proc = subprocess.run(
                [sys.executable, "-u", os.path.abspath(__file__), "--config", config, "--clips", clips_dir],
                capture_output=True, text=True, encoding="utf-8", errors="replace",
            )
            result = None
            for line in proc.stdout.splitlines():
                try:
                    payload = json.loads(line)
                except ValueError:
                    continue
                if payload.get("event") == "row":
                    result = payload
            if result is None:
                last = (proc.stderr.strip().splitlines() or ["erreur inconnue"])[-1]
                if "out of memory" in proc.stderr.lower():
                    last = "Pas assez de mémoire libre pour ce test."
                rows.append({**row, "available": False, "reason": last[:300]})
            else:
                result.pop("event", None)
                rows.append({**row, "available": True, **result})
    emit({"event": "result", "gpu": gpu_name, "rows": rows})


if __name__ == "__main__":
    main()
