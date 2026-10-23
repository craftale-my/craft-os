// src/features/pos/order/usePadWindows.ts
import { useEffect, useRef, useState } from 'react'
import { fetchMenuWindows } from './posApi'
import { NO_WINDOWS, serverNow, slotProblem, type MenuWindows } from './padSlots'
import { useMinuteClock } from './useMinuteClock'

export interface PadWindows {
  windows: MenuWindows
  /** The server's time at this render. */
  now: Date
  /** The pre-send check: pos_insert_order's words for the first line outside its slots, or null.
   *  Judged by the server's time now; when a line looks out of its slot the windows are read
   *  again first, so a schedule changed within the last minute is not refused by an old copy
   *  (a failed read keeps the last windows' answer). */
  check: (lines: { productId: string }[], nameOf: (productId: string) => string) => Promise<string | null>
}

/** The order pad's time slots: pos_menu_windows for the pad's catalog, read again just after the
 *  start of every minute of the server's clock, so a schedule edit reaches an open pad within a
 *  minute and a slot opens and closes on the server's minute. A failed read keeps the last windows
 *  of this catalog (none at first) and the next minute tries again — the server refuses anything
 *  out of its slot anyway. */
export function usePadWindows(catalogId: string | null): PadWindows {
  const [held, setHeld] = useState<{ catalogId: string; windows: MenuWindows } | null>(null)
  // never another catalog's windows
  const windows = held && held.catalogId === catalogId ? held.windows : NO_WINDOWS
  const tick = useMinuteClock(windows.offsetMs)
  const seq = useRef(0)
  useEffect(() => {
    const mine = ++seq.current                                   // a slow reply never overwrites a newer one
    if (!catalogId) return
    fetchMenuWindows(catalogId).then(
      (windows) => { if (mine === seq.current) setHeld({ catalogId, windows }) },
      () => { /* keep the last windows; the next minute tries again */ },
    )
  }, [catalogId, tick])

  const check: PadWindows['check'] = async (lines, nameOf) => {
    const local = slotProblem(windows, lines, nameOf, serverNow(windows, Date.now()))
    if (!local || !catalogId) return local
    const mine = ++seq.current
    let fresh: MenuWindows
    try { fresh = await fetchMenuWindows(catalogId) } catch { return local }
    if (mine === seq.current) setHeld({ catalogId, windows: fresh })
    return slotProblem(fresh, lines, nameOf, serverNow(fresh, Date.now()))
  }
  // evaluated at render with this iPad's clock now (not the tick's), moved to the server's time
  return { windows, now: serverNow(windows, Date.now()), check }
}
