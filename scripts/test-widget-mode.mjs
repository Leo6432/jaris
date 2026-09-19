import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import ts from 'typescript'

/**
 * Ce que Jaris devient quand on quitte sa fenêtre dépend maintenant du mode où on était, à la demande de
 * Léo : "quand on se met dans chat, et on part ... ça met une barre de texte en haut au centre comme le
 * widget vocal, et on peut lui demander une question sans aller directement sur l'application" ; puis, sur
 * le mode Code : "ça doit rien faire aucun widget".
 *
 * - Agent vocal -> le widget cercle qui écoute, inchangé ;
 * - Chat -> une barre de texte au même endroit (ChatWidget.tsx), et Jaris ne réagit PLUS à la voix : le
 *   cercle qu'elle remplace était le seul à écouter, et un Jaris qui entendrait le mot d'activation sans
 *   rien pouvoir montrer serait un Jaris qui a l'air cassé ;
 * - Code -> aucune fenêtre du tout.
 *
 * Test STRUCTUREL, comme test-quit-blur-guard.mjs et test-native-dialog-guard.mjs : il n'y a ni Windows ni
 * vraie fenêtre Electron dans cet environnement, donc ce qui est vérifiable ici, c'est que le câblage
 * existe — que le comportement réel corresponde reste à confirmer en usage réel.
 */
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

function sourceWithoutComments(relativePath, jsx = ts.JsxEmit.None) {
  return ts.transpileModule(readFileSync(join(projectRoot, relativePath), 'utf8'), {
    compilerOptions: { removeComments: true, jsx, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }
  }).outputText
}

const mainSource = sourceWithoutComments('electron/main.ts')
const appSource = sourceWithoutComments('src/App.tsx', ts.JsxEmit.Preserve)
const widgetSource = sourceWithoutComments('src/components/ChatWidget.tsx', ts.JsxEmit.Preserve)

test('le mode actif est RETENU côté main, pas seulement utilisé pour suspendre l’écoute', () => {
  assert.match(
    mainSource,
    /ipcMain\.on\(IPC_CHANNELS\.setActiveMode,[\s\S]{0,200}?activeMode = mode/,
    'le handler setActiveMode n’enregistre pas le mode : au moment du repli, la fenêtre est déjà en train ' +
      'de perdre le focus — le main ne peut plus le demander au renderer, il doit déjà le savoir'
  )
})

test('quitter Jaris depuis le mode Code n’affiche AUCUN widget', () => {
  const showWidget = /function showWidgetWindow\([^)]*\)[\s\S]{0,1200}?\n\}/.exec(mainSource)
  assert.ok(showWidget, 'showWidgetWindow introuvable dans main.ts')
  assert.match(
    showWidget[0],
    /activeMode === ['"]code['"][\s\S]{0,200}?return/,
    'showWidgetWindow ne sort pas en mode Code : Jaris continuerait d’afficher un widget alors que Léo ' +
      'a demandé qu’il disparaisse complètement'
  )
})

test('un widget déjà affiché est caché quand on passe en mode Code, pas laissé sous son ancienne forme', () => {
  const showWidget = /function showWidgetWindow\([^)]*\)[\s\S]{0,1200}?\n\}/.exec(mainSource)
  assert.match(
    showWidget[0],
    /activeMode === ['"]code['"][\s\S]{0,200}?widgetWindow\.hide\(\)/,
    'le widget du mode précédent resterait à l’écran en mode Code, sous une forme qui ne correspond plus à rien'
  )
})

