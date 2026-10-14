interface DbStorage {
  getItem: (key: string) => unknown
  setItem: (key: string, value: unknown) => void
  removeItem?: (key: string) => void
}

export interface WriteResult {
  ok: boolean
  /** 序列化后的字节数，用来告诉用户当前体积离上限还有多远。 */
  bytes: number
  /** 失败原因，可直接拿去提示用户。 */
  message?: string
}

export interface Snapshot {
  /** 要落盘的 JSON 文本。 */
  json: string
  /** JSON 的 UTF-8 字节数。 */
  bytes: number
}

// uTools 单个数据库文档上限 1MB，超了就写不进去。留 124KB 余量给 _id/_rev
// 这些文档自带字段和编码差异，所以阈值按 900KB 算。
// 导出给批量抓图标用：那边要先算出还能塞下多少张图标（见 lib/icons.ts）。
export const MAX_DOC_BYTES = 900 * 1024

// uTools 内走 dbStorage，浏览器预览时退回 localStorage。
// 统一从这里读写，避免同一份数据一半在 dbStorage、一半在 localStorage。
function db(): DbStorage | null {
  return window.utools?.dbStorage || null
}

function readLocal(key: string, fallback: unknown) {
  try {
    const raw = localStorage.getItem(key)
    return raw == null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

/** 从 uTools dbStorage 或浏览器 localStorage 读取值。 */
export function readStorage(key: string, fallback: unknown = null): unknown {
  const store = db()
  if (!store) return readLocal(key, fallback)
  const value = store.getItem(key)
  if (value != null) return value
  // 早期版本把 WebDav 配置等写在 localStorage，这里读到就顺手搬进 dbStorage。
  const legacy = readLocal(key, null)
  if (legacy == null) return fallback
  // 搬迁写失败不影响本次读取：值已经拿到了，下次进来再搬一遍就行。
  try {
    store.setItem(key, legacy)
    localStorage.removeItem(key)
  } catch { /* 留在 localStorage 里 */ }
  return legacy
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(2)}MB` : `${Math.round(bytes / 1024)}KB`
}

/**
 * 把值序列化成待落盘的快照。
 * 和落盘分成两步，调用方才能在写之前拿 json 跟上一次写的内容比一比，
 * 一样就不用再写了——整库收藏压在一个文档里，每次写都是全量落盘加一次云同步。
 */
export function serializeForStorage(value: unknown): Snapshot {
  const json = JSON.stringify(value)
  // 必须按字节算：中文标题一个字占 3 字节，用 string.length 估会少一半以上。
  return { json, bytes: new TextEncoder().encode(json).length }
}

/**
 * 把快照写入当前运行环境的存储。
 * 返回写入结果而不是静默失败——整库收藏都压在一个文档里，
 * 写不进去而用户不知道，等于这次操作白做了。
 */
export function commitStorage(key: string, { json, bytes }: Snapshot): WriteResult {
  if (bytes > MAX_DOC_BYTES) {
    return { ok: false, bytes, message: `数据已有 ${formatBytes(bytes)}，超出 uTools 单个文档 1MB 上限，这次改动没能保存。请删掉几张图片图标或清空废纸篓后重试。` }
  }

  const store = db()
  try {
    // dbStorage 不接受 Vue 的响应式代理，解析一遍 json 得到纯对象快照。
    if (store) store.setItem(key, JSON.parse(json))
    else localStorage.setItem(key, json)
  } catch (caught) {
    return { ok: false, bytes, message: caught instanceof Error ? `保存失败：${caught.message}` : '保存失败' }
  }
  return { ok: true, bytes }
}

/** 序列化并写入存储，适用于不需要做「内容未变」判断的小块配置。 */
export function writeStorage(key: string, value: unknown): WriteResult {
  return commitStorage(key, serializeForStorage(value))
}
