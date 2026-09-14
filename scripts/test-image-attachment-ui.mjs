import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, globSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/**
 * Vérifie l'image jointe (étape 91) avec le VRAI composant ChatPanel, le vrai CSS compilé et une vraie
 * image, dans un vrai navigateur — tout ce que scripts/test-image-attachment.mjs ne peut pas couvrir en pur
 * Node : lecture du fichier, canvas, réduction réelle, aperçu, clic sur "Envoyer", et ce qui part vraiment
 * vers le main process.
 *
 * Playwright n'est PAS une dépendance du projet : il existe dans l'environnement de développement, pas sur
 * le runner Windows de la CI. Sans ce chargement conditionnel, `npm test` (qui prend TOUS les
 * scripts/test-*.mjs, CI comprise) échouerait là-bas sur un import manquant, alors que le reste de la suite
 * est du Node pur. Les tests sont donc explicitement marqués "ignorés" quand Playwright est absent, jamais
 * silencieusement verts : un test qu'on croit passé alors qu'il n'a rien exécuté ne protège de rien.
 */
let chromium = null
try {
  ;({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = new URL('..', import.meta.url).pathname
const entryPath = join(projectRoot, 'tmp-image-attachment-entry.tsx')

/**
 * Faux pont preload commun aux deux panneaux : enregistre ce qui part VRAIMENT vers le main process.
 */
const ENTRY_FOR = (component) => `
import { createRoot } from 'react-dom/client'
import Panel from './src/components/${component}'

window.__sent = []
window.jaris = {
  getChatHistory: () => Promise.resolve([]),
  onLog: () => () => {},
  onChatStreamToken: () => () => {},
  onCodeGenStatus: () => () => {},
  getGeneratedApps: () => Promise.resolve([]),
  getProfile: () => Promise.resolve({ soundEffectsEnabled: false }),
  sendChatMessage: (prompt, imageBase64) => {
    window.__sent.push({ prompt, imageBase64 })
    return Promise.resolve({ role: 'assistant', content: 'Réponse de test.' })
  },
  generateApp: (description, currentHtml, imageBase64) => {
    window.__sent.push({ prompt: description, imageBase64 })
    return Promise.resolve({ html: '<!DOCTYPE html><html></html>', path: '/tmp/app', issues: [], previewUrl: 'about:blank' })
  }
}

createRoot(document.getElementById('root')).render(<Panel />)
`

const pageHtmlByComponent = new Map()
let outDir = null

/**
 * Bundle le vrai composant, une seule fois.
 *
 * Deux pièges d'empaquetage, chacun rencontré en écrivant ce fichier :
 * - esbuild résout `node_modules` depuis l'emplacement du FICHIER D'ENTRÉE : l'entrée est donc écrite dans
 *   le projet (puis supprimée), jamais dans /tmp, sinon react/react-dom restent introuvables ;
 * - le projet est en React 18 avec le runtime JSX automatique (tsconfig `"jsx": "react-jsx"`). Sans
 *   `--jsx=automatic`, esbuild compile en `React.createElement` et la page plante sur "React is not
 *   defined" : le composant ne se monte jamais, et le test paraît simplement "bloqué" sur son premier
 *   waitForSelector sans jamais dire pourquoi.
 */
function buildPage(component) {
  const cached = pageHtmlByComponent.get(component)
  if (cached) return cached
  outDir = outDir ?? mkdtempSync(join(tmpdir(), 'jaris-image-ui-'))
  const bundlePath = join(outDir, `${component}.js`)

  writeFileSync(entryPath, ENTRY_FOR(component))
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
        // Le projet importe via l'alias "@/..." (vite.config/tsconfig) : esbuild ne le connaît pas seul.
        `--alias:@=${join(projectRoot, 'src')}`,
        `--outfile=${bundlePath}`
      ],
      { cwd: projectRoot, stdio: 'pipe' }
    )
  } finally {
    rmSync(entryPath, { force: true })
  }

  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  const html = `<!doctype html><html><head><style>
    html,body{margin:0;height:100%;background:#020409;}
    #root{height:100%;display:flex;}
    ${css}
  </style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  pageHtmlByComponent.set(component, html)
  return html
}

/**
 * Toujours dans un try/finally : sans ça, la moindre assertion qui échoue laisse le navigateur ouvert, ses
 * processus gardent la boucle d'évènements de Node vivante, et `node --test` ne se termine JAMAIS — le test
 * paraît alors "bloqué" au lieu d'afficher son échec (vécu en écrivant ce fichier).
 */
async function withPage(run, component = 'ChatPanel', readySelector = '.chat-panel__composer') {
  const html = buildPage(component)
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width: 1100, height: 800 })
    await page.setContent(html)
    await page.waitForSelector(readySelector)
    await run(page)
  } finally {
    await browser.close()
  }
}

/** Vraie image 2000x1000, donc bien au-dessus de la limite de 1280 : la réduction doit se voir. */
const MAKE_WIDE_PNG = `(() => {
  const canvas = document.createElement('canvas')
  canvas.width = 2000
  canvas.height = 1000
  const context = canvas.getContext('2d')
  context.fillStyle = '#c0392b'
  context.fillRect(0, 0, 2000, 1000)
  context.fillStyle = '#ffffff'
  context.fillRect(100, 100, 600, 300)
  return canvas.toDataURL('image/png')
})()`

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('une image jointe est réduite, prévisualisée, puis envoyée en base64 avec le message', options, async () => {
  await withPage(async (page) => {
    const dataUrl = await page.evaluate(MAKE_WIDE_PNG)
    await page.setInputFiles('.chat-panel__composer input[type=file]', {
      name: 'maquette.png',
      mimeType: 'image/png',
      buffer: Buffer.from(dataUrl.split(',')[1], 'base64')
    })

    await page.waitForSelector('.chat-panel__attachment img')
    assert.equal(await page.textContent('.chat-panel__attachment-name'), 'maquette.png')

    // Envoyer doit être actif MÊME sans texte : une image seule ("regarde ça") est un envoi légitime.
    const sendButton = page.locator('.chat-panel__composer button', { hasText: 'Envoyer' })
    assert.equal(await sendButton.isDisabled(), false)

    await page.fill('.chat-panel__composer textarea', "C'est quoi sur cette image ?")
    await sendButton.click()
    await page.waitForFunction(() => window.__sent.length === 1)

    const [sent] = await page.evaluate(() => window.__sent)
    assert.equal(sent.prompt, "C'est quoi sur cette image ?")
    assert.ok(sent.imageBase64, 'aucune image transmise au main process')
    assert.ok(!sent.imageBase64.startsWith('data:'), 'le préfixe data: doit être retiré avant Ollama')

    // L'image transmise doit VRAIMENT être réduite à la limite, pas envoyée en 2000px de large.
    const sentSize = await page.evaluate(async (base64) => {
      const image = new Image()
      await new Promise((resolve, reject) => {
        image.onload = resolve
        image.onerror = reject
        image.src = `data:image/jpeg;base64,${base64}`
      })
      return { width: image.naturalWidth, height: image.naturalHeight }
    }, sent.imageBase64)
    assert.equal(sentSize.width, 1280)
    assert.equal(sentSize.height, 640)

    // Le fil affiche la vignette, et l'aperçu du composeur a bien été vidé après l'envoi.
    await page.waitForSelector('.chat-panel__message-image')
    assert.equal(await page.locator('.chat-panel__attachment').count(), 0)

    // La vignette ne doit pas déborder du fil de discussion.
    const overflow = await page.evaluate(() => {
      const image = document.querySelector('.chat-panel__message-image')
      const thread = document.querySelector('.chat-panel__thread')
      return image.getBoundingClientRect().right - thread.getBoundingClientRect().right
    })
    assert.ok(overflow <= 1, `la vignette déborde de ${overflow}px`)
  })
})

test("un fichier qui n'est pas une image est refusé avec un message clair", options, async () => {
  await withPage(async (page) => {
    await page.setInputFiles('.chat-panel__composer input[type=file]', {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('bonjour')
    })

    await page.waitForSelector('.chat-panel__error')
    assert.match(await page.textContent('.chat-panel__error'), /non pris en charge/)
    assert.equal(await page.locator('.chat-panel__attachment').count(), 0)
  })
})

test.after(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})

/**
 * Mode Code : même mécanique, mais le composeur a son propre balisage (bouton "Image" dans
 * .code-panel__actions, aperçu dans le composeur lui-même). Vérifié séparément : le CSS est partagé, pas le
 * JSX — une régression dans l'un n'apparaîtrait pas dans l'autre.
 */
test('en mode Code, une maquette jointe part bien avec la demande de génération', options, async () => {
  await withPage(
    async (page) => {
      const dataUrl = await page.evaluate(MAKE_WIDE_PNG)
      await page.setInputFiles('.code-panel__composer input[type=file]', {
        name: 'maquette.png',
        mimeType: 'image/png',
        buffer: Buffer.from(dataUrl.split(',')[1], 'base64')
      })

      await page.waitForSelector('.code-panel__attachment img')
      assert.equal(await page.textContent('.code-panel__attachment-name'), 'maquette.png')

      // Une maquette seule doit suffire à lancer la génération, sans description écrite.
      const generateButton = page.locator('.code-panel__generate')
      assert.equal(await generateButton.isDisabled(), false)

      await generateButton.click()
      await page.waitForFunction(() => window.__sent.length === 1)

      const [sent] = await page.evaluate(() => window.__sent)
      assert.ok(sent.imageBase64, 'aucune maquette transmise au main process')
      assert.ok(!sent.imageBase64.startsWith('data:'))
      // Sans texte, une consigne par défaut prend le relais plutôt qu'une demande vide.
      assert.match(sent.prompt, /image jointe/i)

      // L'aperçu est vidé après la génération, pour ne pas rejoindre par erreur la demande suivante.
      assert.equal(await page.locator('.code-panel__attachment').count(), 0)
    },
    'CodePanel',
    '.code-panel__composer'
  )
})
