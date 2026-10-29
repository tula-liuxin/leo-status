import path from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { resolveDataDir, loadSettings, defaultSettings } from './settings.js'
import { createHubStore, createHubHandler, startHubServer, registerHubRoute } from './hub.js'
import { requestHubYuan } from './sync.js'
import { createRelay } from './relay.js'
import { openNotes, NoteError } from './notes.js'
import { createNotesHandler, NOTES_API, HUB_NOTES_API } from './notes-http.js'
import { titleWorker, loggedGenerator } from './notes-titles.js'
import { applyTodoAction } from './edit.js'
export const name='leo-status',inject=[],PLUGIN_VERSION='2.2.0'
const json=(res,status,value)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(value))}
async function body(req){const chunks=[];let size=0;for await(const c of req){size+=c.length;if(size>8*1024*1024)throw new NoteError('请求过大',413);chunks.push(c)}try{return JSON.parse(Buffer.concat(chunks).toString()||'{}')}catch{throw new NoteError('JSON 无效')}}
export function apply(ctx,config={}) {
 const dataDir=resolveDataDir(config),log=(...v)=>console.log('[leo-status]',...v),routes=[]
 mkdirSync(dataDir,{recursive:true});let token;try{token=readFileSync(path.join(dataDir,'page-token'),'utf8').trim()}catch{}if(!/^[a-f0-9]{32,128}$/i.test(token||'')){token=randomBytes(24).toString('hex');writeFileSync(path.join(dataDir,'page-token'),token,{mode:0o600})}
 let settings=defaultSettings(),notes,worker,handler,relay,server,stopping=false,startup
 const remote=()=>settings.mode==='device'
 async function call(route,value){
  await startup
  if(remote()){
   const get=['state','note','timeline','tags'].includes(route),url=new URL(settings.device.hubUrl.replace(/\/$/,'')+HUB_NOTES_API+'/'+route)
   if(get)for(const [k,v] of Object.entries(value||{}))url.searchParams.set(k,v)
   const r=await fetch(url,{method:get?'GET':'POST',headers:{authorization:'Bearer '+settings.device.password,'content-type':'application/json'},body:get?undefined:JSON.stringify(value||{}),signal:AbortSignal.timeout(20000)}),b=await r.json();if(!r.ok)throw new NoteError(b.error||'本机中心不可达',r.status);return b
  }
  if(route==='state')return {board:notes.board(),notes:notes.list()}
  if(route==='note')return notes.get(value.id)
  if(route==='timeline')return notes.timeline(value)
  if(route==='tags')return notes.tags(value)
  if(route==='save')return notes.save(value)
  if(route==='move')return notes.move(value)
  if(route==='check')return notes.check(value)
  if(route==='cancelTodo')return notes.cancelTodo(value)
  if(route==='trash')return notes.trash(value)
  if(route==='title')return notes.title(value)
  throw new NoteError('不支持的笔记操作')
 }
 const propose=async text=>{const value=String(text||'').trim();if(!value)throw new NoteError('内容不能为空');const n=await call('save',{doc:{type:'doc',content:[{type:'taskList',content:[{type:'taskItem',attrs:{checked:false},content:[{type:'paragraph',content:[{type:'text',text:value}]}]}]}]}});return {ok:true,id:n.id,status:'draft',message:'草稿等待 Leo 提交'}}
 const board={list:async()=>({...((await call('state')).board),mode:settings.mode,role:settings.mode}),stats:async()=>((await call('state')).board.stats),propose,action:async b=>{
  const action=String(b?.action||'')
  if(b?.kind==='markdown'){
   try{
    const roots=(settings.markdownRoots||[]).map(r=>({path:r.path}))
    const result=await applyTodoAction({action,filePath:b.file,line:Number(b.line),raw:b.raw??null,roots})
    return {ok:true,action,result,board:await board.list()}
   }catch(e){throw new NoteError(e.message,e.code==='changed'?409:e.code==='not-found'?404:400)}
  }
  if(!['done','undone','cancel','restore'].includes(action))throw new NoteError('不支持的操作')
  if(action==='cancel'||action==='restore'){const n=await call('cancelTodo',{id:b.id,rev:b.rev,cancelled:action==='cancel'});return {ok:true,note:n,board:await board.list()}}
  const n=await call('check',{id:b.id,rev:b.rev,checked:action==='done'});return {ok:true,note:n,board:await board.list()}
 }}
 ctx.provide('leoBoard',board)
 ctx.provide('leoNotes',{get:id=>call('note',{id}),list:()=>call('state'),save:v=>call('save',v),move:v=>call('move',v),timeline:v=>call('timeline',v),tags:v=>call('tags',v),check:v=>call('check',v),trash:v=>call('trash',v),title:v=>call('title',v)})
 ctx.provide('leoHub',{mode:()=>settings.mode,isHub:()=>settings.mode==='hub',isDevice:remote,baseUrl:()=>settings.device.hubUrl,remoteCall:(route,b)=>requestHubYuan({hubUrl:settings.device.hubUrl,password:settings.device.password,route,body:b}),registerRoute:(prefix,fn)=>registerHubRoute(routes,prefix,fn)})
 ctx.effect(()=>{
  startup=(async()=>{
   const loaded=await loadSettings(dataDir);if(loaded.error)throw new Error(loaded.error);settings=loaded.settings;if(stopping)return
   if(!remote()){notes=openNotes(dataDir);worker=titleWorker(notes,loggedGenerator(ctx,notes.dir))}
   handler=createNotesHandler({store:notes,worker,settings:()=>settings});routes.push({prefix:HUB_NOTES_API,handler:(req,res,p)=>handler(req,res,p)},{prefix:'/api/push',handler:async(req,res)=>{json(res,410,{error:'旧快照导入已停用'});return true}})
   if(settings.mode==='hub'){
    if(!settings.hub.password)throw new Error('本机中心密码未配置')
    const hubStore=createHubStore(dataDir);await hubStore.load()
    server=await startHubServer({port:settings.hub.port,handler:createHubHandler({password:settings.hub.password,store:hubStore,boardProvider:()=>board.list(),extraRoutes:routes,boardWrites:{propose:b=>propose(b.text),action:b=>board.action(b),accept:()=>{throw new NoteError('请提交笔记草稿')},dismiss:()=>{throw new NoteError('请在草稿中处理')}},log}),log})
    relay=createRelay(settings,log);if(!stopping)relay.start()
   }
  })();startup.catch(e=>log('startup failed:',e.message))
  return async()=>{stopping=true;await startup.catch(()=>{});relay?.stop();await server?.close();await worker?.stop();notes?.close()}
 },'leo-status notes runtime')
 ctx.inject(['tools'],scope=>{
  scope.effect(()=>scope.tools.register({name:'leo_status',description:'读取 Leo 已提交笔记的待办。propose 创建待确认草稿，不代表 Leo 承诺；仅 Leo 可提交。done/undone 修改正式待办。',parameters:{type:'object',properties:{action:{type:'string',enum:['list','propose','done','undone']},id:{type:'string'},text:{type:'string'}},required:['action'],additionalProperties:false},output:{schema:{type:'string'},render:(_,v)=>[{type:'text',text:v}]},async execute(a){return JSON.stringify(a.action==='list'?await board.list():a.action==='propose'?await propose(a.text):await board.action(a))}}),'leo-status compatibility tool')
  scope.effect(()=>scope.tools.register({name:'leo_notes',description:'读取笔记和时间轴，或保存带稳定节点 ID 的富文本草稿。不能提交正式版本；save 必须提供读取时的 rev，发生冲突应重新读取。正文 doc 使用 Tiptap JSON。',parameters:{type:'object',properties:{action:{type:'string',enum:['list','get','save','timeline','tags','move']},id:{type:'string'},rev:{type:'integer'},doc:{type:'object',additionalProperties:true},manualTitle:{type:'string'},kind:{type:'string',enum:['year','month','week','day']},date:{type:'string'},depth:{type:'integer'},basis:{type:'string',enum:['start','end']},parentId:{type:['string','null']},parentRev:{type:'integer'},tag:{type:'string'},q:{type:'string'},scope:{type:'string',enum:['all','note','inline']}},required:['action'],additionalProperties:false},output:{schema:{type:'string'},render:(_,v)=>[{type:'text',text:v}]},async execute(a){const {action,...v}=a;return JSON.stringify(await call({list:'state',get:'note',save:'save',timeline:'timeline',tags:'tags',move:'move'}[action],v))}}),'leo-status notes tool')
 })
 ctx.inject(['webServer','connection'],scope=>{
  const matches=v=>{if(typeof v!=='string')return false;const a=Buffer.from(v),b=Buffer.from(token);return a.length===b.length&&timingSafeEqual(a,b)}
  const authorized=(req,res)=>{if(req.headers['sec-fetch-site']==='cross-site'){json(res,403,{error:'cross-site request rejected'});return false}const u=new URL(req.url,'http://localhost');if(matches(req.headers['x-leo-status-token'])||matches(u.searchParams.get('_leo_status_token')))return true;if(scope.connection.authorizeIndex?.(req,res))return true;if(!res.headersSent)json(res,401,{error:'unauthorized'});return false}
  scope.effect(()=>scope.webServer.tapIndex(html=>{if(html.includes('__LEO_STATUS_PAGE_TOKEN__'))return html;const script='<script>window.__LEO_STATUS_PAGE_TOKEN__='+JSON.stringify(token)+'</script>';return html.includes('</head>')?html.replace('</head>',script+'</head>'):html+script}),'leo-status page token')
  const local=async(req,res)=>{try{if(!authorized(req,res))return;await startup;const p=new URL(req.url,'http://localhost').pathname;if(p.startsWith(NOTES_API)){await handler(req,res,p);return}if(p==='/leo-status/api/todos'&&req.method==='GET'){json(res,200,await board.list());return}if(p==='/leo-status/api/todos/action'&&req.method==='POST'){json(res,200,await board.action(await body(req)));return}if(p==='/leo-status/api/hub/status'){json(res,200,{mode:settings.mode,storage:'本机中心',version:PLUGIN_VERSION,relay:relay?.status()});return}json(res,410,{error:'旧来源导入已停用，请使用 leo-status 笔记'})}catch(e){if(!res.headersSent)json(res,e.status||503,{error:e.message})}}
  scope.effect(()=>scope.webServer.register({kind:'prefix',path:'/leo-status/api',handler:local}),'leo-status API')
 })
}
