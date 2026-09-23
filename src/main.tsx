import React from 'react'
import ReactDOM from 'react-dom/client'
// Police embarquée dans le bundle (paquet @fontsource), jamais chargée depuis Google Fonts : Jaris doit
// rester utilisable hors ligne à 100%. Étape 144 (design « rassurant », grand public) : Nunito, une police
// aux formes rondes et très lisible, remplace Rajdhani/Barlow (style « instrument de bord » de l'ancien
// thème science-fiction). Sous-ensemble latin uniquement, quatre graisses suffisent à toute l'interface.
import '@fontsource/nunito/latin-400.css'
import '@fontsource/nunito/latin-600.css'
import '@fontsource/nunito/latin-700.css'
import '@fontsource/nunito/latin-800.css'
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
