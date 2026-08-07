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
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return true
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
