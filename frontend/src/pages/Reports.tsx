import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { httpsCallable } from 'firebase/functions'
import { signInWithCustomToken, signOut } from 'firebase/auth'
import { auth, functions } from '../firebase'
import {
  GameHeader,
  ReportBoard,
  ExportModal,
  buildStudentTextExport,
  type ReportTileConfig,
  type AiTextRow,
} from '@mygames/game-ui'
import { getAuctionReport, type AuctionReport, type LicenseId } from '../api'
import LineChartSVG, { type ChartSeries } from '../components/LineChartSVG'

const LICENSES: readonly LicenseId[] = ['A', 'B', 'C', 'D', 'E']
const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US')

// ── Modal shell (local, matches the eBay/Spectrum reports pattern) ──────────────────
function Modal({ title, onClose, wide, children }: { title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '3rem 1rem', zIndex: 1000, overflowY: 'auto' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,0.25)', width: '100%', maxWidth: wide ? 'min(1200px, calc(100vw - 2rem))' : 'min(1000px, calc(100vw - 2rem))', minWidth: 0, boxSizing: 'border-box', maxHeight: 'calc(100vh - 6rem)', overflowY: 'auto', padding: '1.25rem 1.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600 }}>{title}</h3>
          <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: '1.25rem', cursor: 'pointer', color: '#666' }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ── Statistics table (unchanged content; now rendered inside its modal) ──────────────
const thStyle: React.CSSProperties = { textAlign: 'left', padding: '0.4rem 0.7rem', borderBottom: '2px solid #ddd', fontSize: '0.8rem', fontWeight: 600, whiteSpace: 'nowrap', background: '#faf7f2' }
const tdStyle: React.CSSProperties = { padding: '0.4rem 0.7rem', borderBottom: '1px solid #eee', fontSize: '0.85rem' }
const numTd: React.CSSProperties = { ...tdStyle, fontVariantNumeric: 'tabular-nums' }

