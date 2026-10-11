import { test, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import { quickFeatureTarget, removeQuickFeature, resetQuickFeatures, syncQuickFeature } from '../src/lib/features.ts'

function fakeUtools(initial = []) {
  const features = [...initial]
  return {
    features,
    setFeature: feature => features.push(feature),
    removeFeature: code => {
      const index = features.findIndex(feature => feature.code === code)
      if (index >= 0) features.splice(index, 1)
      return index >= 0
    },
    getFeatures: () => features.slice(),
  }
}

function withUtools(utools) {
  globalThis.window = { utools }
  return utools
}

afterEach(() => {
  delete globalThis.window
})

test('开启快开的卡片按标题注册一条指令', () => {
  const utools = withUtools(fakeUtools())

  syncQuickFeature({ id: 'w1', title: '文档', url: 'https://doc.example.com/', quick: true })

  assert.deepEqual(utools.features, [{ code: 'open-link@w1', description: '打开 文档', icon: 'logo.png', mainHide: true, cmds: ['文档'] }])
})

test('带 {q} 的卡片多注册一条 over 指令，好让用户接着输关键词', () => {
  const utools = withUtools(fakeUtools())

  syncQuickFeature({ id: 'w1', title: '站内搜索', url: 'https://s.example.com/?q={q}', quick: true })

  assert.deepEqual(utools.features[0].cmds, ['站内搜索', { type: 'over', label: '站内搜索' }])
})

test('关掉快开就把入口移除', () => {
  const utools = withUtools(fakeUtools([{ code: 'open-link@w1' }]))

  syncQuickFeature({ id: 'w1', title: '文档', url: 'https://doc.example.com/', quick: false })

  assert.deepEqual(utools.features, [])
})

test('宿主没有 setFeature 时什么都不做，也不抛错', () => {
  withUtools({})

  syncQuickFeature({ id: 'w1', title: '文档', url: 'https://doc.example.com/', quick: true })
  removeQuickFeature('w1')
  resetQuickFeatures([{ id: 'w1', title: '文档', url: 'https://doc.example.com/', quick: true }])

  assert.ok(true, '浏览器里预览时没有这些 API，调用方不该为此加判断')
})

// 恢复备份、重置数据会整体换掉卡片。不先清理的话旧入口还留在 uTools 里，
// 点进去找不到对应的卡片，等于一个死入口。
test('整体替换数据时先清掉所有快开入口再按新数据注册', () => {
  const utools = withUtools(fakeUtools([
    { code: 'open-link@old1' },
    { code: 'open-link@old2' },
    { code: 'add-link' },
  ]))

  resetQuickFeatures([
    { id: 'new1', title: '新的', url: 'https://new.example.com/', quick: true },
    { id: 'new2', title: '没开快开', url: 'https://x.example.com/' },
    { id: 'new3', title: '废纸篓里的', url: 'https://y.example.com/', quick: true, deletedAt: 1 },
  ])

  assert.deepEqual(utools.features.map(feature => feature.code), ['add-link', 'open-link@new1'])
})

test('能从入口 code 还原出卡片 id，别人的 code 不认', () => {
  assert.equal(quickFeatureTarget('open-link@w1'), 'w1')
  assert.equal(quickFeatureTarget('add-link'), '')
  assert.equal(quickFeatureTarget(''), '')
})
