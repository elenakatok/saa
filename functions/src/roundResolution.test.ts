import { describe, it, expect } from 'vitest'
import {
  resolveRound,
  initialStanding,
  provisionalProfit,
  minIncrement,
  minBidToTake,
  valueFor,
  SAA_RESERVE,
  LICENSE_IDS,
  type StandingState,
  type SaaBid,
} from './roundResolution'
import { SAA_AUCTION_SETTINGS } from './auction/settings'

// ═══════════════════════════════════════════════════════════════════════════════
// SAA Phase 2 — Slice 1 harness: the pure per-round resolution core, exercised
// against the REAL §1.1 value matrix. First-price, per-license independence,
// increment schedule, and binding carry-over are the load-bearing invariants.
// ═══════════════════════════════════════════════════════════════════════════════

// helper: place a bid
const bid = (bidderIndex: number, licenseId: SaaBid['licenseId'], amount: number, atMs = amount): SaaBid =>
  ({ bidderIndex, licenseId, amount, atMs })

describe('Slice 1 — SAA round-resolution core', () => {
  // ── 1. Round 1 opens at 200 ──────────────────────────────────────────────────
  describe('(1) round 1 opens at reserve 200', () => {
    const init = initialStanding()
    it('initial standing is all five licenses at 200, no winners', () => {
      for (const l of LICENSE_IDS) {
        expect(init[l]).toEqual({ standingPrice: 200, winnerBidderIndex: null })
      }
    })
    it('a single 200 bid on an untouched license wins it at 200 (no increment round 1)', () => {
      const next = resolveRound(init, [bid(3, 'E', 200)])
      expect(next.E).toEqual({ standingPrice: 200, winnerBidderIndex: 3 })
      // untouched licenses stay at reserve with no winner
      expect(next.A).toEqual({ standingPrice: 200, winnerBidderIndex: null })
    })
  })

  // ── 2. First-price: winner pays their OWN bid (not second-price) ─────────────
  describe('(2) first-price — winner pays own bid', () => {
    it('A with {B1@300, B5@350} clears at 350 (B5 own bid), NOT second-price', () => {
      const next = resolveRound(initialStanding(), [bid(1, 'A', 300), bid(5, 'A', 350)])
      expect(next.A.winnerBidderIndex).toBe(5)
      expect(next.A.standingPrice).toBe(350) // own bid
      const secondPriceWouldBe = Math.min(350, 300 + SAA_AUCTION_SETTINGS.increment) // 325
      expect(secondPriceWouldBe).toBe(325)
      expect(next.A.standingPrice).not.toBe(secondPriceWouldBe)
    })
    it('the pinned settings really are first-price', () => {
      expect(SAA_AUCTION_SETTINGS.pricing).toBe('first')
    })
  })

  // ── 3. Per-license independence: independent winners, prices, ladders ────────
  describe('(3) per-license independence — C at 425 while A at 200', () => {
    // prior: C already run up to 425 (B7 winning); A untouched at reserve.
    const prior: StandingState = {
      ...initialStanding(),
      C: { standingPrice: 425, winnerBidderIndex: 7 },
    }
    // this round: B1 opens A at 200; nobody bids on C.
    const next = resolveRound(prior, [bid(1, 'A', 200)])
    it('A resolves to B1 @200, C carries B7 @425 — different winners, prices, ladders', () => {
      expect(next.A).toEqual({ standingPrice: 200, winnerBidderIndex: 1 })
      expect(next.C).toEqual({ standingPrice: 425, winnerBidderIndex: 7 })
      expect(next.A.winnerBidderIndex).not.toBe(next.C.winnerBidderIndex)
      expect(next.A.standingPrice).not.toBe(next.C.standingPrice)
    })
  })

  // ── 4. Increment bands (schedule function returns 100/50/25) ─────────────────
  describe('(4) increment schedule — 100 / 50 / 25 by band', () => {
    it('band 100 at 200–299: standing 250 needs ≥ 350', () => {
      expect(minIncrement(250)).toBe(100)
      expect(minBidToTake(250)).toBe(350)
    })
    it('band 50 at 300–399: standing 350 needs ≥ 400', () => {
      expect(minIncrement(350)).toBe(50)
      expect(minBidToTake(350)).toBe(400)
    })
    it('band 25 at ≥400: standing 425 needs ≥ 450', () => {
      expect(minIncrement(425)).toBe(25)
      expect(minBidToTake(425)).toBe(450)
    })
    it('band boundaries: 299→100, 300→50, 399→50, 400→25', () => {
      expect(minIncrement(299)).toBe(100)
      expect(minIncrement(300)).toBe(50)
      expect(minIncrement(399)).toBe(50)
      expect(minIncrement(400)).toBe(25)
    })
    it('the minimum ladder from reserve is 200→300→350→400→425→450→475→500', () => {
      const ladder: number[] = [200]
      while (ladder[ladder.length - 1] < 500) ladder.push(minBidToTake(ladder[ladder.length - 1]))
      expect(ladder).toEqual([200, 300, 350, 400, 425, 450, 475, 500])
    })
  })

  // ── 5. Carry-over: unbeaten winner retained; out-bid winner replaced ─────────
  describe('(5) carry-over is binding', () => {
    const prior: StandingState = {
      ...initialStanding(),
      A: { standingPrice: 300, winnerBidderIndex: 1 },
    }
    it('a winner who is NOT out-bid retains price + winner unchanged', () => {
      const next = resolveRound(prior, [bid(2, 'B', 200)]) // no bids on A
      expect(next.A).toEqual({ standingPrice: 300, winnerBidderIndex: 1 })
    })
    it('a winner who IS out-bid is replaced at the new higher bid', () => {
      const next = resolveRound(prior, [bid(5, 'A', 400)])
      expect(next.A).toEqual({ standingPrice: 400, winnerBidderIndex: 5 })
    })
    it('a merely-tying bid does NOT displace the incumbent (binding carry-over)', () => {
      const next = resolveRound(prior, [bid(5, 'A', 300)]) // equals standing, not higher
      expect(next.A).toEqual({ standingPrice: 300, winnerBidderIndex: 1 })
    })
  })

  // ── 6. The congestion worked example (§7.1) ──────────────────────────────────
  describe('(6) congestion example — leave contested C for cheap A', () => {
    it('B7: take C@425 → pay 450, surplus 198; take A@200 → pay 300, surplus 235', () => {
      // C: value 648, standing 425, pay = 425 + minIncrement(425)=25 → 450
      const payC = minBidToTake(425)
      const surplusC = valueFor('C', 7) - payC
      expect(valueFor('C', 7)).toBe(648)
      expect(payC).toBe(450)
      expect(surplusC).toBe(198)
      // A: value 535, standing 200, pay = 200 + minIncrement(200)=100 → 300
      const payA = minBidToTake(200)
      const surplusA = valueFor('A', 7) - payA
      expect(valueFor('A', 7)).toBe(535)
      expect(payA).toBe(300)
      expect(surplusA).toBe(235)
      // the lesson: the cheap untouched license is the better move
      expect(surplusA).toBeGreaterThan(surplusC)
    })
  })

  // ── 7. Provisional profit ────────────────────────────────────────────────────
  describe('(7) provisional profit = value(won license) − standing; 0 if winning nothing', () => {
    const standing: StandingState = {
      ...initialStanding(),
      A: { standingPrice: 300, winnerBidderIndex: 1 },
      C: { standingPrice: 450, winnerBidderIndex: 7 },
    }
    it('B1 winning A@300 → 600 − 300 = 300', () => {
      expect(provisionalProfit(1, standing)).toBe(valueFor('A', 1) - 300)
      expect(provisionalProfit(1, standing)).toBe(300)
    })
    it('B7 winning C@450 → 648 − 450 = 198', () => {
      expect(provisionalProfit(7, standing)).toBe(198)
    })
    it('a bidder winning nothing → 0', () => {
      expect(provisionalProfit(2, standing)).toBe(0)
    })
    it('reserve floor is respected as the round-1 starting price', () => {
      expect(SAA_RESERVE).toBe(200)
    })
  })
})
