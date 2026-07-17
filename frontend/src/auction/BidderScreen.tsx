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
  // A winner is locked to raising/holding their own license; a non-winner may pick any one.
  const [selected, setSelected] = useState<LicenseId | null>(winning)
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // On each new round / view, pre-fill the winner's own row with their standing bid
  // and lock selection to it; a non-winner starts with no selection.
  useEffect(() => {
    if (winning) {
      setSelected(winning)
      setAmounts((a) => ({ ...a, [winning]: String(view.currentBidOnWinningLicense ?? '') }))
    } else {
      setSelected(null)
    }
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.round, view.status, winning])

  const canAct = view.active && !view.droppedOut && !view.hasActedThisRound && !ended
  const rowByLicense = useMemo(
    () => Object.fromEntries(view.licenses.map((l) => [l.licenseId, l])),
    [view.licenses],
  )

  function pick(l: LicenseId) {
    if (!canAct || winning) return // winner can't switch licenses
    setSelected(l)
    setError(null)
  }

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
    if (selected === null) { setError('Select one license to bid on.'); return }
    const raw = amounts[selected]
    const amount = Number(raw)
    if (raw === undefined || raw === '' || !Number.isFinite(amount)) {
      setError('Enter a bid amount.'); return
    }
    // Winner: submitting their unchanged standing bid is a HOLD; a higher value is a raise.
    if (winning && selected === winning && amount === view.currentBidOnWinningLicense) {
      void run(onHold); return
    }
    void run(() => onSubmitBid(selected, amount))
  }

  // ── styles ──────────────────────────────────────────────────────────────────
  const th: React.CSSProperties = { textAlign: 'left', padding: spacing.cellPadHead, borderBottom: `2px solid ${colors.border}`, fontSize: typography.sizeTable, color: colors.textSecondary }
  const td: React.CSSProperties = { padding: spacing.cellPadData, borderBottom: `1px solid ${colors.borderFaint}`, fontSize: typography.sizeTable }
  const input: React.CSSProperties = { width: 90, padding: '0.3rem 0.4rem', border: `1px solid ${colors.borderLight}`, borderRadius: 4, fontSize: typography.sizeTable }
  const btn = (bg: string, on: boolean): React.CSSProperties => ({ padding: '0.55rem 1.1rem', borderRadius: 6, border: 'none', background: on ? bg : colors.borderLight, color: colors.white, fontSize: typography.sizeTable, cursor: on ? 'pointer' : 'not-allowed' })

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
              const isSel = selected === row.licenseId
              // A row is bid-able only if the caller may bid on it this round.
              const allowed = canAct && row.minLegalBidForYou !== null
              const inputDisabled = !allowed || (winning ? row.licenseId !== winning : selected !== null && !isSel)
              return (
                <tr key={row.licenseId} data-testid={`saa-row-${row.licenseId}`}>
                  <td style={td}><strong>{row.licenseId}</strong></td>
                  <td style={td} data-testid={`saa-value-${row.licenseId}`}>{row.yourValue}</td>
                  <td style={td} data-testid={`saa-high-${row.licenseId}`}>{row.currentHighBid}</td>
                  <td style={td}>{row.minIncrement}</td>
                  <td style={td} data-testid={`saa-winner-${row.licenseId}`}>{bidderLabel(row.currentWinnerIndex, view.bidderIndex)}</td>
                  <td style={td}>
                    {canAct ? (
                      <div>
                        <input
                          type="number"
                          inputMode="numeric"
                          data-testid={`saa-bid-input-${row.licenseId}`}
                          style={{ ...input, opacity: inputDisabled ? 0.4 : 1 }}
                          disabled={inputDisabled}
                          placeholder={row.minLegalBidForYou !== null ? String(row.minLegalBidForYou) : ''}
                          value={amounts[row.licenseId] ?? ''}
                          onFocus={() => pick(row.licenseId)}
                          onChange={(e) => { pick(row.licenseId); setAmounts((a) => ({ ...a, [row.licenseId]: e.target.value })) }}
                        />
                        {allowed && row.minLegalBidForYou !== null && (
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
        ) : (
          <section style={{ display: 'flex', alignItems: 'center', gap: spacing.gapBtn }}>
            <button data-testid="saa-submit" style={btn(colors.roleA, canAct && selected !== null && !submitting)} disabled={!canAct || selected === null || submitting} onClick={onSubmit}>
              {winning ? 'Submit (hold or raise)' : 'Submit bid'}
            </button>
            {view.isWinner ? (
              <span data-testid="saa-dropout-blocked" style={{ color: colors.textMuted, fontSize: typography.sizeSm }}>
                <button data-testid="saa-dropout" style={btn(colors.roleNone, false)} disabled>Drop Out</button>
                {' '}You cannot drop out — your winning bid is binding.
              </span>
            ) : (
              <button data-testid="saa-dropout" style={btn(colors.errorAction, canAct && !submitting)} disabled={!canAct || submitting} onClick={() => void run(onDropOut)}>
                I'm Done (Drop Out)
              </button>
            )}
          </section>
        )}
      </main>
    </div>
  )
}
