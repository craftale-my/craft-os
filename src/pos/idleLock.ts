/** Auto-lock (spec §2): the session ends after `minutes` with no touch. Time spent offline does
 *  not count — nobody could sign in again until the network is back. */

export interface IdleState { idleMs: number; lastTick: number }

export const idleStart = (now: number): IdleState => ({ idleMs: 0, lastTick: now })

/** A touch or key press starts the period again. */
export const idleTouch = (now: number): IdleState => idleStart(now)

/** Time passes; it is counted only while online. */
export function idleTick(s: IdleState, now: number, online: boolean): IdleState {
  return { idleMs: online ? s.idleMs + Math.max(0, now - s.lastTick) : s.idleMs, lastTick: now }
}

export const idleDue = (s: IdleState, minutes: number): boolean => s.idleMs >= minutes * 60_000
