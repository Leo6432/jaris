import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * GitHub dans le mode Code (étape 277), sur le VRAI CodePanel et le vrai CSS compilé, avec un faux main.
 *
 * Léo : « pouvoir connecter Jaris à GitHub pour Code », « travailler sur mes dépôts », connexion « la plus
 * facile pour les utilisateurs ». Verrouillé ici : le bouton n'existe que si GitHub est configuré ; la
 * connexion montre le code à coller ; un dépôt choisi change ce que fait le champ ; les changements préparés
 * s'affichent ligne par ligne ; et RIEN ne part sur GitHub avant le clic sur « Enregistrer sur GitHub ».
 */
let chromium = null
try {
  ;({ chromium } = await import('/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}

const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const entryPath = join(projectRoot, 'tmp-github-ui-entry.tsx')

const ENTRY = `
import { createRoot } from 'react-dom/client'
import Panel from './src/components/CodePanel'

const VIEW = {
  fullName: 'leo/projet',
  branch: 'main',
  defaultBranch: 'main',
  private: true,
  htmlUrl: 'https://github.com/leo/projet',
  fileCount: 42,
  truncated: false,
  changes: []
}
const CHANGED = {
  ...VIEW,
  changes: [{ path: 'README.md', kind: 'modified', before: '# Projet\\nBonjour le mondee\\n', after: '# Projet\\nBonjour le monde\\n' }]
}

window.__status = { available: window.__available ?? true, connected: false, login: null }
window.__calls = { run: [], commit: [], open: [] }

window.jaris = {
  onCodeGenStatus: () => () => {},
  onCodeGenProgress: (cb) => { window.__emitProgress = cb; return () => {} },
  getGeneratedApps: () => Promise.resolve([{ path: 'C:/apps/liste', label: 'liste de courses', timestamp: Date.now() }]),
  loadGeneratedApp: (path) => Promise.resolve({ html: '<h1>ok</h1>', path, issues: [], previewUrl: 'about:blank' }),
  generateApp: () => Promise.reject(new Error('ne doit pas être appelé avec un dépôt ouvert')),
  cancelCodeGen: () => { window.__failAgent?.(new Error('aborted')) },
  openGeneratedApp: () => Promise.resolve(),
  deleteGeneratedApp: () => Promise.resolve(),
  getModelChoice: () => Promise.resolve({ selected: null, installed: [], autoModel: null }),
  setModelChoice: () => Promise.resolve(),
  pickImageFile: () => Promise.resolve(null),
  githubStatus: () => Promise.resolve(window.__status),
  githubStartLogin: () => Promise.resolve({ userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' }),
  githubFinishLogin: () => new Promise((resolve, reject) => {
    window.__approve = () => {
      window.__status = { available: true, connected: true, login: 'leo' }
      resolve(window.__status)
    }
    window.__denyLogin = () => reject(new Error("Error invoking remote method 'jaris:github-finish-login': GithubError: Connexion annulée."))
  }),
  githubCancelLogin: () => window.__denyLogin?.(),
  githubLogout: () => Promise.resolve(),
  githubListRepos: () => Promise.resolve([
    { fullName: 'leo/projet', private: true, description: 'Mon projet', defaultBranch: 'main', pushedAt: null },
    { fullName: 'leo/site', private: false, description: null, defaultBranch: 'main', pushedAt: null }
  ]),
  githubListBranches: () => Promise.resolve(['main', 'dev']),
  githubOpenRepo: (fullName, branch) => {
    window.__calls.open.push([fullName, branch])
    if (window.__emptyRepo) return Promise.resolve({ ...VIEW, fileCount: 0 })
    return Promise.resolve({ ...(window.__agentDone ? CHANGED : VIEW), branch: branch ?? 'main' })
  },
  githubRunAgent: (fullName, request) => {
    window.__calls.run.push([fullName, request])
    return new Promise((resolve, reject) => {
      window.__finishAgent = () => {
        window.__agentDone = true
        resolve({ summary: 'Faute corrigée dans le README.', view: CHANGED })
      }
      // Un modèle qui annonce un changement qu'il n'a pas fait (vu pour de vrai) : aucun fichier changé.
      window.__finishAgentEmpty = () => resolve({ summary: "J'ai ajouté 'oeufs'.", view: VIEW })
      window.__failAgent = reject
    })
  },
  githubDiscardChanges: () => Promise.resolve(VIEW),
  githubCommit: (fullName, message) => {
    window.__calls.commit.push([fullName, message])
    return Promise.resolve({ sha: 'abc1234def', url: 'https://github.com/leo/projet/commit/abc1234def', view: VIEW })
  }
}

createRoot(document.getElementById('root')).render(<Panel />)
`

let pageHtml = null

function buildPage() {
  if (pageHtml) return pageHtml
  const outDir = mkdtempSync(join(tmpdir(), 'jaris-github-ui-'))
  const bundlePath = join(outDir, 'bundle.js')
  writeFileSync(entryPath, ENTRY)
  try {
    execFileSync(
      'npx',
      ['esbuild', entryPath, '--bundle', '--format=iife', '--loader:.tsx=tsx', '--loader:.png=dataurl', '--jsx=automatic', `--alias:@=${join(projectRoot, 'src')}`, `--outfile=${bundlePath}`],
      { cwd: projectRoot, stdio: 'pipe' }
    )
  } finally {
    rmSync(entryPath, { force: true })
  }
  const css = readFileSync(globSync(join(projectRoot, 'out/renderer/assets/index-*.css'))[0], 'utf8')
  pageHtml = `<!doctype html><html><head><style>
    html,body{margin:0;height:100%;}
    #root{height:100%;display:flex;}
    ${css}
  </style></head><body><div id="root"></div><script>${readFileSync(bundlePath, 'utf8')}</script></body></html>`
  return pageHtml
}

async function withPage(run, { available = true, width = 1280 } = {}) {
  const html = buildPage().replace('<div id="root">', `<script>window.__available = ${available}</script><div id="root">`)
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.setViewportSize({ width, height: 860 })
    await page.setContent(html)
    await page.waitForSelector('.composer')
    await run(page)
  } finally {
    await browser.close()
  }
}

/** Connexion complète puis ouverture de leo/projet, partagée par plusieurs tests. */
async function connectAndOpen(page) {
  await page.click('.repo-picker__trigger')
  await page.click('.github-picker__primary')
  await page.waitForSelector('.github-picker__code')
  await page.evaluate(() => window.__approve())
  await page.waitForSelector('.github-picker__repo')
  await page.click('.github-picker__repo >> text=leo/projet')
  await page.waitForSelector('.branch-picker__trigger')
}

const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

test('sans application GitHub configurée, aucun bouton GitHub', options, async () => {
  await withPage(
    async (page) => {
      await page.waitForTimeout(100)
      assert.equal(await page.locator('.github-picker').count(), 0)
    },
    { available: false }
  )
})

test('connexion : le code à coller s’affiche, puis la liste des dépôts du compte', options, async () => {
  await withPage(async (page) => {
    await page.click('.repo-picker__trigger')
    assert.match(await page.textContent('.github-picker__panel'), /Connecte ton compte GitHub/)
    await page.click('.github-picker__primary')
    await page.waitForSelector('.github-picker__code')
    assert.equal(await page.textContent('.github-picker__code'), 'ABCD-1234')
    assert.match(await page.textContent('.github-picker__panel'), /déjà copié/)
    await page.evaluate(() => window.__approve())
    await page.waitForSelector('.github-picker__repo')
    assert.match(await page.textContent('.github-picker__account'), /@leo/)
    assert.equal(await page.locator('.github-picker__repo').count(), 2)
    // La recherche filtre la liste.
    await page.fill('.github-picker__search', 'site')
    assert.equal(await page.locator('.github-picker__repo').count(), 1)
  })
})

test('annuler la connexion ne montre pas d’erreur, et revient au bouton « Se connecter »', options, async () => {
  await withPage(async (page) => {
    await page.click('.repo-picker__trigger')
    await page.click('.github-picker__primary')
    await page.waitForSelector('.github-picker__code')
    await page.click('.github-picker__secondary >> text=Annuler')
    await page.waitForSelector('.github-picker__primary')
    assert.equal(await page.locator('.github-picker__error').count(), 0)
  })
})

test('un dépôt ouvert change le champ, puis les changements s’affichent ligne par ligne, SANS rien enregistrer', options, async () => {
  await withPage(async (page) => {
    await connectAndOpen(page)
    assert.equal(await page.textContent('.repo-picker__trigger .effort-picker__model'), 'projet')
    assert.equal(await page.getAttribute('.composer textarea', 'placeholder'), 'Que veux-tu changer dans leo/projet ?')
    // Étape 280 (Léo : « la branche mets pas en haut mais en bas comme le dépôt, comme sur ChatGPT ») : dépôt ET
    // branche dans le champ, rien au-dessus tant que Jaris n'a rien fait.
    assert.equal(await page.textContent('.branch-picker__name'), 'main')
    assert.equal(await page.locator('.repo-panel').count(), 0)
    const chips = await page.evaluate(() => {
      const composer = document.querySelector('.composer').getBoundingClientRect()
      const repo = document.querySelector('.repo-picker__trigger').getBoundingClientRect()
      const branch = document.querySelector('.branch-picker__trigger').getBoundingClientRect()
      return { inComposer: branch.top >= composer.top && branch.bottom <= composer.bottom, sameRow: Math.abs(branch.top - repo.top) < 2, after: branch.left > repo.left }
    })
    assert.deepEqual(chips, { inComposer: true, sameRow: true, after: true })

    await page.fill('.composer textarea', 'Corrige les fautes du README')
    await page.click('.composer__send')
    assert.deepEqual(await page.evaluate(() => window.__calls.run), [['leo/projet', 'Corrige les fautes du README']])

    // Avancement sans total connu : « Étape 2 », jamais « sur 0 ».
    await page.evaluate(() =>
      window.__emitProgress({ label: 'Travail sur leo/projet', stepIndex: 2, stepCount: 0, charsWritten: 0, thinking: true, idleMs: 0 })
    )
    await page.waitForSelector('.code-panel__live')
    assert.match(await page.textContent('.code-panel__live-title'), /^Étape 2 · Travail sur leo\/projet$/)

    await page.evaluate(() => window.__finishAgent())
    await page.waitForSelector('.repo-change')
    assert.match(await page.textContent('.repo-panel__summary'), /Faute corrigée/)
    assert.match(await page.textContent('.code-panel__done'), /1 fichier à vérifier/)
    assert.equal(await page.textContent('.repo-diff__line--del .repo-diff__text'), 'Bonjour le mondee')
    assert.equal(await page.textContent('.repo-diff__line--add .repo-diff__text'), 'Bonjour le monde')
    assert.match(await page.textContent('.repo-change__stats'), /\+1\s+−1/)
    // La branche ne se change pas tant que des changements attendent — et le panneau dit pourquoi.
    await page.click('.branch-picker__trigger')
    assert.match(await page.textContent('.github-picker__panel'), /avant de changer de branche/)
    assert.equal(await page.locator('.github-picker__panel .github-picker__repo').count(), 0)
    await page.keyboard.press('Escape')

    // RIEN n'est parti sur GitHub tant que Léo n'a pas cliqué.
    assert.deepEqual(await page.evaluate(() => window.__calls.commit), [])

    // La description proposée reprend la demande ; elle reste modifiable.
    assert.equal(await page.inputValue('.repo-panel__message'), 'Corrige les fautes du README')
    await page.fill('.repo-panel__message', 'Corrige une faute du README')
    await page.click('.repo-panel__save')
    await page.waitForSelector('.repo-panel__committed')
    assert.deepEqual(await page.evaluate(() => window.__calls.commit), [['leo/projet', 'Corrige une faute du README']])
    assert.equal(await page.getAttribute('.repo-panel__committed a', 'href'), 'https://github.com/leo/projet/commit/abc1234def')
    assert.equal(await page.locator('.repo-change').count(), 0)
  })
})

test('si aucun fichier n’a changé, le bandeau le dit, quoi que le modèle prétende', options, async () => {
  await withPage(async (page) => {
    await connectAndOpen(page)
    await page.fill('.composer textarea', 'Ajoute oeufs')
    await page.click('.composer__send')
    await page.evaluate(() => window.__finishAgentEmpty())
    await page.waitForSelector('.code-panel__done')
    assert.match(await page.textContent('.code-panel__done'), /aucun fichier n'a été changé/)
    assert.equal(await page.locator('.repo-panel__save').count(), 0)
  })
})

test('un dépôt tout neuf s’ouvre (étape 279) et propose de créer, pas d’expliquer', options, async () => {
  await withPage(async (page) => {
    await page.evaluate(() => {
      window.__emptyRepo = true
    })
    await connectAndOpen(page)
    // Étape 280 : plus de « Dépôt vide » en haut (Léo : « enlève dépôt vide »).
    assert.equal(await page.locator('.repo-panel').count(), 0)
    assert.doesNotMatch(await page.textContent('.code-panel'), /Dépôt vide/)
    assert.match(await page.textContent('.empty-state__title'), /encore vide/)
    assert.match(await page.textContent('.empty-state'), /Crée un petit site web/)
    assert.equal(await page.locator('.code-panel__error').count(), 0)
  })
})

test('changer de branche depuis le champ rouvre le dépôt sur cette branche', options, async () => {
  await withPage(async (page) => {
    await connectAndOpen(page)
    await page.click('.branch-picker__trigger')
    await page.waitForSelector('.github-picker__panel .github-picker__repo >> text=dev')
    assert.match(await page.textContent('.github-picker__panel'), /Principale/)
    await page.click('.github-picker__panel .github-picker__repo >> text=dev')
    await page.waitForFunction(() => window.__calls.open.some(([, branch]) => branch === 'dev'))
    assert.deepEqual(await page.evaluate(() => window.__calls.open.at(-1)), ['leo/projet', 'dev'])
    await page.waitForFunction(() => document.querySelector('.branch-picker__name')?.textContent === 'dev')
  })
})

test('les changements et les boutons sont réellement habillés par le CSS de Jaris', options, async () => {
  await withPage(async (page) => {
    await connectAndOpen(page)
    await page.fill('.composer textarea', 'Corrige')
    await page.click('.composer__send')
    await page.evaluate(() => window.__finishAgent())
    await page.waitForSelector('.repo-change')
    const styles = await page.evaluate(() => {
      const css = (selector) => getComputedStyle(document.querySelector(selector))
      return {
        add: css('.repo-diff__line--add').backgroundColor,
        del: css('.repo-diff__line--del').backgroundColor,
        save: css('.repo-panel__save').borderRadius,
        saveBg: css('.repo-panel__save').backgroundColor,
        trigger: css('.github-picker__trigger').height,
        mono: css('.repo-diff').fontFamily
      }
    })
    assert.notEqual(styles.add, 'rgba(0, 0, 0, 0)', 'ligne ajoutée sans couleur')
    assert.notEqual(styles.del, 'rgba(0, 0, 0, 0)', 'ligne retirée sans couleur')
    assert.notEqual(styles.add, styles.del)
    assert.equal(styles.save, '999px')
    assert.notEqual(styles.saveBg, 'rgba(0, 0, 0, 0)')
    assert.equal(styles.trigger, '34px')
    assert.match(styles.mono, /Mono|Consolas|monospace/)
  })
})

test('ouvrir une application de la liste ou « Nouvelle application » quitte le dépôt', options, async () => {
  await withPage(async (page) => {
    await connectAndOpen(page)
    await page.click('.workspace__new')
    await page.waitForSelector('.branch-picker__trigger', { state: 'detached' })
    assert.equal(await page.textContent('.repo-picker__trigger .effort-picker__model'), 'GitHub')
  })
})

test('à 760 px de large, rien ne déborde', options, async () => {
  await withPage(
    async (page) => {
      await connectAndOpen(page)
      await page.fill('.composer textarea', 'Corrige')
      await page.click('.composer__send')
      await page.evaluate(() => window.__finishAgent())
      await page.waitForSelector('.repo-change')
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      assert.ok(overflow <= 0, `débordement horizontal de ${overflow}px`)
    },
    { width: 760 }
  )
})
