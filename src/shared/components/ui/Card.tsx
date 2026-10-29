import type { HTMLAttributes } from 'react'

type Tone = 'white' | 'tint'
const TONES: Record<Tone, string> = {
  white: 'bg-white shadow-card',
  tint:  'bg-[#FEF3E2] border border-accent/25',
}

type CardProps = HTMLAttributes<HTMLDivElement> & {
  tone?: Tone
  padded?: boolean
}

export function Card({ tone = 'white', padded = true, className = '', ...rest }: CardProps) {
  return <div className={`rounded-2xl ${TONES[tone]} ${padded ? 'p-5' : ''} ${className}`.trim()} {...rest} />
}
