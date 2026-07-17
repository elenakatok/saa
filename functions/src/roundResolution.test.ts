import { describe, it, expect } from 'vitest'
import {
  resolveRound,
  VALUE_MATRIX,
  SAA_RESERVE,
  type SaaBid,
  type LicenseId,
  type LicenseResolution,
} from './roundResolution'
import { SAA_AUCTION_SETTINGS } from './auction/settings'

// ─────────────────────────────────────────────────────────────────────────────
// PROOF: the extracted shared resolver + SAA's five-call-per-round pattern
// compose correctly. One round of sealed bids, resolved as five independent
// auctions (one per license A–E).
//
// Scenario (all 7 bidders bid once; all bids ≥ 200 reserve):
//   A: bidder 1 @300, bidder 5 @350      -> contested (2-way)  -> winner 5 @350
//   C: bidder 2 @400, bidder 6 @430, bidder 7 @450 -> contested (3-way) -> winner 7 @450
//   B: bidder 4 @300                     -> single bidder      -> winner 4 @300
//   E: bidder 3 @250                     -> single bidder      -> winner 3 @250
//   D: (no bids)                         -> no sale            -> winner null
// ─────────────────────────────────────────────────────────────────────────────

const ROUND_BIDS: SaaBid[] = [
  { bidderIndex: 1, licenseId: 'A', amount: 300, atMs: 1 },
  { bidderIndex: 5, licenseId: 'A', amount: 350, atMs: 2 },
  { bidderIndex: 2, licenseId: 'C', amount: 400, atMs: 3 },
  { bidderIndex: 6, licenseId: 'C', amount: 430, atMs: 4 },
  { bidderIndex: 7, licenseId: 'C', amount: 450, atMs: 5 },
  { bidderIndex: 4, licenseId: 'B', amount: 300, atMs: 6 },
  { bidderIndex: 3, licenseId: 'E', amount: 250, atMs: 7 },
  // license D: no bids this round
]

function byLicense(results: LicenseResolution[]): Record<LicenseId, LicenseResolution> {
  const out = {} as Record<LicenseId, LicenseResolution>
  for (const r of results) out[r.licenseId] = r
  return out
}

describe('SAA round resolution — five independent resolver calls', () => {
  const results = resolveRound(ROUND_BIDS)
  const R = byLicense(results)

  it('produces exactly five license resolutions (one resolveAuction call per license)', () => {
    expect(results.map((r) => r.licenseId)).toEqual(['A', 'B', 'C', 'D', 'E'])
  })

  // (a) Each license resolves to ITS OWN highest bidder, independently.
  describe('(a) independence: each license resolves to its own highest bidder', () => {
    it('A -> highest of {1@300, 5@350} = bidder 5', () => {
      expect(R.A.winnerBidderIndex).toBe(5)
    })
    it('C -> highest of {2@400, 6@430, 7@450} = bidder 7', () => {
      expect(R.C.winnerBidderIndex).toBe(7)
    })
    it('B -> its lone bidder 4 (independent of the contested licenses)', () => {
      expect(R.B.winnerBidderIndex).toBe(4)
    })
    it('E -> its lone bidder 3', () => {
      expect(R.E.winnerBidderIndex).toBe(3)
    })
    it('D -> no bids -> no sale (an empty license borrows nothing from the others)', () => {
      expect(R.D.winnerBidderIndex).toBeNull()
      expect(R.D.clearingPrice).toBeNull()
    })
  })

  // (b) FIRST-PRICE: the winner's clearing price equals their OWN submitted bid,
  //     never a second-price computation.
  describe('(b) first-price: winner pays their own submitted bid', () => {
    it('A clears at 350 = bidder 5\'s own bid', () => {
      expect(R.A.clearingPrice).toBe(350)
    })
    it('C clears at 450 = bidder 7\'s own bid', () => {
      expect(R.C.clearingPrice).toBe(450)
    })
    it('B clears at 300 = bidder 4\'s own bid', () => {
      expect(R.B.clearingPrice).toBe(300)
    })
    it('A is NOT priced second-price (would be runnerUp + increment = 325)', () => {
      const secondPriceWouldBe = Math.min(350, 300 + SAA_AUCTION_SETTINGS.increment) // 325
      expect(secondPriceWouldBe).toBe(325)
      expect(R.A.clearingPrice).not.toBe(secondPriceWouldBe)
      expect(R.A.clearingPrice).toBe(350)
    })
  })

  // (c) Single-bidder license: resolves to that bidder AT THEIR BID — under
  //     first-price the resolver does NOT fall back to startingPrice (the reserve).
  describe('(c) single-bidder license under first-price', () => {
    it('E -> bidder 3 at their own bid 250, NOT the startingPrice/reserve 200', () => {
      expect(R.E.winnerBidderIndex).toBe(3)
      expect(R.E.clearingPrice).toBe(250)
      expect(R.E.clearingPrice).not.toBe(SAA_RESERVE) // would be 200 under second-price fallback
    })
  })

  // Sanity: the value matrix wired into endowments matches the locked spec §1.1.
  it('value matrix spot-checks (§1.1)', () => {
    expect(VALUE_MATRIX.A[5]).toBe(616)
    expect(VALUE_MATRIX.C[7]).toBe(648)
    expect(VALUE_MATRIX.D[3]).toBe(339) // lowest value in the table, still > 200 reserve
  })
})
