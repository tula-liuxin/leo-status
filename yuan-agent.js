/**
 * leo-status · 阿源的「完整能力」宿主端（v0.4.3）
 *
 * 阿源不再只是 `ctx.llm.stream` 的一次性问答：这里给它一个真实的 DSH Agent
 * 会话（默认 preset 的全部工具 + 与用户相同的 danger-full-access 权限），
 * 由 harness 的 agent loop 跑「模型 → 工具 → 文件 → 再回答」。
 *
 * 只依赖宿主注入的 ctx（agents/agentPresets/sessionTitle/permissionPresets），
 * 不 import 任何 @deepseek-ai/*（这些包由 DSH 运行时解析，插件包不声明依赖）。
 */
import os from 'node:os'
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { randomUUID } from 'node:crypto'

const PERSONA = [
  '你是「阿源」，Leo 的全局 todo 管家与第二大脑。',
  '你可以调用当前 harness 提供的全部工具（读文件、搜索、网页等），权限和 Leo 本人相同。',
  '原则：',
  '1. 默认不要主动扫盘或读文件；只有在回答确实需要证据、或 Leo 明确要求时才读。',
  '2. 读的时候定点、少读：先看列表/搜索定位，再读必要的那一小段。',
  '3. 回复用中文，简短（≤150 字），先结论，再 1–2 条可执行建议。',
  '4. 只基于事实；不确定就说不确定。',
  '5. 需要提议时可用标记（会被移除，Leo 可一键接受）：',
  '   <<TODO 文本>>  <<MEMORY 文本>>  <<REMINDER 文本 | 2026-10-28T09:00:00+08:00>>',
].join('\n')

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fsp.rename(temp, file)
}

function textOfBlocks(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('').trim()
}

/** 从本轮新增的 session events 里提取「回复 + 工具卡」。 */
function extractTurn(events) {
  const toolById = new Map()
  const tools = []
  const assistantTexts = []
  for (const event of events) {
    if (event === null || typeof event !== 'object') continue
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {}
    if (event.type === 'assistant/message') {
      const text = textOfBlocks(data.message?.content)
      if (text !== '') assistantTexts.push(text)
      const content = Array.isArray(data.message?.content) ? data.message.content : []
      for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'tool-call' && typeof block.name === 'string') {
          if (!toolById.has(block.id)) {
            const item = { kind: 'tool', id: block.id, name: block.name, arguments: typeof block.arguments === 'string' ? block.arguments : '' }
            toolById.set(block.id, item)
            tools.push(item)
          }
        }
      }
    } else if (event.type === 'tool/call') {
      const id = typeof data.callId === 'string' ? data.callId : String(data.callId ?? '')
      if (id !== '' && !toolById.has(id)) {
        const item = { kind: 'tool', id, name: typeof data.name === 'string' ? data.name : 'tool', arguments: typeof data.arguments === 'string' ? data.arguments : '' }
        toolById.set(id, item)
        tools.push(item)
      }
    } else if (event.type === 'tool/result') {
      const id = typeof data.message?.toolCallId === 'string' ? data.message.toolCallId : ''
      const item = id !== '' ? toolById.get(id) : undefined
      if (item !== undefined) {
        const text = textOfBlocks(data.message?.content)
        item.result = text.length > 1200 ? `${text.slice(0, 1200)}…` : text
        item.isError = data.message?.isError === true || data.error !== undefined
      }
    }
  }
  return { reply: assistantTexts.join('\n').trim(), tools }
}

/**
 * @param {object} opts
 * @param {import('@deepseek-ai/cordis').Context} opts.ctx 宿主 ctx（用于 ctx.get('agents') 等）
 * @param {string} opts.dataDir
 * @param {Function} [opts.log]
 * @param {Function} [opts.getModel] () => {provider, model, reasoningEffort?}
 */
