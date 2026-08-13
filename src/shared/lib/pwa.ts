/** Helpers for the installed-app ("Add to Home Screen") experience. */

interface NavigatorStandalone extends Navigator {
  /** iOS Safari only, and predates the display-mode media query. */
  standalone?: boolean
}

/** True when running from the home screen rather than inside a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as NavigatorStandalone).standalone === true
  )
}

/**
 * iOS has no install API at all — no `beforeinstallprompt`, no `prompt()`. The
 * only way onto the home screen is Share ▸ Add to Home Screen, by hand, so we
 * have to detect the platform and show the recipe.
 */
export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  if (/iphone|ipad|ipod/i.test(ua)) return true
  // The check below keys off a Mac-like platform string, which an Android
  // device running under desktop emulation also reports — so rule Android out
  // first or every emulated Android is misread as an iPad.
  if (/android/i.test(ua)) return false
  // iPadOS 13+ reports itself as a Mac; the touch points give it away.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
}

/** Set once the user closes the install hint, so it never nags them again. */
export const INSTALL_DISMISSED_KEY = 'craftos.install-prompt.dismissed'

export function installHintDismissed(): boolean {
  try {
    return localStorage.getItem(INSTALL_DISMISSED_KEY) === '1'
  } catch {
    // Private mode / storage disabled — treat as not dismissed but don't crash.
    return false
  }
}

export function dismissInstallHint(): void {
  try {
    localStorage.setItem(INSTALL_DISMISSED_KEY, '1')
  } catch {
    // Nothing to do: the hint just reappears next launch.
  }
}

/** Android fires `beforeinstallprompt`, but only when a manifest is present. */
export function isAndroid(): boolean {
  if (typeof navigator === 'undefined') return false
  return /android/i.test(navigator.userAgent)
}

export type MobilePlatform = 'ios' | 'android' | null

/** null on desktop — the hint is only meaningful on a phone or tablet. */
export function mobilePlatform(): MobilePlatform {
  if (isIos()) return 'ios'
  if (isAndroid()) return 'android'
  return null
}
