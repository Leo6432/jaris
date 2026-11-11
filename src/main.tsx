import React from 'react'
import ReactDOM from 'react-dom/client'
// Polices embarquées dans le bundle (paquets @fontsource), jamais chargées depuis Google Fonts : Jaris doit
// rester utilisable hors ligne à 100%, une police téléchargée à l'exécution casserait ça au premier
// démarrage sans internet. Refonte « design sobre » (maquette Jaris.dc.html) : Geist pour tout le texte,
// Geist Mono pour le code et les données techniques — fini Rajdhani/Barlow et le look cockpit.
// Étape 465 (Léo, sur le site de Jaris : « une police que j'adore, Bricolage Grotesque, et Instrument Sans pour le
// texte courant : utilise ces deux polices pour toute l'application ») : Bricolage Grotesque pour les titres (axe de
// taille optique : dessinée pour les grands titres comme pour les petits), Instrument Sans pour tout le texte ; Geist
// Mono reste pour le code. Polices variables (toutes les graisses dans un fichier) ; leurs fichiers latin ET latin
// étendu (polonais, tchèque, hongrois… : Jaris parle 24 langues), le navigateur ne charge que ceux dont il a besoin.
import '@fontsource-variable/bricolage-grotesque/opsz.css'
import '@fontsource-variable/instrument-sans/wght.css'
import '@fontsource/geist-mono/latin-400.css'
import '@fontsource/geist-mono/latin-500.css'
import App from './App'
import ScreenScan from './components/ScreenScan'
import StartupSplash from './components/StartupSplash'
import './index.css'
import { initRendererLanguage } from './lib/i18n'

// L'overlay de scan (étape 18) est un arbre React totalement séparé de App (pas un mode de plus dans
// App.tsx) : il n'a besoin d'aucun état Jaris ni d'aucune des vérifications d'onboarding qui protègent le
// rendu de App, seulement d'un canvas plein écran piloté par electron/services/scanOverlay.ts.
// Avant le premier rendu : l'écran naît dans la bonne langue (lecture synchrone auprès du processus principal).
initRendererLanguage()

const mode = new URLSearchParams(window.location.search).get('mode')

// Étape 294 : l'écran de démarrage est lui aussi un arbre à part — rien de Jaris n'est prêt pendant qu'il s'affiche.
ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{mode === 'scan' ? <ScreenScan /> : mode === 'splash' ? <StartupSplash /> : <App />}</React.StrictMode>
)
