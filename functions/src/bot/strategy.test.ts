import { describe, it, expect } from 'vitest'
import { decide as decideServer, type BidderView, type BidderLicenseRow, type LicenseId } from './strategy'
// Canonical Slice-1 strategy (games/saa/bot/strategy.ts) — imported directly here (tests
// run locally, not across the deploy boundary) so we can prove this server MIRROR is
// logically identical. If the two ever diverge, this test fails.
import { decide as decideCanonical } from '../../../bot/strategy'

function row(licenseId: LicenseId, o: Partial<BidderLicenseRow> = {}): BidderLicenseRow {
  return { licenseId, yourValue: 0, currentHighBid: 0, currentWinnerIndex: null, youAreWinner: false, minIncrement: 25, minLegalBidForYou: null, ...o }
}
function view(o: Partial<BidderView> & { licenses: BidderLicenseRow[] }): BidderView {
  return { status: 'open', round: 2, bidderIndex: 1, active: true, droppedOut: false, hasActedThisRound: false, isWinner: false, winningLicense: null, currentBidOnWinningLicense: null, ...o }
}

// A representative battery covering every branch of decide().
const FIXTURES: BidderView[] = [
  view({ round: 1, licenses: [row('A', { yourValue: 300, minLegalBidForYou: 200 }), row('B', { yourValue: 500, minLegalBidForYou: 200 }), row('C', { yourValue: 450, minLegalBidForYou: 200 })] }),
  view({ isWinner: true, winningLicense: 'C', currentBidOnWinningLicense: 350, licenses: [row('A', { yourValue: 400, minLegalBidForYou: 300 }), row('C', { yourValue: 600, currentHighBid: 350, youAreWinner: true, currentWinnerIndex: 1 })] }),
  view({ licenses: [row('A', { yourValue: 500, currentHighBid: 400, minLegalBidForYou: 450 }), row('B', { yourValue: 900, currentHighBid: 450, minLegalBidForYou: 500 }), row('C', { yourValue: 480, currentHighBid: 435, minLegalBidForYou: 460 })] }),
  view({ licenses: [row('C', { yourValue: 350, minLegalBidForYou: 250 }), row('A', { yourValue: 300, minLegalBidForYou: 200 }), row('B', { yourValue: 325, minLegalBidForYou: 225 })] }),
  view({ licenses: [row('A', { yourValue: 400, currentHighBid: 375, minLegalBidForYou: 400 }), row('B', { yourValue: 300, currentHighBid: 325, minLegalBidForYou: 350 })] }),
  view({ status: 'ended', licenses: [row('A', { yourValue: 999, minLegalBidForYou: 200 })] }),
  view({ droppedOut: true, active: false, licenses: [row('A', { yourValue: 999, minLegalBidForYou: 200 })] }),
  view({ hasActedThisRound: true, licenses: [row('A', { yourValue: 999, minLegalBidForYou: 200 })] }),
  view({ licenses: [row('A', { yourValue: 210, minLegalBidForYou: 300 })] }),
]

describe('server strategy mirror == canonical Slice-1 strategy', () => {
  it('produces identical decisions across every branch (no drift)', () => {
    for (const v of FIXTURES) {
      expect(decideServer(v)).toEqual(decideCanonical(v as never))
    }
  })

  // Spot-check a couple of concrete outputs so a matched-but-wrong pair still fails.
  it('round-1 reserve on most-valued license', () => {
    expect(decideServer(FIXTURES[0])).toEqual({ action: 'bid', license: 'B', amount: 200 })
  })
  it('holds while winning', () => {
    expect(decideServer(FIXTURES[1])).toEqual({ action: 'hold' })
  })
  it('drops at zero-or-negative surplus', () => {
    expect(decideServer(FIXTURES[4])).toEqual({ action: 'drop' })
  })
})
