import { useEffect, useState } from 'react'
import { newerBuild, RUNNING_BUILD, swUrl } from './appUpdate'

const CHECK_MS = 10 * 60_000

/** True once a newer build is downloaded: its service worker is installed and active, so a
 *  reload opens it even with no network. The app reloads only on the lock screen (spec §3). */
export function useAppUpdate(): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
    let stopped = false
    let busy = false
    const check = async () => {
      if (busy || stopped) return
      busy = true
      try {
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' })
        const build = newerBuild(res.ok ? await res.json() : null, RUNNING_BUILD)
        if (!build) return
        await activated(await navigator.serviceWorker.register(swUrl(build)))
        if (!stopped) setReady(true)
      } catch { /* offline or a failed download: the next check tries again */ } finally { busy = false }
    }
    void check()
    const timer = window.setInterval(() => void check(), CHECK_MS)
    window.addEventListener('online', check)
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener('online', check) }
  }, [])
  return ready
}

function activated(reg: ServiceWorkerRegistration): Promise<void> {
  const w = reg.installing ?? reg.waiting
  if (!w) return Promise.resolve()
  return new Promise((done, fail) => {
    w.addEventListener('statechange', () => {
      if (w.state === 'activated') done()
      else if (w.state === 'redundant') fail(new Error('The update did not install'))
    })
  })
}
