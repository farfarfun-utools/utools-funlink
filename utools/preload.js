const fs = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')
const { spawn } = require('child_process')

const enterQueue = []
let enterHandler = null

utools.onPluginEnter(action => {
  if (enterHandler) enterHandler(action)
  else enterQueue.push(action)
})

function openWithBrowser(url, browser) {
  if (!browser) return utools.shellOpenExternal(url)

  const platform = process.platform
  const commands = {
    darwin: {
      chrome: ['open', ['-a', 'Google Chrome']],
      'chrome-incognito': ['open', ['-a', 'Google Chrome', '--args', '--incognito']],
      edge: ['open', ['-a', 'Microsoft Edge']],
      'edge-inprivate': ['open', ['-a', 'Microsoft Edge', '--args', '--inprivate']],
      firefox: ['open', ['-a', 'Firefox']],
      safari: ['open', ['-a', 'Safari']],
    },
    linux: {
      chrome: ['google-chrome', []],
      'chrome-incognito': ['google-chrome', ['--incognito']],
      edge: ['microsoft-edge', []],
      'edge-inprivate': ['microsoft-edge', ['--inprivate']],
      firefox: ['firefox', []],
    },
    win32: {
      chrome: ['chrome', []],
      'chrome-incognito': ['chrome', ['--incognito']],
      edge: ['msedge', []],
      'edge-inprivate': ['msedge', ['--inprivate']],
      firefox: ['firefox', []],
    },
  }
  const command = commands[platform]?.[browser]
  if (!command) return utools.shellOpenExternal(url)

  try {
    const child = spawn(command[0], [...command[1], url], { detached: true, stdio: 'ignore' })
    child.once('error', () => utools.shellOpenExternal(url))
    child.unref()
  } catch {
    utools.shellOpenExternal(url)
  }
}

function requestContext(method, target) {
  const safeTarget = new URL(target)
  safeTarget.username = ''
  safeTarget.password = ''
  safeTarget.search = ''
  safeTarget.hash = ''
  return `${method} ${safeTarget.href}`
}

function requestError(context, error) {
  return new Error(`${context}: ${error.message}`, { cause: error })
}

/**
 * 发一个 HTTP(S) 请求。
 *
 * `binary` 为 true 时 body 是 Buffer（抓图标要的是原始字节，转 utf8 会把图弄坏）。
 * `maxBytes` 是响应体上限，超了之后的处理按 body 类型分：文本截断就够用
 * （抓图标只需要 HTML 的 `<head>`），而截断的二进制是一张坏图，只能当失败。
 * 解析结果带上 `url`，因为跟完重定向后相对地址要按落地的地址解析。
 */
function request(url, { method = 'GET', headers = {}, body = '', timeout = 10000, redirects = 3, allowedOrigin, binary = false, maxBytes = 0 } = {}) {
  return new Promise((resolve, reject) => {
    // 结算只认第一次。超限这条路上一次请求会被结算两回：先 destroy 再给结果，而
    // destroy 掉的请求随后还会冒一个 aborted 错误走到下面的 req.on('error')。
    // Promise 本身会忽略第二次，但那样就只能靠「反正忽略」兜着，行为也不好读；
    // 显式拦住之后，截断的文本仍然算成功，不会被 aborted 盖成失败。
    let settled = false
    const done = value => { if (!settled) { settled = true; resolve(value) } }
    const fail = error => { if (!settled) { settled = true; reject(error) } }

    let target
    try {
      target = new URL(url)
    } catch (error) {
      return fail(requestError(`${method} 无效地址`, error))
    }
    if (allowedOrigin && target.origin !== allowedOrigin) return fail(new Error(`${method} WebDAV 地址必须与配置服务器同源`))
    const context = requestContext(method, target)
    const client = target.protocol === 'https:' ? https : http
    const req = client.request(target, { method, headers }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects) {
        response.resume()
        try {
          return done(request(new URL(response.headers.location, target).href, { method, headers, body, timeout, redirects: redirects - 1, allowedOrigin, binary, maxBytes }))
        } catch (error) {
          return fail(requestError(context, error))
        }
      }
      const chunks = []
      let received = 0
      const finish = () => {
        const payload = Buffer.concat(chunks)
        if (response.statusCode >= 200 && response.statusCode < 300 || method === 'MKCOL' && response.statusCode === 405) {
          done({ status: response.statusCode, url: target.href, headers: response.headers, body: binary ? payload : payload.toString('utf8') })
        } else fail(new Error(`${context}: ${response.statusCode} ${response.statusMessage || '请求失败'}`))
      }
      response.on('data', chunk => {
        // destroy 之后缓冲区里排着的 chunk 还会送过来，结算完就别再拼了。
        if (settled) return
        chunks.push(chunk)
        received += chunk.length
        if (!maxBytes || received <= maxBytes) return
        response.destroy()
        if (binary) fail(new Error(`${context}: 响应超过 ${Math.round(maxBytes / 1024)}KB 上限`))
        else finish()
      })
      response.on('end', finish)
    })
    req.setTimeout(timeout, () => req.destroy(new Error(`${timeout / 1000}秒超时`)))
    req.on('error', error => fail(requestError(context, error)))
    if (body) req.write(body)
    req.end()
  })
}

