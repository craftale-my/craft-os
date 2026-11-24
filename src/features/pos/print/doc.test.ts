import { describe, expect, it } from 'vitest'
import { docPulses, docText, lineWidth, textBlocks, type PrintDoc } from './doc'

describe('the print document (W4 spec §4)', () => {
  it('Font B fits a third more characters; large keeps the width', () => {
    expect(lineWidth('small', 42)).toBe(56)
    expect(lineWidth('small', 48)).toBe(64)
    expect(lineWidth('small', 32)).toBe(42)
    expect(lineWidth('normal', 42)).toBe(42)
    expect(lineWidth('large', 42)).toBe(42)
  })
  it('text blocks from lines', () => {
    expect(textBlocks(['A', 'B'])).toEqual([{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }])
  })
  it('the text view: big text centred as plain text, image, QR and pulse left out', () => {
    const doc: PrintDoc = {
      fontSize: 'small', paper: true,
      blocks: [{ type: 'text', text: 'TA012', big: true }, { type: 'image', width: 8, height: 1, data: '/w==' },
               { type: 'text', text: 'Hello' }, { type: 'qr', data: 'x' }, { type: 'pulse' }],
    }
    expect(docText(doc, 42)).toEqual([`${' '.repeat(18)}TA012`, 'Hello'])
    expect(docPulses(doc)).toBe(true)
    expect(docPulses({ fontSize: 'normal', paper: true, blocks: textBlocks(['x']) })).toBe(false)
  })
})
