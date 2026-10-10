import assert from 'node:assert/strict'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * L'agent qui travaille sur un dépôt GitHub (étape 277), avec un faux modèle qui joue un scénario d'appels
 * d'outils. Verrouillé ici : il lit avant de modifier, ses modifications sont exactes (ni un passage absent, ni
 * un passage ambigu ne sont devinés), aucun chemin ne sort du dépôt, l'historique est allégé sans perdre le
 * travail en cours, une simple annonce sans outil est relancée une fois, et « Arrêter » coupe vraiment.
 */
const lineDiff = loadTsModule('shared/lineDiff.ts')
const agent = loadTsModule('electron/services/repoAgent.ts', { '../../shared/lineDiff': lineDiff })

function call(name, args) {
  return { function: { name, arguments: args } }
}

const reply = (...calls) => ({ role: 'assistant', content: '', tool_calls: calls })
/** Résultats d'outils renvoyés au modèle : des messages « user » préfixés (étape 281), plus des messages « tool ». */
const toolResults = (messages) => messages.filter((m) => m.role === 'user' && m.content.startsWith('Résultat de ')).map((m) => m.content)

/** Faux dépôt en mémoire + faux modèle qui répond dans l'ordre aux tours de la boucle. */
function setup(files, replies, extra = {}) {
  const repo = new Map(Object.entries(files))
  const staged = new Map()
  const status = []
  const activity = []
  const seen = []
  const deps = {
    repoName: 'leo/projet',
    branch: 'main',
    listPaths: () => {
      const paths = new Set(repo.keys())
      for (const [path, content] of staged) content === null ? paths.delete(path) : paths.add(path)
      return [...paths].sort()
    },
    readFile: async (path) => (staged.has(path) ? (staged.get(path) ?? undefined) : repo.get(path)),
    writeFile: (path, content) => staged.set(path, content),
    pendingSummary: () => [...staged.keys()].map((path) => `- modifié : ${path}`),
    chat: async (messages) => {
      seen.push(messages.map((message) => ({ ...message })))
      const next = replies.shift()
      if (!next) throw new Error('plus de réponse simulée')
      return typeof next === 'function' ? next(messages) : next
    },
    onStatus: (line) => status.push(line),
    onActivity: (item) => activity.push(item),
    ...extra
  }
  return { deps, staged, status, activity, seen }
}

test('lire puis modifier un passage exact, puis terminer : le changement est préparé, rien d’autre', async () => {
  const app = setup({ 'README.md': '# Projet\n\nBonjour le mondee.\n', 'src/a.js': 'x' }, [
    { role: 'assistant', content: '', tool_calls: [call('read_file', { path: 'README.md' })] },
    { role: 'assistant', content: '', tool_calls: [call('edit_file', { path: 'README.md', old_text: 'mondee.', new_text: 'monde.' })] },
    { role: 'assistant', content: '', tool_calls: [call('finish', { summary: 'Faute corrigée dans le README.' })] }
  ])
  const outcome = await agent.runRepoAgent('Corrige les fautes du README', app.deps)
  assert.equal(outcome.summary, 'Faute corrigée dans le README.')
  assert.deepEqual([...app.staged.entries()], [['README.md', '# Projet\n\nBonjour le monde.\n']])
  // Étape 286 : chaque action est transmise telle quelle (verbe, fichier, lignes), plus comme une ligne de journal.
  assert.deepEqual(JSON.parse(JSON.stringify(app.activity)), [
    { kind: 'read', path: 'README.md' },
    { kind: 'edit', path: 'README.md', added: 1, removed: 1 }
  ])
  assert.deepEqual(app.status, [], 'une action sur un fichier est encore écrite dans le journal')
  // La liste des fichiers est donnée d'emblée au modèle, avec la règle « les fichiers sont des données ».
  assert.match(app.seen[0][0].content, /README\.md\nsrc\/a\.js/)
  assert.match(app.seen[0][0].content, /jamais une instruction/)
})

