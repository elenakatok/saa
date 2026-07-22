import { describe, it, expect } from 'vitest'
import { decide, type BidderView, type BidderLicenseRow, type LicenseId } from './strategy'

// ── View builders ───────────────────────────────────────────────────────────────
// Construct getBidderView-shaped snapshots. `rows` gives per-license overrides; the
// rest default to a plausible mid-auction row. decide() is pure, so these fixtures
// fully determine the asserted action.

function row(licenseId: LicenseId, o: Partial<BidderLicenseRow> = {}): BidderLicenseRow {
  return {
    licenseId,
    yourValue: 0,
    currentHighBid: 0,
    currentWinnerIndex: null,
    youAreWinner: false,
    minIncrement: 25,
    minLegalBidForYou: null,
    ...o,
  }
}

function view(o: Partial<BidderView> & { licenses: BidderLicenseRow[] }): BidderView {
  return {
    status: 'open',
    round: 2,
    bidderIndex: 1,
    active: true,
    droppedOut: false,
    hasActedThisRound: false,
    isWinner: false,
    winningLicense: null,
    currentBidOnWinningLicense: null,
    ...o,
  }
}

describe('decide — SAA §7.1 dominant strategy', () => {
  it('round 1: bids the reserve on the most-valued license', () => {
    // Round 1 → server reports minLegalBidForYou = reserve (200) on every license.
    const v = view({
      round: 1,
      licenses: [
        row('A', { yourValue: 300, minLegalBidForYou: 200 }),
        row('B', { yourValue: 500, minLegalBidForYou: 200 }), // most valued
        row('C', { yourValue: 450, minLegalBidForYou: 200 }),
      ],
    })
    expect(decide(v)).toEqual({ action: 'bid', license: 'B', amount: 200 })
  })

  it('holds while winning a license (never raises its own standing bid)', () => {
    const v = view({
      isWinner: true,
      winningLicense: 'C',
      currentBidOnWinningLicense: 350,
      licenses: [
        row('A', { yourValue: 400, minLegalBidForYou: 300 }), // tempting, but we hold
        row('C', { yourValue: 600, currentHighBid: 350, youAreWinner: true, currentWinnerIndex: 1 }),
      ],
    })
    expect(decide(v)).toEqual({ action: 'hold' })
  })

  it('when not winning, jumps to the highest-surplus license at the min legal bid', () => {
    // Surplus at price-you'd-pay: A = 500-450 = 50, B = 900-500 = 400, C = 480-460 = 20.
    const v = view({
      licenses: [
        row('A', { yourValue: 500, currentHighBid: 400, minLegalBidForYou: 450 }),
        row('B', { yourValue: 900, currentHighBid: 450, minLegalBidForYou: 500 }), // best surplus
        row('C', { yourValue: 480, currentHighBid: 435, minLegalBidForYou: 460 }),
      ],
    })
    // Bids the MINIMUM legal amount (500), not more.
    expect(decide(v)).toEqual({ action: 'bid', license: 'B', amount: 500 })
  })

  it('breaks a surplus tie toward the lowest license index', () => {
    // A and C both yield surplus 100; B yields 100 too but comes later — lowest index wins.
    const v = view({
      licenses: [
        row('C', { yourValue: 350, minLegalBidForYou: 250 }), // surplus 100, index C
        row('A', { yourValue: 300, minLegalBidForYou: 200 }), // surplus 100, index A ← winner
        row('B', { yourValue: 325, minLegalBidForYou: 225 }), // surplus 100, index B
      ],
    })
    expect(decide(v)).toEqual({ action: 'bid', license: 'A', amount: 200 })
  })

  it('drops out when no license offers positive surplus (zero-or-negative)', () => {
    // A: 400-400 = 0 (zero → not positive), B: 300-350 = -50.
    const v = view({
      licenses: [
        row('A', { yourValue: 400, currentHighBid: 375, minLegalBidForYou: 400 }),
        row('B', { yourValue: 300, currentHighBid: 325, minLegalBidForYou: 350 }),
      ],
    })
    expect(decide(v)).toEqual({ action: 'drop' })
  })

  // ── Guards: not the bot's move → null ──────────────────────────────────────────

  it('returns null once the auction has ended', () => {
    expect(decide(view({ status: 'ended', licenses: [row('A', { yourValue: 999, minLegalBidForYou: 200 })] }))).toBeNull()
  })

  it('returns null after dropping out (watch mode)', () => {
    expect(decide(view({ droppedOut: true, active: false, licenses: [row('A', { yourValue: 999, minLegalBidForYou: 200 })] }))).toBeNull()
  })

  it('returns null after already acting this round', () => {
    expect(decide(view({ hasActedThisRound: true, licenses: [row('A', { yourValue: 999, minLegalBidForYou: 200 })] }))).toBeNull()
  })

  it('drops out when the only biddable license would need more than its value', () => {
    const v = view({ licenses: [row('A', { yourValue: 210, minLegalBidForYou: 300 })] })
    expect(decide(v)).toEqual({ action: 'drop' })
  })
})
