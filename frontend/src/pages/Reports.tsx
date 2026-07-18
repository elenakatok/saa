import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { httpsCallable } from 'firebase/functions'
import { signInWithCustomToken, signOut } from 'firebase/auth'
import { auth, functions } from '../firebase'
import { GameHeader } from '@mygames/game-ui'
import { getAuctionReport, type AuctionReport, type LicenseId } from '../api'
import LineChartSVG, { type ChartSeries } from '../components/LineChartSVG'

const LICENSES: readonly LicenseId[] = ['A', 'B', 'C', 'D', 'E']
const money = (n: number) => '$' + Math.round(n).toLocaleString('en-US')

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

  // ── Auth bootstrap ─────────────────────────────────────────────────────────
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

  // ── Data load ──────────────────────────────────────────────────────────────
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

  const revenueChart: ChartSeries[] = (auction?.groups ?? []).map(g => ({ label: `Group ${g.groupNumber}`, points: g.revenueSeries.map(p => ({ x: p.round, y: p.revenue })) }))
  const profitChart: ChartSeries[]  = (auction?.groups ?? []).map(g => ({ label: `Group ${g.groupNumber}`, points: g.profitSeries.map(p => ({ x: p.round, y: p.profit })) }))
  const hasCharts = revenueChart.some(s => s.points.length > 0)

  // ── Render ─────────────────────────────────────────────────────────────────
  if (authError) return <div style={{ padding: '2rem', textAlign: 'center' }}><p style={{ color: '#c00' }}>{authError}</p></div>

  const thStyle: React.CSSProperties = { textAlign: 'left', padding: '0.4rem 0.7rem', borderBottom: '2px solid #ddd', fontSize: '0.8rem', fontWeight: 600, whiteSpace: 'nowrap', background: '#faf7f2' }
  const tdStyle: React.CSSProperties = { padding: '0.4rem 0.7rem', borderBottom: '1px solid #eee', fontSize: '0.85rem' }
  const numTd: React.CSSProperties = { ...tdStyle, fontVariantNumeric: 'tabular-nums' }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <GameHeader />
      <div style={{ padding: '1rem 1.5rem 0.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <button onClick={() => navigate(makeLink('/dashboard'))} style={{ background: 'none', border: '1px solid #ccc', borderRadius: 4, padding: '0.3rem 0.8rem', cursor: 'pointer', fontSize: '0.85rem' }}>← Dashboard</button>
        <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Reports — SAA</h2>
      </div>

      <main style={{ flex: 1, padding: '1rem 1.5rem' }}>
        {error && <p style={{ color: '#c00', marginBottom: '1rem' }}>{error}</p>}
        <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: '#666' }}>
          Grading is <strong>participation-only</strong>; profit/efficiency below are <strong>game outcomes, never grades</strong>.
        </p>

        {hasCharts && (
          <>
            <section style={{ marginBottom: '1.5rem' }}>
              <h3 style={{ margin: '0 0 0.35rem', fontSize: '1rem' }}>Revenue over rounds</h3>
              <p style={{ margin: '0 0 0.4rem', fontSize: '0.8rem', color: '#888' }}>Total of the five licenses’ standing prices each round (what the seller collects) — one line per group.</p>
              <LineChartSVG testId="saa-report-revenue" series={revenueChart} xLabel="Round" yLabel="Revenue" yFormat={money} />
            </section>
            <section style={{ marginBottom: '1.5rem' }}>
              <h3 style={{ margin: '0 0 0.35rem', fontSize: '1rem' }}>Profit over rounds</h3>
              <p style={{ margin: '0 0 0.4rem', fontSize: '0.8rem', color: '#888' }}>Sum of each provisional winner’s (value − standing price) each round — one line per group.</p>
              <LineChartSVG testId="saa-report-profit" series={profitChart} xLabel="Round" yLabel="Profit" yFormat={money} />
            </section>
          </>
        )}

        {auction == null ? (
          <p style={{ color: '#888', fontSize: '0.9rem' }}>{loading ? 'Loading…' : 'No data.'}</p>
        ) : auction.groups.length === 0 ? (
          <p style={{ color: '#888', fontSize: '0.9rem' }}>No auctions have run yet.</p>
        ) : (
          <section>
            <h3 style={{ margin: '0 0 0.5rem', fontSize: '1rem' }}>Statistics</h3>
            <div style={{ overflowX: 'auto', border: '1px solid #ddd', borderRadius: 6, maxWidth: 720 }}>
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
          </section>
        )}
      </main>
    </div>
  )
}