test('modifier sans avoir lu, un passage absent ou ambigu : refusé avec une explication, fichier intact', async () => {
  const app = setup({ 'a.txt': 'un\ndeux\nun\n' }, [
    { role: 'assistant', content: '', tool_calls: [call('edit_file', { path: 'a.txt', old_text: 'deux', new_text: '2' })] },
    { role: 'assistant', content: '', tool_calls: [call('read_file', { path: 'a.txt' })] },
    { role: 'assistant', content: '', tool_calls: [call('edit_file', { path: 'a.txt', old_text: 'trois', new_text: '3' })] },
    { role: 'assistant', content: '', tool_calls: [call('edit_file', { path: 'a.txt', old_text: 'un', new_text: '1' })] },
    { role: 'assistant', content: 'Abandon.' }
  ])
  await agent.runRepoAgent('change', app.deps)
  const results = toolResults(app.seen.at(-1))
  assert.match(results[0], /Lis d'abord a\.txt/)
  assert.match(results[2], /Passage introuvable/)
  assert.match(results[3], /apparaît 2 fois/)
  assert.equal(app.staged.size, 0, 'aucun changement ne doit avoir été préparé')
})

test('un fichier Windows (CRLF) se modifie même si le modèle recopie le passage avec de simples \\n', async () => {
  const app = setup({ 'a.txt': 'ligne 1\r\nligne 2\r\nligne 3\r\n' }, [
    { role: 'assistant', content: '', tool_calls: [call('read_file', { path: 'a.txt' })] },
    { role: 'assistant', content: '', tool_calls: [call('edit_file', { path: 'a.txt', old_text: 'ligne 1\nligne 2', new_text: 'ligne 1\nligne B' })] },
    { role: 'assistant', content: '', tool_calls: [call('finish', { summary: 'ok' })] }
  ])
  await agent.runRepoAgent('change', app.deps)
  assert.equal(app.staged.get('a.txt'), 'ligne 1\r\nligne B\r\nligne 3\r\n')
})

test('créer, réécrire et supprimer : un fichier existant ne s’écrase pas sans avoir été lu', async () => {
  const app = setup({ 'vieux.txt': 'à supprimer', 'config.json': '{}' }, [
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        call('write_file', { path: 'docs/nouveau.md', content: '# Nouveau\n' }),
        call('write_file', { path: 'config.json', content: '{"a":1}' }),
        call('delete_file', { path: 'vieux.txt' })
      ]
    },
    { role: 'assistant', content: '', tool_calls: [call('finish', { summary: 'fait' })] }
  ])
  await agent.runRepoAgent('change', app.deps)
  assert.equal(app.staged.get('docs/nouveau.md'), '# Nouveau\n')
  assert.equal(app.staged.has('config.json'), false, 'config.json écrasé sans avoir été lu')
  assert.equal(app.staged.get('vieux.txt'), null)
  // Seules les actions RÉELLEMENT faites s'affichent : l'écrasement refusé de config.json n'en est pas une.
  assert.deepEqual(JSON.parse(JSON.stringify(app.activity)), [
    { kind: 'create', path: 'docs/nouveau.md', added: 1, removed: 0 },
    { kind: 'delete', path: 'vieux.txt' }
  ])
})

test('dépôt vide (étape 279) : le modèle est prévenu, et il crée directement les fichiers', async () => {
  const app = setup({}, [
    reply(call('write_file', { path: 'index.html', content: '<h1>Salut</h1>\n' })),
    reply(call('finish', { summary: 'Page créée.' }))
  ])
  const outcome = await agent.runRepoAgent('Crée une page', app.deps)
  assert.match(app.seen[0][0].content, /Le dépôt est vide/)
  assert.doesNotMatch(app.seen[0][0].content, /Fichiers du dépôt \(0\)/)
  assert.equal(app.staged.get('index.html'), '<h1>Salut</h1>\n')
  assert.equal(outcome.summary, 'Page créée.')
})

