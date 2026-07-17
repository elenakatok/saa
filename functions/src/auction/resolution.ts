// ═══════════════════════════════════════════════════════════════════════════════
// SAA Phase 2 — Slice 1: the PURE per-round resolution core.
//
// Given the prior standing state + this round's sealed bids, resolve all FIVE
// licenses INDEPENDENTLY (§1.4, §2) and produce the new standing state. First-price
// (§2): a license's winner pays their OWN bid. Binding carry-over (§2): a prior
// provisional winner keeps their license/price into the next round unless strictly
// out-bid.
//
// PURE: no Firestore/RTDB/I/O. Reads/writes and the round loop are later slices.
// Resolution is delegated to the already-extracted shared resolver
// (@mygames/game-engine/auction) under SAA's pinned first-price settings, so the
// winner-pays-own-bid invariant is exactly the one the Phase-1 test proved.
// ═══════════════════════════════════════════════════════════════════════════════

import { resolveAuction, type AuctionBid } from '@mygames/game-engine/auction'
import { SAA_AUCTION_SETTINGS } from './settings'
import { LICENSE_IDS, SAA_RESERVE, valueFor, type LicenseId } from './valueMatrix'

/** A single sealed bid placed by a bidder on ONE license in a round. */
export interface SaaBid {
  bidderIndex: number // 1..7
  licenseId: LicenseId
  amount: number
  atMs: number // server-receipt time; tie-break only
}

/** A license's standing: its current price and provisional winner (null = none). */
export interface LicenseStanding {
  standingPrice: number
  winnerBidderIndex: number | null
}

/** The full five-license standing state. */
export type StandingState = Record<LicenseId, LicenseStanding>

// The incumbent's binding bid carries a sentinel timestamp strictly earlier than
// any real/round bid (server timestamps are ≥ 0), so a NEW bid that merely TIES the
// standing price loses the tie-break to the incumbent — carry-over is binding and
// is only displaced by a strictly higher bid (§2).
const CARRYOVER_TS = Number.MIN_SAFE_INTEGER

/** Round-1 prior state (§1.2, §2): every license at reserve 200, no winners. */
export function initialStanding(): StandingState {
  const s = {} as StandingState
  for (const license of LICENSE_IDS) {
    s[license] = { standingPrice: SAA_RESERVE, winnerBidderIndex: null }
  }
  return s
}

/**
 * Resolve one round. For each license independently: combine this round's bids
 * with the incumbent's binding carry-over bid, take the highest (first-price →
 * winner pays own bid; ties → earliest, which the incumbent always wins), and
 * emit the new standing. A license with no bids ever sits at reserve, no winner.
 */
export function resolveRound(prior: StandingState, roundBids: SaaBid[]): StandingState {
  const next = {} as StandingState

  for (const license of LICENSE_IDS) {
    const priorStanding = prior[license]

    const candidates: AuctionBid[] = roundBids
      .filter((b) => b.licenseId === license)
      .map((b) => ({ bidderIndex: b.bidderIndex, maxAmount: b.amount, serverTimestampMs: b.atMs }))

    // Incumbent carries a binding bid at their standing price (unless out-bid).
    if (priorStanding.winnerBidderIndex !== null) {
      candidates.push({
        bidderIndex: priorStanding.winnerBidderIndex,
        maxAmount: priorStanding.standingPrice,
        serverTimestampMs: CARRYOVER_TS,
      })
    }

    // First-price resolution via the shared resolver. Empty endowments/vCommon:
    // SAA reads only winner + clearing price here; profit is computed separately
    // from the standing + value matrix (provisionalProfit).
    const res = resolveAuction(candidates, [], 0, SAA_AUCTION_SETTINGS, SAA_RESERVE)

    next[license] =
      res.winnerBidderIndex === null
        ? { standingPrice: SAA_RESERVE, winnerBidderIndex: null } // never bid on
        : { standingPrice: res.clearingPrice as number, winnerBidderIndex: res.winnerBidderIndex }
  }

  return next
}

/**
 * Provisional profit for a bidder = value(license they are winning) − standingBid,
 * or 0 if they are winning nothing. In valid SAA play a bidder wins at most one
 * license; if (in the pure core) a bidder somehow leads several, the first by
 * license order is used. Feeds the §12 status block in a later slice.
 */
export function provisionalProfit(bidderIndex: number, standing: StandingState): number {
  for (const license of LICENSE_IDS) {
    const s = standing[license]
    if (s.winnerBidderIndex === bidderIndex) {
      return valueFor(license, bidderIndex) - s.standingPrice
    }
  }
  return 0
}
