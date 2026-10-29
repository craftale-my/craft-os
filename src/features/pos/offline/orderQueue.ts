/** Counter orders are written to the device FIRST and sent second, so an
 *  order the cashier has confirmed survives a dropped connection, a closed
 *  tab or a dead battery. The server dedupes on clientOrderId, which makes
 *  resending always safe — including after a send whose reply was lost. */

import type { OrderLine } from '../order/cart'
import { contextCode } from '../deviceErrors'

export type OrderType = 'dine_in' | 'takeaway'

export interface QueuedOrder {
  clientOrderId: string
  orderType: OrderType
  tableId: string | null // null = takeaway
  pax: number | null
  items: OrderLine[]
  queuedAt: number
  failedReason: string | null // set when the server rejected it; never resent automatically
  /** The menu catalog the cart was priced from. Absent on orders queued before
   *  catalogs existed: the server then uses the branch's default for the order type. */
  catalogId?: string | null
  /** Who was signed in on this tablet when Send was pressed (the POS app). Absent on a Craft OS
   *  login and on older orders: the server then records the caller. */
  staffId?: string | null
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
  /** Reason of the retryable failure that stopped this flush; null if none did. */
  lastError: string | null
}

export function newQueuedOrder(
  orderType: OrderType,
  tableId: string | null,
  pax: number | null,
  items: OrderLine[],
  now: number = Date.now(),
  id: string = crypto.randomUUID(),
  catalogId: string | null = null,
): QueuedOrder {
  return {
    clientOrderId: id, orderType, tableId, pax,
    items: items.map((l) => ({ ...l, optionIds: [...l.optionIds] })),
    queuedAt: now, failedReason: null, catalogId,
  }
}

/** The arguments of place_counter_order for a queued order. */
export function counterOrderArgs(o: QueuedOrder) {
  return {
    p_table_id: o.tableId, p_order_type: o.orderType, p_pax: o.pax, p_items: o.items,
    p_client_order_id: o.clientOrderId, p_catalog_id: o.catalogId ?? null, p_staff_id: o.staffId ?? null,
  }
}

export async function enqueue(store: QueueStore, order: QueuedOrder): Promise<void> {
  await store.put(order)
}

export async function flushQueue(store: QueueStore, send: Sender): Promise<FlushReport> {
  const queued = (await store.all()).sort((a, b) => a.queuedAt - b.queuedAt)
  let sent = 0
  let lastError: string | null = null
  for (const order of queued) {
    if (order.failedReason) continue
    let res: SendResult
    try {
      res = await send(order)
    } catch (e) {
      // A throwing sender must not lose the flush: keep the order, stop here.
      res = { ok: false, retryable: true, reason: e instanceof Error ? e.message : String(e) }
    }
    if (res.ok) {
      await store.remove(order.clientOrderId)
      sent++
      continue
    }
    if (res.retryable) {
      lastError = res.reason
      break // still offline — keep order, try again later
    }
    await store.put({ ...order, failedReason: res.reason })
  }
  const left = await store.all()
  return {
    sent,
    pending: left.filter((o) => !o.failedReason).length,
    stuck: left.filter((o) => o.failedReason).length,
    lastError,
  }
}

/** Only these server-confirmed Postgres errors are final. Anything else —
 *  network failures, expired JWT, 502/503/504, statement timeout, aborts — is
 *  retried, which is always safe because the server dedupes on client_order_id. */
const FINAL_ERROR_CODES = new Set([
  'P0001', // raise_exception — the RPC's own business-rule rejections, e.g. "Item is not available"
  '23514', // check_violation — e.g. qty out of range
  '22P02', // invalid_text_representation — e.g. malformed uuid
  '23503', // foreign_key_violation
])

export function toSendResult(error: { message: string; code?: string } | null): SendResult {
  if (!error) return { ok: true }
  // the tablet is locked, unpaired or its outlet closed: keep the order for the next sign-in
  if (contextCode(error.message)) return { ok: false, retryable: true, reason: error.message }
  const final = error.code !== undefined && FINAL_ERROR_CODES.has(error.code)
  return { ok: false, retryable: !final, reason: error.message }
}
