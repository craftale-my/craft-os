import { describe, it, expect } from 'vitest'
import { memberLines, paxChildrenNote, money, toAscii, renderReceiptLines, renderRefundSlipLines, splitFromLine, lr, center, partLabel, renderPartReceiptLines, type PartReceiptPayload, type ReceiptPayload, type RefundSlipPayload } from './receipt'

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

describe('receipt discounts', () => {
  const base: ReceiptPayload = {
    kind: 'receipt', route: 'Bar', reprint: false,
    header: { title: 'Craft Cafe', legalName: null, registrationNo: null, sstNo: null, address: null, phone: null, email: null },
    billNo: 'B0001', closedAt: '2026-10-30T04:00:00.000Z', cashier: 'Ali', tableLabel: 'T1', pax: 2,
    items: [{ qty: 1, name: 'Baked Salmon Steak', unitSen: 4300, amountSen: 4300, mods: [],
              discounts: [{ label: 'Staff Meal 50%', amountSen: 2150 }, { label: 'Discount 10%', amountSen: 215 }] }],
    itemCount: 1, subtotalSen: 1935, billDiscountSen: 500, sstGroups: [], serviceChargeGroups: [],
    takeawayFeeSen: 0, roundingSen: 0, totalSen: 1435, payments: [], changeSen: 0, footer: 'Thank you',
  }
  it('prints each discount under its item and the bill discount under the subtotal', () => {
    const lines = renderReceiptLines(base, 32)
    const staff = lines.findIndex((l) => /^ {3}Staff Meal 50% +-21\.50$/.test(l))
    const own = lines.findIndex((l) => /^ {3}Discount 10% +-2\.15$/.test(l))
    const sub = lines.findIndex((l) => /^Subtotal +19\.35$/.test(l))
    expect(staff).toBeGreaterThan(lines.findIndex((l) => l.startsWith('1 Baked Salmon')))   // under its item (the name may wrap)
    expect(own).toBe(staff + 1)
    expect(sub).toBeGreaterThan(own)
    expect(lines[sub + 1]).toMatch(/^Discount +-5\.00$/)
    expect(lines.every((l) => l.length <= 32)).toBe(true)
  })
  it('a receipt queued before discounts existed prints as before', () => {
    const { billDiscountSen: _b, ...old } = base
    const lines = renderReceiptLines({ ...old, items: [{ ...base.items[0], discounts: undefined }] } as ReceiptPayload, 32)
    expect(lines.some((l) => l.includes('Discount'))).toBe(false)
  })
})

describe('split from (split bill §6)', () => {
  it('the line under the invoice number names the table bill and its table', () => {
    expect(splitFromLine({ billNo: '261116-009', table: 'T5' })).toBe('Split from 261116-009 · T5')
    expect(splitFromLine({ billNo: '261116-004', table: null })).toBe('Split from 261116-004')
  })
  it('prints under the invoice number, in ASCII', () => {
    const lines = renderReceiptLines({ ...r87846, splitFrom: { billNo: '261116-009', table: 'T5' } }, 48)
    const at = lines.findIndex((l) => l.startsWith('Invoice no'))
    expect(lines[at + 1]).toBe('Split from 261116-009 - T5')
    expect(lines[at + 2].startsWith('Date')).toBe(true)
  })
  it('a receipt with splitFrom null prints no such line', () => {
    expect(renderReceiptLines({ ...r87846, splitFrom: null }, 48)).toEqual(renderReceiptLines(r87846, 48))
  })
  it('maps the middle dot to a hyphen for the printer', () => {
    expect(toAscii('a · b')).toBe('a - b')
  })
})

