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

window.__status = { available: window.__available ?? true, connected: false, login: null, lost: window.__lost ?? null }
window.__calls = { run: [], commit: [], open: [], preview: [] }

window.jaris = {
  onCodeGenStatus: () => () => {},
  onCodeGenProgress: (cb) => { window.__emitProgress = cb; return () => {} },
  // Étape 286 : les actions sur les fichiers s'affichent dans la conversation (« Modifié README.md +1 −1 »).
  onCodeGenActivity: (cb) => { window.__emitActivity = cb; return () => {} },
  onCodeGenNarration: (cb) => { window.__emitNarration = cb; return () => {} },
  // Étape 288 : le fichier en cours d'écriture, en direct dans la conversation.
  onCodeGenLive: (cb) => { window.__emitLive = cb; return () => {} },
  getGeneratedApps: () => Promise.resolve([{ path: 'C:/apps/liste', label: 'liste de courses', timestamp: Date.now() }]),
  // Conversations du mode Code (code-conversations.json, tenu par le main) : un fichier vide au départ, et l'écran
  // garde ses changements en mémoire le temps de la page.
  loadCodeConversations: () => ({ repos: [], conversations: {} }),
  saveCodeConversation: () => Promise.resolve(),
  saveCodeRepos: () => Promise.resolve(),
  importCodeConversations: () => Promise.resolve(),
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
  // Pendant un « Déplacer », le vrai main refuse la déconnexion (github.err.dataMoving) : __logoutRefused le simule.
  githubLogout: () =>
    window.__logoutRefused
      ? Promise.reject(new Error("Error invoking remote method 'jaris:github-logout': GithubError: " + window.__logoutRefused))
      : Promise.resolve(),
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
  pickImageFile: () => Promise.resolve(window.__nextPickedFile ?? null),
  githubRunAgent: (fullName, request, imageBase64) => {
    window.__calls.run.push(imageBase64 ? [fullName, request, imageBase64] : [fullName, request])
    return new Promise((resolve, reject) => {
      window.__finishAgent = () => {
        window.__agentDone = true
        // Étape 303 : « finished » comme le vrai main ; __agentUnfinished simule un travail interrompu en route
        // (limite d'étapes), qui reste en attente au lieu d'être enregistré tout seul.
        resolve({
          summary: 'Faute corrigée dans le README.',
          view: window.__manyChanges ? { ...CHANGED, changes: window.__manyChanges } : CHANGED,
          finished: !window.__agentUnfinished
        })
      }
      // Un modèle qui annonce un changement qu'il n'a pas fait (vu pour de vrai) : aucun fichier changé.
      window.__finishAgentEmpty = () => resolve({ summary: "J'ai ajouté 'oeufs'.", view: VIEW, finished: true })
      window.__failAgent = reject
    })
  },
  githubDiscardChanges: (fullName, path) => {
    window.__calls.discard = [...(window.__calls.discard ?? []), [fullName, path ?? null]]
    window.__agentDone = false
    return Promise.resolve(VIEW)
  },
  // Étape 287 : le site du dépôt, jouable dans l'aperçu. Une adresse différente à chaque demande, comme le vrai main.
  githubPreview: (fullName) => {
    window.__calls.preview.push(fullName)
    if (window.__noSite) return Promise.resolve({ entry: null, url: null })
    // Pas « about:blank#… » : dans une page elle-même en about:blank, Chromium tue la page (« bad IPC message,
    // reason 114 », vérifié ici). Une adresse data: différente à chaque demande, comme le vrai main.
    return Promise.resolve({ entry: 'index.html', url: 'data:text/html,<p>site ' + window.__calls.preview.length + '</p>' })
  },
  // Étape 327 : la vue « Code » — les fichiers du dépôt, puis le texte de celui qu'on ouvre (version préparée d'abord).
  githubListFiles: (fullName) => {
    window.__calls.listFiles = [...(window.__calls.listFiles ?? []), fullName]
    return Promise.resolve(['README.md', 'index.html', 'logo.png', 'src/app.js', 'src/styles/main.css'])
  },
  githubReadFile: (fullName, path) => {
    window.__calls.read = [...(window.__calls.read ?? []), path]
    const files = {
      'README.md': window.__agentDone ? '# Projet\\nBonjour le monde\\n' : '# Projet\\nBonjour le mondee\\n',
      'index.html': '<h1>Projet</h1>\\n<script src="src/app.js"></script>\\n',
      'logo.png': null,
      'src/app.js': 'console.log("ok")\\n',
      'src/styles/main.css': 'h1 { color: tomato; }\\n'
    }
    return Promise.resolve(path in files ? { text: files[path] } : { text: null, missing: true })
  },
  githubCommit: (fullName, message) => {
    window.__calls.commit.push([fullName, message])
    // Comme le vrai : une fois enregistré, plus rien n'est préparé (rouvrir le dépôt le retrouve propre).
    window.__agentDone = false
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

async function withPage(run, { available = true, width = 1280, lost = null } = {}) {
  const html = buildPage().replace('<div id="root">', `<script>window.__available = ${available}; window.__lost = ${JSON.stringify(lost)}</script><div id="root">`)
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

// Étape 297 (Léo : « ça déconnecte GitHub tous les jours ») : la raison réelle s'affiche au-dessus du bouton.
test('« Se déconnecter » refusé (données en cours de déplacement) : le message s’affiche et le panneau reste connecté', options, async () => {
  await withPage(async (page) => {
    await page.click('.repo-picker__trigger')
    await page.click('.github-picker__primary')
    await page.waitForSelector('.github-picker__code')
    await page.evaluate(() => window.__approve())
    await page.waitForSelector('.github-picker__account')
    const refusal = "Jaris déplace tes données vers un autre dossier : la connexion à GitHub est en pause jusqu'à son redémarrage. Réessaie juste après."
    await page.evaluate((message) => {
      window.__logoutRefused = message
    }, refusal)
    await page.click('.github-picker__head .github-picker__secondary')
    // Le refus est dit, sans le préfixe technique d'Electron (« Error invoking remote method… »).
    await page.waitForSelector('.github-picker__error')
    assert.equal(await page.textContent('.github-picker__error'), refusal)
    // Toujours connecté : le compte et la liste des dépôts restent affichés, pas « Se connecter ».
    assert.match(await page.textContent('.github-picker__account'), /@leo/)
    assert.equal(await page.locator('.github-picker__primary').count(), 0)
    assert.ok((await page.locator('.github-picker__repo').count()) > 0)
    // Une fois le déplacement fini, la déconnexion passe et le message disparaît.
    await page.evaluate(() => {
      window.__logoutRefused = null
    })
    await page.click('.github-picker__head .github-picker__secondary')
    await page.waitForSelector('.github-picker__primary')
    assert.equal(await page.locator('.github-picker__error').count(), 0)
  })
})

test('déconnecté par GitHub : la raison s’affiche, habillée, au-dessus de « Se connecter »', options, async () => {
  const connectedAt = new Date(2026, 9, 10, 9, 5).getTime()
  await withPage(
    async (page) => {
      await page.click('.repo-picker__trigger')
      await page.waitForSelector('.github-picker__lost')
      const text = await page.textContent('.github-picker__lost')
      assert.match(text, /a été refusée par GitHub/)
      assert.match(text, /10 octobre/)
      assert.doesNotMatch(text, /\{date\}/)
      const lost = await page.$eval('.github-picker__lost', (el) => ({ top: el.getBoundingClientRect().top, border: getComputedStyle(el).borderTopWidth }))
      const button = await page.$eval('.github-picker__primary', (el) => el.getBoundingClientRect().top)
      assert.ok(lost.top < button, 'la raison doit précéder le bouton')
      assert.equal(lost.border, '1px', 'message non habillé par le CSS de Jaris')
    },
    { lost: { reason: 'rejected', login: 'leo', connectedAt } }
  )
  // Jamais connecté : pas de message.
  await withPage(async (page) => {
    await page.click('.repo-picker__trigger')
    await page.waitForSelector('.github-picker__primary')
    assert.equal(await page.locator('.github-picker__lost').count(), 0)
  })
})

// Étape 298 (Léo : « on peut ajouter une image pour une nouvelle conversation, mais en plein chat on n'a pas le
// bouton à gauche ») : avec un dépôt ouvert, le « + » et l'image restent là, et la capture part avec la demande.
test('dépôt ouvert : le bouton « + » permet de joindre une capture, envoyée avec la demande', options, async () => {
  await withPage(async (page) => {
    await connectAndOpen(page)
    await page.waitForSelector('.composer__plus')
    // Une petite image rouge, comme une vraie capture (le champ la réduit et la réencode).
    const base64 = await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 40
      canvas.height = 20
      const context = canvas.getContext('2d')
      context.fillStyle = '#c0392b'
      context.fillRect(0, 0, 40, 20)
      return canvas.toDataURL('image/png').split(',')[1]
    })
    await page.evaluate((data) => {
      window.__nextPickedFile = { name: 'site.png', type: 'image/png', base64: data }
    }, base64)
    await page.click('.composer__plus')
    await page.click('.composer__menu-item:has-text("Joindre une image")')
    await page.waitForSelector('.composer__attachment img')
    // Une image seule suffit : « Envoyer » est actif sans texte.
    assert.equal(await page.locator('.composer__send').isDisabled(), false)
    await page.click('.composer__send')
    await page.waitForFunction(() => window.__calls.run.length === 1)
    const [[fullName, request, sentImage]] = await page.evaluate(() => window.__calls.run)
    assert.equal(fullName, 'leo/projet')
    assert.match(request, /image jointe/)
    assert.ok(typeof sentImage === 'string' && sentImage.length > 20, 'la capture doit partir avec la demande')
    await page.evaluate(() => window.__finishAgent())
    await page.waitForSelector('.changes-card')
    assert.equal(await page.locator('.composer__attachment').count(), 0, 'la capture envoyée ne reste pas dans le champ')
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
    // Étape 303 : travail interrompu en route — il reste en attente (vérifier, annuler, enregistrer à la main).
    await page.evaluate(() => {
      window.__agentUnfinished = true
    })
    assert.equal(await page.textContent('.repo-picker__trigger .effort-picker__model'), 'projet')
    assert.equal(await page.getAttribute('.composer textarea', 'placeholder'), 'Que veux-tu changer dans leo/projet ?')
    // Étape 280 (Léo : « la branche mets pas en haut mais en bas comme le dépôt, comme sur ChatGPT ») : dépôt ET
    // branche dans le champ, rien au-dessus tant que Jaris n'a rien fait.
    assert.equal(await page.textContent('.branch-picker__name'), 'main')
    assert.equal(await page.locator('.repo-panel').count(), 0)
    // Étape 287 (Léo : « pouvoir jouer directement et tester un vrai aperçu ») : le site du dépôt est jouable dès
    // l'ouverture, dans la carte, sans onglets tant que rien n'a changé.
    await page.waitForSelector('.code-preview iframe.code-panel__preview')
    assert.equal(await page.getAttribute('.code-panel__preview', 'title'), 'Aperçu de leo/projet')
    assert.equal(await page.getAttribute('.code-panel__preview', 'sandbox'), 'allow-scripts allow-forms')
    assert.equal(await page.locator('.code-preview__changes-tab').count(), 0)
    const firstSite = await page.getAttribute('.code-panel__preview', 'src')
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

    // Étape 288 (Léo : « enlève ça [Étape 3 · Travail sur … · Arrêter] […] mets ce qu'il fait en direct ») : une ligne
    // de la conversation dit le fichier que Jaris écrit, plus de bandeau « Étape N · Travail sur … ».
    await page.evaluate(() =>
      window.__emitProgress({ label: 'Travail sur leo/projet', stepIndex: 2, stepCount: 0, charsWritten: 0, thinking: true, idleMs: 0, phase: 'thinking' })
    )
    await page.waitForSelector('.code-chat__live')
    assert.equal(await page.locator('.code-panel__live').count(), 0, 'le bandeau « Étape » est revenu')
    await page.evaluate(() => window.__emitLive({ kind: 'edit', path: 'README.md', lines: 3 }))
    assert.equal(
      await page.evaluate(() => [...document.querySelectorAll('.code-chat__live > span:not(.code-chat__live-dot)')].map((part) => part.textContent).join(' ')),
      'Modifie README.md +3 lignes'
    )

    await page.evaluate(() => window.__finishAgent())
    await page.waitForSelector('.changes-card')
    // Étape 287 : après le travail de Jaris, à droite c'est le SITE (avec ses changements), pas le menu d'enregistrement.
    await page.waitForFunction((first) => document.querySelector('.code-panel__preview')?.getAttribute('src') !== first, firstSite)
    assert.equal(await page.locator('.repo-change').count(), 0, 'le menu d’enregistrement remplace encore l’aperçu')
    assert.match(await page.textContent('.code-preview__foot'), /pas encore enregistrés sur GitHub/)
    assert.equal(await page.textContent('.code-preview__count'), '1')
    await page.click('.code-preview__changes-tab')
    await page.waitForSelector('.repo-change')
    assert.equal(await page.locator('.code-panel__preview').count(), 0)
    // Étape 282 : la réponse de Jaris est dans la conversation (à gauche), les changements dans l'aperçu (à droite).
    assert.match(await page.textContent('.code-chat__reply'), /Faute corrigée/)
    assert.equal(await page.evaluate(() => document.querySelector('.code-preview').contains(document.querySelector('.repo-change'))), true)
    // Étape 284 : la carte de l'aperçu porte le nom EXACT du dépôt et sa branche — jamais « Leo/projet ».
    assert.deepEqual(
      await page.evaluate(() => {
        const title = document.querySelector('.code-preview__title')
        return {
          title: title.textContent,
          capitalized: getComputedStyle(title, '::first-letter').textTransform,
          branch: document.querySelector('.code-preview__meta').textContent
        }
      }),
      { title: 'leo/projet', capitalized: 'none', branch: 'main' }
    )
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
    // Étape 290 : une fois enregistré, plus rien à « Annuler » sur la carte de fin — seul l'affichage reste.
    assert.deepEqual(
      await page.locator('.changes-card__actions button').evaluateAll((buttons) => buttons.map((b) => b.textContent)),
      ['Afficher les modifications']
    )
  })
})

test('si aucun fichier n’a changé, la conversation le dit, quoi que le modèle prétende', options, async () => {
  await withPage(async (page) => {
    await connectAndOpen(page)
    await page.fill('.composer textarea', 'Ajoute oeufs')
    await page.click('.composer__send')
    await page.evaluate(() => window.__finishAgentEmpty())
    await page.waitForSelector('.code-chat__worked')
    // Le modèle dit « J'ai ajouté 'oeufs' » : la conversation, elle, dit ce qui s'est vraiment passé.
    assert.match(await page.textContent('.code-chat__note'), /Aucun fichier n'a été changé/)
    assert.equal(await page.locator('.changes-card').count(), 0)
    assert.equal(await page.locator('.repo-panel__save').count(), 0)
  })
})

/** La carte de fin, lue comme on la voit : titre, totaux, puis chaque fichier et ses lignes. */
const readChangesCard = (page) =>
  page.evaluate(() => {
    const card = [...document.querySelectorAll('.changes-card')].at(-1)
    const text = (node) => node?.textContent.replace(/\s+/g, ' ').trim() ?? null
    return {
      title: text(card.querySelector('.changes-card__summary strong')),
      totals: text(card.querySelector('.changes-card__totals')),
      files: [...card.querySelectorAll('.changes-card__file')].map((row) => `${text(row.querySelector('.changes-card__path'))} ${text(row.querySelector('.changes-card__stats'))}`),
      buttons: [...card.querySelectorAll('.changes-card__actions button')].map(text),
      more: text(card.querySelector('.changes-card__more'))
    }
  })

test('la fin d’un travail ressemble à ChatGPT : durée, réponse, puis la carte des fichiers modifiés (étape 290)', options, async () => {
  // Léo, capture de ChatGPT à l'appui : « à la fin ça doit faire comme ChatGPT, pas comme ça » — à la place du bandeau
  // vert « Terminé en 2 min 10 — 1 fichier changé : essaie dans l'aperçu, puis enregistre depuis « Changements » ».
  await withPage(async (page) => {
    await connectAndOpen(page)
    // Étape 303 : travail interrompu en route — il reste en attente (vérifier, annuler, enregistrer à la main).
    await page.evaluate(() => {
      window.__agentUnfinished = true
    })
    await page.fill('.composer textarea', 'Corrige les fautes du README')
    await page.click('.composer__send')
    await page.evaluate(() => window.__finishAgent())
    await page.waitForSelector('.changes-card')
    assert.equal(await page.locator('.code-panel__done').count(), 0, 'le bandeau vert est revenu')

    const order = await page.locator('.code-chat__thread > *').evaluateAll((nodes) => nodes.map((n) => n.className.split(' ')[0]))
    assert.deepEqual(order, ['code-chat__user', 'code-chat__worked', 'code-chat__reply', 'changes-card'])
    assert.match(await page.textContent('.code-chat__worked'), /^Travaillé pendant \d+ s$/)
    assert.deepEqual(await readChangesCard(page), {
      title: '1 fichier modifié',
      totals: '+1 −1',
      files: ['README.md +1−1'],
      buttons: ['Annuler', 'Afficher les modifications'],
      more: null
    })

    // « Afficher les modifications » : les lignes, à droite, dans l'onglet « Changements ».
    await page.click('.changes-card__show')
    await page.waitForSelector('.repo-change')
    assert.equal(await page.textContent('.repo-diff__line--add .repo-diff__text'), 'Bonjour le monde')

    // « Annuler » : tout ce qui était préparé repart, et rien n'est jamais parti sur GitHub.
    await page.click('.changes-card__undo')
    await page.waitForSelector('.changes-card__undo', { state: 'detached' })
    assert.deepEqual(await page.evaluate(() => window.__calls.discard), [['leo/projet', null]])
    assert.deepEqual(await page.evaluate(() => window.__calls.commit), [])
    assert.match(await page.textContent('.code-chat__thread > :last-child'), /Changement annulé : rien n'a été enregistré sur GitHub/)
    // La carte reste comme trace de ce qui a été fait, sans boutons qui n'auraient plus de sens.
    assert.deepEqual((await readChangesCard(page)).buttons, [])
    assert.equal(await page.locator('.repo-change').count(), 0)
  })
})

test('plus de trois fichiers : « Afficher N autres fichiers » déplie la liste ; une ancienne carte perd ses boutons', options, async () => {
  await withPage(async (page) => {
    await page.evaluate(() => {
      window.__manyChanges = ['src/App.tsx', 'src/components/ChatPanel.tsx', 'src/index.css', 'README.md', 'package.json'].map((path) => ({
        path,
        kind: 'modified',
        before: 'a\n',
        after: 'a\nb\n'
      }))
    })
    await connectAndOpen(page)
    // Étape 303 : travail interrompu en route — il reste en attente (vérifier, annuler, enregistrer à la main).
    await page.evaluate(() => {
      window.__agentUnfinished = true
    })
    await page.fill('.composer textarea', 'Refais le design')
    await page.click('.composer__send')
    await page.evaluate(() => window.__finishAgent())
    await page.waitForSelector('.changes-card')
    let card = await readChangesCard(page)
    assert.equal(card.title, '5 fichiers modifiés')
    assert.equal(card.totals, '+5 −0')
    assert.deepEqual(card.files, ['src/App.tsx +1', 'src/components/ChatPanel.tsx +1', 'src/index.css +1'])
    assert.equal(card.more, 'Afficher 2 autres fichiers')
    await page.click('.changes-card__more')
    card = await readChangesCard(page)
    assert.equal(card.files.length, 5)
    assert.equal(card.more, 'Afficher moins')
    // Le dossier est en retrait, le nom du fichier en avant, comme sur ChatGPT.
    assert.deepEqual(
      await page.evaluate(() => {
        const row = document.querySelector('.changes-card__file')
        return [getComputedStyle(row.querySelector('.changes-card__dir')).color === getComputedStyle(row.querySelector('.changes-card__name')).color]
      }),
      [false]
    )

    // Deuxième demande : la première carte reste, mais sans boutons (seule la dernière agit).
    await page.fill('.composer textarea', 'Et le pied de page')
    await page.click('.composer__send')
    await page.evaluate(() => window.__finishAgent())
    await page.waitForFunction(() => document.querySelectorAll('.changes-card').length === 2)
    const buttons = await page.locator('.changes-card').evaluateAll((cards) => cards.map((c) => c.querySelectorAll('.changes-card__actions button').length))
    assert.deepEqual(buttons, [0, 2])
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
    // Étape 303 : travail interrompu en route — il reste en attente (vérifier, annuler, enregistrer à la main).
    await page.evaluate(() => {
      window.__agentUnfinished = true
    })
    await page.fill('.composer textarea', 'Corrige')
    await page.click('.composer__send')
    await page.evaluate(() => window.__finishAgent())
    await page.click('.code-preview__changes-tab')
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
    // Étape 303 : travail interrompu en route — il reste en attente (vérifier, annuler, enregistrer à la main).
    await page.evaluate(() => {
      window.__agentUnfinished = true
    })
      await page.fill('.composer textarea', 'Corrige')
      await page.click('.composer__send')
      await page.evaluate(() => window.__finishAgent())
      await page.click('.code-preview__changes-tab')
      await page.waitForSelector('.repo-change')
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
      assert.ok(overflow <= 0, `débordement horizontal de ${overflow}px`)
    },
    { width: 760 }
  )
})

test('un dépôt sans page web le dit dans l’aperçu, au lieu d’une carte vide (étape 287)', options, async () => {
  await withPage(async (page) => {
    await page.evaluate(() => {
      window.__noSite = true
    })
    await connectAndOpen(page)
    await page.waitForFunction(() => /pas de page web/.test(document.querySelector('.code-preview__placeholder')?.textContent ?? ''))
    assert.equal(await page.locator('.code-panel__preview').count(), 0)
  })
})

test('« Changements » : tout annuler ramène l’aperçu, l’onglet disparaît (étape 287)', options, async () => {
  await withPage(async (page) => {
    await connectAndOpen(page)
    // Étape 303 : travail interrompu en route — il reste en attente (vérifier, annuler, enregistrer à la main).
    await page.evaluate(() => {
      window.__agentUnfinished = true
    })
    await page.fill('.composer textarea', 'Corrige')
    await page.click('.composer__send')
    await page.evaluate(() => window.__finishAgent())
    await page.click('.code-preview__changes-tab')
    await page.waitForSelector('.repo-change')
    await page.click('.repo-panel__changes-head .repo-change__discard')
    await page.waitForSelector('.code-preview iframe.code-panel__preview')
    assert.equal(await page.locator('.code-preview__changes-tab').count(), 0)
  })
})

/** La conversation affichée, ligne par ligne (« classe:texte »), sans l'écran d'accueil d'une conversation vide. */
const threadLines = (page) =>
  page.locator('.code-chat__thread > :not(.empty-state)').evaluateAll((nodes) =>
    nodes.map((node) => {
      const kind = node.className.split(' ')[0]
      if (kind === 'code-chat__worked') return kind
      if (kind === 'changes-card') return `${kind}:${node.querySelector('strong').textContent}`
      const text = node.classList.contains('code-chat__activity')
        ? [...node.querySelectorAll('span:not(.code-chat__activity-stats span):not(.code-chat__live-dot)')].map((part) => part.textContent).join(' ')
        : node.textContent
      return `${kind}:${text}`
    })
  )

// Étape 302 (Léo : « pourquoi les boutons disparaissent quand je relance, afficher modification etc. ») : un travail
// enregistré sur GitHub reste consultable quand on revient à la conversation — plus de carte muette.
// Étape 303 (Léo : « faut pas qu'il demande pour enregistrer sur GitHub, toi tu me demandes pas de cliquer sur un
// bouton ») : un travail terminé part sur GitHub tout seul ; un travail interrompu, jamais.
test('travail terminé : enregistré tout seul sur GitHub, sans clic, avec la demande comme description', options, async () => {
  await withPage(async (page) => {
    await connectAndOpen(page)
    await page.fill('.composer textarea', 'Corrige les fautes du README')
    await page.click('.composer__send')
    await page.evaluate(() => window.__finishAgent())
    await page.waitForFunction(() => window.__calls.commit.length === 1)
    assert.deepEqual(await page.evaluate(() => window.__calls.commit), [['leo/projet', 'Corrige les fautes du README']])
    await page.waitForFunction(() => /Enregistré sur GitHub/.test(document.querySelector('.code-chat__thread').textContent))
    const order = await page.locator('.code-chat__thread > *').evaluateAll((nodes) => nodes.map((n) => n.className.split(' ')[0]))
    assert.deepEqual(order, ['code-chat__user', 'code-chat__worked', 'code-chat__reply', 'changes-card', 'code-chat__reply'])
    // Plus rien à annuler (c'est enregistré) ; les modifications restent consultables.
    assert.deepEqual((await readChangesCard(page)).buttons, ['Afficher les modifications'])
  })
})

// Étape 309, Léo : « ça met Jaris n'est pas connecté à GitHub, et il n'y a même pas se reconnecter ».
test('plus connecté en plein travail : « Se connecter à GitHub » apparaît sous l’erreur et ouvre la connexion', options, async () => {
  await withPage(async (page) => {
    await connectAndOpen(page)
    await page.fill('.composer textarea', 'Ajoute un cookie')
    await page.click('.composer__send')
    // La connexion a été perdue entre-temps : la demande échoue, et main ne voit plus de connexion.
    await page.evaluate(() => {
      window.__status = { available: true, connected: false, login: null, lost: null }
      window.__failAgent(new Error("Error invoking remote method 'jaris:github-run-agent': GithubError: Jaris n'est pas connecté à GitHub."))
    })
    await page.waitForSelector('.code-panel__reconnect')
    assert.equal((await page.textContent('.code-panel__error')).trim(), "Jaris n'est pas connecté à GitHub.")
    const style = await page.$eval('.code-panel__reconnect', (el) => {
      const css = getComputedStyle(el)
      return { radius: css.borderRadius, background: css.backgroundColor }
    })
    assert.equal(style.radius, '999px', 'habillé comme les autres boutons principaux, pas laissé au style du navigateur')
    assert.notEqual(style.background, 'rgba(0, 0, 0, 0)')
    await page.click('.code-panel__reconnect')
    // Le panneau GitHub s'ouvre directement sur la connexion, pas sur une liste de dépôts périmée.
    await page.waitForSelector('.github-picker__panel .github-picker__primary')
    assert.equal(await page.$('.github-picker__panel .github-picker__repo'), null)
  })
})

test('le panneau GitHub relit la connexion à chaque ouverture : jamais une liste quand elle est perdue', options, async () => {
  await withPage(async (page) => {
    await connectAndOpen(page)
    await page.evaluate(() => {
      window.__status = { available: true, connected: false, login: null, lost: null }
    })
    await page.click('.repo-picker__trigger')
    await page.waitForSelector('.github-picker__panel .github-picker__primary')
  })
})

test('travail interrompu en route : rien n’est envoyé sur GitHub, il reste à vérifier', options, async () => {
  await withPage(async (page) => {
    await connectAndOpen(page)
    await page.evaluate(() => {
      window.__agentUnfinished = true
    })
    await page.fill('.composer textarea', 'Corrige les fautes du README')
    await page.click('.composer__send')
    await page.evaluate(() => window.__finishAgent())
    await page.waitForSelector('.changes-card__undo')
    assert.deepEqual(await page.evaluate(() => window.__calls.commit), [])
  })
})

test('enregistré sur GitHub : en revenant à la conversation, la carte propose « Voir sur GitHub »', options, async () => {
  await withPage(async (page) => {
    await connectAndOpen(page)
    await page.fill('.composer textarea', 'Corrige les fautes du README')
    await page.click('.composer__send')
    await page.evaluate(() => window.__finishAgent())
    // Étape 303 : un travail terminé est enregistré tout seul, sans clic.
    await page.waitForFunction(() => window.__calls.commit.length === 1)

    // Comme une relance : on quitte le dépôt, puis on y revient par la liste — plus rien n'est préparé en mémoire.
    await page.click('.workspace__item:has-text("liste de courses")')
    await page.waitForSelector('.empty-state')
    await page.click('.workspace__item:has-text("leo/projet")')
    await page.waitForSelector('.changes-card')
    const link = page.locator('.changes-card a.changes-card__show')
    await link.waitFor()
    assert.equal(await link.textContent(), 'Voir sur GitHub')
    assert.equal(await link.getAttribute('href'), 'https://github.com/leo/projet/commit/abc1234def')
    assert.equal(await link.getAttribute('target'), '_blank')
    // Habillé comme les autres boutons de la carte, pas en lien bleu souligné du navigateur.
    const style = await link.evaluate((el) => ({ decoration: getComputedStyle(el).textDecorationLine, radius: getComputedStyle(el).borderTopLeftRadius }))
    assert.equal(style.decoration, 'none')
    assert.notEqual(style.radius, '0px')
  })
})

test('un dépôt ouvert apparaît à gauche, et sa conversation revient quand on le rouvre (étape 288)', options, async () => {
  // Léo : « c'est bizarre, je suis dans le chat en train de parler et je vois aucune conversation à gauche » — la liste
  // disait « Aucune application pour l'instant » pendant qu'il travaillait sur un dépôt.
  await withPage(async (page) => {
    await connectAndOpen(page)
    // Étape 303 : travail interrompu en route — il reste en attente (vérifier, annuler, enregistrer à la main).
    await page.evaluate(() => {
      window.__agentUnfinished = true
    })
    await page.waitForSelector('.workspace__item--active')
    assert.equal(await page.textContent('.workspace__item--active .workspace__item-title'), 'leo/projet')
    // Le nom EXACT à l'écran aussi : la majuscule de début des titres d'application écrivait « Leo/projet ».
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.querySelector('.workspace__item--active .workspace__item-title'), '::first-letter').textTransform),
      'none'
    )
    assert.match(await page.textContent('.workspace__item--active .workspace__item-meta'), /^GitHub · Aujourd'hui/)

    await page.fill('.composer textarea', 'Corrige les fautes du README')
    await page.click('.composer__send')
    await page.evaluate(() => {
      window.__emitActivity({ kind: 'edit', path: 'README.md', added: 1, removed: 1 })
      window.__finishAgent()
    })
    await page.waitForSelector('.changes-card')
    const expected = [
      'code-chat__user:Corrige les fautes du README',
      'code-chat__activity:Modifié README.md +1−1',
      'code-chat__worked',
      'code-chat__reply:Faute corrigée dans le README.',
      'changes-card:1 fichier modifié'
    ]

    // Une application, puis retour au dépôt PAR LA LISTE : tout revient, y compris comment le travail s'est terminé.
    await page.click('.workspace__item:has-text("liste de courses")')
    await page.waitForSelector('.empty-state')
    assert.deepEqual(await threadLines(page), [])
    await page.click('.workspace__item:has-text("leo/projet")')
    await page.waitForFunction(() => document.querySelectorAll('.code-chat__user').length === 1)
    // La fin du travail (durée, carte des fichiers) revient avec la conversation.
    assert.deepEqual(await threadLines(page), expected)
    assert.equal(await page.textContent('.workspace__item--active .workspace__item-title'), 'leo/projet')

    // « Retirer », jamais « Supprimer » : le dépôt reste sur GitHub, seule la ligne part.
    await page.click('.workspace__list li:has-text("leo/projet") .workspace__delete')
    assert.match(await page.textContent('.workspace__confirm span'), /reste sur GitHub/)
    assert.equal(await page.textContent('.workspace__confirm-yes'), 'Retirer')
    await page.click('.workspace__confirm-yes')
    await page.waitForFunction(() => ![...document.querySelectorAll('.workspace__item-title')].some((node) => node.textContent === 'leo/projet'))
    // Le dépôt affiché est fermé, sans rien enregistrer ni annuler sur GitHub.
    assert.equal(await page.locator('.branch-picker__trigger').count(), 0)
    assert.deepEqual(await page.evaluate(() => window.__calls.commit), [])
  })
})

test('fenêtre étroite : la carte de fin garde sa hauteur et le fil descend jusqu’à elle (étape 290)', options, async () => {
  // Vu sur la capture : dans le fil (colonne de hauteur limitée), la carte en « overflow: hidden » s'écrasait à 0 px
  // dès que la conversation débordait — il n'en restait qu'un trait.
  await withPage(
    async (page) => {
      await page.evaluate(() => {
        window.__manyChanges = ['a.js', 'b.js', 'c.js', 'd.js'].map((path) => ({ path, kind: 'modified', before: 'a\n', after: 'a\nb\n' }))
      })
      await connectAndOpen(page)
      await page.fill('.composer textarea', 'Une longue demande')
      await page.click('.composer__send')
      await page.evaluate(() => {
        for (let id = 1; id <= 6; id++) window.__emitNarration({ id, text: `Étape ${id} : je lis un fichier de plus pour comprendre le projet.` })
        window.__finishAgent()
      })
      await page.waitForSelector('.changes-card')
      await page.waitForTimeout(100)
      const layout = await page.evaluate(() => {
        const thread = document.querySelector('.code-chat__thread')
        const card = document.querySelector('.changes-card').getBoundingClientRect()
        return { overflows: thread.scrollHeight > thread.clientHeight, cardHeight: card.height, bottomSeen: Math.abs(thread.scrollTop + thread.clientHeight - thread.scrollHeight) < 2 }
      })
      assert.equal(layout.overflows, true, 'le test doit faire déborder la conversation')
      assert.ok(layout.cardHeight > 150, `carte écrasée à ${layout.cardHeight}px`)
      assert.equal(layout.bottomSeen, true)
    },
    { width: 1000 }
  )
})

test('« aperçu et code dans code » d’un dépôt : la liste de ses fichiers, la recherche, un onglet par fichier (étape 327)', options, async () => {
  // Léo, capture d'un autre outil à l'appui : « avoir apercu et code dans code ».
  await withPage(async (page) => {
    await connectAndOpen(page)
    await page.waitForSelector('.code-preview iframe.code-panel__preview')
    // Rien n'est demandé tant que la vue « Code » n'est pas ouverte.
    assert.equal(await page.evaluate(() => (window.__calls.listFiles ?? []).length), 0)

    await page.click('.code-preview__code-tab')
    await page.waitForSelector('.code-browser__code')
    assert.equal(await page.locator('.code-panel__preview').count(), 0)
    assert.deepEqual(await page.evaluate(() => window.__calls.listFiles), ['leo/projet'])
    // Comme un explorateur : les dossiers d'abord (repliés), puis les fichiers, chacun par ordre alphabétique.
    const names = () => page.$$eval('.code-browser__tree .code-browser__name', (rows) => rows.map((row) => row.textContent))
    assert.deepEqual(await names(), ['src', 'index.html', 'logo.png', 'README.md'])
    // La page du site s'ouvre d'abord, avec ses numéros de ligne.
    assert.equal(await page.textContent('.code-browser__tab--active .code-browser__tab-name'), 'index.html')
    assert.equal(await page.textContent('.code-browser__code'), '<h1>Projet</h1>\n<script src="src/app.js"></script>\n')
    assert.equal(await page.textContent('.code-browser__gutter'), '1\n2')

    // Un dossier se déplie, un fichier s'ouvre dans un onglet de plus.
    await page.click('.code-browser__folder:has-text("src")')
    assert.deepEqual(await names(), ['src', 'styles', 'app.js', 'index.html', 'logo.png', 'README.md'])
    await page.click('.code-browser__file:has-text("app.js")')
    await page.waitForFunction(() => document.querySelector('.code-browser__code')?.textContent === 'console.log("ok")\n')
    assert.deepEqual(await page.$$eval('.code-browser__tab-name', (tabs) => tabs.map((tab) => tab.textContent)), ['index.html', 'app.js'])
    assert.equal(await page.getAttribute('.code-browser__row--active', 'title'), 'src/app.js')

    // Fermer l'onglet ouvert revient au voisin.
    await page.click('.code-browser__tab--active .code-browser__tab-close')
    assert.deepEqual(await page.$$eval('.code-browser__tab-name', (tabs) => tabs.map((tab) => tab.textContent)), ['index.html'])
    assert.equal(await page.textContent('.code-browser__tab--active .code-browser__tab-name'), 'index.html')

    // La recherche montre les chemins complets, et un fichier trouvé s'ouvre d'un clic, même dans un dossier replié.
    await page.click('.code-browser__collapse')
    await page.fill('.code-browser__search-input', 'MAIN')
    assert.deepEqual(await names(), ['src/styles/main.css'])
    await page.click('.code-browser__file:has-text("main.css")')
    await page.waitForFunction(() => document.querySelector('.code-browser__code')?.textContent === 'h1 { color: tomato; }\n')
    await page.fill('.code-browser__search-input', 'introuvable')
    assert.equal(await page.textContent('.code-browser__note'), 'Aucun fichier ne correspond.')
    await page.fill('.code-browser__search-input', '')
    // Le dossier du fichier ouvert par la recherche est déplié, pour qu'on voie où il est.
    assert.ok((await names()).includes('main.css'))

    // Une image n'est pas du texte : un message, jamais des caractères illisibles.
    await page.click('.code-browser__file:has-text("logo.png")')
    await page.waitForSelector('.code-browser__message')
    assert.match(await page.textContent('.code-browser__message'), /n'est pas du texte/)

    // Retour à l'aperçu : le site jouable revient.
    await page.click('.code-preview__preview-tab')
    await page.waitForSelector('.code-preview iframe.code-panel__preview')
  })
})

test('vue « Code » : ce que Jaris vient de changer est relu et signalé, et la vue reste ouverte (étape 327)', options, async () => {
  await withPage(async (page) => {
    await connectAndOpen(page)
    await page.click('.code-preview__code-tab')
    await page.waitForSelector('.code-browser__code')
    await page.click('.code-browser__file:has-text("README.md")')
    await page.waitForFunction(() => document.querySelector('.code-browser__code')?.textContent.includes('mondee'))
    assert.equal(await page.locator('.code-browser__badge').count(), 0)

    // Un travail interrompu reste en attente (étape 303) : ses changements sont visibles dans la vue « Code ».
    await page.evaluate(() => { window.__agentUnfinished = true })
    await page.fill('.composer textarea', 'Corrige les fautes du README')
    await page.click('.composer__send')
    await page.evaluate(() => window.__finishAgent())
    await page.waitForSelector('.changes-card')
    // Le fichier ouvert est relu : il montre la version préparée par Jaris, sans changer de vue ni d'onglet.
    await page.waitForFunction(() => /monde\n$/.test(document.querySelector('.code-browser__code')?.textContent ?? ''))
    assert.equal(await page.getAttribute('.code-preview__code-tab', 'aria-pressed'), 'true')
    assert.equal(await page.textContent('.code-browser__tab--active .code-browser__tab-name'), 'README.md')
    const badge = await page.evaluate(() => {
      const row = [...document.querySelectorAll('.code-browser__file')].find((item) => item.title === 'README.md')
      const mark = row?.querySelector('.code-browser__badge')
      return mark ? { text: mark.textContent, title: mark.getAttribute('title'), color: getComputedStyle(mark).color, rowColor: getComputedStyle(row).color } : null
    })
    assert.equal(badge?.text, 'M')
    assert.match(badge?.title ?? '', /pas encore enregistré sur GitHub/)
    // Habillé par le CSS de Jaris : sa propre couleur (ambre pour « modifié »), pas celle du nom du fichier.
    assert.notEqual(badge?.color, badge?.rowColor)

    // Tout annuler fait disparaître l'onglet « Changements », mais la vue « Code » reste ouverte.
    await page.click('.changes-card__undo')
    await page.waitForFunction(() => document.querySelectorAll('.code-preview__changes-tab').length === 0)
    assert.equal(await page.getAttribute('.code-preview__code-tab', 'aria-pressed'), 'true')
    await page.waitForFunction(() => document.querySelectorAll('.code-browser__badge').length === 0)
  })
})
