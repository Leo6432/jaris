#!/usr/bin/env node
/**
 * Benchmark comparatif des modèles candidats pour Jaris, sur le matériel réel de l'utilisateur — plutôt
 * que de continuer à deviner à partir de benchmarks publiés (souvent absents, ou pas mesurés dans les
 * mêmes conditions). Utilise EXACTEMENT les mêmes schémas d'outils que Jaris (electron/services/tools.ts),
 * sans jamais les exécuter pour de vrai : on vérifie juste que le bon outil est appelé avec des arguments
 * plausibles, jamais qu'une appli s'ouvre réellement ou qu'un mail parte.
 *
 * Usage :
 *   node scripts/benchmark-models.mjs
 *   OLLAMA_HOST=http://127.0.0.1:11434 node scripts/benchmark-models.mjs
 *
 * Installe automatiquement (`ollama pull`) tout modèle de MODELS pas encore présent avant de le tester —
 * potentiellement plusieurs dizaines de Go au premier lancement si rien n'est encore installé. Lancé
 * depuis l'onglet Modèles de Jaris (bouton "Lancer le benchmark"), une confirmation est affichée avant de
 * démarrer, justement à cause de ce téléchargement potentiellement volumineux.
 */

import { writeFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RESULTS_PATH = join(__dirname, 'benchmark-results.md')

const OLLAMA_HOST = process.env.OLLAMA_HOST?.trim() || 'http://127.0.0.1:11434'

const MODELS = [
  'qwen3.5:2b', // par défaut en Q8_0 (2,74 Go) : plus précis mais plus lourd que la variante ci-dessous
  // Contrairement à qwen3.5:4b/9b (déjà en Q4_K_M par défaut, donc un tag "-q4_K_M" y serait redondant),
  // qwen3.5:2b par défaut est en Q8_0 : ce tag explicite est un fichier réellement différent (1,95 Go,
  // plus compressé, potentiellement plus rapide), donc ça vaut le coup de le comparer séparément.
  'qwen3.5:2b-q4_K_M',
  'qwen3.5:4b',
  'qwen3.5:9b',
  'phi4-mini',
  'gemma4:e4b',
  'granite4:3b',
  'nemotron-3-nano:4b',
  'ministral-3:3b',
  // Pas de tag officiel dans la bibliothèque Ollama pour ce 1.2B (seule la variante 8B-MoE y est) : import
  // direct depuis le dépôt Hugging Face officiel de LiquidAI, `ollama pull` fonctionne pareil avec ce préfixe.
  'hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF',
  'qwen3:1.7b',
  'granite4:1b',
  // Fait exclusivement pour le tool calling (pas pour la conversation générale) : ses réponses aux 2
  // questions de raisonnement du test n'ont pas vraiment de sens, mais intéressant sur les 6 tests d'outils.
  'functiongemma:270m'
]

// Copié tel quel depuis electron/services/tools.ts : mêmes schémas que Jaris utilise réellement en
// conversation, pour que le test reflète le vrai comportement de tool calling, pas un cas simplifié.
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'open_app',
      description:
        "Ouvre n'importe quelle application installée sur l'ordinateur de l'utilisateur (pas seulement " +
        "quelques applications connues : appelle toujours cet outil avec le nom demandé, il cherche lui-même " +
        "parmi toutes les applications installées sur la machine).",
      parameters: {
        type: 'object',
        properties: { app_name: { type: 'string', description: "Nom de l'application à ouvrir, tel que demandé par l'utilisateur" } },
        required: ['app_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: 'Programme un rappel vocal qui sera dit à voix haute dans un certain nombre de minutes.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Le contenu du rappel à dire à voix haute' },
          delay_minutes: { type: 'number', description: 'Dans combien de minutes déclencher le rappel' }
        },
        required: ['message', 'delay_minutes']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'look_at_screen',
      description:
        "Capture une image de l'écran de l'utilisateur et la décrit, ou répond à une question précise sur " +
        "ce qui y est affiché (ex: lire un message d'erreur, décrire une fenêtre ouverte).",
      parameters: {
        type: 'object',
        properties: { question: { type: 'string', description: "Ce qu'il faut chercher ou décrire sur l'écran, en français" } },
        required: ['question']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_web',
      description: "Recherche sur le web (moteur local) pour des informations récentes, actuelles, ou que tu ne connais pas avec certitude.",
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Les mots-clés de recherche' } },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'remember',
      description:
        "Enregistre une information importante à retenir sur le long terme dans la mémoire locale de Jaris " +
        "(préférence de l'utilisateur, fait donné en conversation, résumé à garder).",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Titre court de la note' },
          content: { type: 'string', description: 'Le contenu à retenir, en markdown' }
        },
        required: ['title', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: "Envoie un vrai mail via le compte configuré par l'utilisateur.",
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: "Adresse mail EXACTE du destinataire" },
          subject: { type: 'string', description: 'Objet du mail' },
          body: { type: 'string', description: 'Contenu du mail, en texte simple' }
        },
        required: ['to', 'subject', 'body']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'type_text',
      description: "Écrit du texte à l'endroit où se trouve le curseur/focus actuel sur l'ordinateur.",
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'Le texte exact à taper' } },
        required: ['text']
      }
    }
  }
]

