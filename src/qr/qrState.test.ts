import { describe, it, expect } from 'vitest'
import { tokenFromLocation } from './qrState'

describe('tokenFromLocation', () => {
  it('reads /t/<token> in production and ?t= under the dev server', () => {
    expect(tokenFromLocation('/t/abc123', '')).toBe('abc123')
    expect(tokenFromLocation('/qr/', '?t=abc123')).toBe('abc123')
    expect(tokenFromLocation('/qr/', '')).toBeNull()
    expect(tokenFromLocation('/t/', '')).toBeNull()
  })
})
