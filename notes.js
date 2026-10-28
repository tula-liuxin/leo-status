import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'

export const emptyDoc = () => ({ type: 'doc', content: [{ type: 'paragraph' }] })
export class NoteError extends Error { constructor(message, status = 400) { super(message); this.status = status } }
export function walk(doc, visit) { const queue = [[doc, null, 0]]; while (queue.length) { const [node, parent, depth] = queue.pop(); visit(node, parent, depth); const next = node.type === 'taskItem' ? node.attrs.id : parent; for (let i = (node.content?.length || 0) - 1; i >= 0; i--) queue.push([node.content[i], next, depth + (node.type === 'taskItem' ? 1 : 0)]) } }
export function plain(doc) { const lines = []; walk(doc, n => { if (n.type === 'text') lines.push(n.text || '') }); return lines.join(' ').trim() }
export function todos(doc) { const result = []; walk(doc, (n, parentId, depth) => { if (n.type === 'taskItem') result.push({ id: n.attrs.id, parentId, depth, text: plain(n.content?.[0] || {}), done: n.attrs.checked === true, completedAt: n.attrs.checked === true ? validTime(n.attrs.completedAt) : null }) }); return result }
export function normalizeDoc(input) {
  if (!input || input.type !== 'doc') throw new NoteError('笔记格式无效')
  const doc = structuredClone(input), ids = new Set(); let count = 0
  const types = new Set(['doc','paragraph','text','heading','bulletList','orderedList','listItem','taskList','taskItem','blockquote','codeBlock','hardBreak','horizontalRule','image','media'])
  walk(doc, n => {
    if (!n || typeof n !== 'object' || ++count > 50000 || !types.has(n.type)) throw new NoteError('笔记过大或包含不支持的内容')
    if (n.content !== undefined && !Array.isArray(n.content)) throw new NoteError('笔记结构无效')
    if (n.type === 'taskItem') { n.attrs ||= {}; n.attrs.id ||= randomUUID(); if (ids.has(n.attrs.id)) throw new NoteError('待办 ID 重复'); ids.add(n.attrs.id); n.attrs.checked = n.attrs.checked === true }
    if (n.type === 'image' || n.type === 'media') { if (!/^[a-f0-9-]{36}$/.test(n.attrs?.attachmentId || '')) throw new NoteError('附件尚未上传'); delete n.attrs.src }
    for (const mark of n.marks || []) if (mark.type === 'link' && !/^(https?:|mailto:)/i.test(mark.attrs?.href || '')) throw new NoteError('链接只支持 https/http/mailto')
  }); return doc
}
const validTime = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null
const attachmentIds = doc => { const ids = new Set(); if(doc) walk(typeof doc === 'string' ? JSON.parse(doc) : doc,n=>{if((n.type==='image'||n.type==='media')&&n.attrs?.attachmentId)ids.add(n.attrs.attachmentId)}); return ids }
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const dayKey = time => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time))
const shift = (date, amount) => new Date(Date.parse(date + 'T00:00:00Z') + amount * 86400000).toISOString().slice(0, 10)
export function weekKey(day) { const n = new Date(day + 'T00:00:00Z').getUTCDay(); return shift(day, -((n + 6) % 7)) }
export function periodKeys(time) { const d = dayKey(time); return ['day:' + d, 'week:' + weekKey(d), 'month:' + d.slice(0, 7), 'year:' + d.slice(0, 4)] }
export function inPeriod(day, kind, key) { return kind === 'year' ? day.startsWith(key.slice(0,4)) : kind === 'month' ? day.startsWith(key.slice(0,7)) : kind === 'week' ? weekKey(day) === weekKey(key) : day === key }

