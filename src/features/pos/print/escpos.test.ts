import { describe, it, expect } from 'vitest'
import { encodeEscPos, encodeEscPosDoc } from './escpos'
import type { PrintDoc } from './doc'

const FEED_CUT = [0x1b, 0x64, 0x04, 0x1d, 0x56, 0x42, 0x00]
const bytes = (doc: PrintDoc) => Array.from(encodeEscPosDoc(doc))

describe('encodeEscPos', () => {
  it('initialises, prints each line, feeds and cuts', () => {
    expect(Array.from(encodeEscPos(['Hi', 'A']))).toEqual([
      0x1b, 0x40, // ESC @ — reset
      0x48, 0x69, 0x0a, // "Hi" LF
      0x41, 0x0a, // "A" LF
      0x1b, 0x64, 0x04, // ESC d 4 — feed 4 lines
      0x1d, 0x56, 0x42, 0x00, // GS V B 0 — feed and cut
    ])
  })

  it('replaces characters the printer cannot show with "?"', () => {
    expect(Array.from(encodeEscPos(['咸é'], { cut: false, feed: 0 }))).toEqual([
      0x1b, 0x40, 0x3f, 0x3f, 0x0a, 0x1b, 0x64, 0x00,
    ])
  })
})

describe('encodeEscPosDoc (W4 spec §4)', () => {
  it('normal font: no font command, the same bytes as encodeEscPos', () => {
    expect(bytes({ fontSize: 'normal', paper: true, blocks: [{ type: 'text', text: 'A' }] }))
      .toEqual(Array.from(encodeEscPos(['A'])))
  })
  it('small: ESC M 1 (Font B) once at the top', () => {
    expect(bytes({ fontSize: 'small', paper: true, blocks: [{ type: 'text', text: 'A' }] }))
      .toEqual([0x1b, 0x40, 0x1b, 0x4d, 0x01, 0x41, 0x0a, ...FEED_CUT])
  })
  it('large: GS ! 0x01 (double height) once at the top', () => {
    expect(bytes({ fontSize: 'large', paper: true, blocks: [{ type: 'text', text: 'A' }] }))
      .toEqual([0x1b, 0x40, 0x1d, 0x21, 0x01, 0x41, 0x0a, ...FEED_CUT])
  })
  it('big text: centred (ESC a 1), double width and height (GS ! 0x11), then back', () => {
    expect(bytes({ fontSize: 'normal', paper: true, blocks: [{ type: 'text', text: 'TA', big: true }, { type: 'text', text: 'A' }] }))
      .toEqual([0x1b, 0x40,
        0x1b, 0x61, 0x01, 0x1d, 0x21, 0x11, 0x54, 0x41, 0x0a, 0x1d, 0x21, 0x00, 0x1b, 0x61, 0x00,
        0x41, 0x0a, ...FEED_CUT])
  })
  it('big text in a small receipt prints in Font A, then Font B again', () => {
    expect(bytes({ fontSize: 'small', paper: true, blocks: [{ type: 'text', text: 'TA', big: true }] }))
      .toEqual([0x1b, 0x40, 0x1b, 0x4d, 0x01,
        0x1b, 0x61, 0x01, 0x1b, 0x4d, 0x00, 0x1d, 0x21, 0x11, 0x54, 0x41, 0x0a, 0x1d, 0x21, 0x00, 0x1b, 0x4d, 0x01, 0x1b, 0x61, 0x00,
        ...FEED_CUT])
  })
  it('big text in a large receipt goes back to double height', () => {
    expect(bytes({ fontSize: 'large', paper: true, blocks: [{ type: 'text', text: 'T', big: true }] }))
      .toEqual([0x1b, 0x40, 0x1d, 0x21, 0x01,
        0x1b, 0x61, 0x01, 0x1d, 0x21, 0x11, 0x54, 0x0a, 0x1d, 0x21, 0x01, 0x1b, 0x61, 0x00, ...FEED_CUT])
  })
  it('an image: GS v 0, width in bytes and height in dots little endian, then the rows, centred', () => {
    expect(bytes({ fontSize: 'normal', paper: false, blocks: [{ type: 'image', width: 16, height: 2, data: '/wAP8A==' }] }))
      .toEqual([0x1b, 0x40, 0x1b, 0x61, 0x01, 0x1d, 0x76, 0x30, 0x00, 0x02, 0x00, 0x02, 0x00, 0xff, 0x00, 0x0f, 0xf0, 0x1b, 0x61, 0x00])
  })
  it('a tall image: the height above 255 dots goes into yH', () => {
    const tall = Array.from(encodeEscPosDoc({ fontSize: 'normal', paper: false,
      blocks: [{ type: 'image', width: 8, height: 300, data: btoa('\0'.repeat(300)) }] }))
    expect(tall.slice(5, 13)).toEqual([0x1d, 0x76, 0x30, 0x00, 0x01, 0x00, 0x2c, 0x01])
  })
  it('a QR code: GS ( k model 2, module size 6, error correction M, store, print, centred', () => {
    expect(bytes({ fontSize: 'normal', paper: false, blocks: [{ type: 'qr', data: 'AB' }] }))
      .toEqual([0x1b, 0x40, 0x1b, 0x61, 0x01,
        0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00,
        0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06,
        0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31,
        0x1d, 0x28, 0x6b, 0x05, 0x00, 0x31, 0x50, 0x30, 0x41, 0x42,
        0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30,
        0x1b, 0x61, 0x00])
  })
  it('QR data is stored as UTF-8', () => {
    const b = bytes({ fontSize: 'normal', paper: false, blocks: [{ type: 'qr', data: 'é' }] })
    expect(b.slice(30, 38)).toEqual([0x1d, 0x28, 0x6b, 0x05, 0x00, 0x31, 0x50, 0x30])
    expect(b.slice(38, 40)).toEqual([0xc3, 0xa9])
  })
  it('a drawer kick: ESC p 0 25 250 and no paper (no feed, no cut)', () => {
    expect(bytes({ fontSize: 'normal', paper: false, blocks: [{ type: 'pulse' }] }))
      .toEqual([0x1b, 0x40, 0x1b, 0x70, 0x00, 0x19, 0xfa])
  })
})
