import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import test from 'node:test'
import { loadPhoneModules } from './phone-test-loader.mjs'

/**
 * Étape 214 : le suivi du tunnel Tailscale (phoneTunnel.ts) avec un faux jaris-tunnel qui joue un scénario.
 * Ce qui compte : ne montrer et n'ouvrir QUE des adresses de Tailscale (une adresse inattendue dans la sortie
 * du programme ne doit jamais finir ouverte dans le navigateur), et ne jamais laisser le tunnel tourner seul.
 */

const { PhoneTunnel: RealPhoneTunnel, isTailscaleUrl } = loadPhoneModules().load('phoneTunnel')
// Le faux tunnel est un script Node lancé par Node lui-même : identique sous Linux et sur le runner Windows de
// la CI (où un fichier avec « #! » ne s'exécute pas tout seul).
const nodeSpawn = (bin, args, options) => spawn(process.execPath, [bin, ...args], options)
class PhoneTunnel extends RealPhoneTunnel {
  constructor(bin, dir) {
    super(bin, dir, nodeSpawn)
  }
}

function fakeTunnel(script) {
  const dir = mkdtempSync(join(tmpdir(), 'jaris-tunnel-fake-'))
  const path = join(dir, 'jaris-tunnel')
  writeFileSync(
    path,
    `#!/usr/bin/env node
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const steps = ${JSON.stringify(script)}
let i = 0
const next = () => {
  if (i >= steps.length) return
  const step = steps[i++]
  if (step.exit !== undefined) process.exit(step.exit)
  emit(step)
  setTimeout(next, 20)
}
next()
// stdin fermé = Jaris quitté : le tunnel s'arrête.
process.stdin.on('end', () => process.exit(0))
process.stdin.resume()
`
  )
  chmodSync(path, 0o755)
  return { path, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const waitFor = async (tunnel, predicate) => {
  for (let i = 0; i < 200; i++) {
    if (predicate(tunnel.state)) return tunnel.state
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`état jamais atteint : ${JSON.stringify(tunnel.state)}`)
}

test('adresses acceptées : uniquement les pages de Tailscale, et une adresse finale en .ts.net', () => {
  assert.equal(isTailscaleUrl('https://login.tailscale.com/a/abc', 'action'), true)
  assert.equal(isTailscaleUrl('http://login.tailscale.com/a/abc', 'action'), false)
  assert.equal(isTailscaleUrl('https://login.tailscale.com.evil.example/a', 'action'), false)
  assert.equal(isTailscaleUrl('https://evil.example/?tailscale.com', 'action'), false)
  assert.equal(isTailscaleUrl('https://jaris.tail1234.ts.net', 'address'), true)
  assert.equal(isTailscaleUrl('https://jaris.tail1234.ts.net.evil.example', 'address'), false)
  assert.equal(isTailscaleUrl('javascript:alert(1)', 'action'), false)
})

test('module absent de l’installation : état « indisponible », pas un plantage', () => {
  const tunnel = new PhoneTunnel('/nexiste/pas/jaris-tunnel', tmpdir())
  tunnel.start(1234)
  assert.equal(tunnel.state.state, 'unsupported')
})

test('scénario complet : connexion, autorisation, adresse prête ; une adresse étrangère est ignorée', async () => {
  const fake = fakeTunnel([
    { event: 'starting' },
    { event: 'login', url: 'https://evil.example/phish' },
    { event: 'login', url: 'https://login.tailscale.com/a/abc' },
    { event: 'enable_funnel', url: 'https://login.tailscale.com/f/funnel', text: 'Autorise Funnel' },
    { event: 'ready', url: 'https://jaris.tail1234.ts.net' }
  ])
  const tunnel = new PhoneTunnel(fake.path, fake.dir)
  const seen = []
  tunnel.on('change', (s) => seen.push(s.state === 'login' ? `login:${s.actionUrl}` : s.state))
  try {
    tunnel.start(4321)
    const ready = await waitFor(tunnel, (s) => s.state === 'ready')
    assert.equal(ready.address, 'https://jaris.tail1234.ts.net')
    assert.ok(!seen.some((s) => s.includes('evil')), 'l’adresse étrangère n’a jamais été retenue')
    assert.deepEqual(
      seen.filter((s, i) => s !== seen[i - 1]),
      ['starting', 'login:https://login.tailscale.com/a/abc', 'enable_funnel', 'ready']
    )
    tunnel.stop()
    assert.equal(tunnel.state.state, 'off')
  } finally {
    tunnel.stop()
    fake.cleanup()
  }
})

test('une adresse finale qui n’est pas en .ts.net est une erreur, jamais montrée comme « ton adresse »', async () => {
  const fake = fakeTunnel([{ event: 'ready', url: 'https://jaris.example.com' }])
  const tunnel = new PhoneTunnel(fake.path, fake.dir)
  try {
    tunnel.start(4321)
    const state = await waitFor(tunnel, (s) => s.state === 'error')
    assert.match(state.message, /inattendue/)
  } finally {
    tunnel.stop()
    fake.cleanup()
  }
})

test('tunnel arrêté tout seul : l’écran le dit au lieu de rester bloqué sur « Démarrage »', async () => {
  const fake = fakeTunnel([{ event: 'starting' }, { exit: 3 }])
  const tunnel = new PhoneTunnel(fake.path, fake.dir)
  try {
    tunnel.start(4321)
    const state = await waitFor(tunnel, (s) => s.state === 'error')
    assert.match(state.message, /code 3/)
  } finally {
    tunnel.stop()
    fake.cleanup()
  }
})

test('le message d’erreur du tunnel arrive tel quel', async () => {
  const fake = fakeTunnel([{ event: 'error', message: 'démarrage de Tailscale impossible : pas de réseau' }])
  const tunnel = new PhoneTunnel(fake.path, fake.dir)
  try {
    tunnel.start(4321)
    const state = await waitFor(tunnel, (s) => s.state === 'error')
    assert.equal(state.message, 'démarrage de Tailscale impossible : pas de réseau')
  } finally {
    tunnel.stop()
    fake.cleanup()
  }
})

// v0.22.0 chez Léo : « tsnet: creating state directory: Access is denied ». Sous Windows, Tailscale réécrit
// les droits de tout dossier d'état nommé exactement « tailscale » (refusé sans administrateur). Ni Jaris ni
// le tunnel ne doivent utiliser ce nom — vérifié des deux côtés, la CI tournant, elle, en administrateur.
test('le dossier d’état du tunnel ne s’appelle jamais « tailscale »', () => {
  const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8')
  const dirName = main.match(/const PHONE_TUNNEL_DIR = '([^']+)'/)?.[1]
  assert.ok(dirName, 'PHONE_TUNNEL_DIR introuvable dans main.ts')
  assert.notEqual(dirName.toLowerCase(), 'tailscale')
  assert.match(main, /tunnelStateDir: join\(app\.getPath\('userData'\), PHONE_TUNNEL_DIR\)/)
  const go = readFileSync(new URL('../tunnel/main.go', import.meta.url), 'utf8')
  assert.match(go, /Dir:\s+stateDirFor\(\*stateDir\)/, 'le tunnel doit aussi se protéger lui-même')
})
