import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// The POS app (spec §3): its own entry, pos/index.html, built to dist-pos/ with index.html at
// the top so the craft-pos Vercel project serves it with the same vercel.json as Craft OS.
// `npm run dev:pos` serves it on port 5179.

const root = fileURLToPath(new URL('.', import.meta.url))
const BUILD = new Date().toISOString()

/** The till's modules import the Craft OS client (src/shared/lib/supabase.ts). In the POS app
 *  they get src/pos/posSupabase.ts instead: the device's own storage key and coded errors. */
function posClient(): Plugin {
  const shared = resolve(root, 'src/shared/lib/supabase.ts')
  const pos = resolve(root, 'src/pos/posSupabase.ts')
  return {
    name: 'craft-pos-client',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !/\/supabase(\.ts)?$/.test(source)) return null
      const found = await this.resolve(source, importer, { ...options, skipSelf: true })
      return found?.id === shared ? pos : null
    },
  }
}

/** version.json names the build, so a running tablet can tell that a newer one is out. */
function versionFile(): Plugin {
  return {
    name: 'craft-pos-version',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: BUILD }) })
    },
  }
}

export default defineConfig({
  root: resolve(root, 'pos'),
  envDir: root,
  publicDir: resolve(root, 'pos/public'),
  define: { __POS_BUILD__: JSON.stringify(BUILD) },
  plugins: [react(), posClient(), versionFile(), ...(process.env.HTTPS === '1' ? [basicSsl()] : [])],
  server: { port: Number(process.env.PORT) || 5179, fs: { allow: [root] } },
  build: { outDir: resolve(root, 'dist-pos'), emptyOutDir: true },
})
