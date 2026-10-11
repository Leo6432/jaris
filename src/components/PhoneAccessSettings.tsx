import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { PhoneAccessStatus, PhonePairing } from '../../shared/ipc'
import { formatRecentDate } from '@/lib/formatRecentDate'
import { SettingGroup, SettingRow, Toggle } from './SettingsLayout'
import { t } from '@/lib/i18n'

/** « 12345678 » -> « 1234 5678 » : plus facile à recopier sur un téléphone. */
export function formatPairingCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code
}

function minutesLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 60_000))
}

/**
 * Options → Téléphone (étape 214, Léo : « on va faire parler depuis son téléphone », partout, confidentiel,
 * sans appli à installer à côté). Tailscale est embarqué dans Jaris : la seule démarche est de se connecter
 * une fois à un compte Tailscale gratuit, puis d'autoriser l'adresse web de Jaris. Chaque étape dit ce qu'il
 * faut faire, dans l'ordre, au lieu d'un écran de configuration à deviner.
 */
export default function PhoneAccessSettings(): JSX.Element {
  const [status, setStatus] = useState<PhoneAccessStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [pairing, setPairing] = useState<PhonePairing | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState<string | null>(null)
  const [confirmLogout, setConfirmLogout] = useState(false)

  useEffect(() => {
    void window.jaris.getPhoneAccess().then(setStatus)
    return window.jaris.onPhoneAccessChanged((next) => setStatus(next))
  }, [])

  // Le code expire au bout de 10 minutes : le compte à rebours le dit, puis le QR disparaît.
  useEffect(() => {
    if (!pairing) return
    const timer = setInterval(() => setNow(Date.now()), 5000)
    return () => clearInterval(timer)
  }, [pairing])
  useEffect(() => {
    if (pairing && now >= pairing.expiresAt) setPairing(null)
  }, [now, pairing])

  // Un téléphone vient de se connecter avec le code affiché : on ferme le code, le travail est fait.
  const deviceCount = status?.devices.length ?? 0
  const [devicesAtPairing, setDevicesAtPairing] = useState(0)
  useEffect(() => {
    if (pairing && deviceCount > devicesAtPairing) setPairing(null)
  }, [deviceCount, devicesAtPairing, pairing])

  useEffect(() => {
    if (!pairing) {
      setQr(null)
      return
    }
    void QRCode.toDataURL(pairing.link, { margin: 1, width: 220, color: { dark: '#01040a', light: '#e6f7ff' } }).then(setQr)
  }, [pairing])

  const run = async (action: () => Promise<PhoneAccessStatus | void>): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await action()
      if (next) setStatus(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const showPairing = (): void =>
    void run(async () => {
      setDevicesAtPairing(deviceCount)
      const pairing = await window.jaris.createPhonePairing()
      // APRÈS la création du code : pris avant, le moindre délai faisait afficher « 11 min » au lieu de 10.
      setNow(Date.now())
      setPairing(pairing)
    })

  if (!status) return <div className="options-menu__section" />

  const enabled = status.state !== 'off' && status.state !== 'unsupported'

  return (
    <div className="options-menu__section phone-access">
      <SettingGroup
        title={t('phone.group')}
        description={t('phone.group.hint')}
      >
        <SettingRow
          label={t('phone.access')}
          description={status.state === 'unsupported' ? status.message : t('phone.access.hint')}
        >
          <Toggle
            label={t('phone.access')}
            checked={enabled}
            disabled={busy || status.state === 'unsupported'}
            onChange={(next) => {
              setPairing(null)
              void run(() => window.jaris.setPhoneAccessEnabled(next))
            }}
          />
        </SettingRow>
        <p className="phone-access__safety">
          {t('phone.safety')}
        </p>
      </SettingGroup>

      {status.state === 'starting' && <p className="phone-access__step">{status.message ?? t('phone.starting')}</p>}

      {status.state === 'login' && (
        <div className="phone-access__step phone-access__step--action">
          <strong>{t('phone.step1')}</strong>
          <p>{t('phone.step1.hint')}</p>
          <button className="options-menu__action" onClick={() => void window.jaris.openPhoneAccessLink()}>
            {t('phone.step1.open')}
          </button>
        </div>
      )}

      {status.state === 'enable_funnel' && (
        <div className="phone-access__step phone-access__step--action">
          <strong>{t('phone.step2')}</strong>
          <p>{t('phone.step2.hint')}</p>
          {status.actionUrl ? (
            <button className="options-menu__action" onClick={() => void window.jaris.openPhoneAccessLink()}>
              {t('phone.step2.open')}
            </button>
          ) : (
            status.message && <p>{status.message}</p>
          )}
        </div>
      )}

      {status.state === 'error' && (
        <div className="phone-access__step phone-access__step--error">
          <strong>{t('phone.error')}</strong>
          <p>{status.message}</p>
          <button className="options-menu__action" disabled={busy} onClick={() => void run(() => window.jaris.setPhoneAccessEnabled(true))}>
            {t('common.retry')}
          </button>
        </div>
      )}

      {status.state === 'ready' && (
        <SettingGroup title={t('phone.connect')}>
          {status.message && <p className="phone-access__step phone-access__step--error">{status.message}</p>}
          <SettingRow label={t('phone.address')} description={<span className="phone-access__address">{status.address}</span>}>
            <button className="options-menu__action" disabled={busy} onClick={showPairing}>
              {pairing ? t('phone.newCode') : t('phone.connect')}
            </button>
          </SettingRow>
          {pairing && (
            <div className="phone-access__pairing">
              {qr && <img className="phone-access__qr" src={qr} alt={t('phone.qr.alt')} />}
              <div className="phone-access__pairing-text">
                <ol>
                  <li>{t('phone.pair.scan')}</li>
                  <li>{t('phone.pair.homeScreen')}</li>
                </ol>
                <p>
                  {t('phone.pair.code')}
                  <span className="phone-access__code">{formatPairingCode(pairing.code)}</span>
                </p>
                <p className="phone-access__expiry">{t('phone.pair.expiry', { minutes: minutesLeft(pairing.expiresAt, now) })}</p>
              </div>
            </div>
          )}
        </SettingGroup>
      )}

      {enabled && (
        <SettingGroup title={t('phone.devices')}>
          {status.devices.length === 0 ? (
            <p className="phone-access__empty">{t('phone.devices.none')}</p>
          ) : (
            status.devices.map((device) => (
              <SettingRow key={device.id} label={device.name} description={t('phone.device.meta', { created: formatRecentDate(Date.parse(device.createdAt)).toLowerCase(), seen: formatRecentDate(Date.parse(device.lastSeenAt)).toLowerCase() })}>
                <button className="options-menu__action" disabled={busy} onClick={() => void run(() => window.jaris.removePhoneDevice(device.id))}>
                  {t('phone.device.disconnect')}
                </button>
              </SettingRow>
            ))
          )}
          <SettingRow
            label={t('phone.logout')}
            description={t('phone.logout.hint')}
          >
            {confirmLogout ? (
              <span className="phone-access__confirm">
                <button
                  className="options-menu__action options-menu__action--danger"
                  disabled={busy}
                  onClick={() => {
                    setConfirmLogout(false)
                    setPairing(null)
                    void run(() => window.jaris.logoutPhoneAccess())
                  }}
                >
                  {t('common.confirm')}
                </button>
                <button className="options-menu__action" onClick={() => setConfirmLogout(false)}>
                  {t('common.cancel')}
                </button>
              </span>
            ) : (
              <button className="options-menu__action" disabled={busy} onClick={() => setConfirmLogout(true)}>
                {t('common.logout')}
              </button>
            )}
          </SettingRow>
        </SettingGroup>
      )}

      {error && <p className="options-menu__error">{error}</p>}
    </div>
  )
}
