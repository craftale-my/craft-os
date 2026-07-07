const round1 = (n: number) => Math.round(n * 10) / 10

/** AL balance from the accrual ledger. `balance` ignores pending requests;
 *  `available` also reserves pending annual days so double-applying can't
 *  overspend. */
export function calcAlBalance(
  entries: { amount: number }[],
  approvedDays: number,
  pendingDays: number,
): { balance: number; available: number } {
  const accrued = entries.reduce((sum, e) => sum + e.amount, 0)
  const balance = round1(accrued - approvedDays)
  return { balance, available: round1(balance - pendingDays) }
}

/** Earliest-expiring `days` grants (FIFO by expiry), or null if not enough. */
export function pickPhGrantsFifo<G extends { id: string; expires_at: string }>(
  grants: G[],
  days: number,
): G[] | null {
  if (grants.length < days) return null
  return [...grants].sort((a, b) => a.expires_at.localeCompare(b.expires_at)).slice(0, days)
}
