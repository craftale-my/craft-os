// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { csvCell, csvFileName, csvTime, downloadCsv, ringgit, safeText, toCsv } from './csv'

describe('csvCell', () => {
  it('quotes only what needs it and doubles quotes', () => {
    expect(csvCell('Latte')).toBe('Latte')
    expect(csvCell('Muffin, large')).toBe('"Muffin, large"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('two\nlines')).toBe('"two\nlines"')
    expect(csvCell(' padded')).toBe('" padded"')
    expect(csvCell(null)).toBe('')
    expect(csvCell(12)).toBe('12')
    expect(csvCell(-3)).toBe('-3')
  })
})

describe('safeText (formula injection)', () => {
  it('prefixes an apostrophe when the first character is = + - @ tab or CR', () => {
    for (const s of ['=SUM(A1)', '+1', '-1', '@cmd', '\tx', '\rx']) expect(safeText(s)).toBe(`'${s}`)
    expect(safeText('Latte')).toBe('Latte')
    expect(safeText('a=b')).toBe('a=b')
    expect(safeText('')).toBe('')
  })
  it('header labels are made safe, number cells are not touched', () => {
    expect(toCsv(['=A', 'B'], [[-0.02, '-0.02']])).toBe("\uFEFF'=A,B\r\n-0.02,-0.02\r\n")
  })
})

describe('toCsv', () => {
  it('UTF-8 BOM first, comma separated, CRLF after every row', () => {
    expect(toCsv(['A', 'B'], [['x', 1], [null, 'y,z']])).toBe('\uFEFFA,B\r\nx,1\r\n,"y,z"\r\n')
  })
})

describe('ringgit', () => {
  it('two decimals, no RM, exact for every sen', () => {
    expect(ringgit(0)).toBe('0.00')
    expect(ringgit(5)).toBe('0.05')
    expect(ringgit(1230)).toBe('12.30')
    expect(ringgit(-2)).toBe('-0.02')
    expect(ringgit(-300)).toBe('-3.00')
    expect(ringgit(123456789)).toBe('1234567.89')
  })
})

describe('csvTime and csvFileName', () => {
  it('Malaysia time to the minute; report_from_to.csv', () => {
    expect(csvTime('2026-01-05T17:30:00.000Z')).toBe('2026-01-06 01:30')
    expect(csvFileName('daily-sales', '2026-01-05', '2026-01-06')).toBe('daily-sales_2026-01-05_2026-01-06.csv')
  })
})

describe('downloadCsv', () => {
  const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL }
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    URL.createObjectURL = original.create
    URL.revokeObjectURL = original.revoke
  })
  it('saves the text as a UTF-8 file with the given name, then frees the URL', () => {
    vi.useFakeTimers()
    const blobs: Blob[] = []
    const names: string[] = []
    const revoke = vi.fn()
    Object.assign(URL, { createObjectURL: (b: Blob) => { blobs.push(b); return 'blob:report' }, revokeObjectURL: revoke })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download) })
    downloadCsv('daily-sales_2026-01-05_2026-01-06.csv', '\uFEFFA\r\n')
    expect(names).toEqual(['daily-sales_2026-01-05_2026-01-06.csv'])
    expect(blobs[0].type).toBe('text/csv;charset=utf-8')
    expect(blobs[0].size).toBe(6)                                        // BOM (3 bytes) + "A" + CRLF
    expect(document.querySelector('a')).toBeNull()                       // the link is removed again
    vi.runAllTimers()
    expect(revoke).toHaveBeenCalledWith('blob:report')
  })
})
