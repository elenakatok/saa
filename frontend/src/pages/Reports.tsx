import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { httpsCallable } from 'firebase/functions'
import { signInWithCustomToken, signOut } from 'firebase/auth'
import { auth, functions } from '../firebase'
import { GameHeader } from '@mygames/game-ui'
import { saaConfig, type OutcomeSchema } from '../gameConfig'
import { getAuctionReport, type ReportRow, type ReportQuestionMeta, type AuctionReport } from '../api'
import LineChartSVG, { type ChartSeries } from '../components/LineChartSVG'

// ── Role label (single role — `bidder`) ───────────────────────────────────────

const ROLE_LABELS: Record<string, string> = Object.fromEntries(
  saaConfig.roles.map(r => [r.key, r.label]),
)

function fmtNum(n: number | null): string {
  return n == null ? '—' : n.toLocaleString('en-US')
}

// ── Page component ────────────────────────────────────────────────────────────

export default function Reports() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const devGameInstanceId = import.meta.env.DEV
    ? searchParams.get('_dev_game_instance_id')
    : null
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

  // ── Auth bootstrap ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const establish = async () => {
      await auth.authStateReady()
      if (cancelled) return
      if (auth.currentUser) {
        const expectedUid = devGameInstanceId
          ? `instructor_${devGameInstanceId}`
          : gameInstanceIdParam ? `instructor_${gameInstanceIdParam}` : null
        if (expectedUid && auth.currentUser.uid === expectedUid) { setSessionReady(true); return }
        await signOut(auth)
        if (cancelled) return
      }
      const args = devGameInstanceId
        ? { _dev: { game_instance_id: devGameInstanceId } }
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

  // ── Data load ──────────────────────────────────────────────────────────────
  const [rows,      setRows]      = useState<ReportRow[] | null>(null)
  const [questions, setQuestions] = useState<ReportQuestionMeta[]>([])
  const [, setSchema]             = useState<OutcomeSchema | null>(null)
  const [auction,   setAuction]   = useState<AuctionReport | null>(null)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  useEffect(() => {
    if (!sessionReady) return
    setLoading(true)
    setError(null)
    const fn = httpsCallable<object, { ok: boolean; rows: ReportRow[]; questions: ReportQuestionMeta[]; schema: OutcomeSchema }>(functions, 'getReportData')
    Promise.all([fn({}), getAuctionReport().catch(() => null)]).then(([r, a]) => {
      setRows(r.data.rows)
      setQuestions(r.data.questions)
      setSchema(r.data.schema)
      if (a) setAuction(a)
      setLoading(false)
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to load report data.')
      setLoading(false)
    })
  }, [sessionReady])

  const textFields  = questions.map(q => q.field)

  // Chart series (one line per group) — each group plotted to its own last round.
  const revenueChart: ChartSeries[] = (auction?.groups ?? []).map(g => ({
    label: `Group ${g.groupNumber}`,
    points: g.revenueSeries.map(p => ({ x: p.round, y: p.revenue })),
  }))
  const profitChart: ChartSeries[] = (auction?.groups ?? []).map(g => ({
    label: `Group ${g.groupNumber}`,
    points: g.profitSeries.map(p => ({ x: p.round, y: p.profit })),
  }))
  const hasCharts = revenueChart.some(s => s.points.length > 0)

  // ── Render ─────────────────────────────────────────────────────────────────
  if (authError) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <p style={{ color: '#c00' }}>{authError}</p>
      </div>
    )
  }

  const thStyle: React.CSSProperties = {
    textAlign: 'left', padding: '0.4rem 0.6rem', borderBottom: '2px solid #ddd',
    fontSize: '0.8rem', fontWeight: 600, whiteSpace: 'nowrap', background: '#faf7f2',
  }
  const tdStyle: React.CSSProperties = {
    padding: '0.35rem 0.6rem', borderBottom: '1px solid #eee', fontSize: '0.85rem',
  }
  const numTd: React.CSSProperties = { ...tdStyle, fontVariantNumeric: 'tabular-nums' }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <GameHeader />

      <div style={{ padding: '1rem 1.5rem 0.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <button
          onClick={() => navigate(makeLink('/dashboard'))}
          style={{ background: 'none', border: '1px solid #ccc', borderRadius: 4, padding: '0.3rem 0.8rem', cursor: 'pointer', fontSize: '0.85rem' }}
        >
          ← Dashboard
        </button>
        <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Reports — SAA</h2>
      </div>

      <main style={{ flex: 1, padding: '1rem 1.5rem' }}>
        {error && <p style={{ color: '#c00', marginBottom: '1rem' }}>{error}</p>}

        <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: '#666' }}>
          Grading is <strong>participation-only</strong> (raw scores are uniform across present
          bidders by design; a bidder who dropped out still played and earns the point). Profit is a{' '}
          <strong>game outcome, never a grade</strong>.
        </p>

        {hasCharts && (
          <>
            <section style={{ marginBottom: '1.5rem' }}>
              <h3 style={{ margin: '0 0 0.35rem', fontSize: '1rem' }}>Revenue over rounds</h3>
              <p style={{ margin: '0 0 0.4rem', fontSize: '0.8rem', color: '#888' }}>Total of the five licenses’ standing prices each round (what the seller collects) — one line per group.</p>
              <LineChartSVG testId="saa-report-revenue" series={revenueChart} xLabel="Round" yLabel="Revenue" yFormat={(n) => '$' + n.toLocaleString('en-US')} />
            </section>
            <section style={{ marginBottom: '1.5rem' }}>
              <h3 style={{ margin: '0 0 0.35rem', fontSize: '1rem' }}>Profit over rounds</h3>
              <p style={{ margin: '0 0 0.4rem', fontSize: '0.8rem', color: '#888' }}>Sum of each provisional winner’s (value − standing price) each round — one line per group.</p>
              <LineChartSVG testId="saa-report-profit" series={profitChart} xLabel="Round" yLabel="Profit" yFormat={(n) => '$' + n.toLocaleString('en-US')} />
            </section>
            <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>Per-bidder report</h3>
          </>
        )}

        {rows == null ? (
          <p style={{ color: '#888', fontSize: '0.9rem' }}>{loading ? 'Loading…' : 'No data.'}</p>
        ) : rows.length === 0 ? (
          <p style={{ color: '#888', fontSize: '0.9rem' }}>No finalized participants yet.</p>
        ) : (
          <div style={{ overflowX: 'auto', border: '1px solid #ddd', borderRadius: 6 }}>
            <table data-testid="saa-report-table" style={{ borderCollapse: 'collapse', width: '100%', minWidth: 640 }}>
              <thead>
                <tr>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Group #</th>
                  <th style={thStyle}>Role</th>
                  <th style={{ ...thStyle, background: '#eef6ee' }}>Participation</th>
                  <th style={{ ...thStyle, background: '#eef6ee' }}>KC score</th>
                  <th style={{ ...thStyle, background: '#fdf4e7' }}>Profit (outcome)</th>
                  <th style={thStyle}>Rounds bid</th>
                  <th style={thStyle}>Dropped @ round</th>
                  {textFields.map(field => {
                    const q = questions.find(qq => qq.field === field)
                    return <th key={field} style={thStyle}>{q?.prompt ?? field}</th>
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.participant_id} data-testid={`saa-report-row-${r.participant_id}`}>
                    <td style={tdStyle}>{r.display_name}</td>
                    <td style={numTd}>{r.group_number ?? '—'}</td>
                    <td style={tdStyle}>{ROLE_LABELS[r.role] ?? r.role}</td>
                    <td style={{ ...numTd, background: '#f6fbf6' }}>{fmtNum(r.raw_score)}</td>
                    <td style={{ ...numTd, background: '#f6fbf6' }}>{fmtNum(r.knowledge_check_score)}</td>
                    <td style={{ ...numTd, background: '#fdfaf3' }} data-testid={`saa-report-profit-${r.participant_id}`}>
                      {r.total_profit == null ? '—' : '$' + r.total_profit.toLocaleString('en-US')}
                    </td>
                    <td style={numTd}>{fmtNum(r.rounds_bid)}</td>
                    <td style={numTd}>{r.dropped_out_at_round ?? '—'}</td>
                    {textFields.map(field => (
                      <td key={field} style={tdStyle}>
                        {r.text_answers[field]
                          ? <span style={{ whiteSpace: 'pre-wrap', display: 'inline-block', maxWidth: 260, overflowWrap: 'anywhere' }}>{r.text_answers[field]}</span>
                          : '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p style={{ margin: '0.5rem 0.6rem', fontSize: '0.75rem', color: '#888' }}>
              Green = grade inputs (participation + KC). Amber = game outcome (profit) — displayed, never graded.
            </p>
          </div>
        )}
      </main>
    </div>
  )
}
