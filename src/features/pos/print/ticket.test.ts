import { describe, it, expect } from 'vitest'
import { formatMyt, wrap, renderTicketLines, ticketGuest, type TicketPayload } from './ticket'

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

  it('names the guest after the item when the line has one', () => {
    const t: TicketPayload = { ...base, lines: [
      { qty: 1, name: 'Latte', note: null, guest: 'Eric' },
      { qty: 2, name: 'Cake', note: 'no nuts', mods: ['Cream'], guest: 'Guest 2' },
      { qty: 1, name: 'Tea', note: null },
    ] }
    expect(renderTicketLines(t, 32).slice(5, -1)).toEqual([
      '1 x Latte - Eric',
      '2 x Cake - Guest 2',
      '    + Cream',
      '    * no nuts',
      '1 x Tea',
    ])
  })

  it('marks takeaway when there is no table', () => {
    const lines = renderTicketLines({ ...base, tableLabel: null, source: 'counter' }, 32)
    expect(lines[1]).toBe('TAKEAWAY')
    expect(lines[2]).toBe('Order: AB12CD (COUNTER)')
  })

  it('prints modifiers as + lines under the item, before the note', () => {
    const t: TicketPayload = {
      kind: 'ticket', route: 'Bar', tableLabel: 'T3', orderNo: '261023-004/2', source: 'qr',
      placedAt: '2026-10-23T02:00:00.000Z',
      lines: [{ qty: 2, name: 'Coffee Latte (COLD)', note: 'less ice', mods: ['Oat milk', 'Extra shot'] }],
    }
    const out = renderTicketLines(t, 32)
    expect(out.slice(5, 9)).toEqual([
      '2 x Coffee Latte (COLD)',
      '    + Oat milk',
      '    + Extra shot',
      '    * less ice',
    ])
  })

  it('puts a VOID banner above a void ticket and keeps the rest unchanged', () => {
    const out = renderTicketLines({ ...base, void: true }, 32)
    expect(out[0]).toBe('*** VOID ***')
    expect(out.slice(1)).toEqual(renderTicketLines(base, 32))
  })
})

describe('ticketGuest', () => {
  it('keeps an ASCII name and trims it', () => {
    expect(ticketGuest('Eric')).toBe('Eric')
    expect(ticketGuest('  Mei ')).toBe('Mei')
    expect(ticketGuest('Guest 2')).toBe('Guest 2')
  })

  it('is empty for no guest', () => {
    expect(ticketGuest(undefined)).toBe('')
    expect(ticketGuest('')).toBe('')
  })

  it('prints nothing when no ASCII letter or digit is left', () => {
    expect(ticketGuest('美玲')).toBe('')
    expect(ticketGuest('🙂')).toBe('')
  })

  it('turns the non-ASCII part into ? and keeps the rest', () => {
    expect(ticketGuest('美玲 Mei')).toBe('?? Mei')
  })
})

describe('renderTicketLines guest names', () => {
  const base: TicketPayload = {
    kind: 'ticket', route: 'Bar', tableLabel: 'B5', orderNo: 'AB12CD', source: 'qr',
    placedAt: '2026-10-22T03:48:00.000Z', lines: [],
  }

  it('prints no suffix when the guest name has no ASCII letter or digit', () => {
    const t: TicketPayload = { ...base, lines: [{ qty: 1, name: 'Latte', note: null, guest: '美玲' }] }
    expect(renderTicketLines(t, 32).slice(5, -1)).toEqual(['1 x Latte'])
  })

  it('prints the ASCII form of a mixed guest name', () => {
    const t: TicketPayload = { ...base, lines: [{ qty: 1, name: 'Tea', note: null, guest: '美玲 Mei' }] }
    expect(renderTicketLines(t, 32).slice(5, -1)).toEqual(['1 x Tea - ?? Mei'])
  })
})
