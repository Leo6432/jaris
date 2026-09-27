import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'path'
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

/** Format de la vidéo finale : paysage 1920x1080 par défaut, portrait 1080x1920 si la 1re vidéo jointe l'est. */
export interface VideoFormat {
  width: number
  height: number
}

/** Une vidéo de Léo rangée dans le projet (`public/<file>`), telle que le modèle la connaît. */
export interface ProjectClip {
  file: string
  /** Nom d'origine, pour que Léo puisse la désigner (« la vidéo de la plage »). */
  name: string
  durationSeconds: number
  width: number
  height: number
}

/** Une vidéo choisie par Léo, pas encore copiée dans un projet. */
export interface SourceClip {
  path: string
  name: string
  durationSeconds: number
  width: number
  height: number
}

/** Ce que le projet retient à côté du code (`montage.json`) : format et vidéos jointes. */
interface ProjectInfo {
  format: VideoFormat
  clips: ProjectClip[]
}

const PROJECT_INFO_FILE = 'montage.json'

export function pickFormat(clips: Array<{ width: number; height: number }>): VideoFormat {
  const first = clips[0]
  return first && first.height > first.width
    ? { width: VIDEO_HEIGHT, height: VIDEO_WIDTH }
    : { width: VIDEO_WIDTH, height: VIDEO_HEIGHT }
}

/** « 42,3 s », pour le modèle comme pour l'écran. */
export function formatSeconds(seconds: number): string {
  return `${(Math.round(seconds * 10) / 10).toLocaleString('fr-FR')} s`
}

function montageRules(format: VideoFormat, hasClips: boolean): string[] {
  return [
    'Écris UN SEUL fichier TypeScript React (TSX) pour Remotion, qui exporte `export const Video = () => { ... }` ' +
      `et \`export const durationInSeconds = N\` (la durée totale de la vidéo en secondes, entre ${MIN_VIDEO_SECONDS} et ` +
      `${MAX_VIDEO_SECONDS}${hasClips ? ' : la somme des passages gardés et des écrans ajoutés' : ' ; 5 à 20 s suffisent pour une animation'}).`,
    "N'importe QUE depuis 'remotion' et 'react' : aucune autre bibliothèque n'est installée.",
    `La vidéo fait ${format.width}x${format.height} pixels à ${VIDEO_FPS} images par seconde. Pense en IMAGES : ` +
      'toute animation se calcule à partir de `const frame = useCurrentFrame()` (et `const { fps } = useVideoConfig()`).',
    'Utilise `interpolate(frame, [debut, fin], [valeurDepart, valeurArrivee], { extrapolateLeft: "clamp", ' +
      'extrapolateRight: "clamp" })` pour les fondus et déplacements, `spring({ frame, fps, config: { damping: 200 } })` ' +
      'pour les apparitions souples, `<Sequence from={images} durationInFrames={images}>` pour enchaîner les scènes, ' +
      '`<AbsoluteFill>` comme fond plein écran, et `Easing` pour adoucir.',
    "L'image affichée ne doit dépendre QUE de `frame` : jamais Math.random (utilise `random('graine')` de " +
      "remotion), jamais Date, setTimeout, setInterval, useEffect ni useState pour animer, jamais d'animation ou " +
      'de transition CSS (@keyframes, animation, transition) : Remotion filme chaque image séparément, tout le reste ' +
      'donnerait une vidéo figée ou saccadée.',
    hasClips
      ? "AUCUNE ressource en ligne ni aucun autre fichier que les vidéos listées plus bas (via `staticFile('...')`). " +
        'Polices système uniquement (ex: "Segoe UI, Arial, sans-serif").'
      : 'AUCUNE ressource en ligne : pas d\'URL http, pas d\'image distante, pas de police Google, pas de staticFile. ' +
        'Polices système uniquement (ex: "Segoe UI, Arial, sans-serif"). Formes et illustrations en <div> stylés ou en SVG inline.',
    'Styles en ligne uniquement (`style={{ ... }}`), aucun fichier CSS. Textes grands et lisibles (titres de 100 px ' +
      'ou plus, textes de 50 px ou plus), contrastés sur leur fond (ombre portée ou bandeau sombre par-dessus une vidéo).',
    "Fais EXACTEMENT ce qui est demandé : reprends les textes au mot près, n'ajoute ni scène ni texte en plus."
  ]
}

/**
 * Étape 190 (Léo : « prendre la vidéo, cut, mettre des animations, du texte ») : ce que le modèle sait des
 * vidéos jointes — il ne voit pas leurs images, seulement leur nom, leur durée et leur format. C'est à Léo de
 * dire quels passages garder.
 */
