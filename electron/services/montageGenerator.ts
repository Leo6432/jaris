import { mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import {
  GenerationStoppedError,
  createModelStepRunner,
  isAbortError,
  readModelMaxContext,
  resolveCodeModel,
  slugify,
  type GenerationSteps
} from './codeGenerator'
import { getDataRoot } from './dataLocation'
import { MontageRunnerError, getMontageStatus, runMontageRunner } from './montage'
import { getProfile } from './profileStore'
import type { OllamaMessage } from './ollama'
import type { CodeGenProgress, GeneratedVideo, GeneratedVideoSummary } from '../../shared/ipc'
import {
  DEFAULT_VIDEO_SECONDS,
  MAX_VIDEO_SECONDS,
  MIN_VIDEO_SECONDS,
  VIDEO_FPS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH
} from '../../shared/montage'

/**
 * Montage (étape 189) : une description devient une vidéo MP4. Le modèle de Code écrit une composition
 * Remotion (React), Jaris la vérifie, puis Remotion la filme image par image (montage.ts, render.cjs).
 *
 * Même principe que le mode Code, dont il réutilise le moteur d'étapes (avancement en direct, bouton
 * « Arrêter ») : ce qui est mécaniquement vérifiable est vérifié AVANT le rendu (imports, ressources en
 * ligne, animations non déterministes), et une erreur réelle de Remotion est renvoyée telle quelle au modèle
 * pour qu'il corrige — deux fois au plus — plutôt que d'abandonner au premier faux pas.
 */

const VIDEO_FILE = 'video.mp4'
const CODE_FILE = 'Video.tsx'
/** Taille attendue d'une composition neuve (les exemples réels font 2 000 à 5 000 caractères). */
const NEW_VIDEO_EXPECTED_CHARS = 6000
/** Réparations après une vraie erreur de Remotion, au plus : au-delà, le modèle tourne en rond. */
const MAX_RENDER_REPAIRS = 2
const PROGRESS_HEARTBEAT_MS = 1000

const MONTAGE_RULES = [
  'Écris UN SEUL fichier TypeScript React (TSX) pour Remotion, qui exporte `export const Video = () => { ... }` ' +
    'et `export const durationInSeconds = N` (un nombre entre 1 et 60, la durée de la vidéo en secondes).',
  "N'importe QUE depuis 'remotion' et 'react' : aucune autre bibliothèque n'est installée.",
  `La vidéo fait ${VIDEO_WIDTH}x${VIDEO_HEIGHT} pixels à ${VIDEO_FPS} images par seconde. Pense en IMAGES : ` +
    'toute animation se calcule à partir de `const frame = useCurrentFrame()` (et `const { fps } = useVideoConfig()`).',
  'Utilise `interpolate(frame, [debut, fin], [valeurDepart, valeurArrivee], { extrapolateLeft: "clamp", ' +
    'extrapolateRight: "clamp" })` pour les fondus et déplacements, `spring({ frame, fps, config: { damping: 200 } })` ' +
    'pour les apparitions souples, `<Sequence from={images} durationInFrames={images}>` pour enchaîner les scènes, ' +
    '`<AbsoluteFill>` comme fond plein écran, et `Easing` pour adoucir.',
  "L'image affichée ne doit dépendre QUE de `frame` : jamais Math.random (utilise `random('graine')` de " +
    "remotion), jamais Date, setTimeout, setInterval, useEffect ni useState pour animer, jamais d'animation ou " +
    'de transition CSS (@keyframes, animation, transition) : Remotion filme chaque image séparément, tout le reste ' +
    'donnerait une vidéo figée ou saccadée.',
  'AUCUNE ressource en ligne : pas d\'URL http, pas d\'image distante, pas de police Google. Polices système ' +
    'uniquement (ex: "Segoe UI, Arial, sans-serif"). Formes et illustrations en <div> stylés ou en SVG inline.',
  'Styles en ligne uniquement (`style={{ ... }}`), aucun fichier CSS. Textes grands et lisibles (titres de 100 px ' +
    'ou plus, textes de 50 px ou plus), contrastés sur leur fond.',
  "Fais EXACTEMENT ce qui est demandé : reprends les textes au mot près, n'ajoute ni scène ni texte en plus."
]

const EXAMPLE = [
  '```tsx',
  "import { AbsoluteFill, Sequence, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion'",
  '',
  'export const durationInSeconds = 6',
  '',
  'const Title = ({ text }: { text: string }) => {',
  '  const frame = useCurrentFrame()',
  '  const { fps } = useVideoConfig()',
  '  const scale = spring({ frame, fps, config: { damping: 200 } })',
  "  const opacity = interpolate(frame, [0, 15], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })",
  '  return (',
  "    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>",
  "      <h1 style={{ color: 'white', fontSize: 140, fontFamily: 'Segoe UI, Arial, sans-serif', transform: `scale(${scale})`, opacity }}>{text}</h1>",
  '    </AbsoluteFill>',
  '  )',
  '}',
  '',
  'export const Video = () => {',
  '  return (',
  "    <AbsoluteFill style={{ background: 'linear-gradient(135deg, #031b3a, #0a4d8c)' }}>",
  '      <Sequence durationInFrames={90}><Title text="Bonjour" /></Sequence>',
  '      <Sequence from={90}><Title text="À bientôt" /></Sequence>',
  '    </AbsoluteFill>',
  '  )',
  '}',
  '```'
].join('\n')

const GENERATE_SYSTEM_PROMPT =
  'Tu es un motion designer expert de Remotion (vidéos écrites en React). Tu écris la composition complète ' +
  "d'une vidéo à partir d'une description en langage naturel.\n\n" +
  `Règles impératives :\n${MONTAGE_RULES.map((r) => `- ${r}`).join('\n')}\n\n` +
  `Exemple de fichier valide (à adapter, pas à recopier) :\n${EXAMPLE}\n\n` +
  'Réponds UNIQUEMENT avec le fichier complet, dans un bloc ```tsx. Aucune explication avant ou après.'

const REPAIR_SYSTEM_PROMPT =
  'Tu répares une composition Remotion (TSX) dont les défauts ont déjà été identifiés. Corrige EXACTEMENT ces ' +
  'problèmes, sans changer le reste de la vidéo.\n\n' +
  `Le fichier réparé doit respecter ces règles :\n${MONTAGE_RULES.map((r) => `- ${r}`).join('\n')}\n\n` +
  'Réponds UNIQUEMENT avec le fichier complet réparé, dans un bloc ```tsx. Aucune explication.'

/** Le code d'un bloc ```tsx/```jsx/```ts (ou brut s'il n'y en a pas), à condition qu'il exporte une vidéo. */
export function extractVideoCode(raw: string): string | null {
  const fences = [...raw.matchAll(/```(?:tsx|jsx|typescript|ts|javascript|js|react)?[^\n]*\n([\s\S]*?)```/gi)].map((m) => m[1].trim())
  const candidates = fences.length ? fences : [raw.trim()]
  return candidates.find((code) => /export\s+(?:const|function)\s+Video\b|export\s+default\b/.test(code)) ?? null
}

/**
 * Défauts détectables sans lancer Remotion, formulés pour être renvoyés tels quels au modèle. Les imports
 * sont limités à 'remotion' et 'react' pour une raison de sécurité autant que de fonctionnement : webpack
 * embarquerait sinon dans la vidéo n'importe quel fichier du disque désigné par le code.
 */
export function validateVideoCode(code: string): string[] {
  const issues: string[] = []
  if (!/export\s+(?:const|function)\s+Video\b/.test(code) && !/export\s+default\b/.test(code)) {
    issues.push('le fichier n\'exporte pas la vidéo : il faut `export const Video = () => { ... }`')
  }
  const imports = [...code.matchAll(/(?:import[\s\S]*?from\s*|import\s*\(\s*|require\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1])
  const bareImports = [...code.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
  const forbidden = [...new Set([...imports, ...bareImports].filter((name) => name !== 'remotion' && name !== 'react'))]
  if (forbidden.length) {
    issues.push(`imports interdits (seuls 'remotion' et 'react' sont installés) : ${forbidden.slice(0, 4).join(', ')}`)
  }
  const urls = [...new Set(code.match(/https?:\/\/[^\s'"`)]+/g) ?? [])]
  if (urls.length) issues.push(`ressources en ligne interdites (la vidéo se fabrique hors ligne) : ${urls.slice(0, 3).join(', ')}`)
  if (/Math\.random\s*\(/.test(code)) issues.push("Math.random rend chaque image différente : utilise random('graine') de remotion")
  if (/\bDate\.now\s*\(|new\s+Date\s*\(/.test(code)) issues.push("l'heure (Date) ne doit pas piloter l'animation : calcule tout depuis useCurrentFrame()")
  if (/\bset(?:Timeout|Interval)\s*\(/.test(code)) issues.push('setTimeout/setInterval ne marchent pas en vidéo : calcule tout depuis useCurrentFrame()')
  if (/@keyframes|\banimation\s*:|\btransition\s*:/.test(code)) {
    issues.push('les animations/transitions CSS ne sont pas filmées par Remotion : calcule chaque style depuis useCurrentFrame() avec interpolate')
  }
  if (/\bstaticFile\s*\(/.test(code)) issues.push("staticFile ne trouve aucun fichier ici : dessine avec des <div> ou du SVG")
  return issues
}

/** `export const durationInSeconds = N`, borné ; la durée par défaut s'il est absent ou illisible. */
export function readDurationSeconds(code: string): number {
  const match = code.match(/export\s+const\s+durationInSeconds\s*(?::\s*number\s*)?=\s*(\d+(?:\.\d+)?)/)
  const value = match ? Number(match[1]) : NaN
  if (!Number.isFinite(value)) return DEFAULT_VIDEO_SECONDS
  return Math.min(MAX_VIDEO_SECONDS, Math.max(MIN_VIDEO_SECONDS, value))
}

/** Point d'entrée Remotion, écrit par Jaris (jamais par le modèle) : format figé, durée lue dans le code. */
export function buildIndexTsx(code: string): string {
  const frames = Math.round(readDurationSeconds(code) * VIDEO_FPS)
  const named = /export\s+(?:const|function)\s+Video\b/.test(code)
  return [
    "import { Composition, registerRoot } from 'remotion'",
    named ? "import { Video } from './Video'" : "import Video from './Video'",
    '',
    `const Root = () => <Composition id="Video" component={Video} durationInFrames={${frames}} fps={${VIDEO_FPS}} width={${VIDEO_WIDTH}} height={${VIDEO_HEIGHT}} />`,
    '',
    'registerRoot(Root)',
    ''
  ].join('\n')
}

/**
 * L'erreur de Remotion, réduite à ce qui aide le modèle : les lignes « ERROR: » d'esbuild (avec numéro de
 * ligne dans Video.tsx), sans chemins du disque ni pile d'appels.
 */
export function summarizeRenderError(message: string): string {
  const cleaned = message.replace(/[A-Za-z]:\\[^\s:]*[\\/]|\/(?:[^\s/:]+\/)+/g, '')
  const errorLines = cleaned
    .split('\n')
    .filter((line) => /ERROR:/.test(line))
    .map((line) => line.trim())
  const text = errorLines.length ? errorLines.join('\n') : cleaned.split('\n').filter((line) => !/^\s*at\s/.test(line)).join('\n')
  return text.trim().slice(0, 800)
}

export function getGeneratedVideosDir(): string {
  return join(getDataRoot(), 'generated-videos')
}

/** Un chemin venu de l'écran : accepté seulement s'il désigne un ENFANT DIRECT du dossier des vidéos. */
function assertVideoDir(path: string): string {
  const root = resolve(getGeneratedVideosDir())
  const target = resolve(path)
  const inside = relative(root, target)
  if (!inside || inside.startsWith('..') || isAbsolute(inside) || inside.includes(sep)) {
    throw new Error("Ce dossier n'est pas une vidéo faite par Jaris : refusé.")
  }
  return target
}

export async function listGeneratedVideos(limit = 30): Promise<GeneratedVideoSummary[]> {
  let entries: string[]
  try {
    entries = await readdir(getGeneratedVideosDir())
  } catch {
    return []
  }
  return entries
    .map((name): GeneratedVideoSummary | null => {
      const match = name.match(/^(\d+)-(.+)$/)
      return match ? { path: join(getGeneratedVideosDir(), name), label: match[2].replace(/-/g, ' '), timestamp: Number(match[1]) } : null
    })
    .filter((summary): summary is GeneratedVideoSummary => summary !== null)
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit)
}

export async function loadGeneratedVideo(path: string): Promise<GeneratedVideo> {
  const dir = assertVideoDir(path)
  const code = await readFile(join(dir, CODE_FILE), 'utf-8')
  const hasVideo = await stat(join(dir, VIDEO_FILE)).then(
    (info) => info.size > 0,
    () => false
  )
  return { path: dir, code, hasVideo }
}

/** Le fichier MP4 d'une vidéo, pour la lire à l'écran (Blob côté fenêtre). */
export async function readGeneratedVideo(path: string): Promise<Buffer> {
  return readFile(join(assertVideoDir(path), VIDEO_FILE))
}

export function generatedVideoFile(path: string): string {
  return join(assertVideoDir(path), VIDEO_FILE)
}

export async function deleteGeneratedVideo(path: string): Promise<void> {
  await rm(assertVideoDir(path), { recursive: true, force: true })
}

export interface GenerateMontageOptions {
  onProgress?: (progress: CodeGenProgress) => void
  signal?: AbortSignal
}

/**
 * Fabrique une vidéo. `currentCode` : modification d'une vidéo existante (son code actuel + la demande) ; le
 * résultat va toujours dans un NOUVEAU dossier, l'ancienne vidéo reste intacte.
 */
export async function generateMontage(
  description: string,
  onStatus: (message: string) => void,
  currentCode?: string,
  options: GenerateMontageOptions = {}
): Promise<GeneratedVideo> {
  const { onProgress, signal } = options
  if (!(await getMontageStatus()).installed) {
    throw new Error("Le Montage n'est pas installé : clique sur « Installer le Montage » d'abord.")
  }

  const profile = await getProfile()
  const model = await resolveCodeModel(onStatus, profile)
  const modelMaxContext = await readModelMaxContext(model)
  // Écriture du code, puis fabrication de la vidéo ; relance et réparations s'ajoutent quand elles arrivent.
  const steps: GenerationSteps = { index: 0, count: 2 }
  const runModelStep = createModelStepRunner({ model, modelMaxContext, steps, onStatus, onProgress, signal })

  const userPrompt = currentCode
    ? `Voici le fichier actuel de la vidéo :\n\n\`\`\`tsx\n${currentCode}\n\`\`\`\n\nModification demandée : ${description}\n\n` +
      'Renvoie le fichier complet modifié, pas seulement les parties changées.'
    : `Vidéo à créer : ${description}`
  const generateMessages: OllamaMessage[] = [
    { role: 'system', content: GENERATE_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ]
  const expectedChars = currentCode ? currentCode.length : NEW_VIDEO_EXPECTED_CHARS

  const first = await runModelStep(currentCode ? 'Modification de la vidéo' : 'Écriture de la vidéo', generateMessages, expectedChars)
  let code = extractVideoCode(first.content)
  if (!code) {
    onStatus('Réponse du modèle inexploitable : nouvelle tentative…')
    steps.count += 1
    const retry = await runModelStep('Nouvelle tentative', [
      ...generateMessages,
      first,
      {
        role: 'user',
        content:
          "Ta réponse ne contient pas de composition Remotion exploitable. Réponds UNIQUEMENT avec le fichier TSX " +
          'complet, dans un bloc ```tsx, qui exporte `export const Video` et `export const durationInSeconds`.'
      }
    ], expectedChars)
    code = extractVideoCode(retry.content)
    if (!code) {
      const preview = retry.content.trim().slice(0, 300)
      throw new Error(
        "Le modèle n'a pas écrit de vidéo exploitable, même après une nouvelle tentative. Reformule ta demande." +
          (preview ? ` Ce qu'il a répondu : "${preview}${retry.content.trim().length > 300 ? '…' : ''}"` : ' Sa réponse était vide.')
      )
    }
  }

  const repair = async (label: string, problems: string[], current: string): Promise<string | null> => {
    steps.count += 1
    const repaired = await runModelStep(
      label,
      [
        { role: 'system', content: REPAIR_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Problèmes détectés :\n${problems.map((p) => `- ${p}`).join('\n')}\n\nFichier à réparer :\n\n\`\`\`tsx\n${current}\n\`\`\``
        }
      ],
      current.length
    )
    return extractVideoCode(repaired.content)
  }

  const issues = validateVideoCode(code)
  if (issues.length) {
    const repaired = await repair('Correction du code', issues, code)
    if (repaired && validateVideoCode(repaired).length < issues.length) code = repaired
  }

  const dir = join(getGeneratedVideosDir(), `${Date.now()}-${slugify(description)}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'demande.txt'), description, 'utf-8')

  try {
    for (let attempt = 0; ; attempt += 1) {
      await writeFile(join(dir, CODE_FILE), code, 'utf-8')
      await writeFile(join(dir, 'index.tsx'), buildIndexTsx(code), 'utf-8')
      try {
        await renderStep(dir, steps, onProgress, signal)
        return { path: dir, code, hasVideo: true }
      } catch (err) {
        if (isAbortError(err)) throw new GenerationStoppedError()
        if (!(err instanceof MontageRunnerError) || err.stage === 'browser') throw err
        const summary = summarizeRenderError(err.message)
        if (attempt >= MAX_RENDER_REPAIRS) {
          throw new Error(`Remotion n'a pas réussi à fabriquer la vidéo, même après ${MAX_RENDER_REPAIRS} corrections. Dernière erreur : ${summary}`)
        }
        onStatus(`Remotion a signalé une erreur dans le code, correction automatique (${attempt + 1}/${MAX_RENDER_REPAIRS})…`)
        const repaired = await repair('Correction après erreur de Remotion', [`Remotion a échoué avec cette erreur : ${summary}`], code)
        if (!repaired) throw new Error(`Remotion n'a pas réussi à fabriquer la vidéo : ${summary}`)
        code = repaired
        // Le nouveau rendu est une étape de plus : jamais une « étape 4 sur 3 » à l'écran.
        steps.count += 1
      }
    }
  } catch (err) {
    // Une vidéo qui n'a pas pu être fabriquée ne reste pas dans la liste, où elle ne montrerait rien.
    await rm(dir, { recursive: true, force: true })
    throw err
  }
}

/** Le rendu, avec le même signe de vie que les étapes du modèle : pourcentage + temps depuis le dernier progrès. */
async function renderStep(
  dir: string,
  steps: GenerationSteps,
  onProgress: GenerateMontageOptions['onProgress'],
  signal: AbortSignal | undefined
): Promise<void> {
  steps.index += 1
  const stepIndex = steps.index
  let percent = 0
  let lastActivity = Date.now()
  const emit = (): void =>
    onProgress?.({
      label: 'Fabrication de la vidéo (Remotion)',
      stepIndex,
      stepCount: steps.count,
      charsWritten: 0,
      thinking: false,
      idleMs: Date.now() - lastActivity,
      percent
    })
  emit()
  const heartbeat = setInterval(emit, PROGRESS_HEARTBEAT_MS)
  try {
    await runMontageRunner(
      { action: 'render', projectDir: dir, output: join(dir, VIDEO_FILE) },
      (stage, progress) => {
        // Préparation du code : 0-10 % ; filmage image par image : 10-100 %.
        const next = Math.round(stage === 'bundle' ? progress * 10 : 10 + progress * 90)
        if (next !== percent) {
          percent = next
          lastActivity = Date.now()
          emit()
        }
      },
      signal
    )
  } finally {
    clearInterval(heartbeat)
  }
}
