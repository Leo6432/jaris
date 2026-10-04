#!/usr/bin/env node
/**
 * Fabrique les captures d'écran du test de vision (étape 232, Léo : améliorer Vision « dans le même lancement »).
 * L'ancien test montrait des carrés de couleur et du texte en pixels géants : presque tous les modèles y faisaient
 * 18/18, il ne départageait plus rien. Ces captures ressemblent à ce que Jaris envoie vraiment avec look_at_screen
 * (1280x720, fenêtres Windows, petit texte, éléments qui se chevauchent), rendues par un vrai navigateur.
 *
 * Outil de développement : les PNG produits sont commités dans scripts/vision-tests/ et embarqués dans
 * l'installeur ; ce script n'est jamais lancé chez Léo. Usage : node scripts/make-vision-tests.mjs
 */
import { mkdirSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules/playwright/index.mjs')
const outDir = join(dirname(fileURLToPath(import.meta.url)), 'vision-tests')

const BASE = `
* { box-sizing: border-box; margin: 0; padding: 0; }
body { width: 1280px; height: 720px; overflow: hidden; font-family: 'Liberation Sans', 'DejaVu Sans', sans-serif; font-size: 14px; color: #1b1b1b;
  background: linear-gradient(135deg, #1d4f7a 0%, #2f7aa8 55%, #7fb3d1 100%); position: relative; }
.taskbar { position: absolute; left: 0; right: 0; bottom: 0; height: 48px; background: rgba(32, 32, 32, 0.92); display: flex; align-items: center; padding: 0 12px; gap: 8px; }
.taskbar .icon { width: 32px; height: 32px; border-radius: 6px; background: #3a3a3a; color: #fff; font-size: 11px; display: grid; place-items: center; }
.taskbar .spacer { flex: 1; }
.taskbar .clock { color: #fff; font-size: 12px; text-align: right; line-height: 16px; }
.win { position: absolute; background: #fff; border: 1px solid #9a9a9a; border-radius: 8px; box-shadow: 0 8px 28px rgba(0,0,0,0.35); overflow: hidden; }
.win .title { height: 32px; background: #f3f3f3; border-bottom: 1px solid #ddd; display: flex; align-items: center; padding: 0 12px; font-size: 12px; color: #333; }
.win .title .ctrl { margin-left: auto; letter-spacing: 18px; color: #555; }
.win.inactive .title { background: #e6e6e6; color: #888; }
.win .body { padding: 14px 16px; }
button { font: inherit; font-size: 13px; padding: 6px 18px; border: 1px solid #b5b5b5; border-radius: 4px; background: #fdfdfd; }
button.primary { background: #0067c0; color: #fff; border-color: #0067c0; }
`

/** id -> HTML du corps de la page (1280x720). */
const SCENES = {
  'bloc-notes-courses': `
    <div class="win" style="left:180px;top:70px;width:760px;height:500px">
      <div class="title">Liste de courses.txt - Bloc-notes<span class="ctrl">— ☐ ✕</span></div>
      <div style="height:26px;border-bottom:1px solid #eee;font-size:12px;padding:5px 12px;color:#444">Fichier &nbsp;&nbsp; Modifier &nbsp;&nbsp; Affichage</div>
      <div class="body" style="font-family:'DejaVu Sans Mono',monospace;font-size:15px;line-height:24px">
        Courses pour samedi<br>- Pain de campagne<br>- Lait demi-écrémé (2 bouteilles)<br>- 6 œufs<br>- Beurre doux<br>- Pommes x4<br>- Café moulu
      </div>
    </div>
    <div class="taskbar"><div class="icon">⊞</div><div class="icon">N</div><div class="spacer"></div><div class="clock">10:12<br>04/10/2026</div></div>`,
  'erreur-disque': `
    <div class="win inactive" style="left:60px;top:40px;width:1000px;height:600px"><div class="title">Rapport annuel.docx - Word<span class="ctrl">— ☐ ✕</span></div>
      <div class="body" style="color:#aaa;line-height:22px">Rapport annuel 2026<br>Chiffre d'affaires, perspectives et plan d'action pour l'année prochaine…</div></div>
    <div class="win" style="left:360px;top:230px;width:520px;height:200px">
      <div class="title">Microsoft Word<span class="ctrl">✕</span></div>
      <div class="body" style="display:flex;gap:14px;line-height:20px">
        <div style="width:34px;height:34px;border-radius:50%;background:#c42b1c;color:#fff;font-weight:bold;display:grid;place-items:center;flex:none">✕</div>
        <div>Impossible d'enregistrer « Rapport annuel.docx » : le disque D: est plein. Libérez de l'espace puis réessayez.</div>
      </div>
      <div style="position:absolute;right:16px;bottom:14px"><button class="primary">OK</button></div>
    </div>
    <div class="taskbar"><div class="icon">⊞</div><div class="icon">W</div><div class="spacer"></div><div class="clock">16:05<br>04/10/2026</div></div>`,
  'meteo-villes': `
    <div class="win" style="left:40px;top:20px;width:1200px;height:640px">
      <div class="title">Météo des villes - Météo-France — Microsoft Edge<span class="ctrl">— ☐ ✕</span></div>
      <div style="height:34px;background:#f7f7f7;border-bottom:1px solid #e3e3e3;padding:7px 14px;font-size:12px;color:#555">https://meteofrance.com/previsions-villes</div>
      <div class="body">
        <div style="font-size:22px;font-weight:bold;margin:8px 0 18px">Prévisions pour aujourd'hui</div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:16px">
          ${[['Brest', '12 °C', 'Pluie'], ['Rennes', '14 °C', 'Averses'], ['Nantes', '16 °C', 'Nuageux'], ['Paris', '18 °C', 'Ensoleillé']]
            .map(([c, t, w]) => `<div style="border:1px solid #ddd;border-radius:8px;padding:16px"><div style="font-size:16px;font-weight:bold">${c}</div><div style="font-size:30px;margin:10px 0">${t}</div><div style="color:#666">${w}</div></div>`)
            .join('')}
        </div>
      </div>
    </div>
    <div class="taskbar"><div class="icon">⊞</div><div class="icon">e</div><div class="spacer"></div><div class="clock">08:40<br>04/10/2026</div></div>`,
  'premier-plan': `
    <div class="win inactive" style="left:80px;top:40px;width:820px;height:520px"><div class="title">Discord<span class="ctrl">— ☐ ✕</span></div>
      <div style="display:flex;height:100%"><div style="width:220px;background:#2b2d31;color:#ccc;padding:14px;line-height:28px"># général<br># jeux<br># musique</div>
      <div style="flex:1;background:#313338;color:#ddd;padding:14px;line-height:22px">Marc : quelqu'un pour une partie ce soir ?</div></div></div>
    <div class="win" style="left:430px;top:150px;width:780px;height:470px"><div class="title" style="background:#121212;color:#fff;border-color:#121212">Spotify Premium<span class="ctrl">— ☐ ✕</span></div>
      <div style="background:#121212;color:#fff;height:100%;padding:20px">
        <div style="font-size:26px;font-weight:bold;margin-bottom:16px">Bonjour</div>
        <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:12px">${['Titres likés', 'Daily Mix 1', 'Rock français', 'Concentration'].map((t) => `<div style="background:#2a2a2a;border-radius:6px;padding:16px">${t}</div>`).join('')}</div>
      </div></div>
    <div class="taskbar"><div class="icon">⊞</div><div class="icon">D</div><div class="icon">S</div><div class="spacer"></div><div class="clock">21:02<br>04/10/2026</div></div>`,
  'tableau-prix': `
    <div class="win" style="left:120px;top:50px;width:900px;height:520px"><div class="title">Inventaire bureau.xlsx - Excel<span class="ctrl">— ☐ ✕</span></div>
      <div class="body"><table style="border-collapse:collapse;font-size:14px">
        ${[['', 'A', 'B', 'C'], ['1', 'Produit', 'Prix', 'Stock'], ['2', 'Souris', '19,90 €', '12'], ['3', 'Clavier', '49,90 €', '7'], ['4', 'Écran 27 pouces', '189,00 €', '3'], ['5', 'Casque', '59,90 €', '9'], ['6', 'Webcam', '39,90 €', '5']]
          .map((row, r) => `<tr>${row.map((c, i) => `<td style="border:1px solid #d4d4d4;padding:6px 12px;min-width:${i === 0 ? 40 : 150}px;${r === 0 || i === 0 ? 'background:#f0f0f0;color:#666;text-align:center;' : ''}${r === 1 && i ? 'font-weight:bold;' : ''}">${c}</td>`).join('')}</tr>`)
          .join('')}
      </table></div></div>
    <div class="taskbar"><div class="icon">⊞</div><div class="icon">X</div><div class="spacer"></div><div class="clock">11:30<br>04/10/2026</div></div>`,
  'mails-non-lus': `
    <div class="win" style="left:100px;top:30px;width:1000px;height:610px"><div class="title">Boîte de réception - Outlook<span class="ctrl">— ☐ ✕</span></div>
      <div class="body" style="padding:0">
        ${[
          [true, 'Julie Martin', 'Photos du week-end'],
          [false, 'Banque Populaire', 'Votre relevé de septembre'],
          [true, 'Marc Dubois', 'Match de foot dimanche'],
          [true, 'Amazon', 'Votre colis arrive demain'],
          [false, 'Mairie de Rennes', 'Inscriptions périscolaires'],
          [true, 'Sophie Leroy', 'Réunion de jeudi'],
          [false, 'SNCF Connect', 'Confirmation de votre billet']
        ]
          .map(([unread, from, subject]) => `<div style="display:flex;align-items:center;border-bottom:1px solid #eee;height:62px;padding:0 18px;${unread ? 'font-weight:bold;' : 'color:#666;'}"><div style="width:4px;height:40px;background:${unread ? '#0067c0' : 'transparent'};margin-right:14px"></div><div style="width:240px">${from}</div><div>${subject}</div></div>`)
          .join('')}
      </div></div>
    <div class="taskbar"><div class="icon">⊞</div><div class="icon">O</div><div class="spacer"></div><div class="clock">09:15<br>04/10/2026</div></div>`,
  'boutons-enregistrer': `
    <div class="win inactive" style="left:120px;top:60px;width:900px;height:500px"><div class="title">*Sans titre - Bloc-notes<span class="ctrl">— ☐ ✕</span></div>
      <div class="body" style="font-family:'DejaVu Sans Mono',monospace;color:#999">Idées de cadeaux pour Noël…</div></div>
    <div class="win" style="left:390px;top:250px;width:500px;height:170px"><div class="title">Bloc-notes<span class="ctrl">✕</span></div>
      <div class="body" style="font-size:15px;color:#0a3a8a">Voulez-vous enregistrer les modifications de Sans titre ?</div>
      <div style="position:absolute;right:16px;bottom:16px;display:flex;gap:8px"><button class="primary">Enregistrer</button><button>Ne pas enregistrer</button><button>Annuler</button></div></div>
    <div class="taskbar"><div class="icon">⊞</div><div class="icon">N</div><div class="spacer"></div><div class="clock">18:50<br>04/10/2026</div></div>`,
  'horloge': `
    <div class="win" style="left:200px;top:90px;width:700px;height:420px"><div class="title">Explorateur de fichiers<span class="ctrl">— ☐ ✕</span></div>
      <div class="body" style="line-height:30px">📁 Documents<br>📁 Images<br>📁 Téléchargements<br>📁 Musique</div></div>
    <div class="taskbar"><div class="icon">⊞</div><div class="icon">📁</div><div class="spacer"></div><div class="clock">14:37<br>04/10/2026</div></div>`,
  'youtube-resultats': `
    <div class="win" style="left:30px;top:16px;width:1220px;height:650px"><div class="title">tuto guitare - YouTube — Google Chrome<span class="ctrl">— ☐ ✕</span></div>
      <div style="height:52px;display:flex;align-items:center;gap:16px;padding:0 20px;border-bottom:1px solid #eee"><b style="color:#c00">▶ YouTube</b><div style="flex:1;max-width:520px;border:1px solid #ccc;border-radius:20px;padding:7px 16px">tuto guitare</div></div>
      <div class="body">
        ${[
          ['Apprendre la guitare en 10 minutes – Leçon 1', 'Guitare Facile · 1,2 M de vues'],
          ['Les 5 accords faciles pour débuter', 'Jean-Luc Guitare · 845 k vues'],
          ['Gratter la guitare : le rythme de base', 'Studio Six Cordes · 310 k vues']
        ]
          .map(([t, m]) => `<div style="display:flex;gap:16px;margin-bottom:18px"><div style="width:260px;height:146px;background:#333;border-radius:10px"></div><div><div style="font-size:18px;margin-bottom:8px">${t}</div><div style="color:#666;font-size:12px">${m}</div></div></div>`)
          .join('')}
      </div></div>
    <div class="taskbar"><div class="icon">⊞</div><div class="icon">C</div><div class="spacer"></div><div class="clock">20:10<br>04/10/2026</div></div>`,
  'notification-message': `
    <div class="win" style="left:150px;top:80px;width:760px;height:440px"><div class="title">Calculatrice<span class="ctrl">— ☐ ✕</span></div>
      <div class="body" style="font-size:40px;text-align:right;padding-top:40px">1 284</div></div>
    <div style="position:absolute;right:14px;bottom:60px;width:360px;background:#2b2b2b;color:#fff;border-radius:8px;padding:14px 16px;box-shadow:0 6px 20px rgba(0,0,0,0.4);font-size:13px;line-height:19px">
      <div style="color:#aaa;font-size:11px;margin-bottom:6px">Messages · maintenant</div>
      <div style="font-weight:bold">Julie Martin</div><div>On se retrouve à 19 h devant le cinéma ?</div></div>
    <div class="taskbar"><div class="icon">⊞</div><div class="icon">=</div><div class="spacer"></div><div class="clock">18:21<br>04/10/2026</div></div>`
}

mkdirSync(outDir, { recursive: true })
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } })
  for (const [id, body] of Object.entries(SCENES)) {
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${BASE}</style></head><body>${body}</body></html>`)
    await page.screenshot({ path: join(outDir, `${id}.png`) })
    console.log(`${id}.png`)
  }
} finally {
  await browser.close()
}
