import * as os from 'node:os'
import * as path from 'node:path'
import { loadTsModule } from './load-ts-module.mjs'

/**
 * Étape 500 : le VRAI jarisLocalDir.ts (dossier des moteurs de Jaris, hors d'AppData dans la version Store), branché
 * sur le faux `process` d'un test : sans lui, il lirait l'environnement du processus de test au lieu du sien.
 */
const real = loadTsModule('electron/services/jarisLocalDir.ts', { os, path })

export function jarisLocalDirFor(fakeProcess = process) {
  return {
    jarisLocalDir: (store = fakeProcess.windowsStore === true, env = fakeProcess.env ?? {}, home = os.homedir()) => real.jarisLocalDir(store, env, home)
  }
}
