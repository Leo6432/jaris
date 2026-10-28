/**
 * Étape 368 (Léo : « je peux pas cliquer sur Ajouter ») : l'aperçu isole la page (CSP sandbox sans
 * allow-same-origin), donc localStorage lève une erreur. Une liste de tâches qui enregistre AVANT d'afficher ne
 * réagissait jamais. Vérifié dans un vrai navigateur avec la VRAIE CSP de l'aperçu : clic sur Ajouter → tâche
 * affichée. Playwright n'est pas une dépendance du projet : tests ignorés s'il manque.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadTsModule } from './load-ts-module.mjs'

let chromium = null
try {
  ;({ chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs'))
} catch {
  chromium = null
}
const options = { skip: chromium ? false : 'Playwright indisponible dans cet environnement' }

const preview = loadTsModule('electron/services/generatedAppPreview.ts', { electron: { protocol: {} }, crypto: { randomUUID: () => 'x' } })
const page = readFileSync(new URL('./fixtures/todo-localstorage.html', import.meta.url), 'utf8')

async function addTask(html) {
  const browser = await chromium.launch(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {})
  try {
    const tab = await browser.newPage()
    await tab.route('http://localhost/app', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', headers: { 'Content-Security-Policy': preview.PREVIEW_CSP }, body: html })
    )
    await tab.goto('http://localhost/app')
    const mode = await tab.evaluate(() => document.compatMode)
    await tab.fill('#newTaskInput', 'Acheter du pain')
    await tab.click('#addTaskButton')
    await tab.waitForTimeout(150)
    const tasks = await tab.$$eval('.task-item', (items) => items.map((item) => item.textContent))
    const field = await tab.inputValue('#newTaskInput')
    return { tasks, field, mode }
  } finally {
    await browser.close()
  }
}

test('sans le correctif, la page de Léo ne réagit pas au clic (le défaut existe bien)', options, async () => {
  const result = await addTask(page)
  assert.deepEqual(result.tasks, [])
  assert.equal(result.field, 'Acheter du pain')
})

test('avec la mémoire de l’aperçu, « Ajouter » affiche la tâche et vide le champ', options, async () => {
  const result = await addTask(preview.withMemoryStorage(page))
  assert.deepEqual(result.tasks, ['Acheter du pain'])
  assert.equal(result.field, '')
  assert.equal(result.mode, 'CSS1Compat', 'le doctype doit rester en tête (pas de mode de compatibilité)')
})

test('le script est placé après <head>, sinon <html>, jamais avant le doctype', () => {
  const s = preview.MEMORY_STORAGE_SCRIPT
  assert.equal(preview.withMemoryStorage('<!DOCTYPE html><html><head lang="x"><title>t</title></head></html>'),
    `<!DOCTYPE html><html><head lang="x">${s}<title>t</title></head></html>`)
  assert.equal(preview.withMemoryStorage('<!doctype html><html lang="fr"><body>x</body></html>'), `<!doctype html><html lang="fr">${s}<body>x</body></html>`)
  assert.equal(preview.withMemoryStorage('<!DOCTYPE html><header>x</header>'), `<!DOCTYPE html>${s}<header>x</header>`)
  assert.equal(preview.withMemoryStorage('<p>x</p>'), `${s}<p>x</p>`)
})
