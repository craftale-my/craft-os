// Explicit .ts extensions: the Node print agent loads this file directly (no bundler).
import { docText, lineWidth, textBlocks, type DocBlock, type PrintDoc } from './doc.ts'
import { formatMyt, renderTicketLines, type TicketPayload } from './ticket.ts'
import { partLabel, renderPartReceiptLines, renderReceiptLines, renderRefundSlipLines, type PartReceiptPayload, type ReceiptPayload, type RefundSlipPayload } from './receipt.ts'
import { renderZReportLines, type ZReportPayload } from './zreport.ts'

/** A drawer kick (W4 spec §5): prints nothing; the receipt printer pulses its cash drawer. pos_queue_drawer
 *  builds exactly this (print_jobs.kind stays 'receipt'). Queued before the receipt of the same payment. */
export interface DrawerPayload {
  kind: 'drawer'
  route: string
  reason: string | null // Payment, Part payment, Refund, Pay in, Pay out, or the Open drawer reason
}

/** Everything a print_jobs.payload can hold. Both print hosts (the Node agent and the iPad page) render
 *  through renderJobDoc / renderJobLines, so a new kind is added here once. */
export type JobPayload = TicketPayload | ReceiptPayload | PartReceiptPayload | RefundSlipPayload | ZReportPayload | DrawerPayload

const plain = (lines: string[]): PrintDoc => ({ fontSize: 'normal', paper: true, blocks: textBlocks(lines) })
const callNoBlock = (callNo: string | null | undefined): DocBlock[] => (callNo ? [{ type: 'text', text: callNo, big: true }] : [])

/** A receipt or part receipt: the call number big, the logo, the lines at the font's width, the footer QR.
 *  A payload queued before W4 has none of them: normal font, its lines only. */
function receiptDoc<P extends ReceiptPayload | PartReceiptPayload>(p: P, cols: number, render: (p: P, cols: number) => string[]): PrintDoc {
  const fontSize = p.fontSize ?? 'normal'
  const logo = p.header.logo
  return {
    fontSize,
    paper: true,
    blocks: [
      ...callNoBlock(p.callNo),
      ...(logo ? [{ type: 'image' as const, width: logo.width, height: logo.height, data: logo.data }] : []),
      ...textBlocks(render(p, lineWidth(fontSize, cols))),
      ...(p.footerQr ? [{ type: 'qr' as const, data: p.footerQr }] : []),
    ],
  }
}

/** The document a job prints at `cols` characters a line (the print agent encodes it with encodeEscPosDoc). */
export function renderJobDoc(payload: JobPayload, cols: number): PrintDoc {
  switch (payload.kind) {
    case 'ticket':
      return { fontSize: 'normal', paper: true, blocks: [...callNoBlock(payload.callNo), ...textBlocks(renderTicketLines(payload, cols))] }
    case 'receipt':
      return receiptDoc(payload, cols, renderReceiptLines)
    case 'part':
      return receiptDoc(payload, cols, renderPartReceiptLines)
    case 'refund':
      return plain(renderRefundSlipLines(payload, cols))
    case 'zreport':
      return plain(renderZReportLines(payload, cols))
    case 'drawer':
      return { fontSize: 'normal', paper: false, blocks: [{ type: 'pulse' }] }
    default:
      throw new Error(`Unknown print job kind: ${String((payload as { kind?: unknown }).kind)}`)
  }
}

/** The text view (tests, Epson ePOS, Star WebPRNT): normal font at `cols`, the call number centred as plain
 *  text, no logo, QR or pulse. An old payload gives exactly its renderer's lines. */
export function renderJobLines(payload: JobPayload, cols: number): string[] {
  const normal: JobPayload = payload.kind === 'receipt' || payload.kind === 'part' ? { ...payload, fontSize: 'normal' } : payload
  return docText(renderJobDoc(normal, cols), cols)
}

/** One line for the printer-problems list: what this job is. */
export function jobLabel(payload: JobPayload): string {
  if (payload.kind === 'receipt') return `Receipt ${payload.billNo}${payload.tableLabel ? ` · ${payload.tableLabel}` : ' · takeaway'}`
  if (payload.kind === 'part') return `Part receipt ${payload.billNo} · ${partLabel(payload.partNo, payload.ways)}`
  if (payload.kind === 'refund') return `Refund slip ${payload.billNo}`
  if (payload.kind === 'zreport') return `Z report ${formatMyt(payload.report.closedAt)}${payload.reprint ? ' · REPRINT' : ''}`
  if (payload.kind === 'drawer') return `Cash drawer · ${payload.reason ?? 'Open'}`
  return `${payload.orderNo}${payload.tableLabel ? ` · ${payload.tableLabel}` : ' · takeaway'}${payload.void ? ' · VOID' : ''}`
}
