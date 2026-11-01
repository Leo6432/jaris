/**
 * Blocs interactifs des réponses du Chat (Léo : « sur ChatGPT ils ont ajouté l'UI, on peut faire pareil », choix
 * « blocs tout prêts »). Le modèle n'écrit jamais d'interface : il remplit un petit objet JSON dans un bloc
 * ```jaris-ui, et Jaris le dessine avec SES composants. Un petit modèle local sait remplir un objet ; il casse
 * souvent une vraie page HTML (mode Code).
 *
 * Ce module est PUR (aucun React, aucun Electron) : lecture, vérification et version texte du bloc. Tout ce qui
 * vient du modèle est vérifié ici, borné en taille, et ramené à des chaînes et des nombres : rien n'est jamais
 * interprété comme du HTML ni exécuté (le calculateur a son propre petit lecteur de formules, sans eval).
 */

import { currentLocale, t } from './i18n'

export const UI_FENCE_LANGUAGE = 'jaris-ui'

export interface UiTable {
  type: 'table'
  title?: string
  columns: string[]
  rows: string[][]
}
export interface UiChart {
  type: 'chart'
  title?: string
  kind: 'bar' | 'line'
  unit?: string
  labels: string[]
  values: number[]
}
export interface UiSteps {
  type: 'steps'
  title?: string
  items: string[]
}
export interface UiChecklist {
  type: 'checklist'
  title?: string
  items: string[]
}
export interface UiChoices {
  type: 'choices'
  title?: string
  options: string[]
}
export interface UiCalculatorInput {
  name: string
  label: string
  value: number
  unit?: string
}
export interface UiCalculatorOutput {
  label: string
  formula: string
  unit?: string
}
export interface UiCalculator {
  type: 'calculator'
  title?: string
  inputs: UiCalculatorInput[]
  outputs: UiCalculatorOutput[]
}
/** Étape 404 : plusieurs choses présentées chacune en quelques phrases (pays, options, solutions…). */
export interface UiCards {
  type: 'cards'
  title?: string
  items: { title: string; text: string; tag?: string }[]
}
/** Étape 404 : montants ou parts comparés en barres, avec un gros chiffre de tête facultatif. */
export interface UiBars {
  type: 'bars'
  title?: string
  headline?: string
  subtitle?: string
  note?: string
  items: { label: string; value: number; text: string; highlight: boolean }[]
}
export type UiTone = 'good' | 'warn' | 'bad' | 'neutral'
/** Étape 404 : quelques chiffres clés, chacun avec un niveau (calme, chargé…) dit par sa couleur ET par un mot. */
export interface UiStats {
  type: 'stats'
  title?: string
  note?: string
  items: { label: string; value: string; tag?: string; tone: UiTone; detail?: string }[]
}
/** Étape 404 : plusieurs questions à choix, envoyées ensemble par un seul bouton (comme ChatGPT). */
export interface UiForm {
  type: 'form'
  title?: string
  submit?: string
  questions: { question: string; options: string[] }[]
}
export type UiBlock = UiTable | UiChart | UiSteps | UiChecklist | UiChoices | UiCalculator | UiCards | UiBars | UiStats | UiForm

const MAX_TEXT = 300
const MAX_ROWS = 50
const MAX_COLUMNS = 8
const MAX_POINTS = 40
const MAX_ITEMS = 30
const MAX_OPTIONS = 6
const MAX_INPUTS = 8
const MAX_OUTPUTS = 4
const MAX_CARDS = 8
const MAX_BARS = 12
const MAX_STATS = 8
const MAX_QUESTIONS = 5
const TONES: UiTone[] = ['good', 'warn', 'bad', 'neutral']

function records(value: unknown, max: number): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry)).slice(0, max)
}

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim().slice(0, MAX_TEXT)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function optionalText(value: unknown): string | undefined {
  const result = text(value)
  return result || undefined
}