export function describeClips(clips: ProjectClip[]): string {
  if (!clips.length) return ''
  const list = clips
    .map((clip) => `- staticFile('${clip.file}') : « ${clip.name} », ${formatSeconds(clip.durationSeconds)}, ${clip.width}x${clip.height}`)
    .join('\n')
  return (
    `Vidéos de l'utilisateur, déjà disponibles (tu ne vois pas leurs images : fie-toi à ses indications) :\n${list}\n\n` +
    "Pour en montrer un passage : `<Sequence from={debutDansLeMontage} durationInFrames={dureeDuPassage}><OffthreadVideo " +
    "src={staticFile('clip1.mp4')} trimBefore={Math.round(10 * fps)} trimAfter={Math.round(25 * fps)} " +
    "style={{ width: '100%', height: '100%', objectFit: 'cover' }} /></Sequence>` garde de 10 s à 25 s de clip1 " +
    '(en images : secondes × 30). `OffthreadVideo` et `staticFile` s\'importent depuis remotion. Le son de la vidéo est ' +
    'gardé. Place le texte et les animations dans un `<AbsoluteFill>` PAR-DESSUS la vidéo. Sans indication de coupe, ' +
    "garde la vidéo entière. N'invente aucun autre fichier."
  )
}

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

function generateSystemPrompt(format: VideoFormat, clips: ProjectClip[]): string {
  const rules = montageRules(format, clips.length > 0)
  return (
    'Tu es un monteur vidéo et motion designer expert de Remotion (vidéos écrites en React). Tu écris la ' +
    "composition complète d'une vidéo à partir d'une description en langage naturel.\n\n" +
    `Règles impératives :\n${rules.map((r) => `- ${r}`).join('\n')}\n\n` +
    (clips.length ? `${describeClips(clips)}\n\n` : '') +
    `Exemple de fichier valide (à adapter, pas à recopier) :\n${EXAMPLE}\n\n` +
    'Réponds UNIQUEMENT avec le fichier complet, dans un bloc ```tsx. Aucune explication avant ou après.'
  )
}

