// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import Bars from './Bars'

afterEach(cleanup)
const bars = (n: number) => Array.from({ length: n }, (_, i) => ({ label: String(i + 1), valueSen: 100 * (i + 1) }))

describe('Bars', () => {
  it('up to 62 bars keep a hairline gap', () => {
    render(<Bars title="Daily" bars={bars(62)} />)
    expect(screen.getByRole('list', { name: 'Daily' }).className).toContain('gap-px')
  })
  it('more than 62 bars have no gap and sit in a row that scrolls rather than widening the page', () => {
    render(<Bars title="Daily" bars={bars(366)} />)
    const list = screen.getByRole('list', { name: 'Daily' })
    expect(list.className).not.toContain('gap-px')
    expect(list.parentElement?.className).toContain('overflow-x-auto')
    expect(list.querySelectorAll('[role="listitem"]')).toHaveLength(366)
  })
})
