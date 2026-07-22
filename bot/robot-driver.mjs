// ═══════════════════════════════════════════════════════════════════════════════
// SAA ROBOT MODE — Slice 1 driver (terminal-run, headed, PRODUCTION).
//
// Fills all N seats of a live SAA auction with bots that PLAY THROUGH THE UI. Each
// seat is a real headed Chromium window Elena can watch. Per seat the driver:
//   1. mints a token + drives login→KC→prep→attendance→ready by calling the EXISTING
//      launcher server (POST /api/student-url {mode:'ready'}) — no login/KC/prep is
//      reimplemented here; server.mjs does it exactly as a student's browser would.
//   2. opens a tiled headed Chromium window and navigates it to the ?token= game URL.
//   3. waits for the SAA bidder screen (the instructor opens the auction), then runs
//      the read → decide → ACT-VIA-UI → wait loop until the auction ends.
//
// READ PATH (deliberate): getBidderView is not exposed to page-global scope and its
// group_id lives only in React state — reading it in-page would require modifying the
// SAA production frontend, which Slice 1 must not touch. Instead we scrape the
// BidderScreen's stable data-testids (the same ones saa-bidder-playthrough.mjs reads)
// into the canonical getBidderView shape. Zero frontend changes, and it reads the very
// UI Elena is watching. decide() stays pure and is unit-tested against that shape.
//
// ACT PATH: bids/holds/drops go THROUGH THE UI — fill the bid input, click Submit
// (or Drop Out → Confirm). That is the point: it exercises the real frontend.
//
// Robots read via the DOM; they NEVER call submitBid/holdBid/dropOut directly.
//
// Usage:
//   node robot-driver.mjs --instance <gameInstanceId> [--seats 7] [--pace watch]
//                         [--launcher http://localhost:5180] [--screen 1920x1080] [--cols N]
//
// Prerequisites (Elena, once): the launcher server is running
//   (node classroom/tools/launcher/server.mjs), and from the SAA instructor dashboard
//   she has (a) generated an attendance code, then — after seats are ready —
//   (b) triggered matching and (c) opened the auction for the group.
// ═══════════════════════════════════════════════════════════════════════════════

import { createRequire } from 'node:module'
import { decide } from './dist/strategy.js'

// Resolve Playwright from the SAA harness install (games/saa/node_modules), matching
// saa-bidder-playthrough.mjs — the bot dir has no playwright of its own.
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')

// ── CLI ──────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const a = {}
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i]
    if (k.startsWith('--')) a[k.slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i]
  }
  return a
}
const args = parseArgs(process.argv.slice(2))

const INSTANCE = args.instance
const SEATS = Math.max(1, Math.min(16, Number(args.seats) || 7))
const PACE = String(args.pace || 'watch')
const LAUNCHER = String(args.launcher || 'http://localhost:5180').replace(/\/$/, '')
const [SCREEN_W, SCREEN_H] = String(args.screen || '1920x1080').split('x').map(Number)
const COLS_OVERRIDE = args.cols ? Number(args.cols) : null

if (!INSTANCE || INSTANCE === true) {
  console.error('ERROR: --instance <gameInstanceId> is required.')
  console.error('Usage: node robot-driver.mjs --instance <id> [--seats 7] [--pace watch]')
  process.exit(1)
}

// ── Pace / timing ──────────────────────────────────────────────────────────────────
// watch = randomized 5–15s think-time per action (so Elena can follow the play).
const THINK = PACE === 'watch' ? { min: 5000, max: 15000 } : { min: 400, max: 1200 }
const POLL_MS = 2000                 // matches the frontend's getBidderView poll cadence
const BIDDER_SCREEN_TIMEOUT_MS = 15 * 60 * 1000 // give Elena time to match + open the auction

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Randomized think-time. No shared RNG seed needed — the STRATEGY is deterministic;
// only human-like pacing is random, and it varies per seat/action by design.
const thinkTime = () => THINK.min + Math.floor(Math.random() * (THINK.max - THINK.min))

// ── Grid tiling (mirrors the launcher's gridFeatures math) ──────────────────────────
function gridCell(index, count) {
  const n = Math.max(1, count | 0)
  const cols = COLS_OVERRIDE ?? Math.ceil(Math.sqrt(n))
  const rows = Math.ceil(n / cols)
  const cellW = Math.floor(SCREEN_W / cols)
  const cellH = Math.floor(SCREEN_H / rows)
  const col = index % cols
  const rowN = Math.floor(index / cols)
  const GUTTER = 6
  return {
    x: col * cellW,
    y: rowN * cellH,
    w: cellW - GUTTER,
    h: cellH - GUTTER,
  }
}

