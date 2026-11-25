/**
 * Étape 525 (Léo, version Store : « le navigateur s'est fermé dès son lancement (code 0) », test de code impossible) :
 * lancé par la CI DANS le contexte du paquet du Store (Invoke-CommandInDesktopPackage, même conteneur que Jaris), avec
 * le module de test de ce commit — le chemin du test de code chez Léo. Ouvre une page dans Edge avec le profil dans le
 * dossier temporaire (l'ancien chemin) puis dans le dossier de données (le nouveau), et écrit ce qui s'est passé dans
 * <dossier>/browser.json.
 *
 * Usage : node ci-browser-probe.mjs <dossier de sortie> <benchmark-browser.mjs> [nom du résultat]
 */
import { writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [outDir, modulePath, label = 'browser'] = process.argv.slice(2)
const { findBrowser, openBrowser } = await import(pathToFileURL(modulePath).href)
const browser = findBrowser()
const results = { browser }
for (const [name, root] of [
  ['temp', tmpdir()],
  ['donnees', join(homedir(), 'Jaris', 'navigateur-test')]
]) {
  const started = Date.now()
  try {
    const session = await openBrowser(browser, { profileRoot: root })
    await session.page.loadHtml('<p id="x">ok</p>')
    const text = await session.page.evaluate("document.getElementById('x').textContent")
    await session.close()
    results[name] = { ok: text === 'ok', handedOff: session.handedOff, ms: Date.now() - started }
  } catch (err) {
    results[name] = { ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - started }
  }
}
writeFileSync(join(outDir, `${label}.json`), JSON.stringify(results, null, 2))
