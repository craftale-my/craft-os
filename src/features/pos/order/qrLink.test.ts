import { describe, it, expect } from 'vitest'
import { qrLink, newQrToken } from './qrLink'

describe('qrLink', () => {
  it('uses the /t/ path in production and the dev entry under vite', () => {
    expect(qrLink('https://os.craftale.my', 'abc123', false)).toBe('https://os.craftale.my/t/abc123')
    expect(qrLink('http://192.168.0.20:5174', 'abc123', true)).toBe('http://192.168.0.20:5174/qr/?t=abc123')
  })
  it('makes 24-hex tokens', () => {
    expect(newQrToken()).toMatch(/^[0-9a-f]{24}$/)
    expect(newQrToken()).not.toBe(newQrToken())
  })
})
