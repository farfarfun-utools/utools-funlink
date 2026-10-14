import { test } from 'vitest'
import assert from 'node:assert/strict'
import { ref } from 'vue'
import { useIconBackfill } from '../src/composables/useIconBackfill.ts'

const ICON = 'data:image/webp;base64,FETCHED'

// 抓取的编排逻辑由 icons.test.mjs 覆盖，这里只验对话框看到的那层状态：
// 进度、停下的原因、以及出错时不会一直挂在「请稍后」上。
function setup({ count = 4, fetchIcon = async () => ICON, applyIcons, bridge = true } = {}) {
  const bookmarks = Array.from({ length: count }, (unused, index) => ({
    id: `web_${index}`, title: `站点${index}`, url: `https://s${index}.example.com/`, iconType: 'text', icon: 'S',
  }))
  const state = ref({ bookmarks })
  const toasts = []
  // 没有这个桥接层就抓不了（浏览器预览里就是这种情况）。
  globalThis.window = bridge ? { funlink: { fetchIcon: async () => '' } } : {}
  const backfill = useIconBackfill({
    state,
    storageError: ref(''),
    // 默认实现照着 useFunLink.applyIcons 的样子真的写进卡片——候选列表会跟着变短，
    // 这正是进度分母不能用 candidates.length 的原因。
    applyIcons: applyIcons || (updates => {
      updates.forEach(update => {
        // 必须改 state.value 里的那份（响应式代理），直接改原数组不会触发重算，
        // 候选列表也就不会跟着变——那样测的就不是真实行为了。
        const bookmark = state.value.bookmarks.find(item => item.id === update.id)
        Object.assign(bookmark, { iconType: 'image', iconData: update.iconData })
      })
      return true
    }),
    showToast: (message, error) => toasts.push({ message, error }),
    fetchIcon,
  })
  return { backfill, bookmarks, toasts, cleanup: () => { delete globalThis.window } }
}

// 用户看到的进度一度是「已处理 10 / 90」→「已处理 20 / 70」：每落盘一批，
// 抓到图标的卡片就从候选里消失了，分母一边跑一边缩。
test('进度的分母是开跑时的总数，落盘后候选变少也不跟着缩', async () => {
  const { backfill, cleanup } = setup({ count: 4 })
  try {
    await backfill.start()

    assert.equal(backfill.total, 4)
    assert.equal(backfill.done, 4)
    assert.equal(backfill.filled, 4)
    assert.equal(backfill.percent, 100)
    assert.equal(backfill.candidates.length, 0, '抓完之后这些卡片不再是候选')
    assert.equal(backfill.running, false)
    assert.equal(backfill.finished, true)
  } finally {
    cleanup()
  }
})

test('跑的过程中能看到进度在走', async () => {
  const seen = []
  // 并发是 4，所以第 5、6 张开抓时前面已经有处理完的了。
  const { backfill, cleanup } = setup({
    count: 6,
    fetchIcon: async () => { seen.push([backfill.done, backfill.percent]); return ICON },
  })
  try {
    await backfill.start()

    // 最先发出的那几个请求还没有处理完任何一张，进度条这时要靠动画表示「在跑」。
    assert.deepEqual(seen[0], [0, 0])
    assert.ok(seen.some(([done]) => done > 0), '后面几张开抓时，前面抓完的已经计入进度')
    // 具体走到第几张取决于这几个请求的完成顺序，这里只认百分比跟着张数走。
    seen.forEach(([done, percent]) => assert.equal(percent, Math.round(done / 6 * 100)))
  } finally {
    cleanup()
  }
})

// 对话框是 showModal 开的，toast 在顶层之下会被盖住，所以这些话必须也写在
// 对话框里——否则用户点完「开始抓取」只看到一片没反应。
test('浏览器预览里没有抓取桥接层，对话框里要留下一句话', async () => {
  const { backfill, toasts, cleanup } = setup({ bridge: false })
  try {
    await backfill.start()

    assert.match(backfill.message, /不支持抓取图标/)
    assert.equal(backfill.messageError, true)
    assert.equal(backfill.running, false)
    assert.equal(toasts.length, 1, 'toast 也照样发一条，关掉对话框后还能看见')
  } finally {
    cleanup()
  }
})

test('一张都不需要抓时说清楚，而不是静悄悄', async () => {
  const { backfill, cleanup } = setup({ count: 0 })
  try {
    await backfill.start()

    assert.equal(backfill.message, '没有需要抓图标的卡片')
    assert.equal(backfill.running, false)
    assert.equal(backfill.finished, false, '没真的跑过，不该显示上一轮的结果')
  } finally {
    cleanup()
  }
})

test('冒出没想到的错时收工并说明，不会一直停在「请稍后」', async () => {
  const { backfill, cleanup } = setup({ applyIcons: () => { throw new Error('存档炸了') } })
  try {
    await backfill.start()

    assert.equal(backfill.running, false, 'running 挂在 true 上的话界面永远在转圈')
    assert.match(backfill.message, /抓取中断：存档炸了/)
    assert.equal(backfill.messageError, true)
  } finally {
    cleanup()
  }
})
