import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  // vitest 读的是这份配置,不读 vite.config.ts,所以 __APP_VERSION__ 要在这里再声明一次(与 vite.config.ts 保持一致)。
  define: {
    __APP_VERSION__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local'),
  },
  test: {
    environment: 'node',
    // 其他并行 session 的 git worktree 就住在 .claude/worktrees/ 底下,每个都是整份
    // repo 的复本。不排除的话本地跑测试会把别人分支的测试也跑进来 —— 数字对不上,
    // 而且别人分支一红,我们的验证关卡就跟着无故变红。
    exclude: [...configDefaults.exclude, '**/.claude/worktrees/**'],
  },
})
