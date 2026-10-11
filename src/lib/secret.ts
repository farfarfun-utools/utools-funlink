// 密码这类凭据不能明文落在 dbStorage 里：dbStorage 会被 uTools 同步到云端，
// 明文等于把密码交出去。uTools 没有提供「只存本机」或「加密存储」的接口
// （dbStorage / db 都参与同步），所以自己用设备绑定的密钥加密后再存。
const VERSION = 'v1'
// PBKDF2 迭代次数。只在打开配置和保存时各跑一次，这点开销换一次离线爆破的成本。
const ITERATIONS = 120000
const DEVICE_KEY = 'funlink-device-key'

/**
 * 取加密用的设备密钥材料。
 *
 * utools.getNativeId() 是「设备 + 插件」两个维度上的哈希：它不随数据同步上云，
 * 别的插件也拿不到同一个值，正好用来把密文锁在本机。
 * 浏览器里预览时没有这个 API，退回到 localStorage 里的一串随机数——localStorage
 * 不参与 uTools 的数据同步，留在本机就够用。
 */
function deviceSecret(): string {
  const nativeId = window.utools?.getNativeId?.()
  if (nativeId) return nativeId
  const saved = localStorage.getItem(DEVICE_KEY)
  if (saved) return saved
  const generated = toBase64(crypto.getRandomValues(new Uint8Array(32)))
  localStorage.setItem(DEVICE_KEY, generated)
  return generated
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

// 写成 Uint8Array<ArrayBuffer> 而不是 Uint8Array：后者在当前 TS 下是
// Uint8Array<ArrayBufferLike>，而 Web Crypto 的 BufferSource 不接受 SharedArrayBuffer。
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text), char => char.charCodeAt(0))
}

async function deriveKey(salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(deviceSecret()), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

/**
 * 用设备密钥加密一段文本，产出 `v1:盐:向量:密文` 形式的字符串。
 * 每次加密都换盐和向量，所以同一个密码两次加密的结果不一样。
 */
export async function encryptSecret(plain: string): Promise<string> {
  if (!plain) return ''
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await deriveKey(salt), new TextEncoder().encode(plain))
  return [VERSION, toBase64(salt), toBase64(iv), toBase64(new Uint8Array(cipher))].join(':')
}

/**
 * 解开 encryptSecret 的产物。
 * 换了设备（设备密钥不同）、密文被同步覆盖或被改过，都解不出来，这时返回空串，
 * 由调用方提示用户重新输入——解不开不是异常，是预期内的一种结果。
 */
export async function decryptSecret(token: unknown): Promise<string> {
  const [version, salt, iv, cipher] = String(token || '').split(':')
  if (version !== VERSION || !salt || !iv || !cipher) return ''
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, await deriveKey(fromBase64(salt)), fromBase64(cipher))
    return new TextDecoder().decode(plain)
  } catch {
    return ''
  }
}
