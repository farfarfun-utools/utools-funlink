import { computed, reactive, ref } from 'vue'
import type { Ref } from 'vue'
import { fetchSiteIcon } from '../lib/image'
import { ICON_COST_ESTIMATE, iconBackfillCandidates, iconBudget, runIconBackfill } from '../lib/icons'
import type { IconFailure, IconUpdate } from '../lib/icons'
import { serializeForStorage } from '../lib/storage'
import type { AppState } from '../lib/types'

export interface IconBackfillDeps {
  state: Ref<AppState>
  /** 存档异常时整库是只读的，这一轮不能跑。 */
  storageError: Ref<string>
  /** 把一批图标写进卡片并落盘，返回是否写成功。 */
  applyIcons: (updates: IconUpdate[]) => boolean
  showToast: (message: string, error?: boolean) => void
  /** 抓单张图标，测试里换成假实现。 */
  fetchIcon?: (url: string) => Promise<string>
}

/**
 * 「批量抓取图标」对话框的状态。
 *
 * 返回 reactive 对象而不是一堆 ref：这个对象要整个当 prop 传给 SettingsDialog，
 * 嵌在普通对象里的 ref 在模板里不会自动解包，调用点就得写满 .value。
 */
export function useIconBackfill({ state, storageError, applyIcons, showToast, fetchIcon = fetchSiteIcon }: IconBackfillDeps) {
  const running = ref(false)
  const finished = ref(false)
  const includeExisting = ref(false)
  const done = ref(0)
  const filled = ref(0)
  const failed = ref(0)
  const failures = ref<IconFailure[]>([])
  // 一轮一个编号。被新一轮接管的旧轮次跑完后不许再改界面上的数字。
  let runId = 0

  const candidates = computed(() => iconBackfillCandidates(state.value.bookmarks, { includeExisting: includeExisting.value }))
  // 整库序列化一遍才知道真实体积。computed 是惰性的，对话框没打开就不会算；
  // 打开着的时候每落盘一批都会自动重算，估算误差不会一路累积下去。
  const storageBytes = computed(() => serializeForStorage(state.value).bytes)
  const remainingBytes = computed(() => iconBudget(storageBytes.value))
  const capacity = computed(() => Math.floor(remainingBytes.value / ICON_COST_ESTIMATE))

  async function start() {
    if (running.value) return
    if (storageError.value) return showToast('存档异常已暂停写入，抓到的图标没法保存', true)
    // 抓取走的是 preload 的 Node 侧请求，浏览器预览里没有这个桥接层。
    if (!window.funlink?.fetchIcon) return showToast('当前环境不支持抓取图标', true)
    const targets = candidates.value
    if (!targets.length) return showToast('没有需要抓图标的卡片')

    const id = ++runId
    // 点了停止就把 running 置成 false，抓取循环下一轮判断时就会退出。
    const stopped = () => id !== runId || !running.value
    running.value = true
    finished.value = false
    done.value = 0
    filled.value = 0
    failed.value = 0
    failures.value = []

    const result = await runIconBackfill({
      candidates: targets,
      budget: remainingBytes.value,
      fetch: fetchIcon,
      apply: applyIcons,
      stopped,
      onProgress: progress => {
        if (id !== runId) return
        done.value = progress.done
        filled.value = progress.filled
        failed.value = progress.failed
      },
    })
    // 已经被新一轮接管，这一轮的结果就不该再往界面上写。
    if (id !== runId) return
    running.value = false
    finished.value = true
    filled.value = result.filled
    failed.value = result.failures.length
    failures.value = result.failures

    const missed = result.failures.length ? `，${result.failures.length} 张没抓到` : ''
    if (result.stoppedBy === 'budget') {
      showToast(`剩余空间只够放 ${result.filled} 张图标，已停下。清空废纸篓或删掉几张大图片图标后可以接着抓`, true)
    } else if (result.stoppedBy === 'storage') {
      // 写入失败的原因已经由落盘那边提示过了，再弹一条只会把它顶掉。
    } else if (result.stoppedBy === 'user') {
      showToast(`已停止，这一轮抓到 ${result.filled} 张图标`)
    } else if (result.filled) {
      showToast(`已为 ${result.filled} 张卡片抓到图标${missed}`)
    } else {
      showToast('一张图标都没抓到，可能是网络不通或这些站点没提供图标', true)
    }
  }

  /** 停掉正在跑的这一轮，已经抓到的图标留着。 */
  function stop() {
    running.value = false
  }

  return reactive({
    running, finished, includeExisting, done, filled, failed, failures,
    candidates, storageBytes, remainingBytes, capacity,
    start, stop,
  })
}

export type IconBackfill = ReturnType<typeof useIconBackfill>
