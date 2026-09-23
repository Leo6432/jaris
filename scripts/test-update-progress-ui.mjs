import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * La barre d'avancement de la mise à jour (étape 98), sur le VRAI composant et le vrai CSS compilé.
 *
 * Pourquoi un vrai navigateur pour si peu : `AppUpdateProgress` réutilise la famille de barres déjà
 * partagée (`.options-menu__progress*`) au lieu d'en créer une, et une règle CSS qui ne s'applique pas ne
 * produit AUCUNE erreur — c'est exactement comme ça que le bouton "Nouvelle conversation" était resté gris
 * (étape 97) alors que son nom de classe était bien présent dans le fichier. Seule une mesure du style
 * réellement calculé le prouve.
 *
 * Playwright n'est pas une dépendance du projet (absent du runner Windows de la CI) : import dynamique,
 * tests explicitement ignorés s'il manque — jamais silencieusement verts.
 */
let chromium = null
try {
  ;({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-update-progress-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import AppUpdateProgress from './src/components/AppUpdateProgress'

const root = createRoot(document.getElementById('root'))
window.__render = (progress, target) => root.render(<AppUpdateProgress progress={progress} target={target} />)
window.__render(null)
`

let pageHtml = null
let outDir = null

function buildPage() {
  if (pageHtml) return pageHtml
  outDir = mkdtempSync(join(tmpdir(), 'jaris-update-ui-'))
  const bundlePath = join(outDir, 'bundle.js')

  writeFileSync(entryPath, ENTRY)
  try {
    execFileSync(
      'npx',
      [
        'esbuild',
        entryPath,
        '--bundle',
        '--format=iife',
        '--loader:.tsx=tsx',
        '--jsx=automatic',
        `--alias:@=${join(projectRoot, 'src')}`,
        `--outfile=${bundlePath}`
      ],
      { cwd: projectRoot, stdio: 'pipe' }
    )
  } finally {
    rmSync(entryPath, { force: true })
  }

  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><style>
    html,body{margin:0;background:#05070c;}
    /* Largeur figée : la barre occupe toute la largeur disponible, donc un ratio n'a de sens que si le
       conteneur a une largeur connue. */
    #root{width:520px;}
    ${css}
  </style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

/** try/finally obligatoire : sans lui, une assertion qui échoue laisse Chromium ouvert et `node --test` ne
 *  se termine jamais — l'échec ne s'affiche même pas. */
async function withPage(run) {
  const html = buildPage()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 900, height: 600 })
    await page.setContent(html)
    await page.waitForSelector('.options-menu__progress')
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('la barre avance vraiment, et son remplissage suit le pourcentage reçu', options, async () => {
  await withPage(async (page) => {
    const widthAt = async (percent) => {
      await page.evaluate(
        (p) => window.__render({ phase: 'download', receivedBytes: Math.round(102711850 * (p / 100)), totalBytes: 102711850, percent: p }),
        percent
      )
      await page.waitForSelector('.options-menu__progress-bar-fill')
      // La famille partagée anime la largeur (`transition: width 0.3s ease`) : mesurer tout de suite
      // donnerait la valeur de DÉPART, pas celle demandée — piège déjà rencontré en mesurant la taille de
      // l'orbe pendant sa transition (étape 85). On laisse l'animation finir.
      await page.waitForTimeout(400)
      return page.evaluate(() => {
        const bar = document.querySelector('.options-menu__progress-bar').getBoundingClientRect()
        const fill = document.querySelector('.options-menu__progress-bar-fill').getBoundingClientRect()
        return { ratio: fill.width / bar.width, barHeight: bar.height }
      })
    }

    const quarter = await widthAt(25)
    const most = await widthAt(80)
    assert.ok(Math.abs(quarter.ratio - 0.25) < 0.03, `remplissage à 25 % mesuré à ${Math.round(quarter.ratio * 100)} %`)
    assert.ok(Math.abs(most.ratio - 0.8) < 0.03, `remplissage à 80 % mesuré à ${Math.round(most.ratio * 100)} %`)
    assert.ok(quarter.barHeight >= 6, `barre invisible : ${quarter.barHeight}px de haut`)
  })
})

test("la barre est bien habillée par le CSS de Jaris, pas laissée au style par défaut", options, async () => {
  // Même vérification que pour le bouton resté gris (étape 97) : le nom de classe présent dans le fichier
  // ne prouve rien, seul le style CALCULÉ le fait.
  await withPage(async (page) => {
    await page.evaluate(() =>
      window.__render({ phase: 'download', receivedBytes: 50_000_000, totalBytes: 102_711_850, percent: 49 })
    )
    await page.waitForSelector('.options-menu__progress-bar-fill')
    const style = await page.evaluate(() => {
      const fill = getComputedStyle(document.querySelector('.options-menu__progress-bar-fill'))
      const bar = getComputedStyle(document.querySelector('.options-menu__progress-bar'))
      return { fillImage: fill.backgroundImage, barBorder: bar.borderTopWidth, barBackground: bar.backgroundColor }
    })
    assert.match(style.fillImage, /linear-gradient/, 'le remplissage n\'a pas le dégradé HUD')
    assert.notEqual(style.barBorder, '0px')
    assert.notEqual(style.barBackground, 'rgba(0, 0, 0, 0)')
  })
})

test('chaque étape est annoncée en clair, et rien ne prétend avancer avant le premier octet', options, async () => {
  await withPage(async (page) => {
    // Avant le premier octet : surtout pas "0 %", qui se lit comme un blocage.
    assert.match(await page.textContent('.options-menu__progress-label'), /Connexion au serveur/)
    assert.equal(await page.locator('.options-menu__progress-bar').count(), 0)

    await page.evaluate(() =>
      window.__render({ phase: 'download', receivedBytes: 41_000_000, totalBytes: 102_711_850, percent: 40 })
    )
    const label = await page.textContent('.options-menu__progress-label')
    assert.match(label, /40 %/)
    assert.match(label, /39 Mo sur 98 Mo/)

    await page.evaluate(() => window.__render({ phase: 'install', receivedBytes: 0, totalBytes: null, percent: 100 }))
    assert.match(await page.textContent('.options-menu__progress-label'), /se ferme, puis se rouvre tout seul/)
  })
})

test.after(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})


test("une mise à jour d'Ollama ne promet jamais que Jaris va se fermer", options, async () => {
  // Défaut réel trouvé sur une capture du rendu (étape 112) : la barre était partagée avec la mise à jour de
  // Jaris, donc elle affichait "Ne ferme pas Jaris : il se ferme et se rouvre tout seul à la fin" pendant une
  // mise à jour d'OLLAMA — une fermeture qui n'arrive jamais. Même famille que les fausses confirmations
  // déjà corrigées plusieurs fois dans ce projet.
  await withPage(async (page) => {
    // Dès le premier instant, AVANT le moindre octet : c'est justement là que la consigne est lue.
    await page.evaluate(() => window.__render(null, 'ollama'))
    const avant = await page.textContent('.options-menu__progress-sub')
    assert.doesNotMatch(avant, /se ferme/, `consigne de Jaris affichée pour Ollama : ${avant.trim()}`)

    await page.evaluate(() =>
      window.__render({ target: 'ollama', phase: 'download', receivedBytes: 805_306_368, totalBytes: 1_610_612_736, percent: 50 }, 'ollama')
    )
    const label = await page.textContent('.options-menu__progress-label')
    assert.match(label, /Ollama/, "le libellé ne dit pas que c'est Ollama qui se télécharge")
    assert.match(label, /1,5 Go/, "la taille réelle (1,5 Go) n'est pas annoncée")
    assert.doesNotMatch(await page.textContent('.options-menu__progress-sub'), /se ferme/)

    // Fin : l'installeur d'Ollama n'a aucun mode silencieux, il attend un clic — ne jamais annoncer
    // une fin automatique.
    await page.evaluate(() =>
      window.__render({ target: 'ollama', phase: 'install', receivedBytes: 0, totalBytes: null, percent: 100 }, 'ollama')
    )
    const fin = await page.textContent('.options-menu__progress-label')
    assert.match(fin, /fenêtre/, `la fin ne dit pas qu'une fenêtre attend un clic : ${fin.trim()}`)
    assert.doesNotMatch(fin, /se rouvre tout seul/, 'la fin promet une reprise automatique qui ne vient pas')
  })
})
