import { describe, it, expect } from 'vitest'
import { jobLabel, renderJobDoc, renderJobLines, type DrawerPayload, type JobPayload } from './printJob'
import { renderTicketLines, type TicketPayload } from './ticket'
import { renderPartReceiptLines, renderReceiptLines, renderRefundSlipLines, type PartReceiptPayload, type ReceiptPayload, type RefundSlipPayload } from './receipt'
import { encodeEscPosDoc } from './escpos'

const ticket: TicketPayload = {
  kind: 'ticket', route: 'Kitchen', tableLabel: 'T2', orderNo: '261024-003/1', source: 'counter',
  placedAt: '2026-10-24T04:00:00.000Z', lines: [{ qty: 1, name: 'Carbonara', note: null, mods: [] }],
}
const receipt: ReceiptPayload = {
  kind: 'receipt', route: 'Bar', reprint: false,
  header: { title: 'Craft Cafe', legalName: null, registrationNo: null, sstNo: null, address: null, phone: null, email: null },
  billNo: '261024-003', closedAt: '2026-10-24T05:00:00.000Z', cashier: 'Aina', tableLabel: null, pax: null,
  items: [{ qty: 1, name: 'Carbonara', unitSen: 1800, amountSen: 1800, mods: [] }], itemCount: 1,
  subtotalSen: 1800, sstGroups: [], serviceChargeGroups: [], takeawayFeeSen: 0, roundingSen: 0, totalSen: 1800,
  payments: [{ name: 'Cash', kind: 'cash', amountSen: 1800, tenderedSen: 2000, reference: null }], changeSen: 200, footer: 'Thanks',
}
const refund: RefundSlipPayload = {
  kind: 'refund', route: 'Bar', title: 'Craft Cafe', billNo: '261024-003', refundedAt: '2026-10-24T06:00:00.000Z',
  amountSen: 1800, methodName: 'Cash', reason: null, refundedBy: 'Aina', approvedBy: 'Aina',
}

describe('renderJobLines', () => {
  it('renders each kind with its own renderer', () => {
    expect(renderJobLines(ticket, 42)).toEqual(renderTicketLines(ticket, 42))
    expect(renderJobLines(receipt, 48)).toEqual(renderReceiptLines(receipt, 48))
    expect(renderJobLines(refund, 48)).toEqual(renderRefundSlipLines(refund, 48))
  })
  it('refuses a payload it does not know', () => {
    expect(() => renderJobLines({ kind: 'label' } as unknown as JobPayload, 42)).toThrow('Unknown print job kind: label')
  })
})

describe('jobLabel', () => {
  it('names the job for the printer-problems list', () => {
    expect(jobLabel(ticket)).toBe('261024-003/1 · T2')
    expect(jobLabel({ ...ticket, tableLabel: null, void: true })).toBe('261024-003/1 · takeaway · VOID')
    expect(jobLabel(receipt)).toBe('Receipt 261024-003 · takeaway')
    expect(jobLabel(refund)).toBe('Refund slip 261024-003')
  })
})

describe('part receipts (split bill §6)', () => {
  const part = {
    kind: 'part', route: 'Bar', reprint: false,
    header: { title: 'Craft Cafe', legalName: null, registrationNo: null, sstNo: null, address: null, phone: null, email: null },
    billNo: '261117-003', closedAt: '2026-11-17T06:00:00.000Z', cashier: 'Aina', tableLabel: 'T5', pax: 3,
    items: [{ qty: 1, name: 'Set A', unitSen: 7035, amountSen: 7035, mods: [] }], itemCount: 1, subtotalSen: 7035, billDiscountSen: 0,
    sstGroups: [], serviceChargeGroups: [], takeawayFeeSen: 0, roundingSen: 0, totalSen: 7035,
    partNo: 1, ways: 3, amountSen: 2345, paidBeforeSen: 0, balanceSen: 4690,
    payments: [{ name: 'Cash', kind: 'cash', amountSen: 2345, tenderedSen: 5000, reference: null }], changeSen: 2655,
    footer: 'Part payment — the official receipt prints when the bill is paid in full.',
  } satisfies PartReceiptPayload
  it('renders through renderPartReceiptLines and is labelled with its part', () => {
    expect(renderJobLines(part, 42)).toEqual(renderPartReceiptLines(part, 42))
    expect(jobLabel(part)).toBe('Part receipt 261117-003 · Part 1 of 3')
  })
})

