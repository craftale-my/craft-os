// src/qr/member/useMember.ts
/** This phone's member sign-in on the QR page (spec 2026-11-22-members-phone-points-design.md §3, §8): the
 *  token in localStorage for 180 days (any table of ours), the balance read from `member_me`.
 *  - `off`: the QR switch is off, or the settings could not be read (a front end before its SQL) — no button.
 *  - `out`: no token, or the server said it no longer knows it (quietly forgotten).
 *  - `in`: a stored token. `me` is null until its balance comes back (the button shows `★ …`); a read
 *    that gets no reply is tried again after 1 s, 3 s and 8 s. Only a definite `null` from the server signs out.
 *  Another tab's sign-in or sign-out is picked up from the `storage` event. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemberApi, MemberMe } from './memberApi'

export const MEMBER_TOKEN_KEY = 'craft-member-token'
export type MemberStatus = 'off' | 'out' | 'in'
export type TokenStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
/** the waits before reading the balance again after a read with no reply */
export const RETRY_MS = [1000, 3000, 8000] as const

/** the visit's token when the browser gives no storage (private mode) */
let memoryToken: string | null = null
/** tests only */
export const resetMemberMemory = () => { memoryToken = null }

function browserStorage(): TokenStorage | null {
  try { return window.localStorage } catch { return null }
}
export function loadToken(storage: TokenStorage | null = browserStorage()): string | null {
  try {
    const t = storage?.getItem(MEMBER_TOKEN_KEY)
    if (t != null) return t || null
  } catch { /* unreadable storage: the visit's memory */ }
  return memoryToken
}
export function saveToken(token: string | null, storage: TokenStorage | null = browserStorage()): void {
  memoryToken = token
  try { if (token) storage?.setItem(MEMBER_TOKEN_KEY, token); else storage?.removeItem(MEMBER_TOKEN_KEY) } catch { /* memory holds it */ }
}
/** Remove the stored token only while it is still `dead` (another tab may have signed in since). */
export function clearTokenIf(dead: string, storage: TokenStorage | null = browserStorage()): void {
  if (memoryToken === dead) memoryToken = null
  try { if (storage?.getItem(MEMBER_TOKEN_KEY) === dead) storage.removeItem(MEMBER_TOKEN_KEY) } catch { /* nothing stored */ }
}

export interface Member {
  status: MemberStatus
  me: MemberMe | null
  token: string | null
  /** the earn rate from the settings (points per RM 1) */
  rate: number
  /** read the balance again; a dead token signs out quietly */
  refresh(): Promise<void>
  /** after a verified code */
  signIn(token: string): Promise<MemberMe | null>
  /** Sign out: forgets the token here, then tells the server (whatever it says) */
  signOut(): Promise<void>
  /** forget a token the server no longer knows, without a call — only while it is still the stored one */
  forget(dead: string): void
}

export function useMember(api: MemberApi, storage?: TokenStorage | null): Member {
  const store = useRef(storage === undefined ? browserStorage() : storage)
  const [enabled, setEnabled] = useState<boolean | null>(null)   // null: not read yet
  const [rate, setRate] = useState(1)
  const [token, setToken] = useState<string | null>(() => loadToken(store.current))
  const [me, setMe] = useState<MemberMe | null>(null)
  const tokenRef = useRef(token)
  const seq = useRef(0)                                           // an older reply never lands after a newer one
  const retry = useRef<{ timer: ReturnType<typeof setTimeout> | null; n: number }>({ timer: null, n: 0 })
  const readRef = useRef<(t: string) => Promise<MemberMe | null>>(async () => null)

  const stopRetry = useCallback(() => {
    if (retry.current.timer) clearTimeout(retry.current.timer)
    retry.current = { timer: null, n: 0 }
  }, [])
  /** show `t` as this phone's token (null: signed out), as stored here or in another tab */
  const adopt = useCallback((t: string | null) => {
    if (tokenRef.current === t) return
    stopRetry(); seq.current++
    tokenRef.current = t; setToken(t); setMe(null)
    if (t) void readRef.current(t)
  }, [stopRetry])
  const forget = useCallback((dead: string) => {
    clearTokenIf(dead, store.current)
    if (tokenRef.current !== dead) return                          // already another token here
    const stored = loadToken(store.current)
    adopt(stored && stored !== dead ? stored : null)
  }, [adopt])
  const read = useCallback(async (t: string): Promise<MemberMe | null> => {
    const mine = ++seq.current
    if (retry.current.timer) { clearTimeout(retry.current.timer); retry.current.timer = null }
    let got: MemberMe | null
    try { got = await api.memberMe(t) } catch {
      // no reply (a weak connection): keep the token and try again a little later
      if (mine === seq.current && tokenRef.current === t && retry.current.n < RETRY_MS.length) {
        const wait = RETRY_MS[retry.current.n++]
        retry.current.timer = setTimeout(() => { retry.current.timer = null; void readRef.current(t) }, wait)
      }
      return null
    }
    if (mine !== seq.current || tokenRef.current !== t) return got
    retry.current.n = 0
    if (got === null) forget(t); else setMe(got)
    return got
  }, [api, forget])
  useEffect(() => { readRef.current = read }, [read])
  const refresh = useCallback(async () => {
    const t = tokenRef.current
    if (!t) return
    retry.current.n = 0
    await read(t)
  }, [read])

  useEffect(() => {
    let live = true
    api.memberPublicSettings().then((s) => { if (live) { setEnabled(s.qrEnabled); setRate(s.rate) } }, () => { if (live) setEnabled(false) })
    return () => { live = false }
  }, [api])
  // on entry, and whenever the page comes back into view
  useEffect(() => {
    void refresh()
    const onVis = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [refresh])
  // another tab signed in or out
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && e.key !== MEMBER_TOKEN_KEY) return
      adopt(loadToken(store.current))
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [adopt])
  useEffect(() => stopRetry, [stopRetry])

  const signIn = useCallback(async (t: string) => {
    saveToken(t, store.current)
    stopRetry(); tokenRef.current = t; setToken(t); setMe(null)
    return read(t)
  }, [read, stopRetry])
  const signOut = useCallback(async () => {
    const t = tokenRef.current
    saveToken(null, store.current)
    adopt(null)
    if (t) { try { await api.memberSignOut(t) } catch { /* the token is gone from this phone anyway */ } }
  }, [api, adopt])

  const status: MemberStatus = enabled !== true ? 'off' : !token ? 'out' : 'in'
  return { status, me, token, rate: me?.rate ?? rate, refresh, signIn, signOut, forget }
}
