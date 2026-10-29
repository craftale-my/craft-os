import { useEffect, useState } from 'react'
import { markReloaded, newerBuild, reloadedFor, RUNNING_BUILD, swUrl } from './appUpdate'

const CHECK_MS = 10 * 60_000

/** The newer build once it is downloaded (its service worker is installed and active, so a
 *  reload opens it even with no network), else null. A build this tab already reloaded for is
 *  never offered again. The app reloads only on the lock screen (spec §3). */
export function useAppUpdate(): string | null {
  const [ready, setReady] = useState<string | null>(null)
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
        if (!build || build === reloadedFor(sessionStorage)) return
        await activated(await navigator.serviceWorker.register(swUrl(build)))
        if (!stopped) setReady(build)
      } catch { /* offline or a failed download: the next check tries again */ } finally { busy = false }
    }
    void check()
    const timer = window.setInterval(() => void check(), CHECK_MS)
    window.addEventListener('online', check)
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener('online', check) }
  }, [])
  return ready
}

/** Reloads into `build`, remembering it for this tab so the same build never reloads twice. */
export function reloadForUpdate(build: string): void {
  markReloaded(sessionStorage, build)
  window.location.reload()
}

/** Resolves once the new worker is active. It may already be (no statechange would come), or
 *  become so between the read and the listener, so the state is checked again after attaching. */
function activated(reg: ServiceWorkerRegistration): Promise<void> {
  const w = reg.installing ?? reg.waiting
  if (!w || w.state === 'activated') return Promise.resolve()
  return new Promise((done, fail) => {
    const check = () => {
      if (w.state === 'activated') { w.removeEventListener('statechange', check); done() }
      else if (w.state === 'redundant') { w.removeEventListener('statechange', check); fail(new Error('The update did not install')) }
    }
    w.addEventListener('statechange', check)
    check()
  })
}
