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
 * Repose sur `.github/workflows/build-installer.yml` : dès qu'un push (sur n'importe quelle branche)
 * contient une version de `package.json` sans Release correspondante, le workflow publie lui-même une
 * vraie Release GitHub stable (ex: `v0.1.1`) avec `Jaris-Setup-*.exe` en pièce jointe — personne ne pousse
 * de tag à la main. `GET /releases/latest` ignore naturellement la Release "dernier-build" (marquée
 * `--prerelease` dans le workflow, utilisée pour tester le développement en cours) : elle ne peut jamais
 * être confondue avec une vraie sortie versionnée.
 */
export interface AppVersionStatus {
  current: string
  latest: string
  outdated: boolean
}

/** Une entrée du journal des mises à jour (Options → Modèles), une par Release GitHub stable publiée. */
export interface ReleaseHistoryEntry {
  version: string
  publishedAt: string
  notes: string
}

const REPO = 'Leo6432/jaris'

let cachedStatus: AppVersionStatus | null = null
let cachedDownloadUrl: string | null = null
let freshnessCheck: Promise<void> | null = null

/**
 * Attend la vérification en cours si `checkAppFreshness` n'a pas encore fini (appelée en `void` au
 * démarrage, sans attendre) avant de renvoyer le cache : sans ça, l'appel IPC déclenché par le montage de
 * l'interface (App.tsx, quasi instantané) gagnait quasi systématiquement la course contre l'appel réseau
 * vers GitHub (bien plus lent), et `cachedStatus` valait encore `null` à ce moment-là — la popup de mise à
 * jour ne pouvait alors jamais s'afficher, peu importe la version réellement publiée.
 */
export async function getAppVersionStatus(): Promise<AppVersionStatus | null> {
  if (freshnessCheck) await freshnessCheck
  return cachedStatus
}

/** Version réellement installée, lue localement (`app.getVersion()`) — jamais bloquée par le réseau,
 * contrairement à getAppVersionStatus() qui compare à la dernière Release GitHub. */
export function getInstalledVersion(): string {
  return app.getVersion()
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
 * lancement de Jaris suffit. Ignore silencieusement toute erreur (pas de réseau, GitHub inaccessible...) :
 * ce check en tâche de fond au démarrage ne doit jamais empêcher Jaris de démarrer. Pour un vrai diagnostic
 * (bouton "Rechercher une mise à jour" dans Options), voir checkForUpdate ci-dessous, qui elle remonte
 * l'erreur au lieu de l'avaler.
 */
export function checkAppFreshness(): Promise<void> {
  freshnessCheck = checkForUpdate().then(() => undefined)
  return freshnessCheck
}

/**
 * Vérifie pour de vrai (jamais depuis le cache) et renvoie l'erreur telle quelle en cas d'échec, contrairement
 * à checkAppFreshness ci-dessus qui l'avale silencieusement : déclenchée par un clic explicite sur "Rechercher
 * une mise à jour" (OptionsMenu.tsx), l'utilisateur doit voir la vraie raison d'un échec (pare-feu, réseau
 * d'entreprise, GitHub injoignable...) plutôt qu'un silence qui ressemble à un bug côté Jaris.
 */
export async function checkForUpdate(): Promise<{ status: AppVersionStatus | null; error: string | null }> {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(8000)
    })
    // 404 tant qu'aucune Release stable (tag v*) n'a jamais été publiée : pas une erreur, juste "rien à
    // comparer" — jamais affiché comme "à jour" par défaut dans ce cas.
    if (!response.ok) {
      return response.status === 404
        ? { status: null, error: null }
        : { status: null, error: `GitHub a répondu HTTP ${response.status}.` }
    }
    const release = (await response.json()) as { tag_name?: string; assets?: { name: string; browser_download_url: string }[] }
    const latestParts = release.tag_name ? parseSemver(release.tag_name) : null
    if (!latestParts) return { status: null, error: 'Réponse GitHub inattendue : aucune version reconnue.' }

    const currentVersion = app.getVersion()
    const currentParts = parseSemver(currentVersion) ?? [0, 0, 0]
    const exeAsset = release.assets?.find((a) => a.name.endsWith('.exe'))

    cachedDownloadUrl = exeAsset?.browser_download_url ?? null
    cachedStatus = {
      current: currentVersion,
      latest: latestParts.join('.'),
      outdated: isNewer(latestParts, currentParts)
    }
    return { status: cachedStatus, error: null }
  } catch (err) {
    return { status: null, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Journal des mises à jour (Options → Modèles) : la liste des vraies Releases GitHub stables, la plus
 * récente en premier (ordre déjà renvoyé par l'API). `GET /releases` (pluriel, jusqu'à 30 par défaut, bien
 * assez pour un historique) inclut la Release "dernier-build" au même titre que les autres — filtrée ici
 * via son champ `prerelease`, exactement comme `releases/latest` l'ignore déjà naturellement ailleurs.
 */
export async function getReleaseHistory(): Promise<ReleaseHistoryEntry[]> {
  try {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(5000)
    })
    if (!response.ok) return []
    const releases = (await response.json()) as { tag_name?: string; prerelease?: boolean; published_at?: string; body?: string }[]

    return releases
      .filter((r) => !r.prerelease && r.tag_name && parseSemver(r.tag_name))
      .map((r) => ({
        version: r.tag_name as string,
        publishedAt: r.published_at ?? '',
        notes: r.body?.trim() || 'Pas de notes détaillées pour cette version.'
      }))
  } catch {
    return []
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