describe('part payments on receipts (split bill §6)', () => {
  it('the final receipt labels each part\'s payment; a part\'s cash prints its amount', () => {
    const lines = renderReceiptLines({
      ...r87846,
      payments: [
        { name: 'Cash', kind: 'cash', amountSen: 2320, tenderedSen: null, reference: null, part: 1 },
        { name: 'Visa', kind: 'card', amountSen: 2320, tenderedSen: null, reference: 'A1', part: 2 },
        { name: 'Cash', kind: 'cash', amountSen: 4640, tenderedSen: 5000, reference: null, part: null },
      ],
      changeSen: 360,
    }, 48)
    expect(lines).toContain(lr('Part 1 - Cash', '23.20', 48)[0])
    expect(lines).toContain(lr('Part 2 - Visa', '23.20', 48)[0])
    expect(lines).toContain(lr('Cash', '50.00', 48)[0])
    expect(lines).toContain(lr('Change', '3.60', 48)[0])
  })

  it('a part receipt: the bill, then the part, its payment and change, paid before and the balance', () => {
    const part: PartReceiptPayload = {
      ...r87846, kind: 'part', partNo: 2, ways: 4, amountSen: 2320, paidBeforeSen: 2320, balanceSen: 4640,
      payments: [{ name: 'Cash', kind: 'cash', amountSen: 2320, tenderedSen: 5000, reference: null }], changeSen: 2680,
      footer: 'Part payment — the official receipt prints when the bill is paid in full.',
    }
    const lines = renderPartReceiptLines(part, 48)
    const total = lines.indexOf(lr('Total (MYR)', '92.80', 48)[0])
    expect(total).toBeGreaterThan(0)
    expect(lines.slice(total)).toEqual(expect.arrayContaining([
      center('Part 2 of 4', 48)[0].trimEnd(),
      lr('This part (MYR)', '23.20', 48)[0],
      lr('Cash', '50.00', 48)[0],
      lr('Change', '26.80', 48)[0],
      lr('Paid before', '23.20', 48)[0],
      lr('Balance due', '46.40', 48)[0],
    ]))
    expect(lines.join('\n')).toContain('Part payment - the official receipt')
    expect(lines.join('\n')).not.toContain('Charges summary')
  })

  it('labels a part with its N, or alone for a part by amount', () => {
    expect(partLabel(2, 3)).toBe('Part 2 of 3')
    expect(partLabel(2, null)).toBe('Part 2')
  })
})

describe('children in the pax (W7 spec §5)', () => {
  it('the words', () => {
    expect(paxChildrenNote(1)).toBe(' (1 child)')
    expect(paxChildrenNote(2)).toBe(' (2 children)')
    expect(paxChildrenNote(0)).toBe('')
    expect(paxChildrenNote(null)).toBe('')
    expect(paxChildrenNote(undefined)).toBe('')
  })
  it('the Table pax row says them; a receipt without paxChildren prints as before', () => {
    expect(renderReceiptLines({ ...r87846, paxChildren: 1 }, 48)).toContain(lr('Table pax', '4 (1 child)', 48)[0])
    expect(renderReceiptLines({ ...r87846, paxChildren: 2 }, 48)).toContain(lr('Table pax', '4 (2 children)', 48)[0])
    expect(renderReceiptLines({ ...r87846, paxChildren: null }, 48)).toEqual(renderReceiptLines(r87846, 48))
    expect(renderReceiptLines(r87846, 48)).toContain('Table pax                                      4')
  })
})

describe('member lines (members spec §3)', () => {
  it('"Member" and "Points earned" right after the Total band, before the payments', () => {
    const lines = renderReceiptLines({ ...r87846, member: { last4: '6789', pointsEarned: 92 } }, 48)
    const total = lines.findIndex((l) => l.startsWith('Total (MYR)'))
    expect(total).toBeGreaterThan(0)
    expect(lines[total + 1]).toBe('='.repeat(48))
    expect(lines[total + 2]).toBe('Member' + ' '.repeat(48 - 6 - 6) + '**6789')
    expect(lines[total + 3]).toBe('Points earned' + ' '.repeat(48 - 13 - 2) + '92')
    expect(lines[total + 4].startsWith("Touch 'n Go")).toBe(true)
  })
  it('nothing without a member, under 1 point, or on a receipt queued before members', () => {
    const plain = renderReceiptLines(r87846, 48)
    expect(renderReceiptLines({ ...r87846, member: null }, 48)).toEqual(plain)
    expect(renderReceiptLines({ ...r87846, member: { last4: '6789', pointsEarned: 0 } }, 48)).toEqual(plain)
    expect(plain.some((l) => l.startsWith('Member') || l.startsWith('Points earned'))).toBe(false)
  })
  it('fits a 32-column printer', () => {
    expect(memberLines({ last4: '0291', pointsEarned: 1 }, 32)).toEqual([
      'Member                    **0291',
      'Points earned                  1',
    ])
  })
})
