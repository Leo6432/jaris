/**
 * « Enregistrer l'image » sous une image dessinée par Jaris (étape 185, Léo : « met une petite icône à côté des
 * images générées pour la télécharger et ça demande où télécharger »). Partie pure, testée sans Electron : le
 * dialogue natif et l'écriture restent dans main.ts.
 *
 * Le renderer envoie l'image qu'il affiche (data URL) : c'est lui qui la montre à Léo, et il n'a pas besoin de
 * connaître le chemin du fichier sur le disque. Seul un PNG en base64 est accepté — jamais un chemin ni autre
 * chose venant du renderer — et c'est Léo qui choisit où l'écrire, dans la fenêtre de Windows.
 */
const PNG_DATA_URL = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/
/** Signature des 8 premiers octets de tout fichier PNG. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function decodePngDataUrl(dataUrl: string): Buffer | null {
  const match = PNG_DATA_URL.exec(dataUrl)
  if (!match) return null
  const bytes = Buffer.from(match[1], 'base64')
  return bytes.subarray(0, 8).equals(PNG_SIGNATURE) ? bytes : null
}

/** « jaris-image-2026-09-27-14h05.png » : lisible, et deux images du même jour ne s'écrasent pas à la minute près. */
export function defaultImageFileName(now: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `jaris-image-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}h${pad(now.getMinutes())}.png`
}

/** Le fichier reste un PNG même si Léo efface l'extension en tapant le nom. */
export function withPngExtension(path: string): string {
  return /\.png$/i.test(path) ? path : `${path}.png`
}
