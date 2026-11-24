// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { MemberApi, MemberMe } from './memberApi'
import { MEMBER_TOKEN_KEY, RETRY_MS, clearTokenIf, loadToken, resetMemberMemory, saveToken, useMember } from './useMember'
import { useQrMember } from './useQrMember'
import type { TableState } from '../useQrMenu'

afterEach(() => { cleanup(); vi.useRealTimers() })
beforeEach(() => { localStorage.clear(); sessionStorage.clear(); resetMemberMemory() })

const me = (points = 0): MemberMe => ({ phoneMasked: '+60 ••• ••6789', points, rate: 1, entries: [] })
function fakeApi(over: Partial<MemberApi> = {}): MemberApi {
  return {
    requestCode: vi.fn(async () => ({ ok: true as const })),
    verifyCode: vi.fn(async () => ({ ok: true as const, token: 'tok' })),
    memberMe: vi.fn(async () => me(120)),
    memberSignOut: vi.fn(async () => {}),
    memberLinkTable: vi.fn(async () => ({ linked: true, phoneMasked: '+60 ••• ••6789' })),
    memberPublicSettings: vi.fn(async () => ({ qrEnabled: true, rate: 1 })),
    ...over,
  }
}
const throwing = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => { throw new Error('denied') } }

describe('token storage', () => {
  it('keeps the token in localStorage under craft-member-token', () => {
    saveToken('abc')
    expect(localStorage.getItem(MEMBER_TOKEN_KEY)).toBe('abc')
    expect(loadToken()).toBe('abc')
    saveToken(null)
    expect(localStorage.getItem(MEMBER_TOKEN_KEY)).toBeNull()
  })
  it('falls back to memory when storage throws', () => {
    saveToken('mem', throwing)
    expect(loadToken(throwing)).toBe('mem')
    expect(loadToken(null)).toBe('mem')
  })
})

describe('useMember', () => {
  it('off when the QR switch is off', async () => {
    const api = fakeApi({ memberPublicSettings: vi.fn(async () => ({ qrEnabled: false, rate: 1 })) })
    const { result } = renderHook(() => useMember(api))
    await waitFor(() => expect(api.memberPublicSettings).toHaveBeenCalled())
    await act(async () => {})
    expect(result.current.status).toBe('off')
  })
  it('off when the settings call fails (front end before SQL)', async () => {
    const api = fakeApi({ memberPublicSettings: vi.fn(async () => { throw new Error('PGRST202') }) })
    const { result } = renderHook(() => useMember(api))
    await act(async () => {})
    expect(result.current.status).toBe('off')
  })
  it('out without a token; in with a live one', async () => {
    const api = fakeApi()
    const { result } = renderHook(() => useMember(api))
    await waitFor(() => expect(result.current.status).toBe('out'))
    expect(api.memberMe).not.toHaveBeenCalled()
    await act(async () => { await result.current.signIn('tok') })
    expect(result.current.status).toBe('in')
    expect(result.current.me?.points).toBe(120)
    expect(localStorage.getItem(MEMBER_TOKEN_KEY)).toBe('tok')
  })
  it('a token the server no longer knows goes back to out quietly', async () => {
    localStorage.setItem(MEMBER_TOKEN_KEY, 'dead')
    const api = fakeApi({ memberMe: vi.fn(async () => null) })
    const { result } = renderHook(() => useMember(api))
    await waitFor(() => expect(result.current.status).toBe('out'))
    expect(localStorage.getItem(MEMBER_TOKEN_KEY)).toBeNull()
    expect(api.memberSignOut).not.toHaveBeenCalled()
  })
  it('reads the balance again when the page comes back into view', async () => {
    localStorage.setItem(MEMBER_TOKEN_KEY, 'tok')
    const api = fakeApi()
    const { result } = renderHook(() => useMember(api))
    await waitFor(() => expect(result.current.status).toBe('in'))
    ;(api.memberMe as ReturnType<typeof vi.fn>).mockResolvedValueOnce(me(150))
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => expect(result.current.me?.points).toBe(150))
  })
  it('sign out tells the server and forgets the token even when the call fails', async () => {
    localStorage.setItem(MEMBER_TOKEN_KEY, 'tok')
    const api = fakeApi({ memberSignOut: vi.fn(async () => { throw new Error('offline') }) })
    const { result } = renderHook(() => useMember(api))
    await waitFor(() => expect(result.current.status).toBe('in'))
    await act(async () => { await result.current.signOut() })
    expect(api.memberSignOut).toHaveBeenCalledWith('tok')
    expect(result.current.status).toBe('out')
    expect(localStorage.getItem(MEMBER_TOKEN_KEY)).toBeNull()
  })
})

