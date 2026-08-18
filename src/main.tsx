import React from 'react'
import ReactDOM from 'react-dom/client'
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
