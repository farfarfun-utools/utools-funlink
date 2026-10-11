// @vitest-environment jsdom
import { test, afterEach, vi } from 'vitest'
import assert from 'node:assert/strict'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import SettingsDialog from '../src/components/SettingsDialog.vue'
import { decryptSecret } from '../src/lib/secret.ts'
import { readStorage } from '../src/lib/storage.ts'

// jsdom 不一定实现 <dialog> 的模态行为，这里只需要 open 标记跟着变。
function stubDialog() {
  HTMLDialogElement.prototype.showModal = function showModal() { this.open = true }
  HTMLDialogElement.prototype.close = function close() { this.open = false }
}

function settings() {
  return {
    browser: { isOpenIn: false, width: 1000, height: 700 },
    search: ['title'],
    importSplit: '-',
    navbar: { rounded: 36 },
  }
}

function mountDialog(props = {}) {
  stubDialog()
  return mount(SettingsDialog, { attachTo: document.body, props: { settings: settings(), ...props } })
}

async function openDataTab(wrapper) {
  wrapper.vm.open()
  await nextTick()
  await wrapper.findAll('.settings-tabs button')[1].trigger('click')
  return wrapper
}

afterEach(() => {
  localStorage.clear()
  delete window.funlink
})

test('关闭时设置没动过就不回传保存', async () => {
  const wrapper = mountDialog()
  wrapper.vm.open()
  await nextTick()
  wrapper.vm.close()

  assert.equal(wrapper.emitted('save-settings'), undefined)
})

test('改过设置再关闭才回传保存', async () => {
  const wrapper = mountDialog()
  wrapper.vm.open()
  await nextTick()
  await wrapper.find('.search-setting .check:not(.disabled) input').trigger('change')
  wrapper.vm.close()

  assert.equal(wrapper.emitted('save-settings').length, 1)
})

test('搜索范围勾选会就地改设置对象', async () => {
  const props = { settings: settings() }
  const wrapper = mountDialog(props)
  wrapper.vm.open()
  await nextTick()
  // 第一个「匹配名称」是常开且 disabled 的，取不可用之外的两项。
  const [description, url] = wrapper.findAll('.search-setting .check:not(.disabled) input')

  await description.trigger('change')
  await url.trigger('change')
  assert.deepEqual(wrapper.props('settings').search, ['title', 'description', 'url'])

  await description.trigger('change')
  assert.deepEqual(wrapper.props('settings').search, ['title', 'url'])
})

test('浏览器尺寸步进不会低于下限', async () => {
  const wrapper = mountDialog()
  wrapper.vm.open()
  await nextTick()
  const minus = wrapper.find('[aria-label="减小浏览器宽度"]')

  for (let i = 0; i < 80; i++) await minus.trigger('click')
  assert.equal(wrapper.props('settings').browser.width, 300)
})

test('没有 preload 桥接层时「从电脑还原」回落到文件选择框', async () => {
  const wrapper = await openDataTab(mountDialog())
  let clicked = 0
  wrapper.find('input[accept="application/json,.json"]').element.click = () => { clicked++ }

  await wrapper.find('.data-field:nth-of-type(2) .data-button.success').trigger('click')

  assert.equal(clicked, 1)
  assert.equal(wrapper.emitted('data-file'), undefined)
})

test('有桥接层时直接读文件内容并带上导入选项', async () => {
  window.funlink = { chooseTextFile: () => '{"version":1}' }
  const wrapper = await openDataTab(mountDialog())

  await wrapper.find('.bookmark-import .data-button.primary').trigger('click')

  const [[type, content, options]] = wrapper.emitted('data-file')
  assert.equal(type, 'import')
  assert.equal(content, '{"version":1}')
  assert.deepEqual(options, { mode: 'append', tabPosition: 'left' })
})

test('未配置 WebDav 就点备份只提示，不发请求', async () => {
  let calls = 0
  window.funlink = { webdavBackup: async () => { calls++ } }
  const wrapper = await openDataTab(mountDialog())

  await wrapper.find('.data-button.warning').trigger('click')

  assert.equal(calls, 0)
  assert.deepEqual(wrapper.emitted('message'), [['请先配置WebDav！', true]])
})

