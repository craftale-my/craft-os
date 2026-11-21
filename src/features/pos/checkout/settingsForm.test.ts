import { describe, it, expect } from 'vitest'
import { bpToPercentText, methodKindPatch, parsePercentBp, parseReasons, receiptDetailsProblem, scopeLabel } from './settingsForm'

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

describe('W4: the footer QR and "Opens the cash drawer"', () => {
  const form = { receiptTitle: 'Craft', legalName: '', registrationNo: '', sstNo: '', address: '', phone: '', email: '', footer: '' }
  it('the QR text is at most 300 characters', () => {
    expect(receiptDetailsProblem({ ...form, footerQr: 'x'.repeat(300) })).toBeNull()
    expect(receiptDetailsProblem({ ...form, footerQr: 'x'.repeat(301) })).toBe('The QR text is too long (300 characters at most).')
  })
  it('a new cash method opens the drawer, a new other one does not; a saved method keeps its switch', () => {
    expect(methodKindPatch(true, 'cash')).toEqual({ kind: 'cash', opens_drawer: true })
    expect(methodKindPatch(true, 'card')).toEqual({ kind: 'card', opens_drawer: false })
    expect(methodKindPatch(false, 'cash')).toEqual({ kind: 'cash' })
  })
})

describe('the ordering window in the receipt settings (W7 spec §3)', () => {
  const ok = { receiptTitle: 'Craft Cafe - Demo', legalName: '', registrationNo: '', sstNo: '', address: '', phone: '', email: '', footer: 'Thanks' }
  it('both times or neither, not the same time; a window past midnight is fine', () => {
    expect(receiptDetailsProblem({ ...ok, ordersOpenAt: null, lastOrderAt: null })).toBeNull()
    expect(receiptDetailsProblem({ ...ok, ordersOpenAt: '09:00', lastOrderAt: '02:00' })).toBeNull()
    expect(receiptDetailsProblem({ ...ok, ordersOpenAt: '09:00', lastOrderAt: null })).toBe('Set both times or neither.')
    expect(receiptDetailsProblem({ ...ok, ordersOpenAt: null, lastOrderAt: '21:30' })).toBe('Set both times or neither.')
    expect(receiptDetailsProblem({ ...ok, ordersOpenAt: '21:30', lastOrderAt: '21:30' })).toBe('Orders open at and Last order at must be different times.')
  })
})
