import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

/**
 * Étape 513 (journal de Léo, version Store : « Voix — lecture à voix haute impossible : échec de chargement de
 * Supertonic : Failed to download model from Supertone/supertonic-3 … Cannot call rmtree on a symbolic link ») : la
 * voix ne marchait jamais sur une installation neuve. Jaris remplace ~/.cache/supertonic3 par une jonction vers son
 * dossier de données (étape 155) ; Supertonic 1.3.1 télécharge à côté puis EFFACE ce dossier (shutil.rmtree) avant de
 * mettre le modèle à sa place — refusé sur un lien. tts_server.py donne maintenant le VRAI dossier à Supertonic.
 *
 * Le vrai python/tts_server.py tourne ici, avec un faux paquet `supertonic` qui reproduit À LA LIGNE PRÈS ce que fait
 * supertonic==1.3.1 (config.get_model_cache_dir, pipeline.TTS, loader.download_model : dossier temporaire voisin,
 * rmtree si le dossier existe, puis move) — le vrai paquet tire onnxruntime et télécharge 400 Mo.
 */
const root = fileURLToPath(new URL('..', import.meta.url))

function findPython() {
  for (const cmd of ['python3', 'python']) {
    try {
      const version = execFileSync(cmd, ['-c', 'import sys; print(sys.version_info[:2] >= (3, 10))'], { encoding: 'utf8' }).trim()
      if (version === 'True') return cmd
    } catch {
      // essai suivant
    }
  }
  return null
}
const python = findPython()

const FAKE_SUPERTONIC = {
  '__init__.py': 'from .pipeline import TTS\n',
  'config.py': `
import os
from pathlib import Path
DEFAULT_MODEL = "supertonic-3"
def get_model_cache_dir(model_name):
    env = os.environ.get("SUPERTONIC_CACHE_DIR")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".cache" / "supertonic3"
`,
  'pipeline.py': `
import shutil
from pathlib import Path
from .config import DEFAULT_MODEL, get_model_cache_dir

def get_cache_dir(model_name=None):
    cache_dir = get_model_cache_dir(model_name or DEFAULT_MODEL)
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir

def download_model(model_dir):
    # Copie de supertonic 1.3.1, loader.download_model (snapshot_download remplacé par l'écriture d'un fichier).
    temp_dir = model_dir.parent / f".{model_dir.name}.tmp"
    try:
        temp_dir.mkdir(parents=True, exist_ok=True)
        (temp_dir / "model.onnx").write_text("modele")
        if model_dir.exists():
            shutil.rmtree(model_dir)
        shutil.move(str(temp_dir), str(model_dir))
    except Exception as e:
        if temp_dir.exists():
            shutil.rmtree(temp_dir)
        raise RuntimeError(f"Failed to download model from Supertone/supertonic-3. Error: {e}") from e

class TTS:
    def __init__(self, model=DEFAULT_MODEL, model_dir=None, auto_download=True):
        if model_dir is None:
            model_dir = get_cache_dir(model)
        if not isinstance(model_dir, Path):
            model_dir = Path(model_dir)
        if not (model_dir / "model.onnx").exists() and auto_download:
            download_model(model_dir)
        self.model_dir = model_dir

    def get_voice_style(self, voice_name):
        return voice_name
`
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-tts-dir-'))
  const pkg = join(dir, 'site', 'supertonic')
  mkdirSync(pkg, { recursive: true })
  for (const [name, source] of Object.entries(FAKE_SUPERTONIC)) writeFileSync(join(pkg, name), source)
  const home = join(dir, 'home')
  const data = join(dir, 'donnees', 'supertonic-cache')
  mkdirSync(join(home, '.cache'), { recursive: true })
  mkdirSync(data, { recursive: true })
  return { dir, home, data, site: join(dir, 'site') }
}

function runServer({ home, site }) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, PYTHONPATH: site, PYTHONIOENCODING: 'utf-8' }
  delete env.SUPERTONIC_CACHE_DIR
  const result = spawnSync(python, [join(root, 'python', 'tts_server.py'), '--voice', 'M3'], { env, input: '', encoding: 'utf8', timeout: 60_000 })
  const first = result.stdout.split(/\r?\n/).find((line) => line.trim().startsWith('{'))
  return first ? JSON.parse(first) : { event: 'none', stdout: result.stdout, stderr: result.stderr }
}

test('étape 513 : modèle de la voix derrière une jonction (Jaris) — téléchargé DANS les données de Jaris, la voix démarre', { skip: python ? false : 'Python 3.10+ absent' }, () => {
  const ctx = setup()
  try {
    const link = join(ctx.home, '.cache', 'supertonic3')
    symlinkSync(ctx.data, link, 'junction')
    const answer = runServer(ctx)
    assert.deepEqual(answer, { event: 'ready' }, JSON.stringify(answer))
    assert.equal(readFileSync(join(ctx.data, 'model.onnx'), 'utf8'), 'modele', 'le modèle est dans le dossier de données de Jaris')
    assert.equal(readFileSync(join(link, 'model.onnx'), 'utf8'), 'modele', 'et toujours lisible par la jonction')
    // Second démarrage : rien à retélécharger, toujours prêt.
    assert.deepEqual(runServer(ctx), { event: 'ready' })
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true })
  }
})

test('étape 513 : sans jonction (dossier normal), rien ne change', { skip: python ? false : 'Python 3.10+ absent' }, () => {
  const ctx = setup()
  try {
    assert.deepEqual(runServer(ctx), { event: 'ready' })
    assert.ok(existsSync(join(ctx.home, '.cache', 'supertonic3', 'model.onnx')))
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true })
  }
})

test('étape 513 : le faux Supertonic reste fidèle à la version figée', () => {
  const requirements = readFileSync(join(root, 'python', 'requirements.txt'), 'utf8')
  assert.match(requirements, /^supertonic==1\.3\.1\r?$/m, 'Supertonic a changé de version : relire loader.download_model et mettre ce test à jour')
})
