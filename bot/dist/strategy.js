// ═══════════════════════════════════════════════════════════════════════════════
// SAA robot mode — Slice 1 STRATEGY (SAA spec §7.1, the dominant strategy).
//
// PURE. No I/O, no SDK, no timers, no imports. `decide(view)` maps a getBidderView
// snapshot to the single action the bot should take THIS round, or null when it is
// not the bot's move. The driver (robot-driver.mjs) reads the live view off the
// BidderScreen, calls decide(), and performs the action THROUGH THE UI.
//
// §7.1 dominant strategy for a first-price serial ascending auction:
//   • Round 1: bid the reserve on the most-valued license.
//   • While winning a license: hold (never raise your own standing bid).
//   • When not winning: bid the MINIMUM legal amount on the license with the
//     highest surplus, where surplus is evaluated at the price you'd actually pay
//     (first-price → your own minimum-legal bid).
//   • Drop out when no license offers positive surplus.
//   • Bots bid MINIMUM LEGAL amounts only (never more than minLegalBidForYou).
//
// Round 1 needs no special case: in round 1 the server reports minLegalBidForYou =
// the reserve (opening) price for every license, so the "highest surplus at the
// price you'd pay" rule below reduces to "reserve bid on the most-valued license".
//
// TIE-BREAK (locked, deterministic): equal surplus → LOWEST license index (A<B<…).
// ═══════════════════════════════════════════════════════════════════════════════
/**
 * The dominant-strategy decision for the current round, or null when it is not the
 * bot's move (auction ended, already dropped out, or already acted this round).
 */
export function decide(view) {
    // ── Not our move → nothing to do ────────────────────────────────────────────
    if (view.status === 'ended')
        return null;
    if (view.droppedOut || !view.active)
        return null;
    if (view.hasActedThisRound)
        return null;
    // ── Winning a license → hold (never raise our own standing bid) ──────────────
    if (view.isWinner)
        return { action: 'hold' };
    // ── Not winning → minimum-legal bid on the highest-surplus license ───────────
    // Surplus is evaluated at the price we'd actually pay: minLegalBidForYou
    // (first-price + minimum-legal-bids-only). Consider only licenses we're allowed
    // to bid on (minLegalBidForYou !== null).
    let best = null;
    for (const row of view.licenses) {
        if (row.minLegalBidForYou === null)
            continue;
        const priceYoudPay = row.minLegalBidForYou;
        const surplus = row.yourValue - priceYoudPay;
        // Strictly-greater OR (equal surplus AND lower license index) — deterministic
        // lowest-index tie-break, independent of the order licenses arrive in.
        if (best === null ||
            surplus > best.surplus ||
            (surplus === best.surplus && row.licenseId < best.license)) {
            best = { license: row.licenseId, amount: priceYoudPay, surplus };
        }
    }
    // No biddable license, or nothing with positive surplus → drop out.
    if (best === null || best.surplus <= 0)
        return { action: 'drop' };
    return { action: 'bid', license: best.license, amount: best.amount };
}
