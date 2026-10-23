import { findProduct, type OrderLine, type PosMenu } from '../features/pos/order/cart'

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

/** After the menu was read again (every minute): the names of the products in the cart that
 *  left it — outside their time slot now, switched off — once each, from the menu before. */
export function leftTheMenu(lines: OrderLine[], next: PosMenu, before: PosMenu): string[] {
  const gone = lines.filter((l) => !findProduct(next, l.productId)).map((l) => findProduct(before, l.productId)?.name ?? 'An item')
  return [...new Set(gone)]
}

/** The words the QR page shows for them. */
export function leftTheMenuNotice(names: string[]): string | null {
  if (names.length === 0) return null
  return `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} not available at this time and ${names.length === 1 ? 'was' : 'were'} taken out of your order.`
}
