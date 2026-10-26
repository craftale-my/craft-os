// src/features/pos/shift/useShiftOpen.ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchShiftStatus } from './shiftApi'

/** Whether the branch has an open shift, for the home banner and the Payment button (spec §1–2):
 *  true / false, or null until the first read answers. Read again on every POS refresh
 *  (`refreshKey`) and on reload() (ShiftBar calls it after opening or closing a shift). A failed
 *  read keeps the last answer: checkout_bill refuses a payment with no open shift anyway. */
export function useShiftOpen(refreshKey: number): { open: boolean | null; reload: () => void } {
  const [open, setOpen] = useState<boolean | null>(null)
  const seq = useRef(0)
  const reload = useCallback(() => {
    const id = ++seq.current                       // only the newest reply counts
    fetchShiftStatus().then((s) => { if (id === seq.current) setOpen(s.shift !== null) }, () => undefined)
  }, [])
  useEffect(() => { reload() }, [reload, refreshKey])
  return { open, reload }
}
