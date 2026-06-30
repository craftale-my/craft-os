import { useState } from 'react'

interface StarRatingProps {
  value: number
  onChange?: (v: number) => void
  readonly?: boolean
  size?: 'sm' | 'md' | 'lg'
}

export function StarRating({ value, onChange, readonly = false, size = 'md' }: StarRatingProps) {
  const [hovered, setHovered] = useState(0)

  const sizeClass = { sm: 'text-base gap-0.5', md: 'text-xl gap-1', lg: 'text-2xl gap-1.5' }[size]

  return (
    <div className={`flex items-center ${sizeClass}`}>
      {[1, 2, 3, 4, 5].map(n => {
        const filled = n <= (hovered || value)
        return (
          <button
            key={n}
            type="button"
            disabled={readonly}
            onClick={() => onChange?.(n)}
            onMouseEnter={() => { if (!readonly) setHovered(n) }}
            onMouseLeave={() => setHovered(0)}
            className={`leading-none transition-all ${
              readonly ? 'cursor-default' : 'cursor-pointer hover:scale-125'
            } ${filled ? 'text-[#C4813A]' : 'text-[#D4C5B0] hover:text-[#C4813A80]'}`}
          >
            ★
          </button>
        )
      })}
    </div>
  )
}
