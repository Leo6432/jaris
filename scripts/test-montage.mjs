import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

/**
 * Montage (étape 189, Léo : « un bouton montage à gauche, pas installé par défaut, qui dit que c'est lourd, et
 * qui fait avec Remotion »). Deux niveaux :
 * - les vérifications pures (code du modèle, durée, erreurs de Remotion, versions figées, CI, empaquetage) ;
 * - un VRAI rendu Remotion de bout en bout : le modèle est simulé (il écrit d'abord un code cassé), mais le
 *   programme de rendu, webpack, le navigateur et l'encodage MP4 sont les vrais — ignoré avec sa raison si le
 *   paquet Montage n'est pas installé localement (cd montage && npm ci), comme dans la CI avant sa construction.
 */
// fileURLToPath et pas `.pathname` : sous Windows, `.pathname` donne « /D:/… », d'où un chemin « D:\D:\… » (CI).
const root = fileURLToPath(new URL('..', import.meta.url))
const nodeRequire = createRequire(import.meta.url)

function compile(path) {
  return ts.transpileModule(readFileSync(join(root, path), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText
}

/** Charge un module TS dans le realm courant avec des dépendances choisies (et un `process` éventuellement remplacé). */
function load(path, deps, proc = process) {
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, module, require, process) { ${compile(path)} })`)(
    module.exports,
    module,
    (name) => {
      if (name in deps) return deps[name]
      return nodeRequire(name)
    },
    proc
  )
  return module.exports
}

const sharedMontage = load('shared/montage.ts', {})

function loadGenerator(overrides = {}) {
  return load('electron/services/montageGenerator.ts', {
    './codeGenerator': {
      GenerationStoppedError: class extends Error {},
      createModelStepRunner: () => async () => ({ role: 'assistant', content: '' }),
      isAbortError: (err) => err?.name === 'AbortError',
      readModelMaxContext: async () => null,
      resolveCodeModel: async () => 'modele-de-test',
      slugify: (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'video'
    },
    './dataLocation': { getDataRoot: () => '/donnees' },
    './montage': { MontageRunnerError: class extends Error {}, getMontageStatus: async () => ({ installed: true, supported: true }), runMontageRunner: async () => {} },
    './profileStore': { getProfile: async () => null },
    '../../shared/montage': sharedMontage,
    ...overrides
  })
}

const GOOD = readFileSync(join(root, 'scripts/fixtures/montage/Video.tsx'), 'utf8')

test('le code du modèle est repris dans son bloc tsx, et refusé s’il n’exporte aucune vidéo', () => {
  const { extractVideoCode } = loadGenerator()
  assert.equal(extractVideoCode(`Voici :\n\`\`\`tsx\n${GOOD}\n\`\`\`\nBonne vidéo !`), GOOD.trim())
  assert.equal(extractVideoCode('```tsx\nconst x = 1\n```'), null)
  assert.equal(extractVideoCode('Je ne sais pas faire.'), null)
})

