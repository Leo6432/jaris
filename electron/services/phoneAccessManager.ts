import { EventEmitter } from 'events'
import type { PhoneAccessStatus, PhonePairing } from '../../shared/ipc'
import { PhoneDeviceStore } from './phoneDevices'
import { PhoneServer, type PhoneServerDeps } from './phoneServer'
import { PhoneTunnel, type TunnelState } from './phoneTunnel'

export interface PhoneAccessOptions {
  tunnelBinary: string
  tunnelStateDir: string
  devicesFile: string
  pageDir: string
  sendMessage: PhoneServerDeps['sendMessage']
  transcribe: PhoneServerDeps['transcribe']
  history: PhoneServerDeps['history']
  /** Pour les tests : remplace le vrai tunnel. */
  tunnel?: PhoneTunnel
}

/**
 * Accès depuis le téléphone (étape 214) : assemble le serveur local, le tunnel Tailscale et la liste des
 * téléphones appairés, et résume le tout en un seul état pour Options → Téléphone.
 */
export class PhoneAccessManager extends EventEmitter {
  readonly devices: PhoneDeviceStore
  private readonly server: PhoneServer
  private readonly tunnel: PhoneTunnel

  constructor(options: PhoneAccessOptions) {
    super()
    this.devices = new PhoneDeviceStore(options.devicesFile)
    this.server = new PhoneServer({
      sendMessage: options.sendMessage,
      transcribe: options.transcribe,
      history: options.history,
      devices: this.devices,
      pageDir: options.pageDir
    })
    this.tunnel = options.tunnel ?? new PhoneTunnel(options.tunnelBinary, options.tunnelStateDir)
    this.tunnel.on('change', () => void this.notify())
  }

  private async notify(): Promise<void> {
    this.emit('change', await this.status())
  }

  async status(): Promise<PhoneAccessStatus> {
    const tunnel: TunnelState = this.tunnel.state
    const devices = await this.devices.list()
    switch (tunnel.state) {
      case 'login':
        return { state: 'login', actionUrl: tunnel.actionUrl, devices }
      case 'enable_funnel':
        return { state: 'enable_funnel', actionUrl: tunnel.actionUrl, message: tunnel.message, devices }
      case 'ready':
        return { state: 'ready', address: tunnel.address, devices }
      case 'error':
      case 'unsupported':
        return { state: tunnel.state, message: tunnel.message, devices }
      default:
        return { state: tunnel.state, devices }
    }
  }

  /** Démarre le serveur local puis le tunnel vers lui. */
  async enable(): Promise<void> {
    const port = await this.server.listen()
    this.tunnel.start(port)
  }

  /** Coupe l'accès : plus aucune requête du téléphone n'atteint Jaris. Les téléphones restent appairés. */
  async disable(): Promise<void> {
    this.tunnel.stop()
    await this.server.close()
  }

  /** Nouveau code, uniquement quand l'adresse est prête (sinon le téléphone n'aurait rien à ouvrir). */
  createPairing(): PhonePairing {
    const tunnel = this.tunnel.state
    if (tunnel.state !== 'ready') throw new Error("L'adresse du téléphone n'est pas encore prête.")
    const { code, expiresAt } = this.server.createPairingCode()
    // Le code voyage après le « # » : il n'est jamais envoyé dans une requête ni gardé dans un journal web.
    return { code, expiresAt, link: `${tunnel.address}/#code=${code}` }
  }

  async removeDevice(id: string): Promise<void> {
    await this.devices.remove(id)
    await this.notify()
  }

  /** Déconnecte ce PC de Tailscale et oublie tous les téléphones : repartir de zéro. */
  async logout(): Promise<void> {
    await this.server.close()
    await this.tunnel.logout()
    await this.devices.removeAll()
    await this.notify()
  }
}
