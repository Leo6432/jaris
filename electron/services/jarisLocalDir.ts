import { homedir } from 'os'
import { join } from 'path'

/**
 * Le dossier où Jaris installe ses moteurs sur la machine (environnement Python, Ollama de Jaris, moteur de dessin) —
 * hors des données de Léo (storageRoot.ts), et remplacé par une jonction quand Léo les « Déplace » (modelsLocation.ts).
 *
 * Installeur habituel : `%LOCALAPPDATA%\Jaris`, comme toujours.
 *
 * Étape 500 (Léo, version Store : « L'installation de Python a échoué : … ERROR: Could not install packages due to an
 * OSError: [WinError 3] Le chemin d'accès spécifié est introuvable: '…\AppData\Local\Jaris\python-runtime\python\Lib\
 * site-packages\flatbuffers-25.12.19.dist-info\INSTALLER91qogle4.tmp' -> '…\INSTALLER' ») : dans un paquet du Store,
 * Windows range à part tout NOUVEAU fichier écrit dans AppData (« written to a private per-user, per-app location; but
 * merged at runtime to appear in the real AppData location », doc Microsoft « How packaged desktop apps run »), et le
 * renommage de pip a échoué chez Léo dans cette vue fusionnée (sur un PC neuf, la CI le voit réussir : vraisemblablement
 * le mélange avec les fichiers réels laissés par l'ancien Jaris). La version Store installe
 * donc ses moteurs dans `%USERPROFILE%\.jaris`, un dossier normal hors d'AppData (comme `.ollama` ou `.cache`), où
 * Windows ne redirige rien. Écarté : `unvirtualizedResources` (déjà écarté à l'étape 491, réservé à certains jeux).
 */
export function jarisLocalDir(
  store: boolean = process.windowsStore === true,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  if (store) return join(env.USERPROFILE || home, '.jaris')
  return join(env.LOCALAPPDATA ?? env.APPDATA ?? home, 'Jaris')
}
