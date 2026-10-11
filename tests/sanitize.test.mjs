// @vitest-environment jsdom
// 这组用例必须跑在真实 DOM 环境里：净化器靠 DOMParser 解析、靠 document 重建节点，
// 用假 DOM 测等于什么都没测——真正的攻击面恰恰是浏览器解析器的那些边角行为。
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { sanitizeNoteHtml } from '../src/lib/sanitize.ts'

// 把净化结果插进一个游离节点再读 innerHTML，方便直接断言结构。
function clean(input) {
  const host = document.createElement('div')
  host.appendChild(sanitizeNoteHtml(input))
  return host.innerHTML
}

test('sanitizeNoteHtml 丢掉内联事件处理器，但保留元素和文字', () => {
  const output = clean('<div onclick="alert(1)">正文<b onmouseover="alert(2)">加粗</b></div>')
  assert.equal(output, '<div>正文<b>加粗</b></div>')
})

test('sanitizeNoteHtml 丢掉 <img onerror>，连空壳都不留', () => {
  const output = clean('<p>前</p><img src="x" onerror="alert(1)"><p>后</p>')
  assert.ok(!output.includes('onerror'))
  assert.ok(!output.includes('<img'), 'src 不合法的图片应该整个丢掉，不留裂图占位')
  assert.equal(output, '<p>前</p><p>后</p>')
})

test('sanitizeNoteHtml 丢掉 <script> 及其内容', () => {
  const output = clean('<p>正文</p><script>alert(1)</script>')
  assert.equal(output, '<p>正文</p>', '脚本内容本身就是载荷，不能当文字留下来')
})

// 外来元素的 tagName 保持原始大小写（'svg' 而不是 'SVG'），所以只靠标签名匹配会漏。
test('sanitizeNoteHtml 丢掉 svg / math 这类会把解析规则带偏的外来内容', () => {
  const output = clean('<svg><script>alert(1)</script></svg><math><mtext>x</mtext></math><p>留下</p>')
  assert.equal(output, '<p>留下</p>', 'svg/math 子树要整个丢掉，不能只拆外壳把里面的内容放出来')
})

test('sanitizeNoteHtml 挡住 javascript: 链接，但把链接文字留着', () => {
  const output = clean('<a href="javascript:alert(1)">点我</a>')
  assert.equal(output, '<a>点我</a>', '链接失效好过笔记少一段话')
})

test('sanitizeNoteHtml 挡住大小写/空白混淆出来的 javascript: 链接', () => {
  for (const href of ['JaVaScRiPt:alert(1)', '  javascript:alert(1)', 'jav\tascript:alert(1)', 'data:text/html,<script>alert(1)</script>']) {
    assert.ok(!clean(`<a href="${href}">x</a>`).includes('href'), `${href} 应该被拦下来`)
  }
})

test('sanitizeNoteHtml 保留 http/https/mailto 链接并补上 rel', () => {
  assert.equal(clean('<a href="https://example.com/">站点</a>'), '<a href="https://example.com/" rel="noopener noreferrer">站点</a>')
  assert.equal(clean('<a href="mailto:a@example.com">邮件</a>'), '<a href="mailto:a@example.com" rel="noopener noreferrer">邮件</a>')
  assert.ok(clean('<a href="/relative/path">相对</a>').includes('href="/relative/path"'), '相对链接应该保持原样')
})

test('sanitizeNoteHtml 只认内嵌的位图 data URL，不向外部地址取图', () => {
  const inline = 'data:image/png;base64,iVBORw0KGgo='
  assert.equal(clean(`<img src="${inline}" alt="图">`), `<img src="${inline}" alt="图">`)
  assert.equal(clean('<img src="https://tracker.example.com/pixel.gif">'), '', '外部图片会把用户 IP 泄露给第三方')
  assert.equal(clean('<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">'), '', 'svg 图片是外来内容，一并排除')
})

test('sanitizeNoteHtml 保留编辑器自己产出的格式标签', () => {
  const input = '<p>段落</p><b>粗</b><i>斜</i><u>下划线</u><s>删除</s><ul><li>一</li><li>二</li></ul><h2>标题</h2><blockquote>引用</blockquote><pre><code>代码</code></pre><br>'
  assert.equal(clean(input), input, 'contenteditable 写出来的格式不该因为过滤而变样')
})

// 「网址精灵」的高亮带着一串 element-plus 的 CSS 变量，属性过滤会把它们清掉，
// 剩下的 <mark> 交给插件自己的 --mark-bg 上色。
test('sanitizeNoteHtml 保留导入笔记里的 <mark> 高亮，但清掉它带的样式', () => {
  const input = '<p><mark data-color="var(--el-color-danger-light-8)" style="background-color: var(--el-color-danger-light-8)">使用方法</mark>说明</p>'
  assert.equal(clean(input), '<p><mark>使用方法</mark>说明</p>')
})

test('sanitizeNoteHtml 对不认识的标签只拆外壳，不吞掉里面的文字', () => {
  assert.equal(clean('<font color="red">红字</font>'), '红字')
  assert.equal(clean('<marquee><b>滚动</b></marquee>'), '<b>滚动</b>')
})

test('sanitizeNoteHtml 丢掉 style / class 等未列入白名单的属性', () => {
  assert.equal(clean('<p style="position:fixed;inset:0" class="x" id="y" data-k="v">文字</p>'), '<p>文字</p>')
})

test('sanitizeNoteHtml 丢掉注释节点', () => {
  assert.equal(clean('<p>前</p><!-- 注释 --><p>后</p>'), '<p>前</p><p>后</p>')
})

test('sanitizeNoteHtml 遇到注释截断的构造，残留部分只会是转义后的文字', () => {
  // 返回节点而不是字符串，调用方不再走一遍 innerHTML，
  // 所以这里漏出来的 ` -->` 只能是文本，不会被二次解析成标记。
  const output = clean('<!-- --><img src=x onerror=alert(1)> --><p>正文</p>')
  assert.ok(!output.includes('onerror'))
  assert.ok(!output.includes('<img'))
  assert.ok(output.includes('--&gt;'), '残留的 --> 必须是转义后的文本')
})

test('sanitizeNoteHtml 顶住 noscript/title 这类用于绕过「序列化再解析」的 mXSS 构造', () => {
  for (const input of [
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    '<form><math><mtext></form><form><mglyph><style></math><img src onerror=alert(1)>',
    '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
  ]) {
    const output = clean(input)
    assert.ok(!output.includes('onerror'), `${input} 不该漏出事件处理器`)
    assert.ok(!output.includes('<img'), `${input} 不该漏出图片节点`)
  }
})

test('sanitizeNoteHtml 对空值和非字符串输入返回空片段，不抛异常', () => {
  for (const input of [undefined, null, '', 0, false, {}, []]) {
    assert.equal(typeof clean(input), 'string')
  }
  assert.equal(clean(undefined), '')
  assert.equal(clean(null), '')
})

test('sanitizeNoteHtml 返回的是节点片段，调用方不需要再走一遍 innerHTML', () => {
  const fragment = sanitizeNoteHtml('<p>文字</p>')
  assert.equal(fragment.nodeType, 11, '应该是 DocumentFragment')
  assert.equal(fragment.firstChild.ownerDocument, document, '节点要属于目标文档，才能直接插入')
})
