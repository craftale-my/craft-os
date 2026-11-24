// src/features/pos/order/rejectedOrder.ts
import type { QueuedOrder } from '../offline/orderQueue'
import type { OrderLine } from './cart'
import type { OrderTarget } from './orderTarget'

/** How the order screen reopens a rejected queued order: same table (with the pax it was sent
 *  with) or a new takeaway, same lines, and the same catalog (null for an order queued before
 *  catalogs existed, which the screen then prices from the branch default). */
export function padFromRejected(o: QueuedOrder): { target: OrderTarget; lines: OrderLine[]; catalogId: string | null } {
  return {
    target: o.tableId ? { kind: 'table', tableId: o.tableId, pax: o.pax } : { kind: 'takeaway', billId: null },
    lines: o.items,
    catalogId: o.catalogId ?? null,
  }
}
