import { describe, it, expect } from 'vitest'
import { tableCards, takeawayBills } from './tableStatus'

const t = (id: string, label: string, paused = false) => ({ id, label, qr_token: 'x', qr_paused: paused, is_active: true, sort_order: 0, area: null })
const b = (id: string, table_id: string | null) => ({ id, bill_no: '261023-001', table_id, order_type: table_id ? 'dine_in' as const : 'takeaway' as const, pax: null, opened_at: '2026-10-23T02:00:00Z' })

describe('tableCards', () => {
  it('marks tables empty, open or new and keeps the bill', () => {
    const cards = tableCards([t('t1', 'T1'), t('t2', 'T2', true), t('t3', 'T3')], [b('b2', 't2'), b('b3', 't3'), b('b9', null)], new Set(['b3']))
    expect(cards.map((c) => [c.label, c.state, c.paused, c.bill?.id ?? null])).toEqual([
      ['T1', 'empty', false, null], ['T2', 'open', true, 'b2'], ['T3', 'new', false, 'b3'],
    ])
  })
  it('takeaway bills are the ones without a table', () => {
    expect(takeawayBills([b('b2', 't2'), b('b9', null)]).map((x) => x.id)).toEqual(['b9'])
  })
})
