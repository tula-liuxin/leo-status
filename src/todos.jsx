import React from 'react'
import {Icon} from './icons.jsx'
import {IconButton} from './ui.jsx'
export function descendantCounts(rows){const byId=new Map(rows.map(r=>[r.id,r])),counts=new Map();for(const r of rows){let p=r.parentId,level=0;const visited=new Set();while(p&&byId.has(p)&&!visited.has(p)){visited.add(p);const c=counts.get(p)||[];c[level]=(c[level]||0)+1;counts.set(p,c);p=byId.get(p).parentId;level++}}return counts}
export function filterTree(rows,{query='',hideCompleted=false}={}){const byId=new Map(rows.map(t=>[t.id,t])),visible=new Set(rows.filter(t=>(!hideCompleted||!t.done)&&(!query||t.text.toLowerCase().includes(query.toLowerCase()))).map(t=>t.id));for(const id of [...visible]){let p=byId.get(id)?.parentId;while(p&&!visible.has(p)){visible.add(p);p=byId.get(p)?.parentId}}return rows.filter(t=>visible.has(t.id))}
export function TodoTree({rows,allRows=rows,collapsed,setCollapsed,query,onOpen,onCheck}){
 const byId=new Map(rows.map(t=>[t.id,t])),counts=descendantCounts(allRows),parents=new Set(rows.map(r=>r.parentId).filter(Boolean))
 const visible=rows.filter(t=>{let p=t.parentId;while(p){if(collapsed.has(p)&&!query)return false;p=byId.get(p)?.parentId}return true})
 return <div className="ln-todos" role="list">{visible.map(t=>{const c=counts.get(t.id)||[],label=c.map((n,i)=>`第 ${i+1} 层 ${n} 个子待办`).join('；');const root=!t.parentId||!byId.has(t.parentId);return <div role="listitem" className={'ln-todo '+(root?'ln-root-row ':'')+(t.contextOnly?'ln-context-row':'')} key={t.id} style={{'--indent':Math.min(t.depth,6)}}>
  {parents.has(t.id)?<IconButton className="ln-fold" name={collapsed.has(t.id)?'chevronRight':'chevronDown'} label={(collapsed.has(t.id)?'展开 ':'收起 ')+t.text} aria-expanded={!collapsed.has(t.id)} onClick={()=>setCollapsed(v=>{const next=new Set(v);next.has(t.id)?next.delete(t.id):next.add(t.id);return next})}/>:<span className="ln-fold" aria-hidden="true"/>}
  <label className="ln-check-hit"><input type="checkbox" aria-label={'完成 '+t.text} checked={t.done} onChange={e=>onCheck(t,e.target.checked)}/></label>
  <span className="ln-todo-main"><button className={'ln-todo-text '+(t.done?'ln-done':'')} onClick={()=>onOpen(t.noteId,t.id)}>{t.text||'未命名待办'}</button>{t.contextOnly&&<span className="ln-context-label">范围外父项</span>}<span className="ln-todo-badges">{c.length>0&&<button className="ln-count-badge" title={'全部子待办：'+label} aria-label={'查看子内容，'+label} onClick={()=>onOpen(t.noteId,t.id)}>{c.slice(0,3).join(' / ')}{c.length>3?' / …':''}</button>}<IconButton name="enter" label={'进入内容页 '+(t.text||'未命名待办')} onClick={()=>onOpen(t.noteId,t.id)}/></span></span>
  <small title={t.noteTitle}>{t.noteTitle}</small>
 </div>})}</div>
}
