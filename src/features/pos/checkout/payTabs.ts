// src/features/pos/checkout/payTabs.ts
/** Pure parts of the full-screen Payment (spec §4): the method tabs, the number pad, and the one
 *  payment of a bill paid in one go. tender.ts keeps every money rule; this only arranges it. */
import { lineProblem, parseRinggit, type PaymentKind, type TenderLine, type TenderMethod } from './tender'

export type PayTab = 'cash' | 'card' | 'epay' | 'other'
export const PAY_TAB_LABEL: Record<PayTab, string> = { cash: 'Cash', card: 'Card', epay: 'E-payment', other: 'Other' }
const TAB_OF: Record<PaymentKind, PayTab> = { cash: 'cash', card: 'card', duitnow: 'epay', ewallet: 'epay', other: 'other' }
const ORDER: PayTab[] = ['cash', 'card', 'epay', 'other']

export interface PayTabGroup { tab: PayTab; label: string; methods: TenderMethod[] }

/** Cash · Card · E-payment (DuitNow and e-wallets) · Other, each with its active methods in their
 *  order; a tab with none is left out. */
export function payTabs(methods: TenderMethod[]): PayTabGroup[] {
  return ORDER
    .map((tab) => ({ tab, label: PAY_TAB_LABEL[tab], methods: methods.filter((m) => TAB_OF[m.kind] === tab) }))
    .filter((g) => g.methods.length > 0)
}

export const NUMPAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'] as const

/** One key on the number pad. The text only ever becomes something parseRinggit reads (at most
 *  6 whole digits and 2 decimals); a key that would break that is ignored. 'C' clears. */
export function numpadPress(text: string, key: string): string {
  if (key === 'C') return ''
  if (key === '⌫') return text.slice(0, -1)
  if (key === '.') return text.includes('.') ? text : text === '' ? '0.' : `${text}.`
  if (!/^\d$/.test(key)) return text
  const next = text === '0' ? key : text + key
  return parseRinggit(next) === null ? text : next
}

/** The bill paid in one go (Split payment off): one payment of the whole total with the chosen
 *  method; cash with what was received ('' = exact). A bill of RM 0.00 takes no payment. */
export function singleLines(method: TenderMethod, totalSen: number, receivedText: string, reference: string):
  { lines: Omit<TenderLine, 'key'>[] } | { problem: string } {
  if (totalSen === 0) return { lines: [] }
  let tenderedSen: number | null = null
  if (method.kind === 'cash' && receivedText.trim()) {
    tenderedSen = parseRinggit(receivedText)
    if (tenderedSen === null) return { problem: 'Enter the cash received' }
  }
  const line = { method, amountSen: totalSen, tenderedSen, reference: reference.trim() || null }
  const problem = lineProblem(line, totalSen)
  return problem ? { problem } : { lines: [line] }
}

/** The change shown live on the Cash tab: 0 for exact, null while the cash received is short or unreadable. */
export function liveChangeSen(dueSen: number, receivedText: string): number | null {
  if (!receivedText.trim()) return 0
  const received = parseRinggit(receivedText)
  return received === null || received < dueSen ? null : received - dueSen
}
