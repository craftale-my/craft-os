// src/features/pos/order/useMinuteClock.ts
import { useEffect, useState } from 'react'
import { msUntilServerMinute } from './padSlots'

/** This iPad's Date.now(), refreshed just after the start of every minute of the server's clock
 *  (`offsetMs` = how far the server is ahead of this iPad): time slots open and close on the
 *  server's minute, so the pad re-evaluates them then. A new offset re-arms the timer. */
export function useMinuteClock(offsetMs = 0): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let timer = setTimeout(function tick() {
      setNow(Date.now())
      timer = setTimeout(tick, msUntilServerMinute(Date.now(), offsetMs))
    }, msUntilServerMinute(Date.now(), offsetMs))
    return () => clearTimeout(timer)
  }, [offsetMs])
  return now
}
