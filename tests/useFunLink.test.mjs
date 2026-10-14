import { test } from 'vitest'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { useFunLink } from '../src/composables/useFunLink.ts'
import { STORAGE_KEY } from '../src/lib/state.ts'

// 每次都给一份干净的空白备份当「已保存数据」，避免 useFunLink() 在没有存档时
// 回退去种示例数据（firstData.json），那样各用例之间的书签数量会互相干扰。
function emptyBackup() {
  return {
    version: 1,
    theme: 'system',
    currentView: 'inbox',
    lastCategoryId: '',
    settings: { browser: { isOpenIn: false, width: 1000, height: 680 }, search: ['title', 'description', 'url'], importSplit: '-,_,|,:,/,||', navbar: { rounded: 36 } },
    categories: [],
    bookmarks: [],
  }
}

// vitest 默认 node 环境没有 DOMParser（那是浏览器 API），parseBookmarkHtml 依赖它解析
// 浏览器书签 HTML。这里用一个只认识 <a href="...">text</a> 的最小实现代替，
// 够用来测试 processDataFile 的导入编排逻辑（去重、分类、标题拆分），
// 不重复验证真实 DOM 解析本身——那部分由运行时的浏览器/uTools 环境提供。
class FakeDomParser {
  parseFromString(html) {
    const anchors = [...html.matchAll(/<a\s+href="([^"]*)"[^>]*>([^<]*)<\/a>/g)].map(match => ({
      getAttribute: name => (name === 'href' ? match[1] : null),
      textContent: match[2],
    }))
    return { querySelectorAll: selector => (selector === 'a[href]' ? anchors : []) }
  }
}

const TEXT_ICON = 'data:image/png;base64,TEXTICON'

function withEnv({ confirm = () => true, utools = {}, funlink, seeded = emptyBackup() } = {}, run) {
  const store = new Map(seeded ? [[STORAGE_KEY, seeded]] : [])
  globalThis.DOMParser = FakeDomParser
  globalThis.window = {
    confirm,
    open: () => {},
    utools: {
      dbStorage: {
        getItem: key => (store.has(key) ? store.get(key) : null),
        setItem: (key, value) => store.set(key, value),
      },
      ...utools,
    },
    funlink,
  }
  // 用到 document 的有两处：导出备份点的那个 <a download>，以及把文字图标画成
  // 小图的 <canvas>（主搜索结果的图标只能是图片）。画得对不对由 image.test.mjs 验。
  globalThis.document = {
    documentElement: { dataset: {} },
    createElement: tag => tag === 'canvas'
      ? { width: 0, height: 0, getContext: () => ({ beginPath() {}, arc() {}, fill() {}, fillText() {} }), toDataURL: () => TEXT_ICON }
      : { click() {} },
  }
  const cleanup = () => {
    delete globalThis.window
    delete globalThis.document
    delete globalThis.DOMParser
  }
  try {
    const result = run()
    // run 可能是异步的。同步清掉 window 的话，await 之后的代码就找不到宿主了，
    // 报出来的是 ReferenceError 而不是被测逻辑真正的问题。
    if (result instanceof Promise) return result.finally(cleanup)
    cleanup()
    return result
  } catch (error) {
    cleanup()
    throw error
  }
}

test('processDataFile(restore) 恢复合法备份，并丢弃协议不安全的网址', () => {
  withEnv({}, () => {
    const api = useFunLink()
    const backup = {
      ...emptyBackup(),
      categories: [{ id: 'cat1', name: '工作', parentId: '' }],
      bookmarks: [
        { id: 'w1', title: '安全', url: 'https://example.com/', categoryId: 'cat1' },
        { id: 'w2', title: '危险', url: 'javascript:alert(1)', categoryId: 'cat1' },
      ],
    }
    const ok = api.processDataFile('restore', JSON.stringify(backup))
    assert.equal(ok, true)
    assert.deepEqual(api.state.value.bookmarks.map(bookmark => bookmark.id), ['w1'])
    assert.ok(api.toast.message.includes('跳过'), '应该提示用户有网址因为不安全被跳过')
  })
})

