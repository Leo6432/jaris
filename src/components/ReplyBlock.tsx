import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { t } from '../../shared/i18n'
import {
  evaluateFormula,
  formatNumber,
  toNumber,
  type UiBlock,
  type UiCalculator,
  type UiChart,
  type UiChecklist,
  type UiChoices,
  type UiSteps,
  type UiTable
} from '../../shared/uiBlocks'

/**
 * Blocs interactifs d'une réponse du Chat (voir shared/uiBlocks.ts). Tout le texte vient du modèle et reste du
 * texte : React l'échappe, rien n'est interprété en HTML. Les états (cases cochées, valeurs du calculateur) ne
 * vivent que dans l'écran, comme une feuille de brouillon : ils ne sont ni enregistrés ni renvoyés au modèle.
 */
export interface ReplyBlockOptions {
  /** Clic sur un choix : envoyé comme message de l'utilisateur. Absent = choix affichés sans être cliquables. */
  onChoice?: (option: string) => void
}

export function ReplyBlock({ block, onChoice }: { block: UiBlock } & ReplyBlockOptions): JSX.Element {
  return (
    <figure className={`reply-ui reply-ui--${block.type}`}>
      {block.title && <figcaption className="reply-ui__title">{block.title}</figcaption>}
      {block.type === 'table' && <TableBlock block={block} />}
      {block.type === 'chart' && <ChartBlock block={block} />}
      {block.type === 'steps' && <TickList block={block} numbered />}
      {block.type === 'checklist' && <TickList block={block} />}
      {block.type === 'choices' && <ChoicesBlock block={block} onChoice={onChoice} />}
      {block.type === 'calculator' && <CalculatorBlock block={block} />}
    </figure>
  )
}

