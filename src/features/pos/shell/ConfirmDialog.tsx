// src/features/pos/shell/ConfirmDialog.tsx
/** The POS's own confirm dialog (spec §3). The built-in browser pane and some iPad states dismiss
 *  window.confirm by themselves, so no POS screen uses it. Callers keep a ConfirmRequest in state
 *  and render this while it is set. */
export interface ConfirmRequest {
  title: string
  message?: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void
}

export default function ConfirmDialog({ title, message, confirmLabel, cancelLabel = 'Cancel', danger = false, busy = false, onConfirm, onCancel }: {
  title: string
  message?: string
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={busy ? undefined : onCancel}>
      <div role="dialog" aria-modal="true" aria-label={title} className="w-full max-w-sm rounded-2xl bg-card p-5 shadow-card"
        onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-brown-dark">{title}</h2>
        {message && <p className="mt-1 text-sm text-brown-muted">{message}</p>}
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button type="button" onClick={onCancel} disabled={busy}
            className="min-h-12 rounded-xl border border-border-mid text-brown-dark disabled:opacity-40">{cancelLabel}</button>
          <button type="button" onClick={onConfirm} disabled={busy}
            className={`min-h-12 rounded-xl font-medium text-white disabled:opacity-40 ${danger ? 'bg-red-700 hover:bg-red-800' : 'bg-brown-btn hover:bg-brown-btn-hover'}`}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
