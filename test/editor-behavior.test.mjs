import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import path from 'node:path'

const result = await build({
  stdin: { contents: `export * from './src/editor.jsx';export {getSchema} from '@tiptap/core';export {EditorState,TextSelection,NodeSelection} from '@tiptap/pm/state';export {history,undo,redo} from '@tiptap/pm/history';export {joinBackward,joinForward} from '@tiptap/pm/commands';`, resolveDir: path.resolve('.'), sourcefile: 'editor-test-entry.js' },
  bundle: true, format: 'esm', platform: 'node', write: false, jsx: 'transform',
  plugins: [{ name: 'headless-editor-imports', setup(build) {
    build.onResolve({filter:/^react$/},()=>({path:'react',namespace:'headless'}))
    build.onResolve({filter:/icons\.jsx$/},()=>({path:'icons',namespace:'headless'}))
    build.onLoad({filter:/.*/,namespace:'headless'},args=>({contents:args.path==='react'?'export default {};export const useEffect=()=>{},useCallback=x=>x,useState=()=>{},useRef=()=>{};':'export const Icon=()=>null,createIcon=()=>null;'}))
  }}],
})
const impl=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'))
const {getSchema,editorExtensions,EditorState,TextSelection,NodeSelection,history,undo,redo,deleteAdjacentAttachment,normalizeLinkHref,descendantCounts}=impl
const schema=getSchema(editorExtensions())
const p=text=>({type:'paragraph',...(text?{content:[{type:'text',text}]}:{})})
const media={type:'media',attrs:{attachmentId:'00000000-0000-4000-8000-000000000000',mime:'audio/webm',name:'test.webm'}}
const image={type:'image',attrs:{attachmentId:'10000000-0000-4000-8000-000000000000'}}
const task=(id,content)=>({type:'taskItem',attrs:{id,checked:false,completedAt:null,completionEventId:null},content})
const make=(content,pos)=>{const doc=schema.nodeFromJSON({type:'doc',content});return EditorState.create({schema,doc,selection:TextSelection.create(doc,pos),plugins:[history()]})}

