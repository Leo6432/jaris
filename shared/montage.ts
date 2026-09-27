/**
 * Montage vidéo (étape 189, Léo : « faire un bouton montage à gauche qui n'est pas installé par défaut, faut
 * cliquer et il te dit que c'est lourd, et ça fait avec Remotion »). Module pur, partagé par le main
 * (installation, rendu) et l'écran (texte d'avertissement), testable sans Electron.
 */

/** Version de Remotion figée : la même que montage/package.json (vérifié par un test). */
export const REMOTION_VERSION = '4.0.529'

/**
 * Le paquet (Remotion et ses dépendances pour Windows) est construit par la CI et publié avec chaque Release.
 * Son nom ne dépend que de la version de Remotion : une mise à jour de Jaris qui ne change pas Remotion ne
 * le fait pas retélécharger.
 */
export const MONTAGE_PACK_ASSET = `Jaris-Montage-remotion-${REMOTION_VERSION}.zip`

/**
 * Tailles MESURÉES (étape 189), arrondies vers le haut pour Léo : paquet ~85 Mo compressé + navigateur de
 * rendu ~100 Mo téléchargés ; ~300 Mo + ~220 Mo une fois décompressés.
 */
export const MONTAGE_DOWNLOAD_LABEL = 'environ 200 Mo'
export const MONTAGE_DISK_LABEL = 'environ 600 Mo'

/** Format de toutes les vidéos : Full HD, 30 images par seconde. */
export const VIDEO_WIDTH = 1920
export const VIDEO_HEIGHT = 1080
export const VIDEO_FPS = 30
/** Durée quand le modèle n'en précise pas, et bornes : au-delà d'une minute, le rendu devient très long. */
export const DEFAULT_VIDEO_SECONDS = 8
export const MIN_VIDEO_SECONDS = 1
export const MAX_VIDEO_SECONDS = 60
