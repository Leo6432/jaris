import assert from 'node:assert/strict'
import { globSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Étape 440 (Léo, capture de ChatGPT en noir : « mets l'application full noir ») : en thème sombre, fond, barre
 * latérale et barre d'icônes sont noirs, la liste n'est plus un panneau encadré (un seul trait la sépare de la
 * conversation) ; le champ de saisie et les bulles gardent un gris très foncé pour se voir. Le thème clair ne change
 * pas. Mesuré dans un vrai navigateur, sur le CSS COMPILÉ (out/).
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}
const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

function page() {
  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  return `<!doctype html><html><head><style>${css}</style></head><body>
    <div class="app-shell__body" style="display:flex;height:400px">
      <aside class="app-sidebar">liste</aside>
      <main class="app-main"><div class="composer composer--inline">champ</div></main>
    </div></body></html>`
}

async function measure(colorScheme) {
  const browser = await chromium.launch()
  try {
    const p = await browser.newPage({ colorScheme })
    await p.setContent(page())
    return await p.evaluate(() => {
      const cs = (s) => getComputedStyle(document.querySelector(s))
      return {
        body: cs('body').backgroundColor,
        shell: cs('.app-shell__body').backgroundColor,
        side: cs('.app-sidebar').backgroundColor,
        sideTop: cs('.app-sidebar').borderTopWidth,
        sideRadius: cs('.app-sidebar').borderTopLeftRadius,
        main: cs('.app-main').backgroundColor,
        mainLeft: cs('.app-main').borderLeftWidth,
        composer: cs('.composer').backgroundColor
      }
    })
  } finally {
    await browser.close()
  }
}

test('thème sombre : tout noir, liste sans cadre, un trait avant la conversation, champ gris foncé', options, async () => {
  const dark = await measure('dark')
  for (const key of ['body', 'shell', 'side', 'main']) assert.equal(dark[key], 'rgb(0, 0, 0)', key)
  assert.equal(dark.sideTop, '0px')
  assert.equal(dark.sideRadius, '0px')
  assert.equal(dark.mainLeft, '1px', 'le trait qui sépare la liste de la conversation')
  assert.notEqual(dark.composer, 'rgb(0, 0, 0)', 'le champ de saisie se voit sur le noir')
})

test('thème clair : inchangé (fond clair, liste encadrée et arrondie)', options, async () => {
  const light = await measure('light')
  assert.equal(light.main, 'rgb(255, 255, 255)')
  assert.equal(light.side, 'rgb(249, 249, 249)')
  assert.equal(light.sideTop, '1px')
  assert.equal(light.sideRadius, '12px')
})
