/**
 * Test de code, version 2 (étape 232, Léo : améliorer Code « dans le même lancement »). La version 1 ne regardait
 * que l'allure du fichier HTML : 7 modèles sur 7 y faisaient 3/3. Ici, chaque application générée est OUVERTE dans
 * un vrai navigateur (benchmark-browser.mjs) avec les mêmes règles que l'aperçu du mode Code de Jaris, puis
 * utilisée comme le ferait Léo : on tape dans les champs, on clique sur les boutons (un vrai clic de souris, au
 * centre du bouton : un bouton caché ou recouvert ne reçoit rien), et on lit ce qui s'affiche.
 *
 * Les applications demandées ont un résultat unique et vérifiable (3 clics sur « +1 » donnent 3, 100 °C donnent
 * 212 °F...), et les libellés des boutons sont imposés dans la demande pour qu'on puisse les retrouver.
 * Vérifié par scripts/test-benchmark-code.mjs : une application juste passe, une application cassée échoue.
 */
/**
 * Copie de PREVIEW_CSP (electron/services/generatedAppPreview.ts) sans sa partie « sandbox », qui ne peut pas
 * s'écrire dans la page : ce qu'elle interdit est reproduit par benchmark-browser.mjs (alertes muettes, pas de
 * localStorage). Vérifiée par scripts/test-benchmark-code.mjs.
 */
export const PREVIEW_CSP_FOR_TEST =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"

/** Augmenté à chaque changement des demandes ou des vérifications : un score d'une autre version est refait. */
export const CODE_TEST_VERSION = 3

/** Une vérification ratée, avec la raison lisible écrite dans le fichier de résultats. */
class Fail extends Error {}

/** Outils injectés dans la page : trouver un bouton par son texte, lire les nombres affichés. */
const HELPERS = `window.__j = {
  visible(el) { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0' },
  buttons() { return [...document.querySelectorAll('button, input[type=button], input[type=submit], [role=button], a, [onclick]')].filter((b) => this.visible(b)) },
  label(el) {
    const svgTitles = [...el.querySelectorAll('title')].map((t) => t.textContent).join(' ')
    const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ')
    return [el.innerText || el.value || '', el.getAttribute('aria-label') || '', el.title || '', svgTitles, labelledBy].join(' ').trim()
  },
  hint(el) { return [el.id, el.getAttribute('class'), el.getAttribute('name'), el.getAttribute('data-action')].filter(Boolean).join(' ') },
  iconOnly(el) { return !/[\\p{L}\\p{N}]/u.test(this.label(el)) },
  inputs() { return [...document.querySelectorAll('input:not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=reset]), textarea')].filter((i) => this.visible(i)) },
  numbers() {
    const leaves = [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && !/^(BUTTON|SCRIPT|STYLE|OPTION)$/.test(e.tagName) && this.visible(e))
    return leaves.map((e) => e.textContent.trim()).filter((t) => /^-?\\d+$/.test(t)).map(Number)
      .concat([...document.querySelectorAll('input[readonly], output')].map((e) => (e.value ?? e.textContent).trim()).filter((t) => /^-?\\d+$/.test(t)).map(Number))
  }
}`

const norm = (text) =>
  String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()

/** Texte visible de la page (comme le lit Léo). */
const pageText = (page) => page.evaluate('document.body ? document.body.innerText : ""')

/**
 * Clique le bouton voulu, au milieu du bouton, comme une vraie souris. `within` : texte d'une ligne de liste, pour
 * viser le bouton de CETTE ligne (supprimer une tâche précise).
 *
 * Trouver le bouton comme le ferait Léo, qui voit aussi les icônes (Léo, 04/10/2026 : « si il fait une icône
 * comment on fait ? ») — dans cet ordre :
 * 1. son texte, son libellé d'accessibilité, son infobulle ou le titre de son icône SVG (`pattern`) ;
 * 2. sinon son nom dans le code — id, classe… — en français ou en anglais (`hintPattern` : « btn-delete ») ;
 * 3. sinon, s'il n'y a qu'UN seul bouton sans aucun texte à cet endroit (une icône seule), c'est lui.
 */
