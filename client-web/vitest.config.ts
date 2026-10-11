import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'node',
    /*
     * audit-tests/ 放「审计整改」的契约/门禁行为测试：它们要读 contract/openapi.json、
     * .github/workflows/*.yml、git 与子进程，依赖 node 内建模块，因此不放进 src/
     * （src 由 tsconfig.app.json 管理，其 types 只含 vite/client，加 node 类型会
     * 削弱前端工程的类型约束）。仍在同一条 `npm run test` 里执行。
     * 组件级用例（ICS / rRule / icon / 登录页）用文件头 `// @vitest-environment jsdom`
     * 单独切到 jsdom，其余保持 node。
     */
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
      'audit-tests/**/*.test.ts',
      'audit-tests/**/*.test.tsx',
    ],
  },
})
