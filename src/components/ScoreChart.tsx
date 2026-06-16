import type { MonthlyReview } from '../types'
import { calcFinalScore, getScoreConfig, MONTHS } from '../types'

export function ScoreChart({ reviews }: { reviews: MonthlyReview[] }) {
  const data = [...reviews]
    .sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month)
    .slice(-6)
    .map(r => ({ score: calcFinalScore(r) ?? 0, label: `${MONTHS[r.month - 1]} ${String(r.year).slice(2)}` }))

  if (data.length < 2) {
    return (
      <p className="text-xs text-brown-faint text-center py-6">
        Complete at least 2 reviews to see the score trend.
      </p>
    )
  }

  const W = 320, H = 130
  const pad = { top: 28, right: 16, bottom: 32, left: 28 }
  const cW = W - pad.left - pad.right
  const cH = H - pad.top - pad.bottom

  const xStep = cW / (data.length - 1)
  const x = (i: number) => pad.left + i * xStep
  const y = (score: number) => pad.top + cH - (score / 100) * cH

  const linePath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(d.score).toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L ${x(data.length - 1).toFixed(1)} ${(H - pad.bottom).toFixed(1)} L ${x(0).toFixed(1)} ${(H - pad.bottom).toFixed(1)} Z`

  const gridScores = [60, 75, 90]

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full overflow-visible" style={{ minHeight: 110 }}>
      {/* Grid */}
      {gridScores.map(s => (
        <g key={s}>
          <line
            x1={pad.left} y1={y(s)} x2={W - pad.right} y2={y(s)}
            stroke="#EDE5D8" strokeWidth="1"
            strokeDasharray={s === 60 ? '4,4' : undefined}
          />
          <text x={pad.left - 4} y={y(s) + 3.5} textAnchor="end" fontSize="8" fill="#C4B49A">
            {s}
          </text>
        </g>
      ))}

      {/* Area fill */}
      <path d={areaPath} fill="#8B634412" />

      {/* Line */}
      <path d={linePath} fill="none" stroke="#8B6344" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />

      {/* Points + labels */}
      {data.map((d, i) => {
        const cfg = getScoreConfig(d.score)
        return (
          <g key={i}>
            <circle cx={x(i)} cy={y(d.score)} r="5" fill={cfg.color} />
            <text x={x(i)} y={y(d.score) - 9} textAnchor="middle" fontSize="9" fill="#3D2B1F" fontWeight="700">
              {d.score}
            </text>
            <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="9" fill="#8B7355">
              {d.label}
            </text>
          </g>
        )
      })}
    </svg>
  )
}