test('WebDav 列表只保留 .json 并按修改时间倒序', async () => {
  const xml = `<?xml version="1.0"?>
    <d:multistatus xmlns:d="DAV:">
      <d:response><d:href>/funlink/old.json</d:href><d:propstat><d:prop>
        <d:displayname>old.json</d:displayname><d:getcontentlength>2048</d:getcontentlength>
        <d:getlastmodified>Mon, 01 Sep 2025 10:00:00 GMT</d:getlastmodified>
      </d:prop></d:propstat></d:response>
      <d:response><d:href>/funlink/new.json</d:href><d:propstat><d:prop>
        <d:displayname>new.json</d:displayname><d:getcontentlength>4096</d:getcontentlength>
        <d:getlastmodified>Wed, 01 Oct 2025 10:00:00 GMT</d:getlastmodified>
      </d:prop></d:propstat></d:response>
      <d:response><d:href>/funlink/notes.txt</d:href><d:propstat><d:prop>
        <d:displayname>notes.txt</d:displayname><d:getcontentlength>10</d:getcontentlength>
        <d:getlastmodified>Wed, 01 Oct 2025 11:00:00 GMT</d:getlastmodified>
      </d:prop></d:propstat></d:response>
    </d:multistatus>`
  window.funlink = { webdavBackup: async () => {}, webdavList: async () => xml }
  localStorage.setItem('funlink-webdav', JSON.stringify({ host: 'https://dav.example.com', username: 'u', password: 'p' }))
  const wrapper = await openDataTab(mountDialog())
  await wrapper.find('.text-button').trigger('click')

  await wrapper.find('.data-button.success').trigger('click')

  // 读配置要先解密，链路比一个 tick 长，等到列表真的渲染出来。
  await vi.waitFor(() => {
    const names = wrapper.findAll('.webdav-file-list > div > span').map(node => node.text())
    assert.deepEqual(names, ['new.json', 'old.json'])
  })
})

test('WebDav 失败时把原因展示出来', async () => {
  window.funlink = { webdavBackup: async () => { throw new Error('401 未授权') }, webdavList: async () => '' }
  localStorage.setItem('funlink-webdav', JSON.stringify({ host: 'https://dav.example.com', username: 'u', password: 'p' }))
  window.confirm = () => true
  const wrapper = await openDataTab(mountDialog())
  await wrapper.find('.text-button').trigger('click')

  await wrapper.find('.data-button.warning').trigger('click')

  await vi.waitFor(() => assert.deepEqual(wrapper.emitted('message').at(-1), ['WebDav操作失败：401 未授权', true]))
})

test('用户取消确认时不上传备份', async () => {
  let calls = 0
  let confirmed = 0
  window.funlink = { webdavBackup: async () => { calls++ } }
  localStorage.setItem('funlink-webdav', JSON.stringify({ host: 'https://dav.example.com', username: 'u', password: 'p' }))
  window.confirm = () => { confirmed++; return false }
  const wrapper = await openDataTab(mountDialog())
  await wrapper.find('.text-button').trigger('click')

  await wrapper.find('.data-button.warning').trigger('click')

  // 先确认流程真的走到了确认这一步，否则「没上传」可能只是因为还卡在读配置。
  await vi.waitFor(() => assert.equal(confirmed, 1))
  assert.equal(calls, 0)
})

test('保存 WebDav 配置时存储里不留明文密码', async () => {
  const wrapper = await openDataTab(mountDialog())
  await wrapper.find('.text-button').trigger('click')
  await nextTick()
  await wrapper.find('.webdav-modal input[placeholder="请输入webdav服务器地址"]').setValue('https://dav.example.com')
  await wrapper.find('.webdav-modal input[type="password"]').setValue('p@ssw0rd')

  await wrapper.find('.webdav-modal form').trigger('submit')
  await vi.waitFor(() => assert.ok(readStorage('funlink-webdav', {}).secret))

  const stored = readStorage('funlink-webdav', {})
  assert.equal(stored.host, 'https://dav.example.com')
  assert.equal(stored.password, undefined, '明文字段不能再写进去')
  assert.ok(!JSON.stringify(stored).includes('p@ssw0rd'), '整条记录里都不该出现密码原文')
  assert.equal(await decryptSecret(stored.secret), 'p@ssw0rd', '本机解得开，备份时才有密码可用')
})

test('读到 1.x 的明文密码就当场换成密文', async () => {
  localStorage.setItem('funlink-webdav', JSON.stringify({ host: 'https://dav.example.com', username: 'u', password: 'p@ssw0rd' }))
  const wrapper = await openDataTab(mountDialog())

  await wrapper.find('.text-button').trigger('click')
  await vi.waitFor(() => assert.ok(readStorage('funlink-webdav', {}).secret))

  const stored = readStorage('funlink-webdav', {})
  assert.equal(stored.password, undefined, '明文要从存储里消失，不然还是会同步上云')
  assert.equal(await decryptSecret(stored.secret), 'p@ssw0rd')
  // 迁移不能把用户的密码弄丢：对话框里还填着原来那串。
  assert.equal(wrapper.find('.webdav-modal input[type="password"]').element.value, 'p@ssw0rd')
})

