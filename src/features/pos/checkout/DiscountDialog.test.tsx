// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import DiscountDialog from './DiscountDialog'

afterEach(cleanup)

describe('DiscountDialog', () => {
  it('a quick percent shows what comes off and hands the discount on', () => {
    const onNext = vi.fn()
    render(<DiscountDialog title="Discount bill" summary="Bill B0001 · RM 43.00" baseSen={4300} initial={null} onNext={onNext} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '10%' }))
    expect(screen.getByRole('status').textContent).toBe('−RM 4.30')
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(onNext).toHaveBeenCalledWith({ kind: 'percent', value: 1000 })
  })
  it('an amount stops at the base; a bad value keeps Next off and says why', () => {
    const onNext = vi.fn()
    render(<DiscountDialog title="Discount item" summary="1 × Latte · RM 13.00" baseSen={1300} initial={null} onNext={onNext} onClose={() => {}} />)
    fireEvent.click(screen.getByRole('radio', { name: 'Amount' }))
    fireEvent.change(screen.getByLabelText('Amount (RM)'), { target: { value: '20' } })
    expect(screen.getByRole('status').textContent).toBe('−RM 13.00')
    fireEvent.change(screen.getByLabelText('Amount (RM)'), { target: { value: '0' } })
    expect(screen.getByRole('status').textContent).toBe('Enter an amount above RM 0.00')
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true)
  })
  it('editing starts from the discount on the bill', () => {
    render(<DiscountDialog title="Discount item" summary="s" baseSen={1000} initial={{ kind: 'amount', value: 250 }} onNext={() => {}} onClose={() => {}} />)
    expect((screen.getByLabelText('Amount (RM)') as HTMLInputElement).value).toBe('2.50')
  })
})
