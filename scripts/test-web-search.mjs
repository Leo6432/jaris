import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 337 (Léo : « enlève Docker et mets DuckDuckGo ») : la recherche web lit la page de résultats d'un moteur dans
 * une fenêtre cachée du navigateur de Jaris. La fenêtre elle-même est simulée ici (loader) ; vérifiés : le passage au
 * second moteur, la reconnaissance d'un blocage anti-robot, un message clair quand rien ne marche, les liens du moteur
 * écartés, le script lu dans la page (sélecteurs seulement), la garde de navigation de main.ts, et le retrait de
 * l'ancien conteneur SearXNG.
 */
const nodeRequire = createRequire(import.meta.url)
const webSearch = loadTsModule('electron/services/webSearch.ts')
const { searchWebDetailed, SEARCH_ENGINES, cleanResults, extractionScript } = webSearch
const [DDG, STARTPAGE] = SEARCH_ENGINES

const page = (results, bodyText = '') => ({ results, bodyText })
const result = (n, host = 'exemple.fr') => ({ title: `Titre ${n}`, url: `https://${host}/page-${n}`, content: `Extrait ${n}` })

function recordingLoader(answers) {
  const calls = []
  const loader = async (engine, url) => {
    calls.push({ engine: engine.name, url })
    const answer = answers[engine.name]
    if (answer instanceof Error) throw answer
    return answer
  }
  return { loader, calls }
}

test('DuckDuckGo répond : ses résultats, sans jamais demander à Startpage', async () => {
  const { loader, calls } = recordingLoader({ DuckDuckGo: page([result(1), result(2)]) })
  const { text, sources } = await searchWebDetailed('prix du pain', loader)
  assert.deepEqual(calls.map((c) => c.engine), ['DuckDuckGo'])
  assert.equal(calls[0].url, 'https://duckduckgo.com/?q=prix%20du%20pain')
  assert.equal(text, '1. Titre 1 — Extrait 1 (https://exemple.fr/page-1)\n2. Titre 2 — Extrait 2 (https://exemple.fr/page-2)')
  assert.deepEqual(sources, [
    { title: 'Titre 1', url: 'https://exemple.fr/page-1' },
    { title: 'Titre 2', url: 'https://exemple.fr/page-2' }
  ])
})

test('DuckDuckGo demande une vérification anti-robot : Startpage prend le relais', async () => {
  const { loader, calls } = recordingLoader({
    DuckDuckGo: page([], 'Veuillez confirmer que vous n’êtes pas un robot. CAPTCHA'),
    Startpage: page([result(7)])
  })
  const { text } = await searchWebDetailed('météo lille', loader)
  assert.deepEqual(calls.map((c) => c.engine), ['DuckDuckGo', 'Startpage'])
  assert.match(text, /Titre 7/)
})

