/**
 * Pièce jointe image du Chat et du mode Code (étape 91).
 *
 * Le fichier choisi par Léo n'est JAMAIS envoyé tel quel : une photo de téléphone ou une capture 4K pèse
 * plusieurs mégaoctets, qui devraient traverser l'IPC puis être encodés en base64 (+33%) avant d'arriver au
 * modèle de vision — pour un gain nul. `vision.ts` réduit déjà ses captures d'écran à 1280px de large pour
 * exactement cette raison ("une résolution plus modeste suffit largement à lire du texte ou décrire une
 * fenêtre") : la même limite est reprise ici pour que les deux chemins vers le modèle de vision (capture
 * d'écran et image jointe) lui envoient des images de taille comparable.
 */
export const MAX_IMAGE_WIDTH = 1280

/** Formats acceptés par le sélecteur de fichier ET par le collage/glisser-déposer. */
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp']

export interface ImageAttachment {
  /** Pour l'aperçu dans l'interface (`<img src>`), jamais envoyé au modèle tel quel. */
  dataUrl: string
  /** Uniquement les octets encodés, sans le préfixe `data:image/...;base64,` : ce qu'attend Ollama. */
  base64: string
  /** Nom du fichier d'origine, affiché sous l'aperçu (vide pour une image collée). */
  name: string
}

/**
 * Taille de rendu d'une image pour qu'elle tienne dans `max` de large SANS jamais l'agrandir : une petite
 * image (icône, capture d'une fenêtre étroite) doit rester à sa taille d'origine plutôt qu'être étirée, ce
 * qui n'ajouterait aucun détail pour le modèle tout en gonflant le poids envoyé.
 *
 * Fonction pure, séparée du reste (qui a besoin d'un vrai `canvas`, donc d'un navigateur) précisément pour
 * être testable directement — scripts/test-image-attachment.mjs.
 */
export function computeScaledSize(
  width: number,
  height: number,
  max: number = MAX_IMAGE_WIDTH
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error("Dimensions d'image invalides.")
  }
  if (width <= max) return { width: Math.round(width), height: Math.round(height) }
  return { width: max, height: Math.max(1, Math.round((height / width) * max)) }
}

/** Vrai si ce fichier/ce presse-papier contient une image que le modèle de vision saura lire. */
export function isSupportedImageType(type: string): boolean {
  return ACCEPTED_IMAGE_TYPES.includes(type.toLowerCase())
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error("Ce fichier n'a pas pu être lu comme une image."))
    image.src = dataUrl
  })
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error("Ce fichier n'a pas pu être lu."))
    reader.readAsDataURL(file)
  })
}

/**
 * Lit un fichier image, le réduit si besoin (voir MAX_IMAGE_WIDTH) et renvoie de quoi l'afficher ET
 * l'envoyer. Ré-encodé en JPEG : le modèle de vision se moque de la transparence, et un JPEG de qualité 0,85
 * pèse plusieurs fois moins qu'un PNG à contenu égal — ce qui compte vraiment ici, puisque l'image traverse
 * l'IPC puis la requête HTTP vers Ollama.
 */
export async function fileToImageAttachment(file: File | Blob, name = ''): Promise<ImageAttachment> {
  if (!isSupportedImageType(file.type)) {
    throw new Error(`Format d'image non pris en charge : ${file.type || 'inconnu'}.`)
  }

  const originalDataUrl = await readAsDataUrl(file)
  const image = await loadImage(originalDataUrl)
  const size = computeScaledSize(image.naturalWidth, image.naturalHeight)

  const canvas = document.createElement('canvas')
  canvas.width = size.width
  canvas.height = size.height
  const context = canvas.getContext('2d')
  if (!context) throw new Error("Impossible de préparer l'image (canvas indisponible).")
  context.drawImage(image, 0, 0, size.width, size.height)

  const dataUrl = canvas.toDataURL('image/jpeg', 0.85)
  return { dataUrl, base64: dataUrl.slice(dataUrl.indexOf(',') + 1), name }
}

/** Première image trouvée dans un collage (Ctrl+V) ou un glisser-déposer, s'il y en a une. */
export function findImageInDataTransfer(items: DataTransferItemList | null): File | null {
  if (!items) return null
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file && isSupportedImageType(file.type)) return file
  }
  return null
}
