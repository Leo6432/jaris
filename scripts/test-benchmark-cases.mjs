import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import {
  CONVERSATION_NUM_CTX,
  CONVERSATION_REPEATS,
  CONVERSATION_TEST_VERSION,
  CONVERSATION_TOTAL,
  TEST_CASES,
  TOOLS,
  SYSTEM_PROMPT_TEMPLATE,
  buildBenchmarkSystemPrompt,
  buildCaseMessages,
  isCorrectAnswer,
  isRealReply
} from './benchmark-cases.mjs'
import { systemPromptModule } from './load-system-prompt.mjs'
import { findBrowser } from './benchmark-browser.mjs'
import { CODE_TOTAL } from './benchmark-code.mjs'
import { VISION_TOTAL } from './benchmark-vision.mjs'

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
  'Va sur YouTube': ['computer_use_task', { goal: 'Va sur YouTube et cherche un tuto de guitare' }],
  // Étape 230 : les outils ajoutés au test.
  'Clique à la position': ['click_mouse', { x: 640, y: 360 }],
  'Fais un clic droit': ['click_mouse', { button: 'right' }],
  'Dessine-moi un chat': ['generate_image', { prompt: 'a ginger cat sitting on a sofa' }],
  "Éteins l'ordinateur": ['shutdown_pc', {}],
  "Redémarre l'ordinateur": ['shutdown_pc', { restart: true }],
  "C'est quand déjà l'anniversaire": ['recall_memory', { title: 'Anniversaire de maman' }],
  'Quels sont les horaires de la piscine': ['read_web_page', { url: 'https://metropole.rennes.fr/piscine-saint-georges' }],
  "En fait ma voiture n'est plus": ['remember', { title: 'Voiture', content: 'Renault Clio', replace: true }]
}

function startFakeOllama({ installed, answer, dropChat = () => false, pullFails = false }) {
  const requests = []
  // Étape 230 : téléchargements et suppressions, pour vérifier qu'un modèle téléchargé par le test est supprimé.
  const pulled = []
  const deleted = []
  let chatCalls = 0
  const server = createServer((req, res) => {
    // Coupure de connexion (Ollama arrêté ou en train de redémarrer) : la requête meurt sans réponse.
    if (req.url === '/api/chat' && dropChat(chatCalls++)) return req.socket.destroy()
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json')
      if (req.url === '/api/tags') return res.end(JSON.stringify({ models: installed.map((name) => ({ name })) }))
      if (req.url === '/api/pull' && pullFails) {
        res.statusCode = 500
        return res.end(JSON.stringify({ error: 'pull model manifest: file does not exist' }))
      }
      if (req.url === '/api/pull') {
        const name = JSON.parse(body).name
        pulled.push(name)
        installed.push(name)
        return res.end(JSON.stringify({ status: 'success' }) + '\n')
      }
      if (req.url === '/api/delete') {
        const name = JSON.parse(body).name ?? JSON.parse(body).model
        deleted.push(name)
        installed.splice(installed.indexOf(name), 1)
        return res.end('{}')
      }
      if (req.url === '/api/chat') {
        const json = JSON.parse(body)
        requests.push(json)
        // La question est le dernier message de l'utilisateur : après elle peuvent venir un appel d'outil déjà fait
        // et son résultat (étape 230, read_web_page).
        const prompt = json.messages.findLast((m) => m.role === 'user').content
        const call = answer(json.model, prompt)
        // 'length' : fenêtre pleine pendant la réflexion, aucune réponse (vrai comportement d'Ollama, étape 159).
        if (call === 'length') return res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done_reason: 'length', eval_count: 10, eval_duration: 1e8 }))
        // Étape 230 : { content } = une réponse en texte choisie par le test (questions de vision).
        const message =
          call && !Array.isArray(call)
            ? { role: 'assistant', content: call.content }
            : call
              ? { role: 'assistant', content: '', tool_calls: [{ function: { name: call[0], arguments: call[1] } }] }
              : { role: 'assistant', content: 'Je suis Jaris.' }
        return res.end(JSON.stringify({ message, done_reason: 'stop', eval_count: 10, eval_duration: 1e8 }))
      }
      res.statusCode = 404
      res.end('{}')
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, pulled, deleted, host: `http://127.0.0.1:${server.address().port}` })))
}

/**
 * Étape 232 : le test de code ouvre un vrai navigateur. Ici le Chromium de l'environnement ; sur la CI Windows,
 * le vrai Edge installé avec Windows (le même que chez Léo) — trouvé par findBrowser, comme dans Jaris.
 */
