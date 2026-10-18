// WebDav 备份/还原的全部状态与流程。
//
// 从 SettingsDialog 里搬出来：那边原本把 WebDav、链接检查、批量抓图标三件事
// 和一屏设置项挤在一个文件里，五百多行。这三件事互不相干，分开之后
// 每件事的状态机（密码迁移、扫描编号、抓取进度）都能单独看、单独测。

import { reactive, ref } from 'vue'
import { decryptSecret, encryptSecret } from '../lib/secret'
import { readStorage, writeStorage } from '../lib/storage'
import { parseWebdavList, type WebDavFile } from '../lib/webdav'
import type { WebDavConfig } from '../lib/types'

const WEBDAV_KEY = 'funlink-webdav'

/** 存储里的 WebDav 配置。secret 是加密后的密码；password 是 1.x 的明文字段，只用于迁移。 */
interface StoredWebdav {
  host?: string
  username?: string
  secret?: string
  password?: string
}

export interface WebdavDeps {
  /** 往界面上报一句话，第二个参数为真表示这是错误。 */
  onMessage: (text: string, error?: boolean) => void
  /** 取当前要备份的内容。做成函数是为了点下备份那一刻才序列化。 */
  backupContent: () => string
  /** 从 WebDav 上拉回来的备份内容，交给调用方走正常的还原流程。 */
  onRestore: (content: string) => void
}

export function useWebdav({ onMessage, backupContent, onRestore }: WebdavDeps) {
  const config = reactive({ host: '', username: '', password: '' })
  const loading = ref(false)
  const files = ref<WebDavFile[]>([])

  /** catch 到的是 unknown，统一取一句能直接展示给用户的原因。 */
  function reason(caught: unknown) {
    return caught instanceof Error ? caught.message : String(caught)
  }

  /** 密码在存储里是加密的，这里只写加密后的串，内存里的明文不落盘。 */
  async function write() {
    writeStorage(WEBDAV_KEY, { host: config.host, username: config.username, secret: await encryptSecret(config.password) })
  }

  async function read() {
    // readStorage 读的是存储里的任意 JSON，这里声明期望的形状。
    const stored = readStorage(WEBDAV_KEY, {}) as StoredWebdav
    config.host = stored.host || ''
    config.username = stored.username || ''
    // 1.x 把密码明文存在 dbStorage 里，而 dbStorage 会同步上云。读到明文就当场
    // 加密重写一遍，把明文从存储里换掉。
    if (stored.password) {
      config.password = stored.password
      await write()
      return
    }
    config.password = await decryptSecret(stored.secret)
    // 密文只在加密它的那台设备上解得开。同步到新设备后解不出来，得让用户知道
    // 该重新输一次密码，而不是等点了备份才看到一句「请先配置WebDav」。
    if (stored.secret && !config.password) onMessage('WebDav 密码只保存在原设备，请在本机重新输入', true)
  }

  // 配置只读一次：解密要跑 PBKDF2，而备份、还原、打开配置框都要用到它。
  let ready: Promise<void> | null = null

  /** 确保配置已经从存储里读出来。 */
  function load(): Promise<void> {
    ready ||= read()
    return ready
  }

  async function save() {
    try {
      if (new URL(config.host).protocol !== 'https:') throw new Error('WebDAV 服务器必须使用 HTTPS')
    } catch {
      onMessage('请输入有效的 HTTPS WebDAV 地址', true)
      return
    }
    await write()
    onMessage('设置已保存！')
  }

  /**
   * 取 preload 的桥接层，取不到就提示一句。
   *
   * window.funlink 是可选属性，而这些调用点都在 await 之后用它——类型收窄撑不过
   * await，所以必须先落到局部变量再传下去，不能每次现取。
   */
  function bridge() {
    const found = window.funlink
    if (!found) onMessage('当前环境不支持 WebDav', true)
    return found
  }

  /** preload 那侧要的是能结构化克隆的纯对象，reactive 代理传不过去。 */
  function plain(): WebDavConfig {
    return { host: config.host, username: config.username, password: config.password }
  }

  /** 配置齐了没。配置是存出来的，所以不能只靠「用户这次打开过配置框」。 */
  async function configured() {
    await load()
    if (config.host && config.username && config.password) return true
    onMessage('请先配置WebDav！', true)
    return false
  }

  /** 上传一份备份。 */
  async function backup() {
    if (!await configured()) return
    const found = bridge()
    if (!found) return
    if (!window.confirm('导出内容为明文，可能包含网址、笔记和设置。确认上传到 WebDav？')) return
    loading.value = true
    try {
      await found.webdavBackup(plain(), backupContent())
      onMessage('备份到WebDav成功！')
    } catch (error) {
      onMessage(`WebDav操作失败：${reason(error)}`, true)
    } finally {
      loading.value = false
    }
  }

  /** 拉一遍备份列表，成功才返回 true——由调用方决定要不要把列表弹出来。 */
  async function loadFiles() {
    if (!await configured()) return false
    const found = bridge()
    if (!found) return false
    loading.value = true
    try {
      files.value = parseWebdavList(await found.webdavList(plain()))
      return true
    } catch (error) {
      onMessage(`WebDav操作失败：${reason(error)}`, true)
      return false
    } finally {
      loading.value = false
    }
  }

  /** 下载某份备份并交回调用方还原，返回是否成功。 */
  async function restore(file: WebDavFile) {
    const found = bridge()
    if (!found) return false
    try {
      onRestore(await found.webdavRestore(plain(), file.href))
      return true
    } catch (error) {
      onMessage(`还原失败：${reason(error)}`, true)
      return false
    }
  }

  async function remove(file: WebDavFile) {
    const found = bridge()
    if (!found) return
    try {
      await found.webdavDelete(plain(), file.href)
      files.value = files.value.filter(item => item.href !== file.href)
      onMessage('删除成功！')
    } catch (error) {
      onMessage(`删除失败：${reason(error)}`, true)
    }
  }

  return { config, loading, files, load, save, backup, loadFiles, restore, remove }
}

export type Webdav = ReturnType<typeof useWebdav>
