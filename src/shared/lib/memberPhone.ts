// src/shared/lib/memberPhone.ts
/** Malaysian mobile numbers (the QR page, the till and the back office) (spec 2026-11-22-members-phone-points-design.md §4).
 *  The same rule as member-auth's `normalisePhone` (both tests run memberPhoneCases.ts): NFKC first, so
 *  full-width digits and signs become ASCII; then every space, dash, invisible format mark (the bidi marks
 *  a contacts app wraps a pasted number in), bracket and dot is dropped; then `+60` / `60` / `0060`, then
 *  one `0`; accept `1(1\d{8}|[02-9]\d{7})`. Callers send the E.164 result, never the raw input, so the
 *  narrower SQL `member_phone_normalise` (ASCII separators only) always accepts it. */

export function normalisePhone(input: string | null | undefined): string | null {
  const n = (input ?? '').normalize('NFKC').replace(/[\s\p{Pd}\p{Cf}\u2212().]/gu, '')
    .replace(/^(\+?60|0060)/, '').replace(/^0/, '')
  return /^1(1[0-9]{8}|[02-9][0-9]{7})$/.test(n) ? '+60' + n : null
}

/** `+60123456789` → `+60 ••• ••6789`, the server's mask (`member_phone_mask`). */
export function maskPhone(e164: string): string {
  const d = e164.replace(/\D/g, '')
  return `+60 ••• ••${d.slice(-4)}`
}

/** `+60123456789` → `+60 12-345 6789`; `+601123456789` → `+60 11-2345 6789`. Anything else is returned as given. */
export function formatPhone(e164: string): string {
  const m = /^\+60(1\d)(\d{3,4})(\d{4})$/.exec(e164)
  return m ? `+60 ${m[1]}-${m[2]} ${m[3]}` : e164
}

/** `+60123456789` → `••6789`: the till's short form (bill column, receipt). */
export function shortMask(e164: string): string {
  return `••${e164.replace(/\D/g, '').slice(-4)}`
}
