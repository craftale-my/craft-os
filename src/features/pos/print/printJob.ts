// Explicit .ts extensions: the Node print agent loads this file directly (no bundler).
import { renderTicketLines, type TicketPayload } from './ticket.ts'
import { renderReceiptLines, renderRefundSlipLines, type ReceiptPayload, type RefundSlipPayload } from './receipt.ts'

/** Everything a print_jobs.payload can hold. Both print hosts (the Node agent
 *  and the iPad page) render through renderJobLines, so a new kind is added here once. */
export type JobPayload = TicketPayload | ReceiptPayload | RefundSlipPayload

export function renderJobLines(payload: JobPayload, cols: number): string[] {
  switch (payload.kind) {
    case 'ticket':
      return renderTicketLines(payload, cols)
    case 'receipt':
      return renderReceiptLines(payload, cols)
    case 'refund':
      return renderRefundSlipLines(payload, cols)
    default:
      throw new Error(`Unknown print job kind: ${String((payload as { kind?: unknown }).kind)}`)
  }
}

/** One line for the printer-problems list: what this job is. */
export function jobLabel(payload: JobPayload): string {
  if (payload.kind === 'receipt') return `Receipt ${payload.billNo}${payload.tableLabel ? ` · ${payload.tableLabel}` : ' · takeaway'}`
  if (payload.kind === 'refund') return `Refund slip ${payload.billNo}`
  return `${payload.orderNo}${payload.tableLabel ? ` · ${payload.tableLabel}` : ' · takeaway'}${payload.void ? ' · VOID' : ''}`
}