test('la forme du widget vient du mode actif, pas d’une valeur décidée séparément', () => {
  assert.match(
    mainSource,
    /function currentWidgetMode\(\)[\s\S]{0,200}?activeMode === ['"]chat['"] \? ['"]chat['"] : ['"]voice['"]/,
    'currentWidgetMode doit dériver du mode actif : la taille NATIVE de la fenêtre et le contenu DESSINÉ ' +
      'doivent venir de la même source, sinon les deux se contredisent (orbe rogné en fine bande, déjà vécu)'
  )
  assert.match(
    mainSource,
    /widgetWindow\.webContents\.send\(IPC_CHANNELS\.widgetMode, displayedWidgetMode\)/,
    'le renderer du widget n’est jamais prévenu de la forme à dessiner'
  )
  assert.match(
    mainSource,
    /currentWidgetMode\(\) === ['"]chat['"][\s\S]{0,120}?['"]chat-idle['"]/,
    'le mode Chat ne possède pas de forme inactive distincte de sa barre de saisie'
  )
})

test('la taille native du widget texte est différente de celle du widget vocal', () => {
  const position = /function positionWidgetWindow\([\s\S]{0,1600}?\n\}/.exec(mainSource)
  assert.ok(position, 'positionWidgetWindow introuvable dans main.ts')
  assert.match(
    position[0],
    /currentWidgetMode\(\) === ['"]chat['"]/,
    'positionWidgetWindow ignore la forme du widget : une barre de saisie dessinée dans la pilule de 84px ' +
      'du widget vocal serait rognée exactement comme l’orbe l’avait été'
  )
  assert.match(position[0], /WIDGET_CHAT_WIDTH/, 'aucune largeur dédiée au widget texte')
})

test('l’écoute vocale ne reprend au repli QUE depuis le mode Agent vocal', () => {
  assert.match(
    mainSource,
    /function applyListeningForActiveMode\(\)[\s\S]{0,200}?setListeningSuspended\(activeMode !== ['"]voice['"]\)/,
    'l’écoute doit rester suspendue au repli depuis Chat/Code : la barre de texte ne montre pas qu’on est ' +
      'entendu, et en mode Code il n’y a même plus de fenêtre pour le montrer'
  )
  for (const event of ['minimize', 'blur']) {
    const handler = new RegExp(`win\\.on\\(['"]${event}['"],[\\s\\S]{0,400}?\\}\\);`).exec(mainSource)
    assert.ok(handler, `handler '${event}' introuvable dans main.ts`)
    assert.match(
      handler[0],
      /applyListeningForActiveMode\(\)/,
      `le handler '${event}' force encore la reprise de l’écoute sans regarder le mode actif`
    )
  }
})

test('une émotion du pipeline vocal ne redimensionne jamais le widget texte', () => {
  const emotionHandler = /pipeline\.on\(['"]emotion['"][\s\S]{0,900}?broadcast\(IPC_CHANNELS\.emotion/.exec(mainSource)
  assert.ok(emotionHandler, "handler 'emotion' introuvable dans main.ts")
  assert.match(
    emotionHandler[0],
    /currentWidgetMode\(\) === ['"]voice['"]/,
    'une émotion vocale déplierait le widget texte par-dessus sa barre de saisie, alors qu’il n’écoute pas'
  )
})

test('le widget texte dit au main la hauteur qu’il occupe VRAIMENT', () => {
  assert.match(
    widgetSource,
    /window\.jaris\.setChatWidgetHeight\(/,
    'sans ça, le main ne peut pas savoir qu’une question est partie : rien ne passe par lui quand on tape'
  )
  assert.match(
    widgetSource,
    /getBoundingClientRect\(\)\.bottom/,
    'la hauteur doit être MESURÉE sur le contenu réel : une hauteur fixe taillée pour la réponse la plus ' +
      'longue laisserait, sur une réponse courte, des centaines de pixels invisibles qui avalent les clics'
  )
  assert.match(
    mainSource,
    /ipcMain\.on\(IPC_CHANNELS\.setChatWidgetHeight,[\s\S]{0,400}?positionWidgetWindow\(/,
    'le main reçoit la hauteur mais ne redimensionne jamais la fenêtre avec'
  )
})

test('le rendu Chat possède un état inactif et + le remplace par la barre', () => {
  assert.match(widgetSource, /inactive[\s\S]{0,800}?chat-widget__idle/)
  assert.match(appSource, /widgetMode === ['"]chat-idle['"][\s\S]{0,300}?inactive=/)
  assert.match(mainSource, /activeMode === ['"]chat['"][\s\S]{0,180}?showWidgetWindow\(true\)/)
  assert.match(mainSource, /displayedWidgetMode === ['"]chat['"][\s\S]{0,80}?widgetWindow\.focus\(\)/)
})

test('quitter la barre avec la souris replie réellement la fenêtre en Chat inactif', () => {
  assert.match(widgetSource, /onMouseLeave[\s\S]{0,100}?collapseChatWidget\(\)/)
  assert.match(mainSource, /function collapseChatWidget\(\)[\s\S]{0,500}?displayedWidgetMode = ['"]chat-idle['"][\s\S]{0,250}?positionWidgetWindow\(widgetWindow, false, true\)/)
  assert.match(mainSource, /ipcMain\.on\(IPC_CHANNELS\.collapseChatWidget/)
  assert.match(mainSource, /function startChatPointerWatch\(\)[\s\S]{0,900}?screen\.getCursorScreenPoint\(\)[\s\S]{0,400}?chatPointerWasInside[\s\S]{0,200}?collapseChatWidget\(\)/)
  assert.match(mainSource, /displayedWidgetMode === ['"]chat['"][\s\S]{0,160}?startChatPointerWatch\(\)/)
  assert.match(mainSource, /win\.on\(['"]blur['"],\s*\(\)\s*=>\s*collapseChatWidget\(\)\)/)
  assert.match(mainSource, /function collapseChatWidget\(\)[\s\S]{0,350}?chatWidgetDraftPresent/)
  assert.match(widgetSource, /setChatWidgetDraftPresent\(input\.length > 0\)/)
  assert.match(widgetSource, /onMouseEnter[\s\S]{0,100}?armChatWidgetPointer\(\)/)
})

test('la fenêtre native réserve une vraie marge au halo de tous les widgets', () => {
  assert.match(mainSource, /WIDGET_COLLAPSED_WIDTH = 104/)
  assert.match(mainSource, /WIDGET_COLLAPSED_HEIGHT = 68/)
  assert.match(mainSource, /WIDGET_CHAT_COLLAPSED_HEIGHT = 68/)
  assert.match(appSource, /app--widget-chat-idle/)
})

test('le renderer du widget demande sa forme au montage ET écoute les changements', () => {
  assert.match(
    appSource,
    /window\.jaris\.getWidgetMode\(\)/,
    'sans lecture au montage, un widget tout juste créé raterait le `widgetMode` envoyé juste avant son ' +
      'affichage (il n’écoute pas encore) et resterait sur sa forme par défaut'
  )
  assert.match(
    appSource,
    /window\.jaris\.onWidgetMode\(/,
    'sans abonnement, la forme ne changerait plus jamais — la fenêtre du widget n’est jamais détruite, ' +
      'elle est réutilisée d’un repli à l’autre avec des modes différents'
  )
})

test('le Chat relit son fil en redevenant visible (une question posée depuis le widget doit y apparaître)', () => {
  const chatPanelSource = sourceWithoutComments('src/components/ChatPanel.tsx', ts.JsxEmit.Preserve)
  const refresh = /visibilitychange[\s\S]{0,80}/.exec(chatPanelSource)
  assert.ok(
    refresh,
    'ChatPanel n’écoute pas visibilitychange : sa fenêtre n’est jamais détruite, donc son fil resterait ' +
      'figé sur ce qu’il affichait avant le repli et l’échange fait depuis le widget n’apparaîtrait jamais'
  )
  assert.match(chatPanelSource, /visibilitychange[\s\S]{0,300}?getChatHistory\(\)/)
})
