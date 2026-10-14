// data URL 和原始字节之间的互转。
//
// 图标在三个地方以不同形态出现：界面上是 data URL（<img src>），存进 uTools 附件
// 要的是字节，算内容哈希也按 data URL 的文本算。转换集中在这里，免得解析 data URL
// 的那条正则在 image.ts 和 iconStore.ts 各写一遍。

const DATA_URL = /^data:([^;,]+)(;base64)?,([\s\S]*)$/

export interface DataUrlParts {
  mime: string
  // 显式写上 ArrayBuffer：不写的话类型是 Uint8Array<ArrayBufferLike>，
  // 而 Blob 的入参不收可能指向 SharedArrayBuffer 的视图。
  bytes: Uint8Array<ArrayBuffer>
}

/** 把 data URL 解成 MIME 和原始字节。解析不出来返回 null（当成抓取失败处理）。 */
export function dataUrlToBytes(dataUrl: string): DataUrlParts | null {
  const matched = DATA_URL.exec(String(dataUrl || ''))
  if (!matched) return null
  const [, mime, base64, data] = matched
  try {
    if (!base64) return { mime: mime || '', bytes: new TextEncoder().encode(decodeURIComponent(data ?? '')) }
    const binary = atob(data ?? '')
    return { mime: mime || '', bytes: Uint8Array.from(binary, char => char.charCodeAt(0)) }
  } catch {
    return null
  }
}

// btoa 要的是「每个字符一个字节」的字符串。String.fromCharCode(...bytes) 一把梭的话，
// 几十 KB 的图标就是几万个实参，会撞到引擎的参数个数上限，所以分段拼。
const CHUNK = 8 * 1024

/** 把原始字节编回 data URL。 */
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK))
  }
  return `data:${mime || 'application/octet-stream'};base64,${btoa(binary)}`
}
