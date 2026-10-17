import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
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
})
