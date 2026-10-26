// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import BillColumn from './BillColumn'
import type { BillView } from './billView'

afterEach(cleanup)

const view: BillView = { sent: [], drafts: [], liveSentCount: 0, draftCount: 0, totals: null, totalsIncludeDrafts: true }
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
