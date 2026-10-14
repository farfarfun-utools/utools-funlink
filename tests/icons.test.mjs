import { test } from 'vitest'
import assert from 'node:assert/strict'
import { ICON_REF_COST, ICON_RESERVE_BYTES, iconBackfillCandidates, iconBudget, iconCost, runIconBackfill } from '../src/lib/icons.ts'
import { MAX_DOC_BYTES } from '../src/lib/storage.ts'

const ICON = 'data:image/webp;base64,FETCHED'

function targets(count, host = index => `https://s${index}.example.com/`) {
  return iconBackfillCandidates(Array.from({ length: count }, (unused, index) => ({
    id: `web_${index}`, title: `站点${index}`, url: host(index),
  })))
}

// 一轮抓取的记录仪：收下每一批写入，必要时假装写失败。
function recorder({ failAt = Infinity } = {}) {
  const batches = []
  const apply = updates => {
    batches.push(updates.map(update => update.id))
    return batches.length < failAt
  }
  return { batches, apply, get applied() { return batches.flat() } }
}

test('只抓没有图标的、没在废纸篓里的 http(s) 卡片', () => {
  const found = iconBackfillCandidates([
    { id: 'web_1', title: '待抓', url: 'https://a.example.com/' },
    { id: 'web_2', title: '有图了', url: 'https://b.example.com/', iconType: 'image', iconData: 'data:image/webp;base64,MINE' },
    { id: 'web_3', title: '文字图标', url: 'https://c.example.com/', iconType: 'text', icon: 'CC' },
    { id: 'web_4', title: '废纸篓里的', url: 'https://d.example.com/', deletedAt: 1 },
    { id: 'web_5', title: '本地文件', url: 'file:///home/me/index.html' },
    { id: 'web_6', title: '没写协议', url: 'example.com' },
  ])

  assert.deepEqual(found.map(target => target.id), ['web_1', 'web_3'])
})

test('站内搜索卡片要抓，但请求的是去掉 {q} 的地址', () => {
  const [target] = iconBackfillCandidates([{ id: 'web_1', title: '站内搜索', url: 'https://s.example.com/search?q={q}' }])

  assert.equal(target.url, 'https://s.example.com/search?q={q}', '列表里展示的还是卡片上的原网址')
  assert.equal(target.requestUrl, 'https://s.example.com/search?q=', '原样请求是个无意义的地址')
})

test('重新抓一遍时带上现有图标的体积，净增量才算准', () => {
  const bookmarks = [{ id: 'web_1', title: '有图了', url: 'https://a.example.com/', iconType: 'image', iconData: ICON }]

  assert.deepEqual(iconBackfillCandidates(bookmarks, { includeExisting: true }).map(target => target.existingBytes), [iconCost(ICON)])
  assert.deepEqual(iconBackfillCandidates(bookmarks).map(target => target.id), [])
})

// 图标挪进附件之后卡片上只剩一个 ID。漏看这个字段的话，一轮回填会把整库
// 已经有图标的卡片全当成「还没有」，再白抓一遍。
test('图标存进附件的卡片也算已经有图标了', () => {
  const bookmarks = [{ id: 'web_1', title: '有图了', url: 'https://a.example.com/', iconType: 'image', iconRef: 'icon@abc-d' }]

  assert.deepEqual(iconBackfillCandidates(bookmarks).map(target => target.id), [])
  // 重抓时的净增量按文档里的占用算：这张卡片的图在附件里，文档里的那个 ID 可以忽略。
  assert.deepEqual(iconBackfillCandidates(bookmarks, { includeExisting: true }).map(target => target.existingBytes), [0])
})

test('预算是上限减去已用和预留，已经写满时是 0', () => {
  assert.equal(iconBudget(0), MAX_DOC_BYTES - ICON_RESERVE_BYTES)
  assert.equal(iconBudget(MAX_DOC_BYTES), 0, '不能返回负数，否则预算判断会全部放行')
  assert.equal(iconCost(''), 0, '没抓到的不占体积')
})

test('抓完一轮把图标分批交出去，抓不到的记进失败列表', async () => {
  const store = recorder()
  const result = await runIconBackfill({
    candidates: targets(5),
    budget: 1024 * 1024,
    fetch: async url => (url.includes('s2') ? '' : ICON),
    apply: store.apply,
    batchSize: 2,
  })

  assert.equal(result.stoppedBy, 'done')
  assert.equal(result.filled, 4)
  assert.deepEqual(store.applied.sort(), ['web_0', 'web_1', 'web_3', 'web_4'])
  assert.ok(store.batches.length > 1, '要分批落盘，不能攒到最后一次性写')
  assert.deepEqual(result.failures.map(failure => [failure.id, failure.reason]), [['web_2', '没找到图标']])
})

test('抓取抛错只记一条失败，不影响这一轮其他卡片', async () => {
  const store = recorder()
  const result = await runIconBackfill({
    candidates: targets(2),
    budget: 1024 * 1024,
    fetch: async url => { if (url.includes('s0')) throw new Error('连接超时'); return ICON },
    apply: store.apply,
  })

  assert.deepEqual(result.failures.map(failure => failure.reason), ['连接超时'])
  assert.deepEqual(store.applied, ['web_1'])
})

