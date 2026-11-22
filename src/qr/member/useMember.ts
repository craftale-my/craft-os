// src/qr/member/useMember.ts
/** This phone's member sign-in on the QR page (spec 2026-11-22-members-phone-points-design.md §3, §8): the
 *  token in localStorage for 180 days (any table of ours), the balance read from `member_me`.
 *  - `off`: the QR switch is off, or the settings could not be read (a front end before its SQL) — no button.
 *  - `out`: no token, or the server no longer knows it (quietly forgotten).
 *  - `in`: a live token and its balance. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemberApi, MemberMe } from './memberApi'

export const MEMBER_TOKEN_KEY = 'craft-member-token'
export type MemberStatus = 'off' | 'out' | 'in'
export type TokenStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

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
  /** Sign out: tells the server, then forgets the token here whatever the server says */
  signOut(): Promise<void>
  /** forget a token the server no longer knows, without a call */
  forget(): void
}

export function useMember(api: MemberApi, storage?: TokenStorage | null): Member {
  const store = useRef(storage === undefined ? browserStorage() : storage)
  const [enabled, setEnabled] = useState<boolean | null>(null)   // null: not read yet
  const [rate, setRate] = useState(1)
  const [token, setToken] = useState<string | null>(() => loadToken(store.current))
  const [me, setMe] = useState<MemberMe | null>(null)
  const tokenRef = useRef(token)
  const seq = useRef(0)                                           // an older reply never lands after a newer one

  const forget = useCallback(() => {
    saveToken(null, store.current); tokenRef.current = null; setToken(null); setMe(null)
  }, [])
  const read = useCallback(async (t: string): Promise<MemberMe | null> => {
    const mine = ++seq.current
    let got: MemberMe | null
    try { got = await api.memberMe(t) } catch { return null /* offline for a moment: keep what is shown */ }
    if (mine !== seq.current || tokenRef.current !== t) return got
    if (got === null) forget(); else setMe(got)
    return got
  }, [api, forget])
  const refresh = useCallback(async () => { const t = tokenRef.current; if (t) await read(t) }, [read])

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

  const signIn = useCallback(async (t: string) => {
    saveToken(t, store.current); tokenRef.current = t; setToken(t); setMe(null)
    return read(t)
  }, [read])
  const signOut = useCallback(async () => {
    const t = tokenRef.current
    forget()
    if (t) { try { await api.memberSignOut(t) } catch { /* the token is gone from this phone anyway */ } }
  }, [api, forget])

  // a stored token whose balance has not come back yet shows no button, rather than a wrong "Join"
  const status: MemberStatus = enabled !== true ? 'off' : !token ? 'out' : me ? 'in' : 'off'
  return { status, me, token, rate: me?.rate ?? rate, refresh, signIn, signOut, forget }
}
