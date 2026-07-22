# SAA robot mode — Slice 1 (terminal Playwright driver)

Fills every seat of a **live, production** SAA auction with bots that **play through the
real UI** in headed Chromium windows you can watch. Post-deploy tool — the automated
equivalent of clicking through the bidder screen by hand.

## Pieces

- **`strategy.ts`** — pure `decide(view)` implementing the SAA §7.1 dominant strategy
  (round-1 reserve bid on the most-valued license · hold while winning · else
  minimum-legal bid on the highest-surplus license · drop at zero-or-negative surplus ·
  tie-break to the lowest license index). No I/O, no imports. Compiled to `dist/`.
- **`strategy.test.ts`** — vitest unit tests (`npm test`). Green before the loop was wired.
- **`robot-driver.mjs`** — launches N headed windows, reuses the launcher server to mint
  tokens + drive each seat to ready, then runs `read → decide → act-via-UI → wait` per seat.

## Architecture notes

- **Separate from the web launcher.** The launcher *page* is cross-origin to the game and
  can't drive its own windows; this driver launches its **own** Playwright windows and
  drives them. No robot code ships in the SAA frontend.
- **Reuses `server.mjs` verbatim** for login/KC/prep/attendance: it POSTs
  `/api/student-url {mode:'ready'}` — nothing reimplemented.
- **Reads via the DOM.** `getBidderView` isn't exposed to page scope and its `group_id`
  lives only in React state; exposing it would mean editing the frontend (out of scope).
  The driver scrapes the `BidderScreen` `data-testid`s (the same ones the playthrough
  harness uses) into the `getBidderView` shape. Reads exactly the UI you're watching.
- **Acts via the UI.** Fills the bid input + clicks Submit / Drop Out → Confirm. Never
  calls `submitBid`/`holdBid`/`dropOut` directly.

## Run

```
npm install        # once (vitest + typescript)
npm run build      # once / after editing strategy.ts → dist/strategy.js
npm test           # strategy unit tests
```

Then, with the launcher server running (`node classroom/tools/launcher/server.mjs`) and an
attendance code generated from the SAA dashboard:

```
node robot-driver.mjs --instance <gameInstanceId> --seats 7 --pace watch
```

Options: `--pace watch` (5–15s think-time, default) · `--launcher <url>` (default
`http://localhost:5180`) · `--screen 1920x1080` (tiling) · `--cols N`.

**Instructor steps (from the SAA dashboard):** generate the attendance code *before*
running; then, once the driver reports all seats ready, **trigger matching** and **open the
auction** for the group. Bots begin bidding automatically when the bidder screen appears.
