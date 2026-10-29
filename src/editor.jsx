import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Editor, Extension, Node, getMarkRange, mergeAttributes } from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import { TaskList, TaskItem } from '@tiptap/extension-list'
import Image from '@tiptap/extension-image'
import { Plugin, PluginKey, TextSelection, NodeSelection } from '@tiptap/pm/state'
import { Fragment, Slice } from '@tiptap/pm/model'
import { dropPoint } from '@tiptap/pm/transform'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Icon, createIcon } from './icons.jsx'
import {tagsInText,matchTag} from '../tags.js'

export function attachmentEndpoint(route) {
  const url = new URL('leo-status/api/notes-v1' + route, document.baseURI)
  if (window.__LEO_STATUS_PAGE_TOKEN__) url.searchParams.set('_leo_status_token', window.__LEO_STATUS_PAGE_TOKEN__)
  return url.href
}

export function descendantCounts(node) {
  const result = [], stack = (node.content || []).map(n => [n, 0])
  while (stack.length) {
    const [current, depth] = stack.pop(), next = depth + (current.type === 'taskItem' ? 1 : 0)
    if (current.type === 'taskItem') result[next - 1] = (result[next - 1] || 0) + 1
    for (const child of current.content || []) stack.push([child, next])
  }
  return result
}

export function normalizeLinkHref(value) {
  const href = String(value || '').trim()
  if (!href || /[\u0000-\u0020\u007f]/.test(href)) return null
  try {
    const url = new URL(href)
    if ((url.protocol === 'https:' || url.protocol === 'http:') && url.hostname) return href
    if (url.protocol === 'mailto:' && url.pathname) return href
  } catch {}
  return null
}

/** Shared by the popover and headless tests; mark-only edits preserve text formatting. */
export function changeLink(state, dispatch, { from, to, href, label, initialLabel, remove = false }) {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > to || to > state.doc.content.size) return false
  const mark = state.schema.marks.link
  if (!mark) return false
  const tr = state.tr
  if (remove) tr.removeMark(from, to, mark)
  else {
    const normalized = normalizeLinkHref(href)
    if (!normalized) return false
    const attrs = { href: normalized, target: '_blank', rel: 'noopener noreferrer' }
    if (from !== to && label === initialLabel) tr.addMark(from, to, mark.create(attrs))
    else {
      const value = String(label || '').trim() || normalized
      tr.insertText(value, from, to).addMark(from, from + value.length, mark.create(attrs))
      tr.setSelection(TextSelection.create(tr.doc, from + value.length))
    }
  }
  if (dispatch) dispatch(tr.scrollIntoView())
  return true
}

/** Delete only an adjacent attachment block; never a paragraph or task subtree. */
export function deleteAdjacentAttachment(state, dispatch, direction, { composing = false } = {}) {
  if (composing || !state.selection.empty) return false
  const { $from } = state.selection
  if (!$from.parent.isTextblock || !$from.depth) return false
  const backwards = direction === 'backward'
  if (backwards ? $from.parentOffset !== 0 : $from.parentOffset !== $from.parent.content.size) return false
  const boundary = backwards ? $from.before($from.depth) : $from.after($from.depth)
  const resolved = state.doc.resolve(boundary), node = backwards ? resolved.nodeBefore : resolved.nodeAfter
  if (!node || !node.isAtom || !['image', 'media'].includes(node.type.name)) return false
  const from = backwards ? boundary - node.nodeSize : boundary
  if (dispatch) dispatch(state.tr.delete(from, from + node.nodeSize).scrollIntoView())
  return true
}

const AttachmentBoundaryKeys = Extension.create({
  name: 'attachmentBoundaryKeys', priority: 1000,
  addProseMirrorPlugins() {
    return [new Plugin({
      key: new PluginKey('leoAttachmentBoundary'),
      props: { handleKeyDown(view, event) {
        if (!['Backspace', 'Delete'].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey) return false
        if (event.target?.closest?.('audio,video,input,button,select,textarea')) return false
        return deleteAdjacentAttachment(view.state, view.dispatch, event.key === 'Backspace' ? 'backward' : 'forward', { composing: view.composing || event.isComposing })
      } },
    })]
  },
})

