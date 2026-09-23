import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { resourcesRoot } from '../paths'
import { getDataRoot } from './dataLocation'

/**
 * Étape 153, Léo : la mise à jour échouait avec « Échec de désinstallation des anciens fichiers
 * d'application… : 2 ». Ce code 2 veut dire, dans l'installeur d'electron-builder, qu'un fichier du DOSSIER
 * DU PROGRAMME est resté occupé : pendant une mise à jour, l'ancien désinstalleur déplace chaque fichier du
 * programme, et abandonne au premier fichier qu'il ne peut pas déplacer.
 *
 * Le seul morceau de Jaris qui restait accroché à ce dossier une fois Jaris fermé : le conteneur SearXNG
 * (recherche web). `docker compose up` était lancé DEPUIS le dossier des ressources du programme, avec
 * `./searxng` monté dans le conteneur — et ce conteneur tourne en permanence (`restart: unless-stopped`,
 * relancé à chaque démarrage de Docker, même Jaris fermé).
 *
 * Désormais, SearXNG vit dans le dossier de DONNÉES de Jaris (dataLocation.ts : sur le disque choisi, jamais
 * dans le programme), sous un nom de projet Docker fixe. Le programme ne sert plus que de modèle : ses deux
 * fichiers y sont recopiés au démarrage.
 */

/** Nom du projet Docker Compose de Jaris (le conteneur s'appelle donc `jaris-searxng-searxng-1`). */
export const SEARXNG_PROJECT = 'jaris-searxng'

/**
 * Ancien nom de projet : Docker Compose le déduisait du nom du dossier d'où il était lancé, c'est-à-dire
 * `resources` (le dossier des ressources du programme). Les conteneurs de ce projet sont retirés.
 */
export const LEGACY_SEARXNG_PROJECT = 'resources'

export function searxngComposeDir(): string {
  return join(getDataRoot(), 'searxng-docker')
}

/** Écrit `to` seulement si son contenu diffère de `from` (le conteneur n'a pas à voir un fichier réécrit pour rien). */
function syncFile(from: string, to: string): void {
  const content = readFileSync(from)
  if (existsSync(to) && readFileSync(to).equals(content)) return
  mkdirSync(dirname(to), { recursive: true })
  writeFileSync(to, content)
}

/**
 * Recopie docker-compose.yml et searxng/settings.yml du programme vers le dossier de SearXNG, et renvoie ce
 * dossier. Les autres fichiers que SearXNG crée lui-même dans son dossier de configuration sont laissés tels
 * quels.
 */
export function prepareSearxngComposeDir(): string {
  const dir = searxngComposeDir()
  syncFile(join(resourcesRoot(), 'docker-compose.yml'), join(dir, 'docker-compose.yml'))
  syncFile(join(resourcesRoot(), 'searxng', 'settings.yml'), join(dir, 'searxng', 'settings.yml'))
  return dir
}

/** `docker compose` toujours sous le même nom de projet, quel que soit le dossier d'où il est lancé. */
export function composeCommand(args: string): string {
  return `docker compose -p ${SEARXNG_PROJECT} ${args}`
}

/**
 * Identifiants de conteneurs renvoyés par `docker ps -q`. Seuls des identifiants hexadécimaux sont gardés :
 * ils sont ensuite réinjectés dans une commande (`docker rm -f …`), rien d'autre ne doit pouvoir y entrer.
 */
export function parseContainerIds(stdout: string): string[] {
  return stdout
    .split(/\s+/)
    .map((id) => id.trim())
    .filter((id) => /^[0-9a-f]{12,64}$/i.test(id))
}

/** Le dossier d'où un conteneur a été créé par Compose (étiquette posée par Docker), `null` si illisible. */
export function composeWorkingDir(labelsJson: string): string | null {
  try {
    const labels = JSON.parse(labelsJson) as Record<string, unknown> | null
    const dir = labels?.['com.docker.compose.project.working_dir']
    return typeof dir === 'string' && dir ? dir : null
  } catch {
    return null
  }
}

/** Même dossier, à la casse et aux séparateurs près (Windows ne fait pas la différence). */
export function sameDir(a: string, b: string): boolean {
  const norm = (p: string): string => resolve(p).replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase()
  return norm(a) === norm(b)
}
