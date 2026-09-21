import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { cp, mkdir, rm } from 'fs/promises'
import { join } from 'path'

/**
 * Où vivent les données PROPRES à Jaris — conversations, profil, mémoire, applications générées, rappels —
 * par opposition aux trois briques de `modelsLocation.ts` (téléchargements IA lourds : modèles Ollama,
 * environnement Python, cache HuggingFace).
 *
 * Léo, étape 121, après avoir constaté que "Déplacer" ne bougeait que les modèles : "le fichier jaris avec
 * conversation cache ne change pas quand on clique sur déplacer" puis, quand je lui ai demandé pourquoi il
 * voudrait déplacer quelques Ko de JSON alors que la fonctionnalité vise des dizaines de Go : "sa doit
 * déplacer tout". C'est donc une demande explicite de COMPLÉTUDE, pas de place disque — et quand une demande
 * explicite contredit le périmètre noté jusqu'ici, c'est la demande qui gagne (même convention que l'étape 96
 * face à l'étape 47).
 *
 * **Mécanisme DIFFÉRENT de celui des trois autres briques, à dessein.** modelsLocation.ts pose une JONCTION
 * NTFS sur le dossier habituel, ce qui redirige tout le monde de façon transparente (y compris Ollama et
 * Python, qui ne savent rien de Jaris). Ici c'est impossible sans risque : `app.getPath('userData')` héberge
 * aussi les fichiers INTERNES de Chromium (Cache, GPUCache, Local Storage, Network Persistent State...),
 * ouverts en permanence par le process Electron en cours d'exécution — les copier/supprimer/rediriger pendant
 * que Jaris tourne exposerait à une copie prise en plein milieu d'une écriture, ou à une suppression refusée
 * par Windows. On ne touche donc JAMAIS au dossier userData lui-même : on copie uniquement les fichiers que
 * JARIS écrit lui-même (de simples JSON/markdown, ouverts-écrits-fermés à chaque fois, jamais gardés ouverts —
 * vérifié : aucun `createWriteStream`/`openSync` dans ces stores), et on laisse un petit MARQUEUR dans
 * userData qui dit où ils vivent désormais.
 *
 * userData reste donc l'ancrage FIXE, décidé par Windows et jamais déplacé : c'est là que Jaris cherche
 * toujours ce marqueur au démarrage pour savoir où est le reste.
 */
const MARKER_NAME = 'data-location.json'

/** Sous-dossier créé dans le dossier choisi par l'utilisateur, à côté de `ollama-models`/`python-runtime`/etc. */
const DATA_SUBDIR = 'jaris-data'

/**
 * Ce que Jaris écrit lui-même, et RIEN d'autre : jamais les dossiers internes de Chromium qui partagent le
 * même userData (voir le commentaire en tête de fichier). Chaque entrée est copiée telle quelle (un fichier
 * comme un dossier — `cp` gère les deux avec `recursive`), et une entrée absente est simplement sautée : sur
 * une installation récente, `memory/` ou `reminders.json` peuvent très bien ne jamais avoir été créés.
 */
const OWNED_ENTRIES = ['conversations', 'conversation-history.json', 'profile.json', 'memory', 'generated-apps', 'reminders.json']

function markerPath(): string {
  return join(app.getPath('userData'), MARKER_NAME)
}

/**
 * Le dossier où lire/écrire les données de Jaris MAINTENANT : celui du marqueur s'il existe et pointe vers un
 * dossier réel, sinon l'emplacement par défaut. Un marqueur qui pointe vers un dossier disparu (disque externe
 * débranché, dossier supprimé à la main) retombe sur le défaut plutôt que de faire échouer toute lecture —
 * Jaris repart alors sur les données d'origine, jamais sur une erreur au démarrage.
 */
export function getDataRoot(): string {
  try {
    const marker = JSON.parse(readFileSync(markerPath(), 'utf-8')) as { dataDir?: unknown }
    if (typeof marker.dataDir === 'string' && marker.dataDir && existsSync(marker.dataDir)) return marker.dataDir
  } catch {
    // Jamais déplacé (cas normal), ou marqueur illisible : emplacement par défaut.
  }
  return app.getPath('userData')
}

/**
 * Copie les données de Jaris vers `newDir` et enregistre le marqueur. Appelée par le MÊME bouton "Déplacer"
 * que modelsLocation.ts (main.ts), juste après les trois briques lourdes.
 *
 * **Les originaux SONT supprimés une fois la copie confirmée**, comme les trois autres briques — Léo,
 * ayant vu par lui-même ce qui restait sur le C après un premier "Déplacer" : "Je veut tout dans le dossier
 * choisit TOUT". Remplace le choix de l'étape 121 (garder un filet sur le C, "les originaux ne sont JAMAIS
 * supprimés") : une demande explicite contredisant un choix précédent l'emporte toujours (même convention
 * que l'étape 96 face à l'étape 47, déjà appliquée ici une fois). Seule la suppression est nouvelle — la
 * COPIE reste faite AVANT toute suppression (jamais l'inverse) : si la copie échoue en cours de route, rien
 * n'a encore été supprimé, exactement la même garantie que `redirectFolder` (modelsLocation.ts) applique déjà
 * à ses trois briques.
 */
export async function moveDataLocation(
  newDir: string,
  onProgress: (message: string) => void
): Promise<{ success: boolean; message: string }> {
  const from = getDataRoot()
  const dest = join(newDir, DATA_SUBDIR)
  if (from === dest) return { success: true, message: '' } // déjà à cet emplacement

  try {
    await mkdir(dest, { recursive: true })
    for (const entry of OWNED_ENTRIES) {
      const source = join(from, entry)
      if (!existsSync(source)) continue
      onProgress(`Copie de ${entry}…`)
      await cp(source, join(dest, entry), { recursive: true, force: true })
    }
    writeFileSync(markerPath(), JSON.stringify({ dataDir: dest }, null, 2), 'utf-8')

    // La copie a réussi et le marqueur pointe déjà vers `dest` : Jaris ne relira plus jamais `from`, les
    // originaux peuvent donc disparaître sans rien perdre. Seules les entrées CONNUES (OWNED_ENTRIES) sont
    // supprimées une par une, jamais `from` en bloc — si `from` est encore le vrai userData (premier
    // déplacement), il héberge aussi les fichiers internes de Chromium (voir le commentaire en tête de
    // fichier), qu'il ne faut jamais toucher.
    for (const entry of OWNED_ENTRIES) {
      const source = join(from, entry)
      if (existsSync(source)) await rm(source, { recursive: true, force: true })
    }
    // `from` n'était PAS le vrai userData (un déplacement précédent avait déjà créé ce dossier `jaris-data`,
    // qui n'a jamais contenu que des copies de OWNED_ENTRIES) : il ne reste plus rien dedans, autant le
    // retirer plutôt que de laisser un dossier vide traîner à chaque nouveau déplacement.
    if (from !== app.getPath('userData')) await rm(from, { recursive: true, force: true })

    return { success: true, message: `Tes conversations et réglages sont maintenant dans ${dest}.` }
  } catch (err) {
    return {
      success: false,
      message: `Tes conversations n'ont pas pu être déplacées (${err instanceof Error ? err.message : String(err)}) — elles restent à leur emplacement actuel, rien n'est perdu.`
    }
  }
}
