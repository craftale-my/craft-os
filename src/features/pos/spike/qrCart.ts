export type CartItem = { menuItemId: string; qty: number; note: null }

/** Items actually sent to the server: qty > 0 only, sorted by menuItemId. */
export function cartItems(cart: Record<string, number>): CartItem[] {
  return Object.entries(cart)
    .filter(([, qty]) => qty > 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([menuItemId, qty]) => ({ menuItemId, qty, note: null }))
}

/** Stable identity of the cart contents; the idempotency key follows this. */
export function cartKey(cart: Record<string, number>): string {
  return JSON.stringify(cartItems(cart).map((i) => [i.menuItemId, i.qty]))
}
