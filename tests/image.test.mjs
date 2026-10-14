// @vitest-environment jsdom
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { bookmarkIconUrl, dataUrlToBlob, fetchSiteIcon, textIconDataUrl, toIconDataUrl } from '../src/lib/image.ts'

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

// 画「底色 + 文字」的图标只用到 2D 上下文的几个方法，这里记下调用参数就够验行为了。
function withTextCanvas(encoded, run) {
  const calls = { arc: [], text: [], colors: [], fonts: [] }
  const createElement = document.createElement.bind(document)
  document.createElement = tag => {
    if (tag !== 'canvas') return createElement(tag)
    return {
      width: 0,
      height: 0,
      getContext: () => ({
        set fillStyle(value) { calls.colors.push(value) },
        set font(value) { calls.fonts.push(value) },
        textAlign: '',
        textBaseline: '',
        beginPath() {},
        fill() {},
        arc: (...args) => calls.arc.push(args),
        fillText: (...args) => calls.text.push(args),
      }),
      toDataURL: () => encoded,
    }
  }
  try {
    return run(calls)
  } finally {
    document.createElement = createElement
  }
}

function withBridge(fetchIcon, run) {
  window.funlink = { fetchIcon }
  try {
    return run()
  } finally {
    delete window.funlink
  }
}

test('fetchSiteIcon 把 preload 抓回来的图压到 64px 再存', async () => {
  // 一个 1×1 的 png：抓回来的原图可能是 512px，存之前必须压。
  const raw = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  await withBitmap({ width: 512, height: 512 }, async ({ drawn }) => {
    const icon = await withBridge(async () => raw, () => fetchSiteIcon('https://example.com'))
    assert.equal(icon, 'data:image/webp;base64,SHRUNK')
    assert.deepEqual(drawn, [[0, 0, 64, 64]], '自动抓的图标每张卡片都有一张，比手动上传更要省体积')
  })
})

test('fetchSiteIcon 抓不到图标时返回空串，让调用方保持文字图标', async () => {
  assert.equal(await withBridge(async () => '', () => fetchSiteIcon('https://example.com')), '')
  assert.equal(await withBridge(async () => { throw new Error('超时') }, () => fetchSiteIcon('https://example.com')), '')
  // 浏览器里预览时没有 preload 桥接层。
  assert.equal(await fetchSiteIcon('https://example.com'), '')
})

test('fetchSiteIcon 丢掉压不动又太大的图标，不占掉公共的 1MB 额度', async () => {
  // svg 解不开位图，只能原样留，这时体积就得自己把关。
  globalThis.createImageBitmap = async () => { throw new Error('unsupported source') }
  try {
    const svg = `data:image/svg+xml;base64,${btoa(`<svg>${'x'.repeat(40 * 1024)}</svg>`)}`
    assert.equal(await withBridge(async () => svg, () => fetchSiteIcon('https://example.com')), '')
    const small = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg"></svg>')}`
    assert.ok((await withBridge(async () => small, () => fetchSiteIcon('https://example.com'))).startsWith('data:image/svg+xml;'))
  } finally {
    delete globalThis.createImageBitmap
  }
})

test('dataUrlToBlob 解回原始字节，解析不了的返回 null', async () => {
  const blob = dataUrlToBlob(`data:image/png;base64,${btoa('PNG-BYTES')}`)
  assert.equal(blob.type, 'image/png')
  assert.equal(await blob.text(), 'PNG-BYTES')
  assert.equal(dataUrlToBlob('https://example.com/icon.png'), null)
  assert.equal(dataUrlToBlob(''), null)
})

test('textIconDataUrl 把文字图标画成一张图，uTools 那边才有东西可显示', () => {
  withTextCanvas('data:image/png;base64,TEXTICON', calls => {
    assert.equal(textIconDataUrl('AB', '#2792ff'), 'data:image/png;base64,TEXTICON')
    assert.deepEqual(calls.arc, [[32, 32, 32, 0, Math.PI * 2]], '底色画成一个铺满画布的圆')
    assert.deepEqual(calls.text, [['AB', 32, 32]])
    assert.ok(calls.colors.includes('#2792ff'), '圆的填充色用卡片自己的底色')
  })
})

test('textIconDataUrl 字多了缩一号字号，4 个字也不会顶出圆外', () => {
  withTextCanvas('data:image/png;base64,FOUR', calls => {
    textIconDataUrl('ABCD', '#07b882')
    assert.deepEqual(calls.fonts, ['500 19px sans-serif'])
  })
  withTextCanvas('data:image/png;base64,TWO', calls => {
    textIconDataUrl('AB', '#07b882')
    assert.deepEqual(calls.fonts, ['500 28px sans-serif'])
  })
})

test('textIconDataUrl 同一个图标只画一次，主搜索框每敲一个字都要取图标', () => {
  withTextCanvas('data:image/png;base64,CACHED', calls => {
    textIconDataUrl('缓', '#ff7f1b')
    textIconDataUrl('缓', '#ff7f1b')
    assert.equal(calls.text.length, 1)
  })
  // 第二次连画布都不用建，缓存直接命中（此时替身已还原，真跑画布会拿不到上下文）。
  assert.equal(textIconDataUrl('缓', '#ff7f1b'), 'data:image/png;base64,CACHED')
})

test('bookmarkIconUrl 有图片图标就用它，文字图标现画一张', () => {
  assert.equal(bookmarkIconUrl({ iconType: 'image', iconData: 'data:image/webp;base64,SAVED' }), 'data:image/webp;base64,SAVED')
  withTextCanvas('data:image/png;base64,FROMTEXT', calls => {
    assert.equal(bookmarkIconUrl({ title: 'Hacker News', color: '#8480f9' }), 'data:image/png;base64,FROMTEXT')
    assert.deepEqual(calls.text, [['HN', 32, 32]], '没写图标文字就用标题缩写，跟卡片上显示的一致')
  })
  // 图片图标但没有图片数据（旧数据里有这种），不能渲染成空白。
  withTextCanvas('data:image/png;base64,FALLBACK', () => {
    assert.equal(bookmarkIconUrl({ title: '示例', iconType: 'image', iconData: '', icon: '示' }), 'data:image/png;base64,FALLBACK')
  })
})
