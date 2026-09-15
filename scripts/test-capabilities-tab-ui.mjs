import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * Onglet Options → "Ce que Jaris sait faire" (étape 108), sur le VRAI OptionsMenu, le vrai
 * shared/capabilities.ts et le vrai CSS compilé.
 *
 * La synchronisation avec tools.ts est déjà vérifiée par scripts/test-capabilities.mjs (structurel, sans
 * navigateur) : ce test-ci vérifie seulement que le contenu s'affiche vraiment et lisiblement, ce qu'aucun
 * test structurel ne peut prouver — même leçon que le bouton resté gris de l'étape 97.
 */
let chromium = null
try {
  ;({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-capabilities-tab-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import OptionsMenu from './src/components/OptionsMenu'

const overrides = {
  getProfile: async () => ({ name: 'Léo' }),
  saveProfile: async () => {}
}

window.jaris = new Proxy({}, {
  get: (_target, name) => {
    if (typeof name !== 'string') return undefined
    if (name in overrides) return overrides[name]
    if (name.startsWith('on')) return () => () => {}
    return async () => null
  }
})

const root = createRoot(document.getElementById('root'))
root.render(<OptionsMenu />)
`

let pageHtml = null
let outDir = null

function buildPage() {
  if (pageHtml) return pageHtml
  outDir = mkdtempSync(join(tmpdir(), 'jaris-capabilities-tab-'))
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
  pageHtml = `<!doctype html><html><head><style>html,body{margin:0;background:#05070c;}${css}</style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

async function withCapabilitiesTab(run) {
  const html = buildPage()
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1100, height: 900 })
    await page.setContent(html)
    await page.waitForSelector('.options-menu__trigger')
    await page.click('.options-menu__trigger')
    // C'est le premier onglet de la barre : il doit être atteignable sans faire défiler autre chose d'abord.
    await page.click('.options-menu__tab:has-text("Ce que Jaris sait faire")')
    await page.waitForSelector('.options-menu__capability-group')
    await run(page)
  } finally {
    await browser.close()
  }
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('tous les groupes et toutes les capacités du fichier partagé sont réellement affichés', options, async () => {
  // Compte les groupes (`title:` en tête d'objet du tableau CAPABILITIES) et les capacités (`title:` en tête
  // d'objet des sous-tableaux `items`) directement dans le SOURCE — pas d'import de .ts depuis ce script
  // .mjs, la transpilation vit dans les autres tests (test-capabilities.mjs s'en charge pour la logique).
  const source = readFileSync(join(projectRoot, 'shared/capabilities.ts'), 'utf8')
  const groupCount = [...source.matchAll(/\n {2}\{\n {4}title:/g)].length
  const itemCount = [...source.matchAll(/\n {6}\{\n {8}title:/g)].length
  assert.ok(groupCount >= 5, `motif de comptage des groupes en panne : ${groupCount} trouvé(s)`)
  assert.ok(itemCount >= 15, `motif de comptage des capacités en panne : ${itemCount} trouvé(s)`)

  await withCapabilitiesTab(async (page) => {
    const rendered = await page.evaluate(() => ({
      groups: document.querySelectorAll('.options-menu__capability-group').length,
      items: document.querySelectorAll('.options-menu__capability-group li').length
    }))
    assert.equal(rendered.groups, groupCount, `${rendered.groups} groupe(s) affiché(s), ${groupCount} attendu(s) dans capabilities.ts`)
    assert.equal(rendered.items, itemCount, `${rendered.items} capacité(s) affichée(s), ${itemCount} attendue(s) dans capabilities.ts`)
  })
})

test('le contenu réel (pas un texte générique) est visible : outils précis nommés en clair', options, async () => {
  await withCapabilitiesTab(async (page) => {
    const texte = await page.textContent('.options-page__content')
    assert.match(texte, /Ouvrir une application/)
    assert.match(texte, /qui m'a appelé/i)
    assert.match(texte, /Générer une application complète/)
    // Le point sur lequel Léo a explicitement buté dans le passé : les messages restent impossibles.
    assert.match(texte, /messages/i)
  })
})

test('les titres de groupe sont habillés comme les autres titres de section, pas laissés en texte brut', options, async () => {
  await withCapabilitiesTab(async (page) => {
    const styles = await page.evaluate(() =>
      [...document.querySelectorAll('.options-menu__capability-group .options-menu__section-title')].map((el) => {
        const s = getComputedStyle(el)
        return { texte: el.textContent.trim(), transform: s.textTransform, taille: s.fontSize }
      })
    )
    assert.ok(styles.length >= 5, `trop peu de titres de groupe stylés : ${JSON.stringify(styles)}`)
    for (const style of styles) {
      assert.equal(style.transform, 'uppercase', `« ${style.texte} » n'est pas en majuscules comme les autres titres de section`)
    }
  })
})

test.after(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})
