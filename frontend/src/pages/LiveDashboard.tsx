import { useEffect, useState } from 'react'
import { signInWithCustomToken, setPersistence, browserSessionPersistence } from 'firebase/auth'
import { GameHeader, colors, typography, layout, spacing } from '@mygames/game-ui'
import { auth } from '../firebase'
import {
  getInstructorSession, getInstructorAuctionView, forceOut,
  type InstructorGroupAuction,
} from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// SAA Phase 2 — Slice 5 (rev): the SEPARATE "Live Dashboard" (/live), Spectrum-style.
// Reached from the main dashboard via a nav link that carries the query string. It
// is the auction management hub: per matched group, an eBay-style per-group "Open
// Auction" trigger (openAuction is already per-group); once open, the group shows
// its round state, standing table, per-bidder list (name · acted/deciding · winning),
// and a guarded Force Out. Sealed-bid privacy unchanged — the sanitized
// getInstructorAuctionView never carries a pending amount.
// ═══════════════════════════════════════════════════════════════════════════════

// Instructor-session bootstrap (mirrors the shared dashboard + Spectrum's
// useInstructorSession): reuse an existing session, else exchange the URL token.
function useInstructorAuth() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const params = new URLSearchParams(window.location.search)
      const devGid = import.meta.env.DEV ? params.get('_dev_game_instance_id') : null
      const tokenParam = params.get('token')
      try {
        await auth.authStateReady()
        const expected = devGid ? `instructor_${devGid}` : null
        if (auth.currentUser && (!expected || auth.currentUser.uid === expected)) { if (!cancelled) setReady(true); return }
        const args = devGid ? { _dev: { game_instance_id: devGid } } : tokenParam ? { token: tokenParam } : null
        if (!args) { if (!cancelled) setError('No launch token found.'); return }
        const res = await getInstructorSession(args)
        if (params.get('_session') === 'tab') await setPersistence(auth, browserSessionPersistence)
        await signInWithCustomToken(auth, res.customToken)
        if (!cancelled) setReady(true)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not authenticate.')
      }
    })()
    return () => { cancelled = true }
  }, [])
  return { ready, error }
}

type Confirming = { groupId: string; bidderIndex: number; name: string } | null

const th: React.CSSProperties = { textAlign: 'left', padding: '0.3rem 0.6rem', fontSize: typography.sizeSm, color: colors.textSecondary, borderBottom: `1px solid ${colors.border}` }
const td: React.CSSProperties = { padding: '0.3rem 0.6rem', fontSize: typography.sizeSm, borderBottom: `1px solid ${colors.borderFaint}` }

