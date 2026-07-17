// ═══════════════════════════════════════════════════════════════════════════════
// SAA Slice 6 — a hand-rolled multi-line SVG chart (house style, no chart library;
// mirrors eBay's PriceOverTimeSVG / Baxter's SurplusScatterSVG). One colored line
// per series (group), integer round X-axis, legend. Used for both the revenue and
// profit "over rounds" reports.
// ═══════════════════════════════════════════════════════════════════════════════

const COLORS = ['#1a73e8', '#137333', '#c5221f', '#8a6d00', '#8430ce', '#0b8043', '#d93025', '#e8710a']
const W = 900, H = 480
const PAD = { top: 24, right: 24, bottom: 52, left: 78 }
const PLOT_W = W - PAD.left - PAD.right
const PLOT_H = H - PAD.top - PAD.bottom

function niceMax(v: number): number {
  if (v <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(v)))
  const n = v / mag
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return step * mag
}
function ticks(max: number, count = 5): number[] {
  const out: number[] = []
  for (let i = 0; i <= count; i++) out.push(Math.round((max / count) * i))
  return out
}

export interface ChartSeries {
  label: string
  points: { x: number; y: number }[]
}

interface Props {
  series: ChartSeries[]
  xLabel: string
  yLabel: string
  yFormat?: (n: number) => string
  testId?: string
}

export default function LineChartSVG({ series, xLabel, yLabel, yFormat = (n) => String(n), testId }: Props) {
  const withData = series.filter((s) => s.points.length > 0)
  const allY = withData.flatMap((s) => s.points.map((p) => p.y))
  const allX = withData.flatMap((s) => s.points.map((p) => p.x))
  const maxX = Math.max(1, ...allX)
  const maxY = niceMax(Math.max(1, ...allY))
  const minY = Math.min(0, ...allY)

  const xOf = (x: number) => PAD.left + (maxX <= 1 ? 0.5 : (x - 1) / (maxX - 1)) * PLOT_W
  const yOf = (y: number) => PAD.top + PLOT_H - ((y - minY) / (maxY - minY || 1)) * PLOT_H

  const yTicks = ticks(maxY).map((t) => t + minY)
  const xTicks = Array.from({ length: maxX }, (_, i) => i + 1)

  return (
    <svg data-testid={testId} viewBox={`0 0 ${W} ${H}`} width="100%" style={{ maxWidth: W, fontFamily: 'system-ui, sans-serif', background: '#fff' }} role="img" aria-label={`${yLabel} over ${xLabel}`}>
      {/* Y gridlines + labels */}
      {yTicks.map((v) => (
        <g key={`y${v}`}>
          <line x1={PAD.left} y1={yOf(v)} x2={W - PAD.right} y2={yOf(v)} stroke="#eee" strokeWidth={1} />
          <text x={PAD.left - 8} y={yOf(v) + 4} textAnchor="end" fontSize={12} fill="#666">{yFormat(v)}</text>
        </g>
      ))}
      {/* X ticks + labels */}
      {xTicks.map((t) => (
        <text key={`x${t}`} x={xOf(t)} y={PAD.top + PLOT_H + 20} textAnchor="middle" fontSize={12} fill="#666">{t}</text>
      ))}
      {/* Axes */}
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + PLOT_H} stroke="#999" strokeWidth={1} />
      <line x1={PAD.left} y1={PAD.top + PLOT_H} x2={W - PAD.right} y2={PAD.top + PLOT_H} stroke="#999" strokeWidth={1} />
      <text x={PAD.left + PLOT_W / 2} y={H - 12} textAnchor="middle" fontSize={13} fill="#333">{xLabel}</text>
      <text transform={`rotate(-90, 18, ${PAD.top + PLOT_H / 2})`} x={18} y={PAD.top + PLOT_H / 2} textAnchor="middle" fontSize={13} fill="#333">{yLabel}</text>

      {/* One line + dots per series */}
      {withData.map((s, i) => {
        const color = COLORS[i % COLORS.length]
        const d = s.points.map((p, j) => `${j === 0 ? 'M' : 'L'} ${xOf(p.x)} ${yOf(p.y)}`).join(' ')
        return (
          <g key={s.label}>
            <path d={d} fill="none" stroke={color} strokeWidth={2.5} />
            {s.points.map((p, j) => <circle key={j} cx={xOf(p.x)} cy={yOf(p.y)} r={3.5} fill={color} />)}
          </g>
        )
      })}

      {/* Legend */}
      {withData.map((s, i) => (
        <g key={`lg${s.label}`} transform={`translate(${W - PAD.right - 130}, ${PAD.top + 6 + i * 18})`}>
          <rect width={12} height={12} fill={COLORS[i % COLORS.length]} rx={2} />
          <text x={18} y={11} fontSize={12} fill="#333">{s.label}</text>
        </g>
      ))}
    </svg>
  )
}