// 抓网页图标。只请求用户收藏的那个站点本身，不经过任何第三方 favicon 服务
// （那种服务等于把用户收藏了哪些域名逐条告诉别人）。
//
// 图标声明都在 HTML 的 <head> 里，读 256KB 足够；候选图限 512KB，
// 渲染进程还会再压一遍（见 src/lib/image.ts）。
const ICON_HTML_BYTES = 256 * 1024
const ICON_BYTES = 512 * 1024
// 比 WebDAV 那条路短：这是一次「顺手」的抓取，失败就回落文字图标，不值得让用户干等。
const ICON_TIMEOUT = 6000
// 不少站点对没有 UA 的请求直接返 403。
const ICON_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; FunLink uTools plugin)',
  'Accept': 'text/html,image/*;q=0.9,*/*;q=0.8',
}
// 卡片上图标渲染为 42px，压缩后留 64px；候选图取 128px 这一档最稳：
// 再大是白下载，再小放上去发糊。
const ICON_TARGET_EDGE = 128

const LINK_TAG = /<link\b[^>]*>/gi

// 取属性的正则按属性名缓存：名字只有 rel / href / sizes 这几个固定值，
// 但每个 <link> 标签都要取三次，不缓存就是一个页面编译几十条一模一样的正则。
// 没有 g 标志，所以同一条正则反复用不会带着 lastIndex 串进下一次匹配。
const ATTRIBUTE_PATTERNS = new Map()

function attributePattern(name) {
  let pattern = ATTRIBUTE_PATTERNS.get(name)
  if (!pattern) {
    pattern = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i')
    ATTRIBUTE_PATTERNS.set(name, pattern)
  }
  return pattern
}

function attribute(tag, name) {
  const matched = tag.match(attributePattern(name))
  return matched ? (matched[1] ?? matched[2] ?? matched[3] ?? '').trim() : ''
}

/** 从 sizes="16x16 32x32" 里取最大的边长；sizes="any"（矢量图）按足够大算。 */
function largestSize(sizes) {
  if (/\bany\b/i.test(sizes)) return ICON_TARGET_EDGE
  return sizes.toLowerCase().split(/\s+/).reduce((max, item) => {
    const [width, height] = item.split('x').map(Number)
    return Number.isFinite(width) && width > 0 ? Math.max(max, width, Number.isFinite(height) ? height : 0) : max
  }, 0)
}