test('étape 281 : AUCUN outil déclaré à Ollama, les appels sont demandés en bloc ```action (pas <tool_call>)', async () => {
  const argsSeen = []
  const app = setup({ 'a.txt': 'x' }, [{ role: 'assistant', content: '```action\n{"name": "finish", "arguments": {"summary": "ok"}}\n```' }], {
    chat: async (...args) => {
      argsSeen.push(args)
      return { role: 'assistant', content: '```action\n{"name": "finish", "arguments": {"summary": "ok"}}\n```' }
    }
  })
  await agent.runRepoAgent('change', app.deps)
  // Avec des outils déclarés, Ollama ne rend un appel qu'une fois ENTIÈREMENT écrit : 270 s de silence mesurées.
  // Le second argument (étape 286) est le rappel du texte reçu au fil de l'eau : jamais une liste d'outils.
  assert.ok(argsSeen[0].slice(1).every((arg) => arg === undefined || typeof arg === 'function'), 'des outils partent vers le modèle')
  const system = argsSeen[0][0][0].content
  assert.match(system, /```action/)
  // Ollama intercepte <tool_call> chez les modèles Qwen même sans outils déclarés, puis coupe la réponse.
  assert.doesNotMatch(system, /<tool_call>/)
  for (const tool of agent.REPO_TOOLS) assert.ok(system.includes(`- ${tool.function.name}(`), `outil absent des consignes : ${tool.function.name}`)
})

test('appels en blocs ```action : bloc complet, ouverture manquante (vue avec qwen3.5), sauts de ligne bruts', () => {
  assert.deepEqual(
    agent.extractTextToolCalls('Je lis :\n```action\n{"name": "read_file", "arguments": {"path": "a"}}\n```').map((c) => c.function.arguments.path),
    ['a']
  )
  // Ouverture « ``` » manquante ET fichier sur plusieurs lignes : la lecture ligne par ligne n'y suffirait pas.
  const noOpening = agent.extractTextToolCalls('action\n{"name": "write_file", "arguments": {"path": "b", "content": "l1\nl2"}}\n```')
  assert.deepEqual(noOpening.map((c) => [c.function.arguments.path, c.function.arguments.content]), [['b', 'l1\nl2']])
  // Un fichier écrit avec de VRAIS retours à la ligne dans la chaîne JSON : accepté, contenu intact.
  const raw = '```action\n{"name": "write_file", "arguments": {"path": "i.html", "content": "<h1>\n\tSalut\n</h1>"}}\n```'
  assert.equal(agent.extractTextToolCalls(raw)[0].function.arguments.content, '<h1>\n\tSalut\n</h1>')
  assert.equal(agent.parseLenientJson('{"a": "x"y"}'), undefined, 'un guillemet non échappé reste une erreur, rien n’est deviné')
})

test('appel illisible : on demande de le réécrire, jamais affiché comme résumé ; trois fois et on s’arrête', async () => {
  const broken = { role: 'assistant', content: '```action\n{"name": "write_file", "arguments": {"path": "i.html", "content": "<div class="x">"}}\n```' }
  const app = setup({}, [broken, { role: 'assistant', content: '```action\n{"name": "write_file", "arguments": {"path": "i.html", "content": "<div class=\\"x\\">"}}\n```' }, reply(call('finish', { summary: 'Fait.' }))])
  const outcome = await agent.runRepoAgent('Crée', app.deps)
  assert.match(app.seen[1].at(-1).content, /illisible/)
  assert.equal(app.staged.get('i.html'), '<div class="x">')
  assert.equal(outcome.summary, 'Fait.')

  const stuck = setup({}, [broken, broken, broken, broken])
  const result = await agent.runRepoAgent('Crée', stuck.deps)
  assert.equal(result.limitReached, true)
  assert.match(result.summary, /3 essais illisibles/)
  assert.doesNotMatch(result.summary, /"name"/, 'le JSON cassé ne doit jamais devenir le résumé')
})

test('aucun chemin ne sort du dépôt ni ne touche .git', () => {
  for (const bad of ['../secret', 'a/../../b', '/etc/passwd/..', '.git/config', '.git', 'a//b/./c', '', 42]) {
    assert.throws(() => agent.normalizeRepoPath(bad), undefined, `accepté à tort : ${bad}`)
  }
  assert.equal(agent.normalizeRepoPath('./src\\app.ts'), 'src/app.ts')
  assert.equal(agent.normalizeRepoPath('/README.md'), 'README.md')
  assert.equal(agent.normalizeRepoPath('.github/workflows/ci.yml'), '.github/workflows/ci.yml')
})

test('un chemin refusé devient un message d’outil, pas un plantage de toute la demande', async () => {
  const app = setup({}, [
    { role: 'assistant', content: '', tool_calls: [call('write_file', { path: '../hors.txt', content: 'x' })] },
    { role: 'assistant', content: '', tool_calls: [call('finish', { summary: 'ok' })] }
  ])
  await agent.runRepoAgent('change', app.deps)
  const results = toolResults(app.seen.at(-1))
  assert.match(results[0], /^Résultat de write_file :\nErreur : Chemin invalide/)
  assert.equal(app.staged.size, 0)
})

test('une annonce sans aucun outil est relancée UNE fois, une vraie réponse ensuite est acceptée', async () => {
  const app = setup({ 'a.txt': 'x' }, [
    { role: 'assistant', content: 'Je vais regarder le README.' },
    { role: 'assistant', content: '', tool_calls: [call('read_file', { path: 'a.txt' })] },
    { role: 'assistant', content: 'Ce dépôt contient un seul fichier.' }
  ])
  const outcome = await agent.runRepoAgent('Explique ce dépôt', app.deps)
  assert.equal(outcome.summary, 'Ce dépôt contient un seul fichier.')
  assert.equal(app.seen.length, 3)
  assert.match(app.seen[1].at(-1).content, /aucun outil/)
})

test('appels écrits EN TEXTE (vus avec qwen2.5-coder:7b) : reconnus, mais jamais un JSON quelconque', () => {
  const one = agent.extractTextToolCalls('{"name": "read_file", "arguments": {"path": "README.md"}}')
  assert.deepEqual(one, [{ function: { name: 'read_file', arguments: { path: 'README.md' } } }])
  const lines = agent.extractTextToolCalls('{"name": "read_file", "arguments": {"path": "a"}}\n{"name": "finish", "arguments": {"summary": "ok"}}')
  assert.deepEqual(lines.map((c) => c.function.name), ['read_file', 'finish'])
  const fenced = agent.extractTextToolCalls('Je lis :\n```json\n{"name": "list_files", "arguments": {}}\n```')
  assert.deepEqual(fenced.map((c) => c.function.name), ['list_files'])
  const tagged = agent.extractTextToolCalls('<tool_call>\n{"name": "delete_file", "arguments": {"path": "x"}}\n</tool_call>')
  assert.deepEqual(tagged.map((c) => c.function.name), ['delete_file'])
  // Un JSON qui n'est pas un appel d'un outil de l'agent n'en devient jamais un.
  assert.deepEqual(agent.extractTextToolCalls('{"name": "rm_rf", "arguments": {}}'), [])
  assert.deepEqual(agent.extractTextToolCalls('Le fichier package.json contient {"name": "courses"}'), [])
})

test('un appel écrit en texte fait vraiment le travail, de bout en bout', async () => {
  const app = setup({ 'a.txt': 'bonjour\n' }, [
    { role: 'assistant', content: '{"name": "read_file", "arguments": {"path": "a.txt"}}' },
    { role: 'assistant', content: '{"name": "edit_file", "arguments": {"path": "a.txt", "old_text": "bonjour", "new_text": "salut"}}' },
    { role: 'assistant', content: 'finish\n\nMot remplacé.' }
  ])
  const outcome = await agent.runRepoAgent('change', app.deps)
  assert.equal(app.staged.get('a.txt'), 'salut\n')
  // Le mot « finish » parasite en tête de réponse (vu pour de vrai) est retiré.
  assert.equal(outcome.summary, 'Mot remplacé.')
})

test('un passage recopié avec un saut de ligne en trop (vu pour de vrai) se retrouve quand même', async () => {
  const app = setup({ 'R.md': '## Instalation\n\nOuvrir index.html.\n' }, [
    reply(call('read_file', { path: 'R.md' })),
    reply(call('edit_file', { path: 'R.md', old_text: '## Instalation\n\nOuvrir index.html.\n\n', new_text: '## Installation\n\nOuvrir index.html.\n\n' })),
    reply(call('finish', { summary: 'ok' }))
  ])
  await agent.runRepoAgent('change', app.deps)
  assert.equal(app.staged.get('R.md'), '## Installation\n\nOuvrir index.html.\n')
})

test('« finish » envoyé avec un appel raté dans le même message : refusé, jamais de fausse confirmation', async () => {
  const app = setup({ 'app.js': "const items = ['pain']\n" }, [
    // Vu pour de vrai : tout envoyé d'un coup, avec un passage deviné AVANT d'avoir lu le fichier.
    reply(
      call('read_file', { path: 'app.js' }),
      call('edit_file', { path: 'app.js', old_text: "const ingredients = ['lait']", new_text: "const ingredients = ['lait', 'oeufs']" }),
      call('finish', { summary: "J'ai ajouté 'oeufs'." })
    ),
    reply(call('edit_file', { path: 'app.js', old_text: "['pain']", new_text: "['pain', 'oeufs']" })),
    reply(call('finish', { summary: "J'ai ajouté 'oeufs'." }))
  ])
  const outcome = await agent.runRepoAgent('Ajoute oeufs', app.deps)
  assert.equal(app.seen.length, 3, 'le premier « finish » ne devait pas terminer le travail')
  assert.match(app.seen[1].at(-1).content, /Résultat de finish : refusé/)
  assert.equal(app.staged.get('app.js'), "const items = ['pain', 'oeufs']\n")
  assert.equal(outcome.summary, "J'ai ajouté 'oeufs'.")
})

test('le même appel raté trois fois arrête l’agent au lieu de tourner en rond', async () => {
  const same = () => reply(call('edit_file', { path: 'a.txt', old_text: 'absent', new_text: 'x' }))
  const app = setup({ 'a.txt': 'texte' }, [reply(call('read_file', { path: 'a.txt' })), same, same, same, same])
  const outcome = await agent.runRepoAgent('change', app.deps)
  assert.equal(outcome.limitReached, true)
  assert.match(outcome.summary, /échoué 3 fois/)
  assert.equal(app.seen.length, 4)
  assert.match(app.seen[3].at(-1).content, /déjà essayé exactement cet appel/)
})

test('l’historique s’allège en retirant les VIEILLES lectures, jamais le travail en cours', () => {
  const messages = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u' },
    { role: 'tool', content: 'A'.repeat(5000) },
    { role: 'tool', content: 'B'.repeat(5000) },
    { role: 'assistant', content: '' },
    { role: 'tool', content: 'C'.repeat(5000) }
  ]
  // 15 000 caractères pour un budget de 11 000 : retirer la plus vieille lecture suffit, la suivante reste.
  agent.compactHistory(messages, 11000)
  assert.match(messages[2].content, /Contenu retiré/)
  assert.ok(messages[3].content === 'B'.repeat(5000), 'une lecture a été retirée alors que le budget était déjà tenu')
  // Budget minuscule : tout ce qui peut l'être est retiré, mais jamais les deux derniers messages.
  agent.compactHistory(messages, 10)
  assert.match(messages[3].content, /Contenu retiré/)
  assert.ok(messages[5].content === 'C'.repeat(5000), 'la dernière lecture doit rester intacte')
})

test('un gros fichier déjà écrit compte dans l’historique, et ses arguments sont allégés en premier', () => {
  const messages = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'u' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: { path: 'gros.js', content: 'x'.repeat(20000) } } }] },
    { role: 'tool', content: 'Créé : gros.js.' },
    { role: 'assistant', content: 'fini' }
  ]
  agent.compactHistory(messages, 5000)
  assert.equal(messages[2].tool_calls[0].function.arguments.path, 'gros.js')
  assert.equal(messages[2].tool_calls[0].function.arguments.content, '[retiré]')
})

