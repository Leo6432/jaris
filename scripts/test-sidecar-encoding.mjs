import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'

/**
 * Accents cassés dans les transcriptions (étape 121). Léo, capture d'écran d'un ami (Tom) à l'appui :
 * "◆a marche pas. Ah si, c'est bon. Salut Charisse, ◆a va ?" — soit "Ça marche pas... ça va ?" dont chaque
 * "ç" est arrivé à l'écran en caractère de remplacement.
 *
 * Cause REPRODUITE avant tout correctif (jamais supposée) : Python 3.12 — la série embarquée par Jaris, voir
 * PYTHON_SERIES dans pythonRuntime.ts — choisit l'encodage de `sys.stdout` d'après la PAGE DE CODES Windows
 * quand la sortie est un tube, pas UTF-8. Sur un Windows français ordinaire (cp1252), `json.dumps(...,
 * ensure_ascii=False)` écrit donc "ça" en UN octet 0xE7, alors que Node lit toujours de l'UTF-8 : le
 * caractère devient "�". Invisible sur la machine de Léo (page de codes déjà en UTF-8), d'où un bug qui
 * n'apparaît que chez quelqu'un d'autre — exactement le genre de "ça marche chez moi" qu'un test doit
 * verrouiller une fois pour toutes.
 */

const projectRoot = new URL('..', import.meta.url)
const SIDECARS = ['python/voice_server.py', 'python/tts_server.py']

/** Python n'est pas garanti disponible quand `npm test` tourne (la CI installe le sien APRÈS cette étape) :
 * le test comportemental est alors ignoré avec une raison explicite, jamais silencieusement vert — même
 * convention que Playwright dans les tests navigateur de ce dépôt. */
function findPython() {
  for (const bin of ['python3', 'python']) {
    try {
      if (spawnSync(bin, ['--version']).status === 0) return bin
    } catch {
      continue
    }
  }
  return null
}

const python = findPython()

test('les deux sidecars Python forcent UTF-8 sur stdout ET stderr', () => {
  for (const relative of SIDECARS) {
    const source = readFileSync(new URL(relative, projectRoot), 'utf8')
    assert.ok(
      source.includes('sys.stdout.reconfigure(encoding="utf-8")'),
      `${relative} doit forcer UTF-8 sur stdout, sinon Windows utilise sa page de codes et tout accent arrive en "�"`
    )
    assert.ok(
      source.includes('sys.stderr.reconfigure(encoding="utf-8")'),
      `${relative} doit forcer UTF-8 sur stderr aussi (les diagnostics de debug() sont en français)`
    )
    // Placé AVANT la première écriture : reconfigurer après un premier emit() ne rattraperait pas la ligne
    // déjà partie dans la mauvaise page de codes.
    const reconfigureAt = source.indexOf('sys.stdout.reconfigure')
    const firstWriteAt = source.indexOf('sys.stdout.write')
    assert.ok(
      reconfigureAt !== -1 && (firstWriteAt === -1 || reconfigureAt < firstWriteAt),
      `${relative} doit reconfigurer stdout AVANT toute écriture`
    )
  }
})

test(
  'un accent traverse vraiment le tube Python -> Node, même avec une page de codes Windows (cp1252)',
  { skip: python ? false : 'Python indisponible dans cet environnement' },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jaris-encoding-'))
    // Reproduit EXACTEMENT ce que fait emit() (voice_server.py) : json.dumps(..., ensure_ascii=False) sur
    // stdout, lu côté Node par readline — la vraie chaîne de bout en bout, pas une imitation approximative.
    const script = join(dir, 'emit.py')
    writeFileSync(
      script,
      [
        'import json, sys',
        'sys.stdout.reconfigure(encoding="utf-8")',
        'sys.stdout.write(json.dumps({"event": "transcript", "text": "Ça marche pas. Salut Charisse, ça va ?"}, ensure_ascii=False) + "\\n")',
        'sys.stdout.flush()'
      ].join('\n')
    )

    const received = await new Promise((resolve, reject) => {
      // PYTHONIOENCODING=cp1252 simule la page de codes d'un Windows français : sans le reconfigure du
      // script, c'est exactement ce qui produisait les "�" chez Tom (vérifié en retirant la ligne).
      const proc = spawn(python, [script], { env: { ...process.env, PYTHONIOENCODING: 'cp1252' } })
      const lines = []
      createInterface({ input: proc.stdout }).on('line', (line) => lines.push(line))
      proc.on('error', reject)
      proc.on('close', () => resolve(lines))
    })

    assert.equal(received.length, 1, `une seule ligne JSON attendue, reçu : ${JSON.stringify(received)}`)
    const payload = JSON.parse(received[0])
    assert.equal(
      payload.text,
      'Ça marche pas. Salut Charisse, ça va ?',
      'les accents doivent arriver intacts — un "�" ici, c est le bug de Tom qui revient'
    )
    assert.ok(!payload.text.includes('�'), 'aucun caractère de remplacement ne doit subsister')

    rmSync(dir, { recursive: true, force: true })
  }
)

test('la lecture des micros décode le flux en UTF-8 (un accent peut tomber à cheval sur deux morceaux)', () => {
  const source = readFileSync(new URL('electron/services/voiceClient.ts', projectRoot), 'utf8')
  // Les noms de micros Windows sont pleins d'accents ("Microphone (Réseau)") : accumuler `chunk.toString()`
  // morceau par morceau casse un caractère multi-octets coupé en deux, même quand Python envoie de l'UTF-8
  // parfaitement valide. setEncoding garde l'octet incomplet pour le morceau suivant.
  assert.ok(
    source.includes("proc.stdout.setEncoding('utf8')"),
    'la liste des micros doit être lue avec setEncoding(utf8), jamais accumulée via chunk.toString()'
  )
})
