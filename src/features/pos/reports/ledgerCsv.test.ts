import { describe, expect, it } from 'vitest'
import { billsCsv, linesCsv, paymentsCsv } from './ledgerCsv'
import { LEDGER } from './testReports'

describe('the ledger export (spec §5.12)', () => {
  it('bills.csv: one row per paid bill', () => {
    expect(billsCsv(LEDGER.bills)).toBe(
      '﻿Outlet,Business date,Closed at,Bill no,Order type,Table,Pax,Gross,Discounts,Takeaway fee,Service charge,SST,Rounding,Total,Refunded\r\n'
      + 'Cheras,2026-01-05,2026-01-05 12:00,CH-0001,Dine-in,T1,2,20.00,0.80,0.00,0.00,1.18,0.02,20.40,0.00\r\n'
      + 'Cheras,2026-01-06,2026-01-06 10:00,CH-0003,Takeaway,,,28.40,0.00,0.00,0.00,2.27,-0.02,30.65,3.00\r\n')
  })
  it('lines.csv: one row per live line, its SST share', () => {
    expect(linesCsv(LEDGER.lines)).toBe(
      '﻿Outlet,Bill no,Item,Qty,Unit price,Catalog discount,Item discount,Bill discount share,Net,SST rate (%),SST\r\n'
      + 'Cheras,CH-0001,Cake,1,8.00,0.00,0.80,0.00,7.20,8,0.58\r\n'
      + 'Cheras,CH-0003,"Muffin, large",1,10.20,0.00,0.00,0.00,10.20,8,0.82\r\n')
  })
  it('payments.csv: one row per payment, the part number of a part payment', () => {
    expect(paymentsCsv(LEDGER.payments)).toBe(
      '﻿Outlet,Bill no,Part no,Method,Kind,Amount,Tendered,Change,Reference,Taken at\r\n'
      + 'Cheras,CH-0003,,Cash,cash,30.65,50.00,19.35,,2026-01-06 10:00\r\n'
      + 'Cheras,CH-0005,1,Card,card,10.00,,0.00,APP 123,2026-01-06 13:50\r\n')
  })
})
