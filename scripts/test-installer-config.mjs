import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

/**
 * electron-builder.yml — étape 142, Léo : « pouvoir choisir le dossier où mettre Jaris quand tu l'installes la
 * première fois ». Aucun Windows ici pour lancer le vrai installeur : ce test verrouille la configuration qui
 * produit l'écran « Dossier d'installation », et le fait que les mises à jour, elles, restent silencieuses.
 */
const yml = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')
const nsis = yml.slice(yml.indexOf('\nnsis:'))
const option = (name) => nsis.match(new RegExp(`^  ${name}: (.+)$`, 'm'))?.[1]?.trim()

test("l'installeur propose de choisir le dossier (installeur assisté, pas « un clic »)", () => {
  assert.equal(option('oneClick'), 'false', 'un installeur un clic n’a aucun écran pour choisir le dossier')
  assert.equal(option('allowToChangeInstallationDirectory'), 'true')
})

test("installation pour l'utilisateur courant par défaut : pas d'UAC imposé à chaque mise à jour", () => {
  assert.equal(option('perMachine'), 'false')
})

test('les mises à jour lancées par Jaris restent silencieuses et relancent Jaris', () => {
  const updater = readFileSync(new URL('../electron/services/appUpdater.ts', import.meta.url), 'utf8')
  assert.match(updater, /UPDATE_INSTALLER_ARGS = \['\/S', '--updated', '--force-run'\]/)
  assert.match(updater, /spawn\(installerPath, UPDATE_INSTALLER_ARGS,/)
})