test('processDataFile(restore) 自动识别并转换「网址精灵」旧格式', () => {
  withEnv({}, () => {
    const api = useFunLink()
    const legacyDocs = [
      { _id: 'web_1', title: '旧书签', url: 'https://old.example.com', catIds: [] },
    ]
    const ok = api.processDataFile('restore', JSON.stringify(legacyDocs))
    assert.equal(ok, true)
    assert.equal(api.state.value.bookmarks.length, 1)
    assert.equal(api.state.value.bookmarks[0].title, '旧书签')
  })
})

// 带图片图标的备份很容易撞上 1MB 上限。这时内存里是恢复好的、存储里还是旧数据，
// 如果还报「备份已恢复」，用户关掉插件才会发现恢复没生效。
test('processDataFile(restore) 恢复后写不进存储时按失败返回并提示', () => {
  withEnv({ utools: { dbStorage: {
    getItem: key => (key === STORAGE_KEY ? emptyBackup() : null),
    setItem: () => { throw new Error('db is locked') },
  } } }, () => {
    const api = useFunLink()
    const backup = { ...emptyBackup(), bookmarks: [{ id: 'w1', title: '安全', url: 'https://example.com/' }] }
    const ok = api.processDataFile('restore', JSON.stringify(backup))
    assert.equal(ok, false)
    assert.equal(api.toast.error, true)
    assert.ok(!api.toast.message.includes('备份已恢复'))
  })
})

test('processDataFile(restore) 遇到非法 JSON 时返回 false 并提示错误，不抛异常', () => {
  withEnv({}, () => {
    const api = useFunLink()
    const ok = api.processDataFile('restore', '{not json')
    assert.equal(ok, false)
    assert.equal(api.toast.error, true)
  })
})

test('processDataFile(import) 合并模式按网址去重，替换模式清空原有数据', () => {
  withEnv({}, () => {
    const api = useFunLink()
    api.saveBookmark({ title: '已存在', url: 'https://dup.example.com/' })
    const html = '<a href="https://dup.example.com">重复</a><a href="https://new.example.com">新增</a>'

    const merged = api.processDataFile('import', html, { mode: 'merge' })
    assert.equal(merged, true)
    const urls = api.state.value.bookmarks.map(bookmark => bookmark.url)
    assert.equal(urls.filter(url => url === 'https://dup.example.com/').length, 1, '已存在的网址不应该重复导入')
    assert.ok(urls.includes('https://new.example.com/'))

    const replaced = api.processDataFile('import', '<a href="https://only.example.com">唯一</a>', { mode: 'replace' })
    assert.equal(replaced, true)
    assert.deepEqual(api.state.value.bookmarks.map(bookmark => bookmark.url), ['https://only.example.com/'])
  })
})

test('exportBackup 用户取消确认框时不会真正导出', () => {
  let saved = false
  withEnv({ confirm: () => false, funlink: { saveBackup: () => { saved = true; return true } } }, () => {
    const api = useFunLink()
    api.exportBackup()
    assert.equal(saved, false)
  })
})

test('exportBackup 导出的内容是未加密的明文 JSON', () => {
  let savedContent = null
  withEnv({ confirm: () => true, funlink: { saveBackup: content => { savedContent = content; return true } } }, () => {
    const api = useFunLink()
    api.saveBookmark({ title: '测试', url: 'https://example.com/' })
    api.exportBackup()
    assert.ok(savedContent, 'saveBackup 应该被调用')
    const parsed = JSON.parse(savedContent)
    assert.equal(parsed.bookmarks[0].title, '测试')
    assert.equal(api.toast.message, '备份已导出')
  })
})