test('les défauts détectables sont nommés AVANT le rendu (imports, ressources en ligne, animation non filmable)', () => {
  const { validateVideoCode } = loadGenerator()
  assert.deepEqual(validateVideoCode(GOOD), [])
  const bad = [
    "import { AbsoluteFill } from 'remotion'",
    "import confetti from 'canvas-confetti'",
    "import fs from 'fs'",
    'export const Video = () => <AbsoluteFill style={{ opacity: Math.random(), background: "url(https://exemple.com/a.png)", transition: "all 1s" }} />'
  ].join('\n')
  const issues = validateVideoCode(bad).join(' | ')
  assert.match(issues, /imports interdits.*canvas-confetti, fs/)
  assert.match(issues, /ressources en ligne/)
  assert.match(issues, /Math\.random/)
  assert.match(issues, /animations\/transitions CSS/)
  assert.match(validateVideoCode('const Video = () => null').join(), /n'exporte pas la vidéo/)
})

test('la durée vient du code, bornée à 1-300 s, 8 s par défaut ; le point d’entrée est écrit par Jaris', () => {
  const { readDurationSeconds, buildIndexTsx } = loadGenerator()
  assert.equal(readDurationSeconds('export const durationInSeconds = 12'), 12)
  assert.equal(readDurationSeconds('export const durationInSeconds: number = 2.5'), 2.5)
  assert.equal(readDurationSeconds('export const durationInSeconds = 600'), 300)
  // Étape 190 : sans durée écrite, un montage de vidéos dure ce que durent les vidéos jointes.
  assert.equal(readDurationSeconds('export const Video = () => null', 42.5), 42.5)
  assert.equal(readDurationSeconds('export const durationInSeconds = 0'), 1)
  assert.equal(readDurationSeconds('export const Video = () => null'), 8)
  const index = buildIndexTsx(GOOD)
  assert.match(index, /import \{ Video \} from '\.\/Video'/)
  assert.match(index, /durationInFrames=\{60\} fps=\{30\} width=\{1920\} height=\{1080\}/)
  assert.match(buildIndexTsx('export default function X() { return null }'), /import Video from '\.\/Video'/)
  assert.match(buildIndexTsx(GOOD, { width: 1080, height: 1920 }), /width=\{1080\} height=\{1920\}/)
})

// Étape 190 (Léo : « prendre la vidéo, cut, mettre des animations, du texte »).
test('vidéos jointes : le modèle apprend leurs noms, durées et formats, et comment couper', () => {
  const { describeClips, pickFormat } = loadGenerator()
  const text = describeClips([{ file: 'clip1.mp4', name: 'plage.mov', durationSeconds: 42.34, width: 1920, height: 1080 }])
  assert.match(text, /staticFile\('clip1\.mp4'\) : « plage\.mov », 42,3 s, 1920x1080/)
  assert.match(text, /trimBefore=\{Math\.round\(10 \* fps\)\} trimAfter=\{Math\.round\(25 \* fps\)\}/)
  assert.match(text, /tu ne vois pas leurs images/)
  assert.equal(describeClips([]), '')
  assert.deepEqual({ ...pickFormat([]) }, { width: 1920, height: 1080 })
  assert.deepEqual({ ...pickFormat([{ width: 1080, height: 1920 }]) }, { width: 1080, height: 1920 }, 'vidéo de téléphone : montage vertical')
})

test('staticFile : seulement les vidéos réellement jointes, sous leur nom exact', () => {
  const { validateVideoCode } = loadGenerator()
  const use = (name) => `import { OffthreadVideo, staticFile } from 'remotion'\nexport const Video = () => <OffthreadVideo src={staticFile(${name})} />`
  assert.deepEqual(validateVideoCode(use("'clip1.mp4'"), ['clip1.mp4']), [])
  assert.match(validateVideoCode(use("'clip2.mp4'"), ['clip1.mp4']).join(), /n'existent pas \(clip2\.mp4\).*'clip1\.mp4'/)
  assert.match(validateVideoCode(use('nom'), ['clip1.mp4']).join(), /\(nom calculé\)/)
  assert.match(validateVideoCode(use("'clip1.mp4'")).join(), /aucune vidéo jointe/)
})

test('une erreur de Remotion est réduite à la ligne utile, sans chemins du disque ni pile', () => {
  const { summarizeRenderError } = loadGenerator()
  const windows =
    'Module build failed (from ../../montage/node_modules/@remotion/bundler/dist/esbuild-loader/index.js):\n' +
    'Error: Transform failed with 1 error:\n' +
    'C:\\Users\\happy\\AppData\\Roaming\\Jaris\\generated-videos\\1-intro\\Video.tsx:2:49: ERROR: Unexpected closing "AbsoluteFill" tag does not match opening "h1" tag\n' +
    '    at failureErrorWithLog (C:\\Users\\happy\\AppData\\Local\\Jaris\\montage\\node_modules\\esbuild\\lib\\main.js:1748:15)'
  assert.equal(summarizeRenderError(windows), 'Video.tsx:2:49: ERROR: Unexpected closing "AbsoluteFill" tag does not match opening "h1" tag')
  assert.equal(summarizeRenderError('undefinedThing is not defined\n    at Video (/tmp/x/bundle.js:1:1)'), 'undefinedThing is not defined')
})

test('une vidéo à supprimer ou à lire doit être un dossier de vidéos de Jaris, rien d’autre', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'jaris-montage-guard-'))
  try {
    const videos = join(dataRoot, 'generated-videos')
    mkdirSync(join(videos, '1-ok'), { recursive: true })
    writeFileSync(join(videos, '1-ok', 'Video.tsx'), GOOD)
    const { deleteGeneratedVideo, loadGeneratedVideo } = loadGenerator({ './dataLocation': { getDataRoot: () => dataRoot } })
    for (const bad of [videos, dataRoot, join(videos, '..', 'profile.json'), join(videos, '1-ok', 'sous-dossier'), '/etc']) {
      await assert.rejects(deleteGeneratedVideo(bad), /pas une vidéo faite par Jaris/, bad)
    }
    const loaded = await loadGeneratedVideo(join(videos, '1-ok'))
    assert.equal(loaded.hasVideo, false, 'sans video.mp4, la vidéo est annoncée comme non fabriquée')
    await deleteGeneratedVideo(join(videos, '1-ok'))
    assert.equal(existsSync(join(videos, '1-ok')), false)
  } finally {
    rmSync(dataRoot, { recursive: true, force: true })
  }
})

