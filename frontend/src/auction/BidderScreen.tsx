import { useEffect, useMemo, useState } from 'react'
import { GameHeader, colors, typography, layout, spacing } from '@mygames/game-ui'
import type { BidderView, LicenseId, ActionResult } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// SAA Phase 2 — Slice 4: the bidder screen (§12). A thin view over getBidderView:
// status block + the 5-license table + Submit/Drop Out, with one-bid-per-round
// enforcement, winner pre-fill/hold/raise, drop-out blocked for a winner, a
// waiting state, watch mode after drop-out, and the terminal result. The server is
// authoritative for legality — the UI does only light one-bid UX enforcement and
// surfaces the server's rejection reason inline.
// ═══════════════════════════════════════════════════════════════════════════════

type HeaderLink = { label: string; url: string | null }

interface Props {
  view: BidderView
  onSubmitBid: (licenseId: LicenseId, amount: number) => Promise<ActionResult>
  onHold: () => Promise<ActionResult>
  onDropOut: () => Promise<ActionResult>
  onRefresh: () => void
  headerLinks: HeaderLink[]
}

const bidderLabel = (idx: number | null, you: number) =>
  idx === null ? '—' : idx === you ? 'You' : `Bidder ${idx}`

export default function BidderScreen({ view, onSubmitBid, onHold, onDropOut, onRefresh, headerLinks }: Props) {
  const ended = view.status === 'ended'
  const winning = view.winningLicense
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [confirmingDrop, setConfirmingDrop] = useState(false)

  // On each new round / view, reset the bid boxes: pre-fill the winner's own row with
  // their standing bid (ready to hold or raise), and clear everything for a non-winner.
  // Resetting per round keeps the one-license rule — enforced at Submit by counting how
  // many boxes carry an amount — from being tripped by a stale value left in another box.
  useEffect(() => {
    setAmounts(winning ? { [winning]: String(view.currentBidOnWinningLicense ?? '') } : {})
    setError(null)
    setConfirmingDrop(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.round, view.status, winning])

  const canAct = view.active && !view.droppedOut && !view.hasActedThisRound && !ended
  const rowByLicense = useMemo(
    () => Object.fromEntries(view.licenses.map((l) => [l.licenseId, l])),
    [view.licenses],
  )

  async function run(fn: () => Promise<ActionResult>) {
    setSubmitting(true)
    setError(null)
    try {
      const r = await fn()
      if (!r.ok) setError(r.reason ?? 'That action was rejected.')
      else onRefresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed — try again.')
    } finally {
      setSubmitting(false)
    }
  }

  function onSubmit() {
    if (!canAct) return
    // The one-license-per-round rule is enforced HERE, at Submit — never by disabling
    // inputs. Count the boxes that carry an amount: exactly one must.
    const filled = view.licenses.filter((l) => (amounts[l.licenseId] ?? '').trim() !== '')
    if (filled.length === 0) { setError('Enter a bid amount on the one license you want.'); return }
    if (filled.length > 1) { setError('You may bid on only one license per round — clear the amounts on the others.'); return }
    const license = filled[0].licenseId
    const amount = Number((amounts[license] ?? '').trim())
    if (!Number.isFinite(amount)) { setError('Enter a valid bid amount.'); return }
    // Winner: submitting their unchanged standing bid is a HOLD; a higher value is a raise.
    if (winning && license === winning && amount === view.currentBidOnWinningLicense) {
      void run(onHold); return
    }
    void run(() => onSubmitBid(license, amount))
  }

  // ── styles ──────────────────────────────────────────────────────────────────
  const th: React.CSSProperties = { textAlign: 'left', padding: spacing.cellPadHead, borderBottom: `2px solid ${colors.border}`, fontSize: typography.sizeTable, color: colors.textSecondary }
  const td: React.CSSProperties = { padding: spacing.cellPadData, borderBottom: `1px solid ${colors.borderFaint}`, fontSize: typography.sizeTable }
  const input: React.CSSProperties = { width: 90, padding: '0.3rem 0.4rem', border: `1px solid ${colors.borderLight}`, borderRadius: 4, fontSize: typography.sizeTable }
  // Equal-sized buttons: fixed width + height so Submit and Drop Out match side by side.
  const btn = (bg: string, on: boolean): React.CSSProperties => ({ width: 150, height: 44, padding: '0 1rem', textAlign: 'center', borderRadius: 6, border: 'none', background: on ? bg : colors.borderLight, color: colors.white, fontSize: typography.sizeTable, cursor: on ? 'pointer' : 'not-allowed' })

  const statusText = view.isWinner ? `You are winning License ${winning}` : 'You are not winning any licenses'

  return (
    <div style={{ fontFamily: typography.fontFamily, color: colors.text }}>
      <GameHeader studentLinks={headerLinks} />
      <main style={{ maxWidth: layout.contentWidth, margin: '0 auto', padding: layout.pagePad }}>
        {/* ── status block ── */}
        <section data-testid="saa-status" style={{ marginBottom: spacing.gapXl }}>
          <h2 style={{ margin: 0 }}>Simultaneous Ascending Auction</h2>
          <p style={{ margin: '0.4rem 0', color: colors.textSecondary }}>
            You are <strong data-testid="saa-bidder">Bidder {view.bidderIndex}</strong>
            {!ended && <> · <span data-testid="saa-round">Round {view.round}</span></>}
            {' · '}Active bidders: <strong data-testid="saa-active">{view.activeCount}</strong>
          </p>
          <p style={{ margin: '0.4rem 0' }} data-testid="saa-winning">{ended ? 'The auction has ended.' : statusText}</p>
          <p style={{ margin: '0.4rem 0', color: colors.textSecondary }}>
            Provisional profit: <strong data-testid="saa-profit">{view.provisionalProfit}</strong>
          </p>
        </section>

        {/* ── the 5-license table ── */}
        <table data-testid="saa-license-table" style={{ width: '100%', borderCollapse: 'collapse', marginBottom: spacing.gapLg }}>
          <thead>
            <tr>
              <th style={th}>License</th>
              <th style={th}>Your Value</th>
              <th style={th}>Current High Bid</th>
              <th style={th}>Min Increment</th>
              <th style={th}>Current Winner</th>
              <th style={th}>Bid</th>
            </tr>
          </thead>
          <tbody>
            {view.licenses.map((row) => {
              // Every bid input stays freely editable while the caller can act — the
              // one-license rule is checked only at Submit, never by disabling inputs.
              const showHint = canAct && row.minLegalBidForYou !== null
              return (
                <tr key={row.licenseId} data-testid={`saa-row-${row.licenseId}`}>
                  <td style={td}><strong>{row.licenseId}</strong></td>
                  <td style={td} data-testid={`saa-value-${row.licenseId}`}>{row.yourValue}</td>
                  <td style={td} data-testid={`saa-high-${row.licenseId}`}>{row.currentHighBid}</td>
                  <td style={td} data-testid={`saa-inc-${row.licenseId}`}>{row.minIncrement}</td>
                  <td style={td} data-testid={`saa-winner-${row.licenseId}`}>{bidderLabel(row.currentWinnerIndex, view.bidderIndex)}</td>
                  <td style={td}>
                    {canAct ? (
                      <div>
                        <input
                          type="number"
                          inputMode="numeric"
                          data-testid={`saa-bid-input-${row.licenseId}`}
                          style={input}
                          placeholder={row.minLegalBidForYou !== null ? String(row.minLegalBidForYou) : ''}
                          value={amounts[row.licenseId] ?? ''}
                          onChange={(e) => setAmounts((a) => ({ ...a, [row.licenseId]: e.target.value }))}
                        />
                        {showHint && (
                          <div style={{ fontSize: typography.sizeXs, color: colors.textMuted }}>
                            {winning && row.licenseId === winning ? `Hold at ${view.currentBidOnWinningLicense}, or raise` : `Enter ${row.minLegalBidForYou} or more`}
                          </div>
                        )}
                      </div>
                    ) : (
                      <span style={{ color: colors.textFaint }}>—</span>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>

        {/* ── inline server rejection reason ── */}
        {error && (
          <div data-testid="saa-error" style={{ background: colors.errorBg, border: `1px solid ${colors.errorBorder}`, color: colors.errorText, padding: spacing.gapMd, borderRadius: 6, marginBottom: spacing.gapLg }}>
            {error}
          </div>
        )}

        {/* ── controls / state ── */}
        {ended ? (
          <section data-testid="saa-terminal" style={{ background: colors.surfaceSubtle, padding: layout.pagePad, borderRadius: 8 }}>
            <h3 style={{ marginTop: 0 }}>Final result</h3>
            {view.yourTerminalLicense ? (
              <p data-testid="saa-terminal-you">You won <strong>License {view.yourTerminalLicense}</strong> at {rowByLicense[view.yourTerminalLicense].currentHighBid} — profit <strong>{view.yourTerminalProfit}</strong>.</p>
            ) : (
              <p data-testid="saa-terminal-you">You did not win a license.</p>
            )}
          </section>
        ) : view.droppedOut ? (
          <section data-testid="saa-watch" style={{ color: colors.textSecondary }}>
            You have dropped out — watching the auction to its close. You have no further actions.
          </section>
        ) : view.hasActedThisRound ? (
          <section data-testid="saa-waiting" style={{ color: colors.textSecondary }}>
            You have acted this round. Waiting for the other bidders — {view.actedCount} of {view.activeCount} have acted. The round closes when everyone has acted.
          </section>
        ) : confirmingDrop ? (
          <section data-testid="saa-dropout-confirm" style={{ background: colors.errorBg, border: `1px solid ${colors.errorBorder}`, padding: layout.pagePad, borderRadius: 8 }}>
            <p style={{ marginTop: 0, color: colors.errorText }}>
              Are you sure? Dropping out is permanent — you cannot rejoin the auction.
            </p>
            <div style={{ display: 'flex', gap: spacing.gapBtn }}>
              <button data-testid="saa-dropout-confirm-yes" style={btn(colors.errorAction, !submitting)} disabled={submitting} onClick={() => { setConfirmingDrop(false); void run(onDropOut) }}>
                Confirm
              </button>
              <button data-testid="saa-dropout-confirm-no" style={btn(colors.roleNone, true)} onClick={() => setConfirmingDrop(false)}>
                Cancel
              </button>
            </div>
          </section>
        ) : (
          <section style={{ display: 'flex', alignItems: 'center', gap: spacing.gapBtn }}>
            <button data-testid="saa-submit" style={btn(colors.roleA, canAct && !submitting)} disabled={!canAct || submitting} onClick={onSubmit}>
              Submit
            </button>
            {view.isWinner ? (
              <button data-testid="saa-dropout" style={btn(colors.roleNone, false)} disabled>Drop Out</button>
            ) : (
              <button data-testid="saa-dropout" style={btn(colors.errorAction, canAct && !submitting)} disabled={!canAct || submitting} onClick={() => setConfirmingDrop(true)}>
                Drop Out
              </button>
            )}
          </section>
        )}
      </main>
    </div>
  )
}
