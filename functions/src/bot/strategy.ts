// ═══════════════════════════════════════════════════════════════════════════════
// SAA server-side bot STRATEGY — deploy-boundary MIRROR of games/saa/bot/strategy.ts.
//
// This is the SAME dominant-strategy `decide()` the Slice-1 browser driver uses,
// duplicated here for ONE reason only: Firebase deploys the functions/ directory in
// isolation, so a Cloud Function cannot import a file two levels up in games/saa/bot/.
// The logic is IDENTICAL and MUST stay identical — strategy.test.ts (next to this file)
// runs the same fixtures through BOTH this copy and the canonical bot/strategy.ts and
// fails on any divergence. Edit the canonical file; mirror the change here; the test
// keeps them honest. Do NOT fork the logic.
//
// SAA §7.1 dominant strategy (see the canonical file for the full commentary):
//   round 1 → reserve on most-valued license · hold while winning · else min-legal
//   bid on the highest-surplus license (surplus at the price you'd pay) · drop at
//   zero-or-negative surplus · lowest-license-index tie-break.
// ═══════════════════════════════════════════════════════════════════════════════

export type LicenseId = 'A' | 'B' | 'C' | 'D' | 'E'

export interface BidderLicenseRow {
  licenseId: LicenseId
  yourValue: number
  currentHighBid: number
  currentWinnerIndex: number | null
  youAreWinner: boolean
  minIncrement: number
  minLegalBidForYou: number | null
}

export interface BidderView {
  status: 'open' | 'ended'
  round: number
  bidderIndex: number
  active: boolean
  droppedOut: boolean
  hasActedThisRound: boolean
  isWinner: boolean
  winningLicense: LicenseId | null
  currentBidOnWinningLicense: number | null
  licenses: BidderLicenseRow[]
}

export type Decision =
  | { action: 'bid'; license: LicenseId; amount: number }
  | { action: 'hold' }
  | { action: 'drop' }
  | null

export function decide(view: BidderView): Decision {
  // Not our move → nothing to do.
  if (view.status === 'ended') return null
  if (view.droppedOut || !view.active) return null
  if (view.hasActedThisRound) return null

  // Winning a license → hold (never raise our own standing bid).
  if (view.isWinner) return { action: 'hold' }

  // Not winning → minimum-legal bid on the highest-surplus license. Surplus is
  // evaluated at the price we'd actually pay: minLegalBidForYou (first-price +
  // minimum-legal-bids-only). Consider only licenses we're allowed to bid.
  let best: { license: LicenseId; amount: number; surplus: number } | null = null
  for (const row of view.licenses) {
    if (row.minLegalBidForYou === null) continue
    const priceYoudPay = row.minLegalBidForYou
    const surplus = row.yourValue - priceYoudPay
    if (
      best === null ||
      surplus > best.surplus ||
      (surplus === best.surplus && row.licenseId < best.license)
    ) {
      best = { license: row.licenseId, amount: priceYoudPay, surplus }
    }
  }

  if (best === null || best.surplus <= 0) return { action: 'drop' }

  return { action: 'bid', license: best.license, amount: best.amount }
}
