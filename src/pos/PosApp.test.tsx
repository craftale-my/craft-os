// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { RosterReply } from './roster'
import type { WhoAmI } from './sessionApi'

const api = vi.hoisted(() => ({
  endSession: vi.fn(), fetchRoster: vi.fn(), fetchWhoAmI: vi.fn(), forgetDevice: vi.fn(), unpairThisDevice: vi.fn(),
  startSession: vi.fn(), requestActivation: vi.fn(), pollActivation: vi.fn(), signInDevice: vi.fn(),
  hasDeviceSession: () => localStorage.getItem('craft-pos-auth') !== null,
}))
vi.mock('./sessionApi', () => api)

const till = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }))
vi.mock('../features/pos/order/PosTill', () => ({
  default: (p: Record<string, unknown>) => { till.props.push(p); return <div data-testid="till" /> },
}))

const idb = vi.hoisted(() => ({ createIdbStore: vi.fn(), all: vi.fn(), put: vi.fn() }))
vi.mock('../features/pos/offline/idbStore', () => ({ createIdbStore: idb.createIdbStore }))
vi.mock('../features/pos/checkout/checkoutApi', () => ({ fetchProductNames: vi.fn(() => Promise.resolve([])) }))
vi.mock('./useAppUpdate', () => ({ useAppUpdate: () => false }))

const auth = vi.hoisted(() => ({ listener: null as ((event: string) => void) | null }))
vi.mock('./posSupabase', () => ({
  CONTEXT_EVENT: 'craft-pos:context',
  POS_STORAGE_KEY: 'craft-pos-auth',
  supabase: {
    auth: {
      onAuthStateChange: (cb: (event: string) => void) => { auth.listener = cb; return { data: { subscription: { unsubscribe() {} } } } },
      getSession: () => Promise.resolve({ data: { session: null } }),
    },
  },
}))

import PosApp from './PosApp'

const roster = (o: Partial<RosterReply['outlet']> = {}, session: RosterReply['session'] = null): RosterReply => ({
  device: { id: 'd1', name: 'Counter 1', prints: true },
  outlet: { id: 'b1', name: 'Craft Cafe Kepong', kind: 'branch', opensOn: null, closesOn: null, isActive: true, open: true, ...o },
  idleLockMinutes: 10,
  session,
  staff: [{ id: 's1', name: 'Aina', hasPin: true }],
})
const who: WhoAmI = {
  deviceId: 'd1', deviceName: 'Counter 1', prints: true, outletId: 'b1', outletName: 'Craft Cafe Kepong',
  staffId: 's1', staffName: 'Aina', canSupervise: false, canUnpair: true,
}
const aina = { staffId: 's1', name: 'Aina' }
const lastTill = () => till.props[till.props.length - 1]
const fire = (code: string) => window.dispatchEvent(new CustomEvent('craft-pos:context', { detail: code }))
/** The roster has Aina's session until pos_end_session runs. */
const signedInUntilEnded = () => {
  let open = true
  api.fetchRoster.mockImplementation(async () => roster({}, open ? aina : null))
  api.fetchWhoAmI.mockResolvedValue(who)
  api.endSession.mockImplementation(async () => { open = false })
}
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('craft-pos-auth', '{}')
  for (const f of Object.values(api)) if (typeof f === 'function' && 'mockReset' in f) f.mockReset()
  api.endSession.mockResolvedValue(undefined)
  api.forgetDevice.mockResolvedValue(undefined)
  idb.all.mockReset().mockResolvedValue([])
  idb.put.mockReset().mockResolvedValue(undefined)
  idb.createIdbStore.mockReset().mockReturnValue({ all: idb.all, put: idb.put })
  till.props = []
  auth.listener = null
})
afterEach(cleanup)

