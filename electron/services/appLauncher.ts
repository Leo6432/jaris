import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'

const mappingPath = join(process.cwd(), 'apps.json')

function loadAppMap(): Record<string, string> {
  if (!existsSync(mappingPath)) return {}
  try {
    return JSON.parse(readFileSync(mappingPath, 'utf-8')) as Record<string, string>
  } catch {
    return {}
  }
}

/** Ouvre une application connue depuis apps.json (nom -> commande), ou tente le nom tel quel sinon. */
export function openApp(name: string): Promise<string> {
  const apps = loadAppMap()
  const key = Object.keys(apps).find((k) => k.toLowerCase() === name.toLowerCase().trim())
  const command = key ? apps[key] : name

  return new Promise((resolve) => {
    // `start ""` lance en détaché sans bloquer sur la fermeture de l'appli (sinon `cmd /c <app>` attend sa fin).
    const proc = spawn('cmd', ['/c', 'start', '""', command], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    proc.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
    proc.on('error', (err) => resolve(`Échec de l'ouverture de "${name}" : ${err.message}`))
    proc.on('exit', (code) => {
      if (code === 0) resolve(key ? `${name} a été ouvert.` : `"${name}" lancé (absent de apps.json, essai direct).`)
      else resolve(`Échec probable de l'ouverture de "${name}"${stderr ? ` : ${stderr.trim()}` : ''}`)
    })
  })
}
