import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    // 反馈里的 appVersion。Vercel 构建时有 commit sha,本地就是 'local'。
    __APP_VERSION__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? 'local'),
  },
  server: {
    // honor an externally assigned port (e.g. preview harness); default 5173
    port: Number(process.env.PORT) || 5173,
  },
})