test('解不开的密文会提示在本机重新输入', async () => {
  localStorage.setItem('funlink-webdav', JSON.stringify({ host: 'https://dav.example.com', username: 'u', secret: 'v1:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==' }))
  const wrapper = await openDataTab(mountDialog())

  await wrapper.find('.text-button').trigger('click')

  await vi.waitFor(() => assert.deepEqual(wrapper.emitted('message').at(-1), ['WebDav 密码只保存在原设备，请在本机重新输入', true]))
})

test('没点过配置按钮也能直接备份，配置自己从存储读出来', async () => {
  let uploaded = null
  window.funlink = { webdavBackup: async config => { uploaded = config } }
  localStorage.setItem('funlink-webdav', JSON.stringify({ host: 'https://dav.example.com', username: 'u', password: 'p@ssw0rd' }))
  window.confirm = () => true
  const wrapper = await openDataTab(mountDialog())

  await wrapper.find('.data-button.warning').trigger('click')

  await vi.waitFor(() => assert.ok(uploaded, '备份请求要带着解密后的配置发出去'))
  assert.deepEqual(uploaded, { host: 'https://dav.example.com', username: 'u', password: 'p@ssw0rd' })
})

test('扫描把 4xx 和请求失败都算成无效链接', async () => {
  const bookmarks = [
    { id: 'web_1', title: '正常', url: 'https://ok.example.com' },
    { id: 'web_2', title: '不存在', url: 'https://missing.example.com' },
    { id: 'web_3', title: '连不上', url: 'https://down.example.com' },
    { id: 'web_4', title: '已删除', url: 'https://trash.example.com', deletedAt: 1 },
    { id: 'web_5', title: '站内搜索', url: 'https://search.example.com?q={q}' },
  ]
  window.funlink = {
    checkUrl: async url => {
      if (url.includes('missing')) return 404
      if (url.includes('down')) throw new Error('连接超时')
      return 200
    },
  }
  const wrapper = mountDialog({ bookmarks })
  wrapper.vm.open()
  await nextTick()

  // 废纸篓里的卡片和带 {q} 的站内搜索网址不参与扫描。
  assert.match(wrapper.find('.invalid-summary').text(), /共需检查 3 条链接/)
  await wrapper.find('.invalid-links-modal header .data-button').trigger('click')
  await nextTick()

  const rows = wrapper.findAll('.invalid-result-list > div').map(row => row.text())
  assert.equal(rows.length, 2)
  assert.ok(rows.some(text => text.includes('不存在') && text.includes('404错误')))
  assert.ok(rows.some(text => text.includes('连不上') && text.includes('连接超时')))
})

// 几百条链接挨个探活要等很久，中途必须能停下来，而且停下后在飞的请求回来时
// 不能再往结果列表里塞东西。
test('扫描可以中途停止，停掉之后在飞的结果不再入列', async () => {
  const pending = []
  const bookmarks = Array.from({ length: 12 }, (unused, index) => ({ id: `web_${index}`, title: `站点${index}`, url: `https://s${index}.example.com` }))
  window.funlink = { checkUrl: () => new Promise(resolve => { pending.push(resolve) }) }
  const wrapper = mountDialog({ bookmarks })
  wrapper.vm.open()
  await nextTick()
  const scanButton = () => wrapper.find('.invalid-links-modal header .data-button')

  await scanButton().trigger('click')
  await nextTick()
  assert.equal(pending.length, 8, '并发上限是 8')
  assert.equal(scanButton().text(), '停止扫描')

  await scanButton().trigger('click')
  await nextTick()
  assert.match(scanButton().text(), /检查/, '停下后按钮回到可以重新开始的状态')

  pending.forEach(resolve => resolve(404))
  await nextTick()
  await nextTick()
  assert.equal(wrapper.find('.invalid-result-list').exists(), false)
})

test('忽略链接后它不再参与扫描，并且写进了存储', async () => {
  const bookmarks = [{ id: 'web_1', title: '不存在', url: 'https://missing.example.com' }]
  window.funlink = { checkUrl: async () => 404 }
  const wrapper = mountDialog({ bookmarks })
  wrapper.vm.open()
  await nextTick()
  await wrapper.find('.invalid-links-modal header .data-button').trigger('click')
  await nextTick()

  await wrapper.find('.invalid-result-list > div button').trigger('click')
  await nextTick()

  assert.equal(wrapper.find('.invalid-result-list').exists(), false)
  assert.match(wrapper.find('.invalid-summary').text(), /共需检查 0 条链接/)
  assert.deepEqual(readStorage('funlink-ignore-list', []), [{ title: '不存在', url: 'https://missing.example.com' }])
})
