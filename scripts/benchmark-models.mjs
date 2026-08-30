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

import { exec } from 'child_process'
import { writeFileSync } from 'fs'
import { totalmem } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { promisify } from 'util'
import { deflateSync } from 'zlib'

const execAsync = promisify(exec)
const __dirname = dirname(fileURLToPath(import.meta.url))
const RESULTS_PATH = join(__dirname, 'benchmark-results.md')

const OLLAMA_HOST = process.env.OLLAMA_HOST?.trim() || 'http://127.0.0.1:11434'

/**
 * Petite marge sous la VRAM totale détectée, pour le contexte (num_ctx, 4096 par défaut) et l'overhead
 * OS/pilote pendant le test — contrairement à STT_RESERVED_GB côté app (electron/services/hardwareScan.ts),
 * pas besoin de réserver de la place pour le STT ici : ce script tourne seul, sans le pipeline vocal.
 */
const VRAM_SAFETY_MARGIN_GB = 1

/**
 * Marge sous la RAM totale de la machine, réservée à l'OS et aux autres logiciels ouverts — jamais
 * disponible en entier pour un seul modèle, contrairement à ce qu'un simple `os.totalmem()` suggérerait.
 */
const RAM_SAFETY_MARGIN_GB = 8

/**
 * Modèles dont le filtre de taille ci-dessous vérifie VRAM + RAM combinées, pas la VRAM seule : contrairement
 * aux autres candidats (pensés pour tenir entièrement en VRAM, condition d'un usage voix/chat temps réel),
 * ceux-ci sont conçus pour déborder sur la RAM système (voir CODE_CANDIDATES dans hardwareScan.ts et
 * codeGenerator.ts). Les juger sur la VRAM seule les bloquerait à tort sur une machine avec beaucoup de RAM
 * mais peu de VRAM (le cas de Léo : 8 Go de VRAM, 64 Go de RAM) — mais ils doivent quand même être bloqués
 * sur une machine qui n'a NI la VRAM NI la RAM pour les faire tourner (ex: 12 Go de RAM et pas de GPU
 * dédié) : sans ce filtre, ce script tenterait de télécharger des dizaines de Go pour un modèle qui ne
 * tournerait de toute façon jamais correctement.
 */
