/** Where a table's QR code points. Production serves the customer page at /t/<token>
 *  (vercel.json rewrite → qr/index.html); the Vite dev server has no rewrite, so it
 *  is /qr/?t=<token> there. The page reads both. */
export function qrLink(origin: string, token: string, dev: boolean): string {
  return dev ? `${origin}/qr/?t=${token}` : `${origin}/t/${token}`
}

/** 12 random bytes as hex — the same shape as dining_tables.qr_token's default. */
export function newQrToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}
