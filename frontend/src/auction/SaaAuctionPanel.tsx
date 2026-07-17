import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { colors, typography, spacing } from '@mygames/game-ui'
import { getInstructorAuctionView, forceOut, type InstructorGroupAuction } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// SAA Phase 2 — Slice 5: the LEAN instructor auction panel. Portals into the shared
// dashboard's <main> (eBay pattern), so it sits inside the instructor shell without
// a shared-package change. It polls the SANITIZED getInstructorAuctionView — round
// state, per-license standing (resolved), and a per-bidder list of REAL names +
// acted-status + winner-flag. It NEVER shows a pending bid amount (sealed-bid), and
// offers a guarded Force Out per non-winner. No bid history, no charts — lean.
// ═══════════════════════════════════════════════════════════════════════════════

type Confirming = { groupId: string; bidderIndex: number; name: string } | null

export default function SaaAuctionPanel() {
  const [groups, setGroups] = useState<InstructorGroupAuction[]>([])
  const [host, setHost] = useState<HTMLElement | null>(null)
  const [confirming, setConfirming] = useState<Confirming>(null)
  const [busy, setBusy] = useState(false)

  // Host node as the first child of the shared dashboard's <main>.
  useEffect(() => {
    const main = document.querySelector('main')
    if (!main) return
    const node = document.createElement('div')
    node.setAttribute('data-saa-auction-host', '')
    main.insertBefore(node, main.firstChild)
    setHost(node)
    return () => { node.remove(); setHost(null) }
  }, [])

  // Poll the sanitized instructor view (retry on error until the session is ready;
  // stop once every auction has ended).
  useEffect(() => {
    let alive = true
    const tick = () =>
      getInstructorAuctionView()
        .then((r) => { if (alive) setGroups(r.groups) })
        .catch(() => { /* session not ready / no auctions yet — retry on the interval */ })
    tick()
    const id = setInterval(() => {
      if (groups.length > 0 && groups.every((g) => g.status === 'ended')) { clearInterval(id); return }
      tick()
    }, 2000)
    return () => { alive = false; clearInterval(id) }
  }, [groups])

  const doForceOut = () => {
    if (!confirming) return
    setBusy(true)
    forceOut(confirming.groupId, confirming.bidderIndex)
      .catch(() => { /* backend is authoritative; the poll will reflect the truth */ })
      .finally(() => { setBusy(false); setConfirming(null) })
  }

  if (!host || groups.length === 0) return null

  const card: React.CSSProperties = { border: `1px solid ${colors.borderMid}`, borderRadius: 8, padding: '0.9rem 1.1rem', marginBottom: spacing.gapLg, background: colors.white }
  const th: React.CSSProperties = { textAlign: 'left', padding: '0.3rem 0.6rem', fontSize: typography.sizeSm, color: colors.textSecondary, borderBottom: `1px solid ${colors.border}` }
  const td: React.CSSProperties = { padding: '0.3rem 0.6rem', fontSize: typography.sizeSm, borderBottom: `1px solid ${colors.borderFaint}` }

  return createPortal(
    <section data-testid="saa-dashboard" style={{ margin: '0 0 1.5rem', fontFamily: typography.fontFamily }}>
      <h3 style={{ margin: '0 0 0.75rem' }}>Live auctions</h3>

      {groups.map((g, i) => (
        <div key={g.groupId} data-testid={`saa-dash-group-${g.groupId}`} style={card}>
          <div style={{ marginBottom: spacing.gapMd, fontSize: typography.sizeTable }}>
            <strong>Group {i + 1}</strong>{' · '}
            <span data-testid="saa-dash-round">Round {g.round}</span>{' · '}
            <span data-testid="saa-dash-status" style={{ color: g.status === 'ended' ? colors.textSecondary : colors.successText, fontWeight: 600 }}>{g.status === 'ended' ? 'ended' : 'open'}</span>{' · '}
            Active bidders: <strong data-testid="saa-dash-active">{g.activeCount}</strong>
          </div>

          {/* standing state per license (resolved — safe to show) */}
          <table style={{ borderCollapse: 'collapse', marginBottom: spacing.gapMd, minWidth: 320 }}>
            <thead><tr><th style={th}>License</th><th style={th}>Standing Price</th><th style={th}>Current Winner</th></tr></thead>
            <tbody>
              {g.standing.map((s) => (
                <tr key={s.licenseId} data-testid={`saa-dash-standing-${s.licenseId}`}>
                  <td style={td}><strong>{s.licenseId}</strong></td>
                  <td style={td}>{s.standingPrice}</td>
                  <td style={td}>{s.winnerName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* per-bidder list — names + acted-status (NEVER the pending amount) + force-out */}
          <table style={{ borderCollapse: 'collapse', minWidth: 460 }}>
            <thead><tr><th style={th}>Bidder</th><th style={th}>This round</th><th style={th}>Winning</th><th style={th}></th></tr></thead>
            <tbody>
              {g.bidders.map((b) => {
                const canForce = g.status === 'open' && b.active && !b.droppedOut && !b.isWinner
                return (
                  <tr key={b.bidderIndex} data-testid={`saa-dash-bidder-${b.bidderIndex}`}>
                    <td style={td}>{b.name} <span style={{ color: colors.textMuted }}>(B{b.bidderIndex})</span></td>
                    <td style={td} data-testid={`saa-dash-acted-${b.bidderIndex}`}>
                      {b.droppedOut ? 'dropped out' : b.hasActed ? 'acted this round' : 'still deciding'}
                    </td>
                    <td style={td}>{b.isWinner ? `License ${b.winningLicense}` : '—'}</td>
                    <td style={td}>
                      {canForce && (
                        <button data-testid={`saa-dash-forceout-${b.bidderIndex}`}
                          style={{ padding: '0.3rem 0.7rem', borderRadius: 5, border: `1px solid ${colors.errorBorder}`, background: colors.errorBg, color: colors.errorText, cursor: 'pointer', fontSize: typography.sizeXs }}
                          onClick={() => setConfirming({ groupId: g.groupId, bidderIndex: b.bidderIndex, name: b.name })}>
                          Force Out
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>

          {g.status === 'ended' && (
            <p data-testid={`saa-dash-terminal-${g.groupId}`} style={{ marginTop: spacing.gapMd, color: colors.textSecondary }}>
              Auction ended — {g.standing.filter((s) => s.winnerName).map((s) => `${s.licenseId}: ${s.winnerName} @${s.standingPrice}`).join(' · ')}
            </p>
          )}
        </div>
      ))}

      {confirming && (
        <div data-testid="saa-dash-forceout-confirm" style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}>
          <div style={{ background: colors.white, borderRadius: 8, padding: '1.5rem', maxWidth: 420 }}>
            <p style={{ marginTop: 0 }}>
              Force out <strong>{confirming.name}</strong>? This removes them from the auction permanently and counts toward ending it.
            </p>
            <div style={{ display: 'flex', gap: spacing.gapBtn }}>
              <button data-testid="saa-dash-forceout-yes" disabled={busy} onClick={doForceOut}
                style={{ padding: '0.55rem 1.1rem', borderRadius: 6, border: 'none', background: colors.errorAction, color: colors.white, cursor: 'pointer' }}>
                Force Out
              </button>
              <button data-testid="saa-dash-forceout-no" onClick={() => setConfirming(null)}
                style={{ padding: '0.55rem 1.1rem', borderRadius: 6, border: `1px solid ${colors.borderLight}`, background: colors.white, cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </section>,
    host,
  )
}
