import { describe, it, expect } from 'vitest'
import { encodeEscPos } from './escpos'

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
