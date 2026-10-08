import React from 'react'
import ReactDOM from 'react-dom/client'
// Polices embarquées dans le bundle (paquets @fontsource), jamais chargées depuis Google Fonts : Jaris doit
// rester utilisable hors ligne à 100%, une police téléchargée à l'exécution casserait ça au premier
// démarrage sans internet. Refonte « design sobre » (maquette Jaris.dc.html) : Geist pour tout le texte,
// Geist Mono pour le code et les données techniques — fini Rajdhani/Barlow et le look cockpit.
// Sous-ensemble latin uniquement : une interface en français n'affichera jamais les autres alphabets.
import '@fontsource/geist-sans/latin-400.css'
import '@fontsource/geist-sans/latin-500.css'
import '@fontsource/geist-sans/latin-600.css'
import '@fontsource/geist-mono/latin-400.css'
import '@fontsource/geist-mono/latin-500.css'
import App from './App'
import ScreenScan from './components/ScreenScan'
import './index.css'

// L'overlay de scan (étape 18) est un arbre React totalement séparé de App (pas un mode de plus dans
// App.tsx) : il n'a besoin d'aucun état Jaris ni d'aucune des vérifications d'onboarding qui protègent le
// rendu de App, seulement d'un canvas plein écran piloté par electron/services/scanOverlay.ts.
const isScanOverlay = new URLSearchParams(window.location.search).get('mode') === 'scan'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{isScanOverlay ? <ScreenScan /> : <App />}</React.StrictMode>
)