/** Un nombre, y compris écrit en texte (« 12,5 », « 1 200 », « 30 % ») : les modèles le font souvent. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string') return null
  const cleaned = value.replace(/[\s  ]/g, '').replace(/[%€$£]/g, '').replace(',', '.')
  if (!/^-?\d+(?:\.\d+)?$/.test(cleaned)) return null
  const number = Number(cleaned)
  return Number.isFinite(number) ? number : null
}

function textList(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  return value.map(text).filter(Boolean).slice(0, max)
}

/**
 * JSON tel que l'écrivent les petits modèles : virgule en trop avant « } » ou « ] », retours à la ligne bruts
 * dans une chaîne. Rien d'autre n'est deviné. `undefined` si illisible.
 */
export function parseLenientJson(source: string): unknown {
  try {
    return JSON.parse(source)
  } catch {
    // Seconde chance ci-dessous.
  }
  let out = ''
  let inString = false
  let escaped = false
  for (const char of source) {
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      else if (char === '\n') {
        out += '\\n'
        continue
      } else if (char === '\r') continue
      else if (char === '\t') {
        out += '\\t'
        continue
      }
    } else if (char === '"') inString = true
    out += char
  }
  // Virgules en trop, hors chaînes : on ne retire une virgule que si elle est suivie (blancs mis à part) de } ou ].
  let cleaned = ''
  inString = false
  escaped = false
  for (let index = 0; index < out.length; index++) {
    const char = out[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
    } else if (char === '"') inString = true
    else if (char === ',') {
      let next = index + 1
      while (next < out.length && /\s/.test(out[next])) next++
      if (out[next] === '}' || out[next] === ']') continue
    }
    cleaned += char
  }
  try {
    return JSON.parse(cleaned)
  } catch {
    return undefined
  }
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,30}$/

