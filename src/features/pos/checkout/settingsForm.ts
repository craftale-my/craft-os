/** Pure helpers for the checkout sections of /pos/settings. */

/** "10" → 1000, "6.5" → 650, "0" → 0; null when not a percentage between 0 and 100 with at most two decimals. */
export function parsePercentBp(text: string): number | null {
  const t = text.replace('%', '').trim()
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(t)) return null
  const bp = Math.round(Number(t) * 100)
  return bp <= 10000 ? bp : null
}

/** 1000 → "10", 650 → "6.5". */
export function bpToPercentText(bp: number): string {
  return String(Number((bp / 100).toFixed(2)))
}

/** One reason per line; blank lines and repeats dropped. */
export function parseReasons(text: string): string[] {
  return [...new Set(text.split('\n').map((s) => s.trim()).filter(Boolean))]
}

export interface ReceiptDetailsForm {
  receiptTitle: string
  legalName: string
  registrationNo: string
  sstNo: string
  address: string
  phone: string
  email: string
  footer: string
}

export function receiptDetailsProblem(f: ReceiptDetailsForm): string | null {
  if (!f.receiptTitle.trim()) return 'Enter the receipt title (the shop name printed at the top)'
  if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) return 'The email address does not look right'
  if (f.footer.length > 300) return 'The footer is too long (300 characters at most)'
  return null
}

/** "All tables" or "3 tables" for a rule row. */
export function scopeLabel(ids: string[] | null, noun: string): string {
  if (ids === null) return `All ${noun}s`
  return `${ids.length} ${noun}${ids.length === 1 ? '' : 's'}`
}
