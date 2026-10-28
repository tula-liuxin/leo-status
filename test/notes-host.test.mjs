import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import path from 'node:path'
import http from 'node:http'
import {apply} from '../index.js'
import {openNotes} from '../notes.js'
import {createNotesHandler,NOTES_API} from '../notes-http.js'
import {createHubHandler,createHubStore} from '../hub.js'

async function serve(handler,t){const server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));return 'http://127.0.0.1:'+server.address().port}
const doc={type:'doc',content:[{type:'taskList',content:[{type:'taskItem',attrs:{id:'stable-test-task',checked:false},content:[{type:'paragraph',content:[{type:'text',text:'独立笔记待办'}]}]}]}]}
test('Host 鉴权、无旧来源导入、agent 只建草稿、leoHub 路由保持',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'leo-host-')),source=path.join(dir,'original.md'),services={},cleanups=[],tools=[];let handler
 await writeFile(source,'- [ ] 原文件不能改变\n');await writeFile(path.join(dir,'settings.json'),JSON.stringify({mode:'local',markdownRoots:[dir],includeDshTodos:true,obsidian:{autoDetect:true}}))
 const ctx={provide:(k,v)=>services[k]=v,get:k=>services[k],effect:fn=>{cleanups.push(fn())},inject:(names,fn)=>fn({...ctx,tools:{register:d=>{tools.push(d);return()=>{}}},webServer:{register:r=>{handler=r.handler;return()=>{}},tapIndex:()=>()=>{}},connection:{authorizeIndex:()=>false}})}
 apply(ctx,{dataDir:dir});t.after(async()=>{for(const clean of cleanups.reverse())if(typeof clean==='function')await clean();await rm(dir,{recursive:true,force:true})})
 assert.equal((await services.leoBoard.list()).todos.length,0)
 const url=await serve(handler,t),token=await readFile(path.join(dir,'page-token'),'utf8'),headers={'x-leo-status-token':token,'content-type':'application/json'}
 assert.equal((await fetch(url+NOTES_API+'/state')).status,401)
 assert.equal((await fetch(url+NOTES_API+'/state',{headers:{...headers,'sec-fetch-site':'cross-site'}})).status,403)
 assert.equal((await fetch(url+'/leo-status/api/sources',{headers})).status,410)
 const draft=await services.leoBoard.propose('等待用户确认');assert.equal(draft.status,'draft');assert.equal((await services.leoBoard.list()).todos.length,0)
 assert.ok(tools.find(d=>d.name==='leo_notes'));assert.ok(!tools.find(d=>d.name==='leo_notes').parameters.properties.action.enum.includes('commit'))
 let r=await fetch(url+NOTES_API+'/save',{method:'POST',headers,body:JSON.stringify({doc})});assert.equal(r.status,200);let n=await r.json()
 r=await fetch(url+NOTES_API+'/commit',{method:'POST',headers,body:JSON.stringify({id:n.id,rev:n.rev,requestId:'host-test'})});assert.equal(r.status,200);n=await r.json();assert.equal((await services.leoBoard.list()).todos.length,1)
 await services.leoBoard.action({action:'done',id:'stable-test-task',rev:n.rev});assert.equal((await services.leoBoard.list()).todos[0].done,true)
 await assert.rejects(services.leoBoard.action({action:'delete',id:'stable-test-task'}))
 const cleanup=services.leoHub.registerRoute('/api/yuan/test',()=>true);cleanup();cleanup()
 assert.equal(await readFile(source,'utf8'),'- [ ] 原文件不能改变\n')
})
test('设备代理只写中心，鉴权、冲突、附件 Range 和中心离线',async t=>{
 const dir=await mkdtemp(path.join(tmpdir(),'leo-relay-')),store=openNotes(dir)
 t.after(async()=>{store.close();await rm(dir,{recursive:true,force:true})})
 const notes=createNotesHandler({store,settings:()=>({mode:'hub'})}),hubStore=createHubStore(dir);await hubStore.load()
 const hub=await serve(createHubHandler({password:'test-only',store:hubStore,boardProvider:()=>store.board(),extraRoutes:[{prefix:'/api/notes-v1',handler:notes}]}),t)
 assert.equal((await fetch(hub+'/api/notes-v1/state')).status,401)
 const settings={mode:'device',device:{hubUrl:hub,password:'test-only'}}
 const handler=createNotesHandler({settings:()=>settings}),client=await serve((req,res)=>handler(req,res,new URL(req.url,'http://local').pathname),t)
 const post=(route,b)=>fetch(client+NOTES_API+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)})
 let r=await post('/save',{doc}),n=await r.json();assert.equal(r.status,200);assert.equal(store.get(n.id).rev,1)
 assert.equal((await post('/save',{id:n.id,rev:0,doc})).status,409)
 r=await post('/commit',{id:n.id,rev:n.rev});assert.equal(r.status,200);assert.equal(store.board().todos.length,1)
 r=await fetch(client+NOTES_API+'/attachment?name=test.wav',{method:'POST',headers:{'content-type':'audio/wav'},body:'0123456789'});const a=await r.json();assert.equal(r.status,200)
 r=await fetch(client+NOTES_API+'/attachment?id='+a.id,{headers:{range:'bytes=4-7'}});assert.equal(r.status,206);assert.equal(await r.text(),'4567')
 settings.device.hubUrl='http://127.0.0.1:1';assert.equal((await fetch(client+NOTES_API+'/state')).status,503)
})
test('SQLite 关闭重开保留草稿、正式版本及标题队列',async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'leo-reopen-'));let s=openNotes(dir)
 try{let n=s.save({doc});n=s.commit({id:n.id,rev:n.rev});const pending=s.db.prepare('SELECT * FROM jobs ORDER BY id').all();s.close();s=openNotes(dir);assert.equal(s.get(n.id).rev,n.rev);assert.equal(s.board().todos.length,1);assert.deepEqual(s.db.prepare('SELECT * FROM jobs ORDER BY id').all(),pending)}finally{s.close();await rm(dir,{recursive:true,force:true})}
})