function repairSystemPrompt(format: VideoFormat, clips: ProjectClip[]): string {
  const rules = montageRules(format, clips.length > 0)
  return (
    'Tu répares une composition Remotion (TSX) dont les défauts ont déjà été identifiés. Corrige EXACTEMENT ces ' +
    'problèmes, sans changer le reste de la vidéo.\n\n' +
    `Le fichier réparé doit respecter ces règles :\n${rules.map((r) => `- ${r}`).join('\n')}\n\n` +
    (clips.length ? `${describeClips(clips)}\n\n` : '') +
    'Réponds UNIQUEMENT avec le fichier complet réparé, dans un bloc ```tsx. Aucune explication.'
  )
}

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
export function validateVideoCode(code: string, clipFiles: string[] = []): string[] {
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
  // Étape 190 : staticFile n'est permis que pour les vidéos réellement jointes, sous leur nom exact.
  const requested = [...code.matchAll(/\bstaticFile\s*\(\s*(?:['"`]([^'"`]*)['"`])?/g)].map((m) => m[1] ?? '')
  const unknown = [...new Set(requested.filter((name) => !clipFiles.includes(name)))]
  if (unknown.length) {
    issues.push(
      clipFiles.length
        ? `staticFile désigne des fichiers qui n'existent pas (${unknown.map((n) => n || '(nom calculé)').join(', ')}) : seuls ${clipFiles.map((f) => `'${f}'`).join(', ')} sont disponibles, écrits en toutes lettres`
        : 'staticFile ne trouve aucun fichier ici (aucune vidéo jointe) : dessine avec des <div> ou du SVG'
    )
  }
  return issues
}

/**
 * `export const durationInSeconds = N`, borné. Absent ou illisible : `fallback` (la durée totale des vidéos
 * jointes quand il y en a, sinon la durée par défaut d'une animation).
 */
export function readDurationSeconds(code: string, fallback = DEFAULT_VIDEO_SECONDS): number {
  const match = code.match(/export\s+const\s+durationInSeconds\s*(?::\s*number\s*)?=\s*(\d+(?:\.\d+)?)/)
  const value = match ? Number(match[1]) : fallback
  if (!Number.isFinite(value)) return DEFAULT_VIDEO_SECONDS
  return Math.min(MAX_VIDEO_SECONDS, Math.max(MIN_VIDEO_SECONDS, value))
}

/** Point d'entrée Remotion, écrit par Jaris (jamais par le modèle) : format du projet, durée lue dans le code. */
export function buildIndexTsx(code: string, format: VideoFormat = { width: VIDEO_WIDTH, height: VIDEO_HEIGHT }, fallbackSeconds?: number): string {
  const frames = Math.round(readDurationSeconds(code, fallbackSeconds) * VIDEO_FPS)
  const named = /export\s+(?:const|function)\s+Video\b/.test(code)
  return [
    "import { Composition, registerRoot } from 'remotion'",
    named ? "import { Video } from './Video'" : "import Video from './Video'",
    '',
    `const Root = () => <Composition id="Video" component={Video} durationInFrames={${frames}} fps={${VIDEO_FPS}} width={${format.width}} height={${format.height}} />`,
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

/** `montage.json` d'un projet ; un projet d'avant l'étape 190 n'en a pas : paysage, sans vidéo jointe. */
async function readProjectInfo(dir: string): Promise<ProjectInfo> {
  try {
    const info = JSON.parse(await readFile(join(dir, PROJECT_INFO_FILE), 'utf-8')) as ProjectInfo
    return { format: info.format ?? pickFormat([]), clips: Array.isArray(info.clips) ? info.clips : [] }
  } catch {
    return { format: pickFormat([]), clips: [] }
  }
}

export async function loadGeneratedVideo(path: string): Promise<GeneratedVideo> {
  const dir = assertVideoDir(path)
  const code = await readFile(join(dir, CODE_FILE), 'utf-8')
  const hasVideo = await stat(join(dir, VIDEO_FILE)).then(
    (info) => info.size > 0,
    () => false
  )
  const { clips } = await readProjectInfo(dir)
  return { path: dir, code, hasVideo, clips: clips.map(({ name, durationSeconds }) => ({ name, durationSeconds })) }
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
  /** Étape 190 : vidéos de Léo à monter (déjà vérifiées et mesurées par le main). */
  clips?: SourceClip[]
  /** Projet modifié : ses vidéos déjà jointes sont reprises dans le nouveau projet. */
  previousPath?: string
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

  // Vidéos du projet : celles du projet modifié (reprises telles quelles), puis les nouvelles, numérotées à la
  // suite. Le nom de fichier dans le projet est choisi par Jaris, jamais repris du disque de Léo.
  const previousDir = options.previousPath ? assertVideoDir(options.previousPath) : null
  const previous = previousDir ? await readProjectInfo(previousDir) : null
  const kept = previous?.clips ?? []
  const added = (options.clips ?? []).map((clip, index): ProjectClip & { source: string } => ({
    file: `clip${kept.length + index + 1}${(extname(clip.path) || '.mp4').toLowerCase()}`,
    name: clip.name,
    durationSeconds: clip.durationSeconds,
    width: clip.width,
    height: clip.height,
    source: clip.path
  }))
  const clips: ProjectClip[] = [...kept, ...added.map(({ source: _source, ...clip }) => clip)]
  const format = previous?.clips.length ? previous.format : pickFormat(clips)
  const totalClipSeconds = clips.reduce((sum, clip) => sum + clip.durationSeconds, 0)

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
    { role: 'system', content: generateSystemPrompt(format, clips) },
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
        { role: 'system', content: repairSystemPrompt(format, clips) },
        {
          role: 'user',
          content: `Problèmes détectés :\n${problems.map((p) => `- ${p}`).join('\n')}\n\nFichier à réparer :\n\n\`\`\`tsx\n${current}\n\`\`\``
        }
      ],
      current.length
    )
    return extractVideoCode(repaired.content)
  }

  const clipFiles = clips.map((clip) => clip.file)
  const issues = validateVideoCode(code, clipFiles)
  if (issues.length) {
    const repaired = await repair('Correction du code', issues, code)
    if (repaired && validateVideoCode(repaired, clipFiles).length < issues.length) code = repaired
  }

  const dir = join(getGeneratedVideosDir(), `${Date.now()}-${slugify(description)}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'demande.txt'), description, 'utf-8')

  try {
    if (clips.length) {
      // Copiées (jamais déplacées) : les fichiers de Léo restent où ils sont, et l'ancien projet garde les siens.
      onStatus(clips.length === 1 ? 'Copie de ta vidéo dans le projet…' : `Copie de tes ${clips.length} vidéos dans le projet…`)
      await mkdir(join(dir, 'public'), { recursive: true })
      for (const clip of kept) await copyFile(join(previousDir!, 'public', clip.file), join(dir, 'public', clip.file))
      for (const clip of added) await copyFile(clip.source, join(dir, 'public', clip.file))
    }
    await writeFile(join(dir, PROJECT_INFO_FILE), JSON.stringify({ format, clips } satisfies ProjectInfo, null, 2), 'utf-8')

    for (let attempt = 0; ; attempt += 1) {
      await writeFile(join(dir, CODE_FILE), code, 'utf-8')
      await writeFile(join(dir, 'index.tsx'), buildIndexTsx(code, format, totalClipSeconds || undefined), 'utf-8')
      try {
        await renderStep(dir, steps, onProgress, signal)
        return { path: dir, code, hasVideo: true, clips: clips.map(({ name, durationSeconds }) => ({ name, durationSeconds })) }
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
