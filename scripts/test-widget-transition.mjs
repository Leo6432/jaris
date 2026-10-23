import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const main=readFileSync(new URL('../electron/main.ts',import.meta.url),'utf8')
// `mode`/`chatHeight` : positionWidgetWindow dérive maintenant sa taille de la forme du widget (cercle
// vocal ou barre de texte, voir currentWidgetMode dans main.ts) et, pour la barre, de la hauteur mesurée
// que le renderer lui renvoie. Les deux sont des globaux du module, donc injectés ici comme le reste —
// sans ça, ce faux pont plantait sur "currentWidgetMode is not defined" dès que main.ts s'en est servi.
function fixture(mode='voice',chatHeight=null){
 const timers=new Map();let id=0;const changes=[];const shapes=[]
 const win={isDestroyed:()=>false,isVisible:()=>true,setBounds:b=>changes.push(b),setShape:r=>shapes.push(r)}
 const source=main.slice(main.indexOf('let widgetCollapseTimer:'),main.indexOf('/** Les deux fenêtres'))+'\nexports.position = positionWidgetWindow'
 const context={exports:{},process:{platform:"win32"},screen:{getPrimaryDisplay:()=>({workArea:{x:100,y:20,width:1920}})},WIDGET_WIDTH:320,WIDGET_HEIGHT:460,WIDGET_COLLAPSED_WIDTH:104,WIDGET_COLLAPSED_HEIGHT:68,WIDGET_CHAT_WIDTH:460,WIDGET_CHAT_COLLAPSED_HEIGHT:68,WIDGET_CHAT_MAX_HEIGHT:440,currentWidgetMode:()=>mode,chatWidgetHeight:chatHeight,setTimeout:fn=>{timers.set(++id,fn);return id},clearTimeout:key=>timers.delete(key)}
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context)
 return {win,changes,shapes,position:context.exports.position,flush:()=>{const work=[...timers.values()];timers.clear();work.forEach(fn=>fn())}}
}
test('le repli attend le fondu et garde la fenêtre centrée',()=>{
 const f=fixture();f.position(f.win,true,true);assert.equal(f.changes[0].width,320)
 f.position(f.win,false,true);assert.equal(f.changes.length,1)
 f.flush();assert.equal(f.changes[1].width,320);assert.equal(f.changes[1].height,68)
 assert.equal(f.changes[1].x+160,1060);assert.equal(f.changes[1].y,20);assert.equal(f.changes[0].x,f.changes[1].x);assert.equal(f.shapes[1][0].width,104);assert.equal(f.shapes[1][0].x,108)
})
test('une nouvelle activation annule un repli en attente',()=>{
 const f=fixture();f.position(f.win,true,true);f.position(f.win,false,true);f.position(f.win,true,true);f.flush()
 assert.equal(f.changes.at(-1).width,320);assert.equal(f.changes.length,2)
})
test('aucun redimensionnement tardif après fermeture ou masquage',()=>{
 for(const key of ['isDestroyed','isVisible']){
  const f=fixture();f.position(f.win,false,true);f.win[key]=()=>key==='isDestroyed';f.flush();assert.equal(f.changes.length,0)
 }
})
test('un affichage replié immédiat annule aussi le minuteur',()=>{
 const f=fixture();f.position(f.win,false,true);f.position(f.win,false);f.flush();assert.equal(f.changes.length,1)
})
// Widget TEXTE (repli depuis le mode Chat) : une barre de saisie ne tiendrait pas dans la pilule de 84px du
// widget vocal — la fenêtre native doit prendre les dimensions de ce que le renderer y dessine vraiment.
test('le Chat a un petit état inactif puis la barre prend ses vraies dimensions',()=>{
 const f=fixture('chat',177)
 f.position(f.win,false)
 assert.equal(f.changes[0].width,460);assert.equal(f.changes[0].height,68)
 // Au repos, seul le petit indicateur central capte les clics, comme l'orbe vocal inactif.
 assert.equal(f.shapes[0][0].width,104);assert.equal(f.shapes[0][0].height,68);assert.equal(f.shapes[0][0].x,178)
 f.position(f.win,true)
 assert.equal(f.changes[1].width,460);assert.equal(f.changes[1].height,177)
 assert.equal(f.changes[1].x+230,1060);assert.equal(f.changes[1].y,20)
})
test('la hauteur demandée par le widget texte est bornée',()=>{
 // Une réponse très longue ne doit pas manger la moitié de l'écran : elle défile dans le widget.
 const f=fixture('chat',9000);f.position(f.win,true);assert.equal(f.changes[0].height,440)
 // Et une hauteur absente (widget pas encore mesuré) retombe sur la barre, jamais sur 0.
 const g=fixture('chat',null);g.position(g.win,true);assert.equal(g.changes[0].height,68)
})

test('la limite native du Chat exclut le halo transparent',()=>{
 const start=main.indexOf('function isPointInsideChatSurface(')
 const end=main.indexOf('\nfunction startChatPointerWatch',start)
 const source=main.slice(start,end)+'\nexports.inside = isPointInsideChatSurface'
 const context={exports:{},WIDGET_CHAT_HALO_MARGIN:14}
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context)
 const bounds={x:100,y:20,width:460,height:68}
 assert.equal(context.exports.inside({x:114,y:34},bounds),true,'le premier pixel visible doit armer le suivi')
 assert.equal(context.exports.inside({x:113,y:34},bounds),false,'le halo gauche ne fait pas partie de la barre')
 assert.equal(context.exports.inside({x:545,y:73},bounds),true,'le dernier pixel visible doit rester dedans')
 assert.equal(context.exports.inside({x:546,y:73},bounds),false,'le halo droit doit déclencher la sortie')
 assert.equal(context.exports.inside({x:330,y:33},bounds),false,'le halo supérieur doit déclencher la sortie')
 assert.equal(context.exports.inside({x:330,y:74},bounds),false,'le halo inférieur doit déclencher la sortie')
})

