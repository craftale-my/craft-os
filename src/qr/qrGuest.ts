/** Who this phone is at a table (docs/superpowers/specs/2026-11-22-qr-shared-table-cart-design.md §3):
 *  a random id, a name and an avatar, kept per table code. No sign-in. */
export interface Guest { id: string; name: string; avatar: string }
export type GuestStorage = Pick<Storage, 'getItem' | 'setItem'>

export const AVATARS: readonly { key: string; emoji: string }[] = [
  { key: 'a1', emoji: '🙂' }, { key: 'a2', emoji: '😎' }, { key: 'a3', emoji: '🐱' }, { key: 'a4', emoji: '🐶' },
  { key: 'a5', emoji: '🦊' }, { key: 'a6', emoji: '🐼' }, { key: 'a7', emoji: '☕' }, { key: 'a8', emoji: '🌻' },
]
export const DEFAULT_NAME = 'Guest'
export const NAME_MAX = 20

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isAvatar = (key: unknown): key is string => typeof key === 'string' && AVATARS.some((a) => a.key === key)
const storageKey = (token: string) => `qr-guest-${token}`
/** the visit's guests when the browser gives no storage (private mode) */
const memory = new Map<string, Guest>()

export const avatarEmoji = (key: string | null | undefined): string => AVATARS.find((a) => a.key === key)?.emoji ?? ''

/** The name as the server will store it: no control characters, trimmed, at most 20, 'Guest' when empty. */
export function cleanName(text: string): string {
  // eslint-disable-next-line no-control-regex
  const t = text.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX).trim()
  return t === '' ? DEFAULT_NAME : t
}

export const randomAvatar = (rand: () => number = Math.random): string =>
  AVATARS[Math.min(AVATARS.length - 1, Math.floor(rand() * AVATARS.length))].key

export const newGuest = (name: string, avatar: string, id: string = crypto.randomUUID()): Guest =>
  ({ id, name: cleanName(name), avatar: isAvatar(avatar) ? avatar : 'a1' })

function browserStorage(): GuestStorage | null {
  try { return window.localStorage } catch { return null }
}

export function loadGuest(token: string, storage: GuestStorage | null = browserStorage()): Guest | null {
  let raw: string | null | undefined
  try { raw = storage?.getItem(storageKey(token)) } catch { raw = undefined /* unreadable storage: use the visit's memory */ }
  if (raw == null) return memory.get(token) ?? null
  return parseGuest(raw)
}

/** A stored value that is not a guest (corrupt or foreign) counts as no guest. */
function parseGuest(raw: string): Guest | null {
  try {
    const g = JSON.parse(raw) as Partial<Guest> | null
    if (g && typeof g.id === 'string' && UUID.test(g.id) && typeof g.name === 'string' && isAvatar(g.avatar)) {
      return { id: g.id, name: cleanName(g.name), avatar: g.avatar }
    }
  } catch { /* not JSON */ }
  return null
}

export function saveGuest(token: string, guest: Guest, storage: GuestStorage | null = browserStorage()): void {
  memory.set(token, guest)
  try { storage?.setItem(storageKey(token), JSON.stringify(guest)) } catch { /* the visit's memory holds it */ }
}
