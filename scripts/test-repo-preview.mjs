import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Aperçu jouable d'un dépôt GitHub (étape 287, Léo : « à droite faut pas que c'est le menu pour enregistrer sur
 * GitHub, mais pouvoir jouer directement et tester un vrai aperçu »). Le protocole jaris-preview sert maintenant les
 * fichiers d'un dépôt à côté de sa page. Verrouillé ici, sans Electron :
 *  - rien ne sort du dépôt (`..`, `.`, antislash, caractère nul) ;
 *  - chaque fichier part avec son vrai type (sinon le navigateur refuse une feuille de style ou un module) ;
 *  - un site publié depuis un sous-dossier retrouve ses fichiers écrits en « /style.css » ;
 *  - la page reste isolée (sandbox), sans envoi de formulaire ni page imbriquée ;
 *  - l'aperçu d'une application générée, lui, ne change pas.
 */
const handlers = []
const schemes = []
const preview = loadTsModule('electron/services/generatedAppPreview.ts', {
  electron: { protocol: { registerSchemesAsPrivileged: (list) => schemes.push(...list), handle: (scheme, handler) => handlers.push({ scheme, handler }) } },
  crypto: { randomUUID }
})
preview.registerPreviewScheme()
preview.registerPreviewHandler()
const handler = handlers[0].handler

const FILES = {
  'index.html': '<link rel="stylesheet" href="style.css"><script src="jeu.js"></script>',
  'style.css': 'body { color: red }',
  'jeu.js': 'console.log(1)',
  'img/pomme.png': new Uint8Array([137, 80, 78, 71]),
  'docs/index.html': '<link href="/theme.css">',
  'docs/theme.css': 'h1 {}'
}
const read = async (path) => FILES[path]

const get = (url) => handler(new Request(url))

test('le protocole accepte les requêtes CORS et fetch d’un site (polices, modules, données)', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(schemes)), [
    { scheme: 'jaris-preview', privileges: { standard: true, secure: true, corsEnabled: true, supportFetchAPI: true } }
  ])
})

test('la page et ses fichiers sont servis avec leur vrai type, depuis l’adresse de l’aperçu', async () => {
  const url = preview.createFilesPreview('index.html', read)
  assert.match(url, /^jaris-preview:\/\/[0-9a-f-]{36}\/index\.html$/)
  const base = url.slice(0, url.lastIndexOf('/'))
  const page = await get(url)
  assert.equal(page.status, 200)
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(await page.text(), FILES['index.html'])
  assert.equal((await get(`${base}/style.css`)).headers.get('content-type'), 'text/css; charset=utf-8')
  assert.equal((await get(`${base}/jeu.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8')
  const image = await get(`${base}/img/pomme.png`)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [137, 80, 78, 71])
  // Un cache-busting « ?v=2 » ne casse rien ; un dossier sert son index.html.
  assert.equal((await get(`${base}/style.css?v=2`)).status, 200)
  assert.equal(await (await get(`${base}/`)).text(), FILES['index.html'])
  assert.equal((await get(`${base}/absent.js`)).status, 404)
})

test('rien ne sort du dépôt', async () => {
  for (const path of ['/../secret', '/%2e%2e/secret', '/img/../../x', '/a\\\\b', '/%00', '/./style.css', '/%E0%A4%A']) {
    assert.equal(preview.previewPath(path), null, path)
  }
  const asked = []
  const url = preview.createFilesPreview('index.html', async (path) => {
    asked.push(path)
    return FILES[path]
  })
  const base = url.slice(0, url.lastIndexOf('/'))
  // L'adresse ramène déjà « %2e%2e » à la racine de l'aperçu : on reste DANS le dépôt, où ce fichier n'existe pas.
  assert.equal((await get(`${base}/%2e%2e/%2e%2e/etc/passwd`)).status, 404)
  assert.ok(asked.every((path) => !path.split('/').includes('..')), JSON.stringify(asked))
})

test('un site publié depuis docs/ retrouve ses fichiers écrits « /theme.css »', async () => {
  const url = preview.createFilesPreview('docs/index.html', read)
  assert.match(url, /\/docs\/index\.html$/)
  const base = url.slice(0, url.indexOf('/docs/'))
  const css = await get(`${base}/theme.css`)
  assert.equal(css.status, 200)
  assert.equal(await css.text(), 'h1 {}')
})

test('la page reste isolée : sandbox, aucun envoi de formulaire, aucune page imbriquée', async () => {
  const url = preview.createFilesPreview('index.html', read)
  const csp = (await get(url)).headers.get('content-security-policy')
  assert.equal(csp, preview.REPO_PREVIEW_CSP)
  assert.match(csp, /sandbox allow-scripts allow-forms$/)
  assert.doesNotMatch(csp, /allow-same-origin/)
  assert.match(csp, /form-action 'none'/)
  assert.match(csp, /frame-src 'none'/)
  assert.match(csp, /script-src jaris-preview: /)
})

test('l’aperçu d’une application générée ne change pas (une seule page, règles strictes)', async () => {
  const url = preview.createGeneratedAppPreview('<h1>App</h1>')
  const base = url.slice(0, url.lastIndexOf('/'))
  const page = await get(url)
  assert.equal(await page.text(), '<h1>App</h1>')
  assert.equal(page.headers.get('content-security-policy'), preview.PREVIEW_CSP)
  assert.equal((await get(`${base}/style.css`)).status, 404)
  assert.equal((await get(`${url}?x=1`)).status, 404)
})
