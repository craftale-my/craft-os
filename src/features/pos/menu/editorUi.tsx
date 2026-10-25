// src/features/pos/menu/editorUi.tsx
/** Small pieces every /menu page shares: the look of inputs and buttons, and the
 *  outcome line a save shows next to the section that made it. */
import { useEffect, useState, type ReactNode } from 'react'
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

/** The "saved" message a create passes on through navigation state, captured once on
 *  first render: the state is then cleared from the history entry (so a reload does
 *  not show it again) while the message stays on screen. */
export function useSavedNotice(): string | null {
  const location = useLocation()
  const navigate = useNavigate()
  const [saved] = useState(() => (location.state as { saved?: string } | null)?.saved ?? null)
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

/** The header every /menu page shares: the title with a count chip, a hint under it, and the page's
 *  actions on the right. */
export function PageHeader({ title, count, hint, children }: {
  title: string; count?: number | null; hint?: ReactNode; children?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
          {title}
          {count != null && (
            <span className="rounded-full border border-border bg-card px-2 py-0.5 text-sm font-medium text-brown-muted">{count}</span>
          )}
        </h1>
        {hint && <p className="mt-1 text-sm text-brown-muted">{hint}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  )
}

/** /menu tables: a box that scrolls on its own (so the header can stick), row hover, numbers right-aligned. */
export const tableBoxCls = 'max-h-[calc(100vh-14rem)] overflow-auto rounded-xl border border-border bg-card'
export const tableCls = 'w-full text-sm'
export const theadCls = 'sticky top-0 z-10 bg-card text-left text-brown-muted shadow-[0_1px_0_theme(colors.border)]'
export const thCls = 'px-3 py-2 font-medium'
export const tdCls = 'px-3 py-2 align-middle'
export const rowCls = 'border-t border-border hover:bg-cream'
export const numCls = 'text-right tabular-nums'
