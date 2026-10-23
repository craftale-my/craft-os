import { describe, it, expect } from 'vitest'
import { money, toAscii, renderReceiptLines, renderRefundSlipLines, type ReceiptPayload, type RefundSlipPayload } from './receipt'

// Receipt #87846 (Craft Cafe Cheras, 22/10/2026): the four prices, the totals and the
// payment are the real ones; item names, header numbers and the time are placeholders
// (see the plan's open points) — the layout is what this test pins.
const r87846: ReceiptPayload = {
  kind: 'receipt', route: 'Bar', reprint: false,
  header: {
    title: 'Craft Cafe – Cheras', legalName: 'Craftale Sdn Bhd', registrationNo: '000000-X', sstNo: 'W10-0000-00000000',
    address: 'Taman Connaught, 56000 Cheras, Kuala Lumpur', phone: '03-0000 0000', email: 'cheras@example.com',
  },
  billNo: '87846', closedAt: '2026-10-22T05:12:00.000Z', cashier: 'Aina', tableLabel: 'T7', pax: 4,
  items: [
    { qty: 1, name: 'Chicken Chop', unitSen: 2400, amountSen: 2400, mods: [] },
    { qty: 1, name: 'Beef Lasagna', unitSen: 2500, amountSen: 2500, mods: [] },
    { qty: 1, name: 'Carbonara', unitSen: 1800, amountSen: 1800, mods: [] },
    { qty: 1, name: 'Coffee Latte (COLD)', unitSen: 1300, amountSen: 1300, mods: ['Oat milk'] },
  ],
  itemCount: 4,
  subtotalSen: 8000,
  sstGroups: [{ rateBp: 600, baseSen: 8000, amountSen: 480 }],
  serviceChargeGroups: [{ rateBp: 1000, baseSen: 8000, amountSen: 800 }],
  takeawayFeeSen: 0, roundingSen: 0, totalSen: 9280,
  payments: [{ name: "Touch 'n Go", kind: 'ewallet', amountSen: 9280, tenderedSen: null, reference: null }],
  changeSen: 0,
  footer: 'This is an official receipt. Thank you for visiting us.',
}

describe('money / toAscii', () => {
  it('formats sen as ringgit with a sign', () => {
    expect(money(9280)).toBe('92.80')
    expect(money(-2)).toBe('-0.02')
    expect(money(0)).toBe('0.00')
  })
  it('maps look-alikes to ASCII and anything else to ?', () => {
    expect(toAscii('Craft Cafe – Cheras')).toBe('Craft Cafe - Cheras')
    expect(toAscii('拿铁 Latte')).toBe('?? Latte')
  })
})