const RAM_OFFLOAD_MODELS = new Set(['qwen3.6:35b-a3b', 'north-mini-code-1.0', 'qwen2.5-coder:32b'])

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
  // granite4.1:3b (remplace granite4:3b, retiré de MEDIUM_CANDIDATES dans hardwareScan.ts) : post-training
  // amélioré par IBM, même empreinte VRAM (~2,1 Go). Source : ollama.com/library/granite4.1, blog IBM Research.
  'granite4.1:3b',
  'nemotron-3-nano:4b',
  'ministral-3:3b',
  // Pas de tag officiel dans la bibliothèque Ollama pour ce 1.2B (seule la variante 8B-MoE y est) : import
  // direct depuis le dépôt Hugging Face officiel de LiquidAI, `ollama pull` fonctionne pareil avec ce préfixe.
  'hf.co/LiquidAI/LFM2.5-1.2B-Instruct-GGUF',
  'qwen3:1.7b',
  'granite4:1b',
  // Repli ultime de tous les paliers dans hardwareScan.ts (FLASH/MEDIUM/LARGE_CANDIDATES) : manquait ici
  // par oubli, alors qu'il tient sur n'importe quelle config et est un vrai candidat pour du matériel
  // très contraint (pas de GPU, ou VRAM minuscule).
  'qwen3.5:0.8b',
  // Fait exclusivement pour le tool calling (pas pour la conversation générale) : ses réponses aux 2
  // questions de raisonnement du test n'ont pas vraiment de sens, mais intéressant sur les 6 tests d'outils.
  'functiongemma:270m',
  // Pas de tag officiel dans la bibliothèque Ollama : import direct depuis le dépôt Hugging Face officiel
  // d'OpenBMB (créateur du modèle) plutôt qu'une requantification tierce. Un seul checkpoint sert à la
  // fois de réponse rapide ("No-Think") et de réflexion approfondie ("Think") selon le chat template —
  // pensé explicitement pour assistants locaux / agents de code / appel d'outils, comme Jaris.
  'hf.co/openbmb/MiniCPM5-1B-GGUF',
  // Pas de tag officiel non plus : import depuis la requantification GGUF de bartowski (quantifieur
  // reconnu et fiable dans la communauté Ollama/llama.cpp), à partir du dépôt officiel ai9stars/G9v3-3B.
  'hf.co/bartowski/ai9stars_G9v3-3B-GGUF',
  // Ignorés jusqu'ici car trop gros pour la machine de dev (RTX 3070, 8 Go) : maintenant que le script
  // détecte la VRAM disponible et saute automatiquement ce qui ne rentre pas (voir detectVramGb ci-dessous),
  // les garder dans la liste permet aux utilisateurs avec plus de VRAM de vraiment les tester chez eux —
  // mêmes tailles que LARGE_CANDIDATES dans electron/services/hardwareScan.ts.
  'qwen3.5:35b',
  'qwen3.5:27b',
  // Palier "Code" (CODE_CANDIDATES dans hardwareScan.ts) : spécialiste complétion/génération de code
  // (FIM), pas un modèle conversationnel — ses réponses aux 2 questions de raisonnement n'auront
  // probablement pas de sens, mais les 6 tests d'appel d'outils restent pertinents pour juger s'il peut
  // suivre les instructions de Jaris, pas seulement écrire du code isolé.
  'qwen2.5-coder:7b',
  // Second modèle du palier "Code" : 35 Md de paramètres au total (3 Md actifs, architecture MoE), tourne
  // surtout via la RAM système (plus lent, mais bien plus capable en code) — voir RAM_OFFLOAD_MODELS
  // ci-dessus, jugé sur VRAM + RAM combinées plutôt que sur la VRAM seule.
  'qwen3.6:35b-a3b',
  // Troisième candidat du palier "Code" (Cohere) : spécialiste code agentique, MoE (128 experts, ~3 Md
  // actifs) donc dans RAM_OFFLOAD_MODELS comme qwen3.6:35b-a3b ci-dessus — 19 Go mais rapide malgré tout
  // grâce au MoE. Pas encore utilisé par défaut dans codeGenerator.ts (voir CODE_CANDIDATES dans
  // hardwareScan.ts) : ce run permettra de le comparer objectivement à qwen3.6:35b-a3b avant de décider.
  'north-mini-code-1.0',
  // Quatrième candidat du palier "Code" : plus gros frère de qwen2.5-coder:7b, mais DENSE (contrairement à
  // qwen3.6:35b-a3b et north-mini-code-1.0 ci-dessus, tous deux MoE) — dans RAM_OFFLOAD_MODELS pour ne pas
  // être ignoré sur cette carte, mais un débordement sur la RAM ralentira un dense bien plus fort qu'un MoE
  // de taille comparable (comparer sa vitesse mesurée à celle de north-mini-code-1.0 le confirmera ou non).
  'qwen2.5-coder:32b'
]