// saveState 是所有改动落盘的唯一出口。写失败如果不提示，用户会以为已经保存了，
// 关掉插件才发现改动没了。
test('saveState 写入失败时弹出错误提示，不把失败咽下去', () => {
  withEnv({ utools: { dbStorage: {
    getItem: key => (key === STORAGE_KEY ? emptyBackup() : null),
    setItem: () => { throw new Error('db is locked') },
  } } }, () => {
    const api = useFunLink()
    api.saveBookmark({ title: '新卡片', url: 'https://example.com/' })
    assert.equal(api.toast.error, true)
    assert.ok(api.toast.message.includes('db is locked'), '提示里要带上底层原因')
    assert.ok(!api.toast.message.includes('已添加'), '成功提示不能盖掉错误提示，否则就是一次假成功')
  })
})

test('saveState 遇到超过单文档上限的数据时提示体积超限', () => {
  withEnv({ utools: { dbStorage: {
    getItem: key => (key === STORAGE_KEY ? emptyBackup() : null),
    setItem: () => {},
  } } }, () => {
    const api = useFunLink()
    // 一张没压缩的大图标就能占掉文档的四分之一，这里直接塞到超限。
    api.saveBookmark({ title: '大图标', url: 'https://example.com/', iconType: 'image', iconData: `data:image/png;base64,${'A'.repeat(1024 * 1024)}` })
    assert.equal(api.toast.error, true)
    assert.ok(api.toast.message.includes('1MB'))
  })
})

// 内置浏览器的 Cookie 在 ubrowser 会话里，不在插件数据库里。老实现删 db 里
// cookie@ 开头的文档（那是「网址精灵」的遗留文档），点了等于没点还报「已清空」。
test('clearCookies 通过 ubrowser 按源清理，不去动数据库文档', async () => {
  const cleared = []
  const removed = []
  let runOptions = null
  const chain = {
    goto: () => chain,
    clearCookies: url => { cleared.push(url); return chain },
    run: async options => { runOptions = options; return [null] },
  }
  let api
  await withEnv({ utools: { ubrowser: chain, db: { allDocs: () => [{ _id: 'cookie@legacy' }], remove: id => removed.push(id) } } }, () => {
    api = useFunLink()
    api.saveBookmark({ title: 'A', url: 'https://a.example.com/path' })
    api.saveBookmark({ title: 'A2', url: 'https://a.example.com/other' })
    api.saveBookmark({ title: 'B', url: 'http://b.example.com:8080/' })
    return api.clearCookies()
  })

  // 同一个源只清一次，端口不同算两个源。
  assert.deepEqual(cleared, ['https://a.example.com', 'http://b.example.com:8080'])
  assert.equal(runOptions.show, false, '只是借窗口执行清理队列，不该弹出来')
  assert.deepEqual(removed, [], '不该再去删 dbStorage 里的 cookie@ 文档')
  assert.equal(api.toast.error, false)
})

test('clearCookies 在没有内置浏览器时直接报错，不假装成功', async () => {
  let api
  await withEnv({ utools: {} }, () => {
    api = useFunLink()
    return api.clearCookies()
  })

  assert.equal(api.toast.error, true)
  assert.match(api.toast.message, /内置浏览器/)
})

// 一次保存就是整库全量落盘加一次云同步，空操作不该触发它。
test('saveState 内容没变时不再重复落盘', () => {
  let writes = 0
  withEnv({ utools: { dbStorage: {
    getItem: key => (key === STORAGE_KEY ? emptyBackup() : null),
    setItem: () => { writes++ },
  } } }, () => {
    const api = useFunLink()
    api.setView('all')
    const afterFirst = writes
    assert.ok(afterFirst >= 1, '第一次切换视图要落盘')

    api.setView('all')
    api.setView('all')
    assert.equal(writes, afterFirst, '重复切到同一个视图不该再写')

    api.setView('favorites')
    assert.equal(writes, afterFirst + 1, '内容真的变了还是要写')
  })
})

test('toggleQuick 会向 uTools 注册/移除快开入口', () => {
  const setCalls = []
  const removeCalls = []
  withEnv({ utools: { setFeature: feature => setCalls.push(feature), removeFeature: code => removeCalls.push(code) } }, () => {
    const api = useFunLink()
    api.saveBookmark({ id: 'w1', title: '快开', url: 'https://example.com/' })
    const bookmark = api.state.value.bookmarks[0]

    api.toggleQuick(bookmark)
    assert.equal(setCalls.length, 1)
    assert.equal(setCalls[0].code, 'open-link@w1')

    api.toggleQuick(bookmark)
    assert.ok(removeCalls.includes('open-link@w1'))
  })
})

