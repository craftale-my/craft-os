import { describe, it, expect, afterEach, vi } from 'vitest'
import { isIos, isAndroid, mobilePlatform } from './pwa'

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15'
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148 Mobile Safari/537.36'

function asDevice(userAgent: string, platform: string, maxTouchPoints: number) {
  vi.stubGlobal('navigator', { userAgent, platform, maxTouchPoints })
}

afterEach(() => vi.unstubAllGlobals())

describe('mobilePlatform', () => {
  it('detects an iPhone', () => {
    asDevice(IPHONE, 'iPhone', 5)
    expect(mobilePlatform()).toBe('ios')
  })

  it('detects an iPad, which reports itself as a Mac', () => {
    asDevice(MAC_UA, 'MacIntel', 5)
    expect(isIos()).toBe(true)
    expect(mobilePlatform()).toBe('ios')
  })

  it('detects an Android phone', () => {
    asDevice(ANDROID, 'Linux armv8l', 5)
    expect(mobilePlatform()).toBe('android')
  })

  // Regression: the iPad check keys off a Mac-like platform string, which an
  // emulated Android device on a Mac host also reports. Ordering the Android
  // check first is what keeps it from being read as an iPad.
  it('reads an emulated Android on a Mac host as Android, not iOS', () => {
    asDevice(ANDROID, 'MacIntel', 5)
    expect(isAndroid()).toBe(true)
    expect(isIos()).toBe(false)
    expect(mobilePlatform()).toBe('android')
  })

  it('is null on a desktop Mac, so the hint never shows there', () => {
    asDevice(MAC_UA, 'MacIntel', 0)
    expect(mobilePlatform()).toBeNull()
  })

  it('is null on a desktop PC', () => {
    asDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/148', 'Win32', 0)
    expect(mobilePlatform()).toBeNull()
  })
})