test('rien ne marche : un message clair qui dit pourquoi pour chaque moteur', async () => {
  const offline = new Error('ERR_INTERNET_DISCONNECTED (-106) loading https://duckduckgo.com/?q=x')
  const { loader } = recordingLoader({ DuckDuckGo: offline, Startpage: page([], 'Unusual traffic from your network') })
  await assert.rejects(searchWebDetailed('x', loader), (err) => {
    assert.match(err.message, /^La recherche sur internet n'a pas abouti\./)
    assert.match(err.message, /DuckDuckGo : pas de connexion à internet/)
    assert.match(err.message, /Startpage : il demande de prouver qu'on n'est pas un robot/)
    // Plus jamais SearXNG ni Docker dans ce qui s'affiche.
    assert.doesNotMatch(err.message, /SearXNG|Docker/)
    return true
  })
})

test('un délai dépassé est dit comme tel', async () => {
  const { loader } = recordingLoader({ DuckDuckGo: new Error('timeout'), Startpage: new Error('timeout') })
  await assert.rejects(searchWebDetailed('x', loader), /DuckDuckGo : pas de réponse à temps · Startpage : pas de réponse à temps/)
})

test('les deux moteurs répondent sans résultat : « aucun résultat », pas une panne', async () => {
  const { loader, calls } = recordingLoader({ DuckDuckGo: page([], 'Aucun résultat'), Startpage: page([], 'Pas de résultat') })
  const { text, sources } = await searchWebDetailed('xqzwv', loader)
  assert.equal(calls.length, 2, 'le second moteur est quand même essayé')
  assert.equal(text, 'Aucun résultat trouvé pour « xqzwv ».')
  assert.deepEqual(sources, [])
})

test('les liens du moteur lui-même (publicités, redirections), les doublons et les adresses non web sont écartés', () => {
  const raw = [
    { title: 'Pub', url: 'https://www.startpage.com/clev?event=x', content: 'publicité' },
    { title: ' Piscine  du Petit Port ', url: 'https://petitport-nantes.fr/', content: 'Ouvert\n jusqu’à 14 h' },
    { title: 'Doublon', url: 'https://petitport-nantes.fr/', content: 'x' },
    { title: 'Piège', url: 'javascript:alert(1)', content: 'x' },
    { title: null, url: 'https://sans-titre.fr/', content: null },
    ...[1, 2, 3, 4, 5].map((n) => result(n))
  ]
  const kept = cleanResults(raw, STARTPAGE)
  assert.equal(kept.length, 5, 'les 5 premiers seulement')
  assert.deepEqual(kept[0], { title: 'Piscine du Petit Port', url: 'https://petitport-nantes.fr/', content: 'Ouvert jusqu’à 14 h' })
  assert.deepEqual(kept[1], { title: 'https://sans-titre.fr/', url: 'https://sans-titre.fr/', content: '' })
  assert.ok(!kept.some((r) => r.url.includes('startpage.com') || r.url.startsWith('javascript:')))
  // DuckDuckGo n'écarte que ses propres liens.
  assert.equal(cleanResults([{ title: 'x', url: 'https://duckduckgo.com/y.js?ad=1' }], DDG).length, 0)
  assert.equal(cleanResults([{ title: 'x', url: 'https://www.startpage.com/a' }], DDG).length, 1)
})

test('la recherche tapée n’entre jamais dans le script exécuté dans la page', () => {
  for (const engine of SEARCH_ENGINES) {
    const script = extractionScript(engine)
    assert.ok(script.includes(JSON.stringify(engine.item)))
    // Le script ne dépend que du moteur : aucun texte de la recherche ne peut y être glissé.
    assert.equal(script, extractionScript({ ...engine, searchUrl: () => 'autre' }))
  }
  assert.equal(DDG.searchUrl('a&b "c" <d>'), 'https://duckduckgo.com/?q=a%26b%20%22c%22%20%3Cd%3E')
})

// La structure réelle des pages (relevée sur DuckDuckGo et Startpage le 21/10/2026), lue par le VRAI script.
let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}
const DDG_PAGE = `<html><body>
  <article data-testid="ad"><a data-testid="result-title-a" href="https://pub.fr/">Pub</a></article>
  <article data-testid="result"><h2><a data-testid="result-title-a" href="https://fr.wikipedia.org/wiki/ChatGPT"><span>ChatGPT — Wikipédia</span></a></h2>
    <div data-result="snippet"><span>ChatGPT est lancé en novembre 2022.</span></div></article>
  <article data-testid="result"><h2><a data-testid="result-title-a" href="https://openai.com/">OpenAI</a></h2></article>
</body></html>`
const STARTPAGE_PAGE = `<html><body><div class="w-gl">
  <div class="result"><a class="wgl-site-title" href="https://finance.yahoo.com/quote/BTC-USD/">Yahoo Finance</a>
    <a class="result-title result-link" href="https://finance.yahoo.com/quote/BTC-USD/"><h2 class="wgl-title">Bitcoin BTC Live Price</h2></a>
    <p class="description">Find the live <b>Bitcoin</b> price.</p></div>
</div></body></html>`

test('le script lit la vraie structure des deux moteurs (titre, adresse, extrait)', { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }, async () => {
  const browser = await chromium.launch()
  try {
    const p = await browser.newPage()
    await p.setContent(DDG_PAGE)
    const ddg = await p.evaluate(extractionScript(DDG))
    assert.deepEqual(cleanResults(ddg.results, DDG), [
      { title: 'ChatGPT — Wikipédia', url: 'https://fr.wikipedia.org/wiki/ChatGPT', content: 'ChatGPT est lancé en novembre 2022.' },
      { title: 'OpenAI', url: 'https://openai.com/', content: '' }
    ])
    await p.setContent(STARTPAGE_PAGE)
    const sp = await p.evaluate(extractionScript(STARTPAGE))
    assert.deepEqual(cleanResults(sp.results, STARTPAGE), [
      { title: 'Bitcoin BTC Live Price', url: 'https://finance.yahoo.com/quote/BTC-USD/', content: 'Find the live Bitcoin price.' }
    ])
  } finally {
    await browser.close()
  }
})

test('main.ts : une page de recherche suit ses propres règles et n’ouvre JAMAIS rien dans le navigateur de Windows', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const start = main.indexOf("app.on('web-contents-created'")
  const block = main.slice(start, main.indexOf('\n})', start))
  assert.match(block, /will-navigate[\s\S]*?if \(isSearchContents\(contents\.id\)\) return/)
  assert.match(block, /setWindowOpenHandler\([\s\S]*?if \(!isSearchContents\(contents\.id\) && isWebUrl\(url\)\) void shell\.openExternal\(url\)/)
  // Docker et SearXNG ne sont plus lancés au démarrage.
  assert.doesNotMatch(main, /ensureSearxngRunning|installDockerDesktop/)
})

