import { describe, it, expect } from 'vitest'
import { calcAlBalance, pickPhGrantsFifo } from './leave'

describe('calcAlBalance', () => {
  it('sums the ledger and subtracts approved days', () => {
    const entries = [{ amount: 0.667 }, { amount: 0.667 }, { amount: 0.667 }]
    const { balance, available } = calcAlBalance(entries, 1, 0)
    expect(balance).toBe(1.0)   // 2.001 - 1 = 1.001 → round1 = 1.0
    expect(available).toBe(1.0)
  })

  it('subtracts pending days from available but not from balance', () => {
    const { balance, available } = calcAlBalance([{ amount: 4 }], 0, 2)
    expect(balance).toBe(4.0)
    expect(available).toBe(2.0)
  })

  it('handles forfeits (negative entries)', () => {
    const { balance } = calcAlBalance([{ amount: 8 }, { amount: -4 }], 0, 0)
    expect(balance).toBe(4.0)
  })

  it('returns zeros for an empty ledger', () => {
    expect(calcAlBalance([], 0, 0)).toEqual({ balance: 0, available: 0 })
  })
})

describe('pickPhGrantsFifo', () => {
  const g = (id: string, expires_at: string) => ({ id, expires_at })

  it('picks the earliest-expiring grants first', () => {
    const grants = [g('late', '2026-12-01'), g('soon', '2026-08-01'), g('mid', '2026-10-01')]
    expect(pickPhGrantsFifo(grants, 2)?.map(x => x.id)).toEqual(['soon', 'mid'])
  })

  it('returns null when there are not enough grants', () => {
    expect(pickPhGrantsFifo([g('a', '2026-08-01')], 2)).toBeNull()
  })

  it('does not mutate the input order', () => {
    const grants = [g('late', '2026-12-01'), g('soon', '2026-08-01')]
    pickPhGrantsFifo(grants, 1)
    expect(grants[0].id).toBe('late')
  })
})
