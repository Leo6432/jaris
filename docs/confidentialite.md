# Jaris — Politique de confidentialité / Privacy policy

*Dernière mise à jour : 26 novembre 2026 · Last updated: November 26, 2026*

[English version below](#english)

## Français

Jaris est un assistant vocal qui fonctionne **sur ton ordinateur**. L'intelligence artificielle (modèles de langage,
reconnaissance et synthèse de la voix, images, vidéos) tourne en local. Le développeur de Jaris ne reçoit **aucune**
de tes données : Jaris n'a ni compte, ni publicité, ni statistiques d'utilisation, ni mesure d'audience. La seule
exception, **seulement si tu l'acceptes**, ce sont les rapports d'erreurs anonymes décrits plus bas.

### Ce que Jaris utilise sur ton ordinateur

- **Le micro** : pour entendre le mot « Jaris » et tes demandes. Le son est transformé en texte sur ton ordinateur.
- **L'écran** : seulement quand tu demandes à Jaris de regarder ou de piloter ton écran. Les captures sont analysées
  par un modèle installé sur ton ordinateur.
- **Ce que Jaris enregistre**, uniquement sur ton ordinateur, dans son dossier de données (par défaut
  `C:\Users\<toi>\Jaris` pour la version Microsoft Store) : tes conversations, les notes de mémoire, ton profil (prénom,
  préférences), tes rappels, le journal de tes demandes, les images, vidéos et applications créées, tes votes des
  duels de modèles, et les réglages. Les clés et jetons que tu donnes (GitHub, Claude, services connectés) sont
  **chiffrés par Windows**.

Tu peux tout effacer à tout moment en supprimant ce dossier. Désinstaller Jaris ne l'efface pas, pour ne jamais
perdre tes données par erreur.

### Quand Jaris se connecte à Internet

- **Téléchargements** : le moteur local (Ollama), Python, les modèles d'IA et leurs fichiers sont téléchargés depuis
  leurs sites officiels (ollama.com, huggingface.co, github.com). Ces sites voient ton adresse IP, comme pour tout
  téléchargement.
- **Recherche sur le Web** : quand tu poses une question qui demande Internet, ta recherche est envoyée à DuckDuckGo
  (ou Startpage) et les pages trouvées sont lues.
- **Seulement si tu l'actives** :
  - **Claude (Anthropic)** : si tu enregistres ta propre clé API Claude, les duels de modèles que tu fais juger ou
    voter par Claude (la demande, les réponses, l'image éventuelle) sont envoyés à Anthropic, payés avec ta clé.
  - **GitHub** : en mode Code, si tu connectes ton compte GitHub, Jaris lit et modifie les dépôts que tu choisis.
  - **Accès depuis le téléphone** : passe par un tunnel chiffré Tailscale vers ton propre ordinateur.
  - **Services connectés (MCP)** et **machine louée** : seulement ceux que tu ajoutes toi-même ; ils reçoivent ce
    que tu leur demandes.

Ces services ont leurs propres règles de confidentialité. Jaris ne leur envoie rien d'autre que ce qui est décrit ici.

### Rapports d'erreurs (seulement si tu l'acceptes)

Jaris te demande une seule fois si tu veux aider à corriger les bugs. **Sans ton « oui », rien n'est envoyé.**

- **Ce qui part** quand Jaris rencontre une erreur ou plante : le message d'erreur, l'endroit du code de Jaris où elle
  s'est produite, la version de Jaris, la version de Windows et le type de PC (processeur, carte graphique,
  mémoire, taille de l'écran, langue de Windows).
- **Ce qui ne part jamais** : tes conversations, ta voix, tes fichiers, tes images, tes captures d'écran, ton prénom,
  ton nom d'utilisateur, le nom de ton ordinateur, tes adresses mail, ni le contenu de la mémoire du programme. Avant
  chaque envoi, Jaris efface ton nom des chemins de fichiers (`C:\Users\<user>\…`) et les adresses mail.
- **Où** : chez Sentry (Functional Software, Inc.), sur des serveurs situés en Allemagne (Union européenne). Ton
  adresse IP n'est pas enregistrée. Les rapports sont effacés automatiquement après 90 jours au plus.
- **Pour arrêter** : Options → Général → « Rapports d'erreurs ». L'envoi s'arrête tout de suite.

### Contenu créé par l'IA

Les réponses, images et vidéos sont créées par des modèles d'IA et peuvent être fausses ou inappropriées. Pour
signaler un contenu inapproprié ou poser une question : <https://github.com/Leo6432/jaris/issues>.

## English

Jaris is a voice assistant that runs **on your computer**. Its artificial intelligence (language models, speech
recognition and synthesis, images, videos) runs locally. The developer of Jaris receives **none** of your data: Jaris
has no account, no ads, no usage statistics and no analytics. The only exception, **only if you accept it**, is the
anonymous error reports described below.

### What Jaris uses on your computer

- **Microphone**: to hear the word “Jaris” and your requests. Audio is turned into text on your computer.
- **Screen**: only when you ask Jaris to look at or control your screen. Screenshots are analyzed by a model installed
  on your computer.
- **What Jaris stores**, only on your computer, in its data folder (by default `C:\Users\<you>\Jaris` for the
  Microsoft Store version): your conversations, memory notes, profile (first name, preferences), reminders, request
  log, the images, videos and apps it creates, your model-duel votes, and settings. Keys and tokens you provide
  (GitHub, Claude, connected services) are **encrypted by Windows**.

You can delete everything at any time by deleting this folder. Uninstalling Jaris does not delete it, so your data is
never lost by mistake.

### When Jaris connects to the Internet

- **Downloads**: the local engine (Ollama), Python, AI models and their files are downloaded from their official sites
  (ollama.com, huggingface.co, github.com). These sites see your IP address, as with any download.
- **Web search**: when a question needs the Internet, your search is sent to DuckDuckGo (or Startpage) and the pages
  found are read.
- **Only if you turn it on**:
  - **Claude (Anthropic)**: if you save your own Claude API key, the model duels you ask Claude to judge or vote on
    (the request, the answers, any image) are sent to Anthropic and billed to your key.
  - **GitHub**: in Code mode, if you connect your GitHub account, Jaris reads and changes the repositories you choose.
  - **Phone access**: goes through an encrypted Tailscale tunnel to your own computer.
  - **Connected services (MCP)** and **rented machine**: only the ones you add yourself; they receive what you ask them.

These services have their own privacy policies. Jaris sends them nothing beyond what is described here.

### Error reports (only if you accept)

Jaris asks you once whether you want to help fix bugs. **Without your “yes”, nothing is sent.**

- **What is sent** when Jaris hits an error or crashes: the error message, where in Jaris's code it happened, the Jaris
  version, the Windows version and the type of PC (processor, graphics card, memory, screen size, Windows
  language).
- **What is never sent**: your conversations, voice, files, images, screenshots, first name, user name, computer name,
  email addresses, or the contents of the program's memory. Before each report, Jaris removes your name from file paths
  (`C:\Users\<user>\…`) and any email address.
- **Where**: Sentry (Functional Software, Inc.), on servers located in Germany (European Union). Your IP address is not
  stored. Reports are deleted automatically after at most 90 days.
- **To stop**: Options → General → “Error reports”. Sending stops immediately.

### AI-generated content

Answers, images and videos are created by AI models and may be wrong or inappropriate. To report inappropriate content
or ask a question: <https://github.com/Leo6432/jaris/issues>.
