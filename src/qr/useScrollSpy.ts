// src/qr/useScrollSpy.ts
/** The menu's category bar follows the page: which section is in view, and a jump to one.
 *  The page itself scrolls (window); the sticky bar covers the top `bar.offsetHeight` pixels. */
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

/** The active section, given each section's top relative to the viewport and the line just under the
 *  sticky bar: the last one whose top has reached the line, the first before any has, and the last
 *  once the page cannot scroll further (a short last section never reaches the line). -1 = none. */
export function activeSection(tops: number[], line: number, atBottom = false): number {
  if (tops.length === 0) return -1
  if (atBottom) return tops.length - 1
  let active = 0
  tops.forEach((top, i) => { if (top <= line) active = i })
  return active
}

/** A jump scrolls smoothly; the spy holds the tapped section for this long instead of flicking
 *  through every section passed on the way. */
const JUMP_HOLD_MS = 700

export function useScrollSpy(ids: string[], bar: RefObject<HTMLElement | null>): { active: number; jumpTo: (i: number) => void } {
  const [active, setActive] = useState(0)
  const holdUntil = useRef(0)
  const key = ids.join('|')

  const measure = useCallback(() => {
    if (Date.now() < holdUntil.current) return
    const line = (bar.current?.offsetHeight ?? 0) + 1
    const tops = ids.map((id) => document.getElementById(id)?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY)
    const doc = document.documentElement
    const atBottom = window.scrollY > 0 && window.innerHeight + window.scrollY >= doc.scrollHeight - 2
    const next = activeSection(tops, line, atBottom)
    if (next >= 0) setActive(next)
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (ids.length === 0) return
    measure()
    // a section crossing the 1-pixel line under the bar is what changes the answer
    let io: IntersectionObserver | null = null
    const observe = () => {
      io?.disconnect()
      if (typeof IntersectionObserver === 'undefined') return
      const top = (bar.current?.offsetHeight ?? 0)
      const bottom = Math.max(0, window.innerHeight - top - 1)
      io = new IntersectionObserver(() => measure(), { rootMargin: `-${top}px 0px -${bottom}px 0px`, threshold: [0] })
      for (const id of ids) { const el = document.getElementById(id); if (el) io.observe(el) }
    }
    observe()
    // the bottom of the page is not a crossing: check it on scroll (cheap)
    const onScroll = () => {
      const doc = document.documentElement
      if (window.innerHeight + window.scrollY >= doc.scrollHeight - 2) measure()
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', observe)
    return () => { io?.disconnect(); window.removeEventListener('scroll', onScroll); window.removeEventListener('resize', observe) }
  }, [key, measure]) // eslint-disable-line react-hooks/exhaustive-deps

  const jumpTo = useCallback((i: number) => {
    const el = document.getElementById(ids[i] ?? '')
    if (!el) return
    setActive(i)
    holdUntil.current = Date.now() + JUMP_HOLD_MS
    window.setTimeout(measure, JUMP_HOLD_MS + 50)
    const top = el.getBoundingClientRect().top + window.scrollY - (bar.current?.offsetHeight ?? 0)
    if (typeof window.scrollTo === 'function') {
      try { window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' }) } catch { /* jsdom */ }
    }
  }, [key, measure]) // eslint-disable-line react-hooks/exhaustive-deps

  return { active: Math.min(active, Math.max(0, ids.length - 1)), jumpTo }
}
