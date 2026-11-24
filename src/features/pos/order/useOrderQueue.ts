import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createIdbStore } from '../offline/idbStore'
import { enqueue, flushQueue, type FlushReport, type QueuedOrder } from '../offline/orderQueue'
import { makeFlusher } from '../offline/flusher'
import { sendCounterOrder } from './posApi'

const store = createIdbStore()
const SUBMIT_WAIT_MS = 9_000

export interface SubmitResult { clientOrderId: string; rejectedReason: string | null }

/** Enqueue-then-send: the order is on this iPad's disk before anything goes on
 *  the wire, and flush runs on mount, when the network comes back, every 15 s,
 *  and after every submit. One flush at a time; a request during any part of a
 *  pass runs one more pass afterwards (see makeFlusher). Call this ONCE, in a
 *  component that outlives the order pad. */
export function useOrderQueue() {
  const [report, setReport] = useState<FlushReport | null>(null)
  const [stuck, setStuck] = useState<QueuedOrder[]>([])
  const [discardError, setDiscardError] = useState<string | null>(null)

  const refreshStuck = useCallback(async () => {
    setStuck((await store.all()).filter((o) => o.failedReason !== null))
  }, [])

  const flushRaw = useMemo(() => makeFlusher(async () => {
    setReport(await flushQueue(store, sendCounterOrder))
    await refreshStuck() // inside the pass, so a request during it still triggers another pass
  }), [refreshStuck])

  /** Never rejects — background callers have nobody to catch. */
  const flush = useCallback(
    () => flushRaw().catch((e) => { console.warn('[pos] queue flush failed', e) }),
    [flushRaw],
  )

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    void navigator.storage?.persist?.()
    void flush()
    const onOnline = () => void flush()
    window.addEventListener('online', onOnline)
    const timer = window.setInterval(() => void flush(), 15_000)
    return () => { mounted.current = false; window.removeEventListener('online', onOnline); window.clearInterval(timer) }
  }, [flush])

  /** Rejects ONLY if the order could not be stored on this device. After that
   *  it resolves: it waits for one flush attempt, but never longer than
   *  SUBMIT_WAIT_MS (the flush keeps running in the background), then reports
   *  whether the server rejected this order. */
  const submit = useCallback(async (o: QueuedOrder): Promise<SubmitResult> => {
    await enqueue(store, o)
    let timer: number | undefined
    const wait = new Promise<void>((r) => { timer = window.setTimeout(r, SUBMIT_WAIT_MS) })
    await Promise.race([flush(), wait])
    window.clearTimeout(timer)
    let rejectedReason: string | null = null
    try { rejectedReason = (await store.all()).find((x) => x.clientOrderId === o.clientOrderId)?.failedReason ?? null }
    catch (e) { console.warn('[pos] could not re-read queue', e) }
    return { clientOrderId: o.clientOrderId, rejectedReason }
  }, [flush])

  const discard = useCallback(async (clientOrderId: string) => {
    try { await store.remove(clientOrderId); setDiscardError(null) }
    catch (e) { setDiscardError(e instanceof Error ? e.message : String(e)) }
    try { await refreshStuck() } catch (e) { console.warn('[pos] refresh failed', e) }
  }, [refreshStuck])

  return { submit, report, flush, stuck, discard, discardError }
}