/** 解析 HTML 里声明的图标地址，按离目标边长的远近排好序，并在末尾补上 /favicon.ico 兜底。 */
function iconCandidates(html, pageUrl) {
  const found = []
  for (const tag of String(html).match(LINK_TAG) || []) {
    const rel = attribute(tag, 'rel').toLowerCase()
    const tokens = rel.split(/\s+/)
    if (!tokens.some(token => token === 'icon' || token.startsWith('apple-touch-icon'))) continue
    // mask-icon 是单色蒙版图，当图标用会渲染成一团纯色。
    if (tokens.includes('mask-icon')) continue
    const href = attribute(tag, 'href')
    if (!href) continue
    let resolved
    try {
      resolved = new URL(href, pageUrl)
    } catch {
      continue
    }
    if (!['http:', 'https:'].includes(resolved.protocol)) continue
    // 没写 sizes 的默认 favicon 多是 16/32，apple-touch-icon 按惯例是 180。
    const size = largestSize(attribute(tag, 'sizes')) || (rel.includes('apple-touch-icon') ? 180 : 32)
    found.push({ url: resolved.href, size })
  }
  found.sort((left, right) => Math.abs(left.size - ICON_TARGET_EDGE) - Math.abs(right.size - ICON_TARGET_EDGE))
  // 绝大多数站点都有 /favicon.ico，就算 HTML 里一个字都没声明。
  try {
    found.push({ url: new URL('/favicon.ico', pageUrl).href, size: 32 })
  } catch { /* 页面地址非法，没有兜底可补 */ }
  // 去重后只试前几张：抓图标是顺手做的事，不该为一张图把整个站点翻一遍。
  return [...new Map(found.map(item => [item.url, item])).values()].slice(0, 4)
}

// 文件头常量放模块级：每次识别都 Buffer.from 一遍是白分配，而且这几个字节是常量。
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])
const ICO_MAGIC = Buffer.from([0x00, 0x00, 0x01, 0x00])

/**
 * 按文件头认图片类型。
 * 不信 Content-Type：很多站点给 /favicon.ico 返回的是带 200 状态码的 HTML 404 页面，
 * 信了就会把一个网页存成卡片图标。
 */
