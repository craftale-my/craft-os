import { useCallback, useEffect, useRef, useState } from 'react'
import { createIdbStore } from '../offline/idbStore'
import { enqueue, flushQueue, type FlushReport, type QueuedOrder } from '../offline/orderQueue'
import { sendCounterOrder } from './posApi'

const store = createIdbStore()

/** Enqueue-then-send: the order is on this iPad's disk before anything goes on
 *  the wire, and flush runs on mount, when the network comes back, every 15 s,
 *  and after every submit. One flush at a time; a request during a flush runs
 *  one more pass afterwards. */
export function useOrderQueue() {
  const [report, setReport] = useState<FlushReport | null>(null)
  const [stuck, setStuck] = useState<QueuedOrder[]>([])
  const inFlight = useRef<Promise<void> | null>(null)
  const again = useRef(false)

  const refreshStuck = useCallback(async () => {
    setStuck((await store.all()).filter((o) => o.failedReason !== null))
  }, [])

  const flush = useCallback(async (): Promise<void> => {
    if (inFlight.current) { again.current = true; return inFlight.current }
    inFlight.current = (async () => {
      try {
        do {
          again.current = false
          setReport(await flushQueue(store, sendCounterOrder))
        } while (again.current)
        await refreshStuck()
      } finally { inFlight.current = null }
    })()
    return inFlight.current
  }, [refreshStuck])

  useEffect(() => {
    void navigator.storage?.persist?.()
    void flush()
    const onOnline = () => void flush()
    window.addEventListener('online', onOnline)
    const timer = window.setInterval(() => void flush(), 15_000)
    return () => { window.removeEventListener('online', onOnline); window.clearInterval(timer) }
  }, [flush])

  const submit = useCallback(async (o: QueuedOrder) => {
    await enqueue(store, o)         // throws if the device refused to store it — caller keeps the cart
    await flush()
  }, [flush])

  const discard = useCallback(async (clientOrderId: string) => {
    await store.remove(clientOrderId)
    await refreshStuck()
  }, [refreshStuck])

  return { submit, report, flush, stuck, discard }
}
