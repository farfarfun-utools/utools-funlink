import { defineConfig, mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

// 测试配置单独放一个文件，和同族另外三个插件一致。构建那部分（vue 插件、产物目标）
// 从 vite.config.ts 合并进来，不在这儿重复写一份。
//
// 这段原来是直接写在 vite.config.ts 里的、用 `UserConfig & { test }` 手动拼出来的类型：
// 当时 vitest 2 自带的 defineConfig 带的是 Vite 5 的类型，和项目里 Vite 6 的插件对不上。
// 工具链升到 vite 7 + vitest 4 之后两边的类型本来就是一套，那个变通不再需要。
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // 单测默认跑在 node 下，要 DOM 的文件自己在首行写 `// @vitest-environment jsdom`：
      // 挂一个 jsdom 比跑 node 慢一个量级，纯逻辑的那十几个文件没必要跟着付这份钱。
      include: ['tests/**/*.test.mjs'],
      // 只做一件事：把 jsdom 的 localStorage 补回 globalThis，原因见文件里的注释。
      // node 环境的用例里它是空操作。
      setupFiles: ['tests/setup.mjs'],
      coverage: {
        // 这里列的文件即使没被任何测试碰到，也要出现在报告里 —— 否则漏掉一整个模块
        // 反倒显示成高覆盖率。原来为此写了 `all: true`，vitest 4 里已经没有这个选项，
        // include 列到的文件一律进报告。
        include: ['src/lib/**', 'src/composables/**', 'src/components/**'],
        // 入口和类型声明没有可执行逻辑，算进来只会把数字冲淡。
        exclude: ['src/main.ts', 'src/env.d.ts', 'src/lib/types.ts'],
        reporter: ['text', 'html'],
      },
    },
  }),
)
