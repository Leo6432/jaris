import { app } from 'electron'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { config } from '../config'
import { getLiveGpuStatus, pickSafeModel } from './hardwareScan'
import { chatWithOllama, listInstalledModels, type OllamaMessage } from './ollama'
import { getProfile } from './profileStore'
import type { GeneratedApp } from '../../shared/ipc'

/**
 * Fenêtre de contexte dédiée à la génération de code : le modèle doit produire un fichier HTML complet
 * (souvent 200+ lignes), puis le relire EN ENTIER pour le corriger à la passe suivante. La valeur par
 * défaut de la conversation (4096) tronquerait le fichier en pleine relecture.
 */
const CODE_NUM_CTX = 16384

/**
 * Consignes strictes partagées par les deux passes (génération et critique) — c'est le "scaffolding" qui
 * fait la différence entre un appel LLM brut et un vrai générateur d'applications : sans ces règles, un
 * modèle local produit typiquement une page grise sans style, avec un `<script src>` vers un CDN qui ne
 * chargera jamais (Jaris est 100% local et l'aperçu tourne dans une iframe sans accès réseau).
 */
const APP_RULES = [
  "Produis UN SEUL fichier HTML complet et autonome, commençant par <!DOCTYPE html> et finissant par </html>.",
  "AUCUNE ressource externe : pas de <script src>, pas de <link href> vers un CDN, pas de police Google " +
    "Fonts, pas d'image distante, pas de fetch vers une API. Tout (CSS, JavaScript, icônes) doit être écrit " +
    "en dur dans le fichier. Pour les icônes et les illustrations, utilise du SVG inline. Pour les données " +
    "d'exemple, écris-les en dur dans le JavaScript.",
  "JavaScript classique uniquement (pas de React, Vue, ni aucun framework, pas de syntaxe de modules " +
    "import/export) : le fichier doit fonctionner en l'ouvrant directement dans un navigateur.",
  "TOUT le JavaScript doit être à l'intérieur d'une balise <script> placée juste avant </body>, et tout le " +
    "CSS à l'intérieur d'une balise <style> dans le <head>. Aucune ligne de code ne doit se retrouver " +
    "directement dans le <body> : elle s'afficherait alors comme du texte à l'écran au lieu de s'exécuter.",
  "Écris le code sur plusieurs lignes correctement indentées, jamais tout sur une seule ligne. Dans le " +
    "JavaScript, utilise uniquement des commentaires /* ... */ et jamais // : si le code se retrouve " +
    "malgré tout sur une seule ligne, un // commenterait tout le reste de la ligne et casserait la page.",
  "Soigne le design : palette cohérente, vraie hiérarchie typographique, espacements réguliers, coins " +
    "arrondis, états au survol, et une mise en page responsive (grid ou flex) qui tient aussi sur mobile.",
  "Structure le code en sections claires et commentées, avec des noms de fonctions et de classes CSS " +
    "explicites, plutôt qu'un seul bloc monolithique.",
  "Gère les cas limites visibles par l'utilisateur : liste vide, champ non rempli, saisie invalide, action " +
    "impossible. L'interface ne doit jamais rester silencieuse ou cassée après une action.",
  "Si l'application a besoin de garder des données entre deux ouvertures, utilise localStorage, en " +
    "protégeant chaque lecture/écriture par un try/catch."
]

const GENERATE_SYSTEM_PROMPT =
  "Tu es un développeur front-end expert. Tu génères des applications web complètes et fonctionnelles à " +
  "partir d'une description en langage naturel.\n\n" +
  `Règles impératives :\n${APP_RULES.map((r) => `- ${r}`).join('\n')}\n\n` +
  "Réponds UNIQUEMENT avec le code du fichier, dans un bloc ```html. Aucune explication avant ou après."

