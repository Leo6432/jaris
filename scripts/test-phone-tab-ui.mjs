import assert from 'node:assert/strict'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'

/**
 * Étape 214 : Options → Téléphone, dans un vrai navigateur avec le vrai CSS compilé. Le tunnel Tailscale est
 * simulé : le test pilote lui-même ses étapes (connexion, autorisation, adresse prête) et vérifie que
 * chacune dit quoi faire, dans l'ordre, et que les boutons font vraiment ce qu'ils annoncent.
 */
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}
const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-phone-tab-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import OptionsMenu from './src/components/OptionsMenu'

window.__calls = []
window.__phone = { state: 'off', devices: [] }
let listener = () => {}
window.__emitPhone = (status) => { window.__phone = status; listener(status) }

const overrides = {
  getProfile: async () => ({ name: 'Léo' }),
  listAudioInputDevices: async () => [],
  getPhoneAccess: async () => window.__phone,
  onPhoneAccessChanged: (cb) => { listener = cb; return () => {} },
  setPhoneAccessEnabled: async (enabled) => {
    window.__calls.push(['enable', enabled])
    window.__phone = enabled ? { state: 'starting', devices: window.__phone.devices } : { state: 'off', devices: window.__phone.devices }
    return window.__phone
  },
  openPhoneAccessLink: async () => { window.__calls.push(['open']) },
  createPhonePairing: async () => {
    window.__calls.push(['pair'])
    // Comme le vrai aller-retour vers le PC : le code naît un peu APRÈS le clic.
    await new Promise((r) => setTimeout(r, 30))
    return { code: '12345678', link: 'https://jaris.tail1234.ts.net/#code=12345678', expiresAt: Date.now() + 600000 }
  },
  removePhoneDevice: async (id) => {
    window.__calls.push(['remove', id])
    window.__phone = { ...window.__phone, devices: window.__phone.devices.filter((d) => d.id !== id) }
    return window.__phone
  },
  logoutPhoneAccess: async () => {
    window.__calls.push(['logout'])
    window.__phone = { state: 'off', devices: [] }
    return window.__phone
  }
}

window.jaris = new Proxy({}, {
  get: (_target, name) => {
    if (typeof name !== 'string') return undefined
    if (name in overrides) return overrides[name]
    if (name.startsWith('on')) return () => () => {}
    return async () => null
  }
})

