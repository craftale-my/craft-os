// src/features/pos/order/usePadWindows.ts
import { useEffect, useRef, useState } from 'react'
import { fetchMenuWindows } from './posApi'
import { NO_WINDOWS, serverNow, type MenuWindows } from './padSlots'
import { useMinuteClock } from './useMinuteClock'

/** The order pad's time slots: pos_menu_windows for the pad's catalog, read again at the start
 *  of every minute so a schedule edit reaches an open pad within a minute. A failed read keeps
 *  the last windows of this catalog (none at first) and the next minute tries again — the
 *  server refuses anything out of its slot anyway. `now` is the server's time at that minute. */
export function usePadWindows(catalogId: string | null): { windows: MenuWindows; now: Date } {
  const tick = useMinuteClock()
  const [held, setHeld] = useState<{ catalogId: string; windows: MenuWindows } | null>(null)
  const seq = useRef(0)
  useEffect(() => {
    const mine = ++seq.current                                   // a slow reply never overwrites a newer one
    if (!catalogId) return
    fetchMenuWindows(catalogId).then(
      (windows) => { if (mine === seq.current) setHeld({ catalogId, windows }) },
      () => { /* keep the last windows; the next minute tries again */ },
    )
  }, [catalogId, tick])
  // never another catalog's windows
  const windows = held && held.catalogId === catalogId ? held.windows : NO_WINDOWS
  return { windows, now: serverNow(windows, tick) }
}
