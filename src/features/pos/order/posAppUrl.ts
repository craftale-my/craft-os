/** The POS app's address for Craft OS /pos (VITE_POS_APP_URL; dev https://craft-pos-dev.vercel.app).
 *  Null when unset or not an http(s) address, so the page shows its fallback text instead of a link. */
export function posAppUrl(raw: string | undefined | null): string | null {
  const value = raw?.trim().replace(/\/+$/, '') ?? ''
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? value : null
  } catch {
    return null
  }
}
