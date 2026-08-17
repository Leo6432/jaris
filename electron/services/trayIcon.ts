import { deflateSync } from 'zlib'
import { nativeImage, type NativeImage } from 'electron'

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Dessine un simple disque teal (couleur du noyau JarisOrb) sur fond transparent, encodé en PNG à la main
 * (zlib pour la compression, pas de dépendance externe) : sert d'icône pour la barre système, sans avoir
 * besoin d'un fichier d'icône dans le dépôt.
 */
function buildOrbPng(size: number): Buffer {
  const stride = 1 + size * 4
  const raw = Buffer.alloc(size * stride)
  const center = (size - 1) / 2
  const radius = size * 0.42

  for (let y = 0; y < size; y++) {
    const rowStart = y * stride
    raw[rowStart] = 0 // type de filtre PNG "None" pour cette ligne
    for (let x = 0; x < size; x++) {
      const dx = x - center
      const dy = y - center
      const inside = Math.sqrt(dx * dx + dy * dy) <= radius
      const offset = rowStart + 1 + x * 4
      raw[offset] = 0x33
      raw[offset + 1] = 0xe6
      raw[offset + 2] = 0xc8
      raw[offset + 3] = inside ? 255 : 0
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // profondeur : 8 bits par canal
  ihdr[9] = 6 // type de couleur : RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

export function createTrayIcon(): NativeImage {
  return nativeImage.createFromBuffer(buildOrbPng(32))
}
