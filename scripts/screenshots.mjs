// 【生成文件，请勿手改】由 https://github.com/farfarfun-utools/utools-shots 的
// build-scripts.mjs 拼出来：公用骨架 (_prelude.mjs) + 本插件的演示数据与分镜
// (_tail-<app>.mjs)。四个插件仓库里的这个文件骨架部分一字不差，所以只维护一份、分发
// 过来。要改就回那边改，再重新生成 —— 直接改这里，下次生成就没了。scripts/cdp.mjs 同理。
//
// 生成 README 里的界面截图。
//
// 为什么要有这个脚本：README 里的图最容易过期 —— 改完界面没人记得重截一遍，而图和
// 实物对不上比没有图更糟。所以把它做成可重跑的：打版本标签时 CI 跑一遍，图真变了才
// 提交回仓库（见 .github/workflows/screenshots.yml）。
//
// 插件窗口本质就是一个 Chromium 页面，所以「起个静态服务器打开 utools/dist 再拍照」
// 拍到的就是真机上的样子。视口严格按 utools/plugin.json 里的 pluginSetting.height 来。
//
// 用法：
//   pnpm screenshots              # 先构建再截
//   pnpm screenshots --no-build   # 用现有 utools/dist（反复调版式时快得多）
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBrowser, launch } from './cdp.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DIST = path.join(ROOT, 'utools/dist');
const OUT = path.join(ROOT, 'docs/screenshots');

// 时间冻在一个固定时刻。
//
// 不冻的话每跑一遍都会生成一批像素不同的图（倒计时、动态验证码这类随时间变的东西），
// CI 就会每次都提交一笔「截图变了」，而界面其实一个像素都没改。秒数取 07：
// 任何整分钟的 Unix 时间戳都能被 30 整除，所以 07 秒落在 30 秒周期的第 7 秒上，
// 离周期末尾还远，不会触发「最后 5 秒」那类临界态的版式。
const FROZEN_AT = Date.parse('2026-10-16T20:00:07+08:00');

const FREEZE_CLOCK = `(() => {
  const Real = Date;
  const fixed = ${FROZEN_AT};
  class Frozen extends Real {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  }
  Frozen.parse = Real.parse;
  Frozen.UTC = Real.UTC;
  globalThis.Date = Frozen;
})()`;

// 冻住时钟管不到 CSS 动画和过渡 —— 它们跟的是文档时间轴，不是 Date.now()。
// 所以还得把过渡关掉，拍到的才是终态而不是某一帧中间态。
// 跟时间有关的动画（比如倒计时圆环）由各自的 extraCss 钉到固定进度上。
const BASE_CSS = `
  /* 滚动条是浏览器预览的产物，uTools 窗口里没有。
     两条都要写：元素一旦设了标准属性 scrollbar-width，Chrome 就完全忽略
     ::-webkit-scrollbar 那套，只写 webkit 的那条对它不起作用。 */
  * { scrollbar-width: none !important }
  *::-webkit-scrollbar { width: 0 !important; height: 0 !important; display: none !important }
  *, *::before, *::after { transition: none !important; caret-color: transparent !important }
`;

/** 本轮要注入页面的样式，reload 之后也要重新贴一遍。 */
let pageCss = BASE_CSS;

/** 把样式贴进当前文档。 */
const injectCss = (session) =>
  session.evaluate(`(() => {
    const style = document.createElement('style');
    style.textContent = ${JSON.stringify(pageCss)};
    (document.head || document.documentElement).append(style);
    return true;
  })()`);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 起一个只读静态服务器。端口交给系统分配，不会和别的东西撞。
 * @param root 根目录。
 * @returns 地址和 close()。
 */
async function serve(root) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    const target = path.join(root, relative);
    if (!target.startsWith(root) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      response.writeHead(404).end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream' });
    fs.createReadStream(target).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// ───────────────────────── 操作界面的几个小动作 ─────────────────────────
// 每个都返回 (session) => Promise，交给 shot.before 串起来。

/** 点一个选择器命中的元素。 */
const click = (selector) => (session) =>
  session.evaluate(`document.querySelector(${JSON.stringify(selector)})?.click(), true`);

/** 按可见文字点，用在没有稳定选择器的对话框按钮、标签页上。 */
const clickText = (text, selector = 'button') => (session) =>
  session.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})]
    .find((node) => node.textContent.trim() === ${JSON.stringify(text)})?.click(), true`);

/** 在元素中心按右键，用来调出右键菜单。 */
const rightClick = (selector) => (session) =>
  session.evaluate(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return false;
    const box = node.getBoundingClientRect();
    node.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true, cancelable: true,
      clientX: Math.round(box.left + box.width / 2),
      clientY: Math.round(box.top + box.height / 2),
    }));
    return true;
  })()`);

