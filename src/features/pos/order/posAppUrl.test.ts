import { describe, expect, it } from 'vitest'
import { posAppUrl } from './posAppUrl'

describe('posAppUrl — the POS app address from VITE_POS_APP_URL', () => {
  it('keeps an http(s) address, trimmed, without a trailing slash', () => {
    expect(posAppUrl('https://craft-pos-dev.vercel.app')).toBe('https://craft-pos-dev.vercel.app')
    expect(posAppUrl('  https://craft-pos-dev.vercel.app/  ')).toBe('https://craft-pos-dev.vercel.app')
    expect(posAppUrl('http://localhost:5179')).toBe('http://localhost:5179')
  })
  it('is null when unset or not a web address', () => {
    expect(posAppUrl(undefined)).toBeNull()
    expect(posAppUrl(null)).toBeNull()
    expect(posAppUrl('')).toBeNull()
    expect(posAppUrl('craft-pos-dev.vercel.app')).toBeNull()
    expect(posAppUrl('javascript:alert(1)')).toBeNull()
  })
})