describe('PosApp', () => {
  it('outlet_closed with an open session: the lock screen says the outlet is closed, and the cached person is not signed in', async () => {
    localStorage.setItem('craft-pos-context', JSON.stringify({ roster: roster({}, aina), who }))
    api.fetchRoster.mockResolvedValue(roster({ isActive: false, open: false }, aina))
    api.fetchWhoAmI.mockRejectedValue(new Error('outlet_closed'))
    render(<PosApp />)
    await flush()
    expect(screen.getByTestId('lock-screen')).toBeTruthy()
    expect(screen.getByText('This outlet is closed.')).toBeTruthy()
    expect(screen.queryByText('outlet_closed')).toBeNull()                 // a refusal is not a load error
    expect(screen.queryByTestId('till')).toBeNull()
    expect(JSON.parse(localStorage.getItem('craft-pos-context') ?? 'null').who).toBeNull()
  })

  it('a reload with no network opens the till for whoever was signed in', async () => {
    localStorage.setItem('craft-pos-context', JSON.stringify({ roster: roster({}, aina), who }))
    api.fetchRoster.mockRejectedValue(new TypeError('Failed to fetch'))
    render(<PosApp />)
    await flush()
    expect(screen.getByTestId('till')).toBeTruthy()
    expect(lastTill().locked).toBe(false)
    expect(lastTill().staffId).toBe('s1')
    expect(screen.queryByTestId('lock-screen')).toBeNull()
  })

  it('device_unpaired twice, then SIGNED_OUT: one switch to the activation screen, the waiting orders held once', async () => {
    api.fetchRoster.mockResolvedValue(roster())
    let release!: (v: unknown[]) => void
    idb.all.mockReturnValueOnce(new Promise((r) => { release = r }))
    render(<PosApp />)
    await flush()
    act(() => fire('device_unpaired'))
    act(() => { window.dispatchEvent(new Event('offline')) })               // a render while the hold is still running
    await flush()
    act(() => { fire('device_unpaired'); auth.listener?.('SIGNED_OUT') })
    await act(async () => { release([]) })
    await flush()
    expect(screen.getByText('This device was unpaired. Ask HQ to activate it again.')).toBeTruthy()
    expect(idb.createIdbStore).toHaveBeenCalledTimes(1)
    expect(api.forgetDevice).toHaveBeenCalledTimes(1)
  })

  it('Lock ends the session once, even when two access_changed refusals arrive with it', async () => {
    signedInUntilEnded()
    render(<PosApp />)
    await flush()
    expect(lastTill().locked).toBe(false)
    act(() => { (lastTill().onLock as () => void)(); fire('access_changed'); fire('access_changed') })
    await flush()
    expect(api.endSession).toHaveBeenCalledTimes(1)
    expect(api.endSession).toHaveBeenCalledWith('locked')
    expect(lastTill().locked).toBe(true)
  })

  it('a network blip on whoami when the network returns keeps whoever is signed in', async () => {
    signedInUntilEnded()
    render(<PosApp />)
    await flush()
    expect(lastTill().locked).toBe(false)
    const calls = api.fetchWhoAmI.mock.calls.length
    api.fetchWhoAmI.mockRejectedValue(new TypeError('Failed to fetch'))
    act(() => { window.dispatchEvent(new Event('offline')) })
    act(() => { window.dispatchEvent(new Event('online')) })
    await flush()
    expect(api.fetchWhoAmI.mock.calls.length).toBeGreaterThan(calls)
    expect(lastTill().locked).toBe(false)
    expect(screen.queryByTestId('lock-screen')).toBeNull()
  })

  it('two access_changed refusals together start one Lock', async () => {
    signedInUntilEnded()
    render(<PosApp />)
    await flush()
    act(() => { fire('access_changed'); fire('access_changed') })
    await flush()
    expect(api.endSession).toHaveBeenCalledTimes(1)
    expect(api.endSession).toHaveBeenCalledWith('access_changed')
    expect(screen.getByText('Your access here has changed. Ask your manager.')).toBeTruthy()
  })
})
