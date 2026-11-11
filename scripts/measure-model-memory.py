"""Mémoire réelle d'un modèle chargé par Ollama, avec un contexte de 16 384 — SANS télécharger ses poids (étape 471).

Ollama 0.40 fait tourner chaque modèle avec llama.cpp (`llama-server`). Avant de lire les poids, llama.cpp calcule son
plan de mémoire (« memory breakdown » : poids, contexte, calcul ; plus le lecteur d'images et le modèle brouillon). Ce
plan ne dépend que de l'EN-TÊTE de chaque fichier GGUF. Le script recrée donc chaque fichier en « creux » (fichier
épars : son vrai en-tête, puis des zéros jusqu'à sa vraie taille, sans place prise sur le disque), lance llama-server
avec EXACTEMENT les options d'Ollama (relevées dans son journal), lit le plan, puis l'arrête avant le chargement.

Vérifié le 11/11/2026 : sur K2 Horizon 0.9B, qwen3.5:0.8b et Qwen3.5-0.8B corrigé, le plan est identique au MiB près à
celui d'un vrai chargement par Ollama. La « taille » d'`ollama ps` ne convient pas : elle oublie le lecteur d'images et
le modèle brouillon (0,94 Go annoncés pour qwen3.5:0.8b, 2,6 Go réels).

Mesure faite sur processeur : sur une carte graphique, la place des calculs peut différer légèrement. Ling-3.0-tiny
(architecture bailingmoe3) fait planter llama.cpp sans carte graphique : son chiffre est calculé à part (voir
hardwareScan.ts, MODEL_MEMORY_16K_GB).

Usage :
    python scripts/measure-model-memory.py <dossier lib/ollama d'Ollama Linux 0.40.16> <modèle> [<modèle>...]
Ollama Linux : l'archive officielle ollama-linux-amd64.tar.zst (sha256 vérifié), sans les bibliothèques GPU.
"""
import json
import os
import re
import resource
import struct
import subprocess
import sys
import tempfile
import time

CONTEXT = 16384
ACCEPT = 'application/vnd.docker.distribution.manifest.v2+json'


def manifest_url(model):
    if model.startswith('hf.co/'):
        repo, _, tag = model[len('hf.co/'):].partition(':')
        return f'https://huggingface.co/v2/{repo}/manifests/{tag or "latest"}'
    name, _, tag = model.partition(':')
    if '/' not in name:
        name = 'library/' + name
    return f'https://registry.ollama.ai/v2/{name}/manifests/{tag or "latest"}'


def curl(*args):
    return subprocess.run(['curl', '-sSL', '--max-time', '300', *args], capture_output=True, check=True).stdout


def header(url):
    """Les octets de l'en-tête GGUF, jusqu'au début des données des tenseurs (lus par morceaux de 16 Mo)."""
    buf = b''
    pos = 0

    def read(n):
        nonlocal buf, pos
        while len(buf) < pos + n:
            chunk = curl('-r', f'{len(buf)}-{len(buf) + 16 * 1024 * 1024 - 1}', url)
            if not chunk:
                raise EOFError(url)
            buf += chunk
        pos += n
        return buf[pos - n:pos]

    def u32():
        return struct.unpack('<I', read(4))[0]

    def u64():
        return struct.unpack('<Q', read(8))[0]

    sizes = {0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8}
    alignment = 32
    assert read(4) == b'GGUF', url
    u32()
    n_tensors, n_kv = u64(), u64()
    for _ in range(n_kv):
        key = read(u64())
        kind = u32()
        if key == b'general.alignment':
            alignment = u32()
        elif kind == 8:
            read(u64())
        elif kind == 9:
            item, count = u32(), u64()
            if item == 8:
                for _ in range(count):
                    read(u64())
            else:
                read(sizes[item] * count)
        else:
            read(sizes[kind])
    for _ in range(n_tensors):
        read(u64())
        read(8 * u32())
        u32()
        u64()
    read((alignment - pos % alignment) % alignment)
    return buf[:pos]


def hollow_copy(directory, url, digest, size):
    path = os.path.join(directory, digest.replace(':', '-'))
    with open(path, 'wb') as f:
        f.write(header(url))
        f.truncate(size)
    return path


def memory_plan(lib_dir, model):
    url = manifest_url(model)
    layers = json.loads(curl('-H', f'Accept: {ACCEPT}', url))['layers']
    blobs = url.replace('/manifests/', '/blobs/').rsplit('/', 1)[0]
    with tempfile.TemporaryDirectory() as directory:
        files = {}
        for kind in ('model', 'projector', 'draft'):
            layer = next((l for l in layers if l['mediaType'].endswith('.' + kind)), None)
            if layer:
                files[kind] = hollow_copy(directory, f"{blobs}/{layer['digest']}", layer['digest'], layer['size'])
        # Les options d'Ollama 0.40.16 (journal du serveur, « starting llama-server »).
        args = [os.path.join(lib_dir, 'llama-server'), '--model', files['model'], '--port', '0', '--host', '127.0.0.1', '--no-webui',
                '--offline', '-c', str(CONTEXT), '-np', '1', '--log-verbosity', '4', '--no-log-prefix', '--no-log-timestamps']
        if 'projector' in files:
            args += ['--mmproj', files['projector']]
        if 'draft' in files:
            args += ['--spec-type', 'draft-mtp', '--spec-draft-n-max', '2', '--spec-draft-backend-sampling', '--spec-draft-model', files['draft']]
        args += ['--load-mode', 'none', '--flash-attn', 'auto', '-b', '1024', '-ub', '1024', '--context-shift', '--keep', '4']

        def limit():
            # Le vrai chargement ne doit jamais avoir lieu : mémoire virtuelle bridée, arrêt dès le plan lu.
            resource.setrlimit(resource.RLIMIT_AS, (10 * 1024 ** 3, 10 * 1024 ** 3))

        proc = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding='utf-8', errors='replace',
                                env={**os.environ, 'LD_LIBRARY_PATH': lib_dir}, preexec_fn=limit)
        tables, mmproj, table = [], 0.0, None
        deadline = time.time() + 300
        for line in proc.stdout:
            if 'memory breakdown [MiB]' in line:
                table = []
                tables.append(table)
                continue
            row = re.search(r'\|\s+- (\S+)\s+\|.*?(\d+) =\s+(\d+) \+\s+(\d+) \+\s+(\d+)', line)
            if table is not None and row:
                table.append(int(row.group(2)))
            else:
                table = None
            found = re.search(r'worst-case memory usage of mmproj is ([\d.]+) MiB', line)
            if found:
                mmproj = float(found.group(1))
            if ('load_tensors' in line and len(tables) >= 1 + ('draft' in files)) or time.time() > deadline:
                break
        proc.kill()
        proc.wait()
    if not tables:
        raise RuntimeError(f'{model} : aucun plan de mémoire lu (llama.cpp a peut-être planté)')
    return (sum(sum(t) for t in tables) + mmproj) * 1024 ** 2 / 1e9


if __name__ == '__main__':
    for name in sys.argv[2:]:
        try:
            print(f'{name} : {memory_plan(sys.argv[1], name):.2f} Go', flush=True)
        except Exception as err:  # noqa: BLE001 — un modèle en échec n'arrête pas les autres
            print(f'{name} : ÉCHEC ({err})', flush=True)
