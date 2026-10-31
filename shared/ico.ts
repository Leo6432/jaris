/**
 * Étape 396 : fichier .ico à partir d'images PNG (une par taille). Windows accepte des PNG dans un .ico depuis Vista.
 * En-tête de 6 octets, une entrée de 16 octets par taille (256 s'écrit 0), puis les PNG à la suite.
 */
export interface IcoImage {
  size: number
  png: Uint8Array
}

export function encodeIco(images: IcoImage[]): Uint8Array {
  const headerSize = 6 + 16 * images.length
  const total = headerSize + images.reduce((sum, image) => sum + image.png.length, 0)
  const out = new Uint8Array(total)
  const view = new DataView(out.buffer)
  view.setUint16(0, 0, true)
  view.setUint16(2, 1, true) // 1 = icône
  view.setUint16(4, images.length, true)
  let offset = headerSize
  images.forEach((image, i) => {
    if (image.size < 1 || image.size > 256) throw new Error(`Taille d'icône impossible : ${image.size}`)
    const entry = 6 + 16 * i
    out[entry] = image.size === 256 ? 0 : image.size
    out[entry + 1] = image.size === 256 ? 0 : image.size
    view.setUint16(entry + 4, 1, true) // plans
    view.setUint16(entry + 6, 32, true) // bits par pixel
    view.setUint32(entry + 8, image.png.length, true)
    view.setUint32(entry + 12, offset, true)
    out.set(image.png, offset)
    offset += image.png.length
  })
  return out
}
