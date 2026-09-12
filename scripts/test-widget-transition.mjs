import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'

const main=readFileSync(new URL('../electron/main.ts',import.meta.url),'utf8')
function fixture(){
 const timers=new Map();let id=0;const changes=[];const shapes=[]
 const win={isDestroyed:()=>false,isVisible:()=>true,setBounds:b=>changes.push(b),setShape:r=>shapes.push(r)}
 const source=main.slice(main.indexOf('let widgetCollapseTimer:'),main.indexOf('/** Les deux fenêtres'))+'\nexports.position = positionWidgetWindow'
 const context={exports:{},process:{platform:"win32"},screen:{getPrimaryDisplay:()=>({workArea:{x:100,y:20,width:1920}})},WIDGET_WIDTH:320,WIDGET_HEIGHT:460,WIDGET_COLLAPSED_WIDTH:84,WIDGET_COLLAPSED_HEIGHT:48,setTimeout:fn=>{timers.set(++id,fn);return id},clearTimeout:key=>timers.delete(key)}
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,context)
 return {win,changes,shapes,position:context.exports.position,flush:()=>{const work=[...timers.values()];timers.clear();work.forEach(fn=>fn())}}
}
test('le repli attend le fondu et garde la fenêtre centrée',()=>{
 const f=fixture();f.position(f.win,true,true);assert.equal(f.changes[0].width,320)
 f.position(f.win,false,true);assert.equal(f.changes.length,1)
 f.flush();assert.equal(f.changes[1].width,320);assert.equal(f.changes[1].height,48)
 assert.equal(f.changes[1].x+160,1060);assert.equal(f.changes[1].y,20);assert.equal(f.changes[0].x,f.changes[1].x);assert.equal(f.shapes[1][0].width,84);assert.equal(f.shapes[1][0].x,118)
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
 visit(source);assert.ok(count>=8)
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
