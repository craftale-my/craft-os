import { XP_PER_LEVEL } from '../types'

interface Props {
  xp: number
  level: number
  showLabels?: boolean
}

export function XPBar({ xp, level, showLabels = true }: Props) {
  const xpInLevel = xp % XP_PER_LEVEL
  const percent = (xpInLevel / XP_PER_LEVEL) * 100

  return (
    <div className="w-full">
      {showLabels && (
        <div className="flex justify-between text-xs text-brown-muted mb-1.5">
          <span>Level {level}</span>
          <span>{xpInLevel} / {XP_PER_LEVEL} XP</span>
        </div>
      )}
      <div className="h-2 rounded-full bg-brown-track overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${percent}%`, background: 'linear-gradient(90deg, #8B6344, #C4813A)' }}
        />
      </div>
    </div>
  )
}
