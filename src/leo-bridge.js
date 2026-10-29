/** Same-page bridge shared by the launcher and leo-status; no browser storage or note writes. */
export function createQuickBridge({registry,layout,getUserMedia=()=>navigator.mediaDevices.getUserMedia({audio:true})}){
 let active=null,closed=false;const listeners=new Set()
 const emit=()=>{for(const f of [...listeners])f()}
 function request(kind){
  if(closed)throw new Error('快捷入口已关闭')
  if(active)throw new Error('已有快捷草稿，请先完成或关闭')
  let resolveResult;const pending=new Promise(resolve=>{resolveResult=resolve});let stream=null,cancelled=false,claimed=false,release=()=>{},stopRecording=null
  const req={kind,pending,get claimed(){return claimed},claim(){if(claimed||cancelled)return false;claimed=true;return true},setStopRecorder(fn){stopRecording=fn},finish(){if(cancelled)return;cancelled=true;try{stopRecording?.()}catch{}for(const t of stream?.getTracks?.()||[])try{t.stop()}catch{}stream=null;release();if(active===req)active=null},cancel(){req.finish()}}
  active=req;release=registry.trackCancel(()=>req.cancel())
  // Do not await or schedule: browser microphone permission needs this exact click stack.
  if(kind==='record'){
   try{const media=getUserMedia();Promise.resolve(media).then(s=>{if(cancelled){for(const t of s.getTracks())try{t.stop()}catch{}resolveResult({cancelled:true});return}stream=s;resolveResult({stream:s})},error=>resolveResult({error}))}catch(error){resolveResult({error})}
  }else resolveResult({})
  try{layout.selectPanel('leo-status')}catch(error){req.cancel();throw error}
  emit();return req
 }
 const remove=[];try{remove.push(registry.register({id:'leo-status.new-todo',label:'新建待办',icon:'todo',order:10,run:()=>request('todo')}));remove.push(registry.register({id:'leo-status.new-recording',label:'新建录音',icon:'record',order:20,run:()=>request('record')}))}catch(error){for(const stop of remove)stop();throw error}
 return {subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn)},consume(){const req=active;return req?.claim()?req:null},dispose(){if(closed)return;closed=true;for(const f of remove)f();active?.cancel();listeners.clear()},get active(){return active}}
}
