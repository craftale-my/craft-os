// src/qr/member/useQrMember.ts
/** The member wiring of the QR page, kept out of QrApp (spec 2026-11-22-members-phone-points-design.md §3,
 *  §7, §8): the sheet, and linking the table's open bill to this phone's member.
 *  `member_link_table` links only a guest who has an ordered item on the open bill, so it is called when the
 *  table state shows ordered items (on entry, after sign-in, on a new bill) and again after each send of
 *  this phone. It never blocks or fails an order: an error is ignored, a dead token signs out quietly. */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { MemberApi } from './memberApi'
import { useMember, type TokenStorage } from './useMember'
import type { TableState } from '../useQrMenu'

export const LINKED_TEXT = 'Points from this bill go to your number.'
/** the mask keeps to one line (no-break spaces) */
export const otherMemberText = (mask: string) => `This table's points are going to ${mask.replace(/ /g, '\u00a0')}.`
const toastKey = (tableToken: string) => `craft-member-link-toast:${tableToken}`

export function useQrMember({ api, tableToken, guestId, state, say, storage }: {
  api: MemberApi
  tableToken: string | null
  guestId: string | null
  state: TableState | null
  say: (text: string) => void
  storage?: TokenStorage | null
}) {
  const member = useMember(api, storage)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [linkedBill, setLinkedBill] = useState<string | null | undefined>(undefined)   // the bill no. this phone's member is linked to
  const [sends, setSends] = useState(0)
  const seq = useRef(0)
  const sayRef = useRef(say)
  useEffect(() => { sayRef.current = say })
  // the toast is said once per bill and answer, also across a reload
  const toasted = useRef<string | null>(null)
  if (toasted.current === null && tableToken) { try { toasted.current = sessionStorage.getItem(toastKey(tableToken)) ?? '' } catch { toasted.current = '' } }

  const billNo = state?.billNo ?? null
  const ordered = (state?.items.length ?? 0) > 0
  const { status, token, forget, refresh } = member

  useEffect(() => {
    if (status !== 'in' || !token || !tableToken || !guestId || !ordered) return
    const mine = ++seq.current
    let live = true                                                  // a reply after sign-out or a newer run shows nothing
    api.memberLinkTable(tableToken, token, guestId).then((r) => {
      if (!live || mine !== seq.current) return
      if (r === null) { forget(token); return }                      // the server no longer knows this phone's token
      if (r.linked) setLinkedBill(billNo)
      const text = r.linked ? LINKED_TEXT : r.phoneMasked ? otherMemberText(r.phoneMasked) : null
      if (!text) return                                              // this guest has not ordered on the bill: nothing to say
      const key = `${billNo ?? ''}|${text}`
      if (toasted.current === key) return
      toasted.current = key
      try { sessionStorage.setItem(toastKey(tableToken), key) } catch { /* this visit only */ }
      sayRef.current(text)
    }, () => { /* offline for a moment: the next send or entry tries again */ })
    return () => { live = false }
  }, [api, status, token, tableToken, guestId, ordered, billNo, sends, forget])

  // the bill was paid or a new one started: the balance may have moved
  const lastBill = useRef(billNo)
  useEffect(() => {
    if (lastBill.current === billNo) return
    lastBill.current = billNo
    void refresh()
  }, [billNo, refresh])

  return {
    member,
    sheetOpen,
    openSheet: useCallback(() => setSheetOpen(true), []),
    closeSheet: useCallback(() => setSheetOpen(false), []),
    /** call after this phone's order was sent */
    afterSend: useCallback(() => setSends((n) => n + 1), []),
    /** signed in and this bill is linked to this phone's member: the Order details line */
    linked: status === 'in' && linkedBill !== undefined && linkedBill === billNo,
  }
}
