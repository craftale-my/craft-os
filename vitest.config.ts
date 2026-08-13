import { defineConfig, configDefaults } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // 其他并行 session 的 git worktree 就住在 .claude/worktrees/ 底下,每个都是整份
    // repo 的复本。不排除的话本地跑测试会把别人分支的测试也跑进来 —— 数字对不上,
    // 而且别人分支一红,我们的验证关卡就跟着无故变红。
    exclude: [...configDefaults.exclude, '**/.claude/worktrees/**'],
  },
})
