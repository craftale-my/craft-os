/** Takeaway call numbers on screen (W4 spec §2): TA001–TA999 per outlet and business day (bills.call_no). */

/** "TA012 · Takeaway"; "Takeaway" for a bill without a number (before W4). */
export function takeawayLabel(callNo: string | null | undefined): string {
  return callNo ? `${callNo} · Takeaway` : 'Takeaway'
}

/** The Transactions search: "TA12", "ta012", "12" and " TA 012 " all find TA012 — any case, spaces ignored,
 *  leading zeros optional, the prefix optional. */
export function callNoMatches(callNo: string | null | undefined, search: string): boolean {
  if (!callNo) return false
  const q = search.toLowerCase().replace(/\s+/g, '')
  if (!q) return false
  const c = callNo.toLowerCase()
  if (c.includes(q)) return true
  const asked = /^([a-z]*)0*(\d{1,3})$/.exec(q)
  const own = /^([a-z]+)(\d+)$/.exec(c)
  return !!asked && !!own && (asked[1] === '' || asked[1] === own[1]) && Number(asked[2]) === Number(own[2])
}