// Candidats du palier Vision (VISION_CANDIDATES dans hardwareScan.ts, dupliqué ici pour la même raison que
// detectVramGb ci-dessous : ce script tourne en `node` simple, pas d'import direct possible depuis le TS
// bundlé). Testés séparément de MODELS ci-dessus : la question n'est pas "suit-il les instructions de
// Jaris" (tool-calling) mais "comprend-il vraiment ce qu'il voit" (voir VISION_TEST_CASES plus bas).
const VISION_CANDIDATES = [
  { model: 'qwen3-vl:8b', vramGb: 8 },
  { model: 'hf.co/ggml-org/GLM-4.6V-Flash-GGUF:Q4_K_M', vramGb: 6.5 },
  { model: 'qwen3-vl:4b', vramGb: 5 },
  { model: 'qwen3-vl:2b', vramGb: 3 }
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

/**
 * Encodeur PNG minimal (RGB 8 bits, sans dépendance externe — juste zlib, déjà dans Node) pour générer les
 * images de test de VISION_TEST_CASES ci-dessous à la volée, plutôt que de committer des fichiers image
 * binaires dans le dépôt. Suffisant pour des aplats de couleur simples, pas un encodeur PNG complet.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf])
}

/** `fillFn(x, y) -> [r, g, b]` pour chaque pixel — assez pour des aplats/zones de couleur, pas besoin de plus. */
function makePngBase64(width, height, fillFn) {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // type de filtre "aucun" pour cette ligne
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fillFn(x, y)
      const i = y * (stride + 1) + 1 + x * 3
      raw[i] = r
      raw[i + 1] = g
      raw[i + 2] = b
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // profondeur 8 bits
  ihdr[9] = 2 // type de couleur : RGB
  // ihdr[10..12] (compression/filtre/entrelacement) restent à 0, valeurs standard PNG.

  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0))
  ])
  return png.toString('base64')
}

// Rouge/vert/bleu francs, faciles à nommer sans ambiguïté (pas de teintes intermédiaires prêtant à
// interprétation) — le but est de vérifier que le modèle voit VRAIMENT l'image, pas de tester sa culture
// des nuanciers.
const RED = [214, 40, 40]
const GREEN = [40, 180, 74]
const BLUE = [42, 92, 214]

/**
 * Test du palier Vision (VISION_CANDIDATES ci-dessus) : au lieu du tool-calling testé pour les modèles de
 * conversation (TEST_CASES), la question qui compte pour la vision est "le modèle voit-il vraiment
 * l'image ?" — des questions à réponse unique et objectivement vérifiable (couleur, comptage), pas un
 * jugement de description ouverte qu'il faudrait noter à la main. `check` reçoit la réponse en minuscules.
 */
const VISION_TEST_CASES = [
  {
    image: () => makePngBase64(96, 96, () => BLUE),
    prompt: 'Quelle est la couleur dominante de cette image ? Réponds uniquement avec le nom de la couleur, en un seul mot.',
    check: (answer) => /\bbleu(e)?\b|\bblue\b/.test(answer)
  },
  {
    image: () => makePngBase64(128, 64, (x) => (x < 64 ? RED : GREEN)),
    prompt: 'Le côté GAUCHE de cette image est-il plutôt rouge ou plutôt vert ? Réponds en un seul mot.',
    check: (answer) => /\brouge\b|\bred\b/.test(answer) && !/\bvert(e)?\b|\bgreen\b/.test(answer)
  },
  {
    image: () =>
      makePngBase64(160, 160, (x, y) => {
        const squares = [
          [20, 20],
          [90, 30],
          [50, 110]
        ]
        const inSquare = squares.some(([sx, sy]) => x >= sx && x < sx + 20 && y >= sy && y < sy + 20)
        return inSquare ? [20, 20, 20] : [245, 245, 245]
      }),
    prompt: 'Combien de carrés noirs vois-tu dans cette image ? Réponds uniquement avec le chiffre.',
    check: (answer) => /\b3\b|\btrois\b/.test(answer)
  }
]

async function listInstalledModels() {
  const res = await fetch(`${OLLAMA_HOST}/api/tags`)
  if (!res.ok) throw new Error(`Ollama a répondu ${res.status} (est-il lancé sur ${OLLAMA_HOST} ?)`)
  const data = await res.json()
  return (data.models ?? []).map((m) => m.name)
}

/**
 * VRAM totale de la carte NVIDIA détectée (Go), même requête que detectGpu() dans
 * electron/services/hardwareScan.ts — dupliquée ici volontairement : ce script tourne en `node` simple, pas
 * via le bundler Electron/TS, donc pas d'import direct possible entre les deux. `null` sans GPU NVIDIA
 * détecté (ou en cas d'erreur, ou carte AMD/Intel — non détectées par cette commande) : main() retombe
 * alors sur un budget basé sur la RAM seule, jamais sur "aucune limite".
 */
