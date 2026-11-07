import { useEffect, useState } from 'react'
import type { MachineView } from '../../shared/machine'
import { ipcErrorMessage } from '../lib/ipcError'
import { formatDecimal, t } from '@/lib/i18n'

/**
 * Étape 437 (Léo : « un bouton à gauche, Machine, il explique, tu lui dis combien de stockage, de VRAM, etc. ; et
 * maintenant tout Jaris tourne sur le VPS, si je vais dans Analyse et que je lance, ça se fait sur le VPS, et après je
 * peux déconnecter ») : connecter une machine louée (Hostinger, RunPod…). Tant qu'elle est connectée, le Duel et l'Analyse
 * y font tourner leurs modèles (étape 439 : rien n'y est téléchargé à la connexion) ; le reste de Jaris reste sur ce PC.
 * Les réglages sont revérifiés côté main (connectMachine) ; l'écran ne fait que les transmettre.
 */

/** « 24 », « 24,5 » ou « 24.5 » ; NaN si ce n'est pas un nombre (le main refuse alors avec une phrase claire). */
function typedNumber(value: string): number {
  const text = value.trim().replace(',', '.')
  return text ? Number(text) : Number.NaN
}

export default function MachinePanel(): JSX.Element {
  const [view, setView] = useState<MachineView | null>(null)
  const [host, setHost] = useState('')
  const [vram, setVram] = useState('')
  const [ram, setRam] = useState('')
  const [disk, setDisk] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.jaris
      .machineGet()
      .then((next) => {
        if (!alive) return
        setView(next)
        // Pré-remplis une seule fois avec la dernière machine : Léo n'a qu'à cliquer « Connecter ».
        if (next.saved) {
          setHost((current) => current || next.saved!.host)
          setVram((current) => current || String(next.saved!.vramGb))
          setRam((current) => current || String(next.saved!.ramGb))
          setDisk((current) => current || String(next.saved!.diskGb))
        }
      })
      .catch((err) => alive && setError(ipcErrorMessage(err)))
    const stop = window.jaris.onMachineChanged((next) => alive && setView(next))
    return () => {
      alive = false
      stop()
    }
  }, [])

  const connect = async (): Promise<void> => {
    setSending(true)
    setError(null)
    try {
      setView(
        await window.jaris.machineConnect({ host, vramGb: typedNumber(vram), ramGb: typedNumber(ram), diskGb: typedNumber(disk) })
      )
    } catch (err) {
      setError(ipcErrorMessage(err))
    } finally {
      setSending(false)
    }
  }

  const disconnect = async (): Promise<void> => {
    setSending(true)
    setError(null)
    try {
      setView(await window.jaris.machineDisconnect())
    } catch (err) {
      setError(ipcErrorMessage(err))
    } finally {
      setSending(false)
    }
  }

  const connected = view?.connected === true
  const connecting = sending || view?.connecting === true
  const shownError = error ?? view?.error ?? null
  const busyNote = view?.busy === 'test' ? t('machine.busyTest') : null

  return (
    <div className="machine-page">
      <div className="machine-page__inner">
        <h1 className="machine-page__title">{t('machine.title')}</h1>
        <p className="machine-page__lead">{t('machine.lead')}</p>

        {connected && view ? (
          <section className="machine-page__card machine-page__card--on" aria-live="polite">
            <p className="machine-page__status">
              <span className="machine-page__dot" aria-hidden="true" />
              {t('machine.connected', { host: view.saved?.host ?? '', version: view.version ?? '?' })}
            </p>
            {view.saved && (
              <p className="machine-page__note">
                {t('machine.summary', {
                  vram: formatDecimal(view.saved.vramGb),
                  ram: formatDecimal(view.saved.ramGb),
                  disk: formatDecimal(view.saved.diskGb)
                })}
              </p>
            )}
            {view.freeDiskGb !== null && <p className="machine-page__note">{t('machine.free', { gb: formatDecimal(view.freeDiskGb) })}</p>}
            <p className="machine-page__note">{t('machine.connectedHint')}</p>
            <div className="machine-page__actions">
              <button type="button" className="duel-btn" onClick={() => void disconnect()} disabled={connecting || view.busy === 'test'}>
                {t('machine.disconnect')}
              </button>
            </div>
          </section>
        ) : (
          <>
            <ol className="machine-page__steps">
              <li>{t('machine.step1')}</li>
              <li>{t('machine.step2')}</li>
              <li>{t('machine.step3')}</li>
              <li>{t('machine.step4')}</li>
            </ol>
            <section className="machine-page__card">
              <div className="duel-remote__fields machine-page__fields">
                <label className="duel-remote__field duel-remote__field--host">
                  <span>{t('machine.host')}</span>
                  <input
                    type="url"
                    value={host}
                    placeholder="http://123.45.67.89:11434"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) => setHost(event.target.value)}
                  />
                </label>
                <label className="duel-remote__field">
                  <span>{t('machine.vram')}</span>
                  <input type="text" inputMode="decimal" value={vram} placeholder="80" onChange={(event) => setVram(event.target.value)} />
                </label>
                <label className="duel-remote__field">
                  <span>{t('machine.ram')}</span>
                  <input type="text" inputMode="decimal" value={ram} placeholder="64" onChange={(event) => setRam(event.target.value)} />
                </label>
                <label className="duel-remote__field">
                  <span>{t('machine.disk')}</span>
                  <input type="text" inputMode="decimal" value={disk} placeholder="100" onChange={(event) => setDisk(event.target.value)} />
                </label>
              </div>
              <div className="machine-page__actions">
                <button
                  type="button"
                  className="duel-btn duel-btn--primary"
                  onClick={() => void connect()}
                  disabled={connecting || view?.busy === 'test'}
                >
                  {connecting ? t('machine.connecting') : t('machine.connect')}
                </button>
              </div>
              <p className="machine-page__note">{t('machine.privacy')}</p>
            </section>
          </>
        )}

        {busyNote && <p className="machine-page__note machine-page__note--warn">{busyNote}</p>}
        {shownError && (
          <p className="machine-page__note machine-page__note--warn" role="alert">
            {shownError}
          </p>
        )}
      </div>
    </div>
  )
}
