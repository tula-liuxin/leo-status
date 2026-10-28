import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,writeFileSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import path from 'node:path'
import {randomUUID} from 'node:crypto'
import {openNotes,hash,plain,todos} from '../notes.js'
import {titleWorker} from '../notes-titles.js'
import {createNotesHandler,NOTES_API} from '../notes-http.js'
import http from 'node:http'

const paragraph=text=>({type:'paragraph',content:text?[{type:'text',text}]:[]})
const task=(id,text,children=[])=>({type:'taskItem',attrs:{id,checked:false},content:[paragraph(text),...(children.length?[{type:'taskList',content:children}]:[])]})
const doc=(items)=>({type:'doc',content:[{type:'taskList',content:items}]})
function fixture(t,options={}){const dir=mkdtempSync(path.join(tmpdir(),'leo-polish-'));let clock='2026-10-28T01:00:00.000Z',s=openNotes(dir,{now:()=>clock,...options});t.after(()=>{s.close();rmSync(dir,{recursive:true,force:true})});return {get s(){return s},dir,time:v=>clock=v,reopen(){s.close();s=openNotes(dir,{now:()=>clock,...options});return s}}}
function commit(s,content){let n=s.save({doc:content});return s.commit({id:n.id,rev:n.rev})}
function attachment(s,id=randomUUID()){writeFileSync(path.join(s.dir,'attachments',id),'audio fixture');s.db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)').run(id,'sample.webm','audio/webm',13,s.now());return id}
const mediaDoc=id=>({type:'doc',content:[paragraph('记录'),{type:'media',attrs:{attachmentId:id,mime:'audio/webm',name:'录音'}}]})

