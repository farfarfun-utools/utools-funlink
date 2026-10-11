import { test } from 'vitest'
import assert from 'node:assert/strict'
import { commitStorage, readStorage, serializeForStorage, writeStorage } from '../src/lib/storage.ts'

function fakeLocalStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    has: key => map.has(key),
  }
}

function fakeDb(initial = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, value),
    has: key => map.has(key),
    get: key => map.get(key),
  }
}

function withEnv({ db = null, local = fakeLocalStorage() }, run) {
  globalThis.window = db ? { utools: { dbStorage: db } } : {}
  globalThis.localStorage = local
  try {
    return run()
  } finally {
    delete globalThis.window
    delete globalThis.localStorage
  }
}

test('browser preview falls back to localStorage', () => {
  const local = fakeLocalStorage()
  withEnv({ local }, () => {
    writeStorage('funlink-demo', { a: 1 })
    assert.deepEqual(readStorage('funlink-demo'), { a: 1 })
    assert.equal(readStorage('missing', 'fallback'), 'fallback')
  })
})

test('uTools reads and writes dbStorage', () => {
  const db = fakeDb()
  withEnv({ db }, () => {
    writeStorage('funlink-demo', { a: 1 })
    assert.deepEqual(db.get('funlink-demo'), { a: 1 })
    assert.deepEqual(readStorage('funlink-demo'), { a: 1 })
  })
})

test('legacy localStorage values move into dbStorage once', () => {
  const db = fakeDb()
  const local = fakeLocalStorage({ 'funlink-webdav': JSON.stringify({ host: 'https://dav.example' }) })
  withEnv({ db, local }, () => {
    assert.deepEqual(readStorage('funlink-webdav', {}), { host: 'https://dav.example' })
    // 搬完之后 dbStorage 里有了，localStorage 里清掉，避免两处数据不一致。
    assert.deepEqual(db.get('funlink-webdav'), { host: 'https://dav.example' })
    assert.equal(local.has('funlink-webdav'), false)
    assert.deepEqual(readStorage('funlink-webdav', {}), { host: 'https://dav.example' })
  })
})

test('corrupt localStorage json returns the fallback instead of throwing', () => {
  withEnv({ local: fakeLocalStorage({ broken: '{not json' }) }, () => {
    assert.deepEqual(readStorage('broken', { safe: true }), { safe: true })
  })
})

// 整库收藏压在一个 dbStorage 文档里，而 uTools 单个文档上限 1MB。
// 超限时必须让调用方知道，不能写了个 undefined 回去就当成功了。
test('writeStorage 超出单文档上限时返回失败，并且不写坏已有数据', () => {
  const db = fakeDb({ 'funlink-state-v1': { bookmarks: ['旧数据'] } })
  withEnv({ db }, () => {
    // 1MB 以上的 data URL 图标，等价于几张没压缩的图片图标。
    const huge = { bookmarks: [{ iconData: `data:image/png;base64,${'A'.repeat(1024 * 1024)}` }] }
    const result = writeStorage('funlink-state-v1', huge)
    assert.equal(result.ok, false)
    assert.ok(result.bytes > 1024 * 1024, '应该报出真实体积')
    assert.ok(result.message.includes('1MB'), '提示里要讲清是撞上了 1MB 上限')
    assert.deepEqual(db.get('funlink-state-v1'), { bookmarks: ['旧数据'] }, '写不下就该原样保留，不能把库清空')
  })
})

test('writeStorage 按字节而不是字符数判断体积', () => {
  const db = fakeDb()
  withEnv({ db }, () => {
    // 中文一个字 3 字节：40 万个汉字按 length 算才 40 万「字符」，看着没超，
    // 实际已经 120 万字节。按 length 估会把超限的数据放过去。
    const result = writeStorage('funlink-state-v1', { note: '书'.repeat(400000) })
    assert.equal(result.ok, false)
    assert.ok(result.bytes > 1024 * 1024)
  })
})

test('writeStorage 在 setItem 抛错时返回失败而不是把异常扔给调用方', () => {
  const db = fakeDb()
  db.setItem = () => { throw new Error('db is locked') }
  withEnv({ db }, () => {
    const result = writeStorage('funlink-state-v1', { a: 1 })
    assert.equal(result.ok, false)
    assert.ok(result.message.includes('db is locked'), '底层原因要带出来，方便用户反馈问题')
  })
})

test('writeStorage 写成功时返回体积，调用方可以据此提示用量', () => {
  withEnv({ db: fakeDb() }, () => {
    const result = writeStorage('funlink-state-v1', { a: 1 })
    assert.equal(result.ok, true)
    assert.equal(result.bytes, JSON.stringify({ a: 1 }).length)
  })
})

// 序列化和落盘分成两步，调用方才能拿 json 跟上次写的比一比，一样就不用再写。
test('serializeForStorage 和 commitStorage 可以分开用', () => {
  const db = fakeDb()
  withEnv({ db }, () => {
    const snapshot = serializeForStorage({ note: '书' })
    assert.equal(snapshot.json, '{"note":"书"}')
    // json 有 12 个字符，其中「书」占 3 字节，所以是 14 而不是 12。
    assert.equal(snapshot.bytes, 14, '体积要按 UTF-8 字节算')

    assert.equal(commitStorage('funlink-demo', snapshot).ok, true)
    assert.deepEqual(db.get('funlink-demo'), { note: '书' })
  })
})

test('writeStorage strips reactive proxies before persisting', () => {
  const db = fakeDb()
  withEnv({ db }, () => {
    const source = { nested: { list: [1, 2] } }
    const proxy = new Proxy(source, {})
    writeStorage('funlink-demo', proxy)
    const stored = db.get('funlink-demo')
    stored.nested.list.push(3)
    assert.deepEqual(source.nested.list, [1, 2], '写入的必须是快照，不能和原对象共享引用')
  })
})
