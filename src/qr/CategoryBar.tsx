// src/qr/CategoryBar.tsx
import { forwardRef, useEffect, useRef, useState } from 'react'
import { ChevronDown, X } from 'lucide-react'

/** The menu's category pills, stuck to the top of the page. The pill of the section in view is filled and
 *  keeps itself in view in the bar; a tap jumps to its section; the chevron opens every category in a list. */
const CategoryBar = forwardRef<HTMLElement, {
  names: string[]
  /** index of the section in view */
  active: number
  onPick: (index: number) => void
}>(function CategoryBar({ names, active, onPick }, ref) {
  const [open, setOpen] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const pills = useRef<(HTMLButtonElement | null)[]>([])

  // the active pill scrolls itself to the middle of the bar (never the page)
  useEffect(() => {
    const bar = scroller.current, pill = pills.current[active]
    if (!bar || !pill || typeof bar.scrollTo !== 'function') return
    bar.scrollTo({ left: Math.max(0, pill.offsetLeft - bar.clientWidth / 2 + pill.offsetWidth / 2), behavior: 'smooth' })
  }, [active])

  const pick = (i: number) => { setOpen(false); onPick(i) }
  return (
    <nav ref={ref} aria-label="Categories" className="sticky top-0 z-20 bg-cream">
      <div className="relative">
        <div ref={scroller} className="flex gap-2 overflow-x-auto py-2.5 pl-4 pr-12 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {names.map((n, i) => (
            <button key={`${i}:${n}`} ref={(el) => { pills.current[i] = el }} type="button" onClick={() => pick(i)}
              aria-current={i === active ? 'true' : undefined}
              className={`min-h-9 shrink-0 whitespace-nowrap rounded-full px-4 text-[15px] font-medium transition-colors ${
                i === active ? 'bg-brown-btn text-white' : 'bg-brown-track text-brown-dark'}`}>{n}</button>
          ))}
        </div>
        <div className="pointer-events-none absolute inset-y-0 right-0 w-20 bg-gradient-to-l from-cream via-cream to-transparent" />
        <button type="button" aria-label="All categories" aria-expanded={open} onClick={() => setOpen((o) => !o)}
          className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center text-brown-dark">
          <ChevronDown size={22} strokeWidth={2.25} className={open ? 'rotate-180' : ''} />
        </button>
      </div>
      <div className="h-px bg-border" />
      {open && (
        <>
          <div aria-hidden="true" onClick={() => setOpen(false)} className="fixed inset-0 z-10 bg-black/30" />
          <div role="dialog" aria-label="All categories"
            className="absolute inset-x-0 top-full z-20 max-h-[60vh] overflow-y-auto border-b border-border bg-card shadow-lg">
            <div className="flex items-center justify-between px-4 pb-1 pt-3">
              <span className="text-sm font-semibold text-brown-muted">All categories</span>
              <button type="button" aria-label="Close" onClick={() => setOpen(false)}
                className="flex h-9 w-9 items-center justify-center text-brown-muted"><X size={20} /></button>
            </div>
            <ul>
              {names.map((n, i) => (
                <li key={`${i}:${n}`}>
                  <button type="button" onClick={() => pick(i)}
                    className={`min-h-12 w-full border-t border-border px-4 text-left text-base ${i === active ? 'font-semibold text-brown-btn' : 'text-brown-dark'}`}>{n}</button>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </nav>
  )
})
export default CategoryBar
