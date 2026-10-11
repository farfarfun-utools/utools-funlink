// 整库收藏都存在 uTools 的单个数据库文档里，上限 1MB（见 lib/storage.ts）。
// 图标是唯一会把体积顶到这个量级的字段：一张 200KB 的图转成 base64 要占 267KB，
// 四张就把整个文档写崩。所以存之前先按显示尺寸压一遍，让单张图标稳定在几 KB。

// 图标最大边长。卡片上渲染为 42px，128px 已经覆盖 3 倍 HiDPI。
const MAX_EDGE = 128

// 本来就小的图原样存：重新编码有可能反而更大（16×16 的 png 尤其明显）。
const KEEP_AS_IS_BYTES = 16 * 1024

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error || new Error('图片读取失败'))
    reader.readAsDataURL(file)
  })
}

/**
 * 把图片文件转成有界的 data URL：按最大边长等比缩放后重新编码。
 * @param file 用户选的图片
 * @param maxEdge 缩放后的最大边长
 */
export async function toIconDataUrl(file: Blob, maxEdge: number = MAX_EDGE): Promise<string> {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    // svg 这类没有固有尺寸的图片解不开位图，原样存。
    // 这种文件通常只有几 KB，不会把文档撑爆。
    return readAsDataUrl(file)
  }

  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
    if (scale === 1 && file.size <= KEEP_AS_IS_BYTES) return await readAsDataUrl(file)

    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('无法创建画布')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    // webp 保留透明通道，同画质下比 png 小一个量级；
    // 引擎不支持时 toDataURL 会静默退回 png，结果依然可用。
    return canvas.toDataURL('image/webp', 0.9)
  } finally {
    bitmap.close()
  }
}
