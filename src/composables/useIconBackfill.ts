// 同一个模块里既要取值又要取类型时，用行内 type 写在一条 import 里：
// no-duplicate-imports 只按模块路径看，分成两条会被判成重复导入。
import { computed, reactive, ref, type Ref } from 'vue'
import { fetchSiteIcon } from '../lib/image'
import { ICON_COST_ESTIMATE, ICON_REF_COST, iconBackfillCandidates, iconBudget, iconCost, runIconBackfill, type IconFailure, type IconUpdate } from '../lib/icons'
import { iconStoreAvailable } from '../lib/iconStore'
import { serializeForStorage } from '../lib/storage'
import type { AppState } from '../lib/types'

export interface IconBackfillDeps {
  state: Ref<AppState>
  /** 存档异常时整库是只读的，这一轮不能跑。 */
  storageError: Ref<string>
  /** 把一批图标写进卡片并落盘，返回是否写成功。 */
  applyIcons: (updates: IconUpdate[]) => boolean | Promise<boolean>
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
  // 这一轮开跑时的待抓总数。不能拿 candidates.length 当分母：每落盘一批，
  // 抓到图标的卡片就从候选里消失了，分母会一边跑一边变小。
  const total = ref(0)
  const filled = ref(0)
  const failed = ref(0)
  const failures = ref<IconFailure[]>([])
  // 对话框是模态的（showModal），toast 在顶层之下会被它盖住，所以状态必须
  // 同时写在对话框里，否则用户点完只看到一片没反应。
  const message = ref('')
  const messageError = ref(false)
  // 一轮一个编号。被新一轮接管的旧轮次跑完后不许再改界面上的数字。
  let runId = 0

  const candidates = computed(() => iconBackfillCandidates(state.value.bookmarks, { includeExisting: includeExisting.value }))
  // 整库序列化一遍才知道真实体积。computed 是惰性的，对话框没打开就不会算；
  // 打开着的时候每落盘一批都会自动重算，估算误差不会一路累积下去。
  const storageBytes = computed(() => serializeForStorage(state.value).bytes)
  const remainingBytes = computed(() => iconBudget(storageBytes.value))
  // 图标存进附件之后在整库文档里只剩一个 ID，一张几十字节，这时「还能存多少张」
  // 就不再由存档体积说话了（见 lib/iconStore.ts）。存不进附件（浏览器预览）时
  // 图标仍然内联在文档里，按一张几 KB 估。
  const perIconBytes = () => iconStoreAvailable() ? ICON_REF_COST : ICON_COST_ESTIMATE
  const capacity = computed(() => Math.floor(remainingBytes.value / perIconBytes()))
  const percent = computed(() => total.value ? Math.min(100, Math.round(done.value / total.value * 100)) : 0)

  /** 一句话状态：对话框里和 toast 各写一份。 */
  function say(text: string, error = false) {
    message.value = text
    messageError.value = error
    showToast(text, error)
  }

  async function start() {
    if (running.value) return
    if (storageError.value) return say('存档异常已暂停写入，抓到的图标没法保存', true)
    // 抓取走的是 preload 的 Node 侧请求，浏览器预览里没有这个桥接层。
    if (!window.funlink?.fetchIcon) return say('当前环境不支持抓取图标，请在 uTools 里操作', true)
    const targets = candidates.value
    if (!targets.length) return say('没有需要抓图标的卡片')

    const id = ++runId
    // 点了停止就把 running 置成 false，抓取循环下一轮判断时就会退出。
    const stopped = () => id !== runId || !running.value
    running.value = true
    finished.value = false
    done.value = 0
    total.value = targets.length
    filled.value = 0
    failed.value = 0
    failures.value = []
    message.value = ''
    messageError.value = false

    try {
      const result = await runIconBackfill({
        candidates: targets,
        budget: remainingBytes.value,
        fetch: fetchIcon,
        apply: applyIcons,
        cost: iconStoreAvailable() ? () => ICON_REF_COST : iconCost,
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
      finished.value = true
      filled.value = result.filled
      failed.value = result.failures.length
      failures.value = result.failures

      const missed = result.failures.length ? `，${result.failures.length} 张没抓到` : ''
      if (result.stoppedBy === 'budget') {
        say(`剩余空间只够放 ${result.filled} 张图标，已停下。清空废纸篓或删掉几张大图片图标后可以接着抓`, true)
      } else if (result.stoppedBy === 'storage') {
        // 写失败的具体原因由落盘那边提示，这里只说清为什么停了。
        message.value = `保存失败，已停在第 ${done.value} 张`
        messageError.value = true
      } else if (result.stoppedBy === 'user') {
        say(`已停止，这一轮抓到 ${result.filled} 张图标`)
      } else if (result.filled) {
        say(`已为 ${result.filled} 张卡片抓到图标${missed}`)
      } else {
        say('一张图标都没抓到，可能是网络不通或这些站点没提供图标', true)
      }
    } catch (caught) {
      // 抓取循环自己兜住了单张的失败，能漏到这里的是没想到的错。不兜住的话
      // running 会一直挂在 true 上，界面永远停在「请稍后」。
      if (id !== runId) return
      say(`抓取中断：${caught instanceof Error ? caught.message : String(caught)}`, true)
    } finally {
      if (id === runId) running.value = false
    }
  }

  /** 停掉正在跑的这一轮，已经抓到的图标留着。 */
  function stop() {
    running.value = false
  }

  return reactive({
    running, finished, includeExisting, done, total, filled, failed, failures,
    message, messageError,
    candidates, storageBytes, remainingBytes, capacity, percent,
    start, stop,
  })
}

export type IconBackfill = ReturnType<typeof useIconBackfill>
