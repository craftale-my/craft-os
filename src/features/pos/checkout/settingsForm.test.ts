import { describe, it, expect } from 'vitest'
import { bpToPercentText, parsePercentBp, parseReasons, receiptDetailsProblem, scopeLabel } from './settingsForm'

describe('percent ↔ basis points', () => {
  it('parses a percentage', () => {
    expect(parsePercentBp('10')).toBe(1000)
    expect(parsePercentBp('6.5%')).toBe(650)
    expect(parsePercentBp('0')).toBe(0)
    expect(parsePercentBp('100')).toBe(10000)
  })
  it('refuses junk and over 100', () => {
    expect(parsePercentBp('')).toBeNull()
    expect(parsePercentBp('101')).toBeNull()
    expect(parsePercentBp('6.555')).toBeNull()
    expect(parsePercentBp('ten')).toBeNull()
  })
  it('prints basis points back', () => {
    expect(bpToPercentText(1000)).toBe('10')
    expect(bpToPercentText(650)).toBe('6.5')
  })
})

describe('parseReasons', () => {
  it('keeps one trimmed reason per line, no blanks or repeats', () => {
    expect(parseReasons(' Wrong item keyed \n\nCustomer changed mind\nWrong item keyed')).toEqual(['Wrong item keyed', 'Customer changed mind'])
  })
})

describe('receiptDetailsProblem', () => {
  const ok = { receiptTitle: 'Craft Cafe - Demo', legalName: '', registrationNo: '', sstNo: '', address: '', phone: '', email: '', footer: 'Thanks' }
  it('needs a title and a sane email and footer', () => {
    expect(receiptDetailsProblem(ok)).toBeNull()
    expect(receiptDetailsProblem({ ...ok, receiptTitle: ' ' })).toMatch(/receipt title/)
    expect(receiptDetailsProblem({ ...ok, email: 'nope' })).toBe('The email address does not look right')
    expect(receiptDetailsProblem({ ...ok, footer: 'x'.repeat(301) })).toMatch(/too long/)
  })
})

describe('scopeLabel', () => {
  it('says All or a count', () => {
    expect(scopeLabel(null, 'table')).toBe('All tables')
    expect(scopeLabel(['a'], 'table')).toBe('1 table')
    expect(scopeLabel(['a', 'b'], 'product')).toBe('2 products')
  })
})