test('« Arrêter » coupe la boucle au tour suivant', async () => {
  const controller = new AbortController()
  const app = setup(
    { 'a.txt': 'x' },
    [
      () => {
        controller.abort()
        return { role: 'assistant', content: '', tool_calls: [call('read_file', { path: 'a.txt' })] }
      }
    ],
    { signal: controller.signal }
  )
  await assert.rejects(agent.runRepoAgent('change', app.deps), (err) => err.name === 'AbortError')
  assert.equal(app.seen.length, 1, 'le modèle ne doit plus être rappelé après l’arrêt')
})

test('la limite d’étapes s’annonce clairement au lieu de tourner en rond', async () => {
  const loop = () => ({ role: 'assistant', content: '', tool_calls: [call('list_files', {})] })
  const app = setup({ 'a.txt': 'x' }, [loop, loop, loop], { maxTurns: 3 })
  const outcome = await agent.runRepoAgent('change', app.deps)
  assert.equal(outcome.limitReached, true)
  assert.match(outcome.summary, /arrêté après 3 étapes/)
})

test('un fichier binaire n’est ni lu ni modifié', async () => {
  const app = setup({ 'logo.png': null }, [
    { role: 'assistant', content: '', tool_calls: [call('read_file', { path: 'logo.png' }), call('write_file', { path: 'logo.png', content: 'x' })] },
    { role: 'assistant', content: '', tool_calls: [call('finish', { summary: 'ok' })] }
  ])
  await agent.runRepoAgent('change', app.deps)
  const results = toolResults(app.seen.at(-1))
  assert.match(results[0], /binaire/)
  assert.match(results[1], /binaire/)
  assert.equal(app.staged.size, 0)
})