/** Lit et vérifie le contenu d'un bloc ```jaris-ui. `null` s'il est illisible ou inutilisable. */
export function parseUiBlock(source: string): UiBlock | null {
  const raw = parseLenientJson(source.trim())
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const data = raw as Record<string, unknown>
  const title = optionalText(data.title)
  switch (data.type) {
    case 'table': {
      // Vu chez Léo : des modèles écrivent `headers` au lieu de `columns`, et chaque ligne en objet
      // ({"Opérateur": "RED", …}) au lieu d'une liste — le bloc restait affiché en JSON brut.
      const rawRows = Array.isArray(data.rows) ? data.rows : Array.isArray(data.data) ? data.data : null
      const firstObject = rawRows?.find((row) => row && typeof row === 'object' && !Array.isArray(row)) as Record<string, unknown> | undefined
      const columns = textList(data.columns ?? data.headers, MAX_COLUMNS).length
        ? textList(data.columns ?? data.headers, MAX_COLUMNS)
        : firstObject
          ? Object.keys(firstObject).slice(0, MAX_COLUMNS)
          : []
      if (!columns.length || !rawRows) return null
      const rows = rawRows
        .map((row): unknown[] | null =>
          Array.isArray(row)
            ? row
            : row && typeof row === 'object'
              ? columns.map((column, index) => (row as Record<string, unknown>)[column] ?? Object.values(row as Record<string, unknown>)[index])
              : null
        )
        .filter((row): row is unknown[] => row !== null)
        .slice(0, MAX_ROWS)
        .map((row) => columns.map((_, index) => text(row[index])))
        .filter((row) => row.some(Boolean))
      return rows.length ? { type: 'table', title, columns, rows } : null
    }
    case 'chart': {
      if (!Array.isArray(data.labels) || !Array.isArray(data.values)) return null
      const labels: string[] = []
      const values: number[] = []
      const count = Math.min(data.labels.length, data.values.length, MAX_POINTS)
      for (let index = 0; index < count; index++) {
        const value = toNumber(data.values[index])
        if (value === null) continue
        labels.push(text(data.labels[index]))
        values.push(value)
      }
      if (values.length < 2) return null
      return { type: 'chart', title, kind: data.kind === 'line' ? 'line' : 'bar', unit: optionalText(data.unit), labels, values }
    }
    case 'steps':
    case 'checklist': {
      const items = textList(data.items, MAX_ITEMS)
      return items.length ? { type: data.type, title, items } : null
    }
    case 'choices': {
      const options = [...new Set(textList(data.options, MAX_OPTIONS))]
      return options.length >= 2 ? { type: 'choices', title, options } : null
    }
    case 'calculator': {
      if (!Array.isArray(data.inputs) || !Array.isArray(data.outputs)) return null
      const inputs: UiCalculatorInput[] = []
      for (const entry of data.inputs.slice(0, MAX_INPUTS)) {
        if (!entry || typeof entry !== 'object') continue
        const item = entry as Record<string, unknown>
        const name = text(item.name)
        const value = toNumber(item.value)
        if (!NAME.test(name) || value === null || inputs.some((input) => input.name === name)) continue
        inputs.push({ name, label: text(item.label) || name, value, unit: optionalText(item.unit) })
      }
      const names = new Set(inputs.map((input) => input.name))
      const outputs: UiCalculatorOutput[] = []
      for (const entry of data.outputs.slice(0, MAX_OUTPUTS)) {
        if (!entry || typeof entry !== 'object') continue
        const item = entry as Record<string, unknown>
        const formula = text(item.formula)
        // Une formule qui ne se lit pas avec les valeurs de départ ne s'affiche pas : un calculateur qui répond
        // toujours « — » serait pire que pas de calculateur.
        const start = Object.fromEntries(inputs.map((input) => [input.name, input.value]))
        if (!formula || evaluateFormula(formula, start, names) === null) continue
        outputs.push({ label: text(item.label) || formula, formula, unit: optionalText(item.unit) })
      }
      return inputs.length && outputs.length ? { type: 'calculator', title, inputs, outputs } : null
    }
    case 'cards': {
      const items = records(data.items, MAX_CARDS)
        .map((item) => ({ title: text(item.title), text: text(item.text), tag: optionalText(item.tag) }))
        .filter((item) => item.title || item.text)
      return items.length ? { type: 'cards', title, items } : null
    }
    case 'bars': {
      const items = records(data.items, MAX_BARS)
        .map((item) => {
          const value = toNumber(item.value)
          return value === null
            ? null
            : { label: text(item.label), value, text: text(item.text) || formatNumber(value), highlight: item.highlight === true }
        })
        .filter((item): item is UiBars['items'][number] => item !== null && !!item.label)
      if (!items.length) return null
      return {
        type: 'bars',
        title,
        headline: optionalText(data.headline),
        subtitle: optionalText(data.subtitle),
        note: optionalText(data.note),
        items
      }
    }
    case 'stats': {
      const items = records(data.items, MAX_STATS)
        .map((item) => ({
          label: text(item.label),
          value: text(item.value),
          tag: optionalText(item.tag),
          tone: TONES.includes(item.tone as UiTone) ? (item.tone as UiTone) : 'neutral',
          detail: optionalText(item.detail)
        }))
        .filter((item) => item.value)
      return items.length ? { type: 'stats', title, note: optionalText(data.note), items } : null
    }
    case 'form': {
      const questions = records(data.questions, MAX_QUESTIONS)
        .map((item) => ({ question: text(item.question), options: [...new Set(textList(item.options, MAX_OPTIONS))] }))
        .filter((item) => item.question && item.options.length >= 2)
      return questions.length ? { type: 'form', title, submit: optionalText(data.submit), questions } : null
    }
    default:
      return null
  }
}

/**
 * Message envoyé par un bloc form (étape 404) : une ligne par question, la question suivie de la réponse choisie.
 * Une question terminée par « ? » est suivie directement de sa réponse ; sinon « question : réponse ».
 */
export function formAnswerMessage(questions: UiForm['questions'], answers: string[]): string {
  return questions
    .map((item, index) => {
      const question = item.question.replace(/[\s:]+$/, '')
      const answer = answers[index] ?? ''
      return /\?$/.test(question) ? `${question} ${answer}` : t('common.labelValue', { label: question, value: answer })
    })
    .join('\n')
}

/**
 * Lecteur de formules du calculateur : nombres, noms des champs, + - * / ^ %, parenthèses, et quelques fonctions
 * (min, max, round, floor, ceil, abs, sqrt, pow). JAMAIS eval ni Function. `null` si la formule est illisible,
 * cite un nom inconnu, ou ne donne pas un nombre fini (division par zéro…).
 */
