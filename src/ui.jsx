import React,{useEffect,useRef,useState} from 'react'
import {Icon} from './icons.jsx'
export function IconButton({name,label,className='',...props}){
 return <button type="button" {...props} className={'ln-icon-button '+className} title={label} aria-label={label}><Icon name={name}/></button>
}
export function ConfirmDialog({title,message,confirmLabel='确认',danger=false,onConfirm,onClose}){
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),root=useRef()
 useEffect(()=>{const previous=document.activeElement;root.current?.querySelector('[data-cancel]')?.focus();return()=>previous?.focus?.()},[])
 return <div className="ln-backdrop ln-confirm-backdrop" onMouseDown={e=>{e.stopPropagation()}}><section ref={root} className="ln-confirm" role="alertdialog" aria-modal="true" aria-label={title} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape'&&!busy)onClose();if(e.key==='Tab'){const list=[...root.current.querySelectorAll('button:not(:disabled)')];if(e.shiftKey&&document.activeElement===list[0]){e.preventDefault();list.at(-1)?.focus()}else if(!e.shiftKey&&document.activeElement===list.at(-1)){e.preventDefault();list[0]?.focus()}}}}>
  <header><h3>{title}</h3><IconButton name="x" label="关闭确认" disabled={busy} onClick={onClose}/></header><p>{message}</p>{error&&<p role="alert" className="ln-error">{error}</p>}
  <footer className="ln-row"><button data-cancel disabled={busy} onClick={onClose}>取消</button><button className={danger?'ln-danger':'ln-primary'} disabled={busy} onClick={async()=>{setBusy(true);try{await onConfirm();onClose()}catch(e){setError(e.message)}finally{setBusy(false)}}}>{busy?'处理中…':confirmLabel}</button></footer>
 </section></div>
}
export function DateControls({date,setDate,kind,setKind,basis,setBasis,today,task=false,depth,setDepth}){
 return <div className="ln-date-controls"><input type="date" aria-label={task?'待办日期':'笔记日期'} value={date} onChange={e=>{if(e.target.value)setDate(e.target.value)}}/><button onClick={()=>setDate(today())}>今天</button>
  <div className="ln-segments" aria-label="时间范围">{[['year','年'],['month','月'],['week','周'],['day','日']].map(([k,label])=><button key={k} aria-pressed={kind===k} onClick={()=>setKind(k)}>{label}</button>)}</div>
  <button className="ln-time-toggle" aria-label={'时间依据：'+(basis==='start'?'开始':task?'完成':'结束')+'，点击切换'} title="点击切换时间依据" aria-pressed={basis!=='start'} onClick={()=>setBasis(basis==='start'?(task?'completed':'end'):'start')}><Icon name="calendar"/><span>{basis==='start'?'开始':task?'完成':'结束'}</span></button>
  {setDepth&&<div className="ln-stepper" aria-label="展开等级"><IconButton name="minus" label="减少展开等级" disabled={depth<=1} onClick={()=>setDepth(v=>Math.max(1,v-1))}/><output aria-live="polite">{depth} 级</output><IconButton name="plus" label="增加展开等级" disabled={depth>=4} onClick={()=>setDepth(v=>Math.min(4,v+1))}/></div>}
 </div>
}
