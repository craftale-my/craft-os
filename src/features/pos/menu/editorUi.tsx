// src/features/pos/menu/editorUi.tsx
/** Small pieces every /menu page shares: the look of inputs and buttons, and the
 *  outcome line a save shows next to the section that made it. */
import { useEffect, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

export const inputCls = 'rounded border border-border bg-card px-2 py-1 text-sm'
export const btnCls = 'rounded bg-brown-btn px-3 py-2 text-sm text-white hover:bg-brown-btn-hover disabled:opacity-40'
export const linkBtnCls = 'rounded border border-border px-2 py-1 text-sm hover:bg-cream disabled:opacity-40'

export type Outcome = { kind: 'ok' | 'error'; text: string }
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function OutcomeLine({ outcome }: { outcome: Outcome | null }) {
  if (!outcome) return null
  return outcome.kind === 'error'
    ? <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{outcome.text}</p>
    : <p role="status" className="rounded bg-green-50 px-3 py-2 text-sm text-green-800">{outcome.text}</p>
}

/** While `dirty`, closing or reloading the tab asks first (the browser's own prompt). */
export function useUnsavedWarning(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = '' }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])
}

/** The "saved" message a create passes on through navigation state, read once: it is
 *  then cleared, so a reload does not show it again. */
export function useSavedNotice(): string | null {
  const location = useLocation()
  const navigate = useNavigate()
  const saved = (location.state as { saved?: string } | null)?.saved ?? null
  useEffect(() => {
    if (saved) navigate(location.pathname, { replace: true, state: null })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return saved
}

/** A titled box; `problem` is the first thing in it that stops a save. */
export function Section({ title, hint, problem, children }: {
  title: string; hint?: string; problem?: string | null; children: ReactNode
}) {
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-4">
      <div>
        <h2 className="font-semibold">{title}</h2>
        {hint && <p className="text-xs text-brown-muted">{hint}</p>}
      </div>
      {children}
      {problem && <p role="alert" className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">{problem}</p>}
    </section>
  )
}