// Étape 295 (Léo : « quand ça ouvre ça met directement en widget, mais ça doit ouvrir normalement ») : après l'écran
// de démarrage, la fenêtre de Jaris s'ouvre ; le widget reste préchargé pour le moment où on la réduit.
test('après l’onboarding, la fenêtre de Jaris s’ouvre après le démarrage, le widget reste prêt derrière',()=>{
 const source=ts.transpileModule(main,{compilerOptions:{removeComments:true,target:ts.ScriptTarget.ES2022}}).outputText
 assert.match(source,/fullWindow\s*=\s*createFullWindow\(!onboardingDone\)/)
 // Étape 294 : le widget apparaît quand le démarrage est fini et que ses fenêtres ont fait leur premier rendu.
 assert.match(source,/const windowsLoaded\s*=\s*Promise\.all\(\[windowLoaded\(fullWindow\),\s*windowLoaded\(widgetWindow\)\]\)/)
 const reveal=source.slice(source.indexOf('function revealAfterStartup('),source.indexOf('function createWidgetWindow('))
 assert.match(reveal,/showFullWindow\(\)/)
 assert.doesNotMatch(reveal,/showWidgetWindow\(/,'le widget ne doit plus s’imposer à l’ouverture')
 assert.match(source,/widgetWindow\s*=\s*createWidgetWindow\(\)/)
 assert.match(source,/function triggerVisibleWake\(\)[\s\S]{0,500}showWidgetWindow\(true\)[\s\S]{0,200}pipeline\.triggerWake\(\)/)
})

test('la touche + ouvre la forme active et idle replie le widget vocal sans le cacher',()=>{
 const source=ts.transpileModule(main,{compilerOptions:{removeComments:true,target:ts.ScriptTarget.ES2022}}).outputText
 // Étape 346 : le geste commun à « + » et Ctrl+Alt+J vit dans onWakeShortcut, branché par syncWakeShortcut.
 const shortcut=source.slice(source.indexOf('function onWakeShortcut'),source.indexOf('function setWakeShortcutWanted'))
 assert.match(shortcut,/function onWakeShortcut[\s\S]*triggerVisibleWake\(\)[\s\S]*function syncWakeShortcut/,'le raccourci global ne montre pas la barre avant l’écoute')
 assert.match(shortcut,/globalShortcut\.register\(accelerator, \(\) => onWakeShortcut\(accelerator\)\)/)
 const wake=source.slice(source.indexOf('function triggerVisibleWake'),source.indexOf('/** Envoie un évènement'))
 assert.match(wake,/activeMode\s*===\s*['"]chat['"][\s\S]*showWidgetWindow\(true\)[\s\S]*return/,'+ ne montre pas la barre du Chat')
 const emotion=source.slice(source.indexOf("pipeline.on('emotion'"),source.indexOf("pipeline.on('transcript'"))
 assert.match(emotion,/emotion\s*!==\s*['"]idle['"][\s\S]*showWidgetWindow\(true\)/,'le mot d’activation ne montre pas la barre')
 assert.match(emotion,/positionWidgetWindow\(widgetWindow,\s*emotion\s*!==\s*['"]idle['"],\s*true\)/,'le retour au repos ne replie pas le widget vocal')
 assert.doesNotMatch(emotion,/hideIdleWidget/,'idle ne doit plus faire disparaître le widget permanent')
})
test('toutes les commandes internes de dépendances masquent la console Windows',()=>{
 const source=ts.createSourceFile('dependencyServices.ts',readFileSync(new URL('../electron/services/dependencyServices.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true)
 let count=0
 function visit(n){
  if(ts.isCallExpression(n)&&['execAsync','execSync'].includes(n.expression.getText(source))){
   count++;const options=n.arguments[1];assert.ok(options&&ts.isObjectLiteralExpression(options),n.getText(source))
   assert.ok(options.properties.some(p=>ts.isPropertyAssignment(p)&&p.name.getText(source)==='windowsHide'&&p.initializer.kind===ts.SyntaxKind.TrueKeyword),n.getText(source))
  }
  ts.forEachChild(n,visit)
 }
 // Étape 337 : les commandes Docker et SearXNG sont parties ; restent les arrêts d'Ollama.
 visit(source);assert.ok(count>=3)
})

test('le lanceur Windows reste suivi et attend son serveur caché',()=>{
 const s=readFileSync(new URL('../electron/services/dependencyServices.ts',import.meta.url),'utf8')
 const start=s.indexOf("  const proc = process.platform === 'win32'",s.indexOf('export async function ensureOllamaRunning'))
 const code=s.slice(start,s.indexOf('  // spawn()',start))
 const calls=[]
 vm.runInNewContext(code,{process:{platform:'win32'},spawn:(...args)=>{calls.push(args);return {pid:123}}})
 assert.equal(calls.length,1);assert.equal(calls[0][0],'powershell.exe')
 assert.notEqual(calls[0][2].detached,true);assert.equal(calls[0][2].windowsHide,true)
 assert.match(calls[0][1].at(-1),/-WindowStyle Hidden -PassThru/)
 assert.match(calls[0][1].at(-1),/WaitForExit/)
})
