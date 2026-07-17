import {
  resolveAuction,
  type AuctionBid,
  type AuctionEndowment,
} from '@mygames/game-engine/auction'
import { SAA_AUCTION_SETTINGS } from './auction/settings'

// ─────────────────────────────────────────────────────────────────────────────
// SAA round resolution — the FIVE-CALL pattern.
//
// A round is resolved as FIVE INDEPENDENT auctions, one per license A–E (spec
// §2: "Five independent resolutions per round — not one coupled allocation").
// Each license's bids are resolved on their own via the shared resolver; there
// is no cross-license coupling in the payoff function.
//
// Phase 1 proves ONLY the resolver composition. Bid VALIDATION (reserve floor,
// increment schedule, beat-current+increment) is Phase-2 SAA-local work and is
// deliberately NOT performed here.
// ─────────────────────────────────────────────────────────────────────────────

export type LicenseId = 'A' | 'B' | 'C' | 'D' | 'E'
export const LICENSE_IDS: readonly LicenseId[] = ['A', 'B', 'C', 'D', 'E']

// §1.2: reservation price is 200 on every license; bidding starts at 200.
export const SAA_RESERVE = 200

// §1.1 value matrix (locked 2026-07-13). VALUE_MATRIX[license][bidderIndex 1..7]
// = that bidder's private value for that license.
export const VALUE_MATRIX: Record<LicenseId, Record<number, number>> = {
  A: { 1: 600, 2: 545, 3: 441, 4: 497, 5: 616, 6: 499, 7: 535 },
  B: { 1: 539, 2: 456, 3: 499, 4: 478, 5: 633, 6: 545, 7: 428 },
  C: { 1: 586, 2: 635, 3: 484, 4: 451, 5: 477, 6: 619, 7: 648 },
  D: { 1: 356, 2: 582, 3: 339, 4: 481, 5: 558, 6: 589, 7: 626 },
  E: { 1: 473, 2: 386, 3: 490, 4: 449, 5: 461, 6: 625, 7: 379 },
}

// One sealed bid: a bidder bids some amount on exactly one license in a round.
export interface SaaBid {
  bidderIndex: number // 1..7
  licenseId: LicenseId
  amount: number
  atMs: number // server-receipt time; used ONLY for tie-breaking
}

export interface LicenseResolution {
  licenseId: LicenseId
  winnerBidderIndex: number | null
  clearingPrice: number | null
}

/**
 * Resolve one round: call resolveAuction() once per license (A–E) on the bids
 * placed on that license, and return the five independent outcomes.
 *
 * The reserve (200) is passed as the resolver's `startingPrice`. Under SAA's
 * pinned first-price rule the resolver never consults it (first-price always
 * prices at the winner's own bid); it is the second-price single-bidder fallback
 * only. Passing it keeps the call faithful to the reserve context.
 */
export function resolveRound(bids: SaaBid[]): LicenseResolution[] {
  return LICENSE_IDS.map((licenseId) => {
    const onLicense = bids.filter((b) => b.licenseId === licenseId)

    const auctionBids: AuctionBid[] = onLicense.map((b) => ({
      bidderIndex: b.bidderIndex,
      maxAmount: b.amount,
      serverTimestampMs: b.atMs,
    }))

    // Endowments carry each participant's private value for THIS license, so the
    // resolver can compute realizedValue/profit. SAA has no signal/common-value
    // layer, so signal and signalHalfWidth are 0 and vCommon is 0.
    const endowments: AuctionEndowment[] = onLicense.map((b) => ({
      bidderIndex: b.bidderIndex,
      signal: 0,
      privateValue: VALUE_MATRIX[licenseId][b.bidderIndex],
      signalHalfWidth: 0,
    }))

    const res = resolveAuction(
      auctionBids,
      endowments,
      0, // vCommon — SAA has no common value
      SAA_AUCTION_SETTINGS,
      SAA_RESERVE, // startingPrice
    )

    return {
      licenseId,
      winnerBidderIndex: res.winnerBidderIndex,
      clearingPrice: res.clearingPrice,
    }
  })
}
