import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type { PhoneAccessStatus, PhonePairing } from '../../shared/ipc'
import { formatRecentDate } from '@/lib/formatRecentDate'
import { SettingGroup, SettingRow, Toggle } from './SettingsLayout'

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
      setNow(Date.now())
      setPairing(await window.jaris.createPhonePairing())
    })

  if (!status) return <div className="options-menu__section" />

  const enabled = status.state !== 'off' && status.state !== 'unsupported'

  return (
    <div className="options-menu__section phone-access">
      <SettingGroup
        title="Parler à Jaris depuis ton téléphone"
        description="Écris ou envoie des messages vocaux à Jaris depuis ton téléphone, même loin de chez toi en 4G. C'est la même conversation que le Chat."
      >
        <SettingRow
          label="Accès depuis le téléphone"
          description={
            status.state === 'unsupported'
              ? status.message
              : 'Chiffré de bout en bout par Tailscale (gratuit) : personne d’autre ne lit tes messages, pas même Tailscale. Rien à installer sur le téléphone.'
          }
        >
          <Toggle
            label="Accès depuis le téléphone"
            checked={enabled}
            disabled={busy || status.state === 'unsupported'}
            onChange={(next) => {
              setPairing(null)
              void run(() => window.jaris.setPhoneAccessEnabled(next))
            }}
          />
        </SettingRow>
        <p className="phone-access__safety">
          Pour ta sécurité, depuis le téléphone Jaris ne peut ni taper, ni cliquer, ni regarder ton écran, ni éteindre le PC.
        </p>
      </SettingGroup>

      {status.state === 'starting' && <p className="phone-access__step">Démarrage de la connexion…</p>}

      {status.state === 'login' && (
        <div className="phone-access__step phone-access__step--action">
          <strong>Étape 1 sur 2 : connecte ce PC à Tailscale</strong>
          <p>
            Une page s'est ouverte dans ton navigateur : crée un compte gratuit ou connecte-toi avec Google ou Microsoft. Une seule
            fois : Jaris s'en souviendra.
          </p>
          <button className="options-menu__action" onClick={() => void window.jaris.openPhoneAccessLink()}>
            Ouvrir la page de connexion
          </button>
        </div>
      )}

      {status.state === 'enable_funnel' && (
        <div className="phone-access__step phone-access__step--action">
          <strong>Étape 2 sur 2 : autorise l'adresse web de Jaris</strong>
          <p>Sur ton compte Tailscale, un clic suffit pour que ton téléphone puisse joindre Jaris de n'importe où.</p>
          {status.actionUrl ? (
            <button className="options-menu__action" onClick={() => void window.jaris.openPhoneAccessLink()}>
              Ouvrir la page d'autorisation
            </button>
          ) : (
            status.message && <p>{status.message}</p>
          )}
        </div>
      )}

      {status.state === 'error' && (
        <div className="phone-access__step phone-access__step--error">
          <strong>La connexion n'a pas pu démarrer</strong>
          <p>{status.message}</p>
          <button className="options-menu__action" disabled={busy} onClick={() => void run(() => window.jaris.setPhoneAccessEnabled(true))}>
            Réessayer
          </button>
        </div>
      )}

      {status.state === 'ready' && (
        <SettingGroup title="Connecter un téléphone">
          <SettingRow label="Adresse de ton Jaris" description={<span className="phone-access__address">{status.address}</span>}>
            <button className="options-menu__action" disabled={busy} onClick={showPairing}>
              {pairing ? 'Nouveau code' : 'Connecter un téléphone'}
            </button>
          </SettingRow>
          {pairing && (
            <div className="phone-access__pairing">
              {qr && <img className="phone-access__qr" src={qr} alt="QR code pour connecter le téléphone" />}
              <div className="phone-access__pairing-text">
                <ol>
                  <li>Scanne ce QR code avec l'appareil photo de ton téléphone.</li>
                  <li>
                    Ajoute la page à l'écran d'accueil : iPhone, <em>Partager → Sur l'écran d'accueil</em> ; Android, <em>menu ⋮ → Ajouter à
                    l'écran d'accueil</em>.
                  </li>
                </ol>
                <p>
                  Ou ouvre l'adresse ci-dessus et tape le code :
                  <span className="phone-access__code">{formatPairingCode(pairing.code)}</span>
                </p>
                <p className="phone-access__expiry">Valable encore {minutesLeft(pairing.expiresAt, now)} min, pour un seul téléphone.</p>
              </div>
            </div>
          )}
        </SettingGroup>
      )}

      {enabled && (
        <SettingGroup title="Téléphones connectés">
          {status.devices.length === 0 ? (
            <p className="phone-access__empty">Aucun téléphone pour l'instant.</p>
          ) : (
            status.devices.map((device) => (
              <SettingRow key={device.id} label={device.name} description={`Connecté ${formatRecentDate(Date.parse(device.createdAt)).toLowerCase()} · actif ${formatRecentDate(Date.parse(device.lastSeenAt)).toLowerCase()}`}>
                <button className="options-menu__action" disabled={busy} onClick={() => void run(() => window.jaris.removePhoneDevice(device.id))}>
                  Déconnecter
                </button>
              </SettingRow>
            ))
          )}
          <SettingRow
            label="Se déconnecter de Tailscale"
            description="Oublie ce PC sur ton compte Tailscale et déconnecte tous les téléphones. À refaire depuis le début ensuite."
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
                  Confirmer
                </button>
                <button className="options-menu__action" onClick={() => setConfirmLogout(false)}>
                  Annuler
                </button>
              </span>
            ) : (
              <button className="options-menu__action" disabled={busy} onClick={() => setConfirmLogout(true)}>
                Se déconnecter
              </button>
            )}
          </SettingRow>
        </SettingGroup>
      )}

      {error && <p className="options-menu__error">{error}</p>}
    </div>
  )
}