// ── Launcher reuse: mint token + drive-to-ready (server.mjs, unchanged) ──────────────
async function mintReadyUrl(index) {
  const res = await fetch(`${LAUNCHER}/api/student-url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ game_instance_id: INSTANCE, index, mode: 'ready' }),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { throw new Error(`launcher /api/student-url → ${res.status}: ${text.slice(0, 200)}`) }
  if (json.error) throw new Error(json.error)
  return json // { name, url }
}

async function launcherReachable() {
  try {
    const r = await fetch(`${LAUNCHER}/api/games`)
    return r.ok
  } catch { return false }
}

// ── In-page state read: scrape BidderScreen testids → getBidderView shape ────────────
// Runs in the window's own context. Returns null when the bidder screen isn't mounted
// yet (auction not open for this seat). See header for why we scrape rather than call
// getBidderView.
async function readView(page) {
  const raw = await page.evaluate(() => {
    const q = (tid) => document.querySelector(`[data-testid="${tid}"]`)
    const txt = (tid) => q(tid)?.textContent?.trim() ?? null

    const ended = !!q('saa-terminal')
    const tablePresent = !!q('saa-license-table')
    if (!tablePresent && !ended) return null // bidder screen not up yet

    const licenses = ['A', 'B', 'C', 'D', 'E'].map((L) => {
      if (!q(`saa-row-${L}`)) return null
      const input = q(`saa-bid-input-${L}`)
      const ph = input?.getAttribute('placeholder')
      return {
        licenseId: L,
        yourValue: Number(txt(`saa-value-${L}`)),
        currentHighBid: Number(txt(`saa-high-${L}`)),
        minIncrement: Number(txt(`saa-inc-${L}`)),
        winnerText: txt(`saa-winner-${L}`),         // "You" | "Bidder N" | "—"
        // minLegalBidForYou is the input placeholder, rendered only while we can act.
        minLegalBidForYou: ph && ph !== '' ? Number(ph) : null,
      }
    }).filter(Boolean)

    return {
      ended,
      roundText: txt('saa-round'),        // "Round N" | null (absent once ended)
      bidderText: txt('saa-bidder'),      // "Bidder N"
      winningText: txt('saa-winning') ?? '',
      waiting: !!q('saa-waiting'),        // acted this round, waiting for others
      dropped: !!q('saa-watch'),          // dropped out, watching
      licenses,
    }
  })
  if (!raw) return null

  const bidderIndex = Number(String(raw.bidderText ?? '').replace(/\D/g, '')) || 0
  const isWinner = /You are winning License/.test(raw.winningText)
  const winMatch = raw.winningText.match(/License ([A-E])/)
  const winningLicense = isWinner && winMatch ? winMatch[1] : null

  const licenses = raw.licenses.map((l) => {
    const youAreWinner = l.winnerText === 'You'
    const currentWinnerIndex =
      l.winnerText == null || l.winnerText === '—' ? null
      : youAreWinner ? bidderIndex
      : Number(String(l.winnerText).replace(/\D/g, ''))
    return {
      licenseId: l.licenseId,
      yourValue: l.yourValue,
      currentHighBid: l.currentHighBid,
      currentWinnerIndex,
      youAreWinner,
      minIncrement: l.minIncrement,
      minLegalBidForYou: l.minLegalBidForYou,
    }
  })

  const currentBidOnWinningLicense =
    winningLicense ? (licenses.find((l) => l.licenseId === winningLicense)?.currentHighBid ?? null) : null

  return {
    status: raw.ended ? 'ended' : 'open',
    round: raw.roundText ? Number(raw.roundText.replace(/\D/g, '')) : 0,
    bidderIndex,
    active: !raw.dropped,
    droppedOut: raw.dropped,
    hasActedThisRound: raw.waiting,
    isWinner,
    winningLicense,
    currentBidOnWinningLicense,
    licenses,
  }
}

// ── Act THROUGH THE UI ───────────────────────────────────────────────────────────────
async function clearAllBidInputs(page) {
  for (const L of ['A', 'B', 'C', 'D', 'E']) {
    const sel = `[data-testid="saa-bid-input-${L}"]`
    if (await page.locator(sel).count()) await page.fill(sel, '').catch(() => {})
  }
}

async function performBid(page, license, amount) {
  await clearAllBidInputs(page)                                  // one-license-per-round rule
  await page.fill(`[data-testid="saa-bid-input-${license}"]`, String(amount))
  await page.click('[data-testid="saa-submit"]')
}

async function performHold(page, view) {
  // A winner holds by re-submitting the standing bid on their winning license.
  // The component pre-fills that row; we set it explicitly (to the standing high bid)
  // so an unchanged value is registered as a HOLD, then click Submit.
  const L = view.winningLicense
  const standing = view.currentBidOnWinningLicense
  await clearAllBidInputs(page)
  if (L != null && standing != null) {
    await page.fill(`[data-testid="saa-bid-input-${L}"]`, String(standing))
  }
  await page.click('[data-testid="saa-submit"]')
}

async function performDrop(page) {
  await page.click('[data-testid="saa-dropout"]')
  await page.click('[data-testid="saa-dropout-confirm-yes"]')     // confirm the permanent drop
}

async function perform(page, view, decision) {
  if (decision.action === 'bid')  return performBid(page, decision.license, decision.amount)
  if (decision.action === 'hold') return performHold(page, view)
  if (decision.action === 'drop') return performDrop(page)
}

// ── Per-seat play loop ───────────────────────────────────────────────────────────────
async function playSeat(seat) {
  const { page, label } = seat
  // Wait for the bidder screen — the instructor opens the auction from the dashboard.
  try {
    await page.waitForSelector('[data-testid="saa-license-table"], [data-testid="saa-terminal"]', {
      timeout: BIDDER_SCREEN_TIMEOUT_MS,
    })
  } catch {
    console.error(`  [${label}] bidder screen never appeared (auction not opened within timeout).`)
    return
  }
  console.log(`  [${label}] bidder screen up — playing.`)

  while (true) {
    let view
    try {
      view = await readView(page)
    } catch (e) {
      console.error(`  [${label}] read error: ${e.message} — retrying.`)
      await sleep(POLL_MS)
      continue
    }
    if (!view) { await sleep(POLL_MS); continue }              // screen not ready
    if (view.status === 'ended') {
      const won = view.winningLicense
      console.log(`  [${label}] auction ENDED${won ? ` — winning ${won}` : ' — no license'}.`)
      break
    }

    const decision = decide(view)
    if (decision === null) { await sleep(POLL_MS); continue }  // not our move → wait

    await sleep(thinkTime())                                    // watch pace

    // Re-read after the think — a round may have closed while we paused.
    let fresh
    try { fresh = await readView(page) } catch { await sleep(POLL_MS); continue }
    if (!fresh) { await sleep(POLL_MS); continue }
    if (fresh.status === 'ended') continue                      // let the top of the loop report it
    const d2 = decide(fresh)
    if (d2 === null) continue                                   // already acted / round changed

    try {
      const desc = d2.action === 'bid' ? `bid ${d2.amount} on ${d2.license}` : d2.action
      console.log(`  [${label}] round ${fresh.round}: ${desc}`)
      await perform(page, fresh, d2)
    } catch (e) {
      console.error(`  [${label}] action failed: ${e.message} — continuing.`)
    }
    await sleep(POLL_MS)                                         // let the UI settle into "waiting"
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nSAA robot mode — instance ${INSTANCE}, ${SEATS} seats, pace=${PACE}, target=PRODUCTION\n`)

  if (!(await launcherReachable())) {
    console.error(`Launcher server not reachable at ${LAUNCHER}.`)
    console.error('Start it first:  node classroom/tools/launcher/server.mjs')
    process.exit(1)
  }

  // Phase A — mint + drive each seat to waiting-to-match via the launcher (server.mjs).
  console.log('Phase A — minting tokens + driving seats to ready (login → KC → prep → attendance)…')
  const seats = []
  for (let i = 0; i < SEATS; i++) {
    try {
      const { name, url } = await mintReadyUrl(i)
      seats.push({ index: i, name, url, label: `seat ${i + 1}/${name}` })
      console.log(`  ✓ seat ${i + 1} ready — ${name}`)
    } catch (e) {
      console.error(`  ✗ seat ${i + 1} drive-to-ready failed: ${e.message}`)
    }
  }
  if (!seats.length) {
    console.error('\nNo seats reached ready. (Has the instructor generated an attendance code?) Aborting.')
    process.exit(1)
  }

  // Phase B — open a tiled headed window per seat and navigate it to its game URL.
  console.log('\nPhase B — opening headed windows…')
  for (const seat of seats) {
    try {
      const cell = gridCell(seat.index, seats.length)
      const browser = await chromium.launch({
        headless: false,
        args: [`--window-position=${cell.x},${cell.y}`, `--window-size=${cell.w},${cell.h}`],
      })
      const context = await browser.newContext({ viewport: null }) // let the OS window drive the size
      const page = await context.newPage()
      await page.goto(seat.url, { waitUntil: 'domcontentloaded' })
      seat.browser = browser
      seat.page = page
      console.log(`  ✓ window open — ${seat.name}`)
    } catch (e) {
      console.error(`  ✗ window for ${seat.name} failed: ${e.message}`)
    }
  }

  const live = seats.filter((s) => s.page)
  if (!live.length) { console.error('\nNo windows opened. Aborting.'); process.exit(1) }

  console.log(`\n${live.length} windows are on the waiting-to-match screen.`)
  console.log('From the SAA instructor dashboard now:  (1) Trigger matching   (2) Open the auction for the group.')
  console.log('Bots start bidding automatically the moment the bidder screen appears.\n')

  // Phase C — play every live seat concurrently. One dead seat must not hang the run,
  // so each loop is isolated with allSettled.
  await Promise.allSettled(live.map((seat) => playSeat(seat)))

  console.log('\nAll seats finished. Windows are left OPEN on their final screens. Press Ctrl-C to exit.')
  await new Promise(() => {}) // keep the process (and windows) alive until Elena quits
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