const CRITIQUE_SYSTEM_PROMPT =
  "Tu es un relecteur de code front-end exigeant. On te donne le code d'une application web générée par un " +
  "autre développeur, et la demande initiale de l'utilisateur. Ton travail est de livrer une version " +
  "corrigée et améliorée de ce fichier.\n\n" +
  "Vérifie et corrige en priorité :\n" +
  "- les erreurs de syntaxe HTML/CSS/JavaScript, les balises non fermées, les fonctions appelées mais " +
  "jamais définies, les identifiants référencés dans le JavaScript mais absents du HTML ;\n" +
  "- toute ressource externe qui aurait été laissée (CDN, police distante, image distante, appel réseau) : " +
  "supprime-la et remplace-la par un équivalent écrit en dur dans le fichier ;\n" +
  "- les éléments affichés mais jamais mis en forme, ou visuellement incohérents avec le reste ;\n" +
  "- les cas limites non gérés (liste vide, champ non rempli, saisie invalide) ;\n" +
  "- l'écart avec la demande initiale : une fonctionnalité demandée mais absente doit être ajoutée.\n\n" +
  `Le fichier corrigé doit toujours respecter ces règles :\n${APP_RULES.map((r) => `- ${r}`).join('\n')}\n\n` +
  "Réponds UNIQUEMENT avec le fichier complet corrigé, dans un bloc ```html. Aucune explication, aucun " +
  "commentaire de relecture, aucun résumé des changements."

const REPAIR_SYSTEM_PROMPT =
  "Tu répares un fichier HTML autonome dont les défauts ont déjà été identifiés. On te donne le fichier et " +
  "la liste précise des problèmes détectés automatiquement. Corrige EXACTEMENT ces problèmes, sans " +
  "réécrire ni redesigner le reste de la page.\n\n" +
  `Le fichier réparé doit respecter ces règles :\n${APP_RULES.map((r) => `- ${r}`).join('\n')}\n\n` +
  "Réponds UNIQUEMENT avec le fichier complet réparé, dans un bloc ```html. Aucune explication."

/**
 * Vérification structurelle du fichier produit, avant tout affichage : un petit modèle local se trompe
 * régulièrement de façon *visible mais mécaniquement détectable* — typiquement en laissant le JavaScript
 * dans le <body> au lieu d'une balise <script>, où il s'affiche comme un pavé de texte au milieu de la
 * page. Renvoie la liste des problèmes trouvés, formulée pour être renvoyée telle quelle au modèle
 * (passe de réparation) et affichée à l'utilisateur si elle persiste.
 */
