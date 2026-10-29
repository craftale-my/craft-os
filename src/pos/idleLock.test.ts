import { describe, expect, it } from 'vitest'
import { idleDue, idleStart, idleTick, idleTouch } from './idleLock'

const MIN = 60_000

describe('idle lock', () => {
  it('is due after the set minutes with no touch', () => {
    let s = idleStart(0)
    s = idleTick(s, 9 * MIN, true)
    expect(idleDue(s, 10)).toBe(false)
    s = idleTick(s, 10 * MIN, true)
    expect(idleDue(s, 10)).toBe(true)
  })

  it('a touch starts the period again', () => {
    let s = idleTick(idleStart(0), 9 * MIN, true)
    s = idleTouch(9 * MIN)
    s = idleTick(s, 18 * MIN, true)
    expect(idleDue(s, 10)).toBe(false)
  })

  it('pauses while offline and carries on after', () => {
    let s = idleTick(idleStart(0), 6 * MIN, true)       // 6 min online
    s = idleTick(s, 30 * MIN, false)                    // 24 min offline: not counted
    expect(idleDue(s, 10)).toBe(false)
    s = idleTick(s, 34 * MIN, true)                     // 4 more online: 10
    expect(idleDue(s, 10)).toBe(true)
  })

  it('ignores a clock that went backwards', () => {
    const s = idleTick(idleStart(5 * MIN), 1 * MIN, true)
    expect(s.idleMs).toBe(0)
  })
})