/** Étape 286 (Léo : « il peut pas parler comme toi, il dit ce qu'il fait ») */
test('narrationOf : le texte adressé à l’utilisateur, jamais le code de ses actions', () => {
  const cases = [
    ['Je lis index.html pour trouver le score.\n```action\n{"name": "read_file", "arguments": {"path": "index.html"}}\n```', 'Je lis index.html pour trouver le score.'],
    // Reçu au fil de l'eau : un bloc à moitié écrit ne s'affiche pas, ni ses premiers accents graves.
    ['Je lis index.html.\n```act', 'Je lis index.html.'],
    ['Je lis index.html.\n``', 'Je lis index.html.'],
    // Bloc sans ouverture (vu avec un vrai modèle), contenu de fichier sur plusieurs lignes compris.
    ['Je corrige.\naction\n{"name": "write_file", "arguments": {"path": "b", "content": "l1\nl2"}}\n```\nPuis je termine.', 'Je corrige.\n\nPuis je termine.'],
    ['<think>hmm</think>Je regarde.\n```action\n{}\n```\nEnsuite je modifie style.css.\n```action\n{}\n```', 'Je regarde.\n\nEnsuite je modifie style.css.'],
    ['{"name": "finish", "arguments": {"summary": "ok"}}', ''],
    // Vu avec qwen2.5-coder:7b (essai réel) : le résumé écrit en texte après l'action, déjà affiché à part.
    [`Je vais corriger la faute.\n\n\`\`\`action\n{"name": "edit_file", "arguments": {}}\n\`\`\`\n\nfinish : J'ai corrigé la faute.`, 'Je vais corriger la faute.'],
    ['read_file(index.html)\nJe regarde le jeu.', 'Je regarde le jeu.']
  ]
  for (const [content, expected] of cases) assert.equal(agent.narrationOf(content), expected, content)
})

