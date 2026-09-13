import { exec, spawn } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)
const CACHE_TTL_MS = 5 * 60_000

interface StartApp {
  Name: string
  AppID: string
}

let cache: { apps: StartApp[]; fetchedAt: number } | null = null

/** Liste les applications connues du menu Démarrer Windows (classiques et Store) — aucune curation manuelle. */
async function listInstalledApps(): Promise<StartApp[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.apps

  const { stdout } = await execAsync('powershell -NoProfile -Command "Get-StartApps | ConvertTo-Json -Compress"', {
    windowsHide: true
  })
  const parsed: unknown = JSON.parse(stdout.trim() || '[]')
  const apps = Array.isArray(parsed) ? (parsed as StartApp[]) : [parsed as StartApp]
  cache = { apps, fetchedAt: Date.now() }
  return apps
}

/**
 * Exportée pour être testable directement (scripts/test-app-launcher.mjs) sans avoir à mocker
 * `listInstalledApps` (qui lance PowerShell) juste pour exercer la logique d'appariement.
 *
 * Constaté en usage réel (Léo, "Ouvre le bloc-notes et écris bonjour") : Jaris a ouvert "X" (le réseau
 * social) au lieu du bloc-notes. Cause : un appel d'outil `open_app` SANS `app_name` (ou avec une chaîne
 * vide, ex: argument oublié par le petit modèle local) donnait `q === ''` — `"n'importe quoi".includes('')`
 * vaut TOUJOURS `true` en JS, donc TOUTE application installée matchait la condition, et le tri par nom le
 * plus court (pensé pour départager des matches légitimes similaires) élisait alors le nom le plus court de
 * TOUTE la machine, peu important son rapport avec la demande — "X" (1 caractère) gagne face à "Bloc-notes"
 * sans le moindre lien sémantique. Reproduit avec un vrai test AVANT de corriger (query vide -> {Name: 'X'}
 * sur une liste d'apps de test), pas deviné. Corrigé en refusant toute correspondance pour une requête vide
 * — un nom d'application vide ne "matche" plus rien, il déclenche le message "aucune application nommée"
 * déjà existant dans `openApp` (ou le message dédié ci-dessous, si le nom manque carrément).
 */
export function findBestMatch(apps: StartApp[], query: string): StartApp | undefined {
  const q = query.toLowerCase().trim()
  if (!q) return undefined

  const exact = apps.find((a) => a.Name.toLowerCase() === q)
  if (exact) return exact

  const candidates = apps.filter((a) => a.Name.toLowerCase().includes(q) || q.includes(a.Name.toLowerCase()))
  return candidates.sort((a, b) => a.Name.length - b.Name.length)[0]
}

function launch(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    proc.on('error', (err) => resolve(err.message))
    proc.on('spawn', () => resolve(null))
  })
}

/** Ouvre une application installée sur la machine, identifiée par son nom parlé (ex: "discord", "calculatrice"). */
export async function openApp(name: string): Promise<string> {
  // Message dédié (plutôt que de laisser tomber dans le "aucune application nommée" générique, qui
  // afficherait un nom vide entre guillemets) : voir findBestMatch ci-dessus, un nom vide/absent ouvrait
  // jusqu'ici l'application dont le nom est le plus court sur TOUTE la machine, sans rapport avec la demande.
  if (!name.trim()) {
    return "Aucun nom d'application n'a été précisé : impossible de savoir laquelle ouvrir."
  }

  let apps: StartApp[]
  try {
    apps = await listInstalledApps()
  } catch (err) {
    return `Impossible de lister les applications installées : ${err instanceof Error ? err.message : String(err)}`
  }

  const match = findBestMatch(apps, name)
  if (!match) {
    return `Je n'ai trouvé aucune application nommée "${name}" installée sur cette machine.`
  }

  const error = await launch('explorer.exe', [`shell:appsFolder\\${match.AppID}`])
  return error ? `Échec de l'ouverture de "${match.Name}" : ${error}` : `${match.Name} a été lancé.`
}
