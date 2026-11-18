#!/usr/bin/env node
/**
 * Génère build/icon.ico depuis le vrai logo (assets/jaris-logo.png, cadrage assets/icon-frame.json) — étape 224.
 *
 * Léo : « le logo de l'application bug ». Deux causes :
 *  - la fenêtre recevait le logo en 1008×1008 px et laissait Windows le réduire lui-même en 16-32 px, avec un
 *    rééchantillonnage grossier qui transforme les anneaux fins en motif bruité ;
 *  - les petites tailles du .ico étaient rangées en PNG ; elles sont maintenant en bitmap classique, lu partout.
 * Ici, chaque taille que Windows demande est calculée À L'AVANCE avec un vrai filtre (Lanczos), puis rangée dans
 * un seul .ico : Windows n'a plus qu'à choisir la bonne, jamais à réduire.
 *
 * Lancé par `npm run dist` (build/ n'est pas dans Git) ; en dev, à lancer une fois pour voir la vraie icône.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const sharp = require('sharp')
/** Tailles utilisées par Windows : barre des tâches, titre, Alt+Tab, explorateur, bureau (avec mise à l'échelle). */
export const ICON_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]

/** Image d'icône au format bitmap (DIB 32 bits BGRA, lignes de bas en haut, masque AND vide). */
export function toDib(rgba, size) {
  const header = Buffer.alloc(40)
  header.writeUInt32LE(40, 0)
  header.writeInt32LE(size, 4)
  header.writeInt32LE(size * 2, 8) // hauteur doublée : image + masque, convention des icônes
  header.writeUInt16LE(1, 12)
  header.writeUInt16LE(32, 14)
  header.writeUInt32LE(0, 16)
  header.writeUInt32LE(size * size * 4, 20)
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = (y * size + x) * 4
      const to = ((size - 1 - y) * size + x) * 4
      pixels[to] = rgba[from + 2]
      pixels[to + 1] = rgba[from + 1]
      pixels[to + 2] = rgba[from]
      pixels[to + 3] = rgba[from + 3]
    }
  }
  const maskRow = Math.ceil(size / 32) * 4
  return Buffer.concat([header, pixels, Buffer.alloc(maskRow * size)])
}

export async function buildIco(logoPath, frame) {
  const square = await sharp(logoPath)
    .extract({ left: frame.left, top: frame.top, width: frame.width, height: frame.height })
    .png()
    .toBuffer()
  const images = []
  for (const size of ICON_SIZES) {
    const resized = sharp(square).resize(size, size, { kernel: 'lanczos3' })
    // 256 px en PNG (seul format prévu par Windows à cette taille) ; les autres en bitmap classique, que tous
    // les outils lisent — dont NSIS, qui fabrique l'installeur.
    const data =
      size >= 256 ? await resized.png({ compressionLevel: 9 }).toBuffer() : toDib(await resized.ensureAlpha().raw().toBuffer(), size)
    images.push({ size, png: data })
  }
  // Format ICO : en-tête (6 octets), un répertoire de 16 octets par image, puis les images.
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)
  let offset = 6 + 16 * images.length
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(size >= 256 ? 0 : size, 0)
    entry.writeUInt8(size >= 256 ? 0 : size, 1)
    entry.writeUInt8(0, 2)
    entry.writeUInt8(0, 3)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    offset += png.length
    return entry
  })
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

export function readIconFrame() {
  return JSON.parse(readFileSync(join(root, 'assets', 'icon-frame.json'), 'utf8').replace(/^\uFEFF/, ''))
}

export function logoPath() {
  return join(root, 'assets', 'jaris-logo.png')
}

/**
 * Étape 491 : les logos du paquet Microsoft Store (build/appx/, lus par electron-builder). Sans eux, le Store
 * afficherait les logos d'exemple d'electron-builder. Mêmes noms et tailles que ceux attendus par le manifeste.
 */
export const APPX_LOGOS = [
  { name: 'StoreLogo.png', width: 50, height: 50 },
  { name: 'Square44x44Logo.png', width: 44, height: 44 },
  { name: 'Square150x150Logo.png', width: 150, height: 150 },
  { name: 'Wide310x150Logo.png', width: 310, height: 150 },
  // Étape 496 (Léo, version Store : « en bas le logo est bizarre », un carré violet) : sans version « unplated »,
  // Windows peint la couleur d'accent derrière l'icône de la barre des tâches et du menu Démarrer. Ces fichiers
  // (tailles cibles de la documentation « App icon construction » de Microsoft) lui disent de l'afficher sans fond ;
  // « lightunplated » pour le thème clair. electron-builder les indexe (makepri) dès qu'un nom porte « targetsize- ».
  ...[16, 24, 32, 48, 256].flatMap((size) =>
    ['unplated', 'lightunplated'].map((form) => ({ name: `Square44x44Logo.targetsize-${size}_altform-${form}.png`, width: size, height: size }))
  )
]

export async function buildAppxLogos(logoPath, frame) {
  const square = await sharp(logoPath)
    .extract({ left: frame.left, top: frame.top, width: frame.width, height: frame.height })
    .png()
    .toBuffer()
  const logos = []
  for (const { name, width, height } of APPX_LOGOS) {
    const side = Math.min(width, height)
    const logo = await sharp(square).resize(side, side, { kernel: 'lanczos3' }).png().toBuffer()
    // Logo carré au centre ; le reste transparent (le Store peint la couleur du thème derrière).
    const png = await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: logo, left: Math.round((width - side) / 2), top: Math.round((height - side) / 2) }])
      .png({ compressionLevel: 9 })
      .toBuffer()
    logos.push({ name, png })
  }
  return logos
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const ico = await buildIco(logoPath(), readIconFrame())
  const output = join(root, 'build', 'icon.ico')
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, ico)
  console.log(`build/icon.ico : ${ICON_SIZES.length} tailles (${ICON_SIZES.join(', ')} px), ${ico.length} octets.`)
  const appxDir = join(root, 'build', 'appx')
  mkdirSync(appxDir, { recursive: true })
  for (const { name, png } of await buildAppxLogos(logoPath(), readIconFrame())) writeFileSync(join(appxDir, name), png)
  console.log(`build/appx : ${APPX_LOGOS.map((l) => l.name).join(', ')}.`)
}