export function createYuanAgentRuntime({ ctx, dataDir, log = () => {}, getModel = () => null } = {}) {
  const stateFile = path.join(dataDir, 'yuan', 'agent.json')
  let handle = null
  let agent = null
  let loading = null
  let lastSeq = 0
  let latestContext = ''
  let lastError = null

  function modelOptions() {
    let selection = null
    try {
      selection = typeof getModel === 'function' ? getModel() : null
    } catch {
      selection = null
    }
    if (selection === null || typeof selection !== 'object' || typeof selection.provider !== 'string' || typeof selection.model !== 'string') return {}
    return {
      provider: selection.provider,
      model: selection.model,
      ...(typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== '' ? { reasoningEffort: selection.reasoningEffort } : {}),
    }
  }

  async function setupAgent(agentCtx, agentInstance) {
    const presets = ctx.get('agentPresets')
    if (presets !== undefined && presets !== null) {
      try {
        const preset = await presets.resolve()
        if (preset !== null && preset !== undefined) await presets.mount(agentCtx, preset.id)
      } catch (error) {
        log('yuan-agent: preset mount failed:', error?.message ?? error)
      }
    }
    try {
      agentCtx.systemPrompt.section({ name: 'leo-yuan-persona', order: 300, text: PERSONA })
      agentCtx.systemPrompt.context({ name: 'leo-yuan-live-context', order: 400, text: () => latestContext })
    } catch (error) {
      log('yuan-agent: prompt setup failed:', error?.message ?? error)
    }
  }

  async function ensure() {
    if (agent !== null) return agent
    if (loading !== null) return loading
    loading = (async () => {
      const agents = ctx.get('agents')
      if (agents === undefined || agents === null || typeof agents.create !== 'function') {
        throw new Error('agents service unavailable')
      }
      const saved = await readJson(stateFile, null)
      if (saved !== null && typeof saved.sessionId === 'string' && saved.sessionId !== '') {
        const live = typeof agents.get === 'function' ? agents.get(saved.sessionId) : undefined
        if (live !== undefined && live !== null) {
          agent = live
          lastSeq = Number(live.session?.seq ?? 0) || 0
          return live
        }
        try {
          const resumed = await agents.resume({ resumeSessionId: saved.sessionId, agentOptions: modelOptions(), setup: setupAgent })
          handle = resumed
          agent = resumed.agent
          lastSeq = Number(agent.session?.seq ?? 0) || 0
          log('yuan-agent: resumed', saved.sessionId)
          return agent
        } catch (error) {
          log('yuan-agent: resume failed, creating new:', error?.message ?? error)
        }
      }
      const presets = ctx.get('agentPresets')
      let preset = null
      try {
        preset = presets !== undefined && presets !== null ? await presets.resolve() : null
      } catch (error) {
        log('yuan-agent: resolve preset failed:', error?.message ?? error)
      }
      const sessionId = `session-${randomUUID()}`
      const created = await agents.create({
        sessionId,
        agentOptions: modelOptions(),
        meta: { cwd: os.homedir(), ...(preset !== null && preset !== undefined ? { agentPreset: preset.id } : {}) },
        setup: setupAgent,
      })
      handle = created
      agent = created.agent
      lastSeq = 0
      try {
        ctx.get('sessionTitle')?.rename(agent.session, '阿源')
      } catch (error) {
        log('yuan-agent: title failed:', error?.message ?? error)
      }
      try {
        const permissionPresets = ctx.get('permissionPresets')
        if (permissionPresets !== undefined && permissionPresets !== null && typeof permissionPresets.set === 'function') {
          permissionPresets.set(agent.session, 'danger-full-access')
        }
      } catch (error) {
        log('yuan-agent: permission preset failed:', error?.message ?? error)
      }
      try {
        ctx.get('approval')?.setPolicy(agent, 'never')
      } catch {
        /* 已经是最高权限时忽略 */
      }
      await writeJsonAtomic(stateFile, { sessionId, createdAt: new Date().toISOString() })
      log('yuan-agent: created', sessionId)
      return agent
    })()
    try {
      return await loading
    } catch (error) {
      lastError = {
        message: error?.message ?? String(error),
        code: typeof error?.code === 'string' ? error.code : null,
        at: new Date().toISOString(),
      }
      try {
        await writeJsonAtomic(path.join(dataDir, 'yuan', 'agent-error.json'), lastError)
      } catch {
        /* ignore */
      }
      throw error
    } finally {
      loading = null
    }
  }

  async function chat(text, { contextText = '' } = {}) {
    latestContext = typeof contextText === 'string' ? contextText : ''
    try {
      const current = await ensure()
      lastSeq = Math.max(lastSeq, Number(current.session?.seq ?? 0) || 0)
      const message = {
        id: `msg_${randomUUID()}`,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'user' },
      }
      current.send(message, 'next-turn', true)
      await current.whenIdle()
      const all = typeof current.session?.ownEvents === 'function' ? current.session.ownEvents() : []
      const fresh = []
      for (const event of all) {
        const seq = Number(event?.seq ?? 0)
        if (seq > lastSeq) fresh.push(event)
      }
      if (fresh.length > 0) lastSeq = Number(fresh[fresh.length - 1].seq ?? lastSeq) || lastSeq
      lastError = null
      return extractTurn(fresh)
    } catch (error) {
      lastError = {
        message: error?.message ?? String(error),
        code: typeof error?.code === 'string' ? error.code : null,
        at: new Date().toISOString(),
      }
      try {
        await writeJsonAtomic(path.join(dataDir, 'yuan', 'agent-error.json'), lastError)
      } catch {
        /* ignore */
      }
      throw error
    }
  }

  return {
    ensure,
    chat,
    get sessionId() {
      return agent?.id ?? null
    },
    get lastError() {
      return lastError
    },
    async dispose() {
      try {
        await handle?.dispose?.()
      } catch {
        /* ignore */
      }
      handle = null
      agent = null
    },
  }
}
