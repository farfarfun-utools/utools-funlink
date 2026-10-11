// @vitest-environment jsdom
import { test, afterEach } from 'vitest'
import assert from 'node:assert/strict'
import { decryptSecret, encryptSecret } from '../src/lib/secret.ts'

afterEach(() => {
  localStorage.clear()
  delete window.utools
})

test('加密后能在同一设备上解回原文', async () => {
  window.utools = { getNativeId: () => 'device-a' }

  const token = await encryptSecret('p@ssw0rd 密码')

  assert.match(token, /^v1:/)
  assert.ok(!token.includes('p@ssw0rd'), '密文里不能出现原文')
  assert.equal(await decryptSecret(token), 'p@ssw0rd 密码')
})

test('同一个密码两次加密的结果不同', async () => {
  window.utools = { getNativeId: () => 'device-a' }

  // 盐和向量每次都换，否则同步上云的密文一眼就能看出两台设备用了同一个密码。
  assert.notEqual(await encryptSecret('same'), await encryptSecret('same'))
})

test('换到另一台设备就解不开，返回空串而不是抛错', async () => {
  window.utools = { getNativeId: () => 'device-a' }
  const token = await encryptSecret('p@ssw0rd')

  window.utools = { getNativeId: () => 'device-b' }

  assert.equal(await decryptSecret(token), '')
})

test('密文被改过一个字节也解不开', async () => {
  window.utools = { getNativeId: () => 'device-a' }
  const token = await encryptSecret('p@ssw0rd')
  const parts = token.split(':')
  // 翻掉密文最后一个 base64 字符，AES-GCM 的校验就过不了。
  parts[3] = `${parts[3].slice(0, -1)}${parts[3].endsWith('A') ? 'B' : 'A'}`

  assert.equal(await decryptSecret(parts.join(':')), '')
})

test('空值和残缺的串都安全返回空串', async () => {
  window.utools = { getNativeId: () => 'device-a' }

  assert.equal(await encryptSecret(''), '', '没有密码就不用存密文')
  assert.equal(await decryptSecret(''), '')
  assert.equal(await decryptSecret(undefined), '')
  assert.equal(await decryptSecret('v1:只有一段'), '')
  assert.equal(await decryptSecret('v2:AAAA:AAAA:AAAA'), '', '版本不认识就不去猜格式')
  assert.equal(await decryptSecret('明文密码'), '', '1.x 的明文不是密文，解不出东西来')
})

test('没有 utools 时用 localStorage 里的随机设备密钥，且只生成一次', async () => {
  const token = await encryptSecret('p@ssw0rd')
  const key = localStorage.getItem('funlink-device-key')

  assert.ok(key, '浏览器里预览也要有一把本机密钥')
  assert.equal(await decryptSecret(token), 'p@ssw0rd')
  assert.equal(localStorage.getItem('funlink-device-key'), key, '密钥不能每次重新生成，否则上一次存的密码就废了')
})