async function clickButton(page, pattern, what, hintPattern, within) {
  const target = await page.evaluate(`(() => {
    ${HELPERS}
    const re = new RegExp(${JSON.stringify(pattern)}, 'iu')
    const hintRe = new RegExp(${JSON.stringify(hintPattern)}, 'i')
    let pool = __j.buttons()
    const within = ${JSON.stringify(within ?? null)}
    if (within) {
      const leaf = [...document.querySelectorAll('body *')].find((e) => e.children.length === 0 && e.textContent.includes(within))
      let box = leaf
      while (box && !__j.buttons().some((b) => box.contains(b))) box = box.parentElement
      if (!box || box === document.body || box.innerText.split('\\n').filter((l) => l.trim()).length > 6) return { missing: true }
      pool = pool.filter((b) => box.contains(b))
    }
    let button = pool.find((b) => re.test(__j.label(b))) || pool.find((b) => hintRe.test(__j.hint(b)))
    if (!button) {
      const icons = pool.filter((b) => __j.iconOnly(b))
      if (icons.length === 1) button = icons[0]
    }
    if (!button) return { missing: true }
    document.querySelectorAll('[data-jaris-cible]').forEach((e) => e.removeAttribute('data-jaris-cible'))
    button.setAttribute('data-jaris-cible', '')
    return { found: true }
  })()`)
  if (target.missing) throw new Fail(`bouton « ${what} » introuvable`)
  // Le bouton est-il à l'écran ? Sinon, on fait défiler À LA MOLETTE, comme Léo : une page bloquée
  // (overflow: hidden) ne bouge pas, et son bouton reste hors d'atteinte — exactement le bug vécu dans Jaris.
  const where = () =>
    page.evaluate(`(() => {
      const b = document.querySelector('[data-jaris-cible]')
      if (!b) return null
      const r = b.getBoundingClientRect()
      const x = r.left + r.width / 2
      const y = r.top + r.height / 2
      const inView = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight
      const hit = inView ? document.elementFromPoint(x, y) : null
      return { x, y, inView, below: y >= innerHeight, reachable: !!hit && (hit === b || b.contains(hit) || hit.contains(b)) }
    })()`)
  let spot = await where()
  for (let i = 0; i < 12 && spot && !spot.inView; i++) {
    await page.wheel(500, 340, spot.below ? 400 : -400)
    spot = await where()
  }
  if (!spot || !spot.reachable) throw new Fail(`bouton « ${what} » caché ou recouvert : le clic ne l'atteint pas`)
  await page.click(spot.x, spot.y)
}

/** Tape dans le n-ième champ visible (vidé d'abord), comme au clavier. */
async function typeInto(page, index, text) {
  const ok = await page.evaluate(`(() => {
    ${HELPERS}
    const input = __j.inputs()[${index}]
    if (!input) return false
    input.focus()
    input.value = ''
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return document.activeElement === input
  })()`)
  if (!ok) throw new Fail(`champ n° ${index + 1} introuvable`)
  await page.insertText(text)
}

const numbersShown = (page) => page.evaluate(`(() => { ${HELPERS}; return __j.numbers() })()`)
const inputCount = (page) => page.evaluate(`(() => { ${HELPERS}; return __j.inputs().length })()`)