async function detectVramGb() {
  try {
    const { stdout } = await execAsync('nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits', { windowsHide: true })
    const mib = parseInt(stdout.trim().split('\n')[0], 10)
    return Number.isFinite(mib) ? mib / 1024 : null
  } catch {
    return null
  }
}

/** RAM totale de la machine (Go) : contrairement à la VRAM, Node sait la lire directement, sans commande externe. */
function detectRamGb() {
  return totalmem() / 1024 ** 3
}

class ModelTooLargeError extends Error {
  constructor(model, requiredGb, budgetGb) {
    super(`nécessite ~${requiredGb.toFixed(1)} Go, au-delà des ${budgetGb.toFixed(1)} Go disponibles sur cette carte`)
    this.name = 'ModelTooLargeError'
    this.model = model
  }
}

/**
 * Télécharge `model` via Ollama, avec une progression affichée par tranche de 10% (pas à chaque %, sinon
 * ~100 lignes par modèle) : lisible aussi bien dans un vrai terminal que dans le journal en direct de
 * l'onglet Modèles de Jaris (qui découpe la sortie ligne par ligne, un `\r` ne s'y afficherait pas pareil).
 *
 * `budgetGb` est toujours un nombre concret (jamais de valeur "illimité", voir main()) : dès que le
 * manifeste Ollama révèle la taille réelle du modèle (`progress.total`, en octets, disponible avant la fin
 * du téléchargement), on annule le téléchargement tout de suite si ça dépasse le budget — pas la peine de
 * télécharger plusieurs Go pour un modèle qui ne rentrera de toute façon jamais sur cette machine.
 */
