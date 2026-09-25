import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import {
  CONVERSATION_NUM_CTX,
  CONVERSATION_TEST_VERSION,
  TEST_CASES,
  TOOLS,
  SYSTEM_PROMPT_TEMPLATE,
  buildBenchmarkSystemPrompt,
  isCorrectAnswer
} from './benchmark-cases.mjs'
import { systemPromptModule } from './load-system-prompt.mjs'

/**
 * Étape 162, Léo : « est-ce que les tests d'outils sont bien, ou on en rajoute pour faire un bon score fiable,
 * et on refait l'analyse de tout ». L'ancien test utilisait une copie périmée des outils (7 au lieu de 14, dont
 * send_email retiré de Jaris), des consignes simplifiées, et ne notait que 6 questions sans regarder le contenu
 * des appels. Ce fichier vérifie que le nouveau test reste FIDÈLE au vrai Jaris, et fait tourner le vrai script
 * d'analyse de bout en bout contre un faux Ollama.
 */

function loadRealTools() {
  const source = ts.transpileModule(readFileSync(new URL('../electron/services/tools.ts', import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const module = { exports: {} }
  // Les imports de tools.ts ne servent qu'à exécuter les outils, jamais à décrire TOOLS : de simples bouchons suffisent.
  vm.runInThisContext(`(function (exports, require, module) {${source}\n})`)(module.exports, () => new Proxy({}, { get: () => () => {} }), module)
  return module.exports.TOOLS
}

test('les outils du test sont EXACTEMENT ceux de Jaris (tools.ts) — régénérer benchmark-cases.mjs sinon', () => {
  assert.equal(JSON.stringify(TOOLS), JSON.stringify(loadRealTools()))
})

test('les consignes du test sont EXACTEMENT celles de Jaris (systemPrompt.ts, canal voix)', () => {
  const real = systemPromptModule.buildSystemPrompt(null, [], 'voice')
  const now = new Date()
  // Même phrase de date des deux côtés : seule elle change d'un appel à l'autre.
  const realWithoutDate = real.replace(/Nous sommes le [^]*?, il est \d{2}:\d{2}\. /, '{{DATE_HEURE}}')
  assert.equal(SYSTEM_PROMPT_TEMPLATE, realWithoutDate)
  assert.match(buildBenchmarkSystemPrompt(now), /Nous sommes le .+, il est \d{2}:\d{2}\. /)
  assert.ok(!buildBenchmarkSystemPrompt(now).includes('{{DATE_HEURE}}'))
})

test('chaque question attend un outil qui existe vraiment (ou aucun outil)', () => {
  const names = new Set(TOOLS.map((t) => t.function.name))
  for (const c of TEST_CASES) {
    if (c.expectedTool !== null) assert.ok(names.has(c.expectedTool), `outil inconnu : ${c.expectedTool}`)
  }
  assert.ok(TEST_CASES.length >= 15, 'le test doit noter bien plus que les 6 questions de l’ancien')
  assert.ok(TEST_CASES.filter((c) => c.expectedTool === null).length >= 3, 'des questions SANS outil doivent aussi compter')
})

test('une réponse n’est juste que si l’outil ET son contenu le sont', () => {
  const reminder = TEST_CASES.find((c) => c.prompt.includes('dentiste'))
  assert.equal(isCorrectAnswer(reminder, { toolName: 'set_reminder', toolArgs: { message: 'Appeler le dentiste', delay_minutes: 20 } }), true)
  // Bon outil, mauvais délai : l'ancien test l'aurait compté juste.
  assert.equal(isCorrectAnswer(reminder, { toolName: 'set_reminder', toolArgs: { message: 'Appeler le dentiste', delay_minutes: 2 } }), false)
  assert.equal(isCorrectAnswer(reminder, { toolName: 'search_web', toolArgs: { query: 'dentiste' } }), false)
  // Certains modèles renvoient les arguments en chaîne JSON.
  assert.equal(isCorrectAnswer(reminder, { toolName: 'set_reminder', toolArgs: '{"message":"dentiste","delay_minutes":"20"}' }), true)

  const negation = TEST_CASES.find((c) => c.prompt.startsWith("N'éteins"))
  assert.equal(isCorrectAnswer(negation, { toolName: null, toolArgs: null, content: 'Oui, je t’entends.' }), true)
  assert.equal(isCorrectAnswer(negation, { toolName: 'shutdown_pc', toolArgs: {} }), false)
})

// Étape 166 : les vraies réponses fautives relevées dans l'analyse de Léo du 25/09/2026, mot pour mot.
test('sans outil : une réponse vide ou un appel d’outil écrit en texte compte faux, une vraie phrase compte juste', () => {
  const noTool = TEST_CASES.find((c) => c.prompt.startsWith("N'éteins"))
  const fails = [
    '',
    '   ',
    null,
    '{"name": "get_system_stats", "arguments": {}}',
    'look_at_screen{"question":"qu\'élément d\'affichage montre l\'heure"}',
    'Action : ```json\n[\n    {\n        "tool_name": "directly-answer",\n        "parameters": {}\n    }\n]\n```'
  ]
  for (const content of fails) assert.equal(isCorrectAnswer(noTool, { toolName: null, toolArgs: null, content }), false, JSON.stringify(content))
  const passes = [
    'Oui, je t’entends parfaitement.',
    "De rien ! Si vous avez besoin d'aide, n'hésitez pas à demander. [look_at_screen]",
    'Je m’appelle Jaris. Je peux chercher sur le web avec search_web et mémoriser avec remember.'
  ]
  for (const content of passes) assert.equal(isCorrectAnswer(noTool, { toolName: null, toolArgs: null, content }), true, content)
})

// Étape 168 : le bouton « Tester les modèles sans score » lance le script depuis l'appli installée.
test('chaque fichier importé par le script de test est bien embarqué dans l’installeur', () => {
  const script = readFileSync(new URL('./benchmark-models.mjs', import.meta.url), 'utf8')
  const builder = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  const localImports = [...script.matchAll(/from '\.\/([^']+)'/g)].map((m) => m[1])
  assert.ok(localImports.includes('benchmark-cases.mjs'))
  for (const file of ['benchmark-models.mjs', 'verified-tool-scores.md', ...localImports]) {
    assert.match(builder, new RegExp(`- ${file.replace('.', '\\.')}`), `${file} absent de electron-builder.yml`)
  }
})

// ---------------------------------------------------------------------------------------------------------
// Le vrai script, de bout en bout, contre un faux Ollama
// ---------------------------------------------------------------------------------------------------------

/** Bonne réponse (outil + arguments) pour chaque question — ce que renverrait un modèle parfait. */
const PERFECT = {
  'Écris bonjour': ['type_text', { text: 'bonjour' }],
  'Cherche le prix du Bitcoin': ['search_web', { query: 'prix bitcoin' }],
  'Qui est le président': ['search_web', { query: 'président de la France' }],
  "Rappelle-moi d'appeler le dentiste": ['set_reminder', { message: 'Appeler le dentiste', delay_minutes: 20 }],
  'Préviens-moi dans une heure et demie': ['set_reminder', { message: 'Sortir le linge', delay_minutes: 90 }],
  "Qu'est-ce qui est affiché": ['look_at_screen', { question: 'Que voit-on ?' }],
  'Ouvre le bloc-notes': ['open_app', { app_name: 'bloc-notes' }],
  'Lance Spotify': ['open_app', { app_name: 'Spotify' }],
  'Retiens que mon code postal': ['remember', { title: 'Code postal', content: '75001' }],
  'Monte le son': ['media_control', { action: 'volume_up' }],
  'Appuie sur Entrée': ['press_key', { key: 'entrée' }],
  'Combien de mémoire vive': ['get_system_stats', {}],
  'Va sur YouTube': ['computer_use_task', { goal: 'Va sur YouTube et cherche un tuto de guitare' }]
}

function startFakeOllama({ installed, answer, dropChat = () => false }) {
  const requests = []
  let chatCalls = 0
  const server = createServer((req, res) => {
    // Coupure de connexion (Ollama arrêté ou en train de redémarrer) : la requête meurt sans réponse.
    if (req.url === '/api/chat' && dropChat(chatCalls++)) return req.socket.destroy()
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: installed.map((name) => ({ name })) }))
      if (req.url === '/api/chat') {
        const json = JSON.parse(body)
        requests.push(json)
        const prompt = json.messages.at(-1).content
        const call = answer(json.model, prompt)
        // 'length' : fenêtre pleine pendant la réflexion, aucune réponse (vrai comportement d'Ollama, étape 159).
        if (call === 'length') return res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done_reason: 'length', eval_count: 10, eval_duration: 1e8 }))
        const message = call ? { role: 'assistant', content: '', tool_calls: [{ function: { name: call[0], arguments: call[1] } }] } : { role: 'assistant', content: 'Je suis Jaris.' }
        return res.end(JSON.stringify({ message, done_reason: 'stop', eval_count: 10, eval_duration: 1e8 }))
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, host: `http://127.0.0.1:${server.address().port}` })))
}

