import { describe, it, expect } from 'vitest'
import { validateBid, type ValidateBidInput } from './validateBid'
import { initialStanding, type StandingState } from './resolution'
import type { LicenseId } from './valueMatrix'

// ═══════════════════════════════════════════════════════════════════════════════
// SAA Phase 2 — Slice 2 harness: the pure bid validator. Case A (non-winner) must
// clear reserve + increment to TAKE a held license (unheld reserve → 200 ok);
// Case B (provisional winner) may only self-raise W by any strict amount.
// ═══════════════════════════════════════════════════════════════════════════════

// Build a standing state with per-license overrides. `[price, winner|null]`.
function standingOf(overrides: Partial<Record<LicenseId, [number, number | null]>>): StandingState {
  const s = initialStanding()
  for (const [l, [price, winner]] of Object.entries(overrides) as [LicenseId, [number, number | null]][]) {
    s[l] = { standingPrice: price, winnerBidderIndex: winner }
  }
  return s
}

const submit = (bidderIndex: number, standing: StandingState, ...bids: { licenseId: LicenseId; amount: number }[]): ValidateBidInput =>
  ({ bidderIndex, bids, standing })

const one = (licenseId: LicenseId, amount: number) => ({ licenseId, amount })

describe('Slice 2 — SAA bid validator', () => {
  // ── Case A: non-winner ───────────────────────────────────────────────────────
  describe('Case A — non-winner', () => {
    it('(1) below 200 → rejected with reserve reason', () => {
      const r = validateBid(submit(3, initialStanding(), one('A', 150)))
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.reason).toMatch(/at least 200/i)
        expect(r.minimumRequired).toBe(200)
      }
    })

    it('(2) held @250 (band 100): 300 rejected (needs ≥350), 350 legal', () => {
      const s = standingOf({ C: [250, 4] }) // held by B4
      const lo = validateBid(submit(3, s, one('C', 300)))
      expect(lo.ok).toBe(false)
      if (!lo.ok) { expect(lo.minimumRequired).toBe(350); expect(lo.reason).toMatch(/at least 350/) }
      expect(validateBid(submit(3, s, one('C', 350))).ok).toBe(true)
    })

    it('(3) held @350 (band 50): 380 rejected (needs ≥400), 400 legal', () => {
      const s = standingOf({ C: [350, 4] })
      const lo = validateBid(submit(3, s, one('C', 380)))
      expect(lo.ok).toBe(false)
      if (!lo.ok) expect(lo.minimumRequired).toBe(400)
      expect(validateBid(submit(3, s, one('C', 400))).ok).toBe(true)
    })

    it('(4) held @425 (band 25): 440 rejected (needs ≥450), 450 legal', () => {
      const s = standingOf({ C: [425, 4] })
      const lo = validateBid(submit(3, s, one('C', 440)))
      expect(lo.ok).toBe(false)
      if (!lo.ok) expect(lo.minimumRequired).toBe(450)
      expect(validateBid(submit(3, s, one('C', 450))).ok).toBe(true)
    })

    it('(5) two licenses in one round → rejected, one-license reason', () => {
      const r = validateBid(submit(3, initialStanding(), one('A', 300), one('B', 300)))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/only one license/i)
    })

    // (6) THE Slice-1 agreement point: 200-with-null vs 200-with-holder.
    it('(6a) round-1 untouched license (200, no winner) → 200 is LEGAL (takeable at reserve)', () => {
      const r = validateBid(submit(3, initialStanding(), one('A', 200)))
      expect(r.ok).toBe(true)
    })
    it('(6b) license held at 200 → 200 rejected (needs ≥300), 300 legal', () => {
      const s = standingOf({ A: [200, 5] }) // B5 already holds A at 200
      const lo = validateBid(submit(3, s, one('A', 200)))
      expect(lo.ok).toBe(false)
      if (!lo.ok) { expect(lo.minimumRequired).toBe(300); expect(lo.reason).toMatch(/at least 300/) }
      expect(validateBid(submit(3, s, one('A', 300))).ok).toBe(true)
    })
  })

  // ── Case B: provisional winner of W ──────────────────────────────────────────
  describe('Case B — provisional winner of W', () => {
    const s = standingOf({ A: [350, 3] }) // B3 is winning A at 350

    it('(7) winner bids on a DIFFERENT license → rejected, no-switch reason', () => {
      const r = validateBid(submit(3, s, one('C', 500)))
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/winning license A.*cannot bid on a different/i)
    })

    it('(8) winner bids EQUAL to current on W → rejected (not a raise)', () => {
      const r = validateBid(submit(3, s, one('A', 350)))
      expect(r.ok).toBe(false)
      if (!r.ok) { expect(r.reason).toMatch(/more than your current 350/); expect(r.minimumRequired).toBe(351) }
    })

    it('(9) winner bids LOWER than current on W → rejected', () => {
      expect(validateBid(submit(3, s, one('A', 300))).ok).toBe(false)
    })

    it('(10) winner bids current+1 on W → LEGAL (self-raise, increment does NOT apply)', () => {
      expect(validateBid(submit(3, s, one('A', 351))).ok).toBe(true)
    })

    it('(11) winner submits nothing → legal (carry-over stands)', () => {
      expect(validateBid({ bidderIndex: 3, bids: [], standing: s }).ok).toBe(true)
    })

    it('a self-raise ignores the increment band (winner at 250 may go to 251)', () => {
      const s2 = standingOf({ A: [250, 3] })
      expect(validateBid(submit(3, s2, one('A', 251))).ok).toBe(true) // +1, not +100
    })
  })

  // ── guards ───────────────────────────────────────────────────────────────────
  it('non-finite / non-positive amount → rejected', () => {
    expect(validateBid(submit(3, initialStanding(), one('A', Number.NaN))).ok).toBe(false)
    expect(validateBid(submit(3, initialStanding(), one('A', 0))).ok).toBe(false)
  })
})