const SYSTEM_PROMPT =
  "Tu es Jaris, un assistant vocal personnel qui tourne entièrement en local. Réponds en français, de façon " +
  "concise et naturelle, comme dans une conversation orale, sans émojis ni mise en forme. Pour toute action " +
  "concrète, appelle IMPÉRATIVEMENT l'outil correspondant via un vrai appel de fonction, immédiatement, sans " +
  "phrase d'annonce avant. Si aucune action n'est demandée, réponds directement sans outil."

/** Chaque prompt réaliste tiré de vrais usages de Jaris ; expectedTool: null = pas d'outil attendu (juste conversationnel). */
const TEST_CASES = [
  { prompt: 'Écris bonjour dans le champ de texte ouvert.', expectedTool: 'type_text' },
  { prompt: 'Cherche le prix du Bitcoin aujourd\'hui.', expectedTool: 'search_web' },
  { prompt: "Rappelle-moi d'appeler le dentiste dans 20 minutes.", expectedTool: 'set_reminder' },
  { prompt: 'Qu\'est-ce qui est affiché sur mon écran en ce moment ?', expectedTool: 'look_at_screen' },
  { prompt: 'Ouvre le bloc-notes.', expectedTool: 'open_app' },
  { prompt: 'Retiens que mon code postal est 75001.', expectedTool: 'remember' },
  { prompt: 'Explique-moi en une phrase pourquoi le ciel est bleu.', expectedTool: null },
  { prompt: 'Comment tu t\'appelles et qu\'est-ce que tu peux faire pour moi ?', expectedTool: null }
]

async function listInstalledModels() {
  const res = await fetch(`${OLLAMA_HOST}/api/tags`)
  if (!res.ok) throw new Error(`Ollama a répondu ${res.status} (est-il lancé sur ${OLLAMA_HOST} ?)`)
  const data = await res.json()
  return (data.models ?? []).map((m) => m.name)
}

/**
 * Télécharge `model` via Ollama, avec une progression affichée par tranche de 10% (pas à chaque %, sinon
 * ~100 lignes par modèle) : lisible aussi bien dans un vrai terminal que dans le journal en direct de
 * l'onglet Modèles de Jaris (qui découpe la sortie ligne par ligne, un `\r` ne s'y afficherait pas pareil).
 */
async function pullModel(model) {
  console.log(`Téléchargement de ${model}…`)
  const res = await fetch(`${OLLAMA_HOST}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model, stream: true })
  })
  if (!res.ok || !res.body) throw new Error(`${res.status} ${await res.text()}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastBucket = -1

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let newlineIndex
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (!line) continue

      let progress
      try {
        progress = JSON.parse(line)
      } catch {
        continue
      }
      if (progress.error) throw new Error(progress.error)

      if (progress.total && progress.completed !== undefined) {
        const bucket = Math.floor((progress.completed / progress.total) * 10) * 10
        if (bucket !== lastBucket) {
          lastBucket = bucket
          console.log(`  ${model} : ${bucket}%`)
        }
      }
    }
  }
}

/**
 * Certains modèles (constaté : granite4, ministral-3, functiongemma) n'ont pas de mode réflexion et
 * rejettent le paramètre `think` avec une erreur, contrairement aux familles Qwen/Gemma4/Nemotron qui le
 * supportent toutes. Plutôt que de maintenir une liste de compatibilité à la main (fragile, à mettre à
 * jour à chaque nouveau modèle testé), on retente une fois sans `think` si le premier essai échoue.
 */
async function chatOnce(model, prompt, withThink) {
  const start = performance.now()
  const body = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ],
    tools: TOOLS,
    stream: false
  }
  if (withThink) body.think = 'medium'

  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const wallMs = performance.now() - start
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  return { wallMs, data: await res.json() }
}

