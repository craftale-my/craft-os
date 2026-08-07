import { useEffect, useState } from 'react'
import { X, Share, SquarePlus, Download } from 'lucide-react'
import {
  isStandalone, isIos, installHintDismissed, dismissInstallHint,
} from '../lib/pwa'

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/**
 * Nudges people to put Craft OS on their home screen, because none of the
 * installed-app work is visible until they do.
 *
 * Android/desktop Chrome fires `beforeinstallprompt` and hands us a real
 * installer. iOS fires nothing and has no API, so all we can do there is show
 * the two-step Share ▸ Add to Home Screen recipe.
 *
 * Renders inside AppLayout, so it never covers the login form.
 */
export function InstallPrompt() {
  const [installer, setInstaller] = useState<BeforeInstallPromptEvent | null>(null)
  const [showIosHint, setShowIosHint] = useState(false)

  useEffect(() => {
    if (isStandalone() || installHintDismissed()) return

    const onBeforeInstall = (e: Event) => {
      // Suppress Chrome's own mini-infobar in favour of our styled card.
      e.preventDefault()
      setInstaller(e as BeforeInstallPromptEvent)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstall)

    // Stop nagging the moment the install actually lands.
    const onInstalled = () => { setInstaller(null); setShowIosHint(false) }
    window.addEventListener('appinstalled', onInstalled)

    if (isIos()) setShowIosHint(true)

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  function dismiss() {
    dismissInstallHint()
    setInstaller(null)
    setShowIosHint(false)
  }

  async function install() {
    if (!installer) return
    await installer.prompt()
    // Either they installed it or they said no; don't ask twice.
    dismiss()
  }

  if (!installer && !showIosHint) return null

  return (
    <div
      className="fixed z-40 left-3 right-3
                 bottom-[calc(var(--tabbar-h)+var(--safe-bottom)+0.75rem)]
                 sm:left-auto sm:right-4 sm:bottom-4 sm:w-80"
      role="dialog"
      aria-label="Install Craft OS"
    >
      <div className="relative rounded-2xl bg-card shadow-card-hover border border-border p-4 pr-10">
        <button
          onClick={dismiss}
          aria-label="Dismiss"
          className="absolute top-2.5 right-2.5 p-1 text-brown-faint hover:text-brown-dark transition-colors"
        >
          <X size={16} />
        </button>

        <div className="flex items-start gap-3">
          <img
            src="/icons/icon-192.png"
            alt=""
            className="w-10 h-10 rounded-xl flex-shrink-0 shadow-card"
          />
          <div className="min-w-0">
            <p className="text-sm font-semibold text-brown-dark leading-snug">
              Add Craft OS to your home screen
            </p>
            <p className="text-xs text-brown-muted mt-0.5 leading-relaxed">
              Opens full screen, like an app — no address bar.
            </p>
          </div>
        </div>

        {installer ? (
          <button
            onClick={install}
            className="mt-3 w-full flex items-center justify-center gap-2 rounded-xl
                       bg-[#C4813A] hover:bg-[#A86C2C] transition-colors
                       px-4 py-2.5 text-sm font-semibold text-white"
          >
            <Download size={15} />
            Install
          </button>
        ) : (
          <ol className="mt-3 space-y-1.5 text-xs text-brown-dark">
            <li className="flex items-center gap-2">
              <span className="flex-shrink-0 w-4 text-brown-faint font-semibold">1</span>
              <Share size={14} className="flex-shrink-0 text-[#C4813A]" />
              <span>Tap Share in the Safari toolbar</span>
            </li>
            <li className="flex items-center gap-2">
              <span className="flex-shrink-0 w-4 text-brown-faint font-semibold">2</span>
              <SquarePlus size={14} className="flex-shrink-0 text-[#C4813A]" />
              <span>Choose <b className="font-semibold">Add to Home Screen</b></span>
            </li>
          </ol>
        )}
      </div>
    </div>
  )
}
