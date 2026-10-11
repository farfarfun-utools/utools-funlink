import { reactive } from 'vue'

// 提示停留时长。够看完一句话，又不至于盖着界面不走。
const DURATION = 3200

/** 全局轻提示。连续提示时后一条顶掉前一条，不排队。 */
export function useToast() {
  const toast = reactive({ visible: false, message: '', error: false })
  let timer: ReturnType<typeof setTimeout> | undefined

  function showToast(message: string, error = false) {
    // 必须清掉上一条的定时器，否则新提示会被它提前关掉。
    clearTimeout(timer)
    Object.assign(toast, { visible: true, message, error })
    timer = setTimeout(() => { toast.visible = false }, DURATION)
  }

  return { toast, showToast }
}