test('openLink 对 {q} 占位符做 encodeURIComponent，正确处理中文和 & 符号', async () => {
  const opened = []
  await withEnv({ funlink: { openExternal: url => { opened.push(url); return true } } }, async () => {
    const api = useFunLink()
    api.saveBookmark({ id: 'w1', title: '搜索', url: 'https://example.com/search?q={q}' })
    const bookmark = api.state.value.bookmarks[0]
    await api.openLink(bookmark, '中文 & 符号')
    assert.equal(opened.length, 1)
    assert.ok(opened[0].includes(encodeURIComponent('中文 & 符号')), '关键词必须被正确编码')
    assert.ok(!opened[0].includes('{q}'), '占位符必须被替换掉')
  })
})

test('openLink 不会打开 javascript: 协议的网址（纵深防御）', async () => {
  const opened = []
  await withEnv({ funlink: { openExternal: url => opened.push(url) } }, async () => {
    const api = useFunLink()
    // 直接往 state 里塞一条协议不安全的脏数据，模拟绕过了 UI 层 normalizeUrl 校验的情况。
    api.state.value.bookmarks.push({
      id: 'w2', title: '恶意', url: 'javascript:alert(1)',
      categoryId: 'cat@default', categoryIds: ['cat@default'], deletedAt: null,
    })
    await api.openLink(api.state.value.bookmarks[0])
    assert.deepEqual(opened, [], 'javascript: 协议必须被拦截，不能触发打开')
  })
})

// 插件退到后台时 uTools 会收走子输入框，但插件进程还活着。搜索词不清掉的话，
// 下次进来界面停在上次的筛选结果上，而子输入框是空的，用户只会以为卡片丢了。
test('setupUtools 退出到后台时清掉搜索词和挂着的关键词对话框', async () => {
  let outHandler = null
  let subInput = null
  await withEnv({ utools: {
    setExpandHeight: () => {},
    setSubInput: onChange => { subInput = onChange },
    onPluginOut: handler => { outHandler = handler },
  } }, () => {
    const api = useFunLink()
    api.saveBookmark({ id: 'tpl', title: '站内搜索', url: 'https://example.com/s?q={q}' })
    api.setupUtools({ addBookmark: () => {} })

    // 带 {q} 的卡片没有关键词时会弹对话框，然后一直等着用户输入。
    const opening = api.openLink(api.state.value.bookmarks[0])
    assert.equal(api.keywordPrompt.visible, true)
    subInput({ text: '关键字' })
    assert.equal(api.search.value, '关键字')

    outHandler(false)
    assert.equal(api.search.value, '')
    assert.equal(api.keywordPrompt.visible, false, '对话框必须关掉，否则下次进来它还在')
    return opening
  })
})

test('setupUtools 注册的主搜索结果会排除 {q} 模板书签并限制在 6 条以内', () => {
  let searchHandler = null
  withEnv({ utools: {
    setExpandHeight: () => {},
    onMainPush: (search) => { searchHandler = search },
  } }, () => {
    const api = useFunLink()
    for (let i = 0; i < 8; i += 1) {
      api.saveBookmark({ id: `w${i}`, title: `书签${i}`, url: `https://example.com/${i}` })
    }
    api.saveBookmark({ id: 'tpl', title: '搜索模板', url: 'https://example.com/search?q={q}' })
    api.setupUtools({ addBookmark: () => {} })

    assert.equal(typeof searchHandler, 'function', 'onMainPush 应该被注册')
    const results = searchHandler({ payload: '书签' })
    assert.ok(results.length <= 6, '主搜索结果必须限制在 6 条以内')
    assert.ok(!results.some(result => result.text === '搜索模板'), '带 {q} 占位符的书签不应该出现在主搜索结果里')
  })
})

