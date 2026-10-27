/**
 * leo-status · 本地设置（settings.json）
 *
 * 位置：<dataDir>/settings.json。dataDir 解析顺序：
 *   1. row config 的 dataDir
 *   2. 环境变量 LEO_STATUS_DATA
 *   3. 平台默认：Windows `C:\data\leo-status`，其他 `~/.local/share/leo-status`
 *
 * settings 只在本机读写，不进 git、不进插件包；密码明文保存属于“简单认证”的产品取舍，
 * 文件权限尽力收紧（Windows 下由用户目录 ACL 兜底）。
 */
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

export const SETTINGS_VERSION = 1

const DEFAULT_SYNC_INTERVAL_MS = 60_000
const DEFAULT_HUB_PORT = 8790
const DEFAULT_TUNNEL_REMOTE_PORT = 18899
const DEFAULT_TUNNEL_SSH_TARGET = 'sh'
const DEFAULT_HUB_URL = 'https://dsh.agencyarche.com/leo-status'

/** dataDir：row config → 环境变量 → 平台默认。 */
export function resolveDataDir(rowConfig = {}) {
  const configured = rowConfig && typeof rowConfig.dataDir === 'string' ? rowConfig.dataDir.trim() : ''
  if (configured !== '') return path.resolve(configured)
  const fromEnv = typeof process.env.LEO_STATUS_DATA === 'string' ? process.env.LEO_STATUS_DATA.trim() : ''
  if (fromEnv !== '') return path.resolve(fromEnv)
  return process.platform === 'win32'
    ? path.resolve('C:\\data\\leo-status')
    : path.join(os.homedir(), '.local', 'share', 'leo-status')
}

function hostName() {
  try {
    return os.hostname() || 'leo-device'
  } catch {
    return 'leo-device'
  }
}

/** 完整默认设置（中性值，不含任何个人路径/密码）。 */
export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    mode: 'local',
    deviceName: hostName(),
    markdownRoots: [],
    includeDshTodos: true,
    includeDshCompleted: false,
    syncIntervalMs: DEFAULT_SYNC_INTERVAL_MS,
    hub: {
      port: DEFAULT_HUB_PORT,
      password: '',
      tunnel: {
        enabled: true,
        sshTarget: DEFAULT_TUNNEL_SSH_TARGET,
        remotePort: DEFAULT_TUNNEL_REMOTE_PORT,
      },
    },
    device: {
      deviceId: '',
      name: hostName(),
      hubUrl: DEFAULT_HUB_URL,
      password: '',
    },
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (isPlainObject(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = clone(item)
    return out
  }
  return value
}

/** 深合并已识别的字段；未知字段保留（方便向前兼容、不丢用户手写的配置）。 */
function merge(base, patch) {
  if (!isPlainObject(patch)) return clone(base)
  const out = clone(base)
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = merge(out[key], value)
    else if (value !== undefined) out[key] = clone(value)
  }
  return out
}

/** 规整来自盘上/UI 的值，避免类型错误把插件打挂。 */
export function normalizeSettings(raw) {
  const settings = merge(defaultSettings(), isPlainObject(raw) ? raw : {})
  if (!['local', 'hub', 'device'].includes(settings.mode)) settings.mode = 'local'
  settings.deviceName = String(settings.deviceName || hostName()).slice(0, 60)
  settings.markdownRoots = Array.isArray(settings.markdownRoots)
    ? settings.markdownRoots
        .filter((root) => isPlainObject(root) && typeof root.path === 'string' && root.path.trim() !== '')
        .map((root, index) => ({
          id: typeof root.id === 'string' && root.id.trim() !== '' ? root.id.trim() : `obsidian-${index + 1}`,
          label:
            typeof root.label === 'string' && root.label.trim() !== ''
              ? root.label.trim()
              : `笔记目录 ${index + 1}`,
          path: root.path,
        }))
    : []
  settings.includeDshTodos = settings.includeDshTodos !== false
  settings.includeDshCompleted = settings.includeDshCompleted === true
  const interval = Number(settings.syncIntervalMs)
  settings.syncIntervalMs = Number.isFinite(interval) && interval >= 15_000 ? Math.min(interval, 3_600_000) : DEFAULT_SYNC_INTERVAL_MS
  settings.hub.port = Number.isInteger(settings.hub.port) && settings.hub.port > 0 && settings.hub.port < 65536 ? settings.hub.port : DEFAULT_HUB_PORT
  settings.hub.password = typeof settings.hub.password === 'string' ? settings.hub.password : ''
  settings.hub.tunnel.enabled = settings.hub.tunnel.enabled !== false
  settings.hub.tunnel.sshTarget =
    typeof settings.hub.tunnel.sshTarget === 'string' && settings.hub.tunnel.sshTarget.trim() !== ''
      ? settings.hub.tunnel.sshTarget.trim()
      : DEFAULT_TUNNEL_SSH_TARGET
  settings.hub.tunnel.remotePort =
    Number.isInteger(settings.hub.tunnel.remotePort) && settings.hub.tunnel.remotePort > 0 && settings.hub.tunnel.remotePort < 65536
      ? settings.hub.tunnel.remotePort
      : DEFAULT_TUNNEL_REMOTE_PORT
  settings.device.deviceId = typeof settings.device.deviceId === 'string' ? settings.device.deviceId.trim() : ''
  settings.device.name = String(settings.device.name || settings.deviceName).slice(0, 60)
  settings.device.hubUrl = typeof settings.device.hubUrl === 'string' ? settings.device.hubUrl : DEFAULT_HUB_URL
  settings.device.password = typeof settings.device.password === 'string' ? settings.device.password : ''
  settings.version = SETTINGS_VERSION
  return settings
}

export function settingsPath(dataDir) {
  return path.join(dataDir, 'settings.json')
}

/** 读取设置；文件不存在/损坏时返回默认值 + error 字符串（不抛）。 */
export async function loadSettings(dataDir) {
  try {
    const text = await fsp.readFile(settingsPath(dataDir), 'utf8')
    const parsed = JSON.parse(text)
    return { settings: normalizeSettings(parsed), error: null, exists: true }
  } catch (error) {
    if (error && error.code === 'ENOENT') return { settings: defaultSettings(), error: null, exists: false }
    return { settings: defaultSettings(), error: `settings.json 读取失败：${error?.message ?? error}`, exists: false }
  }
}

/** 原子写设置（.tmp + rename）。 */
export async function saveSettings(dataDir, settings) {
  const normalized = normalizeSettings(settings)
  await fsp.mkdir(dataDir, { recursive: true })
  const target = settingsPath(dataDir)
  const temp = `${target}.${process.pid}.tmp`
  const text = `${JSON.stringify(normalized, null, 2)}\n`
  await fsp.writeFile(temp, text, { mode: 0o600 })
  await fsp.rename(temp, target)
  return normalized
}

/**
 * 有效扫描配置：DEFAULTS ← row config ← settings。
 * 仅 settings 管得到的字段用 settings；其余字段以 row config 为准。
 */
export function effectiveScanConfig(rowConfig = {}, settings = defaultSettings()) {
  const base = { ...(isPlainObject(rowConfig) ? rowConfig : {}) }
  if (settings.markdownRoots.length > 0) base.markdownRoots = settings.markdownRoots
  else if (base.markdownRoots === undefined) base.markdownRoots = []
  base.includeDshTodos = settings.includeDshTodos
  base.includeDshCompleted = settings.includeDshCompleted
  return base
}
