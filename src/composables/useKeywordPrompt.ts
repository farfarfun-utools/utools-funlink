import { reactive } from 'vue'

/**
 * 站内搜索的关键词输入。
 *
 * Electron 不实现 window.prompt，所以改用应用内对话框：askKeyword 返回一个
 * Promise，用户提交或取消时由 resolveKeyword 兑现。取消等于空串，调用方据此放弃打开。
 */
export function useKeywordPrompt() {
  const keywordPrompt = reactive({ visible: false, title: '', value: '' })
  let resolver: ((value: string) => void) | null = null

  function askKeyword(title: string): Promise<string> {
    return new Promise<string>(resolve => {
      resolver = resolve
      Object.assign(keywordPrompt, { visible: true, title, value: '' })
    })
  }

  function resolveKeyword(value = '') {
    keywordPrompt.visible = false
    // 先取出再清空：兑现过程中如果又开了一个对话框，不能把新的 resolver 冲掉。
    const resolve = resolver
    resolver = null
    resolve?.(String(value).trim())
  }

  return { keywordPrompt, askKeyword, resolveKeyword }
}
