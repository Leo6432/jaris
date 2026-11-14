import { withI18n } from './i18n-test-module.mjs'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import vm from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
const source=ts.transpileModule(readFileSync(new URL('../electron/services/generatedAppPreview.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
function setup(){
 const exports={};let handler;let schemes
 const protocol={registerSchemesAsPrivileged:s=>{schemes=s},handle:(_scheme,h)=>{handler=h}}
 vm.runInNewContext(source,{exports,URL,Response,require:withI18n(name=>name==='electron'?{protocol}:{randomUUID})})
 exports.registerPreviewScheme();exports.registerPreviewHandler()
 return {api:exports,request:(url,method='GET')=>handler({url,method}),schemes}
}
test('sert seulement le HTML enregistré avec une CSP isolée',async()=>{
 const {api,request,schemes}=setup();const html='<button>Jouer</button><script>test()</script>'
 const res=request(api.createGeneratedAppPreview(html))
 assert.equal(res.status,200);assert.equal(await res.text(),api.withMemoryStorage(html))
 const csp=res.headers.get('Content-Security-Policy')
 assert.match(csp,/script-src 'unsafe-inline'/);assert.match(csp,/sandbox allow-scripts allow-forms$/);assert.match(csp,/form-action 'none'/)
 assert.ok(!csp.includes('allow-same-origin'));assert.match(csp,/connect-src 'none'/)
 assert.equal(schemes[0].privileges.bypassCSP,undefined)
})
test('aucun accès à un chemin de fichier ou à une URL inconnue',()=>{
 const {api,request}=setup();const url=api.createGeneratedAppPreview('test')
 assert.equal(request(url+'?file=C:/secret').status,404)
 assert.equal(request(url.replace('/index.html','/secret.txt')).status,404)
 assert.equal(request('jaris-preview://inconnu/index.html').status,404)
 assert.equal(request(url,'POST').status,404)
})
test('chaque nouvelle génération obtient son propre aperçu',async()=>{
 const {api,request}=setup();const first=api.createGeneratedAppPreview('premier');const next=api.createGeneratedAppPreview('suivant')
 assert.notEqual(first,next);assert.equal(await request(next).text(),api.withMemoryStorage('suivant'));assert.equal(await request(first).text(),api.withMemoryStorage('premier'))
})
// Étape 482 (captures de Léo : en série de duels Code, des aperçus tout blancs) : la mémoire des aperçus est limitée.
test('étape 482 : un aperçu effacé de la mémoire se reconnaît (previewAvailable), un nouveau le remplace',async()=>{
 const {api,request}=setup();const first=api.createGeneratedAppPreview('<p>premier</p>')
 assert.equal(api.previewAvailable(first),true)
 for(let i=0;i<25;i++)api.createGeneratedAppPreview(`<p>${i}</p>`)
 assert.equal(api.previewAvailable(first),false,'effacé après plus de 20 autres')
 assert.equal(request(first).status,404,'c’est ce que voyait Léo : un cadre vide')
 assert.equal(api.previewAvailable(null),false);assert.equal(api.previewAvailable('pas une adresse'),false)
 const again=api.createGeneratedAppPreview('<p>premier</p>')
 assert.equal(api.previewAvailable(again),true);assert.equal(request(again).status,200)
})
