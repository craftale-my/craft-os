import type { ReactNode } from 'react'

export type SegmentedTab<T extends string> = { id: T; label: ReactNode; dot?: boolean }

// The white tab strip with a dark-brown active pill used on the profile page.
// Scrolls sideways on narrow phones, with the scrollbar hidden.
export function SegmentedTabs<T extends string>({ tabs, value, onChange, label }: {
  tabs: SegmentedTab<T>[]
  value: T
  onChange: (id: T) => void
  label: string
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      className="flex gap-1 bg-white shadow-card rounded-xl p-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {tabs.map(t => {
        const active = t.id === value
        return (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={`relative flex-1 py-2 px-3 text-sm rounded-lg whitespace-nowrap transition-colors ${
              active ? 'bg-brown-header text-[#F5F0E8] font-medium' : 'text-brown-muted hover:text-brown-dark hover:bg-cream'
            }`}
          >
            {t.label}
            {t.dot && !active && (
              <span aria-hidden="true" className="absolute top-1 right-1 w-2 h-2 rounded-full bg-accent" />
            )}
          </button>
        )
      })}
    </div>
  )
}
