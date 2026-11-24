// Test data for the report tabs: the verify script's numbers (outlet "Cheras", bills CH-0001…), typed
// against reportsApi. Imported by tests only.
import type {
  AuditReport, DrawerReport, LedgerReport, PaymentsReport, ProductsReport, ReportQuery, SalesReport, SstReport,
} from './reportsApi'

export const Q: ReportQuery = { outlets: ['b1'], from: '2026-01-05', to: '2026-01-06' }

const HOURS: Record<number, [number, number]> = { 1: [1, 1910], 10: [1, 3065], 12: [1, 2040], 13: [2, 1260], 14: [1, 1925] }

export const SALES: SalesReport = {
  current: { nettSen: 10200, bills: 6, pax: 7, discountSen: 280, voidSen: 400, refundSen: 300 },
  previous: { nettSen: 1060, bills: 1, pax: 2, discountSen: 0, voidSen: 0, refundSen: 0 },
  daily: [
    { branchId: 'b1', outlet: 'Cheras', day: '2026-01-05', bills: 2, pax: 3, grossSen: 4000, discountSen: 280, takeawayFeeSen: 0,
      serviceChargeSen: 0, sstSen: 226, roundingSen: 4, nettSen: 3950, refundSen: 0 },
    { branchId: 'b1', outlet: 'Cheras', day: '2026-01-06', bills: 4, pax: 4, grossSen: 5840, discountSen: 0, takeawayFeeSen: 0,
      serviceChargeSen: 0, sstSen: 411, roundingSen: -1, nettSen: 6250, refundSen: 300 },
  ],
  hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, bills: HOURS[hour]?.[0] ?? 0, nettSen: HOURS[hour]?.[1] ?? 0 })),
  summary: {
    beforeDiscountsSen: 9840, catalogDiscountSen: 0, itemDiscountSen: 80, billDiscountSen: 200, grossSen: 9560,
    takeawayFeeSen: 0, serviceChargeSen: 0, sstSen: 637, roundingSen: 3, nettSen: 10200,
  },
  orderTypes: [{ orderType: 'dine_in', bills: 5, nettSen: 7135 }, { orderType: 'takeaway', bills: 1, nettSen: 3065 }],
  sources: [{ source: 'counter', orders: 4, itemSen: 8040 }, { source: 'qr', orders: 1, itemSen: 1800 }],
  topProducts: [
    { name: 'Latte', qty: 5, valueSen: 5000 }, { name: 'Cake', qty: 3, valueSen: 2400 },
    { name: 'Muffin', qty: 2, valueSen: 2040 }, { name: 'Water', qty: 2, valueSen: 400 },
  ],
}

export const PRODUCTS: ProductsReport = {
  products: [
    { name: 'Latte', category: 'Drinks', qty: 5, grossSen: 5000, discountSen: 200, netSen: 4800 },
    { name: 'Cake', category: 'Food', qty: 3, grossSen: 2400, discountSen: 80, netSen: 2320 },
    { name: 'Muffin', category: 'Food', qty: 2, grossSen: 2040, discountSen: 0, netSen: 2040 },
    { name: 'Water', category: null, qty: 2, grossSen: 400, discountSen: 0, netSen: 400 },
  ],
  addOns: [{ name: 'Oat milk', count: 2, valueSen: 300 }, { name: 'Extra shot', count: 2, valueSen: 200 }],
  categories: [
    { category: 'Drinks', qty: 5, netSen: 4800 }, { category: 'Food', qty: 5, netSen: 4360 }, { category: null, qty: 2, netSen: 400 },
  ],
}

export const PAYMENTS: PaymentsReport = {
  methods: [
    { name: 'Card', kind: 'card', count: 4, amountSen: 4300, refundCount: 0, refundSen: 0, netSen: 4300 },
    { name: 'Cash', kind: 'cash', count: 3, amountSen: 5900, refundCount: 1, refundSen: 300, netSen: 5600 },
  ],
}

export const SST: SstReport = {
  rates: [{ rateBp: 600, baseSen: 4800, sstSen: 288 }, { rateBp: 800, baseSen: 4360, sstSen: 349 }],
  exemptSen: 400,
  months: [
    { month: '2025-12', rates: [{ rateBp: 600, baseSen: 1000, sstSen: 60 }], exemptSen: 0 },
    { month: '2026-01', rates: [{ rateBp: 600, baseSen: 3800, sstSen: 228 }, { rateBp: 800, baseSen: 4360, sstSen: 349 }], exemptSen: 400 },
  ],
}