export function moveImage(state, dispatch, from, target) {
  const node=state.doc.nodeAt(from)
  if(!node||node.type.name!=='image'||!Number.isInteger(target)||target<0||target>state.doc.content.size||target>=from&&target<=from+node.nodeSize)return false
  const tr=state.tr.delete(from,from+node.nodeSize), slice=new Slice(Fragment.from(node),0,0)
  const to=dropPoint(tr.doc,tr.mapping.map(target),slice)
  if(to==null)return false
  tr.insert(to,node).setSelection(NodeSelection.create(tr.doc,to))
  if(dispatch)dispatch(tr.scrollIntoView())
  return true
}

export const AttachmentImage = Image.extend({
  draggable: false,
  addAttributes() { return { ...this.parent?.(), src: { default: null, rendered: false }, attachmentId: { default: null, parseHTML: el => el.getAttribute('data-leo-attachment-id'), renderHTML: attrs => attrs.attachmentId ? { 'data-leo-attachment-id': attrs.attachmentId } : {} } } },
  parseHTML() { return [{ tag: 'img[data-leo-attachment-id]' }] },
  renderHTML({ HTMLAttributes }) {
    // Clipboard HTML carries an attachment reference, never the page token.
    return ['img', mergeAttributes(HTMLAttributes)]
  },
  addNodeView() { return ({node,editor,getPos}) => {
    let current=node, resize=null, moving=null
    const dom=document.createElement('div'), image=document.createElement('img'), grip=document.createElement('button'), handle=document.createElement('button')
    dom.className='ln-image-block';dom.contentEditable='false';dom.draggable=false
    image.draggable=false;image.alt=node.attrs.alt||'图片';image.src=attachmentEndpoint('/attachment?id='+node.attrs.attachmentId)
    grip.type='button';grip.className='ln-image-drag';grip.title='拖动图片调整位置';grip.setAttribute('aria-label','拖动图片调整位置');grip.textContent='⋮⋮'
    handle.type='button';handle.className='ln-image-resize';handle.title='拖动调整图片大小；方向键微调';handle.setAttribute('aria-label','调整图片大小');handle.textContent='↘'
    const display=n=>{current=n;image.alt=n.attrs.alt||'图片';dom.style.width=n.attrs.width?`${n.attrs.width}px`:''}
    const commit=width=>{const pos=getPos();if(typeof pos!=='number')return;const n=editor.state.doc.nodeAt(pos);if(!n||n.type!==current.type)return;editor.view.dispatch(editor.state.tr.setNodeMarkup(pos,undefined,{...n.attrs,width:Math.max(48,Math.round(width)),height:null}))}
    handle.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();resize={id:e.pointerId,x:e.clientX,width:dom.getBoundingClientRect().width};handle.setPointerCapture(e.pointerId)})
    handle.addEventListener('pointermove',e=>{if(!resize||resize.id!==e.pointerId)return;dom.style.width=Math.max(48,resize.width+e.clientX-resize.x)+'px'})
    const end=e=>{if(!resize||resize.id!==e.pointerId)return;const width=dom.getBoundingClientRect().width;resize=null;commit(width)}
    handle.addEventListener('pointerup',end);handle.addEventListener('pointercancel',()=>{resize=null;display(current)})
    handle.addEventListener('keydown',e=>{if(!['ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();commit(dom.getBoundingClientRect().width+(e.key==='ArrowRight'?16:-16))})
    grip.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();e.stopPropagation();moving={id:e.pointerId,x:e.clientX,y:e.clientY};grip.setPointerCapture(e.pointerId);dom.classList.add('is-moving')})
    grip.addEventListener('pointerup',e=>{if(!moving||moving.id!==e.pointerId)return;const start=moving;moving=null;dom.classList.remove('is-moving');if(Math.hypot(e.clientX-start.x,e.clientY-start.y)<5)return;const pos=getPos(),rect=editor.view.dom.getBoundingClientRect(),area=editor.view.dom.closest('.ln-editor-scroll')?.getBoundingClientRect()||rect;if(e.clientX<area.left||e.clientX>area.right||e.clientY<area.top||e.clientY>area.bottom)return;const hit=e.clientY>=rect.bottom?{pos:editor.state.doc.content.size}:e.clientY<=rect.top?{pos:0}:editor.view.posAtCoords({left:Math.max(rect.left+2,Math.min(rect.right-2,e.clientX)),top:e.clientY});if(typeof pos==='number'&&hit)moveImage(editor.state,editor.view.dispatch,pos,hit.pos)})
    grip.addEventListener('pointercancel',()=>{moving=null;dom.classList.remove('is-moving')})
    grip.addEventListener('dragstart',e=>e.preventDefault())
    dom.append(image,grip,handle);display(node)
    return {dom,update(next){if(next.type!==current.type||next.attrs.attachmentId!==current.attrs.attachmentId)return false;display(next);return true},stopEvent:e=>handle.contains(e.target)||grip.contains(e.target),ignoreMutation:()=>true}
  } },
})