export const CODE_TEST_CASES = [
  {
    id: 'compteur',
    prompt: 'Un compteur qui affiche 0 au départ, avec un bouton « +1 » et un bouton « Remettre à zéro ».',
    async check(page) {
      if (!(await numbersShown(page)).includes(0)) throw new Fail('le compteur n’affiche pas 0 au départ')
      for (let i = 0; i < 3; i++) await clickButton(page, '\\+\\s*1', '+1', 'incr|plus|\\binc|add')
      if (!(await numbersShown(page)).includes(3)) throw new Fail('après 3 clics sur « +1 », le compteur n’affiche pas 3')
      await clickButton(page, 'z[ée]ro|r[ée]initialis|reset|remettre', 'Remettre à zéro', 'reset|zero|clear|raz')
      const after = await numbersShown(page)
      if (!after.includes(0) || after.includes(3)) throw new Fail('après « Remettre à zéro », le compteur n’affiche pas 0')
      // Le compteur repart bien de zéro : 2 clics donnent 2 (pas 5, ni un affichage figé).
      for (let i = 0; i < 2; i++) await clickButton(page, '\\+\\s*1', '+1', 'incr|plus|\\binc|add')
      const again = await numbersShown(page)
      if (!again.includes(2) || again.includes(5)) throw new Fail('après la remise à zéro puis 2 clics sur « +1 », le compteur n’affiche pas 2')
    }
  },
  {
    id: 'addition',
    prompt: 'Une calculatrice d’addition : deux champs pour saisir deux nombres et un bouton « Calculer » qui affiche leur somme.',
    async check(page) {
      if ((await inputCount(page)) < 2) throw new Fail('il n’y a pas deux champs pour les nombres')
      await typeInto(page, 0, '12')
      await typeInto(page, 1, '30')
      await clickButton(page, 'calcul', 'Calculer', 'calc|sum|somme|compute|add')
      if (!/\b42\b/.test(await pageText(page))) throw new Fail('12 + 30 : la somme 42 ne s’affiche pas')
      // Deuxième calcul avec d'autres nombres : une somme écrite en dur, ou un résultat qui ne se met pas à jour, échoue.
      await typeInto(page, 0, '250')
      await typeInto(page, 1, '-75')
      await clickButton(page, 'calcul', 'Calculer', 'calc|sum|somme|compute|add')
      if (!/(^|[^\d-])175\b/.test(await pageText(page))) throw new Fail('250 + (−75) : la somme 175 ne s’affiche pas')
    }
  },
  {
    id: 'convertisseur',
    prompt:
      'Un convertisseur de degrés Celsius en Fahrenheit : un champ pour la température en Celsius, un bouton « Convertir », et le résultat en Fahrenheit affiché dans la page.',
    async check(page) {
      await typeInto(page, 0, '100')
      await clickButton(page, 'convert', 'Convertir', 'conv')
      if (!/\b212\b/.test(await pageText(page))) throw new Fail('100 °C : le résultat 212 °F ne s’affiche pas')
      await typeInto(page, 0, '25')
      await clickButton(page, 'convert', 'Convertir', 'conv')
      if (!/\b77\b/.test(await pageText(page))) throw new Fail('25 °C : le résultat 77 °F ne s’affiche pas')
    }
  },
  {
    id: 'liste-taches',
    prompt:
      'Une liste de tâches : un champ de texte, un bouton « Ajouter » qui ajoute la tâche à la liste, et un bouton « Supprimer » à côté de chaque tâche.',
    async check(page) {
      await typeInto(page, 0, 'Acheter du pain')
      await clickButton(page, 'ajout', 'Ajouter', 'add|ajout|submit')
      await typeInto(page, 0, 'Appeler Marc')
      await clickButton(page, 'ajout', 'Ajouter', 'add|ajout|submit')
      const text = await pageText(page)
      if (!text.includes('Acheter du pain') || !text.includes('Appeler Marc')) throw new Fail('les deux tâches ajoutées ne s’affichent pas')
      await clickButton(page, 'supprim|effacer|retirer|×|✕|✖|🗑|^\\s*x\\s*$', 'Supprimer', 'delete|remove|suppr|trash|\\bdel\\b|poubelle', 'Acheter du pain')
      const after = await pageText(page)
      if (after.includes('Acheter du pain')) throw new Fail('la tâche supprimée est toujours affichée')
      if (!after.includes('Appeler Marc')) throw new Fail('supprimer une tâche a aussi fait disparaître l’autre')
    }
  },
  {
    id: 'formulaire-contact',
    prompt:
      'Un formulaire de contact avec un champ nom, un champ email, un champ message et un bouton « Envoyer » qui affiche un message de confirmation dans la page.',
    async check(page) {
      const fields = await page.evaluate(`(() => { ${HELPERS}; return __j.inputs().map((i) => [i.tagName, i.type, (i.name + ' ' + i.id + ' ' + (i.placeholder || '')).toLowerCase()]) })()`)
      if (fields.length < 3) throw new Fail('il manque des champs (nom, email, message)')
      for (const [index, [tag, type, hint]] of fields.entries()) {
        const value = type === 'email' || /mail/.test(hint) ? 'leo@example.com' : tag === 'TEXTAREA' || /message/.test(hint) ? 'Bonjour, ceci est un essai.' : 'Léo Martin'
        await typeInto(page, index, value)
      }
      const confirmation = /merci|confirm|bien ete|envoye(e|s)?\b|recu\b|succes/
      const before = norm(await pageText(page))
      await clickButton(page, 'envoy', 'Envoyer', 'send|submit|envoy')
      const after = norm(await pageText(page))
      if (!confirmation.test(after) || (confirmation.test(before) && after === before)) throw new Fail('aucun message de confirmation après « Envoyer »')
    }
  }
]

export const CODE_TOTAL = CODE_TEST_CASES.length

/** Les règles de l'aperçu de Jaris, ajoutées en tête de page (seule la partie « sandbox » ne s'écrit pas ainsi). */
export function withPreviewRules(html) {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP_FOR_TEST}">`
  return /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => `${m}${meta}`) : `${meta}${html}`
}

/**
 * Ouvre l'application et joue sa vérification. Renvoie `null` si tout marche, sinon la raison. Les erreurs
 * JavaScript de la page sont jointes à la raison, pour comprendre un échec en relisant le fichier.
 */
export async function checkGeneratedApp(page, testCase, html) {
  await page.loadHtml(withPreviewRules(html))
  try {
    await testCase.check(page)
    return null
  } catch (err) {
    if (!(err instanceof Fail) && !/ne répond plus/.test(String(err.message))) throw err
    const jsErrors = page.errors.length ? ` (erreur JavaScript : ${String(page.errors[0]).split('\n')[0].slice(0, 160)})` : ''
    return `${err.message}${jsErrors}`
  }
}