test('l’agent dit ce qu’il fait : sa phrase arrive au fil de l’eau, et le résumé final n’est pas répété', async () => {
  const replies = [
    'Je lis README.md pour trouver la faute.\n```action\n{"name": "read_file", "arguments": {"path": "README.md"}}\n```',
    'Je corrige la faute.\n```action\n{"name": "edit_file", "arguments": {"path": "README.md", "old_text": "mondee", "new_text": "monde"}}\n```',
    'C’est corrigé.\n```action\n{"name": "finish", "arguments": {"summary": "Faute corrigée."}}\n```'
  ]
  const narrations = []
  const app = setup({ 'README.md': 'Bonjour le mondee\n' }, [], {
    // Le modèle écrit par petits fragments, comme Ollama en streaming.
    chat: async (messages, onDelta) => {
      app.seen.push(messages.map((message) => ({ ...message })))
      const text = replies.shift()
      for (let i = 0; i < text.length; i += 7) onDelta?.(text.slice(i, i + 7))
      return { role: 'assistant', content: text }
    },
    onNarration: (narration) => narrations.push({ ...narration })
  })
  const outcome = await agent.runRepoAgent('Corrige la faute du README', app.deps)
  assert.equal(outcome.summary, 'Faute corrigée.')

  const last = new Map()
  for (const narration of narrations) last.set(narration.id, narration.text)
  assert.deepEqual([...last], [
    [1, 'Je lis README.md pour trouver la faute.'],
    [2, 'Je corrige la faute.'],
    // Le dernier tour devient le résumé, affiché à part : sa phrase est retirée.
    [3, '']
  ])
  // En direct : la phrase s'affiche avant d'être finie…
  assert.ok(narrations.some((n) => n.id === 1 && n.text && n.text.length < 'Je lis README.md pour trouver la faute.'.length))
  // … et jamais le code des actions.
  assert.ok(narrations.every((n) => !n.text.includes('`') && !n.text.includes('"name"')), JSON.stringify(narrations))
  // La consigne est bien donnée au modèle.
  assert.match(app.seen[0][0].content, /UNE phrase courte/)
})
