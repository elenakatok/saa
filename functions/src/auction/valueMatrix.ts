// ═══════════════════════════════════════════════════════════════════════════════
// SAA — the LOCKED value matrix (§1.1) as DATA.
//
// Each bidder (1–7) has a private value for each license (A–E). This constant is
// the single source of truth; it will later feed the bidder screen ("your value"
// column) and grading, as well as Slice-1 provisional-profit math. Do NOT inline
// these numbers into logic — read them through valueFor().
// ═══════════════════════════════════════════════════════════════════════════════

export type LicenseId = 'A' | 'B' | 'C' | 'D' | 'E'

export const LICENSE_IDS: readonly LicenseId[] = ['A', 'B', 'C', 'D', 'E'] as const

/** Bidders are indexed 1..7 (fixed group of 7 — spec §6). */
export const BIDDER_INDICES: readonly number[] = [1, 2, 3, 4, 5, 6, 7] as const

/** §1.2: reservation price is 200 on every license; bidding starts at 200. */
export const SAA_RESERVE = 200

// §1.1 value matrix (locked, Elena 2026-07-13). VALUE_MATRIX[license][bidderIndex].
export const VALUE_MATRIX: Record<LicenseId, Record<number, number>> = {
  A: { 1: 600, 2: 545, 3: 441, 4: 497, 5: 616, 6: 499, 7: 535 },
  B: { 1: 539, 2: 456, 3: 499, 4: 478, 5: 633, 6: 545, 7: 428 },
  C: { 1: 586, 2: 635, 3: 484, 4: 451, 5: 477, 6: 619, 7: 648 },
  D: { 1: 356, 2: 582, 3: 339, 4: 481, 5: 558, 6: 589, 7: 626 },
  E: { 1: 473, 2: 386, 3: 490, 4: 449, 5: 461, 6: 625, 7: 379 },
}

/**
 * Bidder `bidderIndex`'s private value for `license`.
 * Throws on an out-of-range license or bidder — the matrix is complete and fixed,
 * so a miss is a programming error, not a data gap.
 */
export function valueFor(license: LicenseId, bidderIndex: number): number {
  const row = VALUE_MATRIX[license]
  if (row === undefined) throw new Error(`valueFor: unknown license '${license}'`)
  const v = row[bidderIndex]
  if (v === undefined) throw new Error(`valueFor: unknown bidderIndex ${bidderIndex} for license '${license}'`)
  return v
}
