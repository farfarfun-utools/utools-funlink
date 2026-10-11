// @vitest-environment jsdom
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { toIconDataUrl } from '../src/lib/image.ts'

// jsdom 没有 createImageBitmap，canvas 的 getContext 也返回 null，
// 所以这里把这两样换成记录调用的替身：要验的是缩放算得对不对、
// 解不开的图片有没有正确回退，而不是 Chromium 的编解码。
// 注意要 await run()：替身装在全局上，如果在被测代码跑完之前就还原，
// 画布那段会落到 jsdom 真实实现上（getContext 返回 null）。
async function withBitmap({ width, height, encoded = 'data:image/webp;base64,SHRUNK' }, run) {
  const drawn = []
  let closed = false
  const createElement = document.createElement.bind(document)
  globalThis.createImageBitmap = async () => ({ width, height, close: () => { closed = true } })
  document.createElement = tag => {
    if (tag !== 'canvas') return createElement(tag)
    return { width: 0, height: 0, getContext: () => ({ drawImage: (...args) => drawn.push(args.slice(1)) }), toDataURL: () => encoded }
  }
  try {
    return await run({ drawn, closed: () => closed })
  } finally {
    document.createElement = createElement
    delete globalThis.createImageBitmap
  }
}

test('toIconDataUrl 把大图等比缩到最大边长以内', async () => {
  await withBitmap({ width: 1024, height: 512 }, async ({ drawn }) => {
    const file = new Blob(['x'.repeat(200 * 1024)], { type: 'image/png' })
    assert.equal(await toIconDataUrl(file), 'data:image/webp;base64,SHRUNK')
    assert.deepEqual(drawn, [[0, 0, 128, 64]], '长边压到 128，短边按比例跟着缩，不能把图拉变形')
  })
})

test('toIconDataUrl 不会把小图放大', async () => {
  await withBitmap({ width: 32, height: 32 }, async ({ drawn }) => {
    // 体积超过 16KB，所以会走重新编码这条路，但尺寸应该保持原样。
    const file = new Blob(['x'.repeat(32 * 1024)], { type: 'image/png' })
    await toIconDataUrl(file)
    assert.deepEqual(drawn, [[0, 0, 32, 32]])
  })
})

test('toIconDataUrl 对本来就小的图原样保留，不做无谓的重编码', async () => {
  await withBitmap({ width: 32, height: 32 }, async ({ drawn }) => {
    const file = new Blob(['tiny-png-bytes'], { type: 'image/png' })
    const result = await toIconDataUrl(file)
    assert.deepEqual(drawn, [], '没必要动的图不该进画布——重新编码可能反而更大')
    assert.ok(result.startsWith('data:image/png;base64,'), '应该是原文件读出来的 data URL')
  })
})

test('toIconDataUrl 遇到解不开的图片（如 svg）时回退成原图，而不是报错', async () => {
  globalThis.createImageBitmap = async () => { throw new Error('unsupported source') }
  try {
    const file = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"></svg>'], { type: 'image/svg+xml' })
    const result = await toIconDataUrl(file)
    assert.ok(result.startsWith('data:image/svg+xml;base64,'), 'svg 图标应该照旧能用')
  } finally {
    delete globalThis.createImageBitmap
  }
})

test('toIconDataUrl 用完就释放位图，不把解码后的像素留在内存里', async () => {
  await withBitmap({ width: 512, height: 512 }, async ({ closed }) => {
    await toIconDataUrl(new Blob(['x'.repeat(100 * 1024)], { type: 'image/png' }))
    assert.equal(closed(), true)
  })
})

test('toIconDataUrl 把最大边长作为参数暴露出来，缩放规则可以被调用方调整', async () => {
  await withBitmap({ width: 400, height: 200 }, async ({ drawn }) => {
    await toIconDataUrl(new Blob(['x'.repeat(50 * 1024)], { type: 'image/png' }), 40)
    assert.deepEqual(drawn, [[0, 0, 40, 20]])
  })
})
