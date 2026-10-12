import { useEffect, useState, type ReactNode } from 'react'
import type { PhoneAccessStatus } from '../../shared/ipc'
import PhoneAccessSettings from './PhoneAccessSettings'
import { t } from '@/lib/i18n'

/**
 * Options → Jaris partout (étape 310, Léo : « à la place de téléphone trouve un nom, et là on va mettre toutes les
 * solutions pour parler avec Jaris : téléphone site, Discord, téléphone numéro… au pire mets bientôt disponible, et
 * fais un truc stylé avec les cases »). Une case par moyen de joindre Jaris loin du PC. Seul le téléphone existe
 * aujourd'hui : ses réglages restent juste en dessous, inchangés. Les autres disent honnêtement « Bientôt
 * disponible » et ne promettent rien de cliquable.
 */

/** Un téléphone (le site Jaris ouvert sur le téléphone). Même tracé arrondi que les autres icônes du projet. */
function PhoneIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="6.5" y="2.8" width="11" height="18.4" rx="2.4" />
      <path d="M10.5 5.8h3" />
      <path d="M11.2 18h1.6" />
    </svg>
  )
}

/** Une bulle de discussion (Discord), sans le logo de la marque. */
function ChatIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5.5 4.5h13a2 2 0 0 1 2 2v8.2a2 2 0 0 1-2 2h-6.8l-4.4 3.3v-3.3H5.5a2 2 0 0 1-2-2V6.5a2 2 0 0 1 2-2z" />
      <path d="M8.5 10.6h.01M12 10.6h.01M15.5 10.6h.01" strokeWidth="2.4" />
    </svg>
  )
}

/** Un avion en papier (Telegram), sans le logo de la marque. */
function PlaneIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20.5 4 3.8 10.6a.6.6 0 0 0 0 1.1l4.6 1.7 1.8 5.6a.6.6 0 0 0 1 .2l2.6-2.7 4.4 3.2a.6.6 0 0 0 1-.4L21.3 4.7a.6.6 0 0 0-.8-.7z" />
      <path d="m8.4 13.4 8.4-5.6-6.3 6.6" />
    </svg>
  )
}

/** Un combiné (appeler Jaris par un vrai numéro). */
function CallIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6.6 3.8h2.6l1.4 4.1-2 1.4a12 12 0 0 0 6.1 6.1l1.4-2 4.1 1.4v2.6a2 2 0 0 1-2.1 2A16.6 16.6 0 0 1 4.6 5.9a2 2 0 0 1 2-2.1z" />
      <path d="M14.6 4.2a5.6 5.6 0 0 1 5.2 5.2" />
    </svg>
  )
}

type ChannelState = 'on' | 'off' | 'soon'

const BADGE: Record<ChannelState, 'channels.on' | 'channels.off' | 'channels.soon'> = {
  on: 'channels.on',
  off: 'channels.off',
  soon: 'channels.soon'
}

function ChannelCard({ icon, title, text, state }: { icon: ReactNode; title: string; text: string; state: ChannelState }): JSX.Element {
  return (
    <li className={`channel-card channel-card--${state}`} aria-disabled={state === 'soon' ? true : undefined}>
      <span className="channel-card__icon">{icon}</span>
      <span className="channel-card__title">{title}</span>
      <span className="channel-card__text">{text}</span>
      <span className="channel-card__badge">{t(BADGE[state])}</span>
    </li>
  )
}

export default function AnywhereSettings(): JSX.Element {
  const [phone, setPhone] = useState<PhoneAccessStatus | null>(null)

  useEffect(() => {
    void window.jaris.getPhoneAccess().then(setPhone)
    return window.jaris.onPhoneAccessChanged((next) => setPhone(next))
  }, [])

  const phoneOn = phone !== null && phone.state !== 'off' && phone.state !== 'unsupported'

  return (
    <div className="options-menu__section anywhere">
      <ul className="channels" aria-label={t('channels.label')}>
        <ChannelCard icon={<PhoneIcon />} title={t('channels.phone.title')} text={t('channels.phone.text')} state={phoneOn ? 'on' : 'off'} />
        <ChannelCard icon={<ChatIcon />} title={t('channels.discord.title')} text={t('channels.discord.text')} state="soon" />
        <ChannelCard icon={<PlaneIcon />} title={t('channels.telegram.title')} text={t('channels.telegram.text')} state="soon" />
        <ChannelCard icon={<CallIcon />} title={t('channels.call.title')} text={t('channels.call.text')} state="soon" />
      </ul>
      <PhoneAccessSettings />
    </div>
  )
}