export function validateGeneratedHtml(html: string): string[] {
  const issues: string[] = []

  if (!/<html[\s>]/i.test(html)) issues.push('la balise <html> est absente')
  if (!/<body[\s>]/i.test(html)) issues.push('la balise <body> est absente')

  const opened = (html.match(/<script[\s>]/gi) ?? []).length
  const closed = (html.match(/<\/script>/gi) ?? []).length
  if (opened !== closed) {
    issues.push(`les balises <script> ne sont pas appariées (${opened} ouvrante(s), ${closed} fermante(s))`)
  }

  const external = [...new Set(html.match(/(?:src|href)\s*=\s*["']https?:\/\/[^"']+/gi) ?? [])]
  if (external.length) {
    issues.push(
      `le fichier charge des ressources externes, interdites ici : ${external.slice(0, 3).join(', ')}` +
        ' — remplace-les par un équivalent écrit en dur dans le fichier'
    )
  }

  // Texte réellement affiché à l'écran : tout ce qui reste une fois le code (script/style), les
  // commentaires et les balises retirés. Y trouver plusieurs marqueurs de JavaScript signifie que du code
  // a été écrit hors d'une balise <script> et sera donc affiché tel quel au lieu de s'exécuter.
  const visibleText = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')

  const jsSignals = [
    /document\.(addEventListener|querySelector|getElementById)/,
    /\bfunction\s+\w+\s*\(/,
    /=>\s*\{/,
    /\b(?:const|let|var)\s+\w+\s*=/,
    /\.addEventListener\s*\(/
  ]
  // Deux marqueurs minimum : un seul pourrait apparaître par hasard dans un texte qui parle de code.
  if (jsSignals.filter((pattern) => pattern.test(visibleText)).length >= 2) {
    issues.push(
      "du code JavaScript se trouve directement dans le <body> et s'affiche comme du texte à l'écran au " +
        "lieu de s'exécuter : déplace TOUT ce code à l'intérieur d'une balise <script> avant </body>"
    )
  }

  return issues
}

/**
 * Récupère le code d'un bloc ```html (ou ``` tout court) dans la réponse du modèle. Certains modèles
 * répondent avec le HTML brut sans bloc de code malgré la consigne : on le détecte alors directement au
 * <!DOCTYPE ou au <html, plutôt que de renvoyer une erreur pour une réponse en réalité exploitable.
 */
function extractHtml(raw: string): string | null {
  const fences = [...raw.matchAll(/```(?:html)?\s*\n([\s\S]*?)```/gi)].map((match) => match[1].trim())

  // Un petit modèle ignore régulièrement la consigne "un seul bloc" et découpe le fichier sur plusieurs
  // blocs de code successifs (le <head> dans l'un, le <body> dans le suivant). Ne garder que le premier
  // bloc donnait alors un document tronqué, sans <body> — la concaténation reconstitue le vrai fichier.
  // Elle est essayée en DERNIER pour que deux versions complètes proposées en alternative gardent la
  // première plutôt que de se retrouver collées bout à bout.
  const candidates = fences.length ? [...fences] : [raw]
  if (fences.length > 1) candidates.push(fences.join('\n'))

  const documents = candidates
    .map((candidate) => {
      const start = candidate.search(/<!DOCTYPE html|<html[\s>]/i)
      return start === -1 ? null : candidate.slice(start).trim()
    })
    .filter((document): document is string => document !== null)

  if (!documents.length) return null

  // Le meilleur candidat est le plus complet : un document qui a vraiment un <body> et une fermeture
  // </html> vaut mieux qu'un fragment qui commence bien mais s'arrête au milieu.
  const score = (document: string): number =>
    (/<body[\s>]/i.test(document) ? 2 : 0) + (/<\/html>/i.test(document) ? 1 : 0)

  return documents.reduce((best, document) => (score(document) > score(best) ? document : best))
}

/**
 * Le meilleur modèle disponible pour du code : le palier "puissant" du profil, avec le même repli que la
 * conversation si la VRAM réellement libre à l'instant présent ne suffit plus (jeu ou navigateur ouvert en
 * parallèle). Générer du code est la tâche la plus exigeante de Jaris — jamais de palier rapide ici.
 */
async function resolveCodeModel(onStatus: (message: string) => void): Promise<string> {
  const profile = await getProfile()
  const fallback = profile?.models?.large ?? config.ollama.model
  const live = await getLiveGpuStatus()
  if (live.freeVramGb === null) return fallback

  const installed = await listInstalledModels().catch(() => [] as string[])
  const safe = pickSafeModel('large', live.freeVramGb, installed, fallback)
  if (safe !== fallback) {
    onStatus(`VRAM libre actuelle : ${live.freeVramGb} Go (insuffisant pour ${fallback}) : repli sur ${safe}.`)
  }
  return safe
}

/** Nom de dossier lisible et sans surprise pour le système de fichiers, dérivé de la demande. */
function slugify(description: string): string {
  const slug = description
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return slug || 'app'
}

/** Dossier où toutes les applications générées sont enregistrées (une par sous-dossier horodaté). */
export function getGeneratedAppsDir(): string {
  return join(app.getPath('userData'), 'generated-apps')
}

/**
 * Génère une application web autonome à partir d'une description, en deux passes façon Lovable/Emergent
 * plutôt qu'un simple appel LLM brut :
 *  1. génération, guidée par un prompt système enrichi de consignes strictes (APP_RULES) ;
 *  2. critique : un second passage relit le code produit pour corriger la syntaxe, retirer les dépendances
 *     externes oubliées et combler les écarts avec la demande, avant tout affichage.
 * Si la passe de critique échoue ou renvoie quelque chose d'inexploitable, on garde le premier jet plutôt
 * que de faire échouer toute la génération.
 *
 * `currentHtml` (modification d'une application déjà générée) est le "contexte ciblé" : on envoie
 * exactement le fichier à modifier et la nouvelle demande, jamais tout l'historique de la discussion.
 */
export async function generateApp(
  description: string,
  onStatus: (message: string) => void,
  currentHtml?: string
): Promise<GeneratedApp> {
  const model = await resolveCodeModel(onStatus)
  onStatus(`Modèle utilisé : ${model}`)

  const userPrompt = currentHtml
    ? `Voici le fichier actuel de l'application :\n\n\`\`\`html\n${currentHtml}\n\`\`\`\n\n` +
      `Modification demandée : ${description}\n\n` +
      "Renvoie le fichier complet modifié, pas seulement les parties changées."
    : `Application à créer : ${description}`

  onStatus(currentHtml ? 'Application en cours de modification…' : "Génération de l'application…")
  const generateMessages: OllamaMessage[] = [
    { role: 'system', content: GENERATE_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ]
  const first = await chatWithOllama(generateMessages, undefined, model, 'high', undefined, CODE_NUM_CTX)
  const draft = extractHtml(first.content)
  if (!draft) {
    throw new Error("Le modèle n'a pas renvoyé de code HTML exploitable. Reformule ta demande, ou relance.")
  }

  onStatus('Relecture du code par un second agent (cohérence, style, syntaxe)…')
  let final = draft
  try {
    const critiqueMessages: OllamaMessage[] = [
      { role: 'system', content: CRITIQUE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Demande initiale de l'utilisateur : ${description}\n\nCode à relire :\n\n\`\`\`html\n${draft}\n\`\`\``
      }
    ]
    const reviewed = await chatWithOllama(critiqueMessages, undefined, model, 'high', undefined, CODE_NUM_CTX)
    const reviewedHtml = extractHtml(reviewed.content)
    if (reviewedHtml) {
      final = reviewedHtml
      onStatus('Relecture terminée.')
    } else {
      onStatus('La relecture n\'a rien renvoyé d\'exploitable : le premier jet est conservé.')
    }
  } catch (err) {
    onStatus(`Relecture impossible (${err instanceof Error ? err.message : String(err)}) : le premier jet est conservé.`)
  }

  // Vérification structurelle : la relecture ci-dessus est faite "au jugé" par le modèle, qui laisse
  // régulièrement passer des défauts pourtant mécaniquement détectables (code hors <script>, balises non
  // appariées, CDN oublié). Ici on les détecte pour de vrai, et on les renvoie au modèle avec la liste
  // exacte de ce qui ne va pas — beaucoup plus efficace qu'une nouvelle demande de relecture générique.
  let issues = validateGeneratedHtml(final)
  if (issues.length) {
    onStatus(`Vérification : ${issues.length} problème(s) détecté(s), tentative de réparation…`)
    for (const issue of issues) onStatus(`  - ${issue}`)
    try {
      const repairMessages: OllamaMessage[] = [
        { role: 'system', content: REPAIR_SYSTEM_PROMPT },
        {
          role: 'user',
          content:
            `Problèmes détectés :\n${issues.map((i) => `- ${i}`).join('\n')}\n\n` +
            `Fichier à réparer :\n\n\`\`\`html\n${final}\n\`\`\``
        }
      ]
      const repaired = await chatWithOllama(repairMessages, undefined, model, 'high', undefined, CODE_NUM_CTX)
      const repairedHtml = extractHtml(repaired.content)
      // La réparation n'est gardée que si elle améliore vraiment les choses : un modèle peut très bien
      // renvoyer une version differemment cassée, auquel cas on garde la précédente.
      if (repairedHtml) {
        const remaining = validateGeneratedHtml(repairedHtml)
        if (remaining.length < issues.length) {
          final = repairedHtml
          issues = remaining
        }
      }
      onStatus(issues.length ? `Réparation partielle : ${issues.length} problème(s) restant(s).` : 'Réparation réussie.')
    } catch (err) {
      onStatus(`Réparation impossible (${err instanceof Error ? err.message : String(err)}).`)
    }
  } else {
    onStatus('Vérification : aucun problème structurel détecté.')
  }

  const dir = join(getGeneratedAppsDir(), `${Date.now()}-${slugify(description)}`)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'index.html'), final, 'utf-8')
  onStatus(`Application enregistrée dans ${dir}`)

  return { html: final, path: dir, issues }
}
