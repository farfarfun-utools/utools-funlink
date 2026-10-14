// WebDav 的 PROPFIND 响应解析。
//
// preload 只负责把请求发出去、把原始 XML 递回来（见 types.ts 的 webdavList 注释），
// 解析放在这里：这段逻辑有 .json 过滤、显示名回落、按时间倒序三条规则，
// 之前写在设置对话框里，想验一下就得把整个抽屉挂起来。

/** WebDav 目录列表里的一个备份文件。 */
export interface WebDavFile {
  href: string
  name: string
  size: number
  modified: string
}

/**
 * 解析 PROPFIND 返回的 XML，取出备份文件列表。
 *
 * 一律用 getElementsByTagNameNS('*', ...)：各家服务端的命名空间前缀不一样
 * （D:response、d:response、lp1:getcontentlength 都见得到），按前缀找会漏。
 */
export function parseWebdavList(xml: string): WebDavFile[] {
  const document = new DOMParser().parseFromString(xml, 'application/xml')
  return [...document.getElementsByTagNameNS('*', 'response')].flatMap((response): WebDavFile[] => {
    const value = (name: string) => response.getElementsByTagNameNS('*', name)[0]?.textContent || ''
    const href = value('href')
    // 目录本身和别的文件也在响应里，只认我们自己写出去的 .json 备份。
    if (!decodeURIComponent(href).endsWith('.json')) return []
    return [{
      href,
      // displayname 不是必返的属性，没有就从 href 末段取文件名。
      name: value('displayname') || decodeURIComponent(href.split('/').pop() || ''),
      size: Number(value('getcontentlength') || 0),
      modified: value('getlastmodified'),
    }]
  }).sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime())
}
