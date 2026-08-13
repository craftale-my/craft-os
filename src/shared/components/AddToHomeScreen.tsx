import { useEffect, useRef, useState } from 'react'
import { X, Share, SquarePlus, EllipsisVertical, Download } from 'lucide-react'
import {
  isStandalone, mobilePlatform, installHintDismissed, dismissInstallHint,
} from '../lib/pwa'
import type { MobilePlatform } from '../lib/pwa'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/** Auto-opening the hint once per session, not once per navigation. */
const AUTO_SHOWN_KEY = 'craftos.install-hint.autoshown'

function autoShownThisSession(): boolean {
  try {
    return sessionStorage.getItem(AUTO_SHOWN_KEY) === '1'
  } catch {
    return false
  }
}

function markAutoShown(): void {
  try {
    sessionStorage.setItem(AUTO_SHOWN_KEY, '1')
  } catch {
    // Private mode — the hint just opens again next navigation. Harmless.
  }
}

function Steps({ platform }: { platform: MobilePlatform }) {
  const [icon, label] = platform === 'ios'
    ? [<Share key="i" size={14} />, 'Share']
    : [<EllipsisVertical key="i" size={14} />, 'Menu']

  return (
    <ol className="mt-3 space-y-2 text-xs text-brown-dark">
      <li className="flex items-center gap-2">
        <span className="w-4 flex-shrink-0 font-semibold text-brown-faint">1</span>
        <span className="flex-shrink-0 text-[#C4813A]">{icon}</span>
        <span>Tap <b className="font-semibold">{label}</b> in the browser toolbar</span>
      </li>
      <li className="flex items-center gap-2">
        <span className="w-4 flex-shrink-0 font-semibold text-brown-faint">2</span>
        <SquarePlus size={14} className="flex-shrink-0 text-[#C4813A]" />
        <span>Choose <b className="font-semibold">Add to Home Screen</b></span>
      </li>
    </ol>
  )
}

/**
 * The Craft OS logo in the mobile top bar, doubling as the entry point for the
 * "add this to your home screen" hint.
 *
 * Staff live in this app on their phones but reach it through a browser tab,
 * which means retyping a URL every shift. Nothing in the browser advertises
 * that a web page can be installed — Android buries it in the overflow menu and
 * iOS Safari never mentions it at all — so the hint has to come from us.
 *
 * A dot on the logo marks it as unread; the panel opens by itself once per
 * session until dismissed, and tapping the logo reopens it afterwards.
 */
export function AddToHomeScreenLogo() {
  // Read once on mount: none of these change while the page is open.
  const [platform] = useState<MobilePlatform>(() => mobilePlatform())
  const [installed] = useState(() => isStandalone())
  const [dismissed, setDismissed] = useState(() => installHintDismissed())
  const [open, setOpen] = useState(false)
  const [installer, setInstaller] = useState<BeforeInstallPromptEvent | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)

  const eligible = !installed && platform !== null

  // Android (and desktop Chrome) offer a real installer. It only fires with a
  // manifest present; without one this stays null and the manual steps show.
  useEffect(() => {
    if (!eligible) return
    const onPrompt = (e: Event) => {
      e.preventDefault()
      setInstaller(e as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [eligible])

  // Open by itself the first time someone lands here in a session, so the hint
  // is discoverable without anyone having to notice the dot.
  useEffect(() => {
    if (!eligible || dismissed || autoShownThisSession()) return
    const t = setTimeout(() => { setOpen(true); markAutoShown() }, 900)
    return () => clearTimeout(t)
  }, [eligible, dismissed])

  // Tap anywhere else to close.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  function dismiss() {
    dismissInstallHint()
    setDismissed(true)
    setOpen(false)
  }

  async function install() {
    if (!installer) return
    await installer.prompt()
    dismiss()
  }

  const logo = (
    <span className="relative flex-shrink-0">
      <img src="/craft-logo.jpg" alt="Craft Cafe" className="w-7 h-7 rounded-full object-cover" />
      {eligible && !dismissed && (
        <span
          className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-[#C4813A] ring-2 ring-[#4A2E1A]"
          aria-hidden
        />
      )}
    </span>
  )

  const wordmark = (
    <span className="font-display text-lg font-bold text-[#F5F0E8] tracking-wide">Craft OS</span>
  )

  // Desktop, or already installed: plain branding, nothing to offer.
  if (!eligible) {
    return <span className="flex items-center gap-2">{logo}{wordmark}</span>
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        aria-label="Add Craft OS to your home screen"
        className="flex items-center gap-2"
      >
        {logo}
        {wordmark}
      </button>

      {open && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2.5 z-50
                        w-[min(19rem,calc(100vw-1.5rem))]">
          <span
            className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-3 rotate-45
                       bg-card border-l border-t border-border"
            aria-hidden
          />
          <div className="relative rounded-2xl bg-card border border-border shadow-card-hover p-4 pr-9">
            <button
              onClick={dismiss}
              aria-label="Dismiss"
              className="absolute top-2.5 right-2.5 p-1 text-brown-faint hover:text-brown-dark transition-colors"
            >
              <X size={16} />
            </button>

            <p className="text-sm font-semibold leading-snug text-brown-dark">
              Add Craft OS to your home screen
            </p>
            <p className="mt-0.5 text-xs leading-relaxed text-brown-muted">
              Open it straight from your phone, no browser, no typing the address.
            </p>

            {installer ? (
              <button
                onClick={install}
                className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl
                           bg-[#C4813A] px-4 py-2.5 text-sm font-semibold text-white
                           transition-colors hover:bg-[#A86C2C]"
              >
                <Download size={15} />
                Add to Home Screen
              </button>
            ) : (
              <Steps platform={platform} />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
