// src/features/pos/order/useBillMember.ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchBillMember, type BillMember } from './billMember'
import { readableError } from '../checkout/rpcResult'

/** What the till knows about a bill's member. `member` means something only when `status` is 'ok' AND
 *  `billId` is the bill on screen: a line or an attach form is never drawn over an unknown state. */
export interface BillMemberState {
  billId: string | null
  status: 'loading' | 'ok' | 'error'
  member: BillMember | null
  error: string | null
}

/** The bill's member (members spec §3 "Staff (POS)"), read on every refresh. A bill switch starts again at
 *  'loading'; a background re-read that fails keeps an earlier good read of the same bill. `set` records
 *  what Attach / Remove answered, and any read started before it is ignored when it lands. */
export function useBillMember(billId: string | null, refreshKey: unknown) {
  const [state, setState] = useState<BillMemberState>({ billId, status: 'loading', member: null, error: null })
  const [tryKey, setTryKey] = useState(0)
  const seq = useRef(0)
  useEffect(() => {
    if (!billId) return
    const mine = ++seq.current
    setState((s) => (s.billId === billId && s.status === 'ok' ? s : { billId, status: 'loading', member: null, error: null }))
    fetchBillMember(billId).then(
      (m) => { if (mine === seq.current) setState({ billId, status: 'ok', member: m, error: null }) },
      (e: unknown) => {
        if (mine !== seq.current) return
        setState((s) => (s.billId === billId && s.status === 'ok' ? s : { billId, status: 'error', member: null, error: readableError(e) }))
      },
    )
  }, [billId, refreshKey, tryKey])
  const set = useCallback((m: BillMember | null) => {
    ++seq.current
    if (billId) setState({ billId, status: 'ok', member: m, error: null })
  }, [billId])
  const retry = useCallback(() => setTryKey((k) => k + 1), [])
  const current: BillMemberState = state.billId === billId ? state : { billId, status: 'loading', member: null, error: null }
  return { state: current, member: current.status === 'ok' ? current.member : null, set, retry }
}