// 同一个域名下常有好几张卡片（首页、文档、后台），图标是同一张。
test('同一个源只真的抓一次', async () => {
  const requested = []
  const store = recorder()
  const result = await runIconBackfill({
    candidates: targets(3, index => `https://one.example.com/page${index}`),
    budget: 1024 * 1024,
    fetch: async url => { requested.push(url); return ICON },
    apply: store.apply,
  })

  assert.equal(requested.length, 1)
  assert.equal(result.filled, 3, '三张卡片都要填上这张图标')
})

// 整库收藏压在一个 1MB 的文档里。抓到装不下的那张就得停，已经抓到的留着。
test('额度用完就停下，已经抓到的照样落盘', async () => {
  const store = recorder()
  const result = await runIconBackfill({
    candidates: targets(5),
    budget: iconCost(ICON) * 2 + 10,
    fetch: async () => ICON,
    apply: store.apply,
    concurrency: 1,
    batchSize: 10,
  })

  assert.equal(result.stoppedBy, 'budget')
  assert.equal(result.filled, 2)
  assert.deepEqual(store.applied, ['web_0', 'web_1'])
})

// 图标存进附件时，文档里每张只多一个 ID。还按一张图几 KB 记账的话，
// 剩余额度看着满满的也会在第二张就喊「空间不够」。
test('记账的单价可以换成一张图一个 ID 的开销', async () => {
  // 一张 3KB 的真实图标，五张 ID 一共才 320 字节。
  const BIG_ICON = `data:image/webp;base64,${'A'.repeat(4000)}`
  const budget = ICON_REF_COST * 5 + 10
  const run = extra => runIconBackfill({
    candidates: targets(5),
    budget,
    fetch: async () => BIG_ICON,
    concurrency: 1,
    batchSize: 10,
    ...extra,
  })

  const inline = recorder()
  assert.equal((await run({ apply: inline.apply })).stoppedBy, 'budget', '内联在文档里的话这点额度连一张都放不下')
  assert.deepEqual(inline.applied, [])

  const applied = []
  const attached = recorder()
  const result = await run({
    // 落盘要先把图标写进附件，是异步的，runIconBackfill 必须等它。
    apply: async updates => { await Promise.resolve(); applied.push(...updates.map(update => update.id)); return attached.apply(updates) },
    cost: () => ICON_REF_COST,
  })

  assert.equal(result.stoppedBy, 'done')
  assert.equal(result.filled, 5)
  assert.deepEqual(applied.sort(), ['web_0', 'web_1', 'web_2', 'web_3', 'web_4'])
})

test('重新抓一遍时按新旧之差记账，额度不会被白占掉', async () => {
  const store = recorder()
  const bookmarks = Array.from({ length: 3 }, (unused, index) => ({
    id: `web_${index}`, title: `站点${index}`, url: `https://s${index}.example.com/`, iconType: 'image', iconData: ICON,
  }))
  const result = await runIconBackfill({
    // 新图标和旧的一样大，净增量是 0，再小的额度也该抓得完。
    candidates: iconBackfillCandidates(bookmarks, { includeExisting: true }),
    budget: 0,
    fetch: async () => ICON,
    apply: store.apply,
  })

  assert.equal(result.filled, 3)
  assert.equal(result.stoppedBy, 'done')
})

// 几百张卡片挨个访问网站要等好几分钟，中途必须能停，而且停下后在飞的结果
// 不能再写进卡片。
test('点了停止之后在飞的结果不再写进卡片', async () => {
  const resolvers = []
  const store = recorder()
  let stopped = false
  const run = runIconBackfill({
    candidates: targets(4),
    budget: 1024 * 1024,
    fetch: () => new Promise(resolve => { resolvers.push(resolve) }),
    apply: store.apply,
    stopped: () => stopped,
    concurrency: 2,
    batchSize: 1,
  })
  assert.equal(resolvers.length, 2, '并发上限是 2')

  stopped = true
  resolvers.forEach(resolve => resolve(ICON))
  const result = await run

  assert.equal(result.stoppedBy, 'user')
  assert.deepEqual(store.applied, [])
})

test('停止前抓到的那一批会补落盘，不至于白抓', async () => {
  const store = recorder()
  let stopped = false
  const result = await runIconBackfill({
    candidates: targets(4),
    budget: 1024 * 1024,
    // 第二张抓完就按下停止，这时第一张还攒在待写队列里。
    fetch: async url => { if (url.includes('s1')) stopped = true; return ICON },
    apply: store.apply,
    stopped: () => stopped,
    concurrency: 1,
    batchSize: 10,
  })

  assert.equal(result.stoppedBy, 'user')
  assert.deepEqual(store.applied, ['web_0'])
  assert.equal(result.filled, 1)
})

// 写不进去的话后面每一批都会撞同一个上限，再抓下去只是白跑网络请求。
test('落盘失败就立刻收工，失败的那一批不算进已填充', async () => {
  const store = recorder({ failAt: 2 })
  const result = await runIconBackfill({
    candidates: targets(6),
    budget: 1024 * 1024,
    fetch: async () => ICON,
    apply: store.apply,
    concurrency: 1,
    batchSize: 2,
  })

  assert.equal(result.stoppedBy, 'storage')
  assert.equal(result.filled, 2, '只有第一批真的写进去了')
  assert.equal(store.batches.length, 2, '第二批失败之后不再往下抓')
})
