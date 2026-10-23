// src/features/pos/order/rejectedOrder.ts
import type { QueuedOrder } from '../offline/orderQueue'
import type { OrderLine } from './cart'
import type { PadMode } from './OrderPad'

/** How the order pad reopens a rejected queued order: same table or takeaway, same
 *  lines, and the same catalog (null for an order queued before catalogs existed,
 *  which the pad then prices from the branch default). */
export function padFromRejected(o: QueuedOrder): { mode: PadMode; lines: OrderLine[]; catalogId: string | null } {
  return {
    mode: o.tableId
      ? { orderType: 'dine_in', tableId: o.tableId, needsPax: o.pax != null, initialPax: o.pax ?? undefined }
      : { orderType: 'takeaway' },
    lines: o.items,
    catalogId: o.catalogId ?? null,
  }
}