function TableBlock({ block }: { block: UiTable }): JSX.Element {
  return (
    <div className="reply-ui__scroll">
      <table className="reply-ui__table">
        <thead>
          <tr>
            {block.columns.map((column, index) => (
              <th key={index} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className={toNumber(cell) !== null ? 'reply-ui__num' : undefined}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Graduations « rondes » (1, 2 ou 5 × 10^n) de 0 jusqu'au plus grand nombre, 4 intervalles au plus. */
function niceTicks(min: number, max: number): number[] {
  const span = max - min || Math.abs(max) || 1
  const raw = span / 4
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw) ?? raw
  const ticks: number[] = []
  for (let value = Math.floor(min / step) * step; value <= max + step * 1e-9; value += step) ticks.push(Number(value.toPrecision(12)))
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step)
  return ticks
}

const HEIGHT = 220
const PAD = { top: 12, right: 12, bottom: 34, left: 44 }

function ChartBlock({ block }: { block: UiChart }): JSX.Element {
  const [active, setActive] = useState<number | null>(null)
  // Le dessin suit la VRAIE largeur de la réponse (1 unité = 1 pixel) : avec une largeur fixe étirée, le texte des
  // axes devenait minuscule dans une fenêtre étroite et énorme dans une grande.
  const holder = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(560)
  useEffect(() => {
    const element = holder.current
    if (!element) return
    const measure = (): void => setWidth(Math.max(240, Math.round(element.clientWidth)))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const tableId = useId()
  const ticks = useMemo(() => niceTicks(Math.min(0, ...block.values), Math.max(0, ...block.values)), [block.values])
  const low = ticks[0]
  const high = ticks[ticks.length - 1]
  const plotW = width - PAD.left - PAD.right
  const plotH = HEIGHT - PAD.top - PAD.bottom
  const y = (value: number): number => PAD.top + plotH - ((value - low) / (high - low || 1)) * plotH
  const count = block.values.length
  const slot = plotW / count
  const x = (index: number): number => PAD.left + slot * index + slot / 2
  const unit = block.unit ? ` ${block.unit}` : ''
  // Une étiquette sur deux (ou moins) quand elles ne tiennent pas : jamais de texte qui se chevauche.
  const labelEvery = Math.max(1, Math.ceil(count / Math.floor(plotW / 56)))
  const shown = active ?? null

  return (
    <div ref={holder}>
      <p className="reply-ui__readout" aria-live="polite">
        {shown === null ? ' ' : t('common.labelValue', { label: block.labels[shown], value: `${formatNumber(block.values[shown])}${unit}` })}
      </p>
      <svg
        className="reply-ui__chart"
        viewBox={`0 0 ${width} ${HEIGHT}`}
        role="img"
        aria-label={block.title}
        aria-describedby={tableId}
        onMouseLeave={() => setActive(null)}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line className="reply-ui__grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
            <text className="reply-ui__axis" x={PAD.left - 6} y={y(tick)} textAnchor="end" dominantBaseline="middle">
              {formatNumber(tick)}
            </text>
          </g>
        ))}
        {block.kind === 'bar'
          ? block.values.map((value, index) => {
              const width = Math.max(4, Math.min(48, slot - 2))
              const top = y(Math.max(0, value))
              const bottom = y(Math.min(0, value))
              const height = Math.max(1, bottom - top)
              const radius = Math.min(4, width / 2, height)
              const left = x(index) - width / 2
              // Coins arrondis seulement du côté de la valeur, jamais contre la ligne de base.
              const d =
                value >= 0
                  ? `M${left},${bottom} V${top + radius} Q${left},${top} ${left + radius},${top} H${left + width - radius} Q${left + width},${top} ${left + width},${top + radius} V${bottom} Z`
                  : `M${left},${top} V${bottom - radius} Q${left},${bottom} ${left + radius},${bottom} H${left + width - radius} Q${left + width},${bottom} ${left + width},${bottom - radius} V${top} Z`
              return <path key={index} className={`reply-ui__bar${active === index ? ' reply-ui__bar--active' : ''}`} d={d} />
            })
          : (
            <>
              <polyline
                className="reply-ui__line"
                points={block.values.map((value, index) => `${x(index)},${y(value)}`).join(' ')}
              />
              {active !== null && (
                <>
                  <line className="reply-ui__cross" x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + plotH} />
                  <circle className="reply-ui__dot" cx={x(active)} cy={y(block.values[active])} r={4.5} />
                </>
              )}
            </>
          )}
        {low < 0 && <line className="reply-ui__baseline" x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} />}
        {block.labels.map((label, index) =>
          index % labelEvery === 0 ? (
            <text key={index} className="reply-ui__axis" x={x(index)} y={HEIGHT - PAD.bottom + 18} textAnchor="middle">
              {label.length > 10 ? `${label.slice(0, 9)}…` : label}
            </text>
          ) : null
        )}
        {/* Zones de survol plus larges que les marques : une colonne entière par valeur. */}
        {block.values.map((_, index) => (
          <rect
            key={index}
            className="reply-ui__hit"
            x={PAD.left + slot * index}
            y={PAD.top}
            width={slot}
            height={plotH}
            onMouseEnter={() => setActive(index)}
          />
        ))}
      </svg>
      <table id={tableId} className="sr-only">
        <tbody>
          {block.labels.map((label, index) => (
            <tr key={index}>
              <th scope="row">{label}</th>
              <td>
                {formatNumber(block.values[index])}
                {unit}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TickList({ block, numbered = false }: { block: UiSteps | UiChecklist; numbered?: boolean }): JSX.Element {
  const [done, setDone] = useState<boolean[]>(() => block.items.map(() => false))
  const count = done.filter(Boolean).length
  const toggle = (index: number): void => setDone((previous) => previous.map((value, i) => (i === index ? !value : value)))
  return (
    <>
      <ul className={`reply-ui__ticks${numbered ? ' reply-ui__ticks--numbered' : ''}`}>
        {block.items.map((item, index) => (
          <li key={index}>
            <label className={`reply-ui__tick${done[index] ? ' reply-ui__tick--done' : ''}`}>
              <input type="checkbox" checked={done[index]} onChange={() => toggle(index)} />
              <span className="reply-ui__tick-mark" aria-hidden="true">
                {done[index] ? '✓' : numbered ? index + 1 : ''}
              </span>
              <span className="reply-ui__tick-text">{item}</span>
            </label>
          </li>
        ))}
      </ul>
      <p className="reply-ui__count">
        {count}/{block.items.length}
      </p>
    </>
  )
}

function ChoicesBlock({ block, onChoice }: { block: UiChoices } & ReplyBlockOptions): JSX.Element {
  const [chosen, setChosen] = useState<string | null>(null)
  return (
    <div className="reply-ui__choices">
      {block.options.map((option) => (
        <button
          key={option}
          type="button"
          className={`reply-ui__choice${chosen === option ? ' reply-ui__choice--chosen' : ''}`}
          disabled={!onChoice || chosen !== null}
          onClick={() => {
            if (!onChoice || chosen !== null) return
            setChosen(option)
            onChoice(option)
          }}
        >
          {option}
        </button>
      ))}
    </div>
  )
}

function CalculatorBlock({ block }: { block: UiCalculator }): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(block.inputs.map((input) => [input.name, formatNumber(input.value).replace(/[\s  ]/g, '')]))
  )
  const numbers: Record<string, number> = {}
  let complete = true
  for (const input of block.inputs) {
    const value = toNumber(values[input.name] ?? '')
    if (value === null) complete = false
    else numbers[input.name] = value
  }
  return (
    <div className="reply-ui__calc">
      <div className="reply-ui__calc-inputs">
        {block.inputs.map((input) => (
          <label key={input.name} className="reply-ui__field">
            <span>{input.label}</span>
            <span className="reply-ui__field-box">
              <input
                className="reply-ui__field-input"
                type="text"
                inputMode="decimal"
                value={values[input.name] ?? ''}
                onChange={(event) => setValues((previous) => ({ ...previous, [input.name]: event.target.value }))}
              />
              {input.unit && <span className="reply-ui__unit">{input.unit}</span>}
            </span>
          </label>
        ))}
      </div>
      <dl className="reply-ui__calc-outputs">
        {block.outputs.map((output, index) => {
          const value = complete ? evaluateFormula(output.formula, numbers) : null
          return (
            <div key={index} className="reply-ui__result">
              <dt>{output.label}</dt>
              <dd>
                {value === null ? '—' : formatNumber(value)}
                {value !== null && output.unit ? ` ${output.unit}` : ''}
              </dd>
            </div>
          )
        })}
      </dl>
    </div>
  )
}
