// 笔记正文是富文本，来源有三处：用户自己在编辑器里打字、恢复 FunLink 备份、
// 导入「网址精灵」备份。后两者是不可信输入——innerHTML 虽然不执行 <script>，
// 但会触发 <img src=x onerror=...> 这类内联事件处理器，而 window.funlink 可以发起
// 网络请求（WebDav 的 host 由调用方指定），足以把整库收藏静默传到任意服务器。
//
// 所以渲染前不复用原节点，而是在目标文档里按白名单重新造一棵树：
// 标签不在白名单就丢掉或拆掉，属性一律重新逐个挑选，`on*` 之类根本没有机会进来。
// 返回节点而不是字符串，调用方直接插入，省掉「序列化再 innerHTML」那一步，
// 也就避开了二次解析带来的 mXSS。

const TEXT_NODE = 3
const ELEMENT_NODE = 1

// 保留语义标签。Chromium 的 contenteditable 对 ctrl+B / I / U 产出的正是
// <b> / <i> / <u>，所以编辑器自己写出来的格式不会因为过滤而变样。
// <mark> 是「网址精灵」笔记里的高亮，本身不带需要保留的属性，放行只会多一层
// 背景色（样式见 .note-editor mark），不放行的话导入的笔记会丢掉所有高亮。
const ALLOWED_TAGS = new Set([
  'P', 'DIV', 'BR', 'SPAN', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'DEL', 'INS', 'MARK',
  'A', 'UL', 'OL', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'BLOCKQUOTE', 'CODE', 'PRE', 'HR', 'IMG',
  'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TD', 'TH',
])

// 这些标签连子节点一起丢，因为子节点就是载荷本身（script/style 的文本）。
const DROP_WITH_CONTENT = new Set([
  'SCRIPT', 'STYLE', 'IFRAME', 'FRAME', 'FRAMESET', 'OBJECT', 'EMBED', 'APPLET',
  'TEMPLATE', 'NOSCRIPT', 'LINK', 'META', 'BASE', 'TITLE',
  'FORM', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'OPTION', 'AUDIO', 'VIDEO', 'SOURCE',
])

const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'

const LINK_PROTOCOLS = new Set(['http:', 'https:', 'ftp:', 'file:', 'mailto:'])

// 只认内嵌的位图 data URL：不向外部地址取图，笔记就不会把用户 IP 暴露给第三方，
// 和插件「不往第三方发请求」的承诺保持一致。svg+xml 一并排除，不给外来内容留入口。
const IMAGE_DATA_URL = /^data:image\/(png|jpe?g|gif|webp);base64,[a-z\d+/=\s]+$/i

function safeHref(value: string | null): string {
  if (!value) return ''
  try {
    // 给一个基准地址，相对链接才能解析出协议；返回原值，保持相对形式。
    return LINK_PROTOCOLS.has(new URL(value, 'https://funlink.invalid/').protocol) ? value : ''
  } catch {
    return ''
  }
}

/**
 * 挑出某个标签允许保留的属性。没列到的全部丢弃，包含所有 on* 事件处理器。
 * 返回 null 表示这个元素留不住，整个丢掉。
 */
function keptAttributes(element: Element): [string, string][] | null {
  if (element.tagName === 'A') {
    // 协议不安全就只去掉 href，文字留着——链接失效好过笔记少一段话。
    const href = safeHref(element.getAttribute('href'))
    return href ? [['href', href], ['rel', 'noopener noreferrer']] : []
  }
  if (element.tagName === 'IMG') {
    const src = element.getAttribute('src') || ''
    // 没有合法 src 的 <img> 只会留个裂图占位，不如直接丢掉。
    if (!IMAGE_DATA_URL.test(src)) return null
    const alt = element.getAttribute('alt')
    return alt ? [['src', src], ['alt', alt]] : [['src', src]]
  }
  return []
}

function cleanChildren(source: Node, target: Node, doc: Document) {
  source.childNodes.forEach(child => {
    if (child.nodeType === TEXT_NODE) {
      target.appendChild(doc.createTextNode(child.nodeValue || ''))
      return
    }
    // 注释、处理指令等既不是文本也不是元素，直接忽略。
    if (child.nodeType !== ELEMENT_NODE) return

    const element = child as Element
    // svg / math 及其子树整个丢掉。它们会把解析规则带偏，而且外来元素的 tagName
    // 保持原始大小写（是 'svg' 不是 'SVG'），靠标签名匹配会从白名单的缝里漏过去，
    // 所以这里按命名空间判断，而不是列标签名。
    if (element.namespaceURI !== HTML_NAMESPACE) return
    if (DROP_WITH_CONTENT.has(element.tagName)) return
    if (!ALLOWED_TAGS.has(element.tagName)) {
      // 不认识的标签（<font> 之类）只拆掉自己，文字留下来，避免把笔记内容吃掉。
      cleanChildren(element, target, doc)
      return
    }

    const attributes = keptAttributes(element)
    if (!attributes) return

    const clean = doc.createElement(element.tagName.toLowerCase())
    attributes.forEach(([name, value]) => clean.setAttribute(name, value))
    cleanChildren(element, clean, doc)
    target.appendChild(clean)
  })
}

/**
 * 把不可信的笔记 HTML 重建成只含白名单标签与属性的节点片段。
 * @param html 原始 HTML
 * @param doc 片段所属文档，默认当前文档
 */
export function sanitizeNoteHtml(html: unknown, doc: Document = document): DocumentFragment {
  // DOMParser 产出的是惰性文档：不加载子资源、不执行脚本，适合用来安全地遍历。
  const parsed = new DOMParser().parseFromString(String(html ?? ''), 'text/html')
  const fragment = doc.createDocumentFragment()
  cleanChildren(parsed.body, fragment, doc)
  return fragment
}
