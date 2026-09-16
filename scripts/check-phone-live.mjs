// Vérification Windows volontaire : aucune action sortante, uniquement lecture et préparation.
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const folder = await mkdtemp(join(tmpdir(), 'jaris-phone-check-'))
try {
  const output = join(folder, 'bridge.cjs')
  await build({ stdin: { contents: "export * from './electron/services/phoneLink'; export { openApp } from './electron/services/appLauncher';", resolveDir: process.cwd() }, outfile: output, bundle: true, platform: 'node', format: 'cjs' })
  const { runPhoneBridge, resolvePhoneRecipient, openApp } = createRequire(import.meta.url)(output)
  const opened = await openApp('Mobile connecté')
  if (!opened.endsWith('a été lancé.')) throw Error(opened)
  try {
    const notes = await runPhoneBridge({ action: 'notifications' })
    console.log(JSON.stringify({ notificationsReadable: notes.ok, count: notes.notifications?.length }))
  } catch (error) { console.log(JSON.stringify({ notificationsError: error.message })); process.exitCode = 1 }
  // Le numéro est factice et prepareOnly empêche l'appel et l'envoi dans le pilote.
  for (const request of [
    { action: 'call', number: '0000000000', prepareOnly: true },
    { action: 'send', number: '0000000000', text: 'Test local Jaris : Bonjour à tous !', prepareOnly: true }
  ]) {
    try { console.log(JSON.stringify({ action: request.action, result: await runPhoneBridge(request) })) }
    catch (error) { console.log(JSON.stringify({ action: request.action, error: error.message })); process.exitCode = 1 }
  }
  // Ne journalise pas les coordonnées personnelles.
  if (process.argv[2]) {
    const number = await resolvePhoneRecipient(process.argv[2])
    console.log(JSON.stringify({ contactResolved: Boolean(number) }))
  }
} finally { await rm(folder, { recursive: true, force: true }) }
