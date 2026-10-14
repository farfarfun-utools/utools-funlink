import { defineConfig, type UserConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// vitest 跟着读这个文件，但 test 字段不在 Vite 的类型里，而 vitest 2 自带的
// defineConfig 带的是 Vite 5 的类型，和本项目 Vite 6 的插件对不上。
// 所以在这儿单独把 test 声明出来：Vite 那部分照样受类型检查。
const config: UserConfig & { test: Record<string, unknown> } = {
  base: './',
  plugins: [vue()],
  build: {
    // 插件只跑在 uTools 的 Chromium 里，不用管别的浏览器。
    // 定到 108 是因为样式里已经在用 dvh 单位（Chrome 108 起支持），代码这边也用了
    // at() 和 crypto.randomUUID（Chrome 92），这是本来就有的下限，不是新加的要求。
    // 写死它还有一层好处：Vite 的默认目标会跟着版本变，升级 Vite 不该顺手改了产物。
    target: 'chrome108',
    outDir: 'utools/dist',
    emptyOutDir: true,
  },
  test: {
    // 单测默认跑在 node 下，要 DOM 的文件自己在首行写 `// @vitest-environment jsdom`：
    // 挂一个 jsdom 比跑 node 慢一个量级，纯逻辑的那十几个文件没必要跟着付这份钱。
    include: ['tests/**/*.test.mjs'],
    coverage: {
      // 没被任何测试碰到的文件也要算进来，否则漏掉一整个模块反倒显示成高覆盖率。
      all: true,
      include: ['src/lib/**', 'src/composables/**', 'src/components/**'],
      // 入口和类型声明没有可执行逻辑，算进来只会把数字冲淡。
      exclude: ['src/main.ts', 'src/env.d.ts', 'src/lib/types.ts'],
      reporter: ['text', 'html'],
    },
  },
}

export default defineConfig(config)