/** Pasted task copies need new identities even when copied to another note. */
export function copySliceWithFreshTaskIds(slice,makeId=()=>crypto.randomUUID()) {
  let changed=false
  const map=node=>{let attrs=node.attrs;if(node.type.name==='taskItem'){attrs={...attrs,id:makeId(),completionEventId:null};changed=true}const children=[];node.content.forEach(child=>children.push(map(child)));return node.isText?node:node.type.create(attrs,Fragment.fromArray(children),node.marks)}
  const children=[];slice.content.forEach(node=>children.push(map(node)))
  return changed?new Slice(Fragment.fromArray(children),slice.openStart,slice.openEnd):slice
}
export function sliceContainsTasks(slice){let found=false;slice.content.descendants(n=>{if(n.type.name==='taskItem')found=true});return found}

export const Media = Node.create({
  name: 'media', group: 'block', atom: true,
  addAttributes() { return { attachmentId: { default: null }, mime: { default: '' }, name: { default: '' } } },
  parseHTML() { return [{ tag: 'figure[data-media]' }] },
  renderHTML({ HTMLAttributes: a }) {
    const src = attachmentEndpoint('/attachment?id=' + a.attachmentId)
    const kind = a.mime.startsWith('audio/') ? 'audio' : a.mime.startsWith('video/') ? 'video' : null
    return ['figure', { 'data-media': a.attachmentId }, kind ? [kind, { controls: true, src, preload: 'metadata' }] : ['a', { href: src, target: '_blank', rel: 'noopener noreferrer' }, a.name], ['figcaption', {}, a.name]]
  },
  addNodeView() { return ({ node }) => {
    const dom = document.createElement('figure'), a = node.attrs, caption = document.createElement('figcaption')
    dom.dataset.media = a.attachmentId; dom.contentEditable = 'false'; caption.textContent = a.name
    const kind = a.mime.startsWith('audio/') ? 'audio' : a.mime.startsWith('video/') ? 'video' : null
    const media = document.createElement(kind || 'a'), src = attachmentEndpoint('/attachment?id=' + a.attachmentId)
    if (kind) { media.src = src; media.controls = true; media.preload = 'metadata'; media.setAttribute('aria-label', a.name || '媒体附件') }
    else { media.href = src; media.target = '_blank'; media.rel = 'noopener noreferrer'; media.textContent = a.name || '打开附件' }
    dom.append(media, caption)
    return { dom, stopEvent: e => Boolean(e.target?.closest?.('audio,video,a,input,button')), ignoreMutation: () => true }
  } },
})