// uTools 回传的 option 只有 text（PluginEnterAction.option），挂在推送结果上的
// 自定义字段不会带回来。这条用例锁住「按回传文本找回书签」这条链路。
test('setupUtools 主搜索结果被选中后，按回传的文本找回书签并打开', () => {
  let pushHandler = null
  let selectHandler = null
  const opened = []
  withEnv({
    utools: {
      setExpandHeight: () => {},
      onMainPush: (push, select) => { pushHandler = push; selectHandler = select },
    },
    funlink: { openExternal: url => opened.push(url) },
  }, () => {
    const api = useFunLink()
    api.saveBookmark({ id: 'w1', title: '目标', url: 'https://target.example.com/' })
    api.saveBookmark({ id: 'w2', title: '别的', url: 'https://other.example.com/' })
    api.setupUtools({ addBookmark: () => {} })

    const results = pushHandler({ payload: '目标' })
    assert.deepEqual(results.map(result => result.text), ['目标'])
    assert.ok(!('bookmarkId' in results[0]), '推送结果只能带 icon/text/title，自定义字段不会被回传')

    const entered = selectHandler({ payload: '目标', option: { text: '目标' } })
    assert.notEqual(entered, true, '直接打开网址即可，不应进入插件界面')
    assert.deepEqual(opened, ['https://target.example.com/'])
  })
})

test('setupUtools 对同名卡片取最靠前的一条，选中时不会落空', () => {
  let pushHandler = null
  let selectHandler = null
  const opened = []
  withEnv({
    utools: {
      setExpandHeight: () => {},
      onMainPush: (push, select) => { pushHandler = push; selectHandler = select },
    },
    funlink: { openExternal: url => opened.push(url) },
  }, () => {
    const api = useFunLink()
    api.saveBookmark({ id: 'w1', title: '同名', url: 'https://first.example.com/' })
    api.saveBookmark({ id: 'w2', title: '同名', url: 'https://second.example.com/' })
    api.setupUtools({ addBookmark: () => {} })

    pushHandler({ payload: '同名' })
    selectHandler({ payload: '同名', option: { text: '同名' } })
    assert.deepEqual(opened, ['https://first.example.com/'])
  })
})

// 推送结果的图标原先写死成 logo.png，主搜索里所有收藏都长着同一个插件图标，
// 根本分不出谁是谁。
test('主搜索推送结果带的是卡片自己的图标', () => {
  let pushHandler = null
  withEnv({ utools: { setExpandHeight: () => {}, onMainPush: push => { pushHandler = push } } }, () => {
    const api = useFunLink()
    api.saveBookmark({ id: 'w1', title: '图片图标', url: 'https://a.example.com/', iconType: 'image', iconData: 'data:image/webp;base64,SAVED' })
    api.saveBookmark({ id: 'w2', title: '文字图标', url: 'https://b.example.com/' })
    api.setupUtools({ addBookmark: () => {} })

    const icons = new Map(pushHandler({ payload: '图标' }).map(result => [result.text, result.icon]))
    assert.equal(icons.get('图片图标'), 'data:image/webp;base64,SAVED')
    assert.equal(icons.get('文字图标'), TEXT_ICON, '文字图标要画成一张小图，不能回落成插件 logo')
  })
})

const FETCHED_ICON = 'data:image/webp;base64,FETCHED'

