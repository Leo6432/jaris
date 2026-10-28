import { useEffect, useRef, useState } from 'react'
import Composer from '@/components/Composer'
import EmptyState from '@/components/EmptyState'
import { setVoiceOutputDevice } from '@/components/JarisOrb'
import { formatDuration } from '@/lib/formatCodeGenProgress'
import { formatModelName } from '@/lib/formatModelName'
import { formatRecentDate } from '@/lib/formatRecentDate'
import { renderFormattedText } from '@/lib/formatReply'
import { formatDecimal, formatPercent, t } from '@/lib/i18n'
import { ipcErrorMessage } from '@/lib/ipcError'
import { useScreenActive } from '@/lib/shellContext'
import { DUEL_CATEGORIES, DUEL_DEFAULT_SIZE, DUEL_MIN_CHOSEN, type DuelAction, type DuelCategory, type DuelOutcome, type DuelSide, type DuelVoteSide } from '../../shared/duel'
import type { DuelActivity, DuelHistoryEntry, DuelModelOption, DuelPlan, DuelRankingView, DuelSessionView, DuelSideView, DuelStandingView, DuelSummary } from '../../shared/ipc'
import type { MessageKey } from '../../shared/i18n'

/**
 * Étape 355 — le Duel (Léo : « un bouton duel à gauche, une session télécharge 4-6 modèles qui tiennent, anonymes, on
 * choisit conversation, code ou vocal, et on vote »). Deux modèles anonymes, A puis B, répondent à la même demande ;
 * chacun agit VRAIMENT sur le PC (« si on lui dit ouvre bloc-notes, il va voir si un modèle a vraiment ouvert »), donc
 * B n'est lancé qu'une fois que Léo a vérifié ce que A a fait. Les noms ne sont révélés qu'à la fin de la session.
 */

const CATEGORY_LABEL: Record<DuelCategory, MessageKey> = {
  conversation: 'duel.category.conversation',
  code: 'duel.category.code',
  voice: 'duel.category.voice'
}

const CATEGORY_HINT: Record<DuelCategory, MessageKey> = {
  conversation: 'duel.category.conversation.hint',
  code: 'duel.category.code.hint',
  voice: 'duel.category.voice.hint'
}

const CATEGORY_ICON: Record<DuelCategory, string> = {
  conversation: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z',
  code: 'M8 7l-5 5 5 5M16 7l5 5-5 5M14 4l-4 16',
  voice: 'M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0zM5 11a7 7 0 0 0 14 0M12 18v3'
}

const SUGGESTIONS: Record<DuelCategory, MessageKey[]> = {
  conversation: ['duel.suggest.conversation.1', 'duel.suggest.conversation.2', 'duel.suggest.conversation.3'],
  code: ['duel.suggest.code.1', 'duel.suggest.code.2', 'duel.suggest.code.3'],
  voice: ['duel.suggest.voice.1', 'duel.suggest.voice.2', 'duel.suggest.voice.3']
}

/** Ce que l'outil appelé demande au PC, en mots de tous les jours (jamais le nom technique de l'outil). */
const ACTION_LABEL: Record<string, MessageKey> = {
  open_app: 'duel.action.open_app',
  set_reminder: 'duel.action.set_reminder',
  look_at_screen: 'duel.action.look_at_screen',
  search_web: 'duel.action.search_web',
  read_web_page: 'duel.action.read_web_page',
  remember: 'duel.action.remember',
  recall_memory: 'duel.action.recall_memory',
  type_text: 'duel.action.type_text',
  press_key: 'duel.action.press_key',
  click_mouse: 'duel.action.click_mouse',
  get_system_stats: 'duel.action.get_system_stats',
  media_control: 'duel.action.media_control',
  computer_use_task: 'duel.action.computer_use_task',
  generate_image: 'duel.action.generate_image'
}

const PHASE_LABEL: Record<Exclude<DuelActivity['kind'], 'action'>, MessageKey> = {
  loading: 'code.phase.loading',
  reading: 'code.phase.reading',
  thinking: 'code.phase.thinking',
  writing: 'code.phase.writing'
}

const OUTCOMES: { outcome: DuelOutcome; label: MessageKey }[] = [
  { outcome: 'a', label: 'duel.vote.a' },
  { outcome: 'tie', label: 'duel.vote.tie' },
  { outcome: 'b', label: 'duel.vote.b' },
  { outcome: 'bothBad', label: 'duel.vote.bothBad' }
]

const ROLE_LABEL: Record<DuelSummary['changes'][number]['role'], MessageKey> = {
  flash: 'role.flash',
  medium: 'role.medium',
  large: 'role.large',
  code: 'app.mode.code'
}

function LineIcon({ d, size = 20 }: { d: string; size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )
}

export function actionLabel(action: DuelAction): string {
  const key = ACTION_LABEL[action.tool]
  const label = key ? t(key) : t('duel.action.other')
  return action.detail ? t('common.labelValue', { label, value: t('common.quoted', { text: action.detail }) }) : label
}

function activityLabel(activity: DuelActivity | null): string {
  if (!activity) return t('code.phase.thinking')
  return activity.kind === 'action' ? actionLabel(activity.action) : t(PHASE_LABEL[activity.kind])
}

const finished = (side: DuelSideView): boolean => side.status === 'done' || side.status === 'error' || side.status === 'stopped'

function statusLabel(side: DuelSideView): string {
  switch (side.status) {
    case 'running':
      return t('duel.status.running')
    case 'done':
      return t('duel.status.done', { duration: formatDuration(side.durationMs ?? 0) })
    case 'error':
      return t('duel.status.error')
    case 'stopped':
      return t('duel.status.stopped')
    default:
      return t('duel.status.waiting')
  }
}

/** La taille gardée : celle déjà choisie si elle reste possible, sinon 5, sinon la plus grande proposée. */
function keepSize(plan: DuelPlan, current: number): number {
  const counts = plan.sizes.map((s) => s.count)
  if (counts.includes(current)) return current
  if (counts.includes(DUEL_DEFAULT_SIZE)) return DUEL_DEFAULT_SIZE
  return counts[counts.length - 1] ?? DUEL_DEFAULT_SIZE
}

