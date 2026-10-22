/** Counter orders are written to the device FIRST and sent second, so an
 *  order the cashier has confirmed survives a dropped connection, a closed
 *  tab or a dead battery. The server dedupes on clientOrderId, which makes
 *  resending always safe — including after a send whose reply was lost. */

export interface CartLine {
  menuItemId: string
  qty: number
  note: string | null
}

export interface QueuedOrder {
  clientOrderId: string
  tableId: string | null // null = takeaway
  items: CartLine[]
  queuedAt: number
  failedReason: string | null // set when the server rejected it; never resent automatically
}

export interface QueueStore {
  put(o: QueuedOrder): Promise<void>
  all(): Promise<QueuedOrder[]>
  remove(clientOrderId: string): Promise<void>
}

export type SendResult = { ok: true } | { ok: false; retryable: boolean; reason: string }
export type Sender = (o: QueuedOrder) => Promise<SendResult>

export interface FlushReport {
  sent: number
  pending: number
  stuck: number
}

export function newQueuedOrder(
  tableId: string | null,
  items: CartLine[],
  now: number = Date.now(),
  id: string = crypto.randomUUID(),
): QueuedOrder {
  return { clientOrderId: id, tableId, items: items.map((l) => ({ ...l })), queuedAt: now, failedReason: null }
}

export async function enqueue(store: QueueStore, order: QueuedOrder): Promise<void> {
  await store.put(order)
}

export async function flushQueue(store: QueueStore, send: Sender): Promise<FlushReport> {
  const queued = (await store.all()).sort((a, b) => a.queuedAt - b.queuedAt)
  let sent = 0
  for (const order of queued) {
    if (order.failedReason) continue
    const res = await send(order)
    if (res.ok) {
      await store.remove(order.clientOrderId)
      sent++
      continue
    }
    if (res.retryable) break // still offline — keep order, try again later
    await store.put({ ...order, failedReason: res.reason })
  }
  const left = await store.all()
  return {
    sent,
    pending: left.filter((o) => !o.failedReason).length,
    stuck: left.filter((o) => o.failedReason).length,
  }
}

// Chrome: "Failed to fetch"; Safari: "Load failed"; Firefox: "NetworkError…"; Node: "fetch failed"
const NETWORK_ERROR = /failed to fetch|load failed|networkerror|network request failed|fetch failed/i

export function toSendResult(error: { message: string } | null): SendResult {
  if (!error) return { ok: true }
  return { ok: false, retryable: NETWORK_ERROR.test(error.message), reason: error.message }
}
