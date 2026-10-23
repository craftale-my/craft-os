import { describe, it, expect } from 'vitest'
import { jobLabel, renderJobLines, type JobPayload } from './printJob'
import { renderTicketLines, type TicketPayload } from './ticket'
import { renderReceiptLines, renderRefundSlipLines, type ReceiptPayload, type RefundSlipPayload } from './receipt'

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