export const AUDIT: AuditReport = {
  discounts: [
    { at: '2026-01-05T03:40:00.000Z', outlet: 'Cheras', billNo: 'CH-0001', item: null, action: 'set', kind: 'amount', value: 100,
      reason: 'Regular', by: 'Aina', approvedBy: 'Ben' },
    { at: '2026-01-05T03:45:00.000Z', outlet: 'Cheras', billNo: 'CH-0001', item: null, action: 'clear', kind: 'amount', value: 100,
      reason: 'Regular', by: 'Aina', approvedBy: null },
    { at: '2026-01-05T03:50:00.000Z', outlet: 'Cheras', billNo: 'CH-0001', item: 'Cake', action: 'set', kind: 'percent', value: 1000,
      reason: 'Regular', by: 'Aina', approvedBy: 'Ben' },
    { at: '2026-01-05T05:05:00.000Z', outlet: 'Cheras', billNo: 'CH-0002', item: null, action: 'set', kind: 'amount', value: 200,
      reason: 'Regular', by: 'Aina', approvedBy: 'Ben' },
  ],
  discountTotals: { catalogSen: 0, catalogBills: 0, itemSen: 80, itemCount: 1, billSen: 200, billCount: 1 },
  voidItems: [
    { at: '2026-01-05T05:00:00.000Z', outlet: 'Cheras', billNo: 'CH-0002', name: 'Water', qty: 1, valueSen: 200,
      reason: 'Wrong item keyed', by: 'Aina', approvedBy: 'Ben' },
    { at: '2026-01-06T07:00:00.000Z', outlet: 'Cheras', billNo: 'CH-0008', name: 'Water', qty: 1, valueSen: 200,
      reason: 'Guest left', by: 'Aina', approvedBy: 'Ben' },
  ],
  voidBills: [
    { at: '2026-01-06T07:00:00.000Z', outlet: 'Cheras', billNo: 'CH-0008', valueSen: 200, reason: 'Guest left', by: 'Aina', approvedBy: 'Ben' },
  ],
  refunds: [
    { at: '2026-01-06T02:30:00.000Z', outlet: 'Cheras', billNo: 'CH-0003', method: 'Cash', amountSen: 300, reason: 'Cold cake', approvedBy: 'Ben' },
  ],
}

export const EMPTY_AUDIT: AuditReport = {
  discounts: [],
  discountTotals: { catalogSen: 0, catalogBills: 0, itemSen: 0, itemCount: 0, billSen: 0, billCount: 0 },
  voidItems: [],
  voidBills: [],
  refunds: [],
}

export const DRAWER: DrawerReport = {
  shifts: [
    { outlet: 'Cheras', openedAt: '2026-01-06T00:00:00.000Z', closedAt: '2026-01-06T14:00:00.000Z', openedBy: 'Aina', closedBy: 'Aina',
      floatSen: 10000, cashSalesSen: 3990, cashRefundSen: 300, payInSen: 2000, payOutSen: 500, noSaleOpens: 2, expectedSen: 15190,
      countedSen: 15150, varianceSen: -40, reason: 'Short at close' },
    { outlet: 'Cheras', openedAt: '2026-01-06T12:00:00.000Z', closedAt: null, openedBy: 'Aina', closedBy: null,
      floatSen: 10000, cashSalesSen: 1910, cashRefundSen: 0, payInSen: 0, payOutSen: 0, noSaleOpens: 0, expectedSen: 11910,
      countedSen: null, varianceSen: null, reason: null },
  ],
}

export const LEDGER: LedgerReport = {
  bills: [
    { outlet: 'Cheras', businessDate: '2026-01-05', closedAt: '2026-01-05T04:00:00.000Z', billNo: 'CH-0001', orderType: 'dine_in',
      table: 'T1', pax: 2, grossSen: 2000, discountSen: 80, takeawayFeeSen: 0, serviceChargeSen: 0, sstSen: 118, roundingSen: 2,
      totalSen: 2040, refundedSen: 0 },
    { outlet: 'Cheras', businessDate: '2026-01-06', closedAt: '2026-01-06T02:00:00.000Z', billNo: 'CH-0003', orderType: 'takeaway',
      table: null, pax: null, grossSen: 2840, discountSen: 0, takeawayFeeSen: 0, serviceChargeSen: 0, sstSen: 227, roundingSen: -2,
      totalSen: 3065, refundedSen: 300 },
  ],
  lines: [
    { outlet: 'Cheras', billNo: 'CH-0001', item: 'Cake', qty: 1, unitPriceSen: 800, catalogDiscountSen: 0, itemDiscountSen: 80,
      billShareSen: 0, netSen: 720, sstRateBp: 800, sstSen: 58 },
    { outlet: 'Cheras', billNo: 'CH-0003', item: 'Muffin, large', qty: 1, unitPriceSen: 1020, catalogDiscountSen: 0, itemDiscountSen: 0,
      billShareSen: 0, netSen: 1020, sstRateBp: 800, sstSen: 82 },
  ],
  payments: [
    { outlet: 'Cheras', billNo: 'CH-0003', partNo: null, method: 'Cash', kind: 'cash', amountSen: 3065, tenderedSen: 5000,
      changeSen: 1935, reference: null, takenAt: '2026-01-06T02:00:00.000Z' },
    { outlet: 'Cheras', billNo: 'CH-0005', partNo: 1, method: 'Card', kind: 'card', amountSen: 1000, tenderedSen: null,
      changeSen: 0, reference: 'APP 123', takenAt: '2026-01-06T05:50:00.000Z' },
  ],
}