function StatisticsTable({ auction }: { auction: AuctionReport }) {
  return (
    <>
      <div style={{ overflowX: 'auto', border: '1px solid #ddd', borderRadius: 6 }}>
        <table data-testid="saa-stats-table" style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              <th style={thStyle}>Group</th>
              <th style={thStyle}>Revenue</th>
              <th style={thStyle}>Profit</th>
              <th style={thStyle}>Total surplus</th>
              <th style={thStyle}>Efficiency (%)</th>
              {LICENSES.map(l => <th key={l} style={{ ...thStyle, textAlign: 'center' }}>{l}</th>)}
            </tr>
          </thead>
          <tbody>
            {auction.groups.map(g => (
              <tr key={g.groupId} data-testid={`saa-stats-row-${g.groupNumber}`}>
                <td style={numTd}>{g.groupNumber}</td>
                <td style={numTd} data-testid={`saa-stats-revenue-${g.groupNumber}`}>{money(g.finalRevenue)}</td>
                <td style={numTd} data-testid={`saa-stats-profit-${g.groupNumber}`}>{money(g.finalProfit)}</td>
                <td style={numTd} data-testid={`saa-stats-total-${g.groupNumber}`}>{money(g.totalSurplus)}</td>
                <td style={numTd} data-testid={`saa-stats-eff-${g.groupNumber}`}>{g.efficiency.toFixed(2)}</td>
                {LICENSES.map(l => (
                  <td key={l} style={{ ...numTd, textAlign: 'center' }} data-testid={`saa-stats-${l}-${g.groupNumber}`}>
                    {g.winnersByLicense[l] ?? '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p style={{ margin: '0.5rem 0.2rem', fontSize: '0.75rem', color: '#888' }}>
        Efficiency = Total surplus ÷ efficient max ({auction.efficientMax.toLocaleString('en-US')}) × 100 — set on the Settings screen.
        Columns A–E show the winning <strong>bidder number</strong> for each license.
      </p>
    </>
  )
}

// Largest round tick at or just under the efficient-max benchmark, so the revenue axis
// tops out near the total-possible-surplus ceiling instead of overshooting far above the
// data (e.g. 3119 → 3000). Undefined for tiny/absent values → the chart auto-scales.
function revenueAxisMaxFor(efficientMax: number): number | undefined {
  if (!(efficientMax > 0)) return undefined
  const v = Math.floor(efficientMax / 500) * 500
  return v > 0 ? v : undefined
}

// ── Page ────────────────────────────────────────────────────────────────────────────
type ReportKind = 'revenue' | 'profit' | 'stats'

export default function Reports() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const devGameInstanceId = import.meta.env.DEV ? searchParams.get('_dev_game_instance_id') : null
  const tokenParam          = searchParams.get('token')
  const gameInstanceIdParam = searchParams.get('game_instance_id')

  const [sessionReady, setSessionReady] = useState(false)
  const [authError,    setAuthError]    = useState<string | null>(null)

  const makeLink = (base: string): string => {
    if (devGameInstanceId) return `${base}?_dev_game_instance_id=${encodeURIComponent(devGameInstanceId)}`
    if (tokenParam && gameInstanceIdParam)
      return `${base}?token=${encodeURIComponent(tokenParam)}&game_instance_id=${encodeURIComponent(gameInstanceIdParam)}`
    return base
  }

  // ── Auth bootstrap ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const establish = async () => {
      await auth.authStateReady()
      if (cancelled) return
      if (auth.currentUser) {
        const expectedUid = devGameInstanceId ? `instructor_${devGameInstanceId}`
          : gameInstanceIdParam ? `instructor_${gameInstanceIdParam}` : null
        if (expectedUid && auth.currentUser.uid === expectedUid) { setSessionReady(true); return }
        await signOut(auth)
        if (cancelled) return
      }
      const args = devGameInstanceId ? { _dev: { game_instance_id: devGameInstanceId } }
        : tokenParam ? { token: tokenParam } : null
      if (!args) { setAuthError('No launch token found.'); return }
      try {
        const fn = httpsCallable<object, { customToken: string }>(functions, 'getInstructorSession')
        const res = await fn(args)
        if (cancelled) return
        await signInWithCustomToken(auth, res.data.customToken)
        if (cancelled) return
        setSessionReady(true)
      } catch (err) {
        if (cancelled) return
        setAuthError(err instanceof Error ? err.message : 'Failed to establish session.')
      }
    }
    void establish()
    return () => { cancelled = true }
  }, [devGameInstanceId, tokenParam]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Data load ──────────────────────────────────────────────────────────────────
  const [auction, setAuction] = useState<AuctionReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState<string | null>(null)

  useEffect(() => {
    if (!sessionReady) return
    setLoading(true)
    setError(null)
    getAuctionReport().then((a) => { setAuction(a); setLoading(false) })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Failed to load report data.'); setLoading(false) })
  }, [sessionReady])

  const [active, setActive] = useState<ReportKind | null>(null)
  const [activeExport, setActiveExport] = useState<{ title: string; text: string } | null>(null)

  const revenueChart: ChartSeries[] = (auction?.groups ?? []).map(g => ({ label: `Group ${g.groupNumber}`, points: g.revenueSeries.map(p => ({ x: p.round, y: p.revenue })) }))
  const profitChart: ChartSeries[]  = (auction?.groups ?? []).map(g => ({ label: `Group ${g.groupNumber}`, points: g.profitSeries.map(p => ({ x: p.round, y: p.profit })) }))
  const hasCharts = revenueChart.some(s => s.points.length > 0)
  const hasGroups = (auction?.groups.length ?? 0) > 0
  const revenueAxisMax = revenueAxisMaxFor(auction?.efficientMax ?? 0)

  const tiles: ReportTileConfig[] = [
    {
      id: 'revenue', title: 'Revenue over rounds',
      preview: hasCharts
        ? <span data-testid="saa-tile-revenue" style={{ fontSize: '0.9rem', color: '#555' }}>{revenueChart.length} group{revenueChart.length !== 1 ? 's' : ''} · seller revenue by round</span>
        : <span data-testid="saa-tile-revenue" style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No auction data yet.</span>,
      onOpen: () => setActive('revenue'), disabled: !hasCharts, actionLabel: 'Open ↗',
    },
    {
      id: 'profit', title: 'Profit over rounds',
      preview: hasCharts
        ? <span data-testid="saa-tile-profit" style={{ fontSize: '0.9rem', color: '#555' }}>{profitChart.length} group{profitChart.length !== 1 ? 's' : ''} · winner surplus by round</span>
        : <span data-testid="saa-tile-profit" style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No auction data yet.</span>,
      onOpen: () => setActive('profit'), disabled: !hasCharts, actionLabel: 'Open ↗',
    },
    {
      id: 'stats', title: 'Statistics',
      preview: hasGroups
        ? <span data-testid="saa-tile-stats" style={{ fontSize: '0.9rem', color: '#555' }}>{auction!.groups.length} group{auction!.groups.length !== 1 ? 's' : ''} · revenue, profit, efficiency</span>
        : <span data-testid="saa-tile-stats" style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No auctions have run yet.</span>,
      onOpen: () => setActive('stats'), disabled: !hasGroups, actionLabel: 'Open ↗',
    },
    // Text prep-question export tiles — the same mechanism eBay uses (one tile per text
    // question, opening the shared ExportModal). SAA defines no text prep questions today,
    // so `questions` is empty and this contributes nothing; it lights up automatically if
    // getAuctionReport ever carries text questions + per-bidder answers.
    ...(auction?.questions ?? []).map((q) => {
      const tileTitle = q.prompt
      const qRows: AiTextRow[] = (auction?.bidders ?? [])
        .filter((b) => b.textAnswers?.[q.field])
        .map((b) => ({ name: b.name, raw_score: null, answer: b.textAnswers![q.field] }))
      const text = buildStudentTextExport(tileTitle, qRows)
      return {
        id: q.field, title: tileTitle,
        preview: qRows.length === 0
          ? <span style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No responses yet.</span>
          : <span style={{ fontSize: '1.25rem', fontWeight: 700, color: '#111' }}>{qRows.length} response{qRows.length !== 1 ? 's' : ''}</span>,
        onOpen: () => setActiveExport({ title: tileTitle, text }), disabled: qRows.length === 0, actionLabel: 'Open ↗',
      } satisfies ReportTileConfig
    }),
  ]

  // ── Render ─────────────────────────────────────────────────────────────────────
  if (authError) return <div style={{ padding: '2rem', textAlign: 'center' }}><p style={{ color: '#c00' }}>{authError}</p></div>

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <GameHeader />
      <div style={{ padding: '1rem 1.5rem 0.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <button onClick={() => navigate(makeLink('/dashboard'))} style={{ background: 'none', border: '1px solid #ccc', borderRadius: 4, padding: '0.3rem 0.8rem', cursor: 'pointer', fontSize: '0.85rem' }}>← Dashboard</button>
        <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Reports — SAA</h2>
      </div>

      <main style={{ flex: 1, padding: '1rem 1.5rem' }}>
        {error && <p style={{ color: '#c00', marginBottom: '1rem' }}>{error}</p>}
        {loading && !auction && <p style={{ color: '#888' }}>Loading…</p>}
        <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: '#666' }}>
          Grading is <strong>participation-only</strong>; profit/efficiency below are <strong>game outcomes, never grades</strong>.
        </p>
        <ReportBoard tiles={tiles} />
      </main>

      {active === 'revenue' && auction && (
        <Modal title="Revenue over rounds" wide onClose={() => setActive(null)}>
          <p style={{ margin: '0 0 0.6rem', fontSize: '0.85rem', color: '#666' }}>
            Total of the five licenses’ standing prices each round (what the seller collects) — one line per group.
          </p>
          <LineChartSVG testId="saa-report-revenue" series={revenueChart} xLabel="Round" yLabel="Revenue" yFormat={money} axisMax={revenueAxisMax} />
        </Modal>
      )}

      {active === 'profit' && auction && (
        <Modal title="Profit over rounds" wide onClose={() => setActive(null)}>
          <p style={{ margin: '0 0 0.6rem', fontSize: '0.85rem', color: '#666' }}>
            Sum of each provisional winner’s (value − standing price) each round — one line per group.
          </p>
          <LineChartSVG testId="saa-report-profit" series={profitChart} xLabel="Round" yLabel="Profit" yFormat={money} />
        </Modal>
      )}

      {active === 'stats' && auction && (
        <Modal title="Statistics" wide onClose={() => setActive(null)}>
          <StatisticsTable auction={auction} />
        </Modal>
      )}

      {activeExport && <ExportModal title={activeExport.title} text={activeExport.text} onClose={() => setActiveExport(null)} />}
    </div>
  )
}