// 存量回填一次要写几十上百张图标，既要真的落盘，也要让快开入口跟着变。
test('applyIcons 把抓来的图标写进卡片并落盘，快开入口的图标跟着换', () => {
  const features = []
  let saved = null
  withEnv({ utools: {
    dbStorage: {
      getItem: key => (key === STORAGE_KEY ? emptyBackup() : null),
      setItem: (key, value) => { saved = value },
    },
    // uTools 的 setFeature 按 code 覆盖同名入口，替身也得这样，否则重新注册
    // 会看成新增一条，看不出图标到底换没换。
    setFeature: feature => {
      const index = features.findIndex(item => item.code === feature.code)
      if (index >= 0) features.splice(index, 1, feature)
      else features.push(feature)
    },
    removeFeature: code => {
      const index = features.findIndex(feature => feature.code === code)
      if (index >= 0) features.splice(index, 1)
      return index >= 0
    },
    getFeatures: () => features.slice(),
  } }, () => {
    const api = useFunLink()
    api.saveBookmark({ id: 'w1', title: '文档', url: 'https://doc.example.com/', quick: true })
    api.saveBookmark({ id: 'w2', title: '面板', url: 'https://panel.example.com/' })

    const ok = api.applyIcons([{ id: 'w1', iconData: FETCHED_ICON }, { id: 'w2', iconData: FETCHED_ICON }])

    assert.equal(ok, true)
    assert.deepEqual(api.state.value.bookmarks.map(bookmark => [bookmark.iconType, bookmark.iconData]), [['image', FETCHED_ICON], ['image', FETCHED_ICON]])
    assert.deepEqual(saved.bookmarks.map(bookmark => bookmark.iconData), [FETCHED_ICON, FETCHED_ICON], '要真的写进存储，不能只改内存')
    assert.deepEqual(features.map(feature => feature.icon), [FETCHED_ICON], '快开入口的图标取自卡片，换了图标得重新注册一遍')

    saved = null
    assert.equal(api.applyIcons([{ id: 'gone', iconData: FETCHED_ICON }]), true, '卡片已经被删掉的更新直接跳过')
    assert.equal(saved, null, '没有实际改动就不落盘')
  })
})

test('applyIcons 写不进存储时把这一批改回原样', () => {
  const seeded = { ...emptyBackup(), bookmarks: [{ id: 'w1', title: '文档', url: 'https://doc.example.com/', iconType: 'text', icon: 'WD' }] }
  withEnv({ utools: { dbStorage: {
    getItem: key => (key === STORAGE_KEY ? seeded : null),
    setItem: () => { throw new Error('db is locked') },
  } } }, () => {
    const api = useFunLink()

    const ok = api.applyIcons([{ id: 'w1', iconData: FETCHED_ICON }])

    assert.equal(ok, false)
    const bookmark = api.state.value.bookmarks[0]
    // 内存和存储不一致的话，后面每次保存都会带着这批图标再撞一次同样的上限。
    assert.equal(bookmark.iconType, 'text')
    assert.ok(!bookmark.iconData)
    assert.equal(api.toast.error, true)
  })
})

// AI / MCP 调用走的是另一条路，不触发进入插件事件，所以工具必须在页面初始化时注册。
function withTools(options, run) {
  const tools = new Map()
  return withEnv({
    ...options,
    utools: { setExpandHeight: () => {}, registerTool: (name, handler) => tools.set(name, handler), ...options?.utools },
  }, () => {
    const api = useFunLink()
    api.setupUtools({ addBookmark: () => {} })
    return run(api, tools)
  })
}

// 工具名和 plugin.json 的键名不一致时 uTools 找不到实现，而这种错在运行期是静默的：
// 插件照常加载，Agent 调用时才发现工具不存在。
test('注册的工具名和 plugin.json 里声明的逐字一致', () => {
  withTools({}, (api, tools) => {
    const declared = JSON.parse(readFileSync(new URL('../utools/plugin.json', import.meta.url), 'utf8')).tools
    assert.deepEqual([...tools.keys()].sort(), Object.keys(declared).sort())
    // 工具名要求小写 snake_case，而且每个都得有描述和输入结构，否则 AI 不知道怎么调。
    Object.entries(declared).forEach(([name, tool]) => {
      assert.match(name, /^[a-z][a-z\d_]*$/)
      assert.ok(tool.description, `${name} 缺少 description`)
      assert.equal(typeof tool.inputSchema, 'object')
      assert.equal(tool.inputSchema.type, 'object')
    })
  })
})