test('Backspace after attachment removes only that block; Undo/Redo restores it',()=>{
 let state=make([p('before'),media,p('after')],10)
 const before=state.doc.toJSON();assert.equal(deleteAdjacentAttachment(state,tr=>state=state.apply(tr),'backward'),true)
 assert.equal(state.doc.childCount,2);assert.equal(state.doc.textContent,'beforeafter')
 assert.equal(undo(state,tr=>state=state.apply(tr)),true);assert.deepEqual(state.doc.toJSON(),before)
 assert.equal(redo(state,tr=>state=state.apply(tr)),true);assert.equal(state.doc.childCount,2)
})
test('Delete before image removes only image without merging paragraphs',()=>{
 let state=make([p('before'),image,p('after')],7)
 assert.equal(deleteAdjacentAttachment(state,tr=>state=state.apply(tr),'forward'),true)
 assert.equal(state.doc.childCount,2);assert.equal(state.doc.child(0).textContent,'before');assert.equal(state.doc.child(1).textContent,'after')
})
test('IME, text selections and interior positions defer to normal editor behavior',()=>{
 const state=make([p('before'),media,p('after')],10)
 assert.equal(deleteAdjacentAttachment(state,()=>assert.fail(),'backward',{composing:true}),false)
 assert.equal(deleteAdjacentAttachment(state.apply(state.tr.setSelection(TextSelection.create(state.doc,10,12))),()=>assert.fail(),'backward'),false)
 assert.equal(deleteAdjacentAttachment(make([p('before'),media,p('after')],11),()=>assert.fail(),'backward'),false)
})
test('Task text boundaries never delete a nested non-empty subtree',()=>{
 const data=[{type:'taskList',content:[task('parent',[p('parent'),{type:'taskList',content:[task('child',[p('child')])]}])]}]
 let state=make(data,4),snapshot=state.doc.toJSON()
 // First paragraph end belongs to parent; next block is taskList, not an attachment.
 let end;state.doc.descendants((node,pos)=>{if(node.type.name==='paragraph'&&node.textContent==='parent')end=pos+1+node.content.size})
 state=state.apply(state.tr.setSelection(TextSelection.create(state.doc,end)))
 assert.equal(deleteAdjacentAttachment(state,()=>assert.fail(),'forward'),false);assert.deepEqual(state.doc.toJSON(),snapshot)
})
test('Boundary delete handles media nested inside a task without changing task IDs',()=>{
 const data=[{type:'taskList',content:[task('parent',[p('title'),media,p('after'),{type:'taskList',content:[task('child',[p('child')])]}])]}]
 let state=make(data,4),start;state.doc.descendants((node,pos)=>{if(node.type.name==='paragraph'&&node.textContent==='after')start=pos+1})
 state=state.apply(state.tr.setSelection(TextSelection.create(state.doc,start)))
 assert.equal(deleteAdjacentAttachment(state,tr=>state=state.apply(tr),'backward'),true)
 const ids=[];state.doc.descendants(n=>{if(n.type.name==='taskItem')ids.push(n.attrs.id)})
 assert.deepEqual(ids,['parent','child']);assert.equal(state.doc.textContent,'titleafterchild')
})
test('Completion attrs survive schema parsing, including unknown old completion times',()=>{
 const content=[{type:'taskList',content:[{...task('a',[p('task')]),attrs:{id:'a',checked:true,completedAt:null,completionEventId:null}},{...task('b',[p('task2')]),attrs:{id:'b',checked:true,completedAt:'2026-10-28T14:00:00.000Z',completionEventId:'event-id'}}]}]
 const d=schema.nodeFromJSON({type:'doc',content});assert.equal(d.firstChild.firstChild.attrs.completedAt,null);assert.equal(d.firstChild.lastChild.attrs.completionEventId,'event-id')
})
test('Layer counts represent direct layer populations, not completion ratios',()=>{
 assert.deepEqual(descendantCounts(task('root',[p('root'),{type:'taskList',content:[task('a',[p('a'),{type:'taskList',content:[task('aa',[p('aa')]),task('ab',[p('ab')])]}]),task('b',[p('b')])]}])),[2,2])
 assert.deepEqual(descendantCounts(task('empty',[p()])),[])
})
test('Links accept HTTP HTTPS mailto and reject scripts, controls and empty host',()=>{
 for(const href of ['https://example.com/a','http://example.com','mailto:reader@example.com'])assert.equal(normalizeLinkHref(href),href)
 for(const href of ['javascript:alert(1)','data:text/html,x','https://','https://ex\nample.com','file:///secret',''])assert.equal(normalizeLinkHref(href),null)
})


test('Link mark edit preserves bold selected text; removing link preserves text and bold',()=>{
 let state=make([{type:'paragraph',content:[{type:'text',text:'参考资料',marks:[{type:'bold'}]}]}],1)
 assert.equal(impl.changeLink(state,tr=>state=state.apply(tr),{from:1,to:5,href:'https://example.com',label:'参考资料',initialLabel:'参考资料'}),true)
 assert.equal(state.doc.textContent,'参考资料');assert.deepEqual(state.doc.firstChild.firstChild.marks.map(m=>m.type.name).sort(),['bold','link'])
 assert.equal(impl.changeLink(state,tr=>state=state.apply(tr),{from:1,to:5,remove:true}),true)
 assert.deepEqual(state.doc.firstChild.firstChild.marks.map(m=>m.type.name),['bold']);assert.equal(state.doc.textContent,'参考资料')
})
test('Collapsed selection inserts a visible URL and supports undo',()=>{
 let state=make([p()],1)
 assert.equal(impl.changeLink(state,tr=>state=state.apply(tr),{from:1,to:1,href:'https://example.com',label:'',initialLabel:''}),true)
 assert.equal(state.doc.textContent,'https://example.com');assert.equal(state.doc.firstChild.firstChild.marks[0].attrs.href,'https://example.com')
 undo(state,tr=>state=state.apply(tr));assert.equal(state.doc.textContent,'')
 assert.equal(impl.changeLink(state,()=>assert.fail(),{from:1,to:999,href:'https://example.com'}),false)
})
