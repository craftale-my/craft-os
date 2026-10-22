export const LATENCY_BUDGET_MS = 2000

/** Postgres sends microseconds ("…:00.123456+00:00"); Safari's Date.parse
 *  rejects more than three fraction digits, so trim them first. */
export function parseServerTime(iso: string): number {
  return Date.parse(iso.replace(/(\.\d{3})\d+/, '$1'))
}

/** Server clock minus local clock, from one request/response round trip —
 *  the server's "now" is assumed to sit at the midpoint. */
export function clockOffsetMs(sentAtLocal: number, serverIso: string, receivedAtLocal: number): number {
  return parseServerTime(serverIso) - (sentAtLocal + receivedAtLocal) / 2
}

/** How long after the server stamped placed_at this device saw the order. */
export function latencyMs(placedAtIso: string, receivedAtLocal: number, offsetMs: number): number {
  return receivedAtLocal + offsetMs - parseServerTime(placedAtIso)
}
