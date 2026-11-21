// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import BillColumn from './BillColumn'
import type { BillView } from './billView'
import { billView } from './billView'
import type { BillItemRow } from './posApi'

afterEach(cleanup)

const view: BillView = { sent: [], drafts: [], liveSentCount: 0, draftCount: 0, totals: null, totalsIncludeDrafts: true, sentSubtotalSen: 0, billDiscount: null, catalogTag: null }
const props = {
  title: 'Table T3', billNo: null, pax: null, onPax: null, catalogIsExtra: false, view,
  loading: false, loadError: null, notice: null, onSentTap: () => {}, onDraftTap: () => {}, onActions: () => {},
  onSend: () => {}, sendDisabled: true, sending: false, payLabel: 'Payment', payDisabled: true, payHint: null, onPay: () => {},
}

describe('BillColumn catalog control', () => {
  it('with no catalog chosen yet, offers Choose catalog', () => {
    const onCatalog = vi.fn()
    render(<BillColumn {...props} catalogName={null} onCatalog={onCatalog} />)
    fireEvent.click(screen.getByRole('button', { name: 'Choose catalog' }))
    expect(onCatalog).toHaveBeenCalledOnce()
  })

  it('no control when there is no catalog and nothing to choose', () => {
    render(<BillColumn {...props} catalogName={null} onCatalog={null} />)
    expect(screen.queryByRole('button', { name: 'Choose catalog' })).toBeNull()
  })
})

describe('BillColumn Goes well with', () => {
  it('a chip row under the drafts; a tap hands back the product', () => {
    const onPick = vi.fn()
    render(<BillColumn {...props} catalogName={null} onCatalog={null}
      goesWell={{ products: [{ id: 'c1', name: 'Butter Croissant' }, { id: 'c2', name: 'Basque Cheesecake' }], onPick }} />)
    expect(screen.getByRole('group', { name: 'Goes well with' }).textContent).toContain('Goes well with:')
    fireEvent.click(screen.getByRole('button', { name: 'Basque Cheesecake' }))
    expect(onPick).toHaveBeenCalledWith('c2')
  })

  it('no row without products', () => {
    render(<BillColumn {...props} catalogName={null} onCatalog={null} goesWell={null} />)
    expect(screen.queryByRole('group', { name: 'Goes well with' })).toBeNull()
  })
})

describe('BillColumn part payments', () => {
  it('the header says what the parts paid', () => {
    render(<BillColumn {...props} billNo="261117-001" catalogName={null} onCatalog={null} partPaidSen={2345} />)
    expect(screen.getByText('Part paid · RM 23.45')).toBeTruthy()
  })
  it('nothing without a part', () => {
    render(<BillColumn {...props} billNo="261117-001" catalogName={null} onCatalog={null} partPaidSen={0} />)
    expect(screen.queryByText(/Part paid/)).toBeNull()
  })
})

describe('BillColumn pax with children (W7 spec §5)', () => {
  it('reads "3 pax (1 child)", "4 pax (2 children)", or just the pax', () => {
    const { rerender } = render(<BillColumn {...props} pax={3} paxChildren={1} onPax={() => {}} catalogName={null} onCatalog={null} />)
    expect(screen.getByRole('button', { name: '3 pax (1 child)' })).toBeTruthy()
    rerender(<BillColumn {...props} pax={4} paxChildren={2} onPax={() => {}} catalogName={null} onCatalog={null} />)
    expect(screen.getByRole('button', { name: '4 pax (2 children)' })).toBeTruthy()
    rerender(<BillColumn {...props} pax={4} paxChildren={null} onPax={() => {}} catalogName={null} onCatalog={null} />)
    expect(screen.getByRole('button', { name: '4 pax' })).toBeTruthy()
  })
})

describe('BillColumn served lines (W7 spec §6)', () => {
  const row = (id: string, served: string | null): BillItemRow => ({
    id, order_id: 'o1', product_id: 'p1', name_snapshot: 'Latte', unit_price_sen: 900, sst_rate_bp: 600, takeaway_fee_sen: 0,
    order_type: 'dine_in', qty: 2, note: null, modifiers_snapshot: [], voided_at: null, catalog_discount_bp: 0, catalog_discount_name: null,
    discount_kind: null, discount_value: null, discount_reason: null, served_at: served,
    orders: { order_no: '1', source: 'counter', placed_at: '2026-11-22T02:00:00Z' },
  })
  it('a served line: ✓ before its name, muted; an unserved one as before', () => {
    const v = billView({ orderType: 'dine_in', tableId: 't1', items: [row('i1', '2026-11-22T03:00:00Z'), row('i2', null)],
      lines: [], menu: null, info: new Map(), billing: null })
    render(<BillColumn {...props} view={v} catalogName={null} onCatalog={null} />)
    const [served, open] = screen.getAllByRole('button', { name: /× Latte/ })
    expect(served.textContent).toMatch(/^✓ 2 × Latte/)
    expect(served.className).toContain('text-brown-muted')
    expect(open.textContent).toMatch(/^2 × Latte/)
    expect(open.className).not.toContain('text-brown-muted')
  })
})
