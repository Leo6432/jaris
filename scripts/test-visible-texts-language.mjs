import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'
import { loadTsModule } from './load-ts-module.mjs'
import { I18N_MODULES, i18nModule } from './i18n-test-module.mjs'

/**
 * Des textes visibles qui restaient en français (ou à la française) quelle que soit la langue de Jaris, trouvés en
 * passant en revue tout ce qui s'affiche après la version 0.34.31 :
 * - la durée d'une vidéo (« 2 s ») était écrite en dur, alors que le reste de Jaris écrit « 2 с » en russe ou
 *   « 2 mp » en hongrois (clé duration.seconds) ;
 * - l'extinction refusée par Windows, affichée telle quelle sur le téléphone, finissait par « (code 1). » en français ;
 * - un modèle Hugging Face qu'Ollama ET l'import direct n'arrivent pas à télécharger : la fin du message
 *   (« ; import direct aussi impossible : … ») restait en français dans le journal de la configuration.
 */
const projectRoot = fileURLToPath(new URL('..', import.meta.url))
const catalog = (code) => JSON.parse(readFileSync(join(projectRoot, `shared/i18n/locales/${code}.json`), 'utf8'))

async function inLanguage(code, run) {
  i18nModule.setLanguage(code, code === 'fr' ? undefined : catalog(code))
  try {
    return await run()
  } finally {
    i18nModule.setLanguage('fr')
  }
}

/**
 * Le VRAI VideoDurationPicker, sans navigateur : JSX compilé vers un faux `jsx` qui renvoie { type, props }, donc
 * l'appel au composant donne directement les propriétés passées à SliderPicker (libellé du bouton, bornes de la barre).
 */
function loadDurationPicker() {
  const source = ts.transpileModule(readFileSync(join(projectRoot, 'src/components/VideoDurationPicker.tsx'), 'utf8'), {
    fileName: 'VideoDurationPicker.tsx',
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText
  const element = (type, props) => ({ type, props })
  const modules = {
    'react/jsx-runtime': { jsx: element, jsxs: element, Fragment: 'fragment' },
    './SliderPicker': { default: function SliderPicker() {} },
    '@/lib/i18n': I18N_MODULES['../../shared/i18n'],
    '../../shared/videoModel': loadTsModule('shared/videoModel.ts')
  }
  const module = { exports: {} }
  vm.runInThisContext(`(function (exports, require, module) {${source}\n})`)(
    module.exports,
    (name) => {
      if (name in modules) return modules[name]
      throw new Error(`Import non fourni au test : ${name}`)
    },
    module
  )
  return module.exports.default
}

const VideoDurationPicker = loadDurationPicker()
const durationProps = () => VideoDurationPicker({ value: 2, onChange: () => {} }).props

test('durée d’une vidéo : « 2 s » en français, l’unité de la langue ailleurs (« 2 с », « 2 mp »)', async () => {
  const fr = await inLanguage('fr', durationProps)
  assert.equal(fr.triggerLabel, '2 s')
  assert.deepEqual([...fr.scale], ['1 s', '5 s'])
  for (const code of ['ru', 'hu', 'el']) {
    const expected = (s) => catalog(code)['duration.seconds'].replace('{s}', String(s))
    const props = await inLanguage(code, durationProps)
    assert.equal(props.triggerLabel, expected(2), code)
    assert.deepEqual([...props.scale], [expected(1), expected(5)], code)
    assert.notEqual(props.triggerLabel, '2 s', `${code} : plus de « s » français écrit en dur`)
  }
})

function loadSystemControl(exitCode) {
  const fakeChildProcess = {
    spawn() {
      const proc = new EventEmitter()
      setImmediate(() => proc.emit('close', exitCode))
      return proc
    }
  }
  return loadTsModule('electron/services/systemControl.ts', {
    child_process: fakeChildProcess,
    './resourceMonitor': { getSystemLoad: async () => ({ cpuPct: 0, ramPct: 0 }) },
    './hardwareScan': { getLiveGpuStatus: async () => ({ freeVramGb: null, tempC: null }) }
  })
}

test('extinction refusée par Windows : le message affiché sur le téléphone est entièrement dans la langue', async () => {
  const { scheduleShutdown } = loadSystemControl(1)
  const message = async (code) => inLanguage(code, () => scheduleShutdown(60).then(() => null, (err) => err.message))
  assert.equal(await message('fr'), "Windows n'a pas accepté l'extinction (code 1).")
  assert.equal(await message('en'), `${catalog('en')['shutdown.refused']} (code 1).`)
  assert.equal(await message('de'), `${catalog('de')['shutdown.refused']} (Code 1).`)
  assert.equal(await message('ru'), `${catalog('ru')['shutdown.refused']} (код 1).`)
})

/** pullModelIfMissing avec un faux Ollama qui refuse le téléchargement, et un import direct qui échoue aussi. */
async function hfDoubleFailure() {
  const { pullModelIfMissing } = loadTsModule('electron/services/ollama.ts', {
    '../config': { config: { ollama: { host: 'http://ollama', model: 'm', numCtx: 8192 } } },
    '../../shared/effort': { parseModelThinking: () => null },
    './systemResources': { DISK_SAFETY_MARGIN_GB: 5, detectFreeDiskGb: () => 100, getDownloadBudgetGb: async () => 100 },
    './huggingFaceImport': {
      importHuggingFaceModel: async () => {
        throw new Error('HF 503')
      }
    }
  })
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/tags')) return { ok: true, status: 200, json: async () => ({ models: [{ name: 'autre:1b' }] }) }
    if (String(url).endsWith('/api/pull')) {
      const body = new TextEncoder().encode('{"error":"blocked redirect"}\n')
      let sent = false
      return { ok: true, status: 200, body: { getReader: () => ({ read: async () => (sent ? { done: true } : ((sent = true), { done: false, value: body })) }) } }
    }
    throw new Error(`appel inattendu : ${url}`)
  }
  try {
    return await pullModelIfMissing('hf.co/org/modele-GGUF:Q4_K_M').then(() => null, (err) => err.message)
  } finally {
    globalThis.fetch = previousFetch
  }
}

test('modèle Hugging Face impossible à télécharger par les deux voies : message entièrement dans la langue', async () => {
  const en = await inLanguage('en', hfDoubleFailure)
  assert.ok(en, 'le téléchargement doit échouer')
  assert.match(en, /blocked redirect/, 'l’erreur d’origine d’Ollama reste en tête')
  assert.match(en, /HF 503$/, 'la raison du second échec suit')
  assert.ok(en.includes('; fetching it directly from Hugging Face failed too: '), en)
  assert.doesNotMatch(en, /aussi|impossible|import direct/, en)
  const fr = await inLanguage('fr', hfDoubleFailure)
  assert.ok(fr.includes(' ; la récupération directe depuis Hugging Face a échoué aussi : HF 503'), fr)
})
