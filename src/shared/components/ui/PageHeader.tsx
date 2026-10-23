import type { ReactNode } from 'react'

// One page-title treatment for every screen (there were ten before).
export function PageHeader({ eyebrow, title, subtitle, actions }: {
  eyebrow?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="flex items-end justify-between gap-4 flex-wrap mb-6">
      <div className="min-w-0">
        {eyebrow && <p className="type-eyebrow text-[11px] text-brown-brand mb-2">{eyebrow}</p>}
        <h1 className="type-wordmark text-[28px] text-brown-dark break-words">{title}</h1>
        {subtitle && <p className="type-condensed text-[15px] text-brown-muted mt-1.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2 flex-shrink-0">{actions}</div>}
    </div>
  )
}