test('Remotion est figé à UNE version partout : constante, paquet, lockfile', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'montage/package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(root, 'montage/package-lock.json'), 'utf8'))
  for (const name of ['remotion', '@remotion/bundler', '@remotion/renderer']) {
    assert.equal(pkg.dependencies[name], sharedMontage.REMOTION_VERSION, name)
    assert.equal(lock.packages[`node_modules/${name}`].version, sharedMontage.REMOTION_VERSION, `${name} (lockfile)`)
  }
  // Les programmes Windows doivent être dans le lockfile : la CI les installe avec `npm ci` sur Windows.
  assert.ok(lock.packages['node_modules/@remotion/compositor-win32-x64-msvc'], 'compositeur Windows (FFmpeg) absent du lockfile')
  assert.equal(sharedMontage.MONTAGE_PACK_ASSET, `Jaris-Montage-remotion-${sharedMontage.REMOTION_VERSION}.zip`)
})

test('le paquet est construit, VÉRIFIÉ par un vrai rendu, puis publié avec chaque Release ; render.cjs est livré avec Jaris', () => {
  const workflow = readFileSync(join(root, '.github/workflows/build-installer.yml'), 'utf8')
  assert.match(workflow, /Push-Location montage\s+npm ci/)
  assert.match(workflow, /Jaris-Montage-remotion-\$version\.zip/)
  assert.match(workflow, /ELECTRON_RUN_AS_NODE = "1"/)
  assert.match(workflow, /action = "render"/)
  assert.equal((workflow.match(/gh release create[^\n]*"\$pack"/g) ?? []).length, 2, 'le paquet doit accompagner les deux créations de Release versionnée')
  const builder = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
  assert.match(builder, /from: montage\s+to: montage\s+filter:\s+- render\.cjs/)
  // Rien de Remotion dans Jaris lui-même : pas installé par défaut, comme demandé.
  const rootPkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.ok(!Object.keys({ ...rootPkg.dependencies, ...rootPkg.devDependencies }).some((dep) => dep.includes('remotion')))
})

// --- Rendu réel -------------------------------------------------------------------------------------------

const packModules = join(root, 'montage/node_modules')
const browserReady = existsSync(join(packModules, '.remotion'))
const realRender = {
  skip: !existsSync(join(packModules, '@remotion/renderer'))
    ? 'paquet Montage non installé ici (cd montage && npm ci)'
    : !browserReady
      ? 'navigateur de rendu absent (node montage/render.cjs sur une tâche ensure-browser)'
      : false,
  timeout: 300_000
}

