// src/features/pos/menu/MenuTabs.tsx
import { Link, useLocation } from 'react-router-dom'
import { MENU_TABS, menuTab } from './menuView'

/** The /menu sub-navigation: Products, Catalogs, Add-on groups, Categories, and the import. */
export default function MenuTabs() {
  const tab = menuTab(useLocation().pathname)
  return (
    <nav className="flex flex-wrap items-center gap-1 border-b border-border pb-2">
      {MENU_TABS.map((t) => (
        <Link key={t.id} to={t.to} aria-current={tab === t.id ? 'page' : undefined}
          className={`rounded px-3 py-1.5 text-sm ${tab === t.id ? 'bg-brown-btn text-white' : 'hover:bg-cream'}`}>
          {t.label}
        </Link>
      ))}
      <Link to="/menu/import" aria-current={tab === 'import' ? 'page' : undefined}
        className={`ml-auto rounded px-3 py-1.5 text-sm ${tab === 'import' ? 'bg-brown-btn text-white' : 'underline'}`}>
        Import from Feedme
      </Link>
    </nav>
  )
}
