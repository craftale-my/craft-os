import { describe, it, expect } from 'vitest'
import { formatMyt, wrap, renderTicketLines, type TicketPayload } from './ticket'

describe('formatMyt', () => {
  it('shows UTC timestamps in Malaysia time (+8)', () => {
    expect(formatMyt('2026-10-22T03:48:00.000Z')).toBe('22/10/2026 11:48')
  })

  it('rolls the date over after 16:00 UTC', () => {
    expect(formatMyt('2026-10-22T16:30:00.000Z')).toBe('23/10/2026 00:30')
  })
})

describe('wrap', () => {
  it('keeps a short line as is', () => {
    expect(wrap('1 x Latte', 32)).toEqual(['1 x Latte'])
  })

  it('breaks on spaces and indents continuation lines', () => {
    expect(wrap('2 x Fried Chicken Curry DON with extra sauce on the side', 32, '    ')).toEqual([
      '2 x Fried Chicken Curry DON with',
      '    extra sauce on the side',
    ])
  })

  it('never splits a single word longer than the width', () => {
    expect(wrap('Supercalifragilistic', 5)).toEqual(['Supercalifragilistic'])
  })
})

describe('renderTicketLines', () => {
  const base: TicketPayload = {
    kind: 'ticket',
    route: 'Bar',
    tableLabel: 'B5',
    orderNo: 'AB12CD',
    source: 'qr',
    placedAt: '2026-10-22T03:48:00.000Z',
    lines: [
      { qty: 1, name: 'Coffee Latte (COLD)', note: 'less ice' },
      { qty: 2, name: 'Fried Chicken Curry DON with extra sauce on the side', note: null },
    ],
  }

  it('lays out a dine-in ticket', () => {
    expect(renderTicketLines(base, 32)).toEqual([
      'BAR TICKET',
      'Table: B5',
      'Order: AB12CD (QR)',
      'Time: 22/10/2026 11:48',
      '--------------------------------',
      '1 x Coffee Latte (COLD)',
      '    * less ice',
      '2 x Fried Chicken Curry DON with',
      '    extra sauce on the side',
      '--------------------------------',
    ])
  })

  it('marks takeaway when there is no table', () => {
    const lines = renderTicketLines({ ...base, tableLabel: null, source: 'counter' }, 32)
    expect(lines[1]).toBe('TAKEAWAY')
    expect(lines[2]).toBe('Order: AB12CD (COUNTER)')
  })
})
