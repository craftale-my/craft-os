interface Props {
  rating: number
  max?: number
  color?: string
}

export function SkillDots({ rating, max = 5, color = '#8B6344' }: Props) {
  return (
    <div className="flex gap-1.5">
      {Array.from({ length: max }).map((_, i) => (
        <div
          key={i}
          className="w-2.5 h-2.5 rounded-full transition-colors"
          style={{ background: i < rating ? color : '#E0D5C5' }}
        />
      ))}
    </div>
  )
}