export function evaluateFormula(formula: string, values: Record<string, number>, allowed?: Set<string>): number | null {
  const tokens = formula.match(/\d+(?:[.,]\d+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/^%(),]|\S/g)
  if (!tokens || formula.length > 300) return null
  let position = 0
  const peek = (): string | undefined => tokens[position]
  const take = (): string | undefined => tokens[position++]

  const FUNCTIONS: Record<string, (...args: number[]) => number> = {
    min: Math.min,
    max: Math.max,
    round: (value, digits = 0) => {
      const factor = 10 ** Math.max(0, Math.min(10, Math.trunc(digits)))
      return Math.round(value * factor) / factor
    },
    floor: Math.floor,
    ceil: Math.ceil,
    abs: Math.abs,
    sqrt: Math.sqrt,
    pow: Math.pow
  }

  function primary(): number {
    const token = take()
    if (token === undefined) throw new Error('fin')
    if (token === '(') {
      const value = expression()
      if (take() !== ')') throw new Error(')')
      return value
    }
    if (token === '-') return -power()
    if (token === '+') return power()
    if (/^\d/.test(token)) return Number(token.replace(',', '.'))
    if (/^[A-Za-z_]/.test(token)) {
      const fn = FUNCTIONS[token.toLowerCase()]
      if (fn && peek() === '(') {
        take()
        const args: number[] = []
        if (peek() !== ')') {
          args.push(expression())
          while (peek() === ',') {
            take()
            args.push(expression())
          }
        }
        if (take() !== ')' || !args.length || args.length > 10) throw new Error('args')
        return fn(...args)
      }
      // hasOwn, jamais `in` : « toString » ou « constructor » existent sur tout objet par héritage.
      if ((allowed && !allowed.has(token)) || !Object.prototype.hasOwnProperty.call(values, token)) throw new Error('nom')
      return values[token]
    }
    throw new Error('jeton')
  }
  function power(): number {
    const base = primary()
    if (peek() === '^') {
      take()
      return base ** power()
    }
    return base
  }
  function term(): number {
    let value = power()
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const operator = take()
      const right = power()
      value = operator === '*' ? value * right : operator === '/' ? value / right : value % right
    }
    return value
  }
  function expression(): number {
    let value = term()
    while (peek() === '+' || peek() === '-') {
      const operator = take()
      const right = term()
      value = operator === '+' ? value + right : value - right
    }
    return value
  }

  try {
    const value = expression()
    if (position !== tokens.length || !Number.isFinite(value)) return null
    return value
  } catch {
    return null
  }
}

const FENCE = /```jaris-ui[ \t]*\n?([\s\S]*?)(?:```|$)/g

/**
 * Version texte d'une réponse, pour ce qui ne sait pas dessiner les blocs (page du téléphone) : chaque bloc devient
 * des lignes ordinaires (liste, tableau aligné…), et un bloc illisible disparaît plutôt que d'afficher du JSON.
 */
export function uiBlocksToText(content: string): string {
  return content.replace(FENCE, (_, body: string) => {
    const block = parseUiBlock(body)
    if (!block) return ''
    const lines: string[] = []
    if (block.title) lines.push(`**${block.title}**`)
    switch (block.type) {
      case 'table':
        lines.push(block.columns.join(' | '))
        for (const row of block.rows) lines.push(`- ${row.join(' | ')}`)
        break
      case 'chart':
        block.labels.forEach((label, index) => lines.push(`- ${line(label, block.values[index], block.unit)}`))
        break
      case 'steps':
        block.items.forEach((item, index) => lines.push(`${index + 1}. ${item}`))
        break
      case 'checklist':
        block.items.forEach((item) => lines.push(`- ${item}`))
        break
      case 'choices':
        block.options.forEach((option) => lines.push(`- ${option}`))
        break
      case 'calculator': {
        const start = Object.fromEntries(block.inputs.map((input) => [input.name, input.value]))
        for (const input of block.inputs) lines.push(`- ${line(input.label, input.value, input.unit)}`)
        for (const output of block.outputs) {
          const value = evaluateFormula(output.formula, start)
          if (value !== null) lines.push(`- ${line(output.label, value, output.unit)}`)
        }
        break
      }
      case 'cards':
        for (const item of block.items) lines.push(`- ${item.title ? `**${item.title}**${item.text ? ` : ${item.text}` : ''}` : item.text}`)
        break
      case 'bars':
        if (block.subtitle) lines.push(block.subtitle)
        if (block.headline) lines.push(`**${block.headline}**`)
        for (const item of block.items) lines.push(`- ${t('common.labelValue', { label: item.label, value: item.text })}`)
        if (block.note) lines.push(block.note)
        break
      case 'stats':
        for (const item of block.items) {
          const value = [item.value, item.tag && `(${item.tag})`].filter(Boolean).join(' ')
          lines.push(`- ${item.label ? t('common.labelValue', { label: item.label, value }) : value}${item.detail ? ` — ${item.detail}` : ''}`)
        }
        if (block.note) lines.push(block.note)
        break
      case 'form':
        block.questions.forEach((item, index) => {
          lines.push(`${index + 1}. ${item.question}`)
          for (const option of item.options) lines.push(`   - ${option}`)
        })
        break
    }
    return `\n${lines.join('\n')}\n`
  })
}

