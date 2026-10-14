import { test } from 'vitest'
import assert from 'node:assert/strict'
import http from 'node:http'

// preload.js 在模块顶层调用 utools.onPluginEnter，必须在 import 之前先把
// 全局 utools / window 占位好，否则一加载就会因为 utools 未定义而报错。
globalThis.utools = { onPluginEnter: () => {} }
globalThis.window = {}
await import('../utools/preload.js')
const funlink = globalThis.window.funlink

function withServer(handler, run) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      run(`http://127.0.0.1:${port}`).then(resolve, reject).finally(() => server.close())
    })
  })
}

test('checkUrl 对真实 HTTP 服务返回实际状态码', async () => {
  await withServer((req, res) => { res.writeHead(204); res.end() }, async base => {
    const status = await funlink.checkUrl(`${base}/ping`)
    assert.equal(status, 204)
  })
})

test('重定向跟随到达次数上限后明确报错，而不是死循环挂起（短链/死链场景）', async () => {
  await withServer((req, res) => {
    // 自己重定向自己，制造一个无限重定向循环。
    res.writeHead(302, { Location: req.url })
    res.end()
  }, async base => {
    const start = Date.now()
    await assert.rejects(() => funlink.checkUrl(`${base}/loop`))
    // request() 默认最多跟 3 次重定向，循环应该在几次请求内就报错退出，
    // 而不是挂起等到网络层超时（10 秒）。
    assert.ok(Date.now() - start < 2000, '重定向次数耗尽应该很快报错，不应该一直挂起')
  })
})

// 最小的合法 png（1×1 透明），用来验证文件头识别和 base64 编码。
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

test('fetchIcon 读 HTML 里声明的图标，返回 data URL', async () => {
  const requested = []
  await withServer((req, res) => {
    requested.push(req.url)
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      return res.end('<html><head><link rel="apple-touch-icon" sizes="180x180" href="/touch.png"><link rel="icon" sizes="16x16" href="/small.png"></head></html>')
    }
    res.writeHead(200, { 'Content-Type': 'image/png' })
    res.end(PNG)
  }, async base => {
    const icon = await funlink.fetchIcon(`${base}/`)
    assert.equal(icon, `data:image/png;base64,${PNG.toString('base64')}`)
    // 16×16 放到卡片上会糊，应该先试尺寸更合适的那张。
    assert.deepEqual(requested, ['/', '/touch.png'])
  })
})

test('fetchIcon 在 HTML 没声明图标时回退到 /favicon.ico', async () => {
  const requested = []
  await withServer((req, res) => {
    requested.push(req.url)
    if (req.url === '/favicon.ico') {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      return res.end(PNG)
    }
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end('<html><head><title>无图标</title></head></html>')
  }, async base => {
    const icon = await funlink.fetchIcon(`${base}/page/deep`)
    assert.ok(icon.startsWith('data:image/png;base64,'))
    assert.deepEqual(requested, ['/page/deep', '/favicon.ico'])
  })
})

test('fetchIcon 不会把 200 状态码的 HTML 错误页当成图标', async () => {
  await withServer((req, res) => {
    // 很多站点就是这样处理 /favicon.ico 的：状态码 200，内容是一张网页。
    res.writeHead(200, { 'Content-Type': 'image/x-icon' })
    res.end('<!doctype html><html><body>Not Found</body></html>')
  }, async base => {
    assert.equal(await funlink.fetchIcon(`${base}/`), '')
  })
})

test('fetchIcon 跳过超过体积上限的图，不把几 MB 的图塞进存储', async () => {
  await withServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      return res.end('<html><head><link rel="icon" href="/huge.png"></head></html>')
    }
    res.writeHead(200, { 'Content-Type': 'image/png' })
    res.end(Buffer.concat([PNG, Buffer.alloc(600 * 1024)]))
  }, async base => {
    // 唯一的候选超限，/favicon.ico 兜底也落到同一个处理函数上，两张都不要。
    assert.equal(await funlink.fetchIcon(`${base}/`), '')
  })
})

