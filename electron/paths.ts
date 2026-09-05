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

/**
 * Racine des fichiers du dépôt lus au moment de l'exécution (scores de modèles vérifiés, configuration
 * SearXNG...). En développement c'est le dossier du projet ; dans l'application installée, c'est le
 * dossier des ressources, où electron-builder les recopie.
 *
 * À NE PAS confondre avec `process.cwd()`, utilisé jusqu'ici : le dossier courant d'une application
 * lancée depuis un raccourci Windows n'a aucun rapport avec l'endroit où elle est installée (souvent
 * C:\Windows\System32), donc tout fichier cherché relativement à lui était introuvable une fois Jaris
 * installé — silencieusement, puisque ces lectures retombent sur une valeur par défaut en cas d'échec.
 */
export function resourcesRoot(): string {
  return app.isPackaged ? process.resourcesPath : join(__dirname, '../..')
}