describe('useMember — weak connection, two tabs', () => {
  it('clearTokenIf removes the stored token only while it is still the dead one', () => {
    saveToken('dead'); clearTokenIf('dead')
    expect(localStorage.getItem(MEMBER_TOKEN_KEY)).toBeNull()
    saveToken('new'); clearTokenIf('dead')
    expect(localStorage.getItem(MEMBER_TOKEN_KEY)).toBe('new')
  })
  it('a stored token with no reply yet is in with me null; retries after 1 s, 3 s, 8 s; never signs out', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    expect(RETRY_MS).toEqual([1000, 3000, 8000])
    localStorage.setItem(MEMBER_TOKEN_KEY, 'tok')
    const memberMe = vi.fn(async (): Promise<MemberMe | null> => { throw new TypeError('Load failed') })
    const api = fakeApi({ memberMe })
    const { result } = renderHook(() => useMember(api))
    await act(async () => {})
    expect(result.current.status).toBe('in')
    expect(result.current.me).toBeNull()
    expect(memberMe).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(999) })
    expect(memberMe).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(1) })
    expect(memberMe).toHaveBeenCalledTimes(2)
    await act(async () => { vi.advanceTimersByTime(3000) })
    expect(memberMe).toHaveBeenCalledTimes(3)
    await act(async () => { vi.advanceTimersByTime(8000) })
    expect(memberMe).toHaveBeenCalledTimes(4)
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(memberMe).toHaveBeenCalledTimes(4)                       // three retries, then the next visibility change
    expect(result.current.status).toBe('in')
    expect(localStorage.getItem(MEMBER_TOKEN_KEY)).toBe('tok')
  })
  it('a retry that gets through shows the balance', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false })
    localStorage.setItem(MEMBER_TOKEN_KEY, 'tok')
    const memberMe = vi.fn(async (): Promise<MemberMe | null> => me(42))
    memberMe.mockRejectedValueOnce(new TypeError('Load failed'))
    const api = fakeApi({ memberMe })
    const { result } = renderHook(() => useMember(api))
    await act(async () => {})
    expect(result.current.me).toBeNull()
    await act(async () => { vi.advanceTimersByTime(1000) })
    await act(async () => {})
    expect(result.current.me?.points).toBe(42)
  })
  it('a dead reply does not remove a token another tab stored meanwhile; this tab takes it', async () => {
    localStorage.setItem(MEMBER_TOKEN_KEY, 'dead')
    let answer: (v: MemberMe | null) => void = () => {}
    const memberMe = vi.fn((t: string) => t === 'dead' ? new Promise<MemberMe | null>((r) => { answer = r }) : Promise.resolve(me(7)))
    const api = fakeApi({ memberMe })
    const { result } = renderHook(() => useMember(api))
    await waitFor(() => expect(memberMe).toHaveBeenCalledWith('dead'))
    localStorage.setItem(MEMBER_TOKEN_KEY, 'fresh')                 // the other tab signed in (no event yet)
    await act(async () => { answer(null) })
    expect(localStorage.getItem(MEMBER_TOKEN_KEY)).toBe('fresh')
    await waitFor(() => expect(result.current.token).toBe('fresh'))
    await waitFor(() => expect(result.current.me?.points).toBe(7))
  })
  it('picks up a sign-in and a sign-out from another tab (storage event), without a server call', async () => {
    const api = fakeApi()
    const { result } = renderHook(() => useMember(api))
    await waitFor(() => expect(result.current.status).toBe('out'))
    localStorage.setItem(MEMBER_TOKEN_KEY, 'other')
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: MEMBER_TOKEN_KEY, newValue: 'other' })) })
    await waitFor(() => expect(result.current.me?.points).toBe(120))
    expect(result.current.status).toBe('in')
    expect(api.memberMe).toHaveBeenCalledWith('other')
    localStorage.removeItem(MEMBER_TOKEN_KEY)
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: MEMBER_TOKEN_KEY, newValue: null })) })
    expect(result.current.status).toBe('out')
    expect(result.current.me).toBeNull()
    expect(api.memberSignOut).not.toHaveBeenCalled()
    // another key changing does nothing
    await act(async () => { window.dispatchEvent(new StorageEvent('storage', { key: 'something-else' })) })
    expect(result.current.status).toBe('out')
  })
})

const state = (billNo: string | null, items: number): TableState => ({
  tableLabel: 'T1', billNo, pax: null, subtotalSen: 0,
  items: Array.from({ length: items }, () => ({ name: 'Latte', qty: 1, unitPriceSen: 900, mods: [], note: null, voided: false })),
})

