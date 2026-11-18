# Jaris sur le Microsoft Store — ce qu'il faut remplir

Étape 491. Identité (Espace partenaires → Jaris → Identité du produit) : `Moulard.Jaris`, éditeur
`CN=32D80499-7B84-467E-9549-326C1D710140`, `Moulard`, Store ID `9MW4KQRBLSPD`.

Le paquet à déposer est `Jaris-Store-X.Y.Z.msix`, joint à chaque Release GitHub (à côté de `Jaris-Setup-X.Y.Z.exe`).
Il n'est pas signé : le Store le signe après validation. Le numéro de version doit monter à chaque dépôt.

## Packages

Déposer `Jaris-Store-X.Y.Z.msix`. Familles d'appareils : **Windows 10/11 Desktop** seulement.

## Disponibilité

Marchés : au choix (tous par défaut). Prix : gratuit.

## Propriétés

- Catégorie : **Productivité** (sous-catégorie : aucune).
- Politique de confidentialité : `https://github.com/Leo6432/jaris/blob/claude/jaris-local-ai-assistant-a2drk4/docs/confidentialite.md`
- Site web : `https://github.com/Leo6432/jaris`
- Support : `https://github.com/Leo6432/jaris/issues`
- Configuration requise (à cocher) : clavier, souris, **micro** (« recommandé ») ; mémoire 16 Go minimum,
  32 Go recommandée ; carte graphique 8 Go recommandée.
- « Ce produit contient du contenu généré par IA en direct » (Live Generative AI) : **Oui** (règle 11.16).

## Évaluation de l'âge (questionnaire IARC)

Répondre honnêtement ; points propres à Jaris :
- Catégorie d'application : **« Application » (pas un jeu)**, type outil/productivité.
- Les utilisateurs peuvent-ils communiquer entre eux / partager du contenu ? **Non**.
- Accès non restreint à Internet (navigation, recherche) ? **Oui** (recherche Web intégrée).
- Contenu généré par IA, sans filtre absolu ? **Oui**.
- Partage de la position ? **Non**. Achats ? **Non**.

## Description dans le Store

### Français (fr-FR)

**Description**

> Au premier lancement, Jaris télécharge et installe lui-même son moteur d'IA local (Ollama), Python et les modèles
> adaptés à ton PC : prévois de la place sur le disque et une connexion Internet.
>
> Jaris est un assistant IA vocal qui tourne entièrement sur ton ordinateur. Dis « Jaris » et parle-lui : il répond à
> voix haute, cherche sur le Web, ouvre tes applications, regarde ton écran quand tu le lui demandes, retient ce que tu
> lui confies et te rappelle ce qu'il faut. Tes conversations restent sur ton PC.
>
> - Vocal, Chat avec plusieurs conversations, et accès depuis ton téléphone.
> - Code : crée une application à partir d'une phrase, ou travaille sur un dépôt GitHub.
> - Image (Z-Image-Turbo) et vidéo (FastWan 2.2), créées sur ton PC.
> - Duels : compare les modèles à l'aveugle et Jaris choisit les meilleurs pour ta machine.
> - 24 langues.
>
> Jaris utilise une IA générative en direct : ses réponses, images et vidéos peuvent être fausses ou inappropriées.
> Pour signaler un contenu : https://github.com/Leo6432/jaris/issues

**Fonctionnalités** (une par ligne)
- Assistant vocal 100 % local : mot « Jaris », voix naturelle
- Chat, recherche Web et mémoire
- Pilotage des applications et de l'écran
- Création d'applications, d'images et de vidéos
- Duels de modèles d'IA à l'aveugle
- Accès depuis le téléphone

**Mots-clés** : assistant vocal, IA locale, chatbot, Ollama, génération d'images

### English (en-US)

**Description**

> On first launch, Jaris downloads and installs its own local AI engine (Ollama), Python and the models suited to your
> PC: make sure you have disk space and an Internet connection.
>
> Jaris is a voice AI assistant that runs entirely on your computer. Say “Jaris” and talk: it answers out loud,
> searches the Web, opens your apps, looks at your screen when you ask, remembers what you tell it and reminds you of
> what matters. Your conversations stay on your PC.
>
> - Voice, Chat with multiple conversations, and access from your phone.
> - Code: build an app from one sentence, or work on a GitHub repository.
> - Image (Z-Image-Turbo) and video (FastWan 2.2), created on your PC.
> - Duels: compare models blind and Jaris picks the best ones for your machine.
> - 24 languages.
>
> Jaris uses live generative AI: its answers, images and videos may be wrong or inappropriate. To report content:
> https://github.com/Leo6432/jaris/issues

**Features**
- 100% local voice assistant: “Jaris” wake word, natural voice
- Chat, Web search and memory
- App and screen control
- App, image and video creation
- Blind AI model duels
- Access from your phone

**Keywords**: voice assistant, local AI, chatbot, Ollama, image generation

### Captures d'écran

Au moins 1 (jusqu'à 10), 1366×768 ou plus, en PNG : prendre l'écran Vocal (orbe), le Chat, le mode Image et les Duels
sur le PC de Léo (touche Windows + Maj + S).

## Notes pour la certification (champ « Notes for certification »)

> No account or login is needed. On first launch Jaris downloads its local AI runtime (Ollama from ollama.com),
> a Python runtime (python-build-standalone from github.com) and AI models (ollama.com, huggingface.co) suited to the
> machine; this is the app's described functionality, disclosed at the top of the description. Without a GPU it still
> runs on the CPU, more slowly. Features using third-party services (Claude API key, GitHub, MCP servers, rented
> machine) are optional and only enabled by the user. Updates are delivered only through the Store (the in-app updater
> is disabled in the Store version). The startup task is declared in the manifest and disabled by default.
