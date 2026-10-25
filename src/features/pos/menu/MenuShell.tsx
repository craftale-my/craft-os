// src/features/pos/menu/MenuShell.tsx
import type { ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { MENU_TABS, menuTab } from './menuView'

// A strip above the page that scrolls sideways; from 900 px a column on the left.
const NAV_CLS = [
  'flex gap-1 overflow-x-auto border-b border-border bg-card px-4 py-2',
  'min-[900px]:sticky min-[900px]:top-0 min-[900px]:min-h-screen min-[900px]:w-44 min-[900px]:shrink-0 min-[900px]:flex-col',
  'min-[900px]:overflow-visible min-[900px]:border-b-0 min-[900px]:border-r min-[900px]:px-2 min-[900px]:py-6',
].join(' ')

/** The frame of every /menu page (Feedme's back-office layout): the sub-menu with the current page
 *  highlighted, and the page beside it. Below 900 px the sub-menu becomes a strip above the page. */
export default function MenuShell({ children }: { children: ReactNode }) {
  const tab = menuTab(useLocation().pathname)
  return (
    <div className="min-[900px]:flex min-[900px]:items-start">
      <nav aria-label="Menu pages" className={NAV_CLS}>
        {MENU_TABS.map((t) => (
          <Link key={t.id} to={t.to} aria-current={tab === t.id ? 'page' : undefined}
            className={`shrink-0 whitespace-nowrap rounded px-3 py-2 text-sm ${tab === t.id ? 'bg-brown-btn text-white' : 'hover:bg-cream'}`}>
            {t.label}
          </Link>
        ))}
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}
