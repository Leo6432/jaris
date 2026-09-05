/**
 * Génère `build/icon.ico`, l'icône de l'application installée (fenêtre, barre des tâches, menu Démarrer,
 * raccourci bureau et installeur — voir electron-builder.yml).
 *
 * Dessinée par code plutôt que stockée comme fichier binaire dans le dépôt, exactement pour la même raison
 * que l'icône de la barre système (electron/services/trayIcon.ts) : un dépôt sans binaire opaque, une
 * icône modifiable en changeant deux constantes ici, et rien à réexporter depuis un logiciel de dessin.
 * Lancé automatiquement avant chaque `npm run dist` (voir package.json).
 */
import { deflateSync } from 'zlib'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const SIZE = 256
/** Teal du noyau de JarisOrb (voir src/components/JarisOrb.tsx), la couleur d'identité de Jaris. */
const TEAL = [55, 226, 255]

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

/**
 * Couverture d'un pixel par un disque/anneau, entre 0 et 1 : au lieu d'un pixel soit plein soit vide (bords
 * en escalier, très visible sur un cercle), on mesure de combien la distance au centre dépasse le rayon,
 * ce qui donne un bord lissé (antialiasing) sur environ un pixel.
 */
function coverage(distance, radius) {
  return Math.min(1, Math.max(0, radius + 0.5 - distance))
}

/** Orbe Jaris : un anneau fin et un noyau plein au centre, sur fond transparent. */
function drawOrb() {
  const pixels = Buffer.alloc(SIZE * SIZE * 4)
  const center = (SIZE - 1) / 2
  const ringOuter = SIZE * 0.47
  const ringInner = SIZE * 0.38
  const coreRadius = SIZE * 0.2

  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const distance = Math.hypot(x - center, y - center)
      // L'anneau est la partie du grand disque à laquelle on retire le disque intérieur : les deux bords
      // sont lissés séparément, sinon l'intérieur de l'anneau redeviendrait net alors que l'extérieur non.
      const ring = coverage(distance, ringOuter) * (1 - coverage(distance, ringInner))
      const core = coverage(distance, coreRadius)
      const alpha = Math.min(1, ring + core)
      const offset = (y * SIZE + x) * 4
      pixels[offset] = TEAL[0]
      pixels[offset + 1] = TEAL[1]
      pixels[offset + 2] = TEAL[2]
      pixels[offset + 3] = Math.round(alpha * 255)
    }
  }
  return pixels
}

function encodePng(pixels) {
  // Chaque ligne d'un PNG est précédée d'un octet de filtre : 0 = aucun filtre, le plus simple et
  // largement suffisant ici (l'image fait quelques Ko une fois compressée).
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0
    pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // 8 bits par canal
  ihdr[9] = 6 // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * Enveloppe le PNG dans un conteneur .ico. Windows accepte depuis Vista une image PNG telle quelle à
 * l'intérieur d'un .ico (plutôt que l'ancien format bitmap + masque), ce qui évite d'avoir à réencoder
 * l'image une seconde fois dans un format différent.
 */
function wrapAsIco(png) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // réservé
  header.writeUInt16LE(1, 2) // 1 = icône (2 = curseur)
  header.writeUInt16LE(1, 4) // une seule image dans le fichier

  const entry = Buffer.alloc(16)
  entry[0] = SIZE >= 256 ? 0 : SIZE // 0 signifie 256 : la largeur tient sur un seul octet
  entry[1] = SIZE >= 256 ? 0 : SIZE
  entry.writeUInt16LE(1, 4) // plans de couleur
  entry.writeUInt16LE(32, 6) // bits par pixel
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(header.length + entry.length, 12)

  return Buffer.concat([header, entry, png])
}

const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.ico')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, wrapAsIco(encodePng(drawOrb())))
console.log(`Icône générée : ${outPath}`)
