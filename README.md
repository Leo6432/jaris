# Jaris

Assistant IA personnel, vocal et écrit, **100 % local** : la voix, la réflexion et les réponses tournent sur le PC
(Ollama), sans abonnement ni API payante. Application Windows (Electron + React + TypeScript).

🌐 **Site et vidéo de présentation : [jaris-site.vercel.app](https://jaris-site.vercel.app/)**

💬 **Aide, bugs, idées : [le Discord de Jaris](https://discord.gg/dVAQV7eJtr)** (aussi le bouton « ? » en bas à gauche dans Jaris).
Jaris est en version bêta : si vous trouvez un bug, dites-le sur le Discord.

## Ce que fait Jaris

- **Vocal** : on dit « Jaris » (ou touche + du pavé numérique), on parle, il répond à voix haute et agit sur le PC
  (ouvrir une application, écrire, chercher sur le web, rappels, regarder l'écran…).
- **Chat** : conversations écrites, avec des réponses interactives (tableaux, listes à cocher, questions).
- **Code** : crée une application à partir d'une phrase (aperçu à côté), ou travaille sur un dépôt GitHub.
- **Image** et **Vidéo** : dessin et vidéo en local.
- **Duel** : compare deux modèles à l'aveugle pour choisir les meilleurs.
- **Téléphone** : parler à Jaris depuis son téléphone, de partout.
- Interface en 24 langues ; Jaris choisit tout seul les modèles adaptés à la machine.

## Installer

Télécharger `Jaris-Setup-X.Y.Z.exe` dans les
[Releases](https://github.com/Leo6432/jaris/releases) et le lancer : Jaris installe lui-même ce dont il a besoin
(Ollama, modèles, voix) au premier démarrage.

## Pour les développeurs et les IA

Lire d'abord [`CLAUDE.md`](CLAUDE.md) (identique à `AGENTS.md`) : carte du code, règles et checklist de
publication. L'historique détaillé de chaque étape est dans [`docs/historique.md`](docs/historique.md).
L'ancien README (liste des étapes, en partie obsolète) est gardé dans
[`docs/ancien-readme.md`](docs/ancien-readme.md).

```
npm install
npm run dev         # lancer en développement
npm test            # tests de régression
```
