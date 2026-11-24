import { useEffect, useRef } from 'react'
import { idleDue, idleStart, idleTick, idleTouch } from './idleLock'

const TICK_MS = 5_000

/** Calls onIdle once after `minutes` with no touch or key press while `active` (someone is
 *  signed in). Time while not `online` (the server unreachable) does not count (idleLock.ts). */
export function useIdleLock(minutes: number, active: boolean, online: boolean, onIdle: () => void): void {
  const cb = useRef(onIdle)
  cb.current = onIdle
  const onlineRef = useRef(online)
  onlineRef.current = online
  useEffect(() => {
    if (!active) return
    let s = idleStart(Date.now())
    const touch = () => { s = idleTouch(Date.now()) }
    const timer = window.setInterval(() => {
      s = idleTick(s, Date.now(), onlineRef.current)
      if (idleDue(s, minutes)) { window.clearInterval(timer); cb.current() }
    }, TICK_MS)
    window.addEventListener('pointerdown', touch, true)
    window.addEventListener('keydown', touch, true)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('pointerdown', touch, true)
      window.removeEventListener('keydown', touch, true)
    }
  }, [minutes, active])
}
