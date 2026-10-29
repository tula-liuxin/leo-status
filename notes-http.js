import { createReadStream, createWriteStream } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { NoteError } from './notes.js'

export const NOTES_API='/leo-status/api/notes-v1'
export const HUB_NOTES_API='/api/notes-v1'
const MAX_ATTACHMENT=100*1024*1024
function json(res,status,value){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value))}
async function body(req){let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>8*1024*1024)throw new NoteError('笔记超过 8 MiB',413);chunks.push(chunk)}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}')}catch{throw new NoteError('JSON 无效')}}
export async function proxyNotes(req,res,pathname,settings){
 const suffix=pathname.slice(NOTES_API.length), q=new URL(req.url,'http://localhost').searchParams;q.delete('_leo_status_token')
 const url=settings.device.hubUrl.replace(/\/$/,'')+HUB_NOTES_API+suffix+'?'+q
 const headers={authorization:'Bearer '+settings.device.password};for(const key of ['content-type','range'])if(req.headers[key])headers[key]=req.headers[key]
 try{const upstream=await fetch(url,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:req,duplex:'half',signal:AbortSignal.timeout(120000)});const safe={};for(const k of ['content-type','content-length','content-range','accept-ranges','content-disposition'])if(upstream.headers.get(k))safe[k]=upstream.headers.get(k);res.writeHead(upstream.status,{...safe,'cache-control':'no-store'});if(upstream.body)await pipeline(Readable.fromWeb(upstream.body),res);else res.end()}catch(e){if(!res.headersSent)json(res,503,{error:'本机中心不可达，草稿尚未同步',detail:e.message});else res.destroy()}
}
export function createNotesHandler({store,worker,settings}){
 return async(req,res,pathname)=>{
  const prefix=pathname.startsWith(NOTES_API)?NOTES_API:HUB_NOTES_API
  if(!pathname.startsWith(prefix))return false
  if(settings().mode==='device'){await proxyNotes(req,res,pathname,settings());return true}
  const route=pathname.slice(prefix.length),url=new URL(req.url,'http://localhost');
  try{
   if(route==='/attachment' && req.method==='POST'){
    const mime=String(req.headers['content-type']||'application/octet-stream').split(';')[0];if(!/^(image\/(png|jpeg|gif|webp)|audio\/[\w.+-]+|video\/[\w.+-]+|application\/pdf)$/.test(mime))throw new NoteError('支持图片、音视频和 PDF 文件')
    const id=randomUUID(),file=path.join(store.dir,'attachments',id),name=(url.searchParams.get('name')||'附件').slice(0,200);let size=0
    try{await pipeline(req,new Transform({transform(chunk,enc,cb){size+=chunk.length;cb(size>MAX_ATTACHMENT?new NoteError('单个附件不能超过 100 MiB',413):null,chunk)}}),createWriteStream(file,{flags:'wx'}));store.db.prepare('INSERT INTO attachments VALUES(?,?,?,?,?)').run(id,name,mime,size,store.now())}catch(e){await fs.rm(file,{force:true});throw e}
    json(res,200,{id,name,mime,size});return true
   }
   if(route==='/attachment' && ['GET','HEAD'].includes(req.method)){
    const a=store.db.prepare('SELECT * FROM attachments WHERE id=?').get(url.searchParams.get('id'));if(!a)throw new NoteError('附件不存在',404)
    let start=0,end=a.size-1,status=200;const range=req.headers.range
    if(range){const m=/^bytes=(\d*)-(\d*)$/.exec(range);if(!m||(!m[1]&&!m[2]))throw new NoteError('Range 无效',416);if(!m[1])start=Math.max(0,a.size-Number(m[2]));else{start=Number(m[1]);if(m[2])end=Math.min(end,Number(m[2]))}if(start>end||start>=a.size)throw new NoteError('Range 超出附件大小',416);status=206}
    res.writeHead(status,{'content-type':a.mime,'x-content-type-options':'nosniff','content-length':end-start+1,'accept-ranges':'bytes','cache-control':'private, no-store','content-disposition':`inline; filename*=UTF-8''${encodeURIComponent(a.name)}`,...(status===206?{'content-range':`bytes ${start}-${end}/${a.size}`}:{})});if(req.method==='HEAD')res.end();else await pipeline(createReadStream(path.join(store.dir,'attachments',a.id),{start,end}),res);return true
   }
   if(req.method==='GET'){
    let result
    if(route==='/state')result={notes:store.list().map(({doc,committed,...n})=>n),trash:store.list({trash:true}).map(({doc,committed,...n})=>n),board:store.board(),jobs:store.db.prepare('SELECT id,due,attempts,error FROM jobs').all(),cleanupPending:store.cleanupStatus().length,cleanupTasks:store.cleanupStatus(),storage:'本机中心',version:2}
    else if(route==='/note')result=store.get(url.searchParams.get('id'))
    else if(route==='/timeline')result=store.timeline(Object.fromEntries(url.searchParams))
    else if(route==='/todos')result=store.todoTimeline(Object.fromEntries(url.searchParams))
    else if(route==='/tags')result=store.tags(Object.fromEntries(url.searchParams))
    else throw new NoteError('接口不存在',404)
    json(res,200,result);return true
   }
   if(req.method!=='POST')throw new NoteError('不支持的方法',405)
   const b=await body(req);let result
   if(route==='/save')result=store.save(b)
   else if(route==='/commit')result=store.commit(b)
   else if(route==='/check')result=store.check(b)
   else if(route==='/cancelTodo')result=store.cancelTodo(b)
   else if(route==='/todo/edit')result=store.editTodo(b)
   else if(route==='/move')result=store.move(b)
   else if(route==='/trash')result=store.trash(b)
   else if(route==='/trash/purge')result=store.purge(b)
   else if(route==='/title')result=store.title(b)
   else if(route==='/generate'){
    if(!/^(note:[a-f0-9-]{36}|(day|week):\d{4}-\d{2}-\d{2}|month:\d{4}-\d{2}|year:\d{4})$/.test(b.target||''))throw new NoteError('标题目标无效')
    if(b.target.startsWith('note:'))store.db.prepare('UPDATE notes SET summarized_hash=NULL WHERE id=?').run(b.target.slice(5))
    else store.db.prepare('UPDATE periods SET content_hash=NULL,last_run=NULL WHERE id=?').run(b.target)
    store.enqueue(b.target,0);worker?.wake();result={ok:true}
   }
   else throw new NoteError('接口不存在',404)
   json(res,200,result)
  }catch(e){if(!res.headersSent)json(res,e.status||500,{error:e.message});else res.destroy()}
  return true
 }
}
