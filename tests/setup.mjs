// 把 jsdom 的 localStorage / sessionStorage 挂回 globalThis。
//
// Node 从 22.4 起自带实验性的 Web Storage，25 起默认开启，于是 globalThis 上本来
// 就有 localStorage 这个名字；没给 --localstorage-file 时读出来是 undefined。
// 而 vitest 的 jsdom 环境只会把「globalThis 上还没有」的 window 属性搬上去，
// 白名单里又没列 localStorage（vitest-dev/vitest#10867），结果就是：新版 Node 上
// 跑 jsdom 用例，拿到的是 Node 那份 undefined，jsdom 自己那份反而被挡在外面。
//
// 症状是 `localStorage.clear()` 之类的地方报 Cannot read properties of undefined，
// 而且 lib/storage.ts 读写失败是静默兜底的，所以还会连带出一批对不上的断言。
//
// 这里按 Node 的做法写成可写属性：node 环境的用例（storage.test.mjs）要能
// 直接 `globalThis.localStorage = fake` 再 delete 掉。
const win = globalThis.jsdom?.window
if (win) {
  for (const key of ['localStorage', 'sessionStorage']) {
    Object.defineProperty(globalThis, key, {
      value: win[key],
      writable: true,
      enumerable: true,
      configurable: true,
    })
  }
}
