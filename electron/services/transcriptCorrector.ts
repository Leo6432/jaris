/**
 * Correcteur de ce que Léo a dit (étape 207, Léo : « pour le vocal, ajouter un correcteur un peu comme Apple »). La
 * transcription locale se trompe surtout sur les NOMS (« Charisse » pour « Jaris », « ouvre stime » pour « ouvre
 * Steam »).
 *
 * Étape 507 (Léo : « il n'y a pas un système de correction à la place d'utiliser un modèle ? », puis « oui ») : plus de
 * modèle. Le petit modèle chargé corrigeait aussi ce que la transcription avait BIEN entendu — lfm3:1.7b a changé
 * « Quelle heure est-il? » en « Quel heure est-il? » (journal de Léo, étape 505) — et coûtait 0,3 s ou plus par phrase.
 * À la place, une liste de mots que Jaris connaît déjà (applications du menu Démarrer, son nom, le prénom de Léo, les
 * titres de ses notes) : un mot entendu qui SE PRONONCE comme un mot de la liste, et qui n'est pas un mot courant, est
 * remplacé par celui-ci. Instantané, dans toutes les langues, et une phrase juste n'est jamais touchée : seuls les
 * mots de la liste peuvent y entrer. Écartés : Grammalecte et LanguageTool, qui corrigent la grammaire, pas les noms
 * mal entendus (et LanguageTool demande Java).
 */

export interface LexiconWord {
  /** Le mot tel qu'il s'écrit (« Steam », « Jaris »). */
  display: string
  /** Minuscules sans accents : un mot entendu identique n'est jamais « corrigé ». */
  plain: string
  /** Sa prononciation simplifiée (phonetic). */
  sound: string
}

export interface Lexicon {
  words: LexiconWord[]
}

/** Minuscules, sans accents. */
function plainOf(word: string): string {
  return word.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

/**
 * Une prononciation simplifiée, à la française, qui rapproche ce que la transcription confond : « steam » et « stime »
 * (stim), « Jaris » et « Charisse » (jari). Pas un vrai phonétiseur : juste assez pour des noms, et seulement des mots
 * de 4 sons ou plus sont comparés (sans quoi trop de mots courts se ressemblent).
 */
export function soundOf(word: string): string {
  let s = plainOf(word).replace(/[^a-z]/g, '')
  s = s
    .replace(/ph/g, 'f')
    // « Chrome », « Christophe » : « ch » devant une consonne se dit « k ».
    .replace(/ch(?=[^aeiouy]|$)/g, 'k')
    .replace(/(sch|sh|ch)/g, 'j')
    .replace(/g(?=[eiy])/g, 'j')
    .replace(/qu|ck|q/g, 'k')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/w/g, 'v')
    .replace(/z/g, 's')
    .replace(/h/g, '')
    .replace(/eau|au/g, 'o')
    .replace(/oo|ou/g, 'u')
    .replace(/ee|ea|y/g, 'i')
    .replace(/ai|ei/g, 'e')
    .replace(/(.)\1+/g, '$1')
  // Les finales muettes du français : « Charisse » → « jarise » → « jaris » → « jari ».
  s = s.replace(/e$/, '').replace(/[stdx]$/, '')
  return s
}

/**
 * Les mots courants ne sont jamais remplacés, même s'ils sonnent comme un nom de la liste (« pain » et l'application
 * « Paint »). Liste volontairement large sur les mots que Léo dit tous les jours à Jaris.
 */
const COMMON = new Set(
  (
    'alors aller allume appelle appeler apres arrete arreter aujourd hui aussi autre avant avec avoir baisse bien bonjour bonsoir ' +
    'cela celle celui cherche chercher chose comme comment dans demain depuis dernier dessine dessiner deux dire dis donne donner ' +
    'dont ecris ecrire elle encore ensuite entre envoie envoyer etre fais faire fait fenetre ferme fermer heure heures ici jamais ' +
    'jour jours juste lance lancer leur lire liste maintenant mais matin meme merci mets mettre minute minutes moins monte musique ' +
    'note notes notre nous nouveau ouvre ouvrir page pain parce pause personne petit peut peux plus pour pourquoi premier prends ' +
    'quand quel quelle quelles quels quoi rappel rappelle rappelles regarde retiens sans semaine seulement soir sont sous suivante ' +
    'sur temps tout toute toutes tous tres trop trouve vers veux voila voir vous ecran image photo photos video videos fichier ' +
    'fichiers dossier mail mails message messages courrier calendrier horloge meteo parametres reglages musique paint word code ' +
    'pari paris paul pierre marie jean julie maman papa voiture maison travail ecole film films jeu jeux carte cartes'
  ).split(' ')
)

const MIN_SOUND = 4

/**
 * Un mot qui ne diffère d'un mot de la liste que par une terminaison d'accord (« signale » / Signal, « blocs » / Bloc,
 * « notes » / Note) est un vrai mot, pas un nom mal entendu (mesuré sur les phrases du test des modèles).
 */
const AGREEMENT_ENDING = /^(?:e|s|es|x|nt|ent)$/
function onlyEndingDiffers(a: string, b: string): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  if (!long.startsWith(short)) return false
  const ending = long.slice(short.length)
  const doubled = ending.startsWith(short.slice(-1)) ? ending.slice(1) : null
  return AGREEMENT_ENDING.test(ending) || (doubled !== null && /^(?:e|es)$/.test(doubled))
}

/** La liste des mots de Jaris : chaque mot de 4 lettres ou plus des noms donnés (« Google Chrome » → Google, Chrome). */
export function buildLexicon(sources: { apps?: readonly string[]; userName?: string | null; notes?: readonly string[] }): Lexicon {
  const names = ['Jaris', ...(sources.userName ? [sources.userName] : []), ...(sources.apps ?? []), ...(sources.notes ?? [])]
  const seen = new Map<string, LexiconWord>()
  for (const name of names) {
    for (const word of name.split(/[^\p{L}\p{N}]+/u)) {
      if (word.length < 4) continue
      const plain = plainOf(word)
      if (seen.has(plain)) continue
      const sound = soundOf(word)
      if (sound.length < MIN_SOUND) continue
      seen.set(plain, { display: word, plain, sound })
    }
  }
  return { words: [...seen.values()] }
}

/**
 * La phrase à utiliser : chaque mot qui sonne comme UN SEUL mot de la liste (et qui n'est ni ce mot, ni un mot courant)
 * est remplacé ; tout le reste — ponctuation, espaces, autres mots — reste exactement tel qu'entendu.
 */
export function correctTranscript(text: string, lexicon: Lexicon): { text: string; changed: boolean; replaced: [string, string][] } {
  const replaced: [string, string][] = []
  const out = text.replace(/[\p{L}\p{N}]+/gu, (heard) => {
    const plain = plainOf(heard)
    if (heard.length < 4 || COMMON.has(plain)) return heard
    if (lexicon.words.some((w) => w.plain === plain)) return heard
    const sound = soundOf(heard)
    if (sound.length < MIN_SOUND) return heard
    const matches = new Set(lexicon.words.filter((w) => w.sound === sound && !onlyEndingDiffers(w.plain, plain)).map((w) => w.display))
    if (matches.size !== 1) return heard
    const [display] = matches
    replaced.push([heard, display])
    return display
  })
  return { text: out, changed: replaced.length > 0, replaced }
}