function runScript(env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [new URL('./benchmark-models.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], {
      // Attente d'Ollama raccourcie pour les tests (3 minutes en vrai).
      env: { ...process.env, JARIS_ANALYSIS_SCOPE: 'flash', JARIS_OLLAMA_WAIT_MS: '400', JARIS_OLLAMA_POLL_MS: '50', ...env }
    })
    let out = ''
    proc.stdout.on('data', (c) => (out += c))
    proc.stderr.on('data', (c) => (out += c))
    proc.on('close', (code) => resolve({ code, out }))
  })
}

const perfectAnswer = (prompt) => Object.entries(PERFECT).find(([start]) => prompt.startsWith(start))?.[1] ?? null

test('le vrai script : vraies consignes et 14 outils envoyés, 17 questions notées, résultats dans le dossier de données', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-bench-'))
  const fake = await startFakeOllama({
    installed: ['ministral-3:3b', 'qwen3:1.7b', 'qwen3.5:0.8b'],
    // ministral-3:3b répond parfaitement ; qwen3:1.7b programme ses rappels au mauvais délai ; qwen3.5:0.8b
    // n'appelle jamais d'outil.
    answer: (model, prompt) => {
      if (model === 'qwen3.5:0.8b') return null
      const call = perfectAnswer(prompt)
      if (model === 'qwen3:1.7b' && call?.[0] === 'set_reminder') return ['set_reminder', { ...call[1], delay_minutes: 1 }]
      return call
    }
  })
  try {
    const resultsPath = join(dir, 'benchmark-results.md')
    const { code, out } = await runScript({ OLLAMA_HOST: fake.host, JARIS_RESULTS_PATH: resultsPath, JARIS_RETEST_ALL: '1' })
    assert.equal(code, 0, out)

    // Ce que les modèles ont reçu : les VRAIES consignes et les 14 VRAIS outils.
    assert.ok(fake.requests.length >= 3 * TEST_CASES.length)
    for (const r of fake.requests) {
      assert.equal(r.tools.length, 14)
      assert.ok(r.messages[0].content.startsWith('Tu es Jaris, un assistant personnel'))
      // Étape 163 : sans fenêtre imposée, Ollama prenait 4096 et coupait les consignes (~4 600 tokens).
      assert.equal(r.options?.num_ctx, CONVERSATION_NUM_CTX)
    }
    assert.match(readFileSync(resultsPath, 'utf8'), new RegExp(`Version du test de conversation : ${CONVERSATION_TEST_VERSION}`))

    const results = readFileSync(resultsPath, 'utf8')
    const scoreOf = (model) => results.match(new RegExp(`\\| ${model.replace(/[.:]/g, '\\$&')} \\|[^\\n]*\\| (\\d+/\\d+) \\|`))?.[1]
    assert.equal(scoreOf('ministral-3:3b'), `${TEST_CASES.length}/${TEST_CASES.length}`)
    // Deux rappels au mauvais délai : deux questions ratées, même avec le bon outil.
    assert.equal(scoreOf('qwen3:1.7b'), `${TEST_CASES.length - 2}/${TEST_CASES.length}`)
    // Aucun outil jamais : seules les 4 questions « sans outil » sont justes.
    assert.equal(scoreOf('qwen3.5:0.8b'), `4/${TEST_CASES.length}`)
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('JARIS_ONLY_MODELS : seuls les modèles demandés sont testés, dans leur épreuve (conversation ou code)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-bench-'))
  const fake = await startFakeOllama({
    // MiniCPM5 et devstral-2:123b n'ont PAS de score non plus : sans le filtre, ils seraient testés eux aussi.
    installed: ['ministral-3:3b', 'nemotron-3.5-lightning:30b', 'qwen2.5-coder:14b', 'qwen2.5-coder:7b', 'hf.co/openbmb/MiniCPM5-1B-GGUF', 'devstral-2:123b'],
    answer: (_m, p) => perfectAnswer(p)
  })
  try {
    const resultsPath = join(dir, 'benchmark-nouveaux-modeles.md')
    const { code, out } = await runScript({
      OLLAMA_HOST: fake.host,
      JARIS_ANALYSIS_SCOPE: 'all',
      JARIS_RESULTS_PATH: resultsPath,
      JARIS_RESUME: '1',
      JARIS_ONLY_MODELS: 'nemotron-3.5-lightning:30b,qwen2.5-coder:14b'
    })
    assert.equal(code, 0, out)
    const tested = new Set(fake.requests.map((r) => r.model))
    assert.deepEqual([...tested].sort(), ['nemotron-3.5-lightning:30b', 'qwen2.5-coder:14b'])
    const lightning = fake.requests.filter((r) => r.model === 'nemotron-3.5-lightning:30b')
    assert.equal(lightning.length, TEST_CASES.length, 'Lightning passe les 17 questions d’appel d’outils')
    assert.ok(fake.requests.filter((r) => r.model === 'qwen2.5-coder:14b').every((r) => !r.tools), 'le modèle de code passe le test de code')
    const results = readFileSync(resultsPath, 'utf8')
    assert.match(results, /\| nemotron-3\.5-lightning:30b \|[^\n]*\| 17\/17 \|/)
    assert.match(results, /## Code[\s\S]*\| qwen2\.5-coder:14b \|/)
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reprise : un modèle déjà passé au NOUVEAU test est sauté, une ligne de l’ANCIEN test (x/6) est refaite', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-bench-'))
  const fake = await startFakeOllama({ installed: ['ministral-3:3b', 'qwen3:1.7b', 'qwen3.5:0.8b'], answer: (_m, p) => perfectAnswer(p) })
  try {
    const resultsPath = join(dir, 'benchmark-results.md')
    writeFileSync(
      resultsPath,
      [
        `Version du test de conversation : ${CONVERSATION_TEST_VERSION}`,
        '',
        '## Conversation — appel d’outils',
        '| Modèle | Latence moyenne | Vitesse moyenne | Fiabilité |',
        '|---|---|---|---|',
        `| ministral-3:3b | 100 ms | 50 tok/s | ${TEST_CASES.length}/${TEST_CASES.length} |`,
        '| qwen3:1.7b | 100 ms | 50 tok/s | 6/6 |'
      ].join('\n')
    )
    const { code, out } = await runScript({ OLLAMA_HOST: fake.host, JARIS_RESULTS_PATH: resultsPath, JARIS_RETEST_ALL: '1', JARIS_RESUME: '1' })
    assert.equal(code, 0, out)
    const testedModels = new Set(fake.requests.map((r) => r.model))
    assert.ok(!testedModels.has('ministral-3:3b'), 'déjà passé au nouveau test : ne doit pas être refait')
    assert.ok(testedModels.has('qwen3:1.7b'), 'une ligne de l’ancien test doit être refaite')
    assert.ok(testedModels.has('qwen3.5:0.8b'))
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('sans « tout retester », un modèle déjà vérifié n’est pas retesté ; avec, il l’est', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-bench-'))
  const fake = await startFakeOllama({ installed: ['ministral-3:3b', 'qwen3:1.7b', 'qwen3.5:0.8b'], answer: (_m, p) => perfectAnswer(p) })
  try {
    // ministral-3:3b, qwen3:1.7b et qwen3.5:0.8b sont tous dans verified-tool-scores.md.
    const plain = await runScript({ OLLAMA_HOST: fake.host, JARIS_RESULTS_PATH: join(dir, 'a.md') })
    assert.equal(plain.code, 0, plain.out)
    assert.equal(fake.requests.length, 0, 'déjà vérifiés : rien ne doit être retesté sans « tout retester »')
    const all = await runScript({ OLLAMA_HOST: fake.host, JARIS_RESULTS_PATH: join(dir, 'b.md'), JARIS_RETEST_ALL: '1' })
    assert.equal(all.code, 0, all.out)
    assert.equal(new Set(fake.requests.map((r) => r.model)).size, 3)
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pendant l’analyse, TOUS les modèles peuvent déborder sur la RAM (gemma4:12b n’était jamais testé sur 8 Go)', () => {
  // Test du code lui-même : simuler une carte graphique ici demanderait un faux nvidia-smi, impossible à
  // poser proprement sur la CI Windows. Réussir une question ne dépend pas du matériel, seule la durée change.
  const script = readFileSync(new URL('./benchmark-models.mjs', import.meta.url), 'utf8')
  assert.match(script, /const memBudget = Math\.max\(vramBudgetGb, ramOffloadBudgetGb\)/)
  assert.ok(script.includes("'gemma4:12b'"), 'gemma4:12b doit rester dans la liste des modèles testés')
})

test('la fenêtre de contexte des questions laisse de la place aux vraies consignes et aux 14 outils', () => {
  // ~2,9 caractères par token pour ce genre de texte (mesuré à l'étape 159) : consignes + outils + question.
  const promptChars = buildBenchmarkSystemPrompt().length + JSON.stringify(TOOLS).length + 200
  assert.ok(CONVERSATION_NUM_CTX >= promptChars / 2.5 + 1024, `fenêtre ${CONVERSATION_NUM_CTX} trop petite pour ~${Math.round(promptChars / 2.5)} tokens`)
  assert.ok(CONVERSATION_NUM_CTX > 4096, 'la valeur par défaut d’Ollama (4096) coupait les consignes')
})

test('reprise : des scores de conversation d’une version PRÉCÉDENTE du test (même sur 17) sont refaits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-bench-'))
  const fake = await startFakeOllama({ installed: ['ministral-3:3b', 'qwen3:1.7b', 'qwen3.5:0.8b'], answer: (_m, p) => perfectAnswer(p) })
  try {
    const resultsPath = join(dir, 'benchmark-results.md')
    // Le fichier réel de la première analyse de Léo : aucune ligne de version, des scores sur 17 faussés.
    writeFileSync(
      resultsPath,
      [
        '# Résultats du benchmark Jaris — 25/09/2026 17:46:33',
        '',
        '## Conversation',
        '',
        '| Modèle | Latence moyenne | Vitesse moyenne | Fiabilité |',
        '|---|---|---|---|',
        '| ministral-3:3b | 900 ms | 85.4 tok/s | 17/17 |',
        '| qwen3.5:0.8b | 3857 ms | 151.6 tok/s | 4/17 |'
      ].join('\n')
    )
    const { code, out } = await runScript({ OLLAMA_HOST: fake.host, JARIS_RESULTS_PATH: resultsPath, JARIS_RETEST_ALL: '1', JARIS_RESUME: '1' })
    assert.equal(code, 0, out)
    assert.equal(new Set(fake.requests.map((r) => r.model)).size, 3, 'les trois modèles doivent être refaits')
    assert.ok(!readFileSync(resultsPath, 'utf8').includes('| 4/17 |'), 'l’ancien score faussé ne doit pas être recopié')
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('une réponse coupée faute de place compte comme un échec, jamais comme « aucun outil » réussi', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-bench-'))
  const fake = await startFakeOllama({
    installed: ['ministral-3:3b', 'qwen3:1.7b', 'qwen3.5:0.8b'],
    answer: (model, prompt) => (model === 'qwen3.5:0.8b' ? 'length' : perfectAnswer(prompt))
  })
  try {
    const resultsPath = join(dir, 'benchmark-results.md')
    const { code, out } = await runScript({ OLLAMA_HOST: fake.host, JARIS_RESULTS_PATH: resultsPath, JARIS_RETEST_ALL: '1' })
    assert.equal(code, 0, out)
    const results = readFileSync(resultsPath, 'utf8')
    // Sans ce garde-fou, les 4 questions « sans outil » auraient été comptées justes : 4/17.
    assert.match(results, new RegExp(`\\| qwen3\\.5:0\\.8b \\|[^\\n]*\\| 0/${TEST_CASES.length} \\|`))
    assert.match(results, /fenêtre de contexte pleine/)
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('les vérifications jugent le fond, pas la forme (« BTC », « return », « guitar »...)', () => {
  const find = (start) => TEST_CASES.find((c) => c.prompt.startsWith(start))
  assert.equal(isCorrectAnswer(find('Cherche le prix'), { toolName: 'search_web', toolArgs: { query: 'cours BTC' } }), true)
  assert.equal(isCorrectAnswer(find('Appuie sur'), { toolName: 'press_key', toolArgs: { key: 'return' } }), true)
  assert.equal(isCorrectAnswer(find('Va sur YouTube'), { toolName: 'computer_use_task', toolArgs: { goal: 'Open YouTube and search for a guitar tutorial' } }), true)
  assert.equal(isCorrectAnswer(find('Qui est le président'), { toolName: 'search_web', toolArgs: { query: "chef de l'État français" } }), true)
  // Le fond reste exigé : une recherche sans rapport reste fausse.
  assert.equal(isCorrectAnswer(find('Cherche le prix'), { toolName: 'search_web', toolArgs: { query: 'météo Paris' } }), false)
})

/**
 * Étape 164 : la deuxième analyse de Léo a noté 0/17 à plusieurs modèles, « fetch failed » sur toutes les
 * questions — Ollama était injoignable (arrêté ou en train de redémarrer), les modèles n'y étaient pour rien. Et
 * la reprise prenait ensuite ces faux 0/17 pour des scores.
 */
test('Ollama coupé un instant : l’analyse attend son retour et note le VRAI score, jamais un faux 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-bench-'))
  // Les 3 premières questions tombent sur une coupure, puis Ollama répond de nouveau.
  const fake = await startFakeOllama({ installed: ['ministral-3:3b'], answer: (_m, p) => perfectAnswer(p), dropChat: (n) => n < 3 })
  try {
    const resultsPath = join(dir, 'benchmark-results.md')
    const { code, out } = await runScript({ OLLAMA_HOST: fake.host, JARIS_RESULTS_PATH: resultsPath, JARIS_RETEST_ALL: '1' })
    assert.equal(code, 0, out)
    assert.match(out, /Ollama ne répond plus/)
    assert.match(readFileSync(resultsPath, 'utf8'), new RegExp(`\\| ministral-3:3b \\|[^\\n]*\\| ${TEST_CASES.length}/${TEST_CASES.length} \\|`))
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Ollama qui ne revient pas : l’analyse s’arrête et n’enregistre AUCUN score pour le modèle en cours', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-bench-'))
  const fake = await startFakeOllama({ installed: ['ministral-3:3b'], answer: (_m, p) => perfectAnswer(p), dropChat: () => true })
  try {
    const resultsPath = join(dir, 'benchmark-results.md')
    const { code, out } = await runScript({ OLLAMA_HOST: fake.host, JARIS_RESULTS_PATH: resultsPath, JARIS_RETEST_ALL: '1' })
    assert.notEqual(code, 0, 'l’analyse doit s’arrêter en erreur')
    assert.match(out, /Ollama ne répond plus : l'analyse s'arrête/)
    let results = ''
    try {
      results = readFileSync(resultsPath, 'utf8')
    } catch {
      // Aucun fichier écrit : c'est aussi un bon résultat.
    }
    assert.ok(!results.includes('| ministral-3:3b |'), 'aucun faux score ne doit être enregistré')
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reprise : une ligne sans AUCUNE réponse (0/17, latence « — ») est refaite, pas prise pour un score', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-bench-'))
  const fake = await startFakeOllama({ installed: ['ministral-3:3b', 'qwen3:1.7b', 'qwen3.5:0.8b'], answer: (_m, p) => perfectAnswer(p) })
  try {
    const resultsPath = join(dir, 'benchmark-results.md')
    // Le vrai fichier de la deuxième analyse de Léo.
    writeFileSync(
      resultsPath,
      [
        `Version du test de conversation : ${CONVERSATION_TEST_VERSION}`,
        '',
        '## Conversation',
        '',
        '| Modèle | Latence moyenne | Vitesse moyenne | Fiabilité |',
        '|---|---|---|---|',
        `| ministral-3:3b | — ms | — tok/s | 0/${TEST_CASES.length} |`,
        `| qwen3:1.7b | 900 ms | 85.4 tok/s | ${TEST_CASES.length}/${TEST_CASES.length} |`
      ].join('\n')
    )
    const { code, out } = await runScript({ OLLAMA_HOST: fake.host, JARIS_RESULTS_PATH: resultsPath, JARIS_RETEST_ALL: '1', JARIS_RESUME: '1' })
    assert.equal(code, 0, out)
    const tested = new Set(fake.requests.map((r) => r.model))
    assert.ok(tested.has('ministral-3:3b'), 'un 0/17 sans aucune réponse doit être refait')
    assert.ok(!tested.has('qwen3:1.7b'), 'un vrai score du test actuel est gardé')
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('aucune question n’est posée avec fetch (qui abandonne au bout de 5 minutes sans réponse)', () => {
  const script = readFileSync(new URL('./benchmark-models.mjs', import.meta.url), 'utf8')
  assert.ok(!/fetch\(`\$\{OLLAMA_HOST\}\/api\/chat`/.test(script), 'les questions doivent passer par postChat (http.request, sans délai)')
  assert.equal((script.match(/await postChat\(/g) ?? []).length, 3, 'conversation, vision et code passent tous par postChat')
})

test('reprise : une mesure de code INCOMPLÈTE (2/2 au lieu de 3/3) est refaite, une complète est gardée', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-bench-'))
  const fake = await startFakeOllama({ installed: ['qwen2.5-coder:32b', 'qwen2.5-coder:7b'], answer: () => null })
  try {
    const resultsPath = join(dir, 'benchmark-results.md')
    // Le vrai cas de Léo : qwen2.5-coder:32b n'avait passé que 2 des 3 générations.
    writeFileSync(
      resultsPath,
      [
        `Version du test de conversation : ${CONVERSATION_TEST_VERSION}`,
        '',
        '## Code',
        '',
        '| Modèle | Latence moyenne | Vitesse moyenne | Fiabilité |',
        '|---|---|---|---|',
        '| qwen2.5-coder:32b | 271491 ms | 3.1 tok/s | 2/2 |',
        '| qwen2.5-coder:7b | 20745 ms | 50.0 tok/s | 3/3 |'
      ].join('\n')
    )
    const { code, out } = await runScript({
      OLLAMA_HOST: fake.host,
      JARIS_RESULTS_PATH: resultsPath,
      JARIS_RETEST_ALL: '1',
      JARIS_RESUME: '1',
      JARIS_ANALYSIS_SCOPE: 'code'
    })
    assert.equal(code, 0, out)
    const tested = new Set(fake.requests.map((r) => r.model))
    assert.ok(tested.has('qwen2.5-coder:32b'), 'une mesure incomplète doit être refaite')
    assert.ok(!tested.has('qwen2.5-coder:7b'), 'une mesure complète est gardée')
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