test('de bout en bout : un code cassé est corrigé grâce à la VRAIE erreur de Remotion, puis la vidéo MP4 est fabriquée', realRender, async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'jaris-montage-e2e-'))
  try {
    const local = join(sandbox, 'local')
    const montageDir = join(local, 'Jaris', 'montage')
    mkdirSync(montageDir, { recursive: true })
    symlinkSync(packModules, join(montageDir, 'node_modules'))
    writeFileSync(join(montageDir, 'package.json'), '{}')
    writeFileSync(join(montageDir, '.installed'), sharedMontage.REMOTION_VERSION)
    const dataRoot = join(sandbox, 'donnees')

    const fakeProcess = Object.create(process, {
      platform: { value: 'win32' },
      env: { value: { ...process.env, LOCALAPPDATA: local } }
    })
    const montage = load(
      'electron/services/montage.ts',
      {
        electron: { app: { getVersion: () => '0.0.0' } },
        './download': { downloadToFile: async () => 0 },
        '../paths': { resourcesRoot: () => root },
        '../../shared/montage': sharedMontage
      },
      fakeProcess
    )
    assert.equal((await montage.getMontageStatus()).installed, true)

    // Le « modèle » : un premier jet avec une balise mal fermée, puis la correction quand on lui montre l'erreur.
    const broken = GOOD.replace('<Title text="JARIS" />', '<h1>JARIS</Title>')
    const prompts = []
    const answers = [`\`\`\`tsx\n${broken}\n\`\`\``, `\`\`\`tsx\n${GOOD}\n\`\`\``]
    const progress = []
    const generator = loadGenerator({
      './codeGenerator': {
        GenerationStoppedError: class extends Error {},
        createModelStepRunner: ({ steps }) => async (label, messages) => {
          steps.index += 1
          prompts.push({ label, content: messages.at(-1).content })
          return { role: 'assistant', content: answers.shift() }
        },
        isAbortError: (err) => err?.name === 'AbortError',
        readModelMaxContext: async () => null,
        resolveCodeModel: async () => 'modele-de-test',
        slugify: () => 'intro-jaris'
      },
      './dataLocation': { getDataRoot: () => dataRoot },
      './montage': montage
    })

    const statuses = []
    const result = await generator.generateMontage('Intro JARIS puis Montage', (m) => statuses.push(m), undefined, {
      onProgress: (p) => progress.push(p)
    })

    assert.equal(result.hasVideo, true)
    assert.equal(result.code, GOOD.trim())
    assert.equal(prompts.length, 2, 'un seul aller-retour de correction')
    assert.equal(prompts[1].label, 'Correction après erreur de Remotion')
    assert.match(prompts[1].content, /Video\.tsx:\d+:\d+: ERROR:/, 'le modèle reçoit la vraie erreur, ligne comprise')
    assert.doesNotMatch(prompts[1].content, new RegExp(sandbox.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'sans chemins du disque')
    assert.ok(statuses.some((s) => /correction automatique \(1\/2\)/.test(s)))

    const mp4 = readFileSync(join(result.path, 'video.mp4'))
    assert.ok(mp4.length > 10_000, `vidéo trop petite (${mp4.length} octets)`)
    assert.equal(mp4.subarray(4, 8).toString('latin1'), 'ftyp', 'un vrai fichier MP4')
    assert.deepEqual(readdirSync(result.path).sort(), ['Video.tsx', 'demande.txt', 'index.tsx', 'montage.json', 'video.mp4'], 'ni bundle ni cache laissés derrière')

    // Deux rendus : le premier a échoué (code cassé), le second a abouti — chacun est une étape à part.
    const lastStep = Math.max(...progress.filter((p) => p.percent !== undefined).map((p) => p.stepIndex))
    const rendering = progress.filter((p) => p.percent !== undefined && p.stepIndex === lastStep)
    assert.ok(rendering.length > 3, 'le rendu donne son avancement')
    assert.equal(rendering.at(-1).stepCount, rendering.at(-1).stepIndex, 'la dernière étape annoncée est bien la dernière')
    assert.equal(rendering.at(-1).percent, 100)
    assert.ok(rendering.every((p, i) => i === 0 || p.percent >= rendering[i - 1].percent), 'jamais en arrière')
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test('« Arrêter » pendant le rendu tue Remotion et ne laisse aucune vidéo à moitié faite', realRender, async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'jaris-montage-stop-'))
  try {
    const local = join(sandbox, 'local')
    const montageDir = join(local, 'Jaris', 'montage')
    mkdirSync(montageDir, { recursive: true })
    symlinkSync(packModules, join(montageDir, 'node_modules'))
    writeFileSync(join(montageDir, 'package.json'), '{}')
    writeFileSync(join(montageDir, '.installed'), sharedMontage.REMOTION_VERSION)
    const dataRoot = join(sandbox, 'donnees')
    const fakeProcess = Object.create(process, {
      platform: { value: 'linux' },
      env: { value: { ...process.env, LOCALAPPDATA: local } }
    })
    const montage = load(
      'electron/services/montage.ts',
      {
        electron: { app: { getVersion: () => '0.0.0' } },
        './download': { downloadToFile: async () => 0 },
        '../paths': { resourcesRoot: () => root },
        '../../shared/montage': sharedMontage
      },
      fakeProcess
    )
    class GenerationStoppedError extends Error {}
    const controller = new AbortController()
    const generator = loadGenerator({
      './codeGenerator': {
        GenerationStoppedError,
        createModelStepRunner: ({ steps }) => async () => {
          steps.index += 1
          return { role: 'assistant', content: `\`\`\`tsx\n${GOOD}\n\`\`\`` }
        },
        isAbortError: (err) => err?.name === 'AbortError',
        readModelMaxContext: async () => null,
        resolveCodeModel: async () => 'modele-de-test',
        slugify: () => 'a-arreter'
      },
      './dataLocation': { getDataRoot: () => dataRoot },
      // getMontageStatus exige Windows : on garde le vrai rendu, mais on déclare le Montage installé.
      './montage': { ...montage, getMontageStatus: async () => ({ installed: true, supported: true }) }
    })
    await assert.rejects(
      generator.generateMontage('à arrêter', () => {}, undefined, {
        signal: controller.signal,
        onProgress: (p) => {
          if (p.percent !== undefined && p.percent > 0) controller.abort()
        }
      }),
      (err) => err instanceof GenerationStoppedError
    )
    assert.deepEqual(readdirSync(join(dataRoot, 'generated-videos')), [], 'la vidéo interrompue ne reste pas dans la liste')
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})

