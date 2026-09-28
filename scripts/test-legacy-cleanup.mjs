import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * electron/services/legacyCleanup.ts (étape 200) : le Montage est retiré, son paquet Remotion (~600 Mo) est
 * effacé au démarrage — y compris sur l'autre disque s'il avait été déplacé (jonction) —, sans jamais toucher
 * aux vidéos de Léo ni suivre une jonction qui pointerait ailleurs. Sur un VRAI dossier temporaire.
 */
const require = createRequire(import.meta.url)
const source = ts.transpileModule(readFileSync(new URL('../electron/services/legacyCleanup.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText
const module = { exports: {} }
vm.runInThisContext(`(function (exports, require, module, process) { ${source} })`)(module.exports, require, module, process)
const { removeLeftoverMontage, leftoverMontageDir } = module.exports

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'jaris-legacy-'))
  return { root, done: () => rmSync(root, { recursive: true, force: true }) }
}

test('le paquet du Montage est effacé, les vidéos de Léo restent', async () => {
  const { root, done } = sandbox()
  try {
    const dir = leftoverMontageDir(join(root, 'Local'))
    mkdirSync(join(dir, 'node_modules', 'remotion'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'remotion', 'package.json'), '{}')
    const videos = join(root, 'Donnees', 'generated-videos')
    mkdirSync(videos, { recursive: true })
    writeFileSync(join(videos, 'vacances.mp4'), 'video')
    assert.equal(await removeLeftoverMontage(dir), true)
    assert.equal(existsSync(dir), false)
    assert.equal(existsSync(join(videos, 'vacances.mp4')), true)
  } finally {
    done()
  }
})

test('déplacé sur un autre disque : la jonction ET son vrai dossier partent', async () => {
  const { root, done } = sandbox()
  try {
    const moved = join(root, 'D', 'Jaris', 'montage')
    mkdirSync(join(moved, 'node_modules'), { recursive: true })
    writeFileSync(join(moved, 'node_modules', 'gros.bin'), 'x')
    const dir = leftoverMontageDir(join(root, 'Local'))
    mkdirSync(join(dir, '..'), { recursive: true })
    symlinkSync(moved, dir, 'junction')
    assert.equal(await removeLeftoverMontage(dir), true)
    assert.equal(existsSync(dir), false)
    assert.equal(existsSync(moved), false)
  } finally {
    done()
  }
})

test('une jonction qui pointe AILLEURS qu’un dossier « montage » n’est jamais suivie', async () => {
  const { root, done } = sandbox()
  try {
    const precious = join(root, 'D', 'Photos')
    mkdirSync(precious, { recursive: true })
    writeFileSync(join(precious, 'souvenir.jpg'), 'x')
    const dir = leftoverMontageDir(join(root, 'Local'))
    mkdirSync(join(dir, '..'), { recursive: true })
    symlinkSync(precious, dir, 'junction')
    await removeLeftoverMontage(dir)
    assert.equal(existsSync(join(precious, 'souvenir.jpg')), true)
  } finally {
    done()
  }
})

test('rien d’installé : aucune erreur', async () => {
  const { root, done } = sandbox()
  try {
    assert.equal(await removeLeftoverMontage(leftoverMontageDir(join(root, 'Local'))), false)
  } finally {
    done()
  }
})
