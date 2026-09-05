import { app } from 'electron'
import { join } from 'path'

/**
 * Dossier des scripts Python (sidecars voix et synthèse vocale). En dev, ils sont lus directement dans le
 * dépôt ; dans l'application installée, ils sont copiés tels quels à côté de l'exécutable
 * (`extraResources` d'electron-builder, voir package.json) et JAMAIS empaquetés dans l'archive `app.asar` :
 * un fichier à l'intérieur d'un asar n'existe pas comme vrai fichier sur le disque, `python.exe` — un
 * process externe qui ne connaît rien à Electron — ne pourrait donc pas l'ouvrir.
 */
export function pythonScriptsDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'python') : join(__dirname, '../../python')
}