describe('renderReceiptLines', () => {
  it('reproduces receipt #87846 at 48 columns', () => {
    expect(renderReceiptLines(r87846, 48)).toEqual([
      '              Craft Cafe - Cheras',
      '                Craftale Sdn Bhd',
      '                REG NO: 000000-X',
      '           SST NO: W10-0000-00000000',
      '  Taman Connaught, 56000 Cheras, Kuala Lumpur',
      '               TEL: 03-0000 0000',
      '               cheras@example.com',
      '',
      'Invoice no                                 87846',
      'Date                            22/10/2026 13:12',
      'Cashier                                     Aina',
      'Table pax                                      4',
      '                    ORDER T7',
      '------------------------------------------------',
      '1 Chicken Chop (24.00/ea)                  24.00',
      '1 Beef Lasagna (25.00/ea)                  25.00',
      '1 Carbonara (18.00/ea)                     18.00',
      '1 Coffee Latte (COLD) (13.00/ea)           13.00',
      '   + Oat milk',
      '------------------------------------------------',
      'Item count                                     4',
      'Subtotal                                   80.00',
      'SST (6%)                                    4.80',
      'SERVICE CHARGE (10%)                        8.00',
      'Bill rounding                               0.00',
      '================================================',
      'Total (MYR)                                92.80',
      '================================================',
      "Touch 'n Go                                92.80",
      'Change                                      0.00',
      '------------------------------------------------',
      'Charges summary',
      '                             Base Amt     Amount',
      'SST 6%                          80.00       4.80',
      'SERVICE CHARGE 10%              80.00       8.00',
      '------------------------------------------------',
      '   This is an official receipt. Thank you for',
      '                  visiting us.',
    ])
  })

  it('takeaway cash reprint: banner, no table, taxed packaging fee, rounding, tendered and change', () => {
    const out = renderReceiptLines({
      ...r87846, reprint: true, tableLabel: null, pax: null,
      items: [
        { qty: 2, name: 'Coffee Latte (COLD)', unitSen: 1300, amountSen: 2600, mods: [] },
        { qty: 1, name: 'Burnt Cheesecake', unitSen: 1250, amountSen: 1250, mods: [] },
      ],
      itemCount: 3, subtotalSen: 3850,
      // the packaging fee is taxed with its line (owner, 2026-10-24): SST base 38.50 + 3.00
      sstGroups: [{ rateBp: 600, baseSen: 4150, amountSen: 249 }], serviceChargeGroups: [],
      takeawayFeeSen: 300, roundingSen: 1, totalSen: 4400,
      payments: [{ name: 'Cash', kind: 'cash', amountSen: 4400, tenderedSen: 5000, reference: null }],
      changeSen: 600,
    }, 48)
    expect(out[0]).toBe('                *** REPRINT ***')
    expect(out).toContain('                    TAKEAWAY')
    expect(out).not.toContain('Table pax                                      4')
    expect(out).toContain('2 Coffee Latte (COLD) (13.00/ea)           26.00')
    expect(out).toContain('Takeaway packaging                          3.00')
    expect(out).toContain('SST (6%)                                    2.49')
    expect(out).toContain('Bill rounding                               0.01')
    expect(out).toContain('Total (MYR)                                44.00')
    expect(out).toContain('Cash                                       50.00')
    expect(out).toContain('Change                                      6.00')
    expect(out).toContain('SST 6%                          41.50       2.49')
    expect(out).not.toContain('SERVICE CHARGE 10%              80.00       8.00')
  })

  it('prints a payment reference under the payment and wraps a long item name', () => {
    const out = renderReceiptLines({
      ...r87846,
      items: [{ qty: 1, name: 'Fried Chicken Curry DON with extra sauce on the side', unitSen: 2400, amountSen: 2400, mods: [] }],
      payments: [{ name: 'Maybank Terminal', kind: 'card', amountSen: 9280, tenderedSen: null, reference: '004512' }],
    }, 48)
    expect(out).toContain('1 Fried Chicken Curry DON with extra sauce 24.00')
    expect(out).toContain('   on the side (24.00/ea)')
    expect(out).toContain('Maybank Terminal                           92.80')
    expect(out).toContain('  Ref: 004512')
  })

  it('every line fits the paper and is plain ASCII', () => {
    for (const l of renderReceiptLines(r87846, 48)) {
      expect(l.length).toBeLessThanOrEqual(48)
      expect(/^[\x20-\x7e]*$/.test(l)).toBe(true)
    }
  })
})

describe('renderRefundSlipLines', () => {
  it('lays out a refund slip', () => {
    const s: RefundSlipPayload = {
      kind: 'refund', route: 'Bar', title: 'Craft Cafe – Cheras', billNo: '261024-007', refundedAt: '2026-10-24T06:30:00.000Z',
      amountSen: 1300, methodName: 'Cash', reason: 'Item not served', refundedBy: 'Aina', approvedBy: 'Mei Ling',
    }
    expect(renderRefundSlipLines(s, 48)).toEqual([
      '              Craft Cafe - Cheras',
      '                     REFUND',
      '',
      'Invoice no                            261024-007',
      'Date                            24/10/2026 14:30',
      'Refunded by                                 Aina',
      'Approved by                             Mei Ling',
      '------------------------------------------------',
      'Refund (MYR)                               13.00',
      'Paid back by                                Cash',
      'Reason: Item not served',
      '------------------------------------------------',
    ])
  })
})
