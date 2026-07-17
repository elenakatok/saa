// ═══════════════════════════════════════════════════════════════════════════════
// SAA Phase 2 — Slice 2: the PURE bid validator (the gatekeeper eBay never had).
//
// Given a bidder, the current standing state (Slice 1), and a proposed submission,
// decide LEGAL or REJECTED with an explicit, student-readable reason. PURE — no
// Firestore/RTDB/I/O. The round loop, submission persistence, drop-out state, and
// UI are Slices 3–6.
//
// Two cases, self-classified from the standing state:
//   • Case A — bidder wins nothing at round start. A bid must clear the reserve and,
//     to TAKE a HELD license, the increment schedule. An UNHELD reserve license
//     (200 / no winner) is takeable at exactly 200 — no increment gate. This mirrors
//     Slice-1 resolveRound: a 200 bid wins an unheld license, but merely TIES (and
//     loses to) an incumbent already standing at 200.
//   • Case B — bidder IS a provisional winner of W. They may only RAISE their own W
//     by any strict amount; the increment schedule does NOT apply to a self-raise.
//
// Drop-out ("I'm Done") is NOT a bid — the validator never sees it (Slice 3). A
// bidder submitting nothing is legal here (their carry-over, if any, stands).
// ═══════════════════════════════════════════════════════════════════════════════

import { LICENSE_IDS, SAA_RESERVE, type LicenseId } from './valueMatrix'
import { minIncrement } from './increment'
import type { StandingState } from './resolution'

/** One attempted bid. A submission is an array so a 2+-license attempt is catchable. */
export interface BidAttempt {
  licenseId: LicenseId
  amount: number
}

export interface ValidateBidInput {
  bidderIndex: number
  /** 0 = no bid (carry-over stands); 1 = a submission; 2+ = illegal multi-license. */
  bids: BidAttempt[]
  standing: StandingState
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; reason: string; minimumRequired?: number }

/** The license this bidder is currently provisionally winning, or null. */
export function winningLicenseOf(bidderIndex: number, standing: StandingState): LicenseId | null {
  for (const l of LICENSE_IDS) {
    if (standing[l].winnerBidderIndex === bidderIndex) return l
  }
  return null
}

/**
 * The smallest LEGAL amount a NON-winner must enter to take `licenseId`:
 *   • unheld reserve license (no winner) → the reserve (200), no increment gate;
 *   • held license → standingPrice + minIncrement(standingPrice).
 */
export function minToTake(licenseId: LicenseId, standing: StandingState): number {
  const s = standing[licenseId]
  if (s.winnerBidderIndex === null) return SAA_RESERVE
  return s.standingPrice + minIncrement(s.standingPrice)
}

export function validateBid(input: ValidateBidInput): ValidationResult {
  const { bidderIndex, bids, standing } = input

  // Submitting nothing is legal — carry-over (if any) stands; a non-winner simply
  // sat this round out. Drop-out is a separate action (Slice 3), never seen here.
  if (bids.length === 0) return { ok: true }

  // One-license rule (everyone).
  if (bids.length > 1) {
    return { ok: false, reason: 'You may bid on only one license per round.' }
  }

  const { licenseId, amount } = bids[0]

  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: 'Enter a valid bid amount.' }
  }

  const currentlyWinning = winningLicenseOf(bidderIndex, standing)

  // ── Case B: provisional winner of W — self-raise only ──────────────────────
  if (currentlyWinning !== null) {
    const w = currentlyWinning
    const current = standing[w].standingPrice
    if (licenseId !== w) {
      return {
        ok: false,
        reason: `You are currently winning license ${w}. You cannot bid on a different license.`,
      }
    }
    // Strictly greater than the current standing bid — a raise. Equal is just the
    // auto-renew (not a submission); lower is meaningless. Increment does NOT apply.
    if (amount <= current) {
      return {
        ok: false,
        reason: `To raise your bid on license ${w}, enter more than your current ${current}.`,
        minimumRequired: current + 1,
      }
    }
    return { ok: true }
  }

  // ── Case A: non-winner ─────────────────────────────────────────────────────
  // Reserve floor first (distinct reason for sub-200).
  if (amount < SAA_RESERVE) {
    return { ok: false, reason: `Bids must be at least ${SAA_RESERVE}.`, minimumRequired: SAA_RESERVE }
  }
  // Clear the increment to TAKE a held license (unheld reserve license → 200 is enough).
  const minimum = minToTake(licenseId, standing)
  if (amount < minimum) {
    return {
      ok: false,
      reason: `To bid on license ${licenseId} you must enter at least ${minimum}.`,
      minimumRequired: minimum,
    }
  }
  return { ok: true }
}
