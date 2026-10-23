import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { computeBill, formatRate, roundingDeltaSen, type BillInput, type BillTotals } from './bill'
import vectors from './billVectors.json'

interface Vector { name: string; input: BillInput; expected: BillTotals }
const all = vectors as Vector[]

describe('computeBill — shared vectors (same numbers as the SQL verify script)', () => {
  it('has the vectors the design asks for', () => {
    expect(all).toHaveLength(22)
    expect(all[0].expected.totalSen).toBe(9280) // receipt #87846
  })
  for (const v of all) {
    it(v.name, () => {
      expect(computeBill(v.input)).toEqual(v.expected)
    })
  }
})

describe('the SQL verify script carries the very same vectors', () => {
  it('matches billVectors.json exactly', () => {
    const sql = readFileSync(new URL('../../../../supabase/migration-2026-10-24-pos-checkout-verify.sql', import.meta.url), 'utf8')
    const m = sql.match(/\$vectors\$([\s\S]*?)\$vectors\$/)
    expect(m).not.toBeNull()
    expect(JSON.parse((m as RegExpMatchArray)[1])).toEqual(vectors)
  })
})

describe('roundingDeltaSen', () => {
  it('rounds to the nearest 5 sen', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(roundingDeltaSen)).toEqual([0, -1, -2, 2, 1, 0, -1, -2, 2, 1])
  })
})

describe('formatRate', () => {
  it('prints basis points as a percentage', () => {
    expect(formatRate(600)).toBe('6%')
    expect(formatRate(650)).toBe('6.5%')
    expect(formatRate(1000)).toBe('10%')
    expect(formatRate(0)).toBe('0%')
  })
})
