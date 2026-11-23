// src/features/pos/members/membersView.ts
/** Pure helpers of the Members page: dates, ledger words, and the checks run before the server is asked. */
import type { LedgerEntry, LedgerKind } from './membersApi'

const TZ = 'Asia/Kuala_Lumpur'

/** "23 Nov 2026" (Malaysia time); "—" for none. */
export function dateMy(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ })
}

/** "23 Nov 2026, 14:05" (Malaysia time). */
export function dateTimeMy(iso: string): string {
  const d = new Date(iso)
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ })
  return `${dateMy(iso)}, ${time}`
}

export const KIND_LABEL: Record<LedgerKind, string> = { earn: 'Earned', refund: 'Refund', adjust: 'Adjusted' }

/** "+42", "−5" (a real minus sign). */
export const signedPoints = (n: number): string => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '0')

/** The ledger's "Bill no. / reason" cell: the bill number, the reason, or both. */
export function billOrReason(e: Pick<LedgerEntry, 'billNo' | 'reason'>): string {
  return [e.billNo, e.reason].filter((x): x is string => !!x && x.trim() !== '').join(' · ') || '—'
}

/** The search box keeps digits only (the server does the same; a full number's leading 60 / 0 is dropped there). */
export const searchDigits = (q: string): string => q.replace(/\D/g, '')

export const ADJUST_LIMIT = 100000
/** The server keeps 200 characters of a reason: the field stops there and the check says so. */
export const REASON_MAX = 200

/** Adjust points: a whole number between −100000 and 100000, not 0, and a reason of at most 200 characters.
 *  The error, or the points. */
export function checkAdjust(amount: string, reason: string): { error: string } | { points: number } {
  const t = amount.trim().replace(/^\+/, '').replace(/^−/, '-')
  if (!/^-?\d+$/.test(t)) return { error: 'Enter a whole number of points, like 20 or -20.' }
  const points = Number(t)
  if (points === 0 || Math.abs(points) > ADJUST_LIMIT) return { error: `Enter a number of points between -${ADJUST_LIMIT} and ${ADJUST_LIMIT}, not 0.` }
  if (reason.trim() === '') return { error: 'A reason is required.' }
  if (reason.trim().length > REASON_MAX) return { error: `Keep the reason to ${REASON_MAX} characters.` }
  return { points }
}

/** Settings: points per RM 1 from 0 to 100 (2 decimals), Sign-in codes per day a whole number from 0 to 100000. */
export function checkSettings(rate: string, cap: string): { error: string } | { rate: number; smsDailyCap: number } {
  const r = Number(rate)
  if (rate.trim() === '' || !Number.isFinite(r) || r < 0 || r > 100 || Math.abs(Math.round(r * 100) - r * 100) > 1e-6) {
    return { error: 'Points per RM 1 must be a number from 0 to 100.' }
  }
  const c = Number(cap)
  if (cap.trim() === '' || !Number.isInteger(c) || c < 0 || c > 100000) return { error: 'Sign-in codes per day must be a whole number from 0 to 100000.' }
  return { rate: r, smsDailyCap: c }
}
