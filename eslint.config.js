import js from '@eslint/js'
import globals from 'globals'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'

// 扁平配置的默认匹配只覆盖 .js/.mjs/.cjs，所以必须显式声明 .ts 和 .vue，
// 否则 src/ 下的代码一行都不会被检查（以前就是这个状况）。
export default [
  {
    ignores: ['node_modules/**', 'utools/dist/**', 'pnpm-lock.yaml'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    // .vue 里的 <script lang="ts"> 要交给 TS 解析器，否则类型标注会被当语法错误。
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: { parser: tseslint.parser, extraFileExtensions: ['.vue'] },
    },
  },
  {
    files: ['src/**'],
    languageOptions: {
      globals: { ...globals.browser, utools: 'readonly' },
    },
  },
  {
    // preload 跑在 uTools 的 CommonJS 环境里，有 Node 全局也有 window 和 utools。
    files: ['utools/preload.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { ...globals.node, ...globals.browser, utools: 'readonly' },
    },
    rules: {
      // preload 必须是 CommonJS（uTools 的硬性要求），require 不是问题。
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['tests/**', '*.config.js', '*.config.ts'],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    // 截图脚本跑在 Node 里，靠 stdout 汇报进度。
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },
  {
    rules: {
      // 项目里刻意用了不少 `?.` 可选调用来兼容「浏览器预览时没有 utools」，
      // 这些地方的空值检查是有意为之，不按未使用变量/表达式处理。
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      // 单行 if/else 是本项目的既有风格（见 useFunLink.ts 的视图分支），不强制换行加括号。
      'curly': 'off',
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/multiline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      // 同一个模块被 import 两次没人看得出来，但确实发生过（NoteDialog、BookmarkDialog
      // 都从 lib/core 导了两行）。这条规则只看模块路径、不区分 import type，
      // 所以既要取值又要取类型时请写成行内的 `type X`，别拆成两条。
      'no-duplicate-imports': 'error',
    },
  },
]
