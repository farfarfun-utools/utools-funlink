declare module '*.vue' {
  import type { DefineComponent } from 'vue'

  const component: DefineComponent
  export default component
}

// Vite 把静态资源 import 解析成 URL 字符串。
declare module '*.svg' {
  const url: string
  export default url
}

declare module '*.png' {
  const url: string
  export default url
}

declare module '*.woff2' {
  const url: string
  export default url
}

// window.utools 由 utools-api-types 声明，这里只补插件自己的桥接层。
// 用 inline import 引用类型，避免顶层 import 把本文件变成模块
// （那样 declare module '*.vue' 会被当成模块增强而失效）。
interface Window {
  funlink?: import('./lib/types').FunLinkBridge
}