test('待办开始时间固定为笔记最早提交，旧笔记后加待办也不重置',t=>{
 const f=fixture(t);let n=f.s.save({doc:doc([task('a','首项')])});assert.equal(n.firstSubmittedAt,null)
 f.time('2026-10-28T02:00:00.000Z');n=f.s.commit({id:n.id,rev:n.rev});assert.equal(n.firstSubmittedAt,'2026-10-28T02:00:00.000Z')
 f.time('2026-11-02T02:00:00.000Z');n=f.s.save({id:n.id,rev:n.rev,doc:doc([task('a','首项'),task('b','后加')])});n=f.s.commit({id:n.id,rev:n.rev})
 assert.equal(n.firstSubmittedAt,'2026-10-28T02:00:00.000Z');assert.deepEqual(f.s.board().todos.map(x=>x.startedAt),[n.firstSubmittedAt,n.firstSubmittedAt])
})
test('旧库迁移从提交历史还原开始时间，已完成旧项保留时间未知',t=>{
 const f=fixture(t);let n=commit(f.s,doc([task('old','旧项')]))
 const old=structuredClone(n.committed);old.content[0].content[0].attrs.checked=true;delete old.content[0].content[0].attrs.completedAt
 f.s.db.prepare('UPDATE notes SET draft=?,committed=? WHERE id=?').run(JSON.stringify(old),JSON.stringify(old),n.id)
 f.s.db.exec('ALTER TABLE notes DROP COLUMN first_submitted; ALTER TABLE jobs DROP COLUMN generation')
 const s=f.reopen();assert.equal(s.get(n.id).firstSubmittedAt,'2026-10-28T01:00:00.000Z');assert.equal(s.board().todos[0].completedAt,null)
 n=s.get(n.id);n.doc.content[0].content[0].attrs.completedAt='2026-10-28T05:00:00Z';n=s.save({id:n.id,rev:n.rev,doc:n.doc});assert.equal(todos(n.doc)[0].completedAt,null)
})
test('完成时间取实际操作，取消清空、重新完成更新且不级联',t=>{
 const {s}=fixture(t);let n=commit(s,doc([task('parent','父',[task('child','子')])]))
 n=s.check({id:'parent',checked:true,rev:n.rev,occurredAt:'2026-10-27T23:59:00+08:00'});assert.equal(todos(n.committed)[0].completedAt,'2026-10-27T15:59:00.000Z');assert.equal(todos(n.committed)[1].completedAt,null)
 n=s.check({id:'parent',checked:false,rev:n.rev});assert.equal(todos(n.doc)[0].completedAt,null)
 n=s.check({id:'parent',checked:true,rev:n.rev,occurredAt:'2026-10-28T03:00:00Z'});assert.equal(todos(n.doc)[0].completedAt,'2026-10-28T03:00:00.000Z')
})
test('编辑草稿完成时间提交前不影响正式记录，离线操作时刻被保留',t=>{
 const {s}=fixture(t);let n=commit(s,doc([task('a','待办')]))
 const changed=structuredClone(n.doc);changed.content[0].content[0].attrs={id:'a',checked:true,completedAt:'2026-10-27T22:30:00+08:00'}
 n=s.save({id:n.id,rev:n.rev,doc:changed});assert.equal(s.board().todos[0].done,false);assert.equal(s.board().todos[0].completedAt,null)
 n=s.commit({id:n.id,rev:n.rev});assert.equal(s.board().todos[0].completedAt,'2026-10-27T14:30:00.000Z')
 const rev=n.rev;n=s.check({id:'a',checked:false,rev});assert.throws(()=>s.save({id:n.id,rev,doc:changed}),e=>e.status===409)
})
test('防抖窗口内取消再完成用事件 ID 识别，普通保存不会伪造新时间',t=>{
 const {s}=fixture(t);let n=commit(s,doc([task('a','快速切换')]))
 n=s.check({id:'a',checked:true,rev:n.rev,occurredAt:'2026-10-28T02:00:00Z'});const original=structuredClone(n.doc),oldEvent=original.content[0].content[0].attrs.completionEventId
 assert.match(oldEvent,/^[a-f0-9-]{36}$/)
 const ordinary=structuredClone(original);ordinary.content[0].content[0].attrs.completedAt='2026-10-28T03:00:00Z';n=s.save({id:n.id,rev:n.rev,doc:ordinary});assert.equal(todos(n.doc)[0].completedAt,'2026-10-28T02:00:00.000Z')
 const toggled=structuredClone(n.doc);toggled.content[0].content[0].attrs.completedAt='2026-10-28T04:00:00Z';toggled.content[0].content[0].attrs.completionEventId=randomUUID();n=s.save({id:n.id,rev:n.rev,doc:toggled});assert.equal(todos(n.doc)[0].completedAt,'2026-10-28T04:00:00.000Z');assert.equal(todos(n.committed)[0].completedAt,'2026-10-28T02:00:00.000Z')
 n=s.commit({id:n.id,rev:n.rev});assert.equal(todos(n.committed)[0].completedAt,'2026-10-28T04:00:00.000Z')
})
test('按完成时间筛选保留祖先上下文，未知单列，未完成不混入',t=>{
 const {s}=fixture(t);let n=commit(s,doc([task('p','父',[task('c','目标子项'),task('s','另一天')]),task('u','旧完成未知')]))
 n=s.check({id:'p',checked:true,rev:n.rev,occurredAt:'2026-10-27T01:00:00Z'});n=s.check({id:'c',checked:true,rev:n.rev,occurredAt:'2026-10-28T01:00:00Z'})
 const legacy=structuredClone(n.committed);legacy.content[0].content[1].attrs={id:'u',checked:true};s.db.prepare('UPDATE notes SET draft=?,committed=? WHERE id=?').run(JSON.stringify(legacy),JSON.stringify(legacy),n.id)
 const result=s.todoTimeline({date:'2026-10-28',basis:'completed',hideCompleted:true});assert.equal(result.matchCount,2)
 assert.deepEqual(result.groups[0].todos.map(x=>[x.id,x.contextOnly]),[['p',true],['c',false]]);assert.equal(result.groups[1].key,'unknown');assert.equal(result.groups[1].todos[0].id,'u')
 assert.equal(s.todoTimeline({date:'2026-10-28',basis:'completed',q:'目标'}).matchCount,1)
})
test('待办时间筛选采用新加坡日期、周一周首和跨年范围',t=>{
 const f=fixture(t);f.time('2026-12-31T16:10:00.000Z');commit(f.s,doc([task('a','跨年')]))
 assert.equal(f.s.todoTimeline({kind:'year',date:'2026-01-01'}).matchCount,0)
 assert.equal(f.s.todoTimeline({kind:'year',date:'2027-01-01'}).matchCount,1)
 assert.equal(f.s.todoTimeline({kind:'week',date:'2026-12-28'}).matchCount,1)
})
test('永久删除批次验证并发恢复，整个批次冲突不部分删除',t=>{
 const {s}=fixture(t);let a=commit(s,doc([task('a','第一篇')])),b=commit(s,doc([task('b','第二篇')]))
 a=s.trash({id:a.id,rev:a.rev});b=s.trash({id:b.id,rev:b.rev});const stale=b;s.trash({id:b.id,rev:b.rev,restore:true})
 assert.throws(()=>s.purge({items:[{id:a.id,rev:a.rev},{id:b.id,rev:stale.rev}]}),e=>e.status===409);assert.ok(s.get(a.id));assert.ok(s.get(b.id))
})
test('永久清理保留其他记录与共享历史附件，只删除本次无引用附件',t=>{
 const {s}=fixture(t),shared=attachment(s),unique=attachment(s),unreferencedUpload=attachment(s)
 let a=commit(s,{type:'doc',content:[...mediaDoc(shared).content,...mediaDoc(unique).content]}),b=commit(s,mediaDoc(shared))
 // The survivor no longer uses the file in its current draft/commit, but history does.
 b=s.save({id:b.id,rev:b.rev,doc:{type:'doc',content:[paragraph('保留历史')]}});b=s.commit({id:b.id,rev:b.rev})
 a=s.trash({id:a.id,rev:a.rev});const r=s.purge({items:[{id:a.id,rev:a.rev}]});assert.deepEqual(r.deletedIds,[a.id]);assert.equal(r.cleanupPending,0)
 assert.ok(existsSync(path.join(s.dir,'attachments',shared)));assert.ok(existsSync(path.join(s.dir,'attachments',unreferencedUpload)));assert.equal(existsSync(path.join(s.dir,'attachments',unique)),false);assert.ok(s.get(b.id))
 assert.equal(s.db.prepare('SELECT count(*) n FROM versions WHERE note_id=?').get(a.id).n,0);assert.equal(s.purge({items:[{id:a.id,rev:a.rev}]}).ok,true)
})
test('附件删除失败持久化为待清理任务，重开后可重试',t=>{
 let blocked=true;const f=fixture(t,{removeAttachment:file=>{if(blocked)throw new Error('文件被占用');rmSync(file,{force:true})}});let n=commit(f.s,mediaDoc(attachment(f.s)));n=f.s.trash({id:n.id,rev:n.rev})
 const r=f.s.purge({items:[{id:n.id,rev:n.rev}]});assert.equal(r.cleanupPending,1);assert.equal(r.cleanupTasks[0].error,'文件被占用')
 const s=f.reopen();assert.equal(s.cleanupStatus().length,1);blocked=false;s.processAttachmentGc({force:true});assert.equal(s.cleanupStatus().length,0)
})
test('清理排队附件若被另一个草稿引用则不会误删',t=>{
 const f=fixture(t,{removeAttachment:()=>{throw new Error('暂时占用')}}),id=attachment(f.s);let n=commit(f.s,mediaDoc(id));n=f.s.trash({id:n.id,rev:n.rev});f.s.purge({items:[{id:n.id,rev:n.rev}]})
 f.s.save({doc:mediaDoc(id)});f.s.processAttachmentGc({force:true});assert.ok(existsSync(path.join(f.s.dir,'attachments',id)));assert.equal(f.s.cleanupStatus().length,0)
})
test('笔记标题生成中被永久删除，迟到结果不会写回或重建',async t=>{
 const f=fixture(t);let n=commit(f.s,doc([task('a','记录')]))
 f.s.db.prepare('DELETE FROM jobs').run();f.s.enqueue('note:'+n.id,0)
 let resolve,started;const ready=new Promise(r=>started=r),w=titleWorker(f.s,()=>{started();return new Promise(r=>resolve=r)},{interval:999999});t.after(()=>w.stop())
 const tick=w.tick();await ready;n=f.s.trash({id:n.id,rev:n.rev});f.s.purge({items:[{id:n.id,rev:n.rev}]});resolve({title:'不应回写',summary:'不应回写'});await tick
 assert.throws(()=>f.s.get(n.id),e=>e.status===404);assert.equal(f.s.db.prepare('SELECT count(*) n FROM title_runs WHERE target=?').get('note:'+n.id).n,0)
})
test('周期标题生成中清理笔记，旧结果不能复活删除内容',async t=>{
 const f=fixture(t);let n=commit(f.s,doc([task('a','记录')]))
 f.s.db.prepare('DELETE FROM jobs').run();f.s.enqueue('day:2026-10-28',0)
 let resolve,started;const ready=new Promise(r=>started=r),w=titleWorker(f.s,()=>{started();return new Promise(r=>resolve=r)},{interval:999999});t.after(()=>w.stop())
 const tick=w.tick();await ready;n=f.s.trash({id:n.id,rev:n.rev});f.s.purge({items:[{id:n.id,rev:n.rev}]});resolve({title:'旧周期标题',summary:'已删内容'});await tick
 assert.equal(f.s.db.prepare("SELECT generated FROM periods WHERE id='day:2026-10-28'").get().generated,null)
})
test('HTTP 暴露时间筛选与清理状态，清空只处理明确快照列表',async t=>{
 const {s}=fixture(t);let a=commit(s,doc([task('a','第一篇')])),b=commit(s,doc([task('b','第二篇')]))
 a=s.trash({id:a.id,rev:a.rev});const items=[{id:a.id,rev:a.rev}];b=s.trash({id:b.id,rev:b.rev})
 const handler=createNotesHandler({store:s,settings:()=>({mode:'local'})}),server=http.createServer((req,res)=>handler(req,res,new URL(req.url,'http://localhost').pathname));await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)))
 const base='http://127.0.0.1:'+server.address().port+NOTES_API;let r=await fetch(base+'/trash/purge',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({items})});assert.equal(r.status,200);assert.ok(s.get(b.id))
 r=await fetch(base+'/todos?kind=day&date=2026-10-28&basis=start');assert.equal(r.status,200);assert.equal((await r.json()).matchCount,0)
 r=await fetch(base+'/state');assert.equal(typeof (await r.json()).cleanupPending,'number')
})
