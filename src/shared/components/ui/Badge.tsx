import type { ReactNode } from 'react'

export type BadgeTone = 'neutral' | 'brand' | 'success' | 'danger'

const TONES: Record<BadgeTone, string> = {
  neutral: 'text-brown-muted border-border-mid bg-cream',
  brand:   'text-accent-text border-accent/25 bg-accent/5',
  success: 'text-ok border-ok/25 bg-ok-bg',
  danger:  'text-bad border-bad/25 bg-bad-bg',
}

export function Badge({ tone = 'neutral', children, className = '' }: { tone?: BadgeTone; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${TONES[tone]} ${className}`.trim()}>
      {children}
    </span>
  )
}