describe('renderJobDoc (W4 spec §4)', () => {
  const text = (lines: string[]) => lines.map((t) => ({ type: 'text' as const, text: t }))
  const logo = { width: 16, height: 2, data: '/wAP8A==' }
  const styled: ReceiptPayload = {
    ...receipt, callNo: 'TA012', fontSize: 'small', footerQr: 'https://g.page/r/craft', header: { ...receipt.header, logo },
  }
  const part: PartReceiptPayload = {
    kind: 'part', route: 'Bar', reprint: false, callNo: 'TA012', fontSize: 'large', footerQr: null,
    header: { title: 'Craft Cafe', legalName: null, registrationNo: null, sstNo: null, address: null, phone: null, email: null, logo: null },
    billNo: '261122-003', closedAt: '2026-11-22T06:00:00.000Z', cashier: 'Aina', tableLabel: null, pax: null,
    items: [{ qty: 1, name: 'Set A', unitSen: 3000, amountSen: 3000, mods: [] }], itemCount: 1, subtotalSen: 3000, billDiscountSen: 0,
    sstGroups: [], serviceChargeGroups: [], takeawayFeeSen: 0, roundingSen: 0, totalSen: 3000,
    partNo: 1, ways: 2, amountSen: 1500, paidBeforeSen: 0, balanceSen: 1500,
    payments: [{ name: 'Cash', kind: 'cash', amountSen: 1500, tenderedSen: 2000, reference: null }], changeSen: 500,
    footer: 'Part payment — the official receipt prints when the bill is paid in full.',
  }
  const kick: DrawerPayload = { kind: 'drawer', route: 'Bar', reason: 'Give change' }

  it('an old receipt (no W4 fields) prints as before: normal font, its lines and nothing else', () => {
    expect(renderJobDoc(receipt, 42)).toEqual({ fontSize: 'normal', paper: true, blocks: text(renderReceiptLines(receipt, 42)) })
    expect(renderJobLines(receipt, 42)).toEqual(renderReceiptLines(receipt, 42))
  })
  it('a receipt: the call number big, the logo, the lines at the Font B width, the QR under the footer', () => {
    expect(renderJobDoc(styled, 42)).toEqual({
      fontSize: 'small', paper: true,
      blocks: [{ type: 'text', text: 'TA012', big: true }, { type: 'image', ...logo }, ...text(renderReceiptLines(styled, 56)),
               { type: 'qr', data: 'https://g.page/r/craft' }],
    })
  })
  it('large: double height, the same characters per line', () => {
    const doc = renderJobDoc({ ...styled, fontSize: 'large' }, 42)
    expect(doc.fontSize).toBe('large')
    expect(doc.blocks.filter((b) => b.type === 'text' && !b.big)).toEqual(text(renderReceiptLines(styled, 42)))
  })
  it('the text view (Epson, Star): normal width, the call number centred, no logo or QR', () => {
    expect(renderJobLines(styled, 42)).toEqual([`${' '.repeat(18)}TA012`, ...renderReceiptLines(styled, 42)])
  })
  it('a part receipt the same way', () => {
    expect(renderJobDoc(part, 42)).toEqual({
      fontSize: 'large', paper: true, blocks: [{ type: 'text', text: 'TA012', big: true }, ...text(renderPartReceiptLines(part, 42))],
    })
  })
  it('a ticket: its call number big on top; an old ticket as before', () => {
    expect(renderJobDoc({ ...ticket, tableLabel: null, callNo: 'TA012' }, 42)).toEqual({
      fontSize: 'normal', paper: true,
      blocks: [{ type: 'text', text: 'TA012', big: true }, ...text(renderTicketLines({ ...ticket, tableLabel: null }, 42))],
    })
    expect(renderJobDoc(ticket, 42)).toEqual({ fontSize: 'normal', paper: true, blocks: text(renderTicketLines(ticket, 42)) })
    expect(renderJobLines(ticket, 42)).toEqual(renderTicketLines(ticket, 42))
  })
  it('a refund slip: its lines', () => {
    expect(renderJobDoc(refund, 48)).toEqual({ fontSize: 'normal', paper: true, blocks: text(renderRefundSlipLines(refund, 48)) })
  })
  it('a drawer kick: no paper, one pulse, no text; labelled with its reason', () => {
    expect(renderJobDoc(kick, 42)).toEqual({ fontSize: 'normal', paper: false, blocks: [{ type: 'pulse' }] })
    expect(renderJobLines(kick, 42)).toEqual([])
    expect(Array.from(encodeEscPosDoc(renderJobDoc(kick, 42)))).toEqual([0x1b, 0x40, 0x1b, 0x70, 0x00, 25, 250])
    expect(jobLabel(kick)).toBe('Cash drawer · Give change')
    expect(jobLabel({ ...kick, reason: null })).toBe('Cash drawer · Open')
  })
})
