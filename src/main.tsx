import React from 'react'
import ReactDOM from 'react-dom/client'
// Polices embarquées dans le bundle (paquets @fontsource), jamais chargées depuis Google Fonts : Jaris doit
// rester utilisable hors ligne à 100%, une police téléchargée à l'exécution casserait ça au premier
// démarrage sans internet. Rajdhani (titres/étiquettes) donne le côté "interface technique", Barlow assure
// la lisibilité du texte courant — voir les tokens --hud-font-* dans index.css.
// Sous-ensemble latin uniquement : ces deux familles embarquent aussi le devanagari (~500 Ko de glyphes
// qu'une interface en français n'affichera jamais), que l'import générique aurait copié dans le bundle.
import '@fontsource/rajdhani/latin-400.css'
import '@fontsource/rajdhani/latin-500.css'
import '@fontsource/rajdhani/latin-600.css'
import '@fontsource/rajdhani/latin-700.css'
import '@fontsource/barlow/latin-400.css'
import '@fontsource/barlow/latin-500.css'
import '@fontsource/barlow/latin-600.css'
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