function taskExtension(onFocus) {
  return TaskItem.extend({
    addAttributes() { return { ...this.parent?.(), id: { default: null }, completedAt: { default: null }, completionEventId: { default: null } } },
    addNodeView() { return ({ node, editor, getPos }) => {
      let current = node, folded = false
      const dom = document.createElement('li'), fold = document.createElement('button'), checkHit = document.createElement('label'), check = document.createElement('input'), body = document.createElement('div')
      dom.className = 'ln-task'; dom.dataset.type = 'taskItem'; body.className = 'ln-taskbody'
      fold.type = 'button'; fold.className = 'ln-task-fold ln-icon-button'; fold.contentEditable = 'false'
      check.type = 'checkbox'; check.contentEditable = 'false'; check.setAttribute('aria-label', '完成待办')
      checkHit.className = 'ln-check-hit'; checkHit.contentEditable = 'false'; checkHit.append(check)
      const render = n => {
        current = n; check.checked = n.attrs.checked
        const expandable = n.childCount > 1
        fold.disabled = !expandable; fold.style.visibility = expandable ? '' : 'hidden'
        fold.replaceChildren(createIcon(folded ? 'chevronRight' : 'chevronDown', 16))
        fold.setAttribute('aria-label', folded ? '展开待办内容' : '收起待办内容'); fold.title = folded ? '展开待办内容' : '收起待办内容'
        fold.setAttribute('aria-expanded', String(!folded)); dom.classList.toggle('is-collapsed', folded && expandable)
      }
      fold.addEventListener('mousedown', e => e.preventDefault())
      fold.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); folded = !folded; render(current) })
      check.addEventListener('change', () => editor.chain().focus().command(({ tr }) => {
        const pos = getPos(); if (typeof pos !== 'number') return false
        tr.setNodeMarkup(pos, undefined, { ...current.attrs, checked: check.checked, completedAt: check.checked ? new Date().toISOString() : null, completionEventId: crypto.randomUUID() }); return true
      }).run())
      dom.append(fold, checkHit, body); render(node)
      return {
        dom, contentDOM: body,
        update(next) { if (next.type !== current.type) return false; render(next); return true },
        stopEvent: e => checkHit.contains(e.target) || fold.contains(e.target),
        ignoreMutation: mutation => mutation.type !== 'selection' && !body.contains(mutation.target),
      }
    } },
    addProseMirrorPlugins() {
      const parent = this.parent?.() || []
      return [...parent, new Plugin({
        key: new PluginKey('leoTaskInlineActions'),
        props: { decorations(state) {
          const widgets = []
          state.doc.descendants((node, pos) => {
            if (node.type.name !== 'taskItem' || !node.firstChild?.isTextblock) return
            const counts = descendantCounts(node.toJSON()), id = node.attrs.id, label = node.firstChild.textContent || '未命名待办'
            widgets.push(Decoration.widget(pos + node.firstChild.nodeSize, () => {
              const actions = document.createElement('span'); actions.className = 'ln-task-actions'; actions.contentEditable = 'false'
              actions.setAttribute('role', 'group'); actions.setAttribute('aria-label', '待办内容入口')
              const go = event => { event.preventDefault(); event.stopPropagation(); if (id) onFocus(id) }
              if (counts.length) {
                const count = document.createElement('button'); count.type = 'button'; count.className = 'ln-count-badge'
                count.textContent = counts.slice(0, 3).join(' / ') + (counts.length > 3 ? ' / …' : '')
                count.title = '全部子待办：' + counts.map((n, i) => `第 ${i + 1} 层 ${n} 项`).join('，') + '；点击进入内容'
                count.setAttribute('aria-label', count.title); count.addEventListener('click', go); actions.append(count)
              }
              const enter = document.createElement('button'); enter.type = 'button'; enter.className = 'ln-icon-button ln-enter'; enter.title = '进入待办内容页'
              enter.setAttribute('aria-label', '进入待办内容页 ' + label); enter.append(createIcon('enter', 17)); enter.addEventListener('click', go); actions.append(enter)
              actions.addEventListener('mousedown', e => e.preventDefault())
              return actions
            }, { key: `${id}:${counts.join(',')}:${label}`, side: 1, stopEvent: () => true, ignoreSelection: true }))
          })
          return DecorationSet.create(state.doc, widgets)
        } },
      })]
    },
  }).configure({ nested: true })
}

function editorTagRanges(doc){const ranges=[];doc.descendants((node,pos)=>{if(!node.isTextblock||node.type.spec.code)return;let run='',start=null;const flush=()=>{if(start!==null)for(const m of tagsInText(run))ranges.push({...m,from:start+m.start,to:start+m.end});run='';start=null};node.forEach((child,offset)=>{const blocked=!child.isText||child.marks.some(m=>m.type.name==='code'||m.type.name==='link');if(blocked){flush();return}if(start===null)start=pos+1+offset;run+=child.text||''});flush();return false});return ranges}
const InlineTagHighlight=Extension.create({name:'inlineTagHighlight',addProseMirrorPlugins(){return [new Plugin({key:new PluginKey('leoInlineTags'),props:{decorations(state){return DecorationSet.create(state.doc,editorTagRanges(state.doc).map(t=>Decoration.inline(t.from,t.to,{class:'ln-inline-tag'})))}}})]}})
export function editorExtensions(onFocus = () => {}) {
  return [StarterKit.configure({ link: { openOnClick: false, protocols: ['http', 'https', 'mailto'] } }), TaskList, taskExtension(onFocus), AttachmentImage, Media, AttachmentBoundaryKeys, InlineTagHighlight]
}

