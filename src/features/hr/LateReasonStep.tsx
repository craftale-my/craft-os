import { useState } from 'react'
import {
  LATE_REASON_CODES, LATE_REASON_LABELS, isLateReasonComplete, requiresWrittenExplanation,
  type LateReasonCode,
} from '../../shared/lib/lateReason'
import { AlertTriangle } from 'lucide-react'

/** Shown after a late clock-in and before it is written. Deliberately has no
 *  close control: the shift is already recorded as late, the only way out is to
 *  say why. */
export function LateReasonStep({
  lateMinutes, shiftStart, thresholdMinutes, saving, error, onSubmit,
}: {
  lateMinutes: number
  shiftStart: string
  thresholdMinutes: number
  saving: boolean
  /** A write that did not land. It has to be shown in here: this step covers the
   *  whole screen, so a banner on the card underneath would be behind the
   *  dimmer, unreadable, while the staff member waits for something to happen. */
  error?: string | null
  onSubmit: (r: { code: LateReasonCode; note: string }) => void
}) {
  const [code, setCode] = useState<LateReasonCode | null>(null)
  const [note, setNote] = useState('')
  const mustWrite = requiresWrittenExplanation(lateMinutes, thresholdMinutes)
  const complete = isLateReasonComplete({ code, note, lateMinutes, thresholdMinutes })

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-end sm:items-center justify-center p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="late-reason-heading" className="bg-white rounded-2xl w-full max-w-md p-5 space-y-4">
        <div>
          <p id="late-reason-heading" className="font-semibold text-brown-dark">
            You are {lateMinutes} {lateMinutes === 1 ? 'minute' : 'minutes'} late for your {shiftStart} shift
          </p>
          <p className="text-sm text-brown-faint mt-1">
            Please tell your supervisor why. This will be recorded.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-2">
          {LATE_REASON_CODES.map(c => (
            <button
              key={c}
              onClick={() => setCode(c)}
              className="px-3 py-2 rounded-xl text-sm font-semibold border transition-colors"
              style={code === c
                ? { background: '#FBF0E6', color: '#8B5A2B', borderColor: '#C4813A' }
                : { background: '#F5EDE0', color: '#8B7355', borderColor: 'transparent' }}
            >
              {LATE_REASON_LABELS[c]}
            </button>
          ))}
        </div>

        {mustWrite && (
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            rows={3}
            placeholder={`Explain what happened (required for lateness over ${thresholdMinutes} min)`}
            className="w-full px-3 py-2 rounded-xl border border-[#D4C5B0] text-sm text-brown-dark"
          />
        )}

        {error && (
          <div
            role="alert"
            className="flex items-start gap-2 bg-[#FCF0EC] text-[#9E4A30] text-sm font-medium px-3 py-2 rounded-xl border border-[#E8BCAE]"
          >
            <AlertTriangle size={15} className="shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <button
          disabled={!complete || saving}
          onClick={() => code && onSubmit({ code, note: note.trim() })}
          className="w-full py-3 rounded-xl bg-[#3D7A50] text-white text-sm font-semibold disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Submit'}
        </button>
      </div>
    </div>
  )
}
