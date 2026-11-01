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
export type UiBlock = UiTable | UiChart | UiSteps | UiChecklist | UiChoices | UiCalculator

const MAX_TEXT = 300
const MAX_ROWS = 50
const MAX_COLUMNS = 8
const MAX_POINTS = 40
const MAX_ITEMS = 30
const MAX_OPTIONS = 6
const MAX_INPUTS = 8
const MAX_OUTPUTS = 4

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
      const columns = textList(data.columns, MAX_COLUMNS)
      if (!columns.length || !Array.isArray(data.rows)) return null
      const rows = data.rows
        .filter((row): row is unknown[] => Array.isArray(row))
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
    default:
      return null
  }
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
