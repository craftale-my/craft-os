// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import HomeScreen from './HomeScreen'
import type { OpenBillRow, TableRow } from './posApi'

afterEach(cleanup)

const table: TableRow = { id: 't5', label: 'T5', qr_token: 'q5', qr_paused: false, is_active: true, sort_order: 1, area: null }
const open = (id: string, tableId: string | null): OpenBillRow => ({
  id, bill_no: `261117-00${id.slice(1)}`, table_id: tableId, order_type: tableId ? 'dine_in' : 'takeaway', pax: 2,
  opened_at: new Date().toISOString(), discount_kind: null, discount_value: null, discount_reason: null,
})

describe('HomeScreen part payments (split spec §3.5)', () => {
  it('a table tile and a takeaway with a part paid say "Part paid · RM x"', () => {
    const bills = [open('b1', 't5'), open('b2', null)]
    const summaries = new Map([
      ['b1', { billId: 'b1', totalSen: 7035, itemCount: 1, paidSen: 2345 }],
      ['b2', { billId: 'b2', totalSen: 3000, itemCount: 1, paidSen: 1000 }],
    ])
    render(<HomeScreen tables={[table]} bills={bills} summaries={summaries} newBillIds={new Set()} banners={null}
      onRefresh={() => {}} onPickTable={() => {}} onPickBill={() => {}} onNewTakeaway={() => {}} />)
    expect(screen.getByText('Part paid · RM 23.45')).toBeTruthy()
    expect(screen.getByText('Part paid · RM 10.00')).toBeTruthy()
  })
  it('no tag without a part', () => {
    render(<HomeScreen tables={[table]} bills={[open('b1', 't5')]} summaries={new Map([['b1', { billId: 'b1', totalSen: 7035, itemCount: 1, paidSen: 0 }]])}
      newBillIds={new Set()} banners={null} onRefresh={() => {}} onPickTable={() => {}} onPickBill={() => {}} onNewTakeaway={() => {}} />)
    expect(screen.queryByText(/Part paid/)).toBeNull()
  })
})

describe('HomeScreen call numbers (W4 spec §2)', () => {
  it('a takeaway with a call number: "TA012 · Takeaway", its bill number under it', () => {
    render(<HomeScreen tables={[table]} bills={[{ ...open('b2', null), call_no: 'TA012' }]} summaries={new Map()} newBillIds={new Set()}
      banners={null} onRefresh={() => {}} onPickTable={() => {}} onPickBill={() => {}} onNewTakeaway={() => {}} />)
    expect(screen.getByText('TA012 · Takeaway')).toBeTruthy()
    expect(screen.getByText(/^261117-002 · \d+m$/)).toBeTruthy()
  })
  it('a takeaway from before W4: its bill number, "Takeaway" under it', () => {
    render(<HomeScreen tables={[table]} bills={[open('b2', null)]} summaries={new Map()} newBillIds={new Set()}
      banners={null} onRefresh={() => {}} onPickTable={() => {}} onPickBill={() => {}} onNewTakeaway={() => {}} />)
    expect(screen.getByText('261117-002')).toBeTruthy()
    expect(screen.getByText(/^Takeaway · \d+m$/)).toBeTruthy()
  })
})