function imageMime(buffer) {
  const head = buffer.subarray(0, 16)
  const ascii = offset => head.subarray(offset, offset + 4).toString('ascii')
  if (head.subarray(0, 8).equals(PNG_MAGIC)) return 'image/png'
  if (head.subarray(0, 3).equals(JPEG_MAGIC)) return 'image/jpeg'
  if (ascii(0) === 'RIFF' && ascii(8) === 'WEBP') return 'image/webp'
  if (head.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif'
  if (head.subarray(0, 4).equals(ICO_MAGIC)) return 'image/x-icon'
  // svg 是文本，没有魔数，只能看开头是不是真的 svg 标签。
  const text = buffer.subarray(0, 512).toString('utf8').trimStart().toLowerCase()
  if ((text.startsWith('<?xml') || text.startsWith('<svg')) && text.includes('<svg')) return 'image/svg+xml'
  return ''
}

async function downloadIcon(url) {
  const result = await request(url, { headers: ICON_HEADERS, timeout: ICON_TIMEOUT, binary: true, maxBytes: ICON_BYTES })
  if (!result.body.length) return ''
  const mime = imageMime(result.body)
  return mime ? `data:${mime};base64,${result.body.toString('base64')}` : ''
}

// 备份目录。历史版本沿用了原插件的中文目录名，现改为 FunLink；
// 旧备份仍留在服务器上原目录，需要时手动搬运。
const WEBDAV_DIRECTORY = 'FunLink'

function webdavTarget(config, file = '') {
  const base = new URL(config.host.endsWith('/') ? config.host : `${config.host}/`)
  return new URL(`${WEBDAV_DIRECTORY}/${file}`, base).href
}

function webdavUrl(config, target) {
  const base = new URL(config.host)
  const url = new URL(target, base)
  if (!['http:', 'https:'].includes(base.protocol) || url.origin !== base.origin) throw new Error('WebDAV 地址必须与配置服务器同源')
  return url.href
}

function webdavFileUrl(config, href) {
  const base = new URL(config.host.endsWith('/') ? config.host : `${config.host}/`)
  const directory = new URL(`${WEBDAV_DIRECTORY}/`, base)
  const target = new URL(webdavUrl(config, href))
  const pathname = decodeURIComponent(target.pathname)
  if (!pathname.startsWith(decodeURIComponent(directory.pathname)) || pathname.split('/').includes('..')) {
    throw new Error('WebDAV 文件地址不在备份目录中')
  }
  return target.href
}

function webdavRequest(config, target, options = {}) {
  const base = new URL(config.host)
  const url = webdavUrl(config, target)
  if (base.protocol !== 'https:') throw new Error('WebDAV 服务器必须使用 HTTPS')
  return request(url, { ...options, allowedOrigin: base.origin })
}

function webdavHeaders(config, extra = {}) {
  return { Authorization: `Basic ${Buffer.from(`${config.username}:${config.password}`).toString('base64')}`, ...extra }
}

window.funlink = {
  onEnter(callback) {
    enterHandler = callback
    while (enterQueue.length) callback(enterQueue.shift())
  },
  openExternal: openWithBrowser,
  saveBackup(content) {
    const destination = utools.showSaveDialog({
      title: '导出一链即达 FunLink 备份',
      defaultPath: `funlink-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (!destination) return false
    fs.writeFileSync(destination, content, 'utf8')
    return true
  },
  chooseTextFile(extensions) {
    const result = utools.showOpenDialog({ properties: ['openFile'], filters: [{ name: '数据文件', extensions }] })
    if (!result?.[0]) return null
    return fs.readFileSync(path.resolve(result[0]), 'utf8')
  },
  async webdavBackup(config, content) {
    await webdavRequest(config, webdavTarget(config), { method: 'MKCOL', headers: webdavHeaders(config) })
    const now = new Date()
    const stamp = [now.getFullYear(), now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes(), now.getSeconds()].join('-')
    await webdavRequest(config, webdavTarget(config, `${stamp}.json`), {
      method: 'PUT',
      headers: webdavHeaders(config, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(content) }),
      body: content,
    })
  },
  async webdavList(config) {
    const xml = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>'
    return (await webdavRequest(config, webdavTarget(config), {
      method: 'PROPFIND',
      headers: webdavHeaders(config, { Depth: '1', 'Content-Type': 'application/xml', 'Content-Length': Buffer.byteLength(xml) }),
      body: xml,
    })).body
  },
  async webdavRestore(config, href) {
    return (await webdavRequest(config, webdavFileUrl(config, href), { headers: webdavHeaders(config) })).body
  },
  async webdavDelete(config, href) {
    await webdavRequest(config, webdavFileUrl(config, href), { method: 'DELETE', headers: webdavHeaders(config) })
  },
  async checkUrl(url) {
    const result = await request(url, { method: 'HEAD' })
    return result.status
  },
  /**
   * 抓取网址对应站点的图标，返回 data URL；抓不到返回空串。
   * 不抛错：这是添加卡片时顺手做的事，失败就让调用方回落文字图标，不该把保存流程打断。
   */
  async fetchIcon(url) {
    let page
    try {
      page = new URL(url)
    } catch {
      return ''
    }
    if (!['http:', 'https:'].includes(page.protocol)) return ''
    // 页面打不开也还有 /favicon.ico 可以试，所以读失败不算结束。
    let html = ''
    let base = page.href
    try {
      const result = await request(page.href, { headers: ICON_HEADERS, timeout: ICON_TIMEOUT, maxBytes: ICON_HTML_BYTES })
      html = result.body
      // 相对地址要按重定向落地后的地址解析，否则 example.com -> www.example.com 这类会解错。
      base = result.url
    } catch { /* 继续走兜底候选 */ }
    for (const candidate of iconCandidates(html, base)) {
      try {
        const dataUrl = await downloadIcon(candidate.url)
        if (dataUrl) return dataUrl
      } catch { /* 这张拿不到就试下一张 */ }
    }
    return ''
  },
}
