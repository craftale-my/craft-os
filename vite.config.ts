import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    // honor an externally assigned port (e.g. preview harness); default 5173
    port: Number(process.env.PORT) || 5173,
  },
})