test('search_bookmarks 返回精简后的卡片，不含图标数据和笔记正文', async () => {
  await withTools({}, async (api, tools) => {
    api.saveBookmark({ title: '文档', url: 'https://doc.example.com/', description: '开发文档', iconType: 'image', iconData: 'data:image/png;base64,AAAA' })
    api.saveNote(api.state.value.bookmarks[0].id, '<p>几千字的笔记</p>')

    const result = await tools.get('search_bookmarks')({ keyword: '文档' })
    assert.equal(result.total, 1)
    assert.equal(result.bookmarks[0].title, '文档')
    assert.equal(result.bookmarks[0].hasNote, true)
    assert.ok(!('iconData' in result.bookmarks[0]), '图标数据不该挤进 AI 的上下文')
    assert.ok(!('note' in result.bookmarks[0]))
  })
})

test('add_bookmark 走界面那条保存链路，重复调用不会多出一张卡片', async () => {
  await withTools({}, async (api, tools) => {
    const created = await tools.get('add_bookmark')({ url: 'example.com', title: '示例' })
    assert.equal(created.created, true)
    assert.equal(created.bookmark.url, 'https://example.com/')
    assert.equal(api.state.value.bookmarks.length, 1)

    const again = await tools.get('add_bookmark')({ url: 'https://example.com/', title: '示例' })
    assert.equal(again.created, false, '同一个网址再调一次应该是幂等的')
    assert.equal(again.bookmark.id, created.bookmark.id)
    assert.equal(api.state.value.bookmarks.length, 1)
  })
})

// 写不进去就是没收藏成功，返回 { ok: false } 之类 Agent 多半会当成功。
test('add_bookmark 落盘失败时抛错给 Agent', async () => {
  await withTools({ utools: { dbStorage: {
    getItem: key => (key === STORAGE_KEY ? emptyBackup() : null),
    setItem: () => { throw new Error('db is locked') },
  } } }, async (api, tools) => {
    await assert.rejects(async () => tools.get('add_bookmark')({ url: 'https://example.com/' }), /没有保存成功/)
  })
})

test('open_bookmark 按 id 打开，{q} 卡片缺关键词时报错而不是挂住调用', async () => {
  const opened = []
  await withTools({ funlink: { openExternal: url => opened.push(url) } }, async (api, tools) => {
    api.saveBookmark({ id: 'w1', title: '目标', url: 'https://target.example.com/' })
    api.saveBookmark({ id: 'tpl', title: '站内搜索', url: 'https://s.example.com/?q={q}' })

    const result = await tools.get('open_bookmark')({ id: 'w1' })
    assert.deepEqual(opened, ['https://target.example.com/'])
    assert.equal(result.opened.id, 'w1')

    // 界面上这里会弹对话框等用户输入，Agent 这条路上没人回答，必须当场报错。
    await assert.rejects(() => tools.get('open_bookmark')({ id: 'tpl' }), /搜索关键词/)
    assert.equal(opened.length, 1, '报错时不该打开任何网址')

    await tools.get('open_bookmark')({ id: 'tpl', query: '关键字' })
    assert.ok(opened[1].includes(encodeURIComponent('关键字')))
  })
})

test('没有 registerTool 的环境（旧版 uTools、浏览器预览）不会报错', () => {
  withEnv({ utools: { setExpandHeight: () => {} } }, () => {
    const api = useFunLink()
    api.setupUtools({ addBookmark: () => {} })
    assert.ok(true, '注册失败不该影响插件本身启动')
  })
})

test('setupUtools 收到 files/window 这类非文本载荷时不会把它当字符串用', () => {
  let enterHandler = null
  const added = []
  withEnv({
    utools: { setExpandHeight: () => {} },
    funlink: { onEnter: callback => { enterHandler = callback } },
  }, () => {
    const api = useFunLink()
    api.setupUtools({ addBookmark: input => added.push(input) })
    assert.equal(typeof enterHandler, 'function')

    enterHandler({ code: 'add-link', type: 'files', payload: [{ name: 'a.txt', path: '/tmp/a.txt' }] })
    assert.deepEqual(added, [{ url: '' }], '非文本载荷应该回落成空串，而不是被 String() 拼成 [object Object]')
  })
})
