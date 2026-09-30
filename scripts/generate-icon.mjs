/** Convertit le logo transparent choisi par Léo en icône Windows multirésolution. */
import sharp from 'sharp'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = await Promise.all(sizes.map(size =>
  sharp(join(root, 'assets', 'jaris-logo.png')).resize(size, size).png().toBuffer()
))
const header = Buffer.alloc(6)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(images.length, 4)
let offset = 6 + 16 * images.length
const entries = images.map((png, index) => {
  const entry = Buffer.alloc(16)
  entry[0] = entry[1] = sizes[index] === 256 ? 0 : sizes[index]
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(offset, 12)
  offset += png.length
  return entry
})
const output = join(root, 'build', 'icon.ico')
mkdirSync(dirname(output), { recursive: true })
writeFileSync(output, Buffer.concat([header, ...entries, ...images]))
console.log(`Icône générée : ${output}`)