const BROWSER = process.env.JARIS_BROWSER_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : findBrowser())

function runScript(env) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [new URL('./benchmark-models.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')], {
      // Attente d'Ollama raccourcie pour les tests (3 minutes en vrai).
      // Étape 232 : ces tests portent sur les 78 questions ; les demandes complètes ont les leurs
      // (test-benchmark-scenarios.mjs), qui retirent ce réglage.
      env: { ...process.env, JARIS_ANALYSIS_SCOPE: 'flash', JARIS_OLLAMA_WAIT_MS: '400', JARIS_OLLAMA_POLL_MS: '50', JARIS_SKIP_SCENARIOS: '1', JARIS_BROWSER_PATH: BROWSER ?? '', ...env }
    })
    let out = ''
    proc.stdout.on('data', (c) => (out += c))
    proc.stderr.on('data', (c) => (out += c))
    proc.on('close', (code) => resolve({ code, out }))
  })
}

const perfectAnswer = (prompt) => Object.entries(PERFECT).find(([start]) => prompt.startsWith(start))?.[1] ?? null

test('le vrai script : vraies consignes et 15 outils envoyés, 17 questions notées, résultats dans le dossier de données', async () => {
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
    assert.ok(fake.requests.length >= 3 * CONVERSATION_TOTAL)
    for (const r of fake.requests) {
      assert.equal(r.tools.length, 15)
      assert.ok(r.messages[0].content.startsWith('Tu es Jaris, un assistant personnel'))
      // Étape 163 : sans fenêtre imposée, Ollama prenait 4096 et coupait les consignes (~4 600 tokens).
      assert.equal(r.options?.num_ctx, CONVERSATION_NUM_CTX)
    }
    assert.match(readFileSync(resultsPath, 'utf8'), new RegExp(`Version du test de conversation : ${CONVERSATION_TEST_VERSION}`))

    const results = readFileSync(resultsPath, 'utf8')
    const scoreOf = (model) => results.match(new RegExp(`\\| ${model.replace(/[.:]/g, '\\$&')} \\|[^\\n]*\\| (\\d+/\\d+) \\|`))?.[1]
    assert.equal(scoreOf('ministral-3:3b'), `${CONVERSATION_TOTAL}/${CONVERSATION_TOTAL}`)
    // Deux rappels au mauvais délai : deux questions ratées à chaque passage, même avec le bon outil.
    assert.equal(scoreOf('qwen3:1.7b'), `${CONVERSATION_TOTAL - 2 * CONVERSATION_REPEATS}/${CONVERSATION_TOTAL}`)
    // Aucun outil jamais : seules les questions « sans outil » sont justes, à chaque passage.
    const noToolQuestions = TEST_CASES.filter((c) => c.expectedTool === null).length
    assert.equal(noToolQuestions, 5)
    assert.equal(scoreOf('qwen3.5:0.8b'), `${noToolQuestions * CONVERSATION_REPEATS}/${CONVERSATION_TOTAL}`)
    // Étape 230 : le détail dit QUELLE question est ratée, combien de fois, et ce que le modèle a fait à la place.
    assert.match(results, /### qwen3:1\.7b — \d+\/\d+\n\n- RATÉ 3\/3 « Rappelle-moi d'appeler le dentiste dans 20 minutes\. » \(attendu : set_reminder\) — obtenu : set_reminder \{"message":"Appeler le dentiste","delay_minutes":1\}/)
    assert.match(results, /### ministral-3:3b — \d+\/\d+\n\nAucune question ratée\./)
    // Étape 230 : TOUTES les réponses sont recopiées, justes et fausses, avec leur jugement.
    assert.match(results, /- « Merci, c'est parfait ! »\n  > compté juste : aucun outil : « Je suis Jaris\. »\n  > compté juste : aucun outil : « Je suis Jaris\. »\n  > compté juste : aucun outil : « Je suis Jaris\. »/)
    assert.match(results, /### ministral-3:3b[\s\S]*?- « Monte le son\. »\n  > compté juste : media_control \{"action":"volume_up"\}/)
    assert.match(results, /- « Rappelle-moi d'appeler le dentiste dans 20 minutes\. »\n  > compté faux : set_reminder \{"message":"Appeler le dentiste","delay_minutes":1\}/)
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
      // Ces deux modèles ont désormais un score (26/09/2026) : RETEST_ALL isole le filtre de ce test du contenu
      // de verified-tool-scores.md. Sans le filtre, ministral-3:3b et les autres installés seraient testés aussi.
      JARIS_RETEST_ALL: '1',
      JARIS_ONLY_MODELS: 'nemotron-3.5-lightning:30b,qwen2.5-coder:14b'
    })
    assert.equal(code, 0, out)
    const tested = new Set(fake.requests.map((r) => r.model))
    assert.deepEqual([...tested].sort(), ['nemotron-3.5-lightning:30b', 'qwen2.5-coder:14b'])
    const lightning = fake.requests.filter((r) => r.model === 'nemotron-3.5-lightning:30b')
    assert.equal(lightning.length, CONVERSATION_TOTAL, 'Lightning passe chaque question d’appel d’outils, 3 fois')
    assert.ok(fake.requests.filter((r) => r.model === 'qwen2.5-coder:14b').every((r) => !r.tools), 'le modèle de code passe le test de code')
    const results = readFileSync(resultsPath, 'utf8')
    assert.match(results, new RegExp(`\\| nemotron-3\\.5-lightning:30b \\|[^\\n]*\\| ${CONVERSATION_TOTAL}/${CONVERSATION_TOTAL} \\|`))
    assert.match(results, /## Code[\s\S]*\| qwen2\.5-coder:14b \|/)
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// Étape 169 : G9v3-3B (1,9 Go) « sauté (trop gros ou téléchargement impossible) » chez Léo, sans aucun moyen
// de savoir lequel des deux — alors que le vrai message d'Ollama était connu du script.
test('un modèle sauté donne sa VRAIE raison, dans le suivi en direct et dans le fichier de résultats', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-bench-'))
  const fake = await startFakeOllama({ installed: [], answer: (_m, p) => perfectAnswer(p), pullFails: true })
  try {
    const resultsPath = join(dir, 'benchmark-nouveaux-modeles.md')
    const { code, out } = await runScript({
      OLLAMA_HOST: fake.host,
      JARIS_ANALYSIS_SCOPE: 'all',
      JARIS_RESULTS_PATH: resultsPath,
      JARIS_RESUME: '1',
      JARIS_ONLY_MODELS: 'hf.co/openbmb/MiniCPM5-1B-GGUF',
      // Marge minimale : la machine de test a peu de RAM, le modèle doit être jugé téléchargeable.
      JARIS_RAM_SAFETY_MARGIN_GB: '0.1'
    })
    assert.equal(code, 0, out)
    const skipped = out.split('\n').find((l) => l.startsWith('##MODEL_SKIPPED## hf.co/openbmb/MiniCPM5-1B-GGUF'))
    assert.ok(skipped, out)
    assert.match(skipped, /téléchargement impossible : .+/, 'la raison doit suivre le nom du modèle')
    assert.match(readFileSync(resultsPath, 'utf8'), /## Modèles non testés[\s\S]*MiniCPM5-1B-GGUF\*\* : téléchargement impossible/)
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
        `| ministral-3:3b | 100 ms | 50 tok/s | ${CONVERSATION_TOTAL}/${CONVERSATION_TOTAL} |`,
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

test('sans « tout retester », un score du test ACTUEL dispense du test ; un score de l’ancien test (sur 17) non', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-bench-'))
  const fake = await startFakeOllama({ installed: ['ministral-3:3b', 'qwen3:1.7b', 'qwen3.5:0.8b'], answer: (_m, p) => perfectAnswer(p) })
  try {
    const verified = join(dir, 'verified.md')
    writeFileSync(
      verified,
      [
        '## Conversation',
        '',
        '| Modèle | Fiabilité |',
        '|---|---|',
        `| ministral-3:3b | ${CONVERSATION_TOTAL - 1}/${CONVERSATION_TOTAL} |`,
        `| qwen3.5:0.8b | ${CONVERSATION_TOTAL}/${CONVERSATION_TOTAL} |`,
        // Étape 230 : granite4.2:3b, testé à l'ancien test, doit repasser le nouveau.
        '| qwen3:1.7b | 16/17 |'
      ].join('\n')
    )
    const plain = await runScript({ OLLAMA_HOST: fake.host, JARIS_RESULTS_PATH: join(dir, 'a.md'), JARIS_VERIFIED_SCORES_PATH: verified })
    assert.equal(plain.code, 0, plain.out)
    assert.deepEqual([...new Set(fake.requests.map((r) => r.model))], ['qwen3:1.7b'], 'seul le score de l’ancien test est refait')
    fake.requests.length = 0
    const all = await runScript({ OLLAMA_HOST: fake.host, JARIS_RESULTS_PATH: join(dir, 'b.md'), JARIS_VERIFIED_SCORES_PATH: verified, JARIS_RETEST_ALL: '1' })
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

test('la fenêtre de contexte des questions laisse de la place aux vraies consignes et aux 15 outils', () => {
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
    assert.match(results, new RegExp(`\\| qwen3\\.5:0\\.8b \\|[^\\n]*\\| 0/${CONVERSATION_TOTAL} \\|`))
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
    assert.match(readFileSync(resultsPath, 'utf8'), new RegExp(`\\| ministral-3:3b \\|[^\\n]*\\| ${CONVERSATION_TOTAL}/${CONVERSATION_TOTAL} \\|`))
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
        `| ministral-3:3b | — ms | — tok/s | 0/${CONVERSATION_TOTAL} |`,
        `| qwen3:1.7b | 900 ms | 85.4 tok/s | ${CONVERSATION_TOTAL}/${CONVERSATION_TOTAL} |`
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
  // Étape 232 : + les demandes complètes (chatScenario : avec réflexion, puis sans si le modèle la refuse).
  assert.equal((script.match(/await postChat\(/g) ?? []).length, 5, 'conversation, vision, code et demandes complètes passent tous par postChat')
})

test('reprise : une mesure de code INCOMPLÈTE (3/4, une génération perdue) est refaite, une complète (4/5) est gardée', { skip: BROWSER ? false : 'aucun navigateur ici (le test de code en a besoin)' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-bench-'))
  const fake = await startFakeOllama({ installed: ['qwen2.5-coder:32b', 'qwen2.5-coder:7b'], answer: () => null })
  try {
    const resultsPath = join(dir, 'benchmark-results.md')
    // Le vrai cas de Léo : qwen2.5-coder:32b n'avait passé que 2 des 3 générations.
    writeFileSync(
      resultsPath,
      [
        `Version du test de conversation : ${CONVERSATION_TEST_VERSION}`,
        'Version du test de code : 2',
        '',
        '## Code',
        '',
        '| Modèle | Latence moyenne | Vitesse moyenne | Fiabilité |',
        '|---|---|---|---|',
        '| qwen2.5-coder:32b | 271491 ms | 3.1 tok/s | 3/4 |',
        '| qwen2.5-coder:7b | 20745 ms | 50.0 tok/s | 4/5 |'
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

// ---------------------------------------------------------------------------------------------------------
// Étape 230 (Léo : « je veux être sûr à 1000 % avant de lancer au moins 4 h de test »)
// ---------------------------------------------------------------------------------------------------------

test('chaque outil de Jaris est testé par au moins une question (5 sur 15 ne l’étaient jamais)', () => {
  const tested = new Set(TEST_CASES.map((c) => c.expectedTool).filter(Boolean))
  const untested = TOOLS.map((t) => t.function.name).filter((name) => !tested.has(name))
  assert.deepEqual(untested, [], `outils jamais testés : ${untested.join(', ')}`)
})

test('chaque question est posée plusieurs fois, et le total suit (26 questions × 3)', () => {
  assert.ok(CONVERSATION_REPEATS >= 3)
  assert.equal(CONVERSATION_TOTAL, TEST_CASES.length * CONVERSATION_REPEATS)
  assert.ok(new Set(TEST_CASES.map((c) => c.prompt)).size === TEST_CASES.length, 'deux questions identiques')
})

test('Jaris reconnaît les scores du test actuel : même total des deux côtés (hardwareScan.ts)', () => {
  const source = readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8')
  assert.equal(Number(source.match(/export const CONVERSATION_TEST_TOTAL = (\d+)/)?.[1]), CONVERSATION_TOTAL)
})

test('avec des notes en mémoire, les consignes sont EXACTEMENT celles de Jaris (systemPrompt.ts)', () => {
  const titles = ['Voiture', 'Anniversaire de maman', 'Code postal']
  const now = new Date(2026, 9, 3, 11, 31)
  const real = systemPromptModule.buildSystemPrompt(null, titles, 'voice')
  const date = /Nous sommes le [^]*?, il est \d{2}:\d{2}\. /
  assert.equal(buildBenchmarkSystemPrompt(now, titles).replace(date, ''), real.replace(date, ''))
  // Sans notes, toujours la mémoire vide.
  assert.equal(buildBenchmarkSystemPrompt(now).replace(date, ''), systemPromptModule.buildSystemPrompt(null, [], 'voice').replace(date, ''))
})

test('lire une page web : la question, PUIS la recherche déjà faite et son résultat, comme dans converse()', () => {
  const testCase = TEST_CASES.find((c) => c.expectedTool === 'read_web_page')
  const messages = buildCaseMessages(testCase)
  assert.deepEqual(messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool'])
  assert.equal(messages[1].content, testCase.prompt)
  assert.equal(messages[2].tool_calls[0].function.name, 'search_web')
  // Même format que webSearch.ts : « 1. titre — extrait (url) ».
  assert.match(messages[3].content, /^1\. .+ — .+ \(https:\/\/metropole\.rennes\.fr\/piscine-saint-georges\)\n2\. /)
  assert.ok(!/\d{1,2} ?h/.test(messages[3].content), 'le résultat ne doit PAS contenir l’horaire, sinon lire la page est inutile')
})

test('les nouvelles questions jugent le fond : bons arguments justes, mauvais arguments faux', () => {
  const find = (start) => TEST_CASES.find((c) => c.prompt.startsWith(start))
  const ok = (start, toolName, toolArgs) => isCorrectAnswer(find(start), { toolName, toolArgs, content: '' })
  assert.equal(ok('Clique à la position', 'click_mouse', { x: 640, y: 360 }), true)
  assert.equal(ok('Clique à la position', 'click_mouse', { x: '640', y: '360', button: 'left' }), true)
  assert.equal(ok('Clique à la position', 'click_mouse', { x: 360, y: 640 }), false)
  assert.equal(ok('Clique à la position', 'click_mouse', {}), false)
  assert.equal(ok('Fais un clic droit', 'click_mouse', { button: 'right' }), true)
  assert.equal(ok('Fais un clic droit', 'click_mouse', { button: 'left' }), false)
  assert.equal(ok('Dessine-moi un chat', 'generate_image', { prompt: 'A ginger cat on a couch' }), true)
  assert.equal(ok('Dessine-moi un chat', 'generate_image', { prompt: 'a sofa in a living room' }), false)
  assert.equal(ok('Dessine-moi un chat', 'look_at_screen', { question: 'chat' }), false)
  assert.equal(ok("Éteins l'ordinateur", 'shutdown_pc', {}), true)
  assert.equal(ok("Éteins l'ordinateur", 'shutdown_pc', { restart: false }), true)
  assert.equal(ok("Éteins l'ordinateur", 'shutdown_pc', { restart: true }), false, 'redémarrer n’est pas éteindre')
  assert.equal(ok("Redémarre l'ordinateur", 'shutdown_pc', { restart: true }), true)
  assert.equal(ok("Redémarre l'ordinateur", 'shutdown_pc', { restart: 'true' }), true)
  assert.equal(ok("Redémarre l'ordinateur", 'shutdown_pc', {}), false, 'éteindre n’est pas redémarrer')
  assert.equal(ok("C'est quand déjà l'anniversaire", 'recall_memory', { title: 'Anniversaire de maman' }), true)
  assert.equal(ok("C'est quand déjà l'anniversaire", 'recall_memory', { title: 'Voiture' }), false)
  assert.equal(ok("C'est quand déjà l'anniversaire", 'search_web', { query: 'anniversaire de ma mère' }), false)
  assert.equal(ok('Quels sont les horaires de la piscine', 'read_web_page', { url: 'https://metropole.rennes.fr/piscine-saint-georges' }), true)
  assert.equal(ok('Quels sont les horaires de la piscine', 'read_web_page', { url: 'https://www.piscine-rennes.fr/horaires' }), false, 'URL inventée')
  assert.equal(ok('Quels sont les horaires de la piscine', 'search_web', { query: 'horaires piscine Saint-Georges' }), false)
})

test('reprise : le détail par question des modèles déjà testés est gardé dans le fichier final', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-bench-'))
  const fake = await startFakeOllama({ installed: ['ministral-3:3b', 'qwen3:1.7b', 'qwen3.5:0.8b'], answer: (_m, p) => perfectAnswer(p) })
  try {
    const resultsPath = join(dir, 'benchmark-results.md')
    writeFileSync(
      resultsPath,
      [
        `Version du test de conversation : ${CONVERSATION_TEST_VERSION}`,
        'Version du test de vision : 2',
        '',
        '## Conversation',
        '',
        '| Modèle | Latence moyenne | Vitesse moyenne | Fiabilité |',
        '|---|---|---|---|',
        `| ministral-3:3b | 900 ms | 85.4 tok/s | ${CONVERSATION_TOTAL - 1}/${CONVERSATION_TOTAL} |`,
        '',
        '## Vision',
        '',
        '| Modèle | Latence moyenne | Vitesse moyenne | Fiabilité |',
        '|---|---|---|---|',
        '| qwen3.5:4b | 900 ms | 85.4 tok/s | 19/20 |',
        '',
        '## Détail de la conversation, modèle par modèle',
        '',
        `### ministral-3:3b — ${CONVERSATION_TOTAL - 1}/${CONVERSATION_TOTAL}`,
        '',
        '- RATÉ 1/3 « Monte le son. » (attendu : media_control) — obtenu : media_control {"action":"play_pause"}',
        '',
        '### qwen3.5:4b (vision) — 19/20',
        '',
        '- RATÉ 1/2 « Quelle heure affiche l’horloge ? » — obtenu : « 14 h 47 »',
        ''
      ].join('\n')
    )
    const { code, out } = await runScript({ OLLAMA_HOST: fake.host, JARIS_RESULTS_PATH: resultsPath, JARIS_RETEST_ALL: '1', JARIS_RESUME: '1' })
    assert.equal(code, 0, out)
    assert.ok(!fake.requests.some((r) => r.model === 'ministral-3:3b'), 'déjà fait : pas retesté')
    const results = readFileSync(resultsPath, 'utf8')
    assert.match(results, new RegExp(`### ministral-3:3b — ${CONVERSATION_TOTAL - 1}/${CONVERSATION_TOTAL}\\n\\n- RATÉ 1/3 « Monte le son\\. »`), 'le détail du modèle repris doit rester')
    assert.match(results, new RegExp(`### qwen3:1\\.7b — ${CONVERSATION_TOTAL}/${CONVERSATION_TOTAL}`))
    // Le détail de vision d'un modèle repris reste lui aussi (la ligne vision est sur 20, le test actuel).
    assert.match(results, /### qwen3\.5:4b \(vision\) — 19\/20\n\n- RATÉ 1\/2 « Quelle heure affiche l’horloge \? »/)
    assert.equal((results.match(/### ministral-3:3b/g) ?? []).length, 1)
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('un modèle téléchargé pour le test est supprimé après ; un modèle déjà installé, jamais', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-bench-'))
  // ministral-3:3b est déjà là (Léo s'en sert) ; qwen3:1.7b est téléchargé par le test.
  const fake = await startFakeOllama({ installed: ['ministral-3:3b'], answer: (_m, p) => perfectAnswer(p) })
  try {
    const { code, out } = await runScript({
      OLLAMA_HOST: fake.host,
      JARIS_RESULTS_PATH: join(dir, 'r.md'),
      JARIS_RETEST_ALL: '1',
      JARIS_ONLY_MODELS: 'ministral-3:3b,qwen3:1.7b',
      JARIS_DELETE_AFTER_TEST: '1',
      JARIS_RAM_SAFETY_MARGIN_GB: '0.1',
      JARIS_DISK_SAFETY_MARGIN_GB: '0'
    })
    assert.equal(code, 0, out)
    assert.deepEqual(fake.pulled, ['qwen3:1.7b'])
    assert.ok(fake.requests.some((r) => r.model === 'qwen3:1.7b'), 'testé avant d’être supprimé')
    assert.deepEqual(fake.deleted, ['qwen3:1.7b'])
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Jaris lance le test en supprimant les modèles téléchargés pour lui', () => {
  const runner = readFileSync(new URL('../electron/services/benchmarkRunner.ts', import.meta.url), 'utf8')
  assert.match(runner, /JARIS_DELETE_AFTER_TEST: '1'/)
  assert.match(runner, /JARIS_RESUME: '1'/)
})

test('test coupé après un téléchargement : à la reprise, ce modèle est bien supprimé, jamais pris pour un modèle de Léo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-bench-'))
  // Coupure précédente : qwen3:1.7b téléchargé ET testé, mais pas encore supprimé ; qwen3.5:0.8b téléchargé, pas
  // encore testé. ministral-3:3b, lui, appartient à Léo.
  const fake = await startFakeOllama({ installed: ['ministral-3:3b', 'qwen3:1.7b', 'qwen3.5:0.8b'], answer: (_m, p) => perfectAnswer(p) })
  try {
    const resultsPath = join(dir, 'r.md')
    writeFileSync(
      resultsPath,
      [
        `Version du test de conversation : ${CONVERSATION_TEST_VERSION}`,
        '',
        '## Conversation',
        '',
        '| Modèle | Latence moyenne | Vitesse moyenne | Fiabilité |',
        '|---|---|---|---|',
        `| qwen3:1.7b | 900 ms | 85.4 tok/s | ${CONVERSATION_TOTAL}/${CONVERSATION_TOTAL} |`
      ].join('\n')
    )
    writeFileSync(`${resultsPath}.telecharges.json`, JSON.stringify(['qwen3:1.7b', 'qwen3.5:0.8b']))
    const { code, out } = await runScript({
      OLLAMA_HOST: fake.host,
      JARIS_RESULTS_PATH: resultsPath,
      JARIS_RETEST_ALL: '1',
      JARIS_RESUME: '1',
      JARIS_DELETE_AFTER_TEST: '1',
      JARIS_ONLY_MODELS: 'ministral-3:3b,qwen3:1.7b,qwen3.5:0.8b'
    })
    assert.equal(code, 0, out)
    assert.ok(!fake.requests.some((r) => r.model === 'qwen3:1.7b'), 'déjà testé : pas retesté')
    assert.deepEqual([...fake.deleted].sort(), ['qwen3.5:0.8b', 'qwen3:1.7b'], 'les deux modèles du test sont supprimés, jamais celui de Léo')
    assert.deepEqual(JSON.parse(readFileSync(`${resultsPath}.telecharges.json`, 'utf8')), [])
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('fermer Jaris arrête le test en cours, et un second lancement est refusé tant qu’il tourne', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  const beforeQuit = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf('})', main.indexOf("app.on('before-quit'")))
  assert.match(beforeQuit, /stopModelTest\(\)/)
  const runner = readFileSync(new URL('../electron/services/benchmarkRunner.ts', import.meta.url), 'utf8')
  assert.match(runner, /if \(runningTest\) return Promise\.reject/)
  assert.match(runner, /runningTest\?\.kill\(\)/)
})

test('vision : mêmes consignes que look_at_screen (vision.ts), et Jaris reconnaît le total du test actuel', () => {
  // Fins de ligne normalisées : la CI Windows récupère les fichiers en CRLF (piège déjà noté dans CLAUDE.md).
  const script = readFileSync(new URL('./benchmark-models.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const vision = readFileSync(new URL('../electron/services/vision.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const prompt = (src) => src.match(/const VISION_SYSTEM_PROMPT =\s*([\s\S]*?)\n\n/)?.[1].replace(/\s+/g, ' ')
  assert.ok(prompt(vision))
  assert.equal(prompt(script), prompt(vision), 'copie des consignes de vision périmée')
  const hardwareScan = readFileSync(new URL('../electron/services/hardwareScan.ts', import.meta.url), 'utf8')
  assert.equal(Number(hardwareScan.match(/export const VISION_TEST_TOTAL = (\d+)/)?.[1]), VISION_TOTAL)
  assert.equal(Number(hardwareScan.match(/export const CODE_TEST_TOTAL = (\d+)/)?.[1]), CODE_TOTAL)
})

test('corriger une note : seul remember avec replace et la nouvelle valeur compte juste', () => {
  const c = TEST_CASES.find((t) => t.prompt.startsWith('En fait ma voiture'))
  const ok = (toolName, toolArgs) => isCorrectAnswer(c, { toolName, toolArgs, content: '' })
  assert.equal(ok('remember', { title: 'Voiture', content: 'Renault Clio', replace: true }), true)
  assert.equal(ok('remember', { title: 'Voiture', content: 'Clio', replace: 'true' }), true)
  assert.equal(ok('remember', { title: 'Voiture', content: 'Clio' }), false, 'sans replace, l’ancienne valeur resterait à côté')
  assert.equal(ok('remember', { title: 'Voiture', content: 'Peugeot', replace: true }), false)
  const soir = TEST_CASES.find((t) => t.prompt.startsWith('Je vais éteindre'))
  assert.equal(isCorrectAnswer(soir, { toolName: 'shutdown_pc', toolArgs: {} }), false, 'parler d’éteindre plus tard n’est pas une demande')
  assert.equal(isCorrectAnswer(soir, { toolName: null, toolArgs: null, content: 'D’accord, bonne soirée !' }), true)
})

// Vérification du 03/10/2026 : erreurs de notation trouvées en relisant TOUTES les réponses de Léo.
test('notation corrigée : relire la note avant de la corriger, noter un plan, annonces et outils écrits en texte', () => {
  const voiture = TEST_CASES.find((t) => t.prompt.startsWith('En fait ma voiture'))
  assert.equal(isCorrectAnswer(voiture, { toolName: 'recall_memory', toolArgs: { title: 'Voiture' } }), true)
  assert.equal(isCorrectAnswer(voiture, { toolName: 'recall_memory', toolArgs: { title: 'Code postal' } }), false)
  const soir = TEST_CASES.find((t) => t.prompt.startsWith('Je vais éteindre'))
  assert.equal(isCorrectAnswer(soir, { toolName: 'remember', toolArgs: { title: 'Soir', content: 'éteindre le PC' } }), true)
  const reply = (content) => isCorrectAnswer(soir, { toolName: null, toolArgs: null, content })
  assert.equal(reply('Je vais mettre mon ordinateur hors ligne maintenant.'), false)
  assert.equal(reply("J'éteins l'ordinateur."), false)
  assert.equal(reply('shutdown_pc[ARGS]{}'), false)
  assert.equal(reply('Très bien, bonne nuit ! Pense à enregistrer ton travail avant.'), true)
  assert.equal(isRealReply('open_app[ARGS]{"app_name":"Spotify"}'), false)
  assert.equal(isRealReply('Avec plaisir !'), true)
})

test('vision de bout en bout : 10 captures × 2, les consignes de Jaris, et le détail des réponses fausses', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-bench-'))
  const VISION_ANSWERS = {
    "Combien d'œufs": '6',
    "Quel fichier n'a pas": 'Rapport annuel.docx',
    'Quelle température fait-il': '14 °C',
    'Quelle application est au premier plan': 'Spotify',
    'Quel est le prix du clavier': '49,90 €',
    'Combien de mails non lus': '4',
    'Quel est le texte du bouton': 'Annuler',
    // Un modèle qui lit mal l'horloge : faux à chaque passage.
    "Quelle heure affiche l'horloge": '14 h 47',
    'Quel est le titre de la première vidéo': 'Apprendre la guitare en 10 minutes – Leçon 1',
    "Qui vient d'envoyer": 'Julie Martin'
  }
  const fake = await startFakeOllama({
    installed: ['qwen3-vl:2b'],
    answer: (_m, prompt) => ({ content: Object.entries(VISION_ANSWERS).find(([start]) => prompt.startsWith(start))?.[1] ?? '' })
  })
  try {
    const resultsPath = join(dir, 'r.md')
    const { code, out } = await runScript({
      OLLAMA_HOST: fake.host,
      JARIS_RESULTS_PATH: resultsPath,
      JARIS_ANALYSIS_SCOPE: 'vision',
      JARIS_RETEST_ALL: '1',
      JARIS_ONLY_MODELS: 'qwen3-vl:2b'
    })
    assert.equal(code, 0, out)
    assert.equal(fake.requests.length, VISION_TOTAL)
    for (const r of fake.requests) {
      assert.equal(r.messages[0].role, 'system')
      assert.ok(r.messages[0].content.startsWith('Tu es Jaris, un assistant vocal qui décrit ce qui est affiché'))
      assert.equal(r.messages[1].images.length, 1)
      // Une vraie capture PNG (signature PNG en base64), pas une image vide.
      assert.ok(r.messages[1].images[0].startsWith('iVBORw0KGgo') && r.messages[1].images[0].length > 50000)
      assert.equal(r.think, false)
    }
    const results = readFileSync(resultsPath, 'utf8')
    assert.match(results, /Version du test de vision : 2/)
    assert.match(results, /\| qwen3-vl:2b \|[^\n]*\| 18\/20 \|/)
    assert.match(results, /### qwen3-vl:2b \(vision\) — 18\/20\n\n- RATÉ 2\/2 « Quelle heure affiche l'horloge[^»]*» — obtenu : « 14 h 47 »/)
    // Toutes les réponses sont recopiées, justes comprises, pour pouvoir corriger un score à la main.
    assert.match(results, /- « Combien d'œufs[^»]*»\n  > compté juste : 6\n  > compté juste : 6/)
  } finally {
    fake.server.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
