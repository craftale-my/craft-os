import { describe, expect, it } from 'vitest'
import { fromBase64, LOGO_MAX_HEIGHT, LOGO_MAX_WIDTH, toBase64 } from './logo'

describe('logo base64', () => {
  it('round-trips the raster bytes', () => {
    expect(toBase64(Uint8Array.from([0xff, 0x00, 0x0f, 0xf0]))).toBe('/wAP8A==')
    expect(Array.from(fromBase64('/wAP8A=='))).toEqual([0xff, 0x00, 0x0f, 0xf0])
  })
  it('reads base64 with line breaks (Postgres encode() wraps at 76)', () => {
    expect(Array.from(fromBase64('/wAP\n8A=='))).toEqual([0xff, 0x00, 0x0f, 0xf0])
  })
  it('a full-size logo survives the trip', () => {
    const bytes = Uint8Array.from({ length: (LOGO_MAX_WIDTH / 8) * LOGO_MAX_HEIGHT }, (_, i) => i % 256)
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes))
  })
})
