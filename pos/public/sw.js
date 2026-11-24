// Craft POS service worker (spec §3 "Install and offline launch"). It is registered as
// /sw.js?v=<build>: each build gets its own cache, filled at install from the assets that
// index.html names, so a tablet that reloads with no network still opens the POS and its
// offline queue. Pages load network-first (3 s at most); assets come from the cache.
// Supabase calls go to another origin and pass straight through.
const VERSION = new URL(self.location.href).searchParams.get('v') || 'dev'
const CACHE = `craft-pos-${VERSION}`
const FILES = ['/manifest.webmanifest', '/icons/pos-180.png', '/icons/pos-192.png', '/icons/pos-512.png']
const NAV_WAIT_MS = 3000

// Network-first, but a network that hangs (café Wi-Fi with no internet) waits 3 s at most
// before the cached page opens. With nothing cached, it keeps waiting for the network.
async function page(req) {
  const net = fetch(req)
  net.catch(() => undefined)                    // a late failure after the cache answered is not an error
  let timer
  const late = new Promise((resolve) => { timer = setTimeout(resolve, NAV_WAIT_MS, null) })
  try {
    const res = await Promise.race([net, late])
    if (res) return res
  } catch { /* offline */ } finally { clearTimeout(timer) }
  const cached = await caches.match('/', { cacheName: CACHE })
  return cached ?? net.catch(() => Response.error())
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE)
    const page = await fetch('/', { cache: 'reload' })
    if (!page.ok) throw new Error(`index.html: ${page.status}`)
    const html = await page.clone().text()
    await cache.put('/', page)
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1])
    await cache.addAll([...FILES, ...assets])
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('craft-pos-') && key !== CACHE) await caches.delete(key)
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return
  if (req.mode === 'navigate') event.respondWith(page(req))
  else if (url.pathname.startsWith('/assets/') || FILES.includes(url.pathname)) {
    event.respondWith(caches.match(req, { cacheName: CACHE }).then((hit) => hit ?? fetch(req)))
  }
})
