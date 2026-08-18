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

function findBestMatch(apps: StartApp[], query: string): StartApp | undefined {
  const q = query.toLowerCase().trim()
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