function AuctionCard({ n, a, onForceOut }: { n: number; a: InstructorGroupAuction; onForceOut: (bi: number, name: string) => void }) {
  return (
    <div data-testid={`saa-dash-group-${a.groupId}`} style={{ border: `1px solid ${colors.borderMid}`, borderRadius: 8, padding: '0.9rem 1.1rem', marginBottom: spacing.gapLg, background: colors.white }}>
      <div style={{ marginBottom: spacing.gapMd, fontSize: typography.sizeTable }}>
        <strong>Group {n}</strong>{' · '}
        <span data-testid="saa-dash-round">Round {a.round}</span>{' · '}
        <span data-testid="saa-dash-status" style={{ color: a.status === 'ended' ? colors.textSecondary : colors.successText, fontWeight: 600 }}>{a.status === 'ended' ? 'ended' : 'open'}</span>{' · '}
        Active bidders: <strong data-testid="saa-dash-active">{a.activeCount}</strong>
      </div>

      <table style={{ borderCollapse: 'collapse', marginBottom: spacing.gapMd, minWidth: 320 }}>
        <thead><tr><th style={th}>License</th><th style={th}>Standing Price</th><th style={th}>Current Winner</th></tr></thead>
        <tbody>
          {a.standing.map((s) => (
            <tr key={s.licenseId} data-testid={`saa-dash-standing-${s.licenseId}`}>
              <td style={td}><strong>{s.licenseId}</strong></td>
              <td style={td}>{s.standingPrice}</td>
              <td style={td}>{s.winnerName ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <table style={{ borderCollapse: 'collapse', minWidth: 460 }}>
        <thead><tr><th style={th}>Bidder</th><th style={th}>This round</th><th style={th}>Winning</th><th style={th}></th></tr></thead>
        <tbody>
          {a.bidders.map((b) => {
            const canForce = a.status === 'open' && b.active && !b.droppedOut && !b.isWinner
            // Once the auction has ENDED there is no "this round" — show each bidder's
            // terminal state (dropped out / license won / —), never a stale "still deciding".
            const roundCell = a.status === 'ended'
              ? (b.droppedOut ? 'dropped out' : b.isWinner ? `License ${b.winningLicense} won` : '—')
              : (b.droppedOut ? 'dropped out' : b.hasActed ? 'acted this round' : 'still deciding')
            return (
              <tr key={b.bidderIndex} data-testid={`saa-dash-bidder-${b.bidderIndex}`}>
                <td style={td}>{b.name} <span style={{ color: colors.textMuted }}>(B{b.bidderIndex})</span></td>
                <td style={td} data-testid={`saa-dash-acted-${b.bidderIndex}`}>{roundCell}</td>
                <td style={td}>{b.isWinner ? `License ${b.winningLicense}` : '—'}</td>
                <td style={td}>
                  {canForce && (
                    <button data-testid={`saa-dash-forceout-${b.bidderIndex}`}
                      style={{ padding: '0.3rem 0.7rem', borderRadius: 5, border: `1px solid ${colors.errorBorder}`, background: colors.errorBg, color: colors.errorText, cursor: 'pointer', fontSize: typography.sizeXs }}
                      onClick={() => onForceOut(b.bidderIndex, b.name)}>Force Out</button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {a.status === 'ended' && (
        <p data-testid={`saa-dash-terminal-${a.groupId}`} style={{ marginTop: spacing.gapMd, color: colors.textSecondary }}>
          Auction ended — {a.standing.filter((s) => s.winnerName).map((s) => `${s.licenseId}: ${s.winnerName} @${s.standingPrice}`).join(' · ')}
        </p>
      )}
    </div>
  )
}

export default function LiveDashboard() {
  const { ready, error } = useInstructorAuth()
  const [auctions, setAuctions] = useState<InstructorGroupAuction[]>([])
  const [confirming, setConfirming] = useState<Confirming>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  // Watch-only: /live shows STARTED auctions. Starting happens on the main dashboard.
  useEffect(() => {
    if (!ready) return
    let alive = true
    const tick = () =>
      getInstructorAuctionView().then((a) => { if (alive && a?.ok) setAuctions(a.groups) }).catch(() => { /* retry on interval */ })
    tick()
    const id = setInterval(tick, 2000)
    return () => { alive = false; clearInterval(id) }
  }, [ready])

  const doForceOut = () => {
    if (!confirming) return
    setBusy((b) => ({ ...b, force: true }))
    forceOut(confirming.groupId, confirming.bidderIndex).catch(() => {}).finally(() => { setBusy((b) => ({ ...b, force: false })); setConfirming(null) })
  }

  const shell = (body: React.ReactNode) => (
    <div style={{ fontFamily: typography.fontFamily, color: colors.text }}>
      <GameHeader />
      <main style={{ maxWidth: layout.maxWidth, margin: '0 auto', padding: `1.5rem ${layout.pagePad} 3rem` }}>{body}</main>
    </div>
  )

  if (error) return shell(<p style={{ color: colors.errorText }}>{error}</p>)
  if (!ready) return shell(<p>Loading…</p>)

  const sorted = [...auctions].sort((a, b) => a.groupId.localeCompare(b.groupId))

  return shell(
    <section data-testid="saa-live-dashboard">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: spacing.gapLg }}>
        <h2 style={{ margin: 0 }}>Live auctions</h2>
        <a data-testid="saa-back-to-dashboard" href={`/dashboard${window.location.search}`} style={{ color: '#D38626', fontWeight: 600, fontSize: typography.sizeSm }}>← Back to dashboard</a>
      </div>

      {sorted.length === 0 && <p style={{ color: colors.textSecondary }}>No auctions started yet — start one from the dashboard.</p>}

      {sorted.map((a, i) => (
        <AuctionCard key={a.groupId} n={i + 1} a={a} onForceOut={(bi, name) => setConfirming({ groupId: a.groupId, bidderIndex: bi, name })} />
      ))}

      {confirming && (
        <div data-testid="saa-dash-forceout-confirm" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div style={{ background: colors.white, borderRadius: 8, padding: '1.5rem', maxWidth: 420 }}>
            <p style={{ marginTop: 0 }}>Force out <strong>{confirming.name}</strong>? This removes them from the auction permanently and counts toward ending it.</p>
            <div style={{ display: 'flex', gap: spacing.gapBtn }}>
              <button data-testid="saa-dash-forceout-yes" disabled={busy.force} onClick={doForceOut}
                style={{ padding: '0.55rem 1.1rem', borderRadius: 6, border: 'none', background: colors.errorAction, color: colors.white, cursor: 'pointer' }}>Force Out</button>
              <button data-testid="saa-dash-forceout-no" onClick={() => setConfirming(null)}
                style={{ padding: '0.55rem 1.1rem', borderRadius: 6, border: `1px solid ${colors.borderLight}`, background: colors.white, cursor: 'pointer' }}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </section>,
  )
}
