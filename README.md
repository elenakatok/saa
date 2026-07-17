# SAA — Serial Spectrum Auction

A first-price sealed-bid serial auction (5 licenses A–E, 7 bidders). Modeled on
the FCC spectrum auction. See `SAA_Game_Specification_v1.md` in the platform root.

## Status: Phase 1 (auction-resolver extraction only)

This directory currently holds ONLY the Phase-1 slice: SAA consuming the shared
auction resolver. The full game (round loop, activity rule, endogenous
termination, bots, bidder/instructor screens) is Phase 2+.

### What Phase 1 contains
- `functions/src/auction/settings.ts` — SAA's pinned `AuctionSettings`
  (`pricing: 'first'`).
- `functions/src/roundResolution.ts` — the **five-call-per-round** pattern: one
  `resolveAuction()` call per license A–E, using the §1.1 value matrix and the
  200 reserve.
- `functions/src/roundResolution.test.ts` — proof that the extracted resolver +
  the five-call pattern compose (12 unit tests: independence, first-price,
  single-bidder).

### Shared-engine dependency — IMPORTANT (pre-tag state)
`functions/package.json` currently depends on the shared engine via a **local
`file:` link**:

```json
"@mygames/game-engine": "file:../../../packages/game-engine"
```

This is the monorepo's established local-shared-package mechanism (identical to
how every game consumes `@mygames/game-ui`, and the `npm link` equivalent the
engine architecture doc prescribes for co-development). It is used because the
`./auction` subpath ships in **game-engine v0.7.0, which is not yet tagged**.

**At release**, flip this line to the git-tag pin like every other game:

```json
"@mygames/game-engine": "git+https://github.com/elenakatok/game-engine.git#v0.7.0"
```

then `rm -rf functions/node_modules functions/package-lock.json && (cd functions && npm install)`.
This only resolves **after** `v0.7.0` is tagged and pushed on the engine repo.
