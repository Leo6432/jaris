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
 vm.runInNewContext(source,{exports,URL,Response,require:name=>name==='electron'?{protocol}:{randomUUID}})
 exports.registerPreviewScheme();exports.registerPreviewHandler()
 return {api:exports,request:(url,method='GET')=>handler({url,method}),schemes}
}
test('sert seulement le HTML enregistré avec une CSP isolée',async()=>{
 const {api,request,schemes}=setup();const html='<button>Jouer</button><script>test()</script>'
 const res=request(api.createGeneratedAppPreview(html))
 assert.equal(res.status,200);assert.equal(await res.text(),html)
 const csp=res.headers.get('Content-Security-Policy')
 assert.match(csp,/script-src 'unsafe-inline'/);assert.match(csp,/sandbox allow-scripts/)
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
 assert.notEqual(first,next);assert.equal(await request(next).text(),'suivant');assert.equal(await request(first).text(),'premier')
})
