// @vitest-environment jsdom
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { parseWebdavList } from '../src/lib/webdav.ts'

// 真实服务端的 PROPFIND 响应。各家的命名空间前缀不一样，这里故意混用
// D: 和 lp1:，再掺一个目录项和一个非备份文件。
const XML = `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:lp1="DAV:">
  <D:response><D:href>/funlink/</D:href><D:propstat><D:prop>
    <D:displayname>funlink</D:displayname>
  </D:prop></D:propstat></D:response>
  <D:response><D:href>/funlink/old.json</D:href><D:propstat><D:prop>
    <D:displayname>old.json</D:displayname>
    <lp1:getcontentlength>2048</lp1:getcontentlength>
    <lp1:getlastmodified>Mon, 01 Sep 2025 10:00:00 GMT</lp1:getlastmodified>
  </D:prop></D:propstat></D:response>
  <D:response><D:href>/funlink/new.json</D:href><D:propstat><D:prop>
    <D:displayname>new.json</D:displayname>
    <lp1:getcontentlength>4096</lp1:getcontentlength>
    <lp1:getlastmodified>Wed, 01 Oct 2025 10:00:00 GMT</lp1:getlastmodified>
  </D:prop></D:propstat></D:response>
  <D:response><D:href>/funlink/notes.txt</D:href><D:propstat><D:prop>
    <D:displayname>notes.txt</D:displayname>
    <lp1:getlastmodified>Wed, 01 Oct 2025 11:00:00 GMT</lp1:getlastmodified>
  </D:prop></D:propstat></D:response>
</D:multistatus>`

test('只保留 .json 备份，目录和其他文件都滤掉', () => {
  const files = parseWebdavList(XML)
  assert.deepEqual(files.map(file => file.name), ['new.json', 'old.json'])
})

test('按修改时间倒序，最近备份排在最前面', () => {
  const [latest] = parseWebdavList(XML)
  assert.equal(latest.name, 'new.json')
  assert.equal(latest.size, 4096)
  assert.equal(latest.href, '/funlink/new.json')
})

test('没有 displayname 时从 href 末段取文件名，并解码百分号转义', () => {
  const files = parseWebdavList(`<multistatus xmlns="DAV:">
    <response><href>/backup/%E6%94%B6%E8%97%8F%E5%A4%B9.json</href><propstat><prop>
      <getlastmodified>Wed, 01 Oct 2025 10:00:00 GMT</getlastmodified>
    </prop></propstat></response>
  </multistatus>`)
  assert.deepEqual(files.map(file => file.name), ['收藏夹.json'])
  // 请求要用原始 href，解码后的名字只用于显示。
  assert.equal(files[0].href, '/backup/%E6%94%B6%E8%97%8F%E5%A4%B9.json')
})

test('缺 getcontentlength 时体积算 0，不出 NaN', () => {
  const [file] = parseWebdavList(`<multistatus xmlns="DAV:">
    <response><href>/a.json</href><propstat><prop><displayname>a.json</displayname></prop></propstat></response>
  </multistatus>`)
  assert.equal(file.size, 0)
})

test('空响应和非 XML 都返回空列表，不抛异常', () => {
  assert.deepEqual(parseWebdavList(''), [])
  assert.deepEqual(parseWebdavList('<html><body>404 Not Found</body></html>'), [])
})
