import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  // HTTPS=1 serves a self-signed certificate so iPads and phones on the shop
  // Wi-Fi get a secure context (POS spike). Plain `npm run dev` is unchanged.
  plugins: [react(), ...(process.env.HTTPS === '1' ? [basicSsl()] : [])],
  server: {
    // honor an externally assigned port (e.g. preview harness); default 5173
    port: Number(process.env.PORT) || 5173,
  },
  build: {
    rollupOptions: {
      input: { main: resolve(root, 'index.html'), qr: resolve(root, 'qr/index.html') },
    },
  },
})
