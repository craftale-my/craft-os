// @vitest-environment jsdom
// src/shared/lib/customerService.open.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getSession = vi.fn()
vi.mock('./supabase', () => ({ supabase: { auth: { getSession: (...a: unknown[]) => getSession(...a) } } }))

const { openCustomerService, CS_MESSAGES } = await import('./customerService')

const res = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function fakeTab() {
  return {
    opener: {} as unknown,
    document: { title: '', body: { textContent: '' } },
    location: { href: '' },
    close: vi.fn(),
  }
}

let tab: ReturnType<typeof fakeTab>
let openSpy: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.stubEnv('VITE_CRAFT_API_URL', 'https://api.test')
  vi.stubEnv('VITE_CRAFT_MARKETING_URL', 'https://cm.test/')
  tab = fakeTab()
  openSpy = vi.fn(() => tab)
  vi.stubGlobal('open', openSpy)
  window.open = openSpy as unknown as typeof window.open
  getSession.mockReset()
  getSession.mockResolvedValue({ data: { session: { access_token: 'tok' } } })
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('openCustomerService', () => {
  it('closes the tab and reports unavailable when getSession rejects', async () => {
    getSession.mockRejectedValue(new Error('storage locked'))
    await expect(openCustomerService()).resolves.toBe(CS_MESSAGES.unavailable)
    expect(tab.close).toHaveBeenCalledTimes(1)
  })

  it('closes the tab and reports no access on 403', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(403)))
    await expect(openCustomerService()).resolves.toBe(CS_MESSAGES.no_access)
    expect(tab.close).toHaveBeenCalledTimes(1)
    expect(tab.location.href).toBe('')
  })

  it('points the tab at <marketing>/sso#t=<ticket> on 200', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, { ticket: 'abc', expiresIn: 60 })))
    await expect(openCustomerService()).resolves.toBeNull()
    expect(tab.location.href).toBe('https://cm.test/sso#t=abc')
    expect(tab.close).not.toHaveBeenCalled()
    expect(tab.opener).toBeNull()
  })

  it('does nothing and reports unavailable when the env vars are missing', async () => {
    vi.stubEnv('VITE_CRAFT_API_URL', '')
    await expect(openCustomerService()).resolves.toBe(CS_MESSAGES.unavailable)
    expect(openSpy).not.toHaveBeenCalled()
  })

  it('falls back to this tab when the pop-up is blocked', async () => {
    openSpy.mockReturnValue(null as never)
    vi.stubGlobal('fetch', vi.fn(async () => res(200, { ticket: 'abc' })))
    const original = window.location
    const loc = { href: 'http://localhost/' }
    Object.defineProperty(window, 'location', { configurable: true, value: loc })
    try {
      await expect(openCustomerService()).resolves.toBeNull()
      expect(loc.href).toBe('https://cm.test/sso#t=abc')
    } finally {
      Object.defineProperty(window, 'location', { configurable: true, value: original })
    }
  })
})
