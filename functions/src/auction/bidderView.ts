// ═══════════════════════════════════════════════════════════════════════════════
// SAA — the per-seat BidderView builder (PURE), extracted from getBidderView so a
// bot seat can be fed the SAME view a human's browser gets, server-side, with no
// auth/browser context. getBidderView (saaAuction.ts) now composes its wire response
// on top of this core, so the human view is byte-for-byte unchanged.
//
// Reads NOTHING — it is a pure projection of RoundLoopState + the caller's bidderIndex
// (+ the value matrix). The one group state doc is read by the caller.
// ═══════════════════════════════════════════════════════════════════════════════

import { LICENSE_IDS, valueFor, type LicenseId } from './valueMatrix'
import { minIncrement } from './increment'
import { winningLicenseOf, minToTake } from './validateBid'
import type { RoundLoopState } from './roundLoop'

export interface BidderLicenseRow {
  licenseId: LicenseId
  yourValue: number
  currentHighBid: number
  currentWinnerIndex: number | null
  youAreWinner: boolean
  minIncrement: number
  minLegalBidForYou: number | null
}

/** Exactly the shape the bot strategy's decide() consumes (structural match). */
export interface BidderViewCore {
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

/**
 * Build the paranoid §12 per-caller view core for `bidderIndex` against `state`.
 * IDENTICAL logic to the former inline body of getBidderView (drop-out reflected
 * immediately; minLegalBidForYou only offered while the caller can act).
 */
export function buildBidderView(state: RoundLoopState, bidderIndex: number): BidderViewCore {
  const winningLicense = winningLicenseOf(bidderIndex, state.standing)
  const myAction = state.actions[bidderIndex]
  const droppedOut =
    state.droppedBidders.includes(bidderIndex) || myAction?.type === 'dropout' || myAction?.type === 'forced_out'
  const active = state.activeBidders.includes(bidderIndex) && !droppedOut
  const isOpen = state.status === 'open'
  const hasActedThisRound = myAction !== undefined

  const licenses: BidderLicenseRow[] = LICENSE_IDS.map((l) => {
    const s = state.standing[l]
    let minLegalBidForYou: number | null = null
    if (isOpen && active && !hasActedThisRound) {
      if (winningLicense === null) minLegalBidForYou = minToTake(l, state.standing)
      else if (l === winningLicense) minLegalBidForYou = s.standingPrice + 1
    }
    return {
      licenseId: l,
      yourValue: valueFor(l, bidderIndex),
      currentHighBid: s.standingPrice,
      currentWinnerIndex: s.winnerBidderIndex,
      youAreWinner: s.winnerBidderIndex === bidderIndex,
      minIncrement: minIncrement(s.standingPrice),
      minLegalBidForYou,
    }
  })

  return {
    status: state.status,
    round: state.round,
    bidderIndex,
    active,
    droppedOut,
    hasActedThisRound,
    isWinner: winningLicense !== null,
    winningLicense,
    currentBidOnWinningLicense: winningLicense ? state.standing[winningLicense].standingPrice : null,
    licenses,
  }
}