const gb = (value: number): string => t('unit.gb', { value: formatDecimal(value) })

/** Étape 363 : pourquoi un modèle est grisé dans la liste à cocher. */
function unavailableText(option: DuelModelOption): string {
  const reason = option.reason
  if (!reason) return ''
  switch (reason.kind) {
    case 'tooBig':
      return t('duel.pick.reason.tooBig', { need: gb(reason.needGb), budget: gb(reason.budgetGb) })
    case 'untested':
      return t('duel.pick.reason.untested')
    case 'tools':
      return t('duel.pick.reason.tools', { score: reason.score })
    case 'ollama':
      return t('duel.pick.reason.ollama', { version: reason.version })
    case 'blocked':
      return t('duel.pick.reason.blocked')
  }
}

interface ModelPickerProps {
  plan: DuelPlan
  picked: string[]
  onToggle: (model: string) => void
}

/**
 * Étape 363, Léo : « choisir les modèles qu'on veut, minimum 4, et on doit voir tous les modèles de Jaris ; si le PC
 * ne peut pas, il est en gris mais il est quand même présent ». Boutons à cocher (role="checkbox") plutôt que des
 * <input> : la règle générale des champs de saisie leur imposerait un cadre carré.
 */
function ModelPicker({ plan, picked, onToggle }: ModelPickerProps): JSX.Element {
  const models = plan.models ?? []
  return (
    <ul className="duel-picks" aria-labelledby="duel-size-title">
      {models.map((option) => {
        const available = option.reason === null
        const checked = available && picked.includes(option.model)
        return (
          <li key={option.model}>
            <button
              type="button"
              role="checkbox"
              aria-checked={checked}
              disabled={!available}
              className={`duel-pick${checked ? ' duel-pick--checked' : ''}${available ? '' : ' duel-pick--unavailable'}`}
              title={option.model}
              onClick={() => onToggle(option.model)}
            >
              <span className="duel-pick__box" aria-hidden="true">
                {checked && (
                  <svg viewBox="0 0 16 16" width="12" height="12">
                    <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
              <span className="duel-pick__name">{formatModelName(option.model)}</span>
              <span className="duel-pick__meta">
                {available ? (option.installed ? t('duel.pick.installed') : gb(option.vramGb)) : unavailableText(option)}
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

interface SideCardProps {
  name: DuelSide
  side: DuelSideView
  category: DuelCategory
  now: number
  playing: boolean
  onStop: () => void
  onListen: () => void
  /** Étape 358 : le nom du modèle, révélé après le vote ; `null` avant. */
  model: string | null
}

function SideCard({ name, side, category, now, playing, onStop, onListen, model }: SideCardProps): JSX.Element {
  const running = side.status === 'running'
  const final = finished(side)
  const showActions = category !== 'code' && (side.actions.length > 0 || (final && side.status !== 'stopped'))
  const empty = final && side.status === 'done' && !side.text.trim() && !side.previewUrl
  return (
    <section className={`duel-side duel-side--${side.status}`} aria-label={t(name === 'a' ? 'duel.side.a' : 'duel.side.b')}>
      <header className="duel-side__head">
        <span className="duel-side__name">
          <span className="duel-side__letter" aria-hidden="true">
            {name.toUpperCase()}
          </span>
          {t(name === 'a' ? 'duel.side.a' : 'duel.side.b')}
          {model !== null && (
            <span className="duel-side__model" title={model}>
              {formatModelName(model)}
            </span>
          )}
        </span>
        <span className="duel-side__status">{statusLabel(side)}</span>
      </header>

      {running && (
        <p className="duel-side__activity" aria-live="polite">
          <span className="duel-side__pulse" aria-hidden="true" />
          <span className="duel-side__activity-text">{activityLabel(side.activity)}</span>
          {side.startedAt !== null && <span className="duel-side__elapsed">{formatDuration(Math.max(0, now - side.startedAt))}</span>}
        </p>
      )}

      {showActions && (
        <div className="duel-side__actions">
          <h3 className="duel-side__actions-title">{t('duel.actions.title')}</h3>
          {side.actions.length ? (
            <ul>
              {side.actions.map((action, index) => (
                <li key={index}>{actionLabel(action)}</li>
              ))}
            </ul>
          ) : (
            <p className="duel-side__muted">{t('duel.actions.none')}</p>
          )}
        </div>
      )}

      {category === 'code' && side.previewUrl && (
        <iframe
          className="duel-side__preview"
          title={t('duel.preview.title', { side: name.toUpperCase() })}
          sandbox="allow-scripts allow-forms"
          src={side.previewUrl}
        />
      )}

      {category === 'code' ? (
        side.text.trim() && final ? (
          <div className="duel-side__issues">
            <p>{t('duel.codeIssues')}</p>
            <pre>{side.text}</pre>
          </div>
        ) : null
      ) : side.text.trim() ? (
        <div className={`duel-side__text${category === 'voice' ? ' duel-side__text--voice' : ''}`}>
          {category === 'voice' ? side.text : renderFormattedText(side.text)}
        </div>
      ) : null}

      {category === 'voice' && side.audio && (
        <button type="button" className="duel-btn duel-side__listen" onClick={onListen} aria-pressed={playing}>
          <LineIcon d="M5 9v6h4l5 4V5L9 9H5zM17 9a4 4 0 0 1 0 6" size={16} />
          {playing ? t('duel.listenAgain') : t('duel.listen')}
        </button>
      )}
      {category === 'voice' && side.audioError && <p className="duel-side__muted">{t('duel.audioFailed', { error: side.audioError })}</p>}

      {empty && <p className="duel-side__muted">{t('duel.noReply')}</p>}
      {side.status === 'error' && side.error && <p className="duel-side__error">{side.error}</p>}
      {side.trouble && (
        <div className="duel-side__trouble" role="note">
          <p>{t('duel.trouble.side', { action: actionLabel({ tool: side.trouble.tool, detail: null }) })}</p>
          {/* La réponse est souvent déjà ce message d'erreur : pas deux fois la même phrase. */}
          {!side.text.includes(side.trouble.message) && <p className="duel-side__trouble-detail">{side.trouble.message}</p>}
        </div>
      )}

      {running && (
        <button type="button" className="duel-btn duel-side__stop" onClick={onStop}>
          {t('common.stop')}
        </button>
      )}
    </section>
  )
}

/** Le petit bouton qui ouvre l'historique, là où Léo en a besoin (accueil, duel en cours, fin de session). */
function HistoryButton({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button type="button" className="duel-btn duel-history-button" onClick={onClick}>
      <LineIcon d="M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.5-6M3 4v4h4" size={16} />
      {t('duel.history.open')}
    </button>
  )
}

/**
 * Étape 358 : une ligne du classement façon Arena — points (tous partent de 0), marge à 95 %, rangs possibles, puis
 * victoires, défaites et égalités.
 */
function RankingStats({ row }: { row: DuelStandingView }): JSX.Element {
  const signed = (value: number): string => `${value > 0 ? '+' : ''}${formatDecimal(Math.round(value))}`
  return (
    <span className="duel-ranking__record">
      <span className="duel-ranking__score">{t('duel.ranking.score', { score: signed(row.score), margin: formatDecimal(Math.round(row.margin)) })}</span>
      {' · '}
      {row.rankBest === row.rankWorst
        ? t('duel.ranking.rankOne', { rank: row.rankBest })
        : t('duel.ranking.rank', { best: row.rankBest, worst: row.rankWorst })}
      {' · '}
      {t('duel.ranking.record', { wins: row.wins, losses: row.losses, ties: row.ties })}
    </span>
  )
}

function outcomeLabel(entry: Pick<DuelHistoryEntry, 'outcome' | 'modelA' | 'modelB'>): string {
  if (entry.outcome === 'tie') return t('duel.vote.tie')
  if (entry.outcome === 'bothBad') return t('duel.outcome.bothBad')
  const winner = entry.outcome === 'a' ? entry.modelA : entry.modelB
  if (winner === null) return t(entry.outcome === 'a' ? 'duel.vote.a' : 'duel.vote.b')
  return t('duel.outcome.winner', { model: formatModelName(winner) })
}

interface HistorySideProps {
  entry: DuelHistoryEntry
  name: DuelSide
  side: DuelVoteSide
}

function HistorySide({ entry, name, side }: HistorySideProps): JSX.Element {
  const [app, setApp] = useState<string | null | 'loading' | 'missing'>(null)
  const model = name === 'a' ? entry.modelA : entry.modelB
  const openApp = (): void => {
    setApp('loading')
    window.jaris
      .duelHistoryApp(entry.id, name)
      .then((url) => setApp(url ?? 'missing'))
      .catch(() => setApp('missing'))
  }
  return (
    <section className="duel-side duel-history__side" aria-label={t(name === 'a' ? 'duel.side.a' : 'duel.side.b')}>
      <header className="duel-side__head">
        <span className="duel-side__name">
          <span className="duel-side__letter" aria-hidden="true">
            {name.toUpperCase()}
          </span>
          <span className="duel-history__model" title={model ?? undefined}>
            {model ? formatModelName(model) : t(name === 'a' ? 'duel.side.a' : 'duel.side.b')}
          </span>
        </span>
        {side.durationMs !== null && (
          <span className="duel-side__status">{t('duel.status.done', { duration: formatDuration(side.durationMs) })}</span>
        )}
      </header>
      {entry.category !== 'code' && (
        <div className="duel-side__actions">
          <h3 className="duel-side__actions-title">{t('duel.actions.title')}</h3>
          {side.actions.length ? (
            <ul>
              {side.actions.map((action, index) => (
                <li key={index}>{actionLabel(action)}</li>
              ))}
            </ul>
          ) : (
            <p className="duel-side__muted">{t('duel.actions.none')}</p>
          )}
        </div>
      )}
      {entry.category === 'code' ? (
        <>
          {side.app &&
            (typeof app === 'string' && app !== 'loading' && app !== 'missing' ? (
              <iframe
                className="duel-side__preview"
                title={t('duel.preview.title', { side: name.toUpperCase() })}
                sandbox="allow-scripts allow-forms"
                src={app}
              />
            ) : (
              <button type="button" className="duel-btn duel-history__open-app" onClick={openApp} disabled={app === 'loading'}>
                {app === 'loading' ? t('common.loading') : t('duel.history.openApp')}
              </button>
            ))}
          {(!side.app || app === 'missing') && <p className="duel-side__muted">{t('duel.history.appMissing')}</p>}
          {side.text.trim() && (
            <div className="duel-side__issues">
              <p>{t('duel.codeIssues')}</p>
              <pre>{side.text}</pre>
            </div>
          )}
        </>
      ) : side.text.trim() ? (
        <div className={`duel-side__text${entry.category === 'voice' ? ' duel-side__text--voice' : ''}`}>
          {entry.category === 'voice' ? side.text : renderFormattedText(side.text)}
        </div>
      ) : (
        !side.error && <p className="duel-side__muted">{t('duel.noReply')}</p>
      )}
      {side.error && <p className="duel-side__error">{side.error}</p>}
    </section>
  )
}

/** L'historique complet des duels votés (Léo : « un petit bouton pour voir tous les combats »). */
function DuelHistory({ onBack }: { onBack: () => void }): JSX.Element {
  const [entries, setEntries] = useState<DuelHistoryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<DuelCategory | 'all'>('all')
  const [open, setOpen] = useState<string | null>(null)
  // Étape 362 : « Télécharger les votes » — résultat affiché sous le bouton (rien sur une annulation).
  const [exporting, setExporting] = useState(false)
  const [exported, setExported] = useState<{ count: number } | { error: string } | null>(null)
  const exportVotes = (): void => {
    setExporting(true)
    setExported(null)
    window.jaris
      .duelExportVotes()
      .then((result) => {
        if (result.saved) setExported({ count: result.count ?? 0 })
        else if (result.error) setExported({ error: result.error })
      })
      .catch((err) => setExported({ error: ipcErrorMessage(err) }))
      .finally(() => setExporting(false))
  }

  useEffect(() => {
    let alive = true
    window.jaris
      .duelHistory()
      .then((list) => alive && setEntries(list))
      .catch((err) => alive && setError(ipcErrorMessage(err)))
    return () => {
      alive = false
    }
  }, [])

  const shown = (entries ?? []).filter((entry) => filter === 'all' || entry.category === filter)
  const now = new Date()
  return (
    <div className="duel__scroll">
      <div className="duel-history">
        <div className="duel-history__head">
          <button type="button" className="duel-btn duel-history__back" onClick={onBack}>
            <LineIcon d="M15 6l-6 6 6 6" size={16} />
            {t('duel.history.back')}
          </button>
          <button
            type="button"
            className="duel-btn duel-history__download"
            onClick={exportVotes}
            disabled={exporting || !entries?.length}
          >
            <LineIcon d="M12 4v11m0 0l-4.5-4.5M12 15l4.5-4.5M5 19h14" size={16} />
            {exporting ? t('common.loading') : t('duel.history.download')}
          </button>
        </div>
        {exported && (
          <p className={'error' in exported ? 'duel__error' : 'duel-history__exported'} role="status">
            {'error' in exported ? exported.error : t('duel.history.downloaded', { count: exported.count })}
          </p>
        )}
        <h1 className="duel-summary__title">{t('duel.history.title')}</h1>
        <p className="duel-summary__lead">{t('duel.history.lead')}</p>

        <div className="duel-history__filters" role="radiogroup" aria-label={t('duel.history.title')}>
          {(['all', ...DUEL_CATEGORIES] as const).map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={filter === id}
              className={`duel-size duel-history__filter${filter === id ? ' duel-size--selected' : ''}`}
              onClick={() => setFilter(id)}
            >
              {id === 'all' ? t('duel.history.all') : t(CATEGORY_LABEL[id])}
            </button>
          ))}
        </div>

        {error && <p className="duel__error">{error}</p>}
        {entries === null && !error ? (
          <p className="duel-home__note">{t('common.loading')}</p>
        ) : shown.length === 0 ? (
          <p className="duel-home__note">{t('duel.history.empty')}</p>
        ) : (
          <ol className="duel-history__list">
            {shown.map((entry) => {
              const expanded = open === entry.id
              return (
                <li key={entry.id} className="duel-history__item">
                  <p className="duel-history__meta">
                    {formatRecentDate(entry.at, now)} · {t(CATEGORY_LABEL[entry.category])}
                  </p>
                  <p className="duel-summary__round-prompt">{entry.prompt}</p>
                  <p className="duel-summary__round-models">
                    {t('duel.summary.versus', { a: formatModelName(entry.modelA ?? '—'), b: formatModelName(entry.modelB ?? '—') })}
                  </p>
                  <p className={`duel-summary__outcome duel-summary__outcome--${entry.outcome}`}>{outcomeLabel(entry)}</p>
                  <button
                    type="button"
                    className="duel-history__toggle"
                    aria-expanded={expanded}
                    onClick={() => setOpen(expanded ? null : entry.id)}
                  >
                    {expanded ? t('duel.history.hide') : t('duel.history.show')}
                  </button>
                  {expanded &&
                    (entry.sides ? (
                      <div className={`duel-round__sides duel-history__sides${entry.category === 'code' ? ' duel-round__sides--code' : ''}`}>
                        <HistorySide entry={entry} name="a" side={entry.sides.a} />
                        <HistorySide entry={entry} name="b" side={entry.sides.b} />
                      </div>
                    ) : (
                      <p className="duel-home__note">{t('duel.history.noDetail')}</p>
                    ))}
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </div>
  )
}

export default function DuelPanel(): JSX.Element {
  const active = useScreenActive()
  const [view, setView] = useState<DuelSessionView | null>(null)
  const [ended, setEnded] = useState<{ id: string; summary: DuelSummary } | null>(null)
  const [category, setCategory] = useState<DuelCategory>('conversation')
  const [plan, setPlan] = useState<DuelPlan | null>(null)
  const [size, setSize] = useState<number>(DUEL_DEFAULT_SIZE)
  /** Étape 363 : modèles au hasard, ou choisis à la main. */
  const [pickMode, setPickMode] = useState<'random' | 'manual'>('random')
  const [picked, setPicked] = useState<string[]>([])
  const [rankings, setRankings] = useState<DuelRankingView[] | null>(null)
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  /** L'action en cours d'envoi au main (un seul bouton actif à la fois). */
  const [pending, setPending] = useState<'start' | 'ask' | 'runB' | 'vote' | 'next' | 'retry' | 'skip' | 'end' | 'delete' | 'close' | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [deleted, setDeleted] = useState<{ deleted: string[]; failed: { model: string; error: string }[] } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  // L'état de la session vit dans le main : relu à l'ouverture (un rechargement de l'écran ne perd rien), puis suivi.
  useEffect(() => {
    let alive = true
    let heard = false
    const off = window.jaris.onDuelChanged((next) => {
      heard = true
      setView(next)
    })
    void window.jaris
      .duelState()
      .then((state) => {
        if (alive && !heard) setView(state)
      })
      .catch(() => {})
    return () => {
      alive = false
      off()
    }
  }, [])

  const home = view === null

  // Accueil : ce que la session proposerait pour la catégorie choisie (aucun téléchargement ici).
  useEffect(() => {
    if (!home || !active) return
    let alive = true
    setPlan(null)
    window.jaris
      .duelPlan(category)
      .then((next) => {
        if (!alive) return
        setPlan(next)
        setSize((current) => keepSize(next, current))
      })
      .catch((err) => alive && setError(ipcErrorMessage(err)))
    return () => {
      alive = false
    }
  }, [home, active, category])

  useEffect(() => {
    if (!home || !active) return
    let alive = true
    window.jaris
      .duelRankings()
      .then((next) => alive && setRankings(next))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [home, active])

  // Une session terminée sans passer par « Terminer » (téléchargements impossibles, écran rechargé) : son bilan est
  // demandé ici. Jamais pendant « Terminer » lui-même : le bilan de ce clic contient les changements appliqués, un
  // second appel ne les verrait plus.
  useEffect(() => {
    if (view?.phase !== 'ended' || ended?.id === view.id || pending === 'end') return
    let alive = true
    const id = view.id
    window.jaris
      .duelEnd()
      .then((summary) => alive && setEnded({ id, summary }))
      .catch((err) => alive && setError(ipcErrorMessage(err)))
    return () => {
      alive = false
    }
  }, [view?.phase, view?.id, ended?.id, pending])

  const round = view?.round ?? null
  const anyRunning = round ? round.a.status === 'running' || round.b.status === 'running' : false
  useEffect(() => {
    if (!anyRunning) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [anyRunning])

  // --- Voix (duel Vocal) -----------------------------------------------------------------------------------------
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioUrlRef = useRef<string | null>(null)
  const autoPlayed = useRef(new Set<string>())
  const [playing, setPlaying] = useState<DuelSide | null>(null)

  const stopAudio = (): void => {
    audioRef.current?.pause()
    setPlaying(null)
  }

  const play = async (side: DuelSide): Promise<void> => {
    const data = await window.jaris.duelAudio(side).catch(() => null)
    const el = audioRef.current
    if (!data || !el) return
    if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
    audioUrlRef.current = URL.createObjectURL(new Blob([data as BlobPart], { type: 'audio/wav' }))
    el.src = audioUrlRef.current
    const profile = await window.jaris.getProfile().catch(() => null)
    await setVoiceOutputDevice(el, profile?.audioOutputDeviceId ?? '')
    setPlaying(side)
    await el.play().catch(() => setPlaying(null))
  }

  useEffect(
    () => () => {
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current)
    },
    []
  )

  // Une réponse lue se joue d'elle-même une fois prête, comme à l'Agent vocal — seulement si l'écran Duel est affiché.
  useEffect(() => {
    if (!view || view.category !== 'voice' || !round || !active) return
    for (const side of ['a', 'b'] as const) {
      const key = `${view.id}:${round.number}:${side}`
      if (round[side].audio && !autoPlayed.current.has(key)) {
        autoPlayed.current.add(key)
        void play(side)
        break
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view?.id, view?.category, round?.number, round?.a.audio, round?.b.audio, active])

  // Le modèle B qui démarre, ou un nouveau duel : la voix précédente se tait.
  useEffect(() => {
    if (round?.b.status === 'running' || round?.prompt === null) stopAudio()
  }, [round?.b.status, round?.prompt, round?.number])

  // --- Actions --------------------------------------------------------------------------------------------------
  const run = async <T,>(kind: NonNullable<typeof pending>, task: () => Promise<T>): Promise<T | undefined> => {
    setPending(kind)
    setError(null)
    try {
      return await task()
    } catch (err) {
      setError(ipcErrorMessage(err))
      return undefined
    } finally {
      setPending(null)
    }
  }

  // Seuls les modèles disponibles pour la catégorie affichée comptent (un modèle coché en Conversation peut ne pas
  // l'être en Code).
  const availableModels = new Set((plan?.models ?? []).filter((m) => m.reason === null).map((m) => m.model))
  const pickedNow = picked.filter((m) => availableModels.has(m))
  const toggle = (model: string): void =>
    setPicked((current) => (current.includes(model) ? current.filter((m) => m !== model) : [...current, model]))

  const start = (): void => {
    void run('start', async () => {
      setEnded(null)
      setDeleted(null)
      setView(await window.jaris.duelStart(category, pickMode === 'manual' ? pickedNow : size))
    })
  }

  const ask = (): void => {
    const text = prompt.trim()
    if (!text) return
    void run('ask', async () => {
      setView(await window.jaris.duelAsk(text))
      setPrompt('')
    })
  }

  const runB = (): void => {
    void run('runB', async () => setView(await window.jaris.duelRunB()))
  }

  const stop = (): void => {
    void window.jaris.duelStop().catch((err) => setError(ipcErrorMessage(err)))
  }

  const vote = (outcome: DuelOutcome): void => {
    void run('vote', async () => setView(await window.jaris.duelVote(outcome)))
  }

  const next = (): void => {
    stopAudio()
    void run('next', async () => setView(await window.jaris.duelNext()))
  }

  const retry = (): void => {
    stopAudio()
    void run('retry', async () => setView(await window.jaris.duelRetry()))
  }

  const skip = (): void => {
    stopAudio()
    void run('skip', async () => setView(await window.jaris.duelSkip()))
  }

  const openHistory = (): void => setHistoryOpen(true)

  const end = (): void => {
    const id = view?.id
    if (!id) return
    stopAudio()
    void run('end', async () => {
      const summary = await window.jaris.duelEnd()
      setEnded({ id, summary })
    })
  }

  const close = (): void => {
    void run('close', async () => {
      await window.jaris.duelClose()
      setEnded(null)
      setDeleted(null)
      setView(null)
    })
  }

  const removeDownloaded = (models: string[]): void => {
    void run('delete', async () => setDeleted(await window.jaris.duelDeleteModels(models)))
  }

  // --- Écrans ---------------------------------------------------------------------------------------------------
  let content: JSX.Element

  if (historyOpen) {
    content = <DuelHistory onBack={() => setHistoryOpen(false)} />
  } else if (view === null) {
    const ranking = rankings?.find((r) => r.category === category) ?? null
    const chosen = plan?.sizes.find((s) => s.count === size) ?? null
    const tooFew = plan !== null && plan.sizes.length === 0
    const manual = pickMode === 'manual'
    const pickedMissing = (plan?.models ?? []).filter((m) => pickedNow.includes(m.model) && !m.installed)
    const pickedDownloadGb = pickedMissing.reduce((sum, m) => sum + m.vramGb, 0)
    const pickedFitsDisk = plan?.downloadBudgetGb == null || pickedDownloadGb <= plan.downloadBudgetGb
    const canStart = manual ? pickedNow.length >= DUEL_MIN_CHOSEN && pickedFitsDisk : Boolean(chosen && chosen.fitsDisk)
    content = (
      <div className="duel__scroll">
        <div className="duel-home">
          <EmptyState title={t('app.mode.duel.title')} description={t('duel.lead')} />

          <section className="duel-home__section" aria-labelledby="duel-category-title">
            <h2 id="duel-category-title" className="duel-home__label">
              {t('duel.category.title')}
            </h2>
            <div className="duel-categories" role="radiogroup" aria-labelledby="duel-category-title">
              {DUEL_CATEGORIES.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={category === id}
                  className={`duel-category${category === id ? ' duel-category--selected' : ''}`}
                  onClick={() => setCategory(id)}
                >
                  <span className="duel-category__icon">
                    <LineIcon d={CATEGORY_ICON[id]} />
                  </span>
                  <span className="duel-category__name">{t(CATEGORY_LABEL[id])}</span>
                  <span className="duel-category__hint">{t(CATEGORY_HINT[id])}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="duel-home__section" aria-labelledby="duel-size-title">
            <h2 id="duel-size-title" className="duel-home__label">
              {t('duel.size.title')}
            </h2>
            <div className="duel-sizes duel-pickmode" role="radiogroup" aria-label={t('duel.pick.title')}>
              {(['random', 'manual'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={pickMode === mode}
                  className={`duel-size${pickMode === mode ? ' duel-size--selected' : ''}`}
                  onClick={() => setPickMode(mode)}
                >
                  {t(mode === 'random' ? 'duel.pick.random' : 'duel.pick.manual')}
                </button>
              ))}
            </div>
            {plan === null ? (
              <p className="duel-home__note">{t('duel.size.searching')}</p>
            ) : manual ? (
              <>
                <ModelPicker plan={plan} picked={pickedNow} onToggle={toggle} />
                <p className={`duel-home__note${pickedNow.length >= DUEL_MIN_CHOSEN ? '' : ' duel-home__note--warn'}`} role="status">
                  {t('duel.pick.chosen', { count: pickedNow.length, min: DUEL_MIN_CHOSEN })}
                </p>
                {pickedNow.length > 0 && (
                  <p className={`duel-home__note${pickedFitsDisk ? '' : ' duel-home__note--warn'}`}>
                    {pickedMissing.length === 0
                      ? t('duel.size.installed')
                      : t('duel.size.download', { count: pickedMissing.length, size: gb(pickedDownloadGb) })}
                    {!pickedFitsDisk && ` ${t('duel.size.noDisk', { free: gb(plan.freeDiskGb ?? 0) })}`}
                  </p>
                )}
              </>
            ) : tooFew ? (
              <p className="duel-home__note duel-home__note--warn">
                {t('duel.notEnough')}{' '}
                {t('duel.notEnough.machine', {
                  gpu:
                    plan.machine?.vramGb == null
                      ? t('duel.machine.noGpu')
                      : t('duel.machine.gpu', { vram: formatDecimal(plan.machine.vramGb) }),
                  ram: plan.machine?.ramGb ?? '?',
                  count: plan.available
                })}
              </p>
            ) : (
              <>
                <div className="duel-sizes" role="radiogroup" aria-labelledby="duel-size-title">
                  {plan.sizes.map((option) => (
                    <button
                      key={option.count}
                      type="button"
                      role="radio"
                      aria-checked={size === option.count}
                      className={`duel-size${size === option.count ? ' duel-size--selected' : ''}`}
                      onClick={() => setSize(option.count)}
                    >
                      {option.count}
                    </button>
                  ))}
                </div>
                {chosen && (
                  <p className={`duel-home__note${chosen.fitsDisk ? '' : ' duel-home__note--warn'}`}>
                    {chosen.toDownload === 0
                      ? t('duel.size.installed')
                      : t('duel.size.download', { count: chosen.toDownload, size: gb(chosen.downloadGb) })}
                    {!chosen.fitsDisk && ` ${t('duel.size.noDisk', { free: gb(plan.freeDiskGb ?? 0) })}`}
                  </p>
                )}
              </>
            )}
          </section>

          <ul className="duel-home__facts">
            <li>{t('duel.realActions')}</li>
            <li>{t('duel.anonymous')}</li>
          </ul>

          <button
            type="button"
            className="duel-btn duel-btn--primary duel-home__start"
            onClick={start}
            disabled={pending !== null || !canStart}
          >
            {pending === 'start' ? t('duel.starting') : t('duel.start')}
          </button>

          <section className="duel-home__section duel-ranking" aria-labelledby="duel-ranking-title">
            <div className="duel-ranking__head">
              <h2 id="duel-ranking-title" className="duel-home__label">
                {t('duel.ranking.title')} · {t(CATEGORY_LABEL[category])}
              </h2>
              <HistoryButton onClick={openHistory} />
            </div>
            {ranking && ranking.ranking.length > 0 ? (
              <ol className="duel-ranking__list">
                {ranking.ranking.map((row) => (
                  <li key={row.model} className="duel-ranking__row">
                    <span className="duel-ranking__model" title={row.model}>
                      {formatModelName(row.model)}
                    </span>
                    <RankingStats row={row} />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="duel-home__note">{t('duel.ranking.empty')}</p>
            )}
            <p className="duel-home__note">{t('duel.ranking.legend')}</p>
          </section>
        </div>
      </div>
    )
  } else if (view.phase === 'preparing') {
    const preparing = view.preparing
    content = (
      <div className="duel__scroll duel__center">
        <div className="duel-preparing" role="status">
          <h1 className="duel-preparing__title">{t('duel.preparing.title')}</h1>
          <p className="duel-preparing__step">
            {preparing ? t('duel.preparing.download', { index: preparing.done + 1, total: preparing.total }) : t('duel.preparing.ready')}
          </p>
          {preparing && (
            <div className="duel-progress" aria-hidden="true">
              <span className="duel-progress__fill" style={{ width: `${Math.max(2, Math.min(100, preparing.percent ?? 0))}%` }} />
            </div>
          )}
          {preparing?.percent != null && <p className="duel-preparing__percent">{formatPercent(preparing.percent / 100)}</p>}
          <p className="duel-home__note">{t('duel.preparing.hidden')}</p>
          {view.dropped > 0 && <p className="duel-home__note duel-home__note--warn">{t('duel.dropped', { count: view.dropped })}</p>}
          <button type="button" className="duel-btn" onClick={end} disabled={pending !== null}>
            {t('duel.stopSession')}
          </button>
        </div>
      </div>
    )
  } else if (view.phase === 'ready' && !round) {
    // Ne devrait pas arriver (une session prête a toujours un duel) : de quoi terminer quand même.
    content = (
      <div className="duel__scroll duel__center">
        <div className="duel-preparing">
          <p className="duel-home__note">{t('duel.preparing.ready')}</p>
          <button type="button" className="duel-btn" onClick={end} disabled={pending !== null}>
            {t('duel.end')}
          </button>
        </div>
      </div>
    )
  } else if (view.phase === 'ready' && round) {
    const bothDone = finished(round.a) && finished(round.b)
    // Un outil de Jaris a échoué : ce duel ne compte pas (rien n'est voté contre un modèle pour une panne de Jaris).
    const trouble = Boolean(round.a.trouble || round.b.trouble)
    const noneRunning = round.a.status !== 'running' && round.b.status !== 'running'
    content = (
      <>
        <div className="duel__bar">
          <span className="duel__bar-title">
            {t('duel.header', { number: round.number, category: t(CATEGORY_LABEL[view.category]) })}
          </span>
          <span className="duel__bar-meta">
            {t('duel.votesCount', { count: view.votes })}
            {view.dropped > 0 && ` · ${t('duel.dropped', { count: view.dropped })}`}
          </span>
          <HistoryButton onClick={openHistory} />
          <button type="button" className="duel-btn duel__bar-end" onClick={end} disabled={pending !== null}>
            {t('duel.end')}
          </button>
        </div>

        {round.prompt === null ? (
          <div className="duel__ask">
            <EmptyState
              title={t('duel.ask.title')}
              description={t('duel.ask.hint')}
              suggestions={SUGGESTIONS[view.category].map((key) => t(key))}
              onSuggestion={setPrompt}
            />
          </div>
        ) : (
          <div className="duel__scroll">
            <div className="duel-round">
              <div className="duel-round__prompt">
                <span className="duel-round__prompt-label">{t('duel.yourPrompt')}</span>
                <p>{round.prompt}</p>
              </div>
              <div className={`duel-round__sides${view.category === 'code' ? ' duel-round__sides--code' : ''}`}>
                <SideCard
                  name="a"
                  side={round.a}
                  category={view.category}
                  now={now}
                  playing={playing === 'a'}
                  onStop={stop}
                  onListen={() => void play('a')}
                  model={round.revealed?.a ?? null}
                />
                {round.b.status === 'idle' ? (
                  <section className="duel-side duel-side--idle" aria-label={t('duel.side.b')}>
                    <header className="duel-side__head">
                      <span className="duel-side__name">
                        <span className="duel-side__letter" aria-hidden="true">
                          B
                        </span>
                        {t('duel.side.b')}
                      </span>
                      <span className="duel-side__status">{t('duel.status.waiting')}</span>
                    </header>
                    {finished(round.a) && round.a.trouble ? (
                      <p className="duel-side__muted">{t('duel.trouble.waitB')}</p>
                    ) : finished(round.a) ? (
                      <div className="duel-side__turn">
                        <p>{t('duel.waitB')}</p>
                        <button type="button" className="duel-btn duel-btn--primary" onClick={runB} disabled={pending !== null}>
                          {t('duel.runB')}
                        </button>
                      </div>
                    ) : (
                      <p className="duel-side__muted">{t('duel.waitA')}</p>
                    )}
                  </section>
                ) : (
                  <SideCard
                    name="b"
                    side={round.b}
                    category={view.category}
                    now={now}
                    playing={playing === 'b'}
                    onStop={stop}
                    onListen={() => void play('b')}
                    model={round.revealed?.b ?? null}
                  />
                )}
              </div>

              {trouble && noneRunning && (
                <div className="duel-vote duel-vote--trouble" role="group" aria-labelledby="duel-trouble-title">
                  <h2 id="duel-trouble-title" className="duel-vote__title">
                    {t('duel.trouble.title')}
                  </h2>
                  <p className="duel-vote__text">{t('duel.trouble.text')}</p>
                  <div className="duel-vote__buttons">
                    <button type="button" className="duel-btn duel-btn--primary" onClick={retry} disabled={pending !== null}>
                      {t('duel.trouble.retry')}
                    </button>
                    <button type="button" className="duel-btn" onClick={skip} disabled={pending !== null}>
                      {t('duel.trouble.skip')}
                    </button>
                  </div>
                </div>
              )}

              {round.revealed && (
                <div className="duel-vote duel-vote--revealed" role="group" aria-labelledby="duel-revealed-title">
                  <h2 id="duel-revealed-title" className="duel-vote__title">
                    {t('duel.revealed.title')}
                  </h2>
                  <p className="duel-vote__text">
                    {t('duel.summary.versus', { a: formatModelName(round.revealed.a), b: formatModelName(round.revealed.b) })}
                    {' · '}
                    {outcomeLabel({ outcome: round.revealed.outcome, modelA: round.revealed.a, modelB: round.revealed.b })}
                  </p>
                  <div className="duel-vote__buttons">
                    <button type="button" className="duel-btn duel-btn--primary" onClick={next} disabled={pending !== null}>
                      {t('duel.next')}
                    </button>
                  </div>
                </div>
              )}

              {bothDone && !trouble && !round.revealed && (
                <div className="duel-vote" role="group" aria-labelledby="duel-vote-title">
                  <h2 id="duel-vote-title" className="duel-vote__title">
                    {t('duel.vote.title')}
                  </h2>
                  <div className="duel-vote__buttons">
                    {OUTCOMES.map(({ outcome, label }) => (
                      <button
                        key={outcome}
                        type="button"
                        className={`duel-btn duel-vote__button duel-vote__button--${outcome}`}
                        onClick={() => vote(outcome)}
                        disabled={pending !== null}
                      >
                        {t(label)}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {error && <p className="duel__error">{error}</p>}

        {round.prompt === null && (
          <Composer
            value={prompt}
            onChange={setPrompt}
            onSubmit={ask}
            placeholder={t('duel.ask.placeholder')}
            submitLabel={t('duel.ask.submit')}
            busyLabel={t('common.loading')}
            busy={pending === 'ask'}
            attachment={null}
            onAttachmentChange={() => {}}
            onError={setError}
            imagesAllowed={false}
            submitOnEnter={view.category !== 'code'}
            rows={2}
          />
        )}
      </>
    )
  } else {
    // Fin de session : les noms sont révélés.
    const summary = ended && ended.id === view.id ? ended.summary : null
    const deletable = summary ? summary.downloaded.filter((d) => !d.inUse && !deleted?.deleted.includes(d.model)) : []
    const deletableGb = deletable.reduce((sum, d) => sum + d.sizeGb, 0)
    content = (
      <div className="duel__scroll">
        <div className="duel-summary">
          <h1 className="duel-summary__title">{t('duel.summary.title')}</h1>
          <p className="duel-summary__lead">{t('duel.summary.lead')}</p>
          {view.error && <p className="duel-home__note duel-home__note--warn">{view.error}</p>}

          {!summary ? (
            <p className="duel-home__note">{t('common.loading')}</p>
          ) : (
            <>
              <section className="duel-summary__section">
                <h2 className="duel-home__label">{t('duel.summary.rounds')}</h2>
                {summary.rounds.length === 0 ? (
                  <p className="duel-home__note">{t('duel.summary.noRounds')}</p>
                ) : (
                  <ol className="duel-summary__rounds">
                    {summary.rounds.map((r, index) => (
                      <li key={index} className="duel-summary__round">
                        <p className="duel-summary__round-prompt">{r.prompt}</p>
                        <p className="duel-summary__round-models">
                          {t('duel.summary.versus', { a: formatModelName(r.modelA), b: formatModelName(r.modelB) })}
                        </p>
                        <p className={`duel-summary__outcome duel-summary__outcome--${r.outcome}`}>
                          {r.outcome === 'a' || r.outcome === 'b'
                            ? t('duel.outcome.winner', { model: formatModelName(r.outcome === 'a' ? r.modelA : r.modelB) })
                            : t(r.outcome === 'tie' ? 'duel.vote.tie' : 'duel.outcome.bothBad')}
                        </p>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              <section className="duel-summary__section">
                <div className="duel-ranking__head">
                  <h2 className="duel-home__label">
                    {t('duel.ranking.title')} · {t(CATEGORY_LABEL[summary.category])}
                  </h2>
                  <HistoryButton onClick={openHistory} />
                </div>
                {summary.ranking.length ? (
                  <ol className="duel-ranking__list">
                    {summary.ranking.map((row) => (
                      <li key={row.model} className="duel-ranking__row">
                        <span className="duel-ranking__model" title={row.model}>
                          {formatModelName(row.model)}
                        </span>
                        <RankingStats row={row} />
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="duel-home__note">{t('duel.ranking.empty')}</p>
                )}
              </section>

              <section className="duel-summary__section">
                <h2 className="duel-home__label">{t('duel.summary.changes')}</h2>
                {summary.changes.length === 0 ? (
                  <p className="duel-home__note">{t('duel.summary.noChanges')}</p>
                ) : (
                  <ul className="duel-summary__changes">
                    {summary.changes.map((change) => {
                      const role = t(ROLE_LABEL[change.role])
                      return (
                        <li key={change.role}>
                          <span>
                            {t('duel.summary.change', {
                              role: summary.category === 'voice' && change.role !== 'code' ? t('role.voice', { role }) : role,
                              from: change.from ? formatModelName(change.from) : t('duel.summary.none'),
                              to: formatModelName(change.to)
                            })}
                          </span>
                          <span className={`duel-summary__state${change.applied ? ' duel-summary__state--ok' : ''}`}>
                            {change.applied ? t('duel.summary.applied') : t('duel.summary.pending')}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </section>

              {summary.downloaded.length > 0 && (
                <section className="duel-summary__section">
                  <h2 className="duel-home__label">{t('duel.summary.downloaded')}</h2>
                  <ul className="duel-summary__downloads">
                    {summary.downloaded.map((d) => (
                      <li key={d.model}>
                        <span title={d.model}>{formatModelName(d.model)}</span>
                        <span className="duel-summary__state">
                          {d.inUse ? t('duel.summary.inUse') : deleted?.deleted.includes(d.model) ? t('duel.summary.removed') : gb(d.sizeGb)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {deletable.length > 0 && (
                    <button
                      type="button"
                      className="duel-btn"
                      onClick={() => removeDownloaded(deletable.map((d) => d.model))}
                      disabled={pending !== null}
                    >
                      {pending === 'delete' ? t('common.deleting') : t('duel.summary.delete', { size: gb(deletableGb) })}
                    </button>
                  )}
                  {deleted?.failed.map((f) => (
                    <p key={f.model} className="duel-side__error">
                      {t('duel.summary.deleteFailed', { model: formatModelName(f.model), error: f.error })}
                    </p>
                  ))}
                </section>
              )}
            </>
          )}

          {error && <p className="duel__error">{error}</p>}
          <button type="button" className="duel-btn duel-btn--primary duel-summary__again" onClick={close} disabled={pending !== null}>
            {t('duel.summary.again')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="duel">
      {content}
      {(view === null || view.phase === 'preparing' || (view.phase === 'ready' && !round)) && error && <p className="duel__error">{error}</p>}
      {/* Duel Vocal : la réponse lue, une seule à la fois. */}
      <audio ref={audioRef} onEnded={() => setPlaying(null)} hidden />
    </div>
  )
}