describe('useQrMember (linking)', () => {
  it('links after a send with the guest id, says it once, and marks the bill linked', async () => {
    localStorage.setItem(MEMBER_TOKEN_KEY, 'tok')
    const api = fakeApi()
    const say = vi.fn()
    const { result, rerender } = renderHook((p: { s: TableState | null }) => useQrMember({ api, tableToken: 'TT', guestId: 'G1', state: p.s, say }), { initialProps: { s: state(null, 0) } })
    await waitFor(() => expect(result.current.member.status).toBe('in'))
    expect(api.memberLinkTable).not.toHaveBeenCalled()             // nothing ordered yet
    act(() => result.current.afterSend())
    rerender({ s: state('B12', 1) })                                // the table state after the send
    await waitFor(() => expect(api.memberLinkTable).toHaveBeenCalledWith('TT', 'tok', 'G1'))
    await waitFor(() => expect(result.current.linked).toBe(true))
    expect(say).toHaveBeenCalledTimes(1)
    expect(say).toHaveBeenCalledWith('Points from this bill go to your number.')
    act(() => result.current.afterSend())                           // a second send: linked again, no second toast
    await waitFor(() => expect(api.memberLinkTable).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(say).toHaveBeenCalledTimes(1)
  })
  it('another member first: says whose number; no order from this guest: says nothing', async () => {
    localStorage.setItem(MEMBER_TOKEN_KEY, 'tok')
    const link = vi.fn(async () => ({ linked: false, phoneMasked: '+60 ••• ••1234' }))
    const say = vi.fn()
    const api1 = fakeApi({ memberLinkTable: link }), s1 = state('B1', 2)
    const { result } = renderHook(() => useQrMember({ api: api1, tableToken: 'TT', guestId: 'G2', state: s1, say }))
    await waitFor(() => expect(say).toHaveBeenCalledWith("This table's points are going to +60\u00a0•••\u00a0••1234."))
    expect(result.current.linked).toBe(false)

    cleanup(); sessionStorage.clear()
    const say2 = vi.fn()
    const quiet = vi.fn(async () => ({ linked: false, phoneMasked: null }))
    const api2 = fakeApi({ memberLinkTable: quiet })
    renderHook(() => useQrMember({ api: api2, tableToken: 'TT', guestId: 'G3', state: s1, say: say2 }))
    await waitFor(() => expect(quiet).toHaveBeenCalled())
    await act(async () => {})
    expect(say2).not.toHaveBeenCalled()
  })
  it('a link failure is ignored; a null reply signs out quietly', async () => {
    localStorage.setItem(MEMBER_TOKEN_KEY, 'tok')
    const fail = vi.fn(async () => { throw new Error('offline') })
    const say = vi.fn()
    const apiA = fakeApi({ memberLinkTable: fail }), s1 = state('B1', 1)
    const a = renderHook(() => useQrMember({ api: apiA, tableToken: 'TT', guestId: 'G', state: s1, say }))
    await waitFor(() => expect(fail).toHaveBeenCalled())
    await act(async () => {})
    expect(say).not.toHaveBeenCalled()
    expect(a.result.current.member.status).toBe('in')
    a.unmount()

    const dead = vi.fn(async () => null)
    const apiB = fakeApi({ memberLinkTable: dead })
    const b = renderHook(() => useQrMember({ api: apiB, tableToken: 'TT', guestId: 'G', state: s1, say }))
    await waitFor(() => expect(b.result.current.member.status).toBe('out'))
    expect(localStorage.getItem(MEMBER_TOKEN_KEY)).toBeNull()
  })
  it('reads the balance again when the bill number changes (paid, or a new bill)', async () => {
    localStorage.setItem(MEMBER_TOKEN_KEY, 'tok')
    const api = fakeApi()
    const { result, rerender } = renderHook((p: { s: TableState | null }) => useQrMember({ api, tableToken: 'TT', guestId: 'G', state: p.s, say: () => {} }), { initialProps: { s: state('B1', 1) } })
    await waitFor(() => expect(result.current.member.status).toBe('in'))
    const before = (api.memberMe as ReturnType<typeof vi.fn>).mock.calls.length
    rerender({ s: state(null, 0) })
    await waitFor(() => expect((api.memberMe as ReturnType<typeof vi.fn>).mock.calls.length).toBe(before + 1))
  })
  it('a link reply that lands after sign-out shows nothing', async () => {
    localStorage.setItem(MEMBER_TOKEN_KEY, 'tok')
    let answer: (v: { linked: boolean; phoneMasked: string | null }) => void = () => {}
    const link = vi.fn(() => new Promise<{ linked: boolean; phoneMasked: string | null }>((r) => { answer = r }))
    const say = vi.fn()
    const s1 = state('B1', 1)
    const api = fakeApi({ memberLinkTable: link })
    const { result } = renderHook(() => useQrMember({ api, tableToken: 'TT', guestId: 'G', state: s1, say }))
    await waitFor(() => expect(link).toHaveBeenCalled())
    await act(async () => { await result.current.member.signOut() })
    await act(async () => { answer({ linked: true, phoneMasked: '+60 ••• ••6789' }) })
    expect(say).not.toHaveBeenCalled()
    expect(result.current.linked).toBe(false)
  })
})