/** 重新加载页面，让下一张图从干净的初始界面开始。 */
const reload = async (session) => {
  await session.send('Page.reload');
  await session.waitForExpression('document.readyState === "complete"');
  await injectCss(session);
  await sleep(1200);
};

/** 依次执行若干个动作。 */
const steps = (...actions) => async (session) => {
  for (const action of actions) {
    await action(session);
    await sleep(350);
  }
};

/**
 * 跑一组截图。
 *
 * @param options.width/height 视口尺寸，对齐 plugin.json 的插件窗口。
 * @param options.scale 像素密度，2 出高清图。
 * @param options.seed 页面首次加载后执行的表达式，用来塞演示数据；执行完会 reload 一次。
 * @param options.extraCss 额外样式，用来把跟时间有关的动画钉到固定进度上，保证可重复。
 * @param options.shots `[{ name, before, wait }]`，before 负责把界面点到位。
 */
async function shoot({ width, height, scale = 2, seed, extraCss = '', shots }) {
  pageCss = BASE_CSS + extraCss;
  const server = await serve(DIST);
  const browser = await launch({ headless: true });
  const { session } = browser;
  const failures = [];
  session.on('Runtime.exceptionThrown', (event) => {
    failures.push(event.exceptionDetails?.exception?.description ?? event.exceptionDetails?.text);
  });

  try {
    await session.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    // 冻时钟必须赶在页面脚本之前，所以走 addScriptToEvaluateOnNewDocument 而不是 evaluate。
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source: FREEZE_CLOCK });
    await browser.navigate(server.origin);
    await session.waitForExpression('document.readyState === "complete"');

    if (seed) {
      await session.evaluate(seed);
      await session.send('Page.reload');
      await session.waitForExpression('document.readyState === "complete"');
    }
    await injectCss(session);
    await sleep(900);

    fs.mkdirSync(OUT, { recursive: true });
    for (const shot of shots) {
      if (shot.before) await shot.before(session);
      await sleep(shot.wait ?? 500);
      const { data } = await session.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, `${shot.name}.png`), Buffer.from(data, 'base64'));
      console.log(`  ✓ docs/screenshots/${shot.name}.png`);
    }
  } finally {
    await browser.close();
    await server.close();
  }

  // 页面里的报错不让截图失败（图照样拍出来了），但要打出来，别让它悄悄烂掉。
  if (failures.length) console.warn('  页面抛错：', failures.slice(0, 5));
}

// 没有浏览器就跳过而不是失败：这是开发期的辅助命令，没装 Chrome 的机器不该因此卡住。
if (!findBrowser()) {
  console.warn('[截图] 找不到 Chromium 系浏览器，跳过');
  process.exit(0);
}

