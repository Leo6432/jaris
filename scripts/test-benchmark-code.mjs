import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { findBrowser, openBrowser } from './benchmark-browser.mjs'
import { CODE_TEST_CASES, PREVIEW_CSP_FOR_TEST, checkGeneratedApp, withPreviewRules } from './benchmark-code.mjs'

/**
 * Étape 232 : le test de code ouvre vraiment chaque application générée et clique dedans. Ici, des applications
 * écrites à la main : une juste doit passer, une cassée doit échouer avec une raison lisible — sinon le test
 * noterait faux un modèle qui a bien travaillé, ou laisserait passer des boutons qui ne marchent pas.
 * Le navigateur : JARIS_BROWSER_PATH, ou le Chromium de cet environnement ; ignoré avec une raison s'il manque.
 */
const browserPath = process.env.JARIS_BROWSER_PATH || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : findBrowser())
const options = { skip: browserPath ? false : 'aucun navigateur disponible ici', timeout: 60000 }

const page = (body, script = '') => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:sans-serif;padding:20px}</style></head><body>${body}<script>${script}</script></body></html>`

const APPS = {
  compteur: {
    good: page('<div id="n">0</div><button id="p">+1</button><button id="z">Remettre à zéro</button>', "let n=0;const s=()=>document.getElementById('n').textContent=n;p.onclick=()=>{n++;s()};z.onclick=()=>{n=0;s()}"),
    // Une page longue, mais qui défile : le bouton est atteint à la molette, comme le ferait Léo.
    goodLong: page('<div style="height:1500px">Faites défiler</div><div id="n">0</div><button id="p">+1</button><button id="z">Remettre à zéro</button>', "let n=0;const s=()=>document.getElementById('n').textContent=n;p.onclick=()=>{n++;s()};z.onclick=()=>{n=0;s()}"),
    // Boutons-icônes (Léo : « si il fait une icône comment on fait ? ») : retrouvés par leur nom dans le code
    // (id « btn-increment ») et par le titre de leur icône SVG (« Réinitialiser »).
    goodIcons: page(
      '<div id="n">0</div><button id="btn-increment"><svg width="16" height="16"><path d="M8 2v12M2 8h12" stroke="black"/></svg></button><button class="btn-reset"><svg width="16" height="16"><title>Réinitialiser</title><circle cx="8" cy="8" r="6" stroke="black" fill="none"/></svg></button>',
      "let n=0;const s=()=>document.getElementById('n').textContent=n;document.getElementById('btn-increment').onclick=()=>{n++;s()};document.querySelector('.btn-reset').onclick=()=>{n=0;s()}"
    ),
    bad: [
      ['boutons sans action', page('<div>0</div><button>+1</button><button>Remettre à zéro</button>'), /n’affiche pas 3/],
      [
        'la remise à zéro n’efface que l’affichage (le compteur repart de 3)',
        page('<div id="n">0</div><button id="p">+1</button><button id="z">Remettre à zéro</button>', "let n=0;p.onclick=()=>{n++;document.getElementById('n').textContent=n};z.onclick=()=>{document.getElementById('n').textContent=0}"),
        /2 clics sur « \+1 », le compteur n’affiche pas 2/
      ],
      [
        'bouton caché par overflow:hidden (le vrai bug de Léo)',
        page('<div style="height:100vh"></div><div id="n">0</div><button id="p">+1</button><button id="z">Remettre à zéro</button>', "let n=0;p.onclick=()=>{n++;document.getElementById('n').textContent=n}").replace('padding:20px}', 'padding:20px;height:100vh;overflow:hidden}').replace('<head>', '<head><style>html{overflow:hidden;height:100%}</style>'),
        /bouton « \+1 » caché ou recouvert/
      ],
      [
        'bouton recouvert par un autre élément',
        page('<div id="n">0</div><button id="p">+1</button><button id="z">Remettre à zéro</button><div style="position:fixed;inset:0;background:transparent"></div>', "let n=0;p.onclick=()=>{n++;n.textContent=n}"),
        /caché ou recouvert/
      ]
    ]
  },
  addition: {
    good: page('<input id="a" type="number"><input id="b" type="number"><button id="c">Calculer</button><p id="r"></p>', "c.onclick=()=>{r.textContent='Somme : '+(Number(a.value)+Number(b.value))}"),
    // Un seul bouton, une icône « = » sans aucun texte ni nom : c'est forcément lui.
    goodIcons: page('<input id="a" type="number"><input id="b" type="number"><button>=</button><p id="r"></p>', "document.querySelector('button').onclick=()=>{r.textContent=Number(a.value)+Number(b.value)}"),
    bad: [
      ['texte collé au lieu d’additionner (1230)', page('<input id="a"><input id="b"><button id="c">Calculer</button><p id="r"></p>', "c.onclick=()=>{r.textContent=a.value+b.value}"), /42 ne s’affiche pas/],
      ['somme écrite en dur', page('<input id="a"><input id="b"><button id="c">Calculer</button><p id="r"></p>', "c.onclick=()=>{r.textContent='Somme : 42'}"), /175 ne s’affiche pas/],
      ['résultat calculé une seule fois', page('<input id="a"><input id="b"><button id="c">Calculer</button><p id="r"></p>', "let done=false;c.onclick=()=>{if(done)return;done=true;r.textContent=Number(a.value)+Number(b.value)}"), /175 ne s’affiche pas/]
    ]
  },
  convertisseur: {
    good: page('<input id="c" type="number" placeholder="Celsius"><button id="b">Convertir</button><p id="r"></p>', "b.onclick=()=>{r.textContent=(Number(c.value)*9/5+32)+' °F'}"),
    bad: [
      ['mauvaise formule', page('<input id="c"><button id="b">Convertir</button><p id="r"></p>', "b.onclick=()=>{r.textContent=(Number(c.value)*9/5)+' °F'}"), /212/],
      ['résultat écrit en dur', page('<input id="c"><button id="b">Convertir</button><p id="r"></p>', "b.onclick=()=>{r.textContent='212 °F'}"), /77/]
    ]
  },
  'liste-taches': {
    good: page(
      '<input id="t"><button id="a">Ajouter</button><ul id="l"></ul>',
      "a.onclick=()=>{if(!t.value.trim())return;const li=document.createElement('li');const s=document.createElement('span');s.textContent=t.value;const d=document.createElement('button');d.textContent='Supprimer';d.onclick=()=>li.remove();li.append(s,d);l.append(li);t.value=''}"
    ),
    // « Ajouter » en icône « + » (id « add »), et dans chaque ligne une icône crayon (classe « btn-edit ») et une
    // icône poubelle (classe « btn-delete ») : c'est la poubelle de la BONNE ligne qui doit être cliquée.
    goodIcons: page(
      '<input id="t"><button id="add">+</button><ul id="l"></ul>',
      "add.onclick=()=>{const li=document.createElement('li');const s=document.createElement('span');s.textContent=t.value;const e=document.createElement('button');e.className='btn-edit';e.innerHTML='<svg width=\"14\" height=\"14\"><path d=\"M2 12L12 2\" stroke=\"black\"/></svg>';e.onclick=()=>{s.textContent='modifiée'};const d=document.createElement('button');d.className='btn-delete';d.innerHTML='<svg width=\"14\" height=\"14\"><rect x=\"3\" y=\"3\" width=\"8\" height=\"10\" stroke=\"black\" fill=\"none\"/></svg>';d.onclick=()=>li.remove();li.append(s,e,d);l.append(li);t.value=''}"
    ),
    // Une seule icône sans texte ni nom dans chaque ligne : c'est elle.
    goodIcons2: page(
      '<input id="t"><button id="a">Ajouter</button><ul id="l"></ul>',
      "a.onclick=()=>{const li=document.createElement('li');const s=document.createElement('span');s.textContent=t.value;const d=document.createElement('button');d.innerHTML='<svg width=\"14\" height=\"14\"><rect x=\"3\" y=\"3\" width=\"8\" height=\"10\" stroke=\"black\" fill=\"none\"/></svg>';d.onclick=()=>li.remove();li.append(s,d);l.append(li);t.value=''}"
    ),
    bad: [
      [
        'supprimer efface toute la liste',
        page('<input id="t"><button id="a">Ajouter</button><ul id="l"></ul>', "a.onclick=()=>{const li=document.createElement('li');li.innerHTML='<span>'+t.value+'</span> <button>Supprimer</button>';li.querySelector('button').onclick=()=>{l.innerHTML=''};l.append(li);t.value=''}"),
        /fait disparaître l’autre/
      ],
      ['bouton Ajouter qui ne fait rien', page('<input id="t"><button>Ajouter</button><ul></ul>'), /ne s’affichent pas/]
    ]
  },
  'formulaire-contact': {
    // Un vrai <form> : il ne marche dans Jaris que depuis l'ajout de allow-forms à l'aperçu (étape 232).
    good: page(
      '<form id="f"><input name="nom" placeholder="Nom"><input type="email" name="email"><textarea name="message"></textarea><button type="submit">Envoyer</button></form><p id="ok"></p>',
      "f.addEventListener('submit',e=>{e.preventDefault();ok.textContent='Merci, votre message a bien été envoyé.'})"
    ),
    bad: [
      [
        'confirmation par alerte (invisible dans l’aperçu de Jaris)',
        page('<input placeholder="Nom"><input type="email"><textarea></textarea><button id="b">Envoyer</button>', "b.onclick=()=>alert('Message envoyé !')"),
        /aucun message de confirmation/
      ],
      [
        'localStorage sans try/catch : plante dans l’aperçu isolé de Jaris',
        page('<input placeholder="Nom"><input type="email"><textarea></textarea><button id="b">Envoyer</button><p id="ok"></p>', "b.onclick=()=>{localStorage.setItem('m','1');ok.textContent='Merci !'}"),
        /aucun message de confirmation.*erreur JavaScript/
      ]
    ]
  }
}

test('chaque application demandée a sa version juste et au moins une cassée', () => {
  assert.deepEqual(Object.keys(APPS).sort(), CODE_TEST_CASES.map((c) => c.id).sort())
})

test('les règles de l’aperçu sont celles de Jaris (generatedAppPreview.ts), sauf la partie sandbox', () => {
  const source = readFileSync(new URL('../electron/services/generatedAppPreview.ts', import.meta.url), 'utf8')
  const csp = source.match(/export const PREVIEW_CSP =\s*"([^"]+)"/)?.[1]
  assert.ok(csp)
  assert.equal(csp.replace(/; sandbox [^;]+$/, ''), PREVIEW_CSP_FOR_TEST)
  assert.match(csp, /sandbox allow-scripts allow-forms$/)
  assert.match(withPreviewRules('<html><head><title>x</title></head></html>'), /<head><meta http-equiv="Content-Security-Policy"/)
})

for (const testCase of CODE_TEST_CASES) {
  test(`« ${testCase.id} » : l’application juste passe, les cassées échouent avec leur raison`, options, async () => {
    const { page: browserPage, close } = await openBrowser(browserPath)
    try {
      for (const variant of ['good', 'goodLong', 'goodIcons', 'goodIcons2']) {
        if (APPS[testCase.id][variant]) assert.equal(await checkGeneratedApp(browserPage, testCase, APPS[testCase.id][variant]), null, variant)
      }
    } finally {
      await close()
    }
    for (const [what, html, reason] of APPS[testCase.id].bad) {
      const { page: p, close: c } = await openBrowser(browserPath)
      try {
        const result = await checkGeneratedApp(p, testCase, html)
        assert.ok(result, `${what} : devait échouer`)
        assert.match(result, reason, what)
      } finally {
        await c()
      }
    }
  })
}

test('une application qui boucle à l’infini est arrêtée et comptée fausse, sans bloquer le test', options, async () => {
  const { page: p, close } = await openBrowser(browserPath)
  try {
    const html = page('<div>0</div><button id="p">+1</button>', 'p.onclick=()=>{while(true){}}')
    const result = await checkGeneratedApp(p, CODE_TEST_CASES[0], html)
    assert.match(result, /ne répond plus/)
  } finally {
    await close()
  }
})