test('webSearch.ts : la fenêtre cachée ne peut ni demander une permission, ni télécharger, ni quitter le moteur', () => {
  const source = readFileSync(new URL('../electron/services/webSearch.ts', import.meta.url), 'utf8')
  assert.match(source, /setPermissionRequestHandler\(\(_contents, _permission, callback\) => callback\(false\)\)/)
  assert.match(source, /will-download', \(event\) => event\.preventDefault\(\)/)
  assert.match(source, /if \(!host \|\| !belongsTo\(host, engine\.domain\)\) event\.preventDefault\(\)/)
  assert.match(source, /show: false/)
  assert.match(source, /sandbox: true, contextIsolation: true, nodeIntegration: false/)
})

// ————— Retrait de l'ancien conteneur SearXNG —————

const legacy = loadTsModule('electron/services/legacyCleanup.ts', {
  child_process: { execFile: () => { throw new Error('jamais appelé dans ces tests') } },
  'fs/promises': nodeRequire('fs/promises'),
  path: nodeRequire('path')
})

function leftoverRoot() {
  const root = mkdtempSync(join(tmpdir(), 'jaris-searxng-'))
  mkdirSync(join(root, 'searxng-docker', 'searxng'), { recursive: true })
  writeFileSync(join(root, 'searxng-docker', 'docker-compose.yml'), 'services: {}')
  writeFileSync(join(root, 'profile.json'), '{"name":"Léo"}')
  return root
}

function fakeDocker({ missing = false, stopped = false, containers = {}, imageInUse = false } = {}) {
  const calls = []
  const docker = async (args) => {
    calls.push(args.join(' '))
    if (missing) throw Object.assign(new Error('spawn docker ENOENT'), { code: 'ENOENT' })
    if (args[0] === '--version') return 'Docker version 28.0.0'
    if (stopped) throw new Error('Cannot connect to the Docker daemon')
    if (args[0] === 'ps') {
      const key = args.filter((a) => a.startsWith('label=')).join(' ')
      return (containers[key] ?? []).join('\n')
    }
    if (args[0] === 'images') return 'abc123\r\n'
    if (args[0] === 'rmi' && imageInUse) throw new Error('image is being used')
    return ''
  }
  return { docker, calls }
}

test('conteneurs SearXNG de Jaris retirés (les deux projets), puis l’image et le dossier', async () => {
  const root = leftoverRoot()
  const { docker, calls } = fakeDocker({
    containers: {
      'label=com.docker.compose.project=jaris-searxng': ['c1'],
      'label=com.docker.compose.project=resources label=com.docker.compose.service=searxng': ['c0']
    }
  })
  assert.equal(await legacy.removeLeftoverSearxng(root, docker), true)
  assert.ok(calls.includes('rm -f c1') && calls.includes('rm -f c0'), calls.join(' | '))
  assert.ok(calls.includes('rmi abc123'))
  assert.ok(!existsSync(join(root, 'searxng-docker')))
  assert.equal(readFileSync(join(root, 'profile.json'), 'utf8'), '{"name":"Léo"}', 'rien d’autre n’est touché')
  // Jamais de désinstallation de Docker Desktop, jamais un conteneur hors des projets de Jaris.
  assert.ok(calls.every((c) => /^(--version|ps -aq --filter label=com\.docker\.compose\.project=(jaris-searxng|resources)|rm -f c[01]|images -q searxng\/searxng|rmi abc123)/.test(c)), calls.join(' | '))
  rmSync(root, { recursive: true, force: true })
})

test('Docker arrêté : rien n’est retiré, le dossier reste pour le prochain démarrage', async () => {
  const root = leftoverRoot()
  const { docker } = fakeDocker({ stopped: true })
  assert.equal(await legacy.removeLeftoverSearxng(root, docker), false)
  assert.ok(existsSync(join(root, 'searxng-docker', 'docker-compose.yml')))
  rmSync(root, { recursive: true, force: true })
})

test('Docker absent : plus rien à retirer, le dossier part', async () => {
  const root = leftoverRoot()
  const { docker, calls } = fakeDocker({ missing: true })
  assert.equal(await legacy.removeLeftoverSearxng(root, docker), true)
  assert.deepEqual(calls, ['--version'])
  assert.ok(!existsSync(join(root, 'searxng-docker')))
  rmSync(root, { recursive: true, force: true })
})

test('image encore utilisée ailleurs : gardée, le reste du ménage est fait', async () => {
  const root = leftoverRoot()
  const { docker } = fakeDocker({ imageInUse: true })
  assert.equal(await legacy.removeLeftoverSearxng(root, docker), true)
  assert.ok(!existsSync(join(root, 'searxng-docker')))
  rmSync(root, { recursive: true, force: true })
})

test('jamais installé : Docker n’est même pas interrogé', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jaris-searxng-'))
  const { docker, calls } = fakeDocker()
  assert.equal(await legacy.removeLeftoverSearxng(root, docker), false)
  assert.deepEqual(calls, [])
  rmSync(root, { recursive: true, force: true })
})

test('plus aucun reste de SearXNG ni de Docker dans le programme livré', () => {
  const builder = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  assert.doesNotMatch(builder, /docker-compose|searxng/)
  for (const gone of ['../docker-compose.yml', '../searxng/settings.yml', '../electron/services/searxngHome.ts', '../electron/services/dockerLocation.ts']) {
    assert.ok(!existsSync(new URL(gone, import.meta.url)), `${gone} existe encore`)
  }
})