export default function RichEditor({ doc, onChange, onFocus, editorRef, locateTag }) {
  const element = useRef(), callbacks = useRef({ onChange, onFocus })
  callbacks.current = { onChange, onFocus }
  useEffect(() => {
    let ready = false, fixing = false
    const editor = new Editor({
      element: element.current, extensions: editorExtensions(id => callbacks.current.onFocus(id)), content: doc,
      editorProps: {
        attributes: { class: 'ln-prose', spellcheck: 'false', 'aria-label': '笔记正文' },
        handlePaste(view, event, slice) {
          const html=event.clipboardData?.getData('text/html')||''
          if (html.includes('data-leo-attachment-id') || sliceContainsTasks(slice)) {
            event.preventDefault();view.dispatch(view.state.tr.replaceSelection(copySliceWithFreshTaskIds(slice)).scrollIntoView());return true
          }
          const files = [...(event.clipboardData?.files || [])]
          if (!files.some(file => file.type.startsWith('image/'))) return false
          event.preventDefault(); editorRef.current?.upload?.(files); return true
        },
        handleClick(view, pos, event) {
          const link = event.target?.closest?.('a')
          if (!link || link.closest('figure[data-media]')) return false
          event.preventDefault(); editor.commands.setTextSelection(pos); editorRef.openLink?.(); return true
        },
      },
      onCreate({editor}) { ready = true;if(locateTag){const found=editorTagRanges(editor.state.doc).find(t=>matchTag(t.key,locateTag));if(found)requestAnimationFrame(()=>{if(editor.isDestroyed)return;const node=editor.view.domAtPos(found.from).node;(node.nodeType===1?node:node.parentElement)?.scrollIntoView({block:'center'})})} },
      onUpdate({ editor, transaction }) {
        // A focus/selection-only transaction may append StarterKit's empty trailing
        // paragraph. That is view normalization, not a user's edit or a new draft.
        if (!ready || fixing || !transaction.docChanged) return
        const tr = editor.state.tr, ids = new Set()
        editor.state.doc.descendants((node, pos) => {
          if (node.type.name !== 'taskItem') return
          if (!node.attrs.id || ids.has(node.attrs.id)) tr.setNodeMarkup(pos, undefined, { ...node.attrs, id: crypto.randomUUID() })
          ids.add(node.attrs.id)
        })
        if (tr.docChanged) { fixing = true; editor.view.dispatch(tr.setMeta('addToHistory', false)); fixing = false }
        callbacks.current.onChange(editor.getJSON())
      },
    })
    editorRef.current = editor; editorRef.notifyReady?.(editor)
    return () => { ready = false; editorRef.notifyReady?.(null); editor.destroy(); if (editorRef.current === editor) editorRef.current = null }
  }, [])
  return <div ref={element} />
}

