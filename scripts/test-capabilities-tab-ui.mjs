import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
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
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
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
    buildSync({entryPoints:[entryPath], bundle:true, format:'iife', jsx:'automatic', alias:{'@':join(projectRoot,'src')}, outfile:bundlePath})
  } finally {
    rmSync(entryPath, { force: true })
  }

  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><style>html,body{margin:0;background:#05070c;}${css}</style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

async function withCapabilitiesTab(run) {
  const html = buildPage()
  const browser = await chromium.launch({channel: process.env.PLAYWRIGHT_CHANNEL || undefined})
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
  const source = readFileSync(join(projectRoot, 'shared/capabilities.ts'), 'utf8').replace(/\r\n/g, '\n')
  const groupCount = [...source.matchAll(/\n {2}\{\n {4}title:/g)].length
  const itemCount = [...source.matchAll(/\n {6}\{\n {8}title:/g)].length
  const limitationCount = [...source.matchAll(/\n {8}limitation: true/g)].length
  assert.ok(groupCount >= 5, `motif de comptage des groupes en panne : ${groupCount} trouvé(s)`)
  assert.ok(itemCount >= 15, `motif de comptage des capacités en panne : ${itemCount} trouvé(s)`)

  await withCapabilitiesTab(async (page) => {
    const rendered = await page.evaluate(() => ({
      groups: document.querySelectorAll('.options-menu__capability-group').length,
      cards: document.querySelectorAll('.options-menu__capability').length,
      limitations: document.querySelectorAll('.options-menu__capability-limitation').length
    }))
    assert.equal(rendered.groups, groupCount, `${rendered.groups} groupe(s) affiché(s), ${groupCount} attendu(s) dans capabilities.ts`)
    assert.equal(
      rendered.cards + rendered.limitations,
      itemCount,
      `${rendered.cards} carte(s) + ${rendered.limitations} note(s) affichées, ${itemCount} entrée(s) attendues dans capabilities.ts`
    )
    assert.equal(rendered.limitations, limitationCount, 'une limitation est rendue comme une capacité, ou disparaît')
  })
})

test("chaque carte montre la phrase à dire, détachée de sa description", options, async () => {
  // Le vrai retour de Léo (étape 111) : "on comprend pas trop". Une phrase d'exemple noyée dans le
  // paragraphe ne se repère pas — il faut qu'elle soit un élément à part, avec son étiquette.
  await withCapabilitiesTab(async (page) => {
    const exemple = await page.evaluate(() => {
      const carte = [...document.querySelectorAll('.options-menu__capability')].find((c) =>
        c.textContent.includes('Ouvrir une application')
      )
      const ligne = carte?.querySelector('.options-menu__capability-example')
      if (!ligne) return null
      const style = getComputedStyle(ligne)
      return {
        texte: ligne.textContent.trim(),
        separe: style.borderTopWidth,
        descriptionDistincte: carte.querySelector('.options-menu__capability-description') !== null
      }
    })
    assert.ok(exemple, "la carte « Ouvrir une application » n'affiche aucune phrase d'exemple")
    assert.match(exemple.texte, /Dis/, "l'exemple n'est pas introduit par son étiquette")
    assert.match(exemple.texte, /«\s*ouvre le bloc-notes\s*»/, 'la phrase exacte à dire est absente')
    assert.notEqual(exemple.separe, '0px', "la phrase d'exemple n'est pas détachée de la description")
    assert.ok(exemple.descriptionDistincte, 'la description et la phrase à dire sont dans le même bloc')
  })
})

test('les guillemets ne sont jamais doublés autour d\'un exemple', options, async () => {
  // Défaut réel trouvé sur une capture : un exemple qui portait déjà ses guillemets donnait « écris
  // « bonjour... » ». La source est gardée propre par test-capabilities.mjs ; ici on vérifie le RENDU.
  await withCapabilitiesTab(async (page) => {
    const doublons = await page.evaluate(() =>
      [...document.querySelectorAll('.options-menu__capability-example-text')]
        .map((el) => el.textContent.trim())
        .filter((t) => (t.match(/«/g) ?? []).length > 1 || (t.match(/»/g) ?? []).length > 1)
    )
    assert.deepEqual(doublons, [], `guillemets imbriqués à l'écran : ${doublons.join(' | ')}`)
  })
})

test('le contenu réel (pas un texte générique) est visible : chaque famille est représentée', options, async () => {
  await withCapabilitiesTab(async (page) => {
    const texte = await page.textContent('.options-page__content')
    assert.match(texte, /Ouvrir une application/)
    assert.match(texte, /rappel/i)
    assert.match(texte, /mode Code/i)
    assert.match(texte, /conversation/i)
  })
})

test('les cartes sont vraiment habillées par le CSS, pas laissées au style par défaut', options, async () => {
  // Leçon du bouton resté gris (étape 97) : une règle CSS sans effet ne produit aucune erreur, elle est
  // juste ignorée — la seule vérification qui vaut est de MESURER le style calculé. Les éléments sont
  // sélectionnés par leur balise/rôle puis vérifiés un par un, jamais par la classe qu'on teste (leçon de
  // l'étape 21 : un sélecteur par classe ne peut pas voir cette classe manquer).
  await withCapabilitiesTab(async (page) => {
    const mesures = await page.evaluate(() => {
      const groupe = document.querySelector('.options-menu__capability-group')
      const titre = groupe.querySelector('h3')
      const carte = document.querySelector('.options-menu__capability')
      const styleCarte = getComputedStyle(carte)
      return {
        titreTaille: parseFloat(getComputedStyle(titre).fontSize),
        titreCouleur: getComputedStyle(titre).color,
        carteFond: styleCarte.backgroundColor,
        carteBordure: styleCarte.borderTopWidth,
        carteRayon: styleCarte.borderTopLeftRadius,
        colonnes: getComputedStyle(document.querySelector('.options-menu__capability-cards')).gridTemplateColumns
      }
    })
    assert.ok(mesures.titreTaille >= 15, `titre de groupe trop petit (${mesures.titreTaille}px) pour un intertitre`)
    assert.notEqual(mesures.titreCouleur, 'rgb(255, 255, 255)', 'le titre de groupe est resté au blanc par défaut du navigateur')
    assert.notEqual(mesures.carteFond, 'rgba(0, 0, 0, 0)', 'la carte n’a aucun fond : la règle CSS ne s’applique pas')
    assert.notEqual(mesures.carteBordure, '0px', 'la carte n’a aucune bordure')
    assert.notEqual(mesures.carteRayon, '0px', 'la carte n’a pas de coins arrondis')
    // Une grille à plusieurs colonnes à 1100px de large : une colonne unique redonnerait le mur de texte.
    assert.ok(mesures.colonnes.split(' ').length >= 2, `les cartes ne se rangent pas en grille : ${mesures.colonnes}`)
  })
})

test('"Ce que Jaris sait faire" est dans sa propre catégorie, pas dans les réglages', options, async () => {
  // Demande explicite de Léo (étape 111) : "met ce que jaris sait faire pas dans reglage mais crée une
  // autre sous categorie dans les options".
  await withCapabilitiesTab(async (page) => {
    const nav = await page.evaluate(() => {
      const aside = document.querySelector('.options-page__navigation')
      const labels = [...aside.querySelectorAll('.options-page__navigation-label')].map((el) => el.textContent.trim())
      // Pour chaque liste d'onglets, l'intitulé de catégorie qui la précède immédiatement.
      const listes = [...aside.querySelectorAll('nav')].map((liste) => ({
        categorie: liste.previousElementSibling?.textContent.trim() ?? null,
        onglets: [...liste.querySelectorAll('button')].map((b) => b.textContent.trim())
      }))
      return { labels, listes }
    })
    assert.ok(nav.labels.length >= 2, `une seule catégorie dans la colonne : ${JSON.stringify(nav.labels)}`)

    const capacites = nav.listes.find((l) => l.onglets.some((o) => /sait faire/i.test(o)))
    assert.ok(capacites, '"Ce que Jaris sait faire" est introuvable dans la navigation')
    assert.doesNotMatch(
      capacites.categorie,
      /réglages/i,
      '"Ce que Jaris sait faire" est encore rangé sous "Réglages"'
    )
    // Et les vrais réglages, eux, restent bien ensemble sous leur propre intitulé. Depuis la refonte de
    // l'étape 115 (Léo : "des categorie... peuvent etre ensemble"), Micro/Activation ont rejoint Voix et
    // Mise à jour/Stockage/Historique ont rejoint Général — la liste attendue est donc plus courte
    // qu'avant, mais toujours strictement celle-ci, jamais un simple comptage qui masquerait un onglet
    // disparu par erreur.
    const reglages = nav.listes.find((l) => l.onglets.includes('Voix'))
    assert.match(reglages.categorie, /réglages/i, 'les réglages ont perdu leur intitulé de catégorie')
    assert.deepEqual(reglages.onglets, ['Voix', 'Modèles', 'Général'], `réglages inattendus : ${JSON.stringify(reglages.onglets)}`)
  })
})

test.after(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})