if (!process.argv.includes('--no-build')) {
  const built = spawnSync('pnpm', ['build'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (built.status !== 0) process.exit(built.status ?? 1);
}

// ───────────────────────────── 演示数据 ─────────────────────────────
// 全是编的收藏，只用来撑满版式。
//
// 刻意不放 cat@default：那是「收集箱」这个内置视图的分类 id，顶部导航自己会画，
// 再当成一级分类塞进来会多出一个重名的标签页。

const CATEGORIES = [
  { id: 'cat-dev', name: '开发', parentId: '' },
  { id: 'cat-fe', name: '前端', parentId: 'cat-dev' },
  { id: 'cat-be', name: '服务端', parentId: 'cat-dev' },
  { id: 'cat-ai', name: 'AI', parentId: 'cat-dev' },
  { id: 'cat-design', name: '设计', parentId: '' },
  { id: 'cat-doc', name: '文档', parentId: '' },
  { id: 'cat-tool', name: '工具', parentId: '' },
];

const card = (id, title, url, description, categoryId, icon, color, extra = {}) => ({
  id, title, url, description,
  categoryIds: [categoryId],
  categoryId,
  iconType: 'text',
  icon,
  color,
  ...extra,
});

const BOOKMARKS = [
  card('b1', 'Vue 3', 'https://cn.vuejs.org', '渐进式 JavaScript 框架', 'cat-fe', 'V', '#42b883', { favorite: true }),
  card('b2', 'Vite', 'https://cn.vitejs.dev', '下一代前端构建工具', 'cat-fe', 'VT', '#646cff'),
  card('b3', 'MDN Web Docs', 'https://developer.mozilla.org', 'Web 标准的权威文档', 'cat-fe', 'M', '#000000', { favorite: true }),
  card('b4', 'TypeScript', 'https://www.typescriptlang.org', '带类型的 JavaScript', 'cat-fe', 'TS', '#3178c6'),
  card('b5', 'Can I use', 'https://caniuse.com', '浏览器兼容性速查', 'cat-fe', 'CI', '#e8664a'),
  card('b6', 'Tailwind CSS', 'https://tailwindcss.com', '原子化 CSS 框架', 'cat-fe', 'TW', '#38bdf8'),
  card('b7', 'npm', 'https://www.npmjs.com/search?q={q}', '包搜索（支持 {q} 站内搜索）', 'cat-fe', 'NP', '#cb3837', { quick: true }),
  card('b8', 'CodePen', 'https://codepen.io', '在线写点 Demo', 'cat-fe', 'CP', '#1e1f26'),
  card('b9', 'Vite 插件市场', 'https://vite.dev/plugins', '官方插件清单', 'cat-fe', 'VP', '#9333ea'),
  card('b10', 'Pinia', 'https://pinia.vuejs.org/zh', 'Vue 状态管理', 'cat-fe', 'PN', '#ffd859'),
  card('b11', 'Iconify', 'https://icon-sets.iconify.design', '找图标就来这', 'cat-fe', 'IF', '#1769aa'),
  card('b12', 'Vitest', 'https://cn.vitest.dev', '跑单测的那个', 'cat-fe', 'VI', '#fcc72b'),
  card('b13', 'Bundlephobia', 'https://bundlephobia.com', '装之前先看体积', 'cat-fe', 'BP', '#ff6b6b'),
  card('b14', 'Regex101', 'https://regex101.com', '正则在线调试', 'cat-fe', 'RE', '#0f9f6e'),
  card('b15', 'GitHub', 'https://github.com', '代码托管与协作', 'cat-be', 'GH', '#24292f', { favorite: true, note: '常用仓库都在这里' }),
  card('b16', 'Docker Hub', 'https://hub.docker.com', '容器镜像仓库', 'cat-be', 'DK', '#2496ed'),
  card('b17', 'uTools 文档', 'https://www.u.tools/docs', '插件开发手册', 'cat-doc', 'UT', '#0ca47f'),
  card('b18', 'Figma', 'https://www.figma.com', '协同设计工具', 'cat-design', 'FG', '#f24e1e'),
];

const seedFor = (theme) => `localStorage.setItem('funlink-state-v1', ${JSON.stringify(JSON.stringify({
  version: 1,
  theme,
  currentView: 'category:cat-fe',
  lastCategoryId: 'cat-fe',
  categories: CATEGORIES,
  bookmarks: BOOKMARKS,
}))})`;

// 视口对齐 utools/plugin.json 的 pluginSetting.height。
const VIEWPORT = { width: 800, height: 558 };

await shoot({
  ...VIEWPORT,
  seed: seedFor('light'),
  shots: [
    { name: 'home', wait: 1200 },
    // 编辑已有卡片而不是新建：新建面板是空的，填满的表单才看得出能调哪些东西。
    { name: 'edit', before: steps(rightClick('.bookmark-card'), clickText('编辑')), wait: 900 },
    // 停在「数据管理」页：备份还原和书签导入都在这一页，比基础设置更有信息量。
    { name: 'settings', before: steps(reload, click('[aria-label="设置"]'), clickText('数据管理')), wait: 800 },
  ],
});

await shoot({
  ...VIEWPORT,
  seed: seedFor('dark'),
  shots: [{ name: 'dark', wait: 1200 }],
});