export function EditorToolbar({ editorRef }) {
  const [, update] = useState(0), [link, setLink] = useState(null), [error, setError] = useState('')
  const address = useRef(), originalSelection = useRef(null), originalDocument = useRef(null)
  const openLink = useCallback(() => {
    const editor = editorRef.current; if (!editor || editor.isDestroyed) return
    const selection = editor.state.selection, mark = getMarkRange(selection.$from, editor.schema.marks.link)
    const range = selection.empty && mark ? mark : { from: selection.from, to: selection.to }
    const label = editor.state.doc.textBetween(range.from, range.to, ' '), href = editor.getAttributes('link').href || ''
    originalSelection.current = range; originalDocument.current = editor.state.doc
    setLink({ label, initialLabel: label, href, existing: Boolean(href) }); setError('')
  }, [editorRef])
  useEffect(() => {
    let detach = () => {}, alive = true
    const attach = editor => {
      detach(); detach = () => {}
      if (!alive) return
      update(n => n + 1)
      if (!editor) return
      const changed = () => { if (alive) update(n => n + 1) }
      editor.on('selectionUpdate', changed); editor.on('transaction', changed)
      detach = () => { editor.off('selectionUpdate', changed); editor.off('transaction', changed) }
    }
    editorRef.notifyReady = attach; editorRef.openLink = openLink
    if (editorRef.current) attach(editorRef.current)
    return () => { alive = false; detach(); if (editorRef.notifyReady === attach) delete editorRef.notifyReady; if (editorRef.openLink === openLink) delete editorRef.openLink }
  }, [editorRef, openLink])
  useEffect(() => { if (link) address.current?.focus() }, [Boolean(link)])
  const run = (command, arg) => { const editor = editorRef.current; if (editor && !editor.isDestroyed) editor.chain().focus()[command](arg).run() }
  const closeLink = () => { setLink(null); editorRef.current?.commands.focus() }
  const applyLink = event => {
    event?.preventDefault(); const href = normalizeLinkHref(link.href), editor = editorRef.current
    if (!href) { setError('请输入 http://、https:// 或 mailto: 地址'); return }
    if (!editor || editor.isDestroyed) return
    const range = originalSelection.current
    if (!editor.state.doc.eq(originalDocument.current) || range.to > editor.state.doc.content.size) { setError('正文已变化，请重新选择链接位置'); return }
    if (!changeLink(editor.state, editor.view.dispatch, { ...range, ...link, href })) { setError('无法更新链接，请重新选择文字'); return }
    editor.commands.focus()
    setLink(null)
  }
  const removeLink = () => { const editor = editorRef.current; if (!editor || editor.isDestroyed) return; if (!editor.state.doc.eq(originalDocument.current)) { setError('正文已变化，请重新选择链接位置'); return }; changeLink(editor.state, editor.view.dispatch, { ...originalSelection.current, remove: true }); editor.commands.focus(); setLink(null) }
  const buttons = [
    ['bold', '加粗', 'toggleBold', undefined, 'bold'], ['italic', '斜体', 'toggleItalic', undefined, 'italic'],
    ['heading', '二级标题', 'toggleHeading', { level: 2 }, 'heading'], ['list', '普通列表', 'toggleBulletList', undefined, 'bulletList'],
    ['todo', '待办列表', 'toggleTaskList', undefined, 'taskList'], ['indent', '增加缩进', 'sinkListItem', 'taskItem'],
    ['outdent', '减少缩进', 'liftListItem', 'taskItem'],
  ]
  const editor = editorRef.current
  return <div className="ln-format-wrap">
    <div className="ln-format" role="toolbar" aria-label="笔记格式">
      {buttons.map(([name, label, command, arg, active]) => <button key={name} type="button" className="ln-icon-button" title={label} aria-label={label} aria-pressed={active ? Boolean(editor && !editor.isDestroyed && editor.isActive(active)) : undefined} onMouseDown={e => e.preventDefault()} onClick={() => run(command, arg)}><Icon name={name} /></button>)}
      <span className="ln-toolbar-separator" aria-hidden="true" />
      <button type="button" className="ln-icon-button" title="插入或编辑链接" aria-label="插入或编辑链接" aria-expanded={Boolean(link)} onMouseDown={e => e.preventDefault()} onClick={openLink}><Icon name="link" /></button>
      <button type="button" className="ln-icon-button" title="撤销" aria-label="撤销" onMouseDown={e => e.preventDefault()} onClick={() => run('undo')}><Icon name="undo" /></button>
      <button type="button" className="ln-icon-button" title="重做" aria-label="重做" onMouseDown={e => e.preventDefault()} onClick={() => run('redo')}><Icon name="redo" /></button>
    </div>
    {link && <section className="ln-link-popover" role="dialog" aria-label="插入或编辑链接" onKeyDown={e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeLink() } }}>
      <form onSubmit={applyLink}>
        <header><strong>链接</strong><button type="button" className="ln-icon-button" aria-label="关闭链接编辑" title="关闭" onClick={closeLink}><Icon name="x" /></button></header>
        <label>显示文字<input value={link.label} placeholder="留空时显示网址" onChange={e => setLink({ ...link, label: e.target.value })} /></label>
        <label>地址<input ref={address} type="text" inputMode="url" value={link.href} placeholder="https://… 或 mailto:…" onChange={e => setLink({ ...link, href: e.target.value })} /></label>
        {error && <p role="alert" className="ln-error">{error}</p>}
        <footer><button type="submit" className="ln-primary">保存链接</button>{link.existing && <button type="button" onClick={removeLink}><Icon name="unlink" /> 移除链接</button>}<button type="button" disabled={!normalizeLinkHref(link.href)} onClick={() => window.open(normalizeLinkHref(link.href), '_blank', 'noopener,noreferrer')}><Icon name="external" /> 打开</button></footer>
      </form>
    </section>}
  </div>
}


