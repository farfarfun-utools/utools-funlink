# 更新日志

## 未发布

### 新增

- 添加卡片时自动抓取网站图标，带设置开关（默认开）。抓取只请求收藏的那个站点本身：
  读页面里声明的 `<link rel="icon">` / `apple-touch-icon`，按 `sizes` 挑最合适的一张，
  都没有就试 `/favicon.ico`，不经过任何第三方 favicon 服务。请求放在 `preload.js` 的
  Node 侧（页面 CSP 不允许往外拉图，渲染进程也会撞 CORS），并且按文件头识别图片格式
  ——很多站点的 `/favicon.ico` 返回的是状态码 200 的 HTML 错误页。抓回来的图压到
  64px 再存（压不动又超过 32KB 的直接丢弃），整库共用的 1MB 额度扛得住每张卡片都带一张图。
  抓不到就保持文字图标。通过主搜索框和 AI 工具 `add_bookmark` 添加的卡片同样会抓。
- 存量卡片也能补图标：设置 →「数据」里新增「批量抓取图标」，编辑卡片时也能
  单张手动抓（自动抓取关着、或者想换一张时用，手动按的这一下会盖掉原来的图标）。
  真正的约束不是抓取而是存储——整库压在 uTools 的单个文档里（上限 1MB），一张图标
  约 1.5~4KB，几百张全抓一遍就可能在最后一次写入时整批失败。所以批量抓取带预算
  记账：`900KB - 当前体积 - 64KB 预留`，开始前就把「剩余约可存 N 张」摆出来，每抓到
  一张先算装不装得下，装不下立刻停并提示去清空废纸篓 / 删掉大图标，已经抓到的
  每 10 张就落一次盘，不会白干。同一个域名下的多张卡片只真的请求一次；中途可以
  停止，停下后在飞的结果不再写进卡片。两点已知限制：废纸篓里的卡片不抓（恢复出来后
  可以再抓）；同一个域名下的多张卡片各存一份相同的图标，想省这份重复得把图标改成
  按 hash 共享，那是一次数据迁移，没放进这次改动。导入书签后不会自动抓，点一次
  批量抓取即可。
- 接入 `utools-api-types` 官方类型定义，uTools API 改名会在编译期报错而不是
  运行时静默失效。
- 笔记正文渲染前按白名单重建 DOM（`src/lib/sanitize.ts`），并为页面加上 CSP。
- 新增 GitHub Actions 持续集成（`.github/workflows/ci.yml`）：在 Node 20 / 22 上
  跑 lint、类型检查、测试、构建，并校验打包产物齐全（`preload.js` 语法、
  `plugin.json` 可解析、`dist/index.html` 与图标存在）。
- 新增 `lint` / `lint:fix` / `typecheck` / `check` 四个 npm 脚本；`lint` 不再自动
  修改代码，CI 里应该报错而不是悄悄改写源文件。
- `utools/build.sh` 打包前先跑 lint 和类型检查，避免带着问题出包。
- WebDav 密码不再明文入库：新增 `src/lib/secret.ts`，用 `utools.getNativeId()`
  派生的设备密钥加密（PBKDF2-SHA256 + AES-GCM）后再存。dbStorage 会被 uTools
  同步到云端，而 uTools 没有提供「只存本机」或「加密存储」的接口。旧版本留下的
  明文配置在第一次读取时自动换成密文。
- 失效链接扫描可以中途停止：几百条链接挨个探活要等很久，停下之后在飞的请求
  返回也不再往结果列表里追加。
- 接入 uTools 8 的 AI 工具能力：`plugin.json` 声明 `tools`，并用
  `utools.registerTool` 注册 `search_bookmarks` / `list_categories` /
  `add_bookmark` / `open_bookmark` 四个工具（`src/lib/tools.ts` 负责纯逻辑，
  `src/composables/useAiTools.ts` 负责注册）。`utools.ai()` 的 Function Calling 和
  开启 MCP 服务后的第三方 AI Agent 都能调用。只开放查、增、打开，不开放删除卡片、
  清空废纸篓、恢复备份这类破坏性操作。注册跟着页面初始化做而不是挂在
  `onPluginEnter` 上——AI 调用不会触发进入插件事件。

### 修复

- 修复 uTools 主搜索框里所有收藏都显示同一个插件 logo 的问题：主搜索推送结果和
  「网页快开」动态指令的图标写死成 `logo.png`，一眼分不出哪条是哪条。现在用卡片
  自己的图标——图片图标直接给，文字图标在画布上画成一张 64px 的小图（uTools 那边
  只认图片路径或 data URL）。主搜索框每敲一个字都要重算推送列表，所以画好的图会
  按「文字 + 底色」缓存。
- 适配 uTools 8 API：`setExpendHeight` 更正为 `setExpandHeight`、
  `Feature.explain` 更正为 `description`、`platform` 改为功能级字段。
- 修复主搜索结果选中后打不开的问题：uTools 只回传选中项的文本，
  挂在推送结果上的自定义字段不会带回来，改为按显示文本映射书签 id。
- 修复 `files` / `window` 类型指令进入插件时把载荷当字符串用的问题。
- 修复笔记正文经 `innerHTML` 注入导致的 XSS：恢复备份或导入外部数据时，
  `<img src=x onerror=...>` 这类内联事件处理器会被执行。
