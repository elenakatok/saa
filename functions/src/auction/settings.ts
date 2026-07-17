import type { AuctionSettings } from '@mygames/game-engine/auction'

// ─────────────────────────────────────────────────────────────────────────────
// SAA's PINNED auction settings.
//
// SAA is a FIRST-PRICE sealed-bid serial auction (spec §1, §2). The shared
// resolver (@mygames/game-engine/auction) branches on these values; SAA fixes
// pricing:'first', so the round winner pays their OWN submitted bid — never a
// second-price computation.
// ─────────────────────────────────────────────────────────────────────────────
export const SAA_AUCTION_SETTINGS: AuctionSettings = {
  durationSeconds: 0,      // §2: rounds do not time out — there is no clock
  increment: 25,           // scalar, and UNUSED under first-price. SAA's per-band
                           //   increment schedule (100 / 50 / 25 by standing price,
                           //   §1.3) is Phase-2 bid-VALIDATION: it is resolved
                           //   band -> scalar BEFORE a bid is accepted and never
                           //   reaches the resolver. Kept scalar here on purpose.
  direction: 'ascending',  // only implemented direction; 'sealed' resolves identically
  format: 'sealed',        // §2: simultaneous private bids per round
  closeType: 'hard',       // not the resolver's concern
  pricing: 'first',        // ← SAA IS FIRST-PRICE: winner pays their own bid
  proxyBidding: false,     // §1.5: free-amount sealed bids, no proxy
  revealAtClose: 'full',
}