test('monter une VRAIE vidéo : coupée, texte par-dessus, reprise à la modification, fichier de Léo intact', realRender, async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'jaris-montage-clip-'))
  try {
    const local = join(sandbox, 'local')
    const montageDir = join(local, 'Jaris', 'montage')
    mkdirSync(montageDir, { recursive: true })
    symlinkSync(packModules, join(montageDir, 'node_modules'))
    writeFileSync(join(montageDir, 'package.json'), '{}')
    writeFileSync(join(montageDir, '.installed'), sharedMontage.REMOTION_VERSION)
    const dataRoot = join(sandbox, 'donnees')
    const fakeProcess = Object.create(process, {
      platform: { value: 'win32' },
      env: { value: { ...process.env, LOCALAPPDATA: local } }
    })
    const montage = load(
      'electron/services/montage.ts',
      {
        electron: { app: { getVersion: () => '0.0.0' } },
        './download': { downloadToFile: async () => 0 },
        '../paths': { resourcesRoot: () => root },
        '../../shared/montage': sharedMontage
      },
      fakeProcess
    )
    const answers = []
    const prompts = []
    const generator = loadGenerator({
      './codeGenerator': {
        GenerationStoppedError: class extends Error {},
        createModelStepRunner: ({ steps }) => async (_label, messages) => {
          steps.index += 1
          prompts.push(messages.map((m) => m.content).join('\n'))
          return { role: 'assistant', content: answers.shift() }
        },
        isAbortError: (err) => err?.name === 'AbortError',
        readModelMaxContext: async () => null,
        resolveCodeModel: async () => 'modele-de-test',
        slugify: (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
      },
      './dataLocation': { getDataRoot: () => dataRoot },
      './montage': montage
    })

    // La « vidéo de Léo » : une vraie vidéo de 2 s (la vidéo de test fabriquée par Remotion lui-même).
    answers.push(`\`\`\`tsx\n${GOOD}\n\`\`\``)
    const source = await generator.generateMontage('source', () => {})
    const leoFile = join(sandbox, 'Mes vidéos', 'plage.mp4')
    mkdirSync(join(leoFile, '..'), { recursive: true })
    writeFileSync(leoFile, readFileSync(join(source.path, 'video.mp4')))
    const before = readFileSync(leoFile)

    // Lecture réelle de la durée et du format (ce que fait le dialogue « Vidéos »).
    const [meta] = await montage.probeMontageVideos([leoFile])
    assert.ok(Math.abs(meta.durationInSeconds - 2) < 0.2, `durée lue : ${meta.durationInSeconds}`)
    assert.equal(meta.width, 1920)
    assert.equal(meta.height, 1080)

    const edit = [
      "import { AbsoluteFill, OffthreadVideo, Sequence, staticFile, useVideoConfig } from 'remotion'",
      'export const durationInSeconds = 1.5',
      'export const Video = () => {',
      '  const { fps } = useVideoConfig()',
      '  return (',
      '    <AbsoluteFill>',
      "      <OffthreadVideo src={staticFile('clip1.mp4')} trimBefore={Math.round(0.5 * fps)} trimAfter={Math.round(2 * fps)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />",
      "      <AbsoluteFill style={{ justifyContent: 'flex-end', padding: 80 }}><h1 style={{ color: 'white', fontSize: 120 }}>VACANCES</h1></AbsoluteFill>",
      '    </AbsoluteFill>',
      '  )',
      '}'
    ].join('\n')
    answers.push(`\`\`\`tsx\n${edit}\n\`\`\``)
    const clip = { path: leoFile, name: 'plage.mp4', durationSeconds: meta.durationInSeconds, width: meta.width, height: meta.height }
    const edited = await generator.generateMontage('garde de 0:00,5 à la fin, titre VACANCES', () => {}, undefined, { clips: [clip] })

    assert.match(prompts.at(-1), /staticFile\('clip1\.mp4'\) : « plage\.mp4 », 2 s, 1920x1080/, 'le modèle connaît la vidéo jointe')
    assert.deepEqual(edited.clips.map((c) => c.name), ['plage.mp4'])
    assert.ok(existsSync(join(edited.path, 'public', 'clip1.mp4')), 'la vidéo est copiée dans le projet')
    assert.equal(Buffer.compare(readFileSync(leoFile), before), 0, 'le fichier de Léo n’est pas modifié')
    const [out] = await montage.probeMontageVideos([join(edited.path, 'video.mp4')])
    assert.ok(Math.abs(out.durationInSeconds - 1.5) < 0.2, `montage coupé à 1,5 s (lu : ${out.durationInSeconds})`)

    // Modification : la vidéo jointe est reprise sans que Léo la rejoigne.
    answers.push(`\`\`\`tsx\n${edit.replace('VACANCES', 'ÉTÉ 2026')}\n\`\`\``)
    const modified = await generator.generateMontage('titre ÉTÉ 2026', () => {}, edited.code, { previousPath: edited.path })
    assert.match(prompts.at(-1), /staticFile\('clip1\.mp4'\)/)
    assert.ok(existsSync(join(modified.path, 'public', 'clip1.mp4')))
    assert.ok(existsSync(join(edited.path, 'public', 'clip1.mp4')), 'l’ancienne version garde sa vidéo')
    assert.deepEqual((await generator.loadGeneratedVideo(modified.path)).clips.map((c) => c.name), ['plage.mp4'])
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }
})
