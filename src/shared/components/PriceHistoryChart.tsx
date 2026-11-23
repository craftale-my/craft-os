import type { ItemPriceHistory } from '../types'

/**
 * Purchase-price trend for one item. Hand-rolled SVG to match ScoreChart —
 * the app has no charting library and this doesn't warrant introducing one.
 */
export function PriceHistoryChart({ history, unit }: { history: ItemPriceHistory[]; unit: string }) {
  const data = [...history]
    .sort((a, b) => new Date(a.recorded_at).getTime() - new Date(b.recorded_at).getTime())
    .slice(-8)
    .map(h => ({
      price: h.price,
      label: new Date(h.recorded_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }),
    }))

  if (data.length < 2) {
    return (
      <p className="text-xs text-brown-faint text-center py-6">
        Needs at least 2 recorded prices to show a trend.
      </p>
    )
  }

  const W = 320, H = 140
  const pad = { top: 28, right: 16, bottom: 32, left: 40 }
  const cW = W - pad.left - pad.right
  const cH = H - pad.top - pad.bottom

  const prices = data.map(d => d.price)
  const rawMin = Math.min(...prices)
  const rawMax = Math.max(...prices)
  // Pad the range so a flat line sits mid-chart instead of hugging an edge.
  const span = rawMax - rawMin
  const min = span === 0 ? rawMin * 0.9 : rawMin - span * 0.2
  const max = span === 0 ? rawMax * 1.1 || 1 : rawMax + span * 0.2

  const xStep = cW / (data.length - 1)
  const x = (i: number) => pad.left + i * xStep
  const y = (p: number) => pad.top + cH - ((p - min) / (max - min)) * cH

  const linePath = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(d.price).toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L ${x(data.length - 1).toFixed(1)} ${(H - pad.bottom).toFixed(1)} L ${x(0).toFixed(1)} ${(H - pad.bottom).toFixed(1)} Z`

  const first = data[0].price
  const last = data[data.length - 1].price
  const trendUp = last > first
  const trendColor = last === first ? '#8B7355' : trendUp ? '#9E4A30' : '#3D7A50'

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full overflow-visible" style={{ minHeight: 120 }}>
        {/* Min / max gridlines */}
        {[rawMin, rawMax].map((p, idx) => (
          <g key={idx}>
            <line
              x1={pad.left} y1={y(p)} x2={W - pad.right} y2={y(p)}
              stroke="#EDE5D8" strokeWidth="1" strokeDasharray="4,4"
            />
            <text x={pad.left - 4} y={y(p) + 3.5} textAnchor="end" fontSize="8" fill="#C4B49A">
              {p.toFixed(2)}
            </text>
          </g>
        ))}

        <path d={areaPath} fill={`${trendColor}12`} />
        <path d={linePath} fill="none" stroke={trendColor} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />

        {data.map((d, i) => (
          <g key={i}>
            <circle cx={x(i)} cy={y(d.price)} r="4" fill={trendColor} />
            {/* Label only the ends when crowded, so the numbers stay readable. */}
            {(data.length <= 5 || i === 0 || i === data.length - 1) && (
              <text x={x(i)} y={y(d.price) - 9} textAnchor="middle" fontSize="9" fill="#3D2B1F" fontWeight="700">
                {d.price.toFixed(2)}
              </text>
            )}
            <text x={x(i)} y={H - 8} textAnchor="middle" fontSize="8" fill="#8B7355">
              {d.label}
            </text>
          </g>
        ))}
      </svg>

      <p className="text-xs text-center mt-1" style={{ color: trendColor }}>
        {last === first
          ? `No change · RM ${last.toFixed(2)} / ${unit}`
          : `${trendUp ? '↑' : '↓'} ${Math.abs(((last - first) / first) * 100).toFixed(1)}% over ${data.length} deliveries · now RM ${last.toFixed(2)} / ${unit}`}
      </p>
    </div>
  )
}
