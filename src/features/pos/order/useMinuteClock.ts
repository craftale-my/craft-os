// src/features/pos/order/useMinuteClock.ts
import { useEffect, useState } from 'react'

/** This iPad's Date.now(), refreshed just after the start of every minute: time slots open
 *  and close on the minute, so the pad re-evaluates them once a minute while it is open. */
export function useMinuteClock(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const untilNextMinute = () => 60_000 - (Date.now() % 60_000) + 50
    let timer = setTimeout(function tick() {
      setNow(Date.now())
      timer = setTimeout(tick, untilNextMinute())
    }, untilNextMinute())
    return () => clearTimeout(timer)
  }, [])
  return now
}
