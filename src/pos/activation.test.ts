import { describe, expect, it } from 'vitest'
import {
  afterPoll, clearPending, detectPlatform, ENDED, isPolling, loadPending, retryableSignIn, savePending, signInRetryMs, type Pending,
} from './activation'

const pending: Pending = { code: 'ABC-DEF', secret: 's3cret', expiresAt: '2026-10-31T10:00:00Z', name: 'Counter 1' }

function memoryStorage(): Storage {
  const m = new Map<string, string>()
  return {
    get length() { return m.size }, clear: () => m.clear(), key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v) }, removeItem: (k) => { m.delete(k) },
  }
}

describe('afterPoll', () => {
  it('keeps waiting (and polling) while pending', () => {
    const s = afterPoll(pending, { status: 'pending' })
    expect(s).toEqual({ kind: 'waiting', pending, note: null })
    expect(isPolling(s)).toBe(true)
  })

  it('signs in with the credentials when approved as POS', () => {
    const s = afterPoll(pending, { status: 'approved', deviceId: 'd', email: 'device-x@devices.invalid', password: 'pw', branchId: 'b', kind: 'pos', name: 'Counter 1' })
    expect(s).toEqual({ kind: 'signing_in', email: 'device-x@devices.invalid', password: 'pw' })
    expect(isPolling(s)).toBe(false)
  })

  it('refuses a device approved as a print agent', () => {
    expect(afterPoll(pending, { status: 'approved', deviceId: 'd', email: 'e', password: 'p', branchId: 'b', kind: 'print_agent', name: 'n' }))
      .toEqual({ kind: 'ended', reason: 'wrong_kind' })
  })

  it.each(['rejected', 'expired', 'unknown'] as const)('stops polling when %s', (status) => {
    const s = afterPoll(pending, { status })
    expect(s).toEqual({ kind: 'ended', reason: status })
    expect(isPolling(s)).toBe(false)
  })
})

describe('detectPlatform', () => {
  it('knows an iPad, also one that says Macintosh', () => {
    expect(detectPlatform('Mozilla/5.0 (iPad; CPU OS 12_0 like Mac OS X)', 5)).toBe('ipad')
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15', 5)).toBe('ipad')
  })
  it('knows Android, and calls a desktop other', () => {
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 14; SM-X200) Chrome/130', 10)).toBe('android')
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130', 0)).toBe('other')
  })
})

describe('the waiting request on this device', () => {
  it('survives a reload and is cleared after', () => {
    const store = memoryStorage()
    expect(loadPending(store)).toBeNull()
    savePending(store, pending)
    expect(loadPending(store)).toEqual(pending)
    clearPending(store)
    expect(loadPending(store)).toBeNull()
  })
  it('ignores a broken entry', () => {
    const store = memoryStorage()
    store.setItem('craft-pos-activation', '{oops')
    expect(loadPending(store)).toBeNull()
  })
})

describe('signing in after the approval', () => {
  it('waits 2 s, 5 s, 10 s, then every 15 s between tries', () => {
    expect([0, 1, 2, 3, 9].map(signInRetryMs)).toEqual([2_000, 5_000, 10_000, 15_000, 15_000])
  })
  it('tries again after a network failure only, not a refusal', () => {
    expect(retryableSignIn(Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError' }))).toBe(true)
    expect(retryableSignIn(new TypeError('Failed to fetch'))).toBe(true)
    expect(retryableSignIn(Object.assign(new Error('Invalid login credentials'), { name: 'AuthApiError' }))).toBe(false)
  })
  it('a sign-out with no unpair seen has its own message', () => {
    expect(ENDED.signed_out).toBe('This device was signed out. Ask HQ to unpair it in Devices and approve a new request.')
  })
})
