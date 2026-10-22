import type { OrderLine } from '../features/pos/order/cart'

/** /t/<token> is what the printed QR card carries (vercel rewrite); the Vite
 *  dev server has no rewrite, so there the page is /qr/?t=<token>. */
export function tokenFromLocation(pathname: string, search: string): string | null {
  const m = pathname.match(/^\/t\/([A-Za-z0-9]+)\/?$/)
  if (m) return m[1]
  const t = new URLSearchParams(search).get('t')
  return t && /^[A-Za-z0-9]+$/.test(t) ? t : null
}

export const addLine = (lines: OrderLine[], line: OrderLine): OrderLine[] => [...lines, line]
export const replaceLine = (lines: OrderLine[], i: number, line: OrderLine): OrderLine[] => lines.map((l, k) => (k === i ? line : l))
export const removeLine = (lines: OrderLine[], i: number): OrderLine[] => lines.filter((_, k) => k !== i)