function line(label: string, value: number, unit?: string): string {
  return t('common.labelValue', { label, value: `${formatNumber(value)}${unit ? ` ${unit}` : ''}` })
}

/** Nombre lisible à la façon de la langue de Jaris : au plus 2 décimales, sans zéros inutiles. */
export function formatNumber(value: number): string {
  return new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: 2 }).format(value)
}

/**
 * Étape 403 (Léo, capture d'une « liste de courses pour des crêpes » rendue en simples puces) : la consigne
 * « utilise un bloc checklist » est facultative pour le modèle, et un petit modèle local ne la suit pas toujours.
 * Quand la DEMANDE est une liste de courses ou de choses à faire, l'écran rend lui-même les listes de la réponse
 * cochables — même si le modèle a écrit de simples puces. Ne regarde que la demande : une liste dans une réponse
 * ordinaire (avantages, explications) reste une liste.
 */
export function wantsChecklist(request: string): boolean {
  const text = request
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
  return (
    /\bliste\b[^.?!\n]{0,40}\b(courses|achats|choses a faire|taches|trucs a faire|ingredients a acheter|affaires|valise|bagages)\b/.test(text) ||
    /\b(check-?list|to-?do(?:-?list)?|liste a cocher|shopping list|grocery list|packing list|to do list)\b/.test(text)
  )
}

/** Le séparateur d'un tableau Markdown : « |---|:---:| ». */
const MD_TABLE_SEPARATOR = /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(\|[ \t]*:?-{2,}:?[ \t]*)+\|?[ \t]*$/

function markdownCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  return trimmed.split('|').map((cell) =>
    cell
      .trim()
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/(?<![*\w])\*([^*\n]+?)\*(?![*\w])/g, '$1')
  )
}

/**
 * Léo (capture « Compare 3 forfaits mobiles ») : le modèle écrit souvent un tableau Markdown (« | A | B | » puis
 * « |---|---| ») au lieu du bloc jaris-ui, et il s'affichait avec ses barres. Il devient un vrai bloc tableau, rendu par
 * Jaris comme les autres. Rien ne change dans un bloc de code.
 */
export function markdownTablesToBlocks(content: string): string {
  const lines = content.split('\n')
  const out: string[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^[ \t]*```/.test(line)) inFence = !inFence
    const next = lines[i + 1]
    if (!inFence && line.includes('|') && next !== undefined && MD_TABLE_SEPARATOR.test(next)) {
      const columns = markdownCells(line)
      if (columns.length >= 2) {
        const rows: string[][] = []
        let j = i + 2
        while (j < lines.length && lines[j].trim().includes('|') && lines[j].trim() !== '') {
          rows.push(markdownCells(lines[j]))
          j += 1
        }
        if (rows.length) {
          out.push('```' + UI_FENCE_LANGUAGE, JSON.stringify({ type: 'table', columns, rows }), '```')
          i = j - 1
          continue
        }
      }
    }
    out.push(line)
  }
  return out.join('\n')
}