test('fetchIcon 读到 HTML 上限就截断，截断的那半页仍然照常解析', async () => {
  const requested = []
  await withServer((req, res) => {
    requested.push(req.url)
    // 客户端读满 256KB 就会把响应掐掉，服务端这边的写入随后会撞到断开的连接；
    // 这是预期行为，不该让测试里的 http server 抛出来。
    res.on('error', () => {})
    req.on('error', () => {})
    if (req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      // 图标声明在 <head> 里，后面垫上远超上限的内容。
      return res.end(`<html><head><link rel="icon" href="/icon.png"></head><body>${'x'.repeat(400 * 1024)}</body></html>`)
    }
    res.writeHead(200, { 'Content-Type': 'image/png' })
    res.end(PNG)
  }, async base => {
    assert.equal(await funlink.fetchIcon(`${base}/`), `data:image/png;base64,${PNG.toString('base64')}`)
    // 掐断连接会让请求随后冒一个 aborted 错误。要是让它盖掉已经读到的内容，
    // 这里就只剩 /favicon.ico 兜底了，拿不到 /icon.png。
    assert.deepEqual(requested, ['/', '/icon.png'])
  })
})

test('fetchIcon 在页面打不开时仍然试一次 /favicon.ico', async () => {
  await withServer((req, res) => {
    if (req.url === '/favicon.ico') {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      return res.end(PNG)
    }
    res.writeHead(500)
    res.end('boom')
  }, async base => {
    assert.ok((await funlink.fetchIcon(`${base}/`)).startsWith('data:image/png;base64,'))
  })
})

test('fetchIcon 对非 http(s) 地址直接返回空串，不发请求', async () => {
  assert.equal(await funlink.fetchIcon('file:///etc/passwd'), '')
  assert.equal(await funlink.fetchIcon('不是网址'), '')
})

test('WebDAV 请求失败时，错误信息不会泄露 URL 或账号里的用户名密码', async () => {
  await withServer((req, res) => { res.writeHead(500); res.end('boom') }, async base => {
    const baseWithCreds = base.replace('http://', 'http://url-user:url-pass@')
    await assert.rejects(
      () => funlink.webdavBackup({ host: baseWithCreds, username: 'wd-user', password: 'wd-pass' }, '{}'),
      error => {
        assert.ok(!error.message.includes('url-user'), `错误信息泄露了 URL 里的用户名: ${error.message}`)
        assert.ok(!error.message.includes('url-pass'), `错误信息泄露了 URL 里的密码: ${error.message}`)
        return true
      },
    )
  })
})

test('webdavList 正常返回服务端响应的原始内容', async () => {
  const body = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:"></d:multistatus>'
  await withServer((req, res) => {
    assert.equal(req.method, 'PROPFIND')
    res.writeHead(207, { 'Content-Type': 'application/xml' })
    res.end(body)
  }, async base => {
    const result = await funlink.webdavList({ host: base, username: 'u', password: 'p' })
    assert.equal(result, body)
  })
})

test('WebDAV 跨源重定向不会转发认证请求', async () => {
  let redirectedRequest = false
  await withServer((targetReq, targetRes) => {
    redirectedRequest = true
    targetRes.writeHead(204)
    targetRes.end()
  }, async target => {
    await withServer((redirectReq, redirectRes) => {
      redirectRes.writeHead(302, { Location: target })
      redirectRes.end()
    }, async base => {
      await assert.rejects(
        () => funlink.webdavBackup({ host: base, username: 'u', password: 'p' }, '{}'),
        /必须与配置服务器同源/,
      )
      assert.equal(redirectedRequest, false)
    })
  })
})

test('WebDAV 服务端返回的跨源 href 不会携带认证访问', async () => {
  let targetRequest = false
  await withServer((targetReq, targetRes) => {
    targetRequest = true
    targetRes.writeHead(204)
    targetRes.end()
  }, async target => {
    await withServer((sourceReq, sourceRes) => {
      sourceRes.writeHead(204)
      sourceRes.end()
    }, async base => {
      await assert.rejects(
        () => funlink.webdavRestore({ host: base, username: 'u', password: 'p' }, `${target}/backup.json`),
        /必须与配置服务器同源/,
      )
      assert.equal(targetRequest, false)
    })
  })
})
