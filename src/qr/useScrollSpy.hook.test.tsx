// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'
import { useScrollSpy } from './useScrollSpy'

afterEach(() => { cleanup(); vi.useRealTimers() })

// section tops relative to the viewport, as the page "scrolls"
let tops = [0, 500, 1000]
function Spy({ onReady }: { onReady: (s: ReturnType<typeof useScrollSpy>) => void }) {
  const bar = useRef<HTMLElement>(null)
  const spy = useScrollSpy(['s0', 's1', 's2'], bar)
  onReady(spy)
  return (
    <>
      <nav ref={bar} />
      {[0, 1, 2].map((i) => <section key={i} id={`s${i}`} ref={(el) => { if (el) el.getBoundingClientRect = () => ({ top: tops[i] } as DOMRect) }} />)}
    </>
  )
}

describe('useScrollSpy jump', () => {
  it('holds the tapped section while the page keeps scrolling, then follows the page once it is quiet', () => {
    vi.useFakeTimers()
    window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
    let spy!: ReturnType<typeof useScrollSpy>
    render(<Spy onReady={(s) => { spy = s }} />)
    expect(spy.active).toBe(0)
    act(() => spy.jumpTo(2))
    expect(spy.active).toBe(2)
    // on the way: section 1 passes the line, scroll events keep coming
    for (let k = 0; k < 10; k++) {
      tops = [-300 - k * 50, 0 - k * 10, 400]
      act(() => { window.dispatchEvent(new Event('scroll')); vi.advanceTimersByTime(100) })
      expect(spy.active).toBe(2)
    }
    // arrived (just under the bar would be 0 here: the bar is 0 px tall in jsdom) and quiet
    tops = [-2000, -1000, 0]
    act(() => { window.dispatchEvent(new Event('scroll')); vi.advanceTimersByTime(200) })
    expect(spy.active).toBe(2)
    // a jump that ends short of its target hands back to the page
    tops = [-500, 0, 300]
    act(() => { spy.jumpTo(2); vi.advanceTimersByTime(500) })
    expect(spy.active).toBe(1)
  })
})