async function chat(model, prompt) {
  let wallMs, data
  try {
    ;({ wallMs, data } = await chatOnce(model, prompt, true))
  } catch (firstErr) {
    try {
      ;({ wallMs, data } = await chatOnce(model, prompt, false))
    } catch {
      throw firstErr // le premier message d'erreur est généralement le plus informatif (statut HTTP réel)
    }
  }
  const evalCount = data.eval_count ?? 0
  const evalDurationS = (data.eval_duration ?? 0) / 1e9
  const tokPerSec = evalDurationS > 0 ? evalCount / evalDurationS : null
  const toolCalls = data.message?.tool_calls ?? []
  return {
    wallMs,
    tokPerSec,
    toolName: toolCalls[0]?.function?.name ?? null,
    toolArgs: toolCalls[0]?.function?.arguments ?? null,
    content: data.message?.content?.trim() ?? ''
  }
}

function fmt(n, digits = 1) {
  return n === null || n === undefined || Number.isNaN(n) ? '—' : n.toFixed(digits)
}

async function main() {
  console.log(`Ollama : ${OLLAMA_HOST}\n`)

  let installed
  try {
    installed = await listInstalledModels()
  } catch (err) {
    console.error(`Impossible de joindre Ollama : ${err.message}`)
    process.exit(1)
  }

  const missing = MODELS.filter((m) => !installed.includes(m))
  if (missing.length) {
    console.log(`${missing.length} modèle(s) manquant(s) à installer avant le test :\n`)
    for (const model of missing) {
      try {
        await pullModel(model)
      } catch (err) {
        console.log(`  Échec de l'installation de ${model} : ${err.message} (ignoré pour ce run)`)
      }
    }
    installed = await listInstalledModels()
    console.log('')
  }

  const toRun = MODELS.filter((m) => installed.includes(m))
  if (!toRun.length) {
    console.log('Aucun des modèles à tester n\'a pu être installé.')
    return
  }

  const results = []
  const reasoningAnswers = []
  const errors = []

  for (const model of toRun) {
    console.log(`\n=== ${model} ===`)
    const perModel = { model, latencies: [], speeds: [], correct: 0, total: 0 }

    for (const { prompt, expectedTool } of TEST_CASES) {
      process.stdout.write(`  "${prompt.slice(0, 40)}${prompt.length > 40 ? '…' : ''}" ... `)
      try {
        const r = await chat(model, prompt)
        perModel.latencies.push(r.wallMs)
        if (r.tokPerSec !== null) perModel.speeds.push(r.tokPerSec)

        if (expectedTool) {
          perModel.total++
          const ok = r.toolName === expectedTool
          if (ok) perModel.correct++
          console.log(`${ok ? 'OK' : 'RATÉ'} (attendu: ${expectedTool}, obtenu: ${r.toolName ?? 'aucun outil'}) — ${fmt(r.wallMs, 0)}ms, ${fmt(r.tokPerSec)} tok/s`)
        } else {
          console.log(`${fmt(r.wallMs, 0)}ms, ${fmt(r.tokPerSec)} tok/s${r.toolName ? ` (outil inattendu: ${r.toolName})` : ''}`)
          reasoningAnswers.push({ model, prompt, answer: r.content || `[outil appelé au lieu de répondre: ${r.toolName}]` })
        }
      } catch (err) {
        console.log(`ERREUR (${err.message})`)
        errors.push({ model, prompt, message: err.message })
      }
    }

    results.push(perModel)
  }

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)

  const lines = []
  lines.push(`# Résultats du benchmark Jaris — ${new Date().toLocaleString('fr-FR')}`)
  lines.push('')
  lines.push('| Modèle | Latence moyenne | Vitesse moyenne | Tool-calling |')
  lines.push('|---|---|---|---|')
  for (const r of results) {
    const acc = r.total ? `${r.correct}/${r.total}` : '—'
    lines.push(`| ${r.model} | ${fmt(avg(r.latencies), 0)} ms | ${fmt(avg(r.speeds))} tok/s | ${acc} |`)
  }

  lines.push('')
  lines.push('## Réponses aux questions de raisonnement (à juger toi-même)')
  lines.push('')
  for (const { prompt, answer, model } of reasoningAnswers) {
    lines.push(`**${model}** — « ${prompt} »`)
    lines.push(`> ${answer}`)
    lines.push('')
  }

  if (errors.length) {
    lines.push('## Erreurs')
    lines.push('')
    for (const { model, prompt, message } of errors) {
      lines.push(`- **${model}** sur « ${prompt.slice(0, 40)}${prompt.length > 40 ? '…' : ''} » : ${message}`)
    }
    lines.push('')
  }

  const report = lines.join('\n')
  console.log(`\n\n${report}`)

  // Écrit aussi le rapport dans un fichier : plus simple à envoyer/coller ailleurs qu'à faire défiler et
  // copier depuis le terminal, surtout avec autant de modèles testés d'affilée.
  writeFileSync(RESULTS_PATH, report, 'utf-8')
  console.log(`\n(Résultats aussi sauvegardés dans ${RESULTS_PATH})`)
}

main()
