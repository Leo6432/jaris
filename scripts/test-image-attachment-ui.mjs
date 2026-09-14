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
 *
 * `pickImageFile` (étape 93) remplace l'ancien `<input type="file">` : le sélecteur est désormais ouvert par
 * le main process, donc le test le simule comme n'importe quel autre canal IPC — `__nextPickedFile` est ce
 * que le main renverrait (null = dialogue annulé), et `__pickCalls` compte les ouvertures réelles.
 */
const ENTRY_FOR = (component) => `
import { createRoot } from 'react-dom/client'
import Panel from './src/components/${component}'

window.__sent = []
window.__nextPickedFile = null
window.__pickCalls = 0
window.jaris = {
  getChatHistory: () => Promise.resolve([]),
  // Ajouté à l'étape 96 : ChatPanel liste ses conversations au montage. Sans ce faux canal, le composant
  // plante dans son effet et la page ne rend jamais rien — le test paraît alors juste "bloqué".
  listConversations: () => Promise.resolve({ activeId: 'c1', conversations: [{ id: 'c1', title: 'Conversation', createdAt: '', updatedAt: '', messageCount: 0 }] }),
  onLog: () => () => {},
  onChatStreamToken: () => () => {},
  onCodeGenStatus: () => () => {},
  getGeneratedApps: () => Promise.resolve([]),
  getProfile: () => Promise.resolve({ soundEffectsEnabled: false }),
  pickImageFile: () => {
    window.__pickCalls += 1
    return Promise.resolve(window.__nextPickedFile)
  },
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
async function withPage(run, component = 'ChatPanel', readySelector = '.composer') {
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

/**
 * Simule ce que renvoie le sélecteur natif (main process) puis clique VRAIMENT sur le bouton de pièce
 * jointe — pas d'appel direct à la fonction interne : c'est le câblage bouton -> IPC -> réduction qui doit
 * être vérifié, puisque c'est précisément lui qui a changé à l'étape 93.
 */
async function pickFile(page, picked) {
  await page.evaluate((file) => {
    window.__nextPickedFile = file
  }, picked)
  await page.click('.composer__attach')
}

test('une image jointe est réduite, prévisualisée, puis envoyée en base64 avec le message', options, async () => {
  await withPage(async (page) => {
    const dataUrl = await page.evaluate(MAKE_WIDE_PNG)
    await pickFile(page, { name: 'maquette.png', type: 'image/png', base64: dataUrl.split(',')[1] })

    await page.waitForSelector('.composer__attachment img')
    assert.equal(await page.textContent('.composer__attachment-name'), 'maquette.png')

    // Envoyer doit être actif MÊME sans texte : une image seule ("regarde ça") est un envoi légitime.
    const sendButton = page.locator('.composer__send')
    assert.equal(await sendButton.isDisabled(), false)

    await page.fill('.composer__input', "C'est quoi sur cette image ?")
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
    assert.equal(await page.locator('.composer__attachment').count(), 0)

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
    // Le filtre du dialogue natif n'empêche pas de taper *.* et de choisir n'importe quoi : le main renvoie
    // alors un type vide, et le refus doit être le même que pour un collage non supporté.
    await pickFile(page, { name: 'notes.txt', type: '', base64: btoa('bonjour') })

    await page.waitForSelector('.chat-panel__error')
    assert.match(await page.textContent('.chat-panel__error'), /non pris en charge/)
    assert.equal(await page.locator('.composer__attachment').count(), 0)
  })
})

test('annuler le sélecteur ne signale aucune erreur et garde la pièce jointe en cours', options, async () => {
  await withPage(async (page) => {
    const dataUrl = await page.evaluate(MAKE_WIDE_PNG)
    await pickFile(page, { name: 'maquette.png', type: 'image/png', base64: dataUrl.split(',')[1] })
    await page.waitForSelector('.composer__attachment img')

    // null = dialogue fermé sans rien choisir : ni erreur affichée, ni image perdue.
    await pickFile(page, null)
    await page.waitForFunction(() => window.__pickCalls === 2)
    assert.equal(await page.locator('.chat-panel__error').count(), 0)
    assert.equal(await page.textContent('.composer__attachment-name'), 'maquette.png')
  })
})

test.after(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true })
})

/**
 * Mode Code : le composeur est le MÊME composant qu'en Chat depuis l'étape 92, mais il est piloté par un
 * autre panneau (état, libellés, envoi vers generateApp au lieu de sendChatMessage). Vérifié séparément :
 * une régression du câblage dans l'un n'apparaîtrait pas dans l'autre.
 */
test('en mode Code, une maquette jointe part bien avec la demande de génération', options, async () => {
  await withPage(
    async (page) => {
      const dataUrl = await page.evaluate(MAKE_WIDE_PNG)
      await pickFile(page, { name: 'maquette.png', type: 'image/png', base64: dataUrl.split(',')[1] })

      await page.waitForSelector('.composer__attachment img')
      assert.equal(await page.textContent('.composer__attachment-name'), 'maquette.png')

      // Une maquette seule doit suffire à lancer la génération, sans description écrite.
      const generateButton = page.locator('.composer__send')
      assert.equal(await generateButton.isDisabled(), false)

      await generateButton.click()
      await page.waitForFunction(() => window.__sent.length === 1)

      const [sent] = await page.evaluate(() => window.__sent)
      assert.ok(sent.imageBase64, 'aucune maquette transmise au main process')
      assert.ok(!sent.imageBase64.startsWith('data:'))
      // Sans texte, une consigne par défaut prend le relais plutôt qu'une demande vide.
      assert.match(sent.prompt, /image jointe/i)

      // L'aperçu est vidé après la génération, pour ne pas rejoindre par erreur la demande suivante.
      assert.equal(await page.locator('.composer__attachment').count(), 0)
    },
    'CodePanel',
    '.composer'
  )
})