- 修复存储写入失败被静默吞掉的问题：uTools 单个文档上限 1MB，而整库收藏
  压在一个文档里。现在写入超限或失败会提示用户，并且不再在失败后仍报
  「已保存」「备份已恢复」。
- 图片图标存入前按显示尺寸压缩（最大边 128px），单张图标从最多 267KB
  降到几 KB，不再是撑爆文档的主因。
- 补齐 `useFunLink.ts` 组合式函数的 TypeScript 类型标注并启用 `noImplicitAny`，
  公开 API 不再有隐式 any 参数。
- 补充 `useFunLink.ts` 主对外交互 API（备份恢复/导入去重/导出明文确认/
  uTools 快开与主搜索）和 `preload.js` WebDAV 网络调用（重定向跳转上限、
  错误信息脱敏）的单元测试，覆盖此前完全没有测试的部分。
- 开启 TypeScript `strict` 和 `noUncheckedIndexedAccess`，并把全部组件的
  `defineProps` / `reactive` / 模板 ref 改成泛型写法。此前 `reactive({})` 和
  运行时 `defineProps({ type: Object })` 让表单字段和子组件实例全是 any，
  类型检查形同虚设（修掉后 `vue-tsc` 从 188 个错误降到 0）。
- 修正下标访问越界的隐患：按卡片数取模取配色、`splice` 取出被移动的分类等
  位置原先都假定一定取得到值。
- 补充 10 个组件的测试（此前为零）：笔记对话框的 XSS 过滤与「只看不改不落盘」
  基准、书签表单的校验与旧数据兼容与图标体积上限、分类拖拽的保护规则、
  设置面板的 WebDAV 列表解析与失效链接扫描。测试总数 72 → 123。
- 只有首次启动和「恢复示例数据」才用得到的 84KB 示例数据改为动态 import，
  不再压进主包：主 JS 从 196KB（gzip 63KB）降到 149KB（gzip 54KB）。
- 内容和上次写进去的完全一样时不再重复落盘：整库收藏压在一个文档里，一次保存
  就是全量写入加一次云同步，而点同一个导航、把卡片拖回原处这类空操作很常见。
- 修复「清空 Cookies」点了等于没点却报「已清空」的问题：原实现删的是数据库里
  `cookie@` 开头的文档——那是上一代插件留下的东西，FunLink 从不写，内置浏览器的
  Cookie 也不在那里。改为按收藏夹里出现过的每个源调用 `ubrowser.clearCookies`，
  失败也会如实报错。
- 退出到后台时清掉搜索词和挂着的关键词对话框：uTools 会收走子输入框，但插件
  进程还活着，不清的话下次进来界面还停在上次的筛选结果上，和空的子输入框对不上。
- 修复不先打开一次「配置WebDav」就点备份时一律提示「请先配置WebDav」的问题：
  配置现在在用到时自己从存储读出来，不再只在打开配置框时才加载。
- 分类面板发出的操作改成按 `type` 区分的联合类型（`CategoryAction`）：原先是
  `(action: string, value: unknown)`，每个分支都得自己把 `value` 收窄回来，少写
  一次判断编译器也不管。顺带删掉了没有任何地方会触发的 `up` / `down` 分支。
- `displayHost` / `safeColor` 从组合式函数移到 `src/lib/core.ts`：组件只要这两个
  纯函数，却要 import 整个 `useFunLink`。
- 拆开 488 行的 `useFunLink.ts`（现 375 行）：视图筛选推导（`src/lib/views.ts`）、
  快开入口管理（`src/lib/features.ts`）、轻提示和关键词对话框
  （`src/composables/useToast.ts` / `useKeywordPrompt.ts`）、uTools 宿主事件注册
  （`src/composables/useUtoolsHost.ts`）各自独立，对外 API 不变。
  前两者是纯函数，现在可以单独测，不用再绕着整个组合式函数转。
- 拆开根目录 785 行的 `style.css`：按界面区域分成 `src/styles/` 下的十个文件，由
  `index.css` 按层叠顺序导入，内容逐字未改（打包出的 CSS 哈希与拆分前一致）。
  随后删掉 1.0 之前的对话框标记留下的 14 条孤立规则（`.modal-header`、
  `.segmented`、`.modal-actions`、`.form-row` 等）和笔记待办列表样式——净化器会
  清掉 `class` / `data-type`，这些选择器永远匹配不上。CSS 产物 44.4KB → 42.1KB。
- 导入「网址精灵」笔记时 `<mark>` 高亮不再丢失：该标签没有需要保留的属性，
  放进净化白名单只多一层背景色，样式仍由插件自己的 `--mark-bg` 决定。
- 补充设备密钥加解密、WebDav 凭据迁移、扫描中止、写入去重、`clearCookies`、
  退出后台清理、视图筛选、快开入口管理与 AI 工具（含工具名和 `plugin.json`
  声明一致性）等测试，测试总数 123 → 178。

### 变更

- WebDav 密码只保存在输入它的那台设备上：密钥绑定设备，换设备或重装后需要在
  本机重新输入一次（界面会提示）。这是把密码从云端同步里拿掉的代价。

## 1.0.0

### 新增

- 首个 FunLink 版本，提供网址收藏、分类、搜索和导入导出。

### 修复

- 补齐规范要求的构建、测试和开源项目元数据。

### 变更

- uTools 展示名称统一为“网址收藏”。

### 废弃

- 无。
