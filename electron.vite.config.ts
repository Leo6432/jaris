import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    // Identifiants OAuth "Application de bureau" figés dans la construction. L'application installée n'a
    // pas de fichier .env (l'étape 16 interdit d'en demander un à l'utilisateur), donc sans ça le bouton
    // "Connecter Gmail" ne pourrait jamais marcher pour le public. Ils viennent des secrets GitHub au
    // moment du build (voir .github/workflows/build-installer.yml) : jamais écrits dans le dépôt.
    //
    // Un identifiant client de type "application de bureau" n'est pas un secret au sens strict — Google
    // documente lui-même qu'il ne peut pas rester confidentiel dans une application distribuée, et c'est
    // pour ça que ce type de client exige en plus le consentement explicite de l'utilisateur dans son
    // navigateur pour chaque compte connecté.
    define: {
      __GOOGLE_CLIENT_ID__: JSON.stringify(process.env.GOOGLE_CLIENT_ID ?? ''),
      __GOOGLE_CLIENT_SECRET__: JSON.stringify(process.env.GOOGLE_CLIENT_SECRET ?? '')
    },
    build: {
      outDir: 'out/main',
      lib: {
        entry: resolve(__dirname, 'electron/main.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      lib: {
        entry: resolve(__dirname, 'electron/preload.ts')
      }
    }
  },
  renderer: {
    root: '.',
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src')
      }
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: resolve(__dirname, 'index.html')
      }
    },
    plugins: [react()]
  }
})