export function openNotes(dataDir, { now = () => new Date().toISOString(), removeAttachment = file => unlinkSync(file) } = {}) {
  const dir = path.join(dataDir, 'notes-v1'); mkdirSync(dir, { recursive: true }); mkdirSync(path.join(dir, 'attachments'), { recursive: true })
  const db = new DatabaseSync(path.join(dir, 'notes.sqlite'))
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY, rev INTEGER NOT NULL, draft TEXT NOT NULL, committed TEXT, started TEXT NOT NULL, ended TEXT, updated TEXT NOT NULL, deleted TEXT, manual TEXT, generated TEXT, summary TEXT, title_history TEXT NOT NULL DEFAULT '[]', content_hash TEXT, summarized_hash TEXT);
    CREATE TABLE IF NOT EXISTS versions(note_id TEXT, rev INTEGER, body TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY(note_id,rev));
    CREATE TABLE IF NOT EXISTS periods(id TEXT PRIMARY KEY, manual TEXT, generated TEXT, summary TEXT, history TEXT NOT NULL DEFAULT '[]', content_hash TEXT, last_run TEXT);
    CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, due INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, error TEXT);
    CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, created TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS title_runs(id TEXT PRIMARY KEY, target TEXT, input TEXT, output TEXT, error TEXT, at TEXT);
    CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attachment_gc(id TEXT PRIMARY KEY, queued TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL, error TEXT);
  `)
  if(!db.prepare('PRAGMA table_info(notes)').all().some(c=>c.name==='manual_history'))db.exec("ALTER TABLE notes ADD COLUMN manual_history TEXT NOT NULL DEFAULT '[]'")
  if(!db.prepare('PRAGMA table_info(periods)').all().some(c=>c.name==='manual_history'))db.exec("ALTER TABLE periods ADD COLUMN manual_history TEXT NOT NULL DEFAULT '[]'")
  if(!db.prepare('PRAGMA table_info(notes)').all().some(c=>c.name==='first_submitted'))db.exec('ALTER TABLE notes ADD COLUMN first_submitted TEXT')
  if(!db.prepare('PRAGMA table_info(jobs)').all().some(c=>c.name==='generation'))db.exec('ALTER TABLE jobs ADD COLUMN generation INTEGER NOT NULL DEFAULT 0')
  for(const n of db.prepare('SELECT id FROM notes WHERE first_submitted IS NULL AND committed IS NOT NULL').all()){const stamps=db.prepare('SELECT at FROM versions WHERE note_id=?').all(n.id).map(v=>validTime(v.at)).filter(Boolean).sort();if(stamps.length)db.prepare('UPDATE notes SET first_submitted=? WHERE id=?').run(stamps[0],n.id)}
  const tx = fn => { db.exec('BEGIN IMMEDIATE'); try { const r = fn(); db.exec('COMMIT'); return r } catch(e) { db.exec('ROLLBACK'); throw e } }
  function raw(id) { const n = db.prepare('SELECT * FROM notes WHERE id=?').get(id); if (!n) throw new NoteError('笔记不存在',404); return n }
  function view(n) { return { id:n.id, rev:n.rev, doc:JSON.parse(n.draft), committed:n.committed ? JSON.parse(n.committed) : null, startedAt:n.started, firstSubmittedAt:n.first_submitted, endedAt:n.ended, updatedAt:n.updated, deletedAt:n.deleted, title:n.manual ?? n.generated ?? (plain(JSON.parse(n.committed || n.draft)).slice(0,50) || '未命名笔记'), manualTitle:n.manual, generatedTitle:n.generated, titleHistory:JSON.parse(n.title_history), dirty:n.draft !== n.committed } }
  function get(id) { return view(raw(id)) }
  function requireRev(n, rev) { if (n.rev !== rev) throw new NoteError('另一端已更新此笔记。当前草稿已保留，请另存副本或重新载入。',409); if(n.deleted) throw new NoteError('笔记已在回收站',409) }
  function enqueue(id, delay=60000) { db.prepare('INSERT INTO jobs(id,due) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET due=excluded.due,attempts=0,error=NULL,generation=jobs.generation+1').run(id, Date.parse(now())+delay) }
  function schedule(n) { enqueue('note:'+n.id); for(const key of new Set([...periodKeys(n.started),...periodKeys(n.ended || n.started)])) enqueue(key) }
  function save({ id=randomUUID(), rev=0, doc, manualTitle }) { return tx(() => {
    const normalized=normalizeDoc(doc), stamp=now(); let n=db.prepare('SELECT * FROM notes WHERE id=?').get(id)
    if(n)requireRev(n,rev)
    const prior=new Map();if(n)walk(JSON.parse(n.draft),x=>{if(x.type==='taskItem')prior.set(x.attrs.id,x.attrs)})
    walk(normalized,x=>{
      if(x.type!=='taskItem')return
      const old=prior.get(x.attrs.id),incomingEvent=/^[a-f0-9-]{36}$/i.test(x.attrs.completionEventId||'')?x.attrs.completionEventId:null
      const eventChanged=!!incomingEvent&&incomingEvent!==old?.completionEventId,statusChanged=!!x.attrs.checked!==!!old?.checked
      x.attrs.completionEventId=eventChanged?incomingEvent:statusChanged?randomUUID():old?.completionEventId||null
      if(!x.attrs.checked)x.attrs.completedAt=null
      else if(old?.checked&&!eventChanged)x.attrs.completedAt=validTime(old.completedAt)
      else x.attrs.completedAt=validTime(x.attrs.completedAt)||stamp
    })
    const body=JSON.stringify(normalized)
    const ids=new Set(todos(normalized).map(t=>t.id))
    for(const other of db.prepare('SELECT draft,committed FROM notes WHERE id<>?').all(id))for(const source of new Set([other.draft,other.committed].filter(Boolean)))if(todos(JSON.parse(source)).some(t=>ids.has(t.id)))throw new NoteError('待办 ID 已被另一笔记使用；复制内容时请创建新 ID',409)
    if(!n) { if(rev!==0) throw new NoteError('笔记版本不匹配',409); db.prepare('INSERT INTO notes(id,rev,draft,started,updated,manual) VALUES(?,1,?,?,?,?)').run(id,body,stamp,stamp,manualTitle?.trim() || null) }
    else { requireRev(n,rev); const next=manualTitle===undefined?n.manual:manualTitle?.trim()||null;if(next!==n.manual&&n.manual)db.prepare('UPDATE notes SET manual_history=? WHERE id=?').run(JSON.stringify([...JSON.parse(n.manual_history),{title:n.manual,at:stamp}]),id);db.prepare('UPDATE notes SET rev=rev+1,draft=?,updated=?,manual=? WHERE id=?').run(body,stamp,next,id) }
    return get(id)
  }) }
  function commit({id,rev,requestId}) { return tx(() => {
    if(requestId) { const old=db.prepare('SELECT result FROM requests WHERE id=?').get(requestId); if(old) { const result=JSON.parse(old.result);if(result.id!==id)throw new NoteError('提交请求 ID 已用于其他笔记',409);return result } }
    const n=raw(id); requireRev(n,rev);
    walk(JSON.parse(n.draft),node=>{if(node.type==='image'||node.type==='media'){const a=db.prepare('SELECT id FROM attachments WHERE id=?').get(node.attrs.attachmentId);if(!a||!existsSync(path.join(dir,'attachments',a.id)))throw new NoteError('附件尚未完整上传，不能提交',409)}})
    const stamp=now(); db.prepare('UPDATE notes SET rev=rev+1,committed=draft,ended=?,updated=?,content_hash=?,first_submitted=? WHERE id=?').run(stamp,stamp,hash(JSON.parse(n.draft)),n.first_submitted||(!n.committed?stamp:null),id)
    db.prepare('INSERT INTO versions VALUES(?,?,?,?)').run(id,rev+1,n.draft,stamp); schedule(raw(id)); const result=get(id)
    if(requestId) db.prepare('INSERT INTO requests VALUES(?,?)').run(requestId,JSON.stringify(result)); return result
  }) }
  function list({trash=false,drafts=false}={}) { return db.prepare(`SELECT * FROM notes WHERE deleted IS ${trash?'NOT ':''}NULL ORDER BY started`).all().filter(n=>!drafts||n.draft!==n.committed).map(view) }
  function board() { const result=[]; for(const n of list()) if(n.committed) for(const t of todos(n.committed)) result.push({...t,noteId:n.id,noteTitle:n.title,startedAt:n.firstSubmittedAt,local:true,kind:'note',sourceId:'notes-v1',sourceLabel:'leo-status',deviceId:'local',rev:n.rev}); const open=result.filter(t=>!t.done).length; return {version:3,todos:result,suggestions:[],stats:{total:result.length,open,done:result.length-open},devices:[],sources:[],hub:{connected:true},mode:'local'} }
  function check({id,checked,rev,occurredAt}) { return tx(()=>{
    const found=board().todos.find(t=>t.id===id); if(!found) throw new NoteError('待办不存在',404); const n=raw(found.noteId); if(rev!==undefined) requireRev(n,rev)
    const completedAt=checked ? (found.done?found.completedAt:validTime(occurredAt)||now()) : null,completionEventId=randomUUID()
    const patch = body => { const d=JSON.parse(body); walk(d,x=>{if(x.type==='taskItem' && x.attrs.id===id){x.attrs.checked=!!checked;x.attrs.completedAt=completedAt;x.attrs.completionEventId=completionEventId}});return JSON.stringify(d) }
    db.prepare('UPDATE notes SET rev=rev+1,draft=?,committed=?,updated=? WHERE id=?').run(patch(n.draft),patch(n.committed),now(),n.id); schedule(raw(n.id)); return get(n.id)
  }) }
  function trash({id,rev,restore=false}) { return tx(()=>{const n=raw(id); if(n.rev!==rev) throw new NoteError('笔记版本已变化',409); db.prepare('UPDATE notes SET deleted=?,rev=rev+1,updated=? WHERE id=?').run(restore?null:now(),now(),id); schedule(n); return get(id)}) }
  function referencedAttachments() {
    const ids=new Set()
    for(const n of db.prepare('SELECT draft,committed FROM notes').all())for(const body of [n.draft,n.committed])for(const id of attachmentIds(body))ids.add(id)
    for(const version of db.prepare('SELECT body FROM versions').all())for(const id of attachmentIds(version.body))ids.add(id)
    return ids
  }
  function cleanupStatus() { return db.prepare('SELECT id,attempts,error,due FROM attachment_gc ORDER BY queued').all() }
  function processAttachmentGc({force=false}={}) {
    const jobs=db.prepare('SELECT id FROM attachment_gc WHERE due<=? ORDER BY queued LIMIT 50').all(force?Number.MAX_SAFE_INTEGER:Date.parse(now()))
    for(const {id} of jobs)tx(()=>{
      // A note may have started referencing an attachment since purge queued it.
      if(referencedAttachments().has(id)){db.prepare('DELETE FROM attachment_gc WHERE id=?').run(id);return}
      try {
        if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('Invalid attachment ID')
        try { removeAttachment(path.join(dir,'attachments',id)) } catch(e) { if(e.code!=='ENOENT')throw e }
        db.prepare('DELETE FROM attachments WHERE id=?').run(id)
        db.prepare('DELETE FROM attachment_gc WHERE id=?').run(id)
      } catch(e) { db.prepare('UPDATE attachment_gc SET attempts=attempts+1,error=?,due=? WHERE id=?').run(e.message,Date.parse(now())+60000,id) }
    })
    return cleanupStatus()
  }
  function purge({items}={}) {
    if(!Array.isArray(items)||items.length>5000)throw new NoteError('请提供明确的回收站记录列表')
    const unique=new Set();for(const item of items){if(typeof item?.id!=='string'||!Number.isInteger(item.rev)||unique.has(item.id))throw new NoteError('回收站记录列表无效');unique.add(item.id)}
    const result=tx(()=>{
      const selected=[]
      for(const item of items){const n=db.prepare('SELECT * FROM notes WHERE id=?').get(item.id);if(!n)continue;if(!n.deleted||n.rev!==item.rev)throw new NoteError('回收站已变化，记录可能已恢复或更新，请刷新后重试。',409);selected.push(n)}
      const candidates=new Set(),affectedPeriods=new Set()
      for(const n of selected){
        const versions=db.prepare('SELECT body,at FROM versions WHERE note_id=?').all(n.id)
        for(const body of [n.draft,n.committed,...versions.map(v=>v.body)])for(const id of attachmentIds(body))candidates.add(id)
        for(const stamp of [n.started,n.ended,...versions.map(v=>v.at)].filter(Boolean))for(const key of periodKeys(stamp))affectedPeriods.add(key)
        db.prepare('DELETE FROM versions WHERE note_id=?').run(n.id)
        db.prepare('DELETE FROM title_runs WHERE target=?').run('note:'+n.id)
        db.prepare('DELETE FROM jobs WHERE id=?').run('note:'+n.id)
        db.prepare('DELETE FROM notes WHERE id=?').run(n.id)
      }
      for(const r of db.prepare('SELECT id,result FROM requests').all()){let value;try{value=JSON.parse(r.result)}catch{}if(unique.has(value?.id))db.prepare('DELETE FROM requests WHERE id=?').run(r.id)}
      for(const key of affectedPeriods){
        db.prepare("UPDATE periods SET generated=NULL,summary=NULL,history='[]',content_hash=NULL,last_run=NULL WHERE id=?").run(key)
        db.prepare('DELETE FROM title_runs WHERE target=?').run(key)
        enqueue(key)
      }
      const referenced=referencedAttachments()
      for(const id of candidates)if(!referenced.has(id)&&db.prepare('SELECT 1 FROM attachments WHERE id=?').get(id))db.prepare('INSERT OR IGNORE INTO attachment_gc(id,queued,due) VALUES(?,?,?)').run(id,now(),Date.parse(now()))
      return {ok:true,deletedIds:[...unique]}
    })
    result.cleanupTasks=processAttachmentGc();result.cleanupPending=result.cleanupTasks.length
    return result
  }
  function todoTimeline({kind='day',date=dayKey(now()),basis='start',q='',hideCompleted=false}={}) {
    if(!['year','month','week','day'].includes(kind)||!['start','completed'].includes(basis)||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z')))throw new NoteError('待办时间范围无效')
    const all=board().todos,byId=new Map(all.map(t=>[t.id,t])),groups=new Map(),needle=String(q).trim().toLocaleLowerCase(),hide=hideCompleted===true||hideCompleted==='true'
    for(const t of all){
      if((basis==='completed'&&!t.done)||(basis==='start'&&hide&&t.done)||(needle&&!t.text.toLocaleLowerCase().includes(needle)))continue
      const stamp=basis==='start'?t.startedAt:t.completedAt,key=stamp?dayKey(stamp):'unknown'
      if(key!=='unknown'&&!inPeriod(key,kind,date))continue
      if(!groups.has(key))groups.set(key,{key,label:key==='unknown'?(basis==='completed'?'完成时间未知':'开始时间未知'):key,unknown:key==='unknown',matches:new Set(),visible:new Set()})
      const group=groups.get(key);group.matches.add(t.id);group.visible.add(t.id)
      let parent=t.parentId;while(parent){group.visible.add(parent);parent=byId.get(parent)?.parentId}
    }
    const result=[...groups.values()].sort((a,b)=>a.unknown?1:b.unknown?-1:a.key.localeCompare(b.key)).map(g=>({key:g.key,label:g.label,unknown:g.unknown,matchCount:g.matches.size,todos:all.filter(t=>g.visible.has(t.id)).map(t=>({...t,contextOnly:!g.matches.has(t.id)}))}))
    return {kind,date,basis,groups:result,matchCount:result.reduce((sum,g)=>sum+g.matchCount,0)}
  }
  function title({target,title,restore=false}) {
    const isNote=target.startsWith('note:'), key=isNote?target.slice(5):target, table=isNote?'notes':'periods', historyKey=isNote?'title_history':'history'
    if(!isNote) db.prepare('INSERT OR IGNORE INTO periods(id) VALUES(?)').run(key)
    const n=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(key); if(!n) throw new NoteError('标题不存在',404)
    if(n.manual&&(restore||n.manual!==(title?.trim()||null)))db.prepare(`UPDATE ${table} SET manual_history=? WHERE id=?`).run(JSON.stringify([...JSON.parse(n.manual_history),{title:n.manual,at:now()}]),key)
    if(restore) { const h=JSON.parse(n[historyKey]); if(!h.length) throw new NoteError('没有上一版模型标题'); const previous=h.pop(); db.prepare(`UPDATE ${table} SET manual=NULL,generated=?,${historyKey}=? WHERE id=?`).run(previous,JSON.stringify(h),key) }
    else db.prepare(`UPDATE ${table} SET manual=? WHERE id=?`).run(title?.trim() || null,key)
    if(isNote)db.prepare('UPDATE notes SET rev=rev+1,updated=? WHERE id=?').run(now(),key)
    return {ok:true}
  }
  function timeline({kind='day',date=dayKey(now()),basis='start',depth=1}={}) {
    if(!['year','month','week','day'].includes(kind)||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))) throw new NoteError('时间轴参数无效')
    const levels=['year','month','week','day','note']; depth=Math.max(1,Math.min(4,Number(depth)||1))
    const notes=list().filter(n=>n.committed).map(n=>({...n,day:dayKey(basis==='end'?n.endedAt:n.startedAt),time:basis==='end'?n.endedAt:n.startedAt})).filter(n=>inPeriod(n.day,kind,date)).sort((a,b)=>a.time.localeCompare(b.time))
    const periodTitle=(k,key)=>{const p=db.prepare('SELECT * FROM periods WHERE id=?').get(k+':'+key);return {title:p?.manual??p?.generated??key,manualTitle:p?.manual,generatedTitle:p?.generated,titleHistory:JSON.parse(p?.history||'[]')}}
    const build=(rows,k,left)=>{if(k==='note')return rows.map(n=>({kind:'note',key:n.id,date:n.day,time:n.time,title:n.title,manualTitle:n.manualTitle,generatedTitle:n.generatedTitle,titleHistory:n.titleHistory,noteId:n.id,children:[]})); const groups=new Map();for(const n of rows){const key=k==='year'?n.day.slice(0,4):k==='month'?n.day.slice(0,7):k==='week'?weekKey(n.day):n.day;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(n)}return [...groups].map(([key,items])=>({kind:k,key,date:items[0].day,...periodTitle(k,key),count:items.length,children:left>1?build(items,levels[levels.indexOf(k)+1],left-1):[]}))}
    const key=kind==='year'?date.slice(0,4):kind==='month'?date.slice(0,7):kind==='week'?weekKey(date):date
    return {kind,date,basis,depth,current:{target:kind+':'+key,...periodTitle(kind,key)},rows:build(notes,levels[levels.indexOf(kind)+1],depth)}
  }
  return {db,dir,get,save,commit,list,board,check,trash,purge,title,timeline,todoTimeline,enqueue,processAttachmentGc,cleanupStatus,close:()=>db.close(),now}
}
