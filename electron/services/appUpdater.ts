import { app } from 'electron'
import { spawn } from 'child_process'
import { writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

/**
 * Met à jour Jaris lui-même depuis l'interface (étape 20 du roadmap), sans jamais `git pull`/`npm run
 * build` : même principe que la mise à jour d'Ollama (dependencyServices.ts) — comparer la version locale
 * à la dernière publiée, puis télécharger et lancer l'installeur au lieu de renvoyer vers un site.
 *
 * Repose sur `.github/workflows/build-installer.yml` : un tag `v*` poussé publie une vraie Release GitHub
 * stable (ex: `v0.1.1`) avec `Jaris-Setup-*.exe` en pièce jointe. `GET /releases/latest` ignore
 * naturellement la Release "dernier-build" (marquée `--prerelease` dans le workflow, utilisée pour tester
 * le développement en cours) : elle ne peut jamais être confondue avec une vraie sortie versionnée.
 */
export interface AppVersionStatus {
  current: string
  latest: string
  outdated: boolean
}

const REPO = 'Leo6432/jaris'

let cachedStatus: AppVersionStatus | null = null
let cachedDownloadUrl: string | null = null

export function getAppVersionStatus(): AppVersionStatus | null {
  return cachedStatus
}

function parseSemver(version: string): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function isNewer(a: [number, number, number], b: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

/**
 * Compare la version installée (`app.getVersion()`, lue par Electron dans `package.json` au moment du
 * build — pas modifiable à l'exécution) à la dernière Release GitHub stable. Met le résultat en cache pour
 * que l'UI (App.tsx, OptionsMenu.tsx) le lise à tout moment sans refaire l'appel réseau — un seul check par
 * lancement de Jaris suffit.
 */
export async function checkAppFreshness(): Promise<void> {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(5000)
    })
    // 404 tant qu'aucune Release stable (tag v*) n'a jamais été publiée : pas une erreur, juste "rien à
    // comparer" — jamais affiché comme "à jour" par défaut dans ce cas, voir getAppVersionStatus (null).
    if (!response.ok) return
    const release = (await response.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] }
    const latestParts = release.tag_name ? parseSemver(release.tag_name) : null
    if (!latestParts) return

    const currentVersion = app.getVersion()
    const currentParts = parseSemver(currentVersion) ?? [0, 0, 0]
    const exeAsset = release.assets?.find((a) => a.name.endsWith('.exe'))

    cachedDownloadUrl = exeAsset?.browser_download_url ?? null
    cachedStatus = {
      current: currentVersion,
      latest: latestParts.join('.'),
      outdated: isNewer(latestParts, currentParts)
    }
  } catch {
    // Best-effort (pas de réseau, GitHub inaccessible...) : ne doit jamais empêcher Jaris de démarrer.
  }
}

/**
 * Déclenché par le bouton "Mettre à jour" (OptionsMenu.tsx, comme celui d'Ollama). Télécharge le VRAI
 * installeur de la Release GitHub (jamais un fichier généré à la volée) et le lance : l'installeur NSIS
 * "un clic" (voir electron-builder.yml) détecte tout seul que Jaris tourne déjà et le ferme si besoin, mais
 * Jaris se ferme ici de lui-même juste après avoir lancé l'installeur pour éviter même cette invite —
 * l'installation continue alors entièrement silencieuse et relance Jaris à la fin (`runAfterFinish`).
 */
export async function updateApp(): Promise<{ success: boolean; message: string }> {
  if (!cachedStatus?.outdated) {
    return { success: false, message: 'Aucune mise à jour disponible.' }
  }
  if (!cachedDownloadUrl) {
    return {
      success: false,
      message: `Une nouvelle version (${cachedStatus.latest}) existe, mais aucun installeur n'est joint à sa Release GitHub.`
    }
  }

  try {
    const response = await fetch(cachedDownloadUrl, { signal: AbortSignal.timeout(120000) })
    if (!response.ok) return { success: false, message: `Téléchargement impossible (HTTP ${response.status}).` }
    const installerPath = join(tmpdir(), 'JarisSetup.exe')
    await writeFile(installerPath, Buffer.from(await response.arrayBuffer()))

    // windowsHide: false — si Jaris ne se ferme pas assez vite pour éviter l'invite "Jaris tourne déjà,
    // fermer et continuer ?" du point de vue de l'installeur, l'utilisateur doit pouvoir la voir et cliquer
    // "OK" plutôt qu'un installeur bloqué invisible en arrière-plan.
    spawn(installerPath, [], { detached: true, stdio: 'ignore', windowsHide: false })
      .on('error', () => {
        // Rien à faire de plus ici : le message de succès a déjà été renvoyé au moment de l'appel, et
        // Jaris est sur le point de se fermer de toute façon (voir plus bas) — un échec asynchrone du
        // spawn lui-même n'a plus d'utilisateur à qui le rapporter à ce stade.
      })
      .unref()

    // Laisse une seconde à l'installeur pour démarrer avant que Jaris ne se ferme et libère son propre
    // exécutable — sans quoi les deux processus pourraient se disputer le même fichier au même instant.
    setTimeout(() => app.quit(), 1000)

    return { success: true, message: `Mise à jour vers ${cachedStatus.latest} : Jaris va se fermer et relancer automatiquement.` }
  } catch (err) {
    return { success: false, message: `Échec de la mise à jour : ${err instanceof Error ? err.message : String(err)}` }
  }
}