async function pullModel(model, budgetGb) {
  console.log(`Téléchargement de ${model}…`)
  const controller = new AbortController()
  const res = await fetch(`${OLLAMA_HOST}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model, stream: true }),
    signal: controller.signal
  })
  if (!res.ok || !res.body) throw new Error(`${res.status} ${await res.text()}`)

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let lastBucket = -1
  let sizeChecked = false

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

      if (!sizeChecked && progress.total) {
        sizeChecked = true
        const requiredGb = progress.total / 1024 ** 3
        if (requiredGb > budgetGb) {
          controller.abort()
          throw new ModelTooLargeError(model, requiredGb, budgetGb)
        }
      }

      if (progress.total && progress.completed !== undefined) {
        const bucket = Math.floor((progress.completed / progress.total) * 10) * 10
        if (bucket !== lastBucket) {
          lastBucket = bucket
          console.log(`  ${model} : ${bucket}%`)
          // Progression FINE du modèle en cours de téléchargement (pas juste "N modèles sur M") : sans ça,
          // un seul gros modèle (qwen3.6:35b-a3b, north-mini-code-1.0...) fait stagner la barre de
          // progression pendant plusieurs minutes d'affilée, sans aucun retour visuel entre-temps.
          console.log(`##PULL_MODEL_PROGRESS## ${bucket}`)
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

/**
 * Même appel que lookAtScreen (electron/services/vision.ts) : pas d'outils, `think: false` toujours (les
 * modèles vision ne le supportent pas forcément, et la production ne l'utilise jamais ici) — pour que ce
 * test mesure le comportement réel de Jaris, pas un usage générique de l'API vision.
 */
async function chatVision(model, prompt, imageBase64) {
  const start = performance.now()
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt, images: [imageBase64] }],
      stream: false,
      think: false
    })
  })
  const wallMs = performance.now() - start
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`)
  const data = await res.json()
  const evalCount = data.eval_count ?? 0
  const evalDurationS = (data.eval_duration ?? 0) / 1e9
  return {
    wallMs,
    tokPerSec: evalDurationS > 0 ? evalCount / evalDurationS : null,
    content: data.message?.content?.trim() ?? ''
  }
}

function fmt(n, digits = 1) {
  return n === null || n === undefined || Number.isNaN(n) ? '—' : n.toFixed(digits)
}

async function main() {
  console.log(`Ollama : ${OLLAMA_HOST}\n`)

  // budgetGb n'est JAMAIS null/illimité, quelle que soit la machine : detectVramGb() ne détecte que les
  // cartes NVIDIA (nvidia-smi) — une machine sans NVIDIA (carte AMD/Intel, GPU intégré, portable sans GPU
  // dédié) est donc TOUJOURS vramGb === null ici. Sans repli, ça désactivait purement et simplement le
  // filtre de taille pour tout le monde dans ce cas — un modèle de 24+ Go aurait été téléchargé en entier
  // sans aucune vérification. Le repli sur la RAM seule couvre ce cas : au pire (vraiment aucun GPU), le
  // modèle tournera de toute façon sur CPU/RAM, donc c'est la bonne limite à vérifier.
  const vramGb = await detectVramGb()
  const ramGb = detectRamGb()
  // Marge différente selon le cas : VRAM_SAFETY_MARGIN_GB (1 Go) suffit pour du contexte/overhead pilote
  // sur une vraie carte GPU, mais le repli "pas de GPU, tout sur RAM/CPU" doit réserver bien plus pour l'OS
  // et les autres logiciels — RAM_SAFETY_MARGIN_GB (8 Go), la même marge que pour RAM_OFFLOAD_MODELS.
  const vramBudgetGb =
    vramGb !== null ? Math.max(0, vramGb - VRAM_SAFETY_MARGIN_GB) : Math.max(0, ramGb - RAM_SAFETY_MARGIN_GB)
  console.log(
    vramGb !== null
      ? `VRAM détectée : ${vramGb.toFixed(1)} Go (budget de test : ${vramBudgetGb.toFixed(1)} Go, marge de ${VRAM_SAFETY_MARGIN_GB} Go pour le contexte/l'OS) — les modèles trop gros pour cette carte seront sautés automatiquement.\n`
      : `Pas de carte NVIDIA détectée : repli sur la RAM seule comme budget (${ramGb.toFixed(1)} Go détectés, ` +
        `budget de test : ${vramBudgetGb.toFixed(1)} Go) — les modèles trop gros seront sautés automatiquement.\n`
  )

  // Budget pour RAM_OFFLOAD_MODELS : VRAM + RAM combinées (pas juste l'une ou l'autre), puisque ces modèles
  // sont conçus pour tourner à cheval sur les deux — mais toujours borné, pour ne pas télécharger des
  // dizaines de Go sur une machine qui n'a de toute façon ni la VRAM ni la RAM pour les faire tourner.
  const ramOffloadBudgetGb = Math.max(0, (vramGb ?? 0) + ramGb - RAM_SAFETY_MARGIN_GB)
  console.log(
    `RAM détectée : ${ramGb.toFixed(1)} Go — budget combiné VRAM+RAM pour les modèles conçus pour déborder ` +
      `sur la RAM (RAM_OFFLOAD_MODELS) : ${ramOffloadBudgetGb.toFixed(1)} Go.\n`
  )

  let installed
  try {
    installed = await listInstalledModels()
  } catch (err) {
    console.error(`Impossible de joindre Ollama : ${err.message}`)
    process.exit(1)
  }

  // MODELS (conversation/code) et VISION_CANDIDATES installés dans la même passe : la barre de progression
  // (OptionsMenu.tsx) n'a pas besoin de les distinguer, seulement combien reste à installer au total.
  const allInstallable = [...MODELS, ...VISION_CANDIDATES.map((c) => c.model)]
  const missing = allInstallable.filter((m) => !installed.includes(m))
  if (missing.length) {
    console.log(`${missing.length} modèle(s) manquant(s) à installer avant le test :\n`)
    let pullsDone = 0
    for (const model of missing) {
      // Repart de 0 pour ce nouveau modèle : sans ça, la barre de progression (OptionsMenu.tsx) garderait
      // affiché le dernier pourcentage du modèle précédent pendant tout le début du téléchargement suivant.
      console.log('##PULL_MODEL_PROGRESS## 0')
      try {
        await pullModel(model, RAM_OFFLOAD_MODELS.has(model) ? ramOffloadBudgetGb : vramBudgetGb)
      } catch (err) {
        if (err instanceof ModelTooLargeError) {
          console.log(`  ${model} ignoré : ${err.message}`)
        } else {
          console.log(`  Échec de l'installation de ${model} : ${err.message} (ignoré pour ce run)`)
        }
      }
      pullsDone++
      // Lu par l'onglet Modèles de Jaris pour afficher une barre de progression (voir OptionsMenu.tsx) :
      // format volontairement machine-friendly, jamais affiché tel quel dans le journal visible.
      console.log(`##PULL_PROGRESS## ${pullsDone} ${missing.length}`)
    }
    installed = await listInstalledModels()
    console.log('')
  }

  const toRun = MODELS.filter((m) => installed.includes(m))
  const visionToRun = VISION_CANDIDATES.map((c) => c.model).filter((m) => installed.includes(m))
  if (!toRun.length && !visionToRun.length) {
    console.log('Aucun des modèles à tester n\'a pu être installé.')
    return
  }

  const results = []
  const reasoningAnswers = []
  const errors = []
  let testsDone = 0
  const testsTotal = toRun.length * TEST_CASES.length + visionToRun.length * VISION_TEST_CASES.length

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
      testsDone++
      console.log(`##TEST_PROGRESS## ${testsDone} ${testsTotal}`)
    }

    results.push(perModel)
  }

  // Modèles Vision : les images de VISION_TEST_CASES sont générées une seule fois ici (pas à chaque appel
  // modèle), le PNG encodé ne dépend que du test, pas du modèle qui le reçoit.
  const visionImages = VISION_TEST_CASES.map((c) => c.image())

  for (const model of visionToRun) {
    console.log(`\n=== ${model} (vision) ===`)
    const perModel = { model, latencies: [], speeds: [], correct: 0, total: 0 }

    for (let i = 0; i < VISION_TEST_CASES.length; i++) {
      const { prompt, check } = VISION_TEST_CASES[i]
      process.stdout.write(`  "${prompt.slice(0, 40)}${prompt.length > 40 ? '…' : ''}" ... `)
      try {
        const r = await chatVision(model, prompt, visionImages[i])
        perModel.latencies.push(r.wallMs)
        if (r.tokPerSec !== null) perModel.speeds.push(r.tokPerSec)
        perModel.total++
        const ok = check(r.content.toLowerCase())
        if (ok) perModel.correct++
        console.log(`${ok ? 'OK' : 'RATÉ'} (réponse: "${r.content.slice(0, 60)}") — ${fmt(r.wallMs, 0)}ms, ${fmt(r.tokPerSec)} tok/s`)
      } catch (err) {
        console.log(`ERREUR (${err.message})`)
        errors.push({ model, prompt, message: err.message })
      }
      testsDone++
      console.log(`##TEST_PROGRESS## ${testsDone} ${testsTotal}`)
    }

    results.push(perModel)
  }

  const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)

  const lines = []
  lines.push(`# Résultats du benchmark Jaris — ${new Date().toLocaleString('fr-FR')}`)
  lines.push('')
  // "Fiabilité" plutôt que "Tool-calling" : ce tableau mélange les modèles de conversation/code (testés sur
  // l'appel d'outils, TEST_CASES) et les modèles vision (testés sur la compréhension d'image,
  // VISION_TEST_CASES) — la colonne représente le score "X/Y" dans les deux cas, mais pas la même épreuve.
  lines.push('| Modèle | Latence moyenne | Vitesse moyenne | Fiabilité (tool-calling ou vision selon le modèle) |')
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
