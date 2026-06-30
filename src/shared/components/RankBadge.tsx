import { Rank, RANK_LABELS, RANK_COLORS } from '../types'

interface Props {
  rank: Rank
  size?: 'sm' | 'md' | 'lg'
}

const sizes = {
  sm: 'text-xs px-2.5 py-0.5',
  md: 'text-sm px-3 py-1',
  lg: 'text-base px-3.5 py-1.5',
}

export function RankBadge({ rank, size = 'md' }: Props) {
  const color = RANK_COLORS[rank]
  return (
    <span
      className={`inline-block rounded-full font-semibold tracking-wide ${sizes[size]}`}
      style={{ color, border: `1px solid ${color}40`, background: `${color}18` }}
    >
      {RANK_LABELS[rank]}
    </span>
  )
}
