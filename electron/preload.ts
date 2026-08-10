import { contextBridge } from 'electron'

// Le bridge sera étendu dans les prochaines étapes (contrôle PC, rappels,
// capture d'écran, vision, mails...). Pour l'instant il n'expose rien.
const api = {}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
} else {
  // @ts-expect-error (define in dts)
  window.api = api
}
