// ═══════════════════════════════════════════════════════════════════════════════
// SAA — the minimum-increment SCHEDULE (§1.3), a FUNCTION of the current price.
//
// This is the whole point of SAA's increment being a schedule, not a scalar: the
// required raise DECREASES as a license's price climbs. It is SAA-LOCAL — the
// shared AuctionSettings.increment stays a scalar (unused under first-price); any
// call that needs a scalar resolves a band → number via minIncrement() first.
//
//   current price 200–299 → 100
//   current price 300–399 → 50
//   current price ≥ 400    → 25
//
// Round 1 is special (no increment; bidding simply opens at 200) — that is a
// ROUND-LOOP concern (Slice 3+), NOT this function's. minIncrement() answers only
// "given a license standing at P, what is the smallest raise to take it?"
//
// The resulting minimum ladder from reserve:
//   200 → 300 → 350 → 400 → 425 → 450 → 475 → 500 → …
// ═══════════════════════════════════════════════════════════════════════════════

/** Documentation of the bands (lower bound inclusive). minIncrement() is authoritative. */
export const INCREMENT_BANDS: ReadonlyArray<{ minPrice: number; increment: number }> = [
  { minPrice: 400, increment: 25 },
  { minPrice: 300, increment: 50 },
  { minPrice: 200, increment: 100 },
] as const

/**
 * The minimum raise required to out-bid a license standing at `currentPrice`.
 * Prices below the 200 reserve cannot occur in play; they are treated as the
 * lowest band (100) defensively.
 */
export function minIncrement(currentPrice: number): number {
  if (currentPrice >= 400) return 25
  if (currentPrice >= 300) return 50
  return 100 // 200–299 (and any defensive < 200)
}

/** Convenience: the smallest legal bid that takes a license standing at `currentPrice`. */
export function minBidToTake(currentPrice: number): number {
  return currentPrice + minIncrement(currentPrice)
}
