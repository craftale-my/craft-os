/** Updates (spec §3): every build writes version.json. The app checks it in the background,
 *  has the new build's service worker download it, and reloads only on the lock screen. */

declare const __POS_BUILD__: string
export const RUNNING_BUILD: string = __POS_BUILD__

/** The build named by version.json when it is not the one running, else null. */
export function newerBuild(remote: unknown, running: string): string | null {
  const v = (remote as { version?: unknown } | null)?.version
  return typeof v === 'string' && v !== '' && v !== running ? v : null
}

export const swUrl = (build: string): string => `/sw.js?v=${encodeURIComponent(build)}`