createRoot(document.getElementById('root')).render(<OptionsMenu />)
`

let pageHtml = null
function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-phone-tab-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    buildSync({ entryPoints: [entryPath], bundle: true, format: 'iife', jsx: 'automatic', alias: { '@': join(projectRoot, 'src') }, loader: { '.png': 'dataurl' }, outfile: bundlePath })
  } finally {
    rmSync(entryPath, { force: true })
  }
  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><style>html,body{margin:0;background:#05070c;}${css}</style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

async function withPhoneTab(run) {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || undefined })
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1200, height: 900 })
    await page.setContent(buildPage())
    await page.waitForSelector('.options-menu__trigger')
    await page.click('.options-menu__trigger')
    await page.click('.options-menu__tab:has-text("Téléphone")')
    await page.waitForSelector('.phone-access')
    await run(page)
  } finally {
    await browser.close()
  }
}

const calls = (page) => page.evaluate(() => window.__calls)
const READY = (devices = []) => ({ state: 'ready', address: 'https://jaris.tail1234.ts.net', devices })

test('désactivé par défaut : ce que ça fait, que c’est chiffré, et ce qui reste interdit depuis le téléphone', options, async () => {
  await withPhoneTab(async (page) => {
    assert.equal(await page.getAttribute('.phone-access [role="switch"]', 'aria-checked'), 'false')
    const text = await page.textContent('.phone-access')
    assert.match(text, /Chiffré de bout en bout/)
    assert.match(text, /ni taper, ni cliquer, ni regarder ton écran/)
    assert.match(text, /bouton prévu sur la page du téléphone, avec une minute pour annuler/)
    assert.equal(await page.locator('.phone-access__pairing, .phone-access__step').count(), 0, 'rien d’autre tant que c’est désactivé')
  })
})

test('activer : étape 1 (connexion Tailscale) puis étape 2 (autoriser l’adresse), chacune avec son bouton', options, async () => {
  await withPhoneTab(async (page) => {
    await page.click('.phone-access [role="switch"]')
    assert.deepEqual((await calls(page))[0], ['enable', true])
    await page.waitForSelector('text=Démarrage de la connexion')

    await page.evaluate(() => window.__emitPhone({ state: 'login', actionUrl: 'https://login.tailscale.com/a/abc', devices: [] }))
    await page.waitForSelector('text=Étape 1 sur 2')
    await page.click('button:has-text("Ouvrir la page de connexion")')
    assert.deepEqual((await calls(page)).at(-1), ['open'])

    await page.evaluate(() => window.__emitPhone({ state: 'enable_funnel', actionUrl: 'https://login.tailscale.com/f/funnel', devices: [] }))
    await page.waitForSelector('text=Étape 2 sur 2')
    assert.equal(await page.locator('text=Étape 1 sur 2').count(), 0, 'une seule étape affichée à la fois')
    await page.click('button:has-text("Ouvrir la page d’autorisation"), button:has-text("autorisation")')
    assert.deepEqual((await calls(page)).at(-1), ['open'])
  })
})

test('adresse prête : QR code + code lisible, qui se ferme tout seul dès qu’un téléphone s’est connecté', options, async () => {
  await withPhoneTab(async (page) => {
    await page.evaluate((s) => window.__emitPhone(s), READY())
    await page.waitForSelector('.phone-access__address')
    assert.equal(await page.textContent('.phone-access__address'), 'https://jaris.tail1234.ts.net')
    assert.match(await page.textContent('.phone-access'), /Aucun téléphone pour l'instant/)

    await page.click('button:has-text("Connecter un téléphone")')
    await page.waitForSelector('.phone-access__qr')
    assert.match(await page.getAttribute('.phone-access__qr', 'src'), /^data:image\/png;base64,/)
    assert.equal(await page.textContent('.phone-access__code'), '1234 5678')
    assert.match(await page.textContent('.phone-access__expiry'), /Valable encore 10 min/)
    const qr = await page.$eval('.phone-access__qr', (img) => ({ w: img.getBoundingClientRect().width, natural: img.naturalWidth }))
    assert.ok(qr.w >= 180 && qr.natural > 0, 'QR réellement dessiné, assez grand pour être scanné')

    await page.evaluate((s) => window.__emitPhone(s), READY([{ id: 'd1', name: 'iPhone', createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() }]))
    await page.waitForFunction(() => !document.querySelector('.phone-access__pairing'))
    assert.match(await page.textContent('.phone-access'), /iPhone/)
  })
})

test('déconnecter un téléphone, et se déconnecter de Tailscale après confirmation seulement', options, async () => {
  await withPhoneTab(async (page) => {
    const now = new Date().toISOString()
    await page.evaluate((s) => window.__emitPhone(s), READY([{ id: 'd1', name: 'iPhone', createdAt: now, lastSeenAt: now }, { id: 'd2', name: 'Android', createdAt: now, lastSeenAt: now }]))
    await page.waitForSelector('text=Android')
    await page.click('.options-menu__row:has-text("Android") button:has-text("Déconnecter")')
    assert.deepEqual((await calls(page)).at(-1), ['remove', 'd2'])
    await page.waitForFunction(() => !document.querySelector('.phone-access').textContent.includes('Android'))

    await page.click('button:has-text("Se déconnecter")')
    assert.equal((await calls(page)).some((c) => c[0] === 'logout'), false, 'rien sans confirmation')
    await page.click('button:has-text("Confirmer")')
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'logout'))
    await page.waitForFunction(() => document.querySelector('.phone-access [role="switch"]').getAttribute('aria-checked') === 'false')
  })
})

test('étapes de préparation et avertissement de l’adresse affichés tels quels', options, async () => {
  await withPhoneTab(async (page) => {
    await page.evaluate(() => window.__emitPhone({ state: 'starting', message: 'Préparation du certificat sécurisé (jusqu’à 2 minutes la première fois)…', devices: [] }))
    await page.waitForSelector('text=Préparation du certificat sécurisé')
    await page.evaluate(() => window.__emitPhone({ state: 'ready', address: 'https://jaris.tail1234.ts.net', message: 'Connexion sécurisée refusée : acme: rate limited', devices: [] }))
    await page.waitForSelector('text=acme: rate limited')
    assert.ok(await page.isVisible('button:has-text("Connecter un téléphone")'), 'l’adresse reste utilisable')
  })
})

test('échec : la vraie raison et un bouton pour réessayer', options, async () => {
  await withPhoneTab(async (page) => {
    await page.evaluate(() => window.__emitPhone({ state: 'error', message: 'démarrage de Tailscale impossible : pas de réseau', devices: [] }))
    await page.waitForSelector('text=pas de réseau')
    await page.click('button:has-text("Réessayer")')
    assert.deepEqual((await calls(page)).at(-1), ['enable', true])
  })
})

test('les boutons sont habillés par le CSS de Jaris, pas le style par défaut du navigateur', options, async () => {
  await withPhoneTab(async (page) => {
    await page.evaluate((s) => window.__emitPhone(s), READY())
    await page.waitForSelector('button:has-text("Connecter un téléphone")')
    const styles = await page.$$eval('.phone-access button:not([role="switch"])', (buttons) =>
      buttons.map((b) => ({ text: b.textContent, bg: getComputedStyle(b).backgroundImage + getComputedStyle(b).backgroundColor, color: getComputedStyle(b).color }))
    )
    assert.ok(styles.length >= 2)
    for (const s of styles) {
      assert.notEqual(s.color, 'rgb(0, 0, 0)', `${s.text} : couleur par défaut`)
      assert.notEqual(s.bg, 'nonergb(239, 239, 239)', `${s.text} : fond par défaut`)
    }
  })
})
