// ═══════════════════════════════════════════════════════════════════════════════
// SAA student-path GUARD harness.
//
// Two invariants, asserted against the REAL student page in a browser:
//
//   1. NO NEGOTIATION SCAFFOLD. The student path goes prep → auction room →
//      bidder screen → terminal result. None of the removed screens may ever
//      appear: group roster ("Your negotiation group"), "Start negotiation",
//      "Go negotiate", "We've finished — report our outcome", "Waiting for the
//      outcome", the lead placeholder form ("Record placeholder result"), the
//      confirm/reject outcome review, or the deadlock screen.
//
//   2. NO OTHER-BIDDER NAMES. SAA identifies bidders ONLY by bidder NUMBER. No
//      student-facing screen and no student-authed payload may carry a display
//      name. seedGroupForTest seeds known TEST_NAMES — none may appear in the
//      student DOM, and getBidderView's JSON must not contain any of them.
//
// RUN (from games/saa): emulator on :5005 (project saa-mygames-live) + vite on
// :5173 —   node saa-student-path-guard.mjs      (HEADED=1 to watch)
// ═══════════════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright'

const PROJECT = 'saa-mygames-live'
const FUNCTIONS = `http://localhost:5005/${PROJECT}/us-central1`
const FE = 'http://localhost:5173'
const P = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']

// Must mirror TEST_NAMES in functions/src/seedFunctions.ts.
const TEST_NAMES = ['Ada Lovelace', 'Ben Carter', 'Chen Wei', 'Diego Ramos', 'Emma Novak', 'Farah Aziz', 'Grace Kim']

// Every screen the negotiation scaffold used to render, by its user-visible text.
const BANNED_SCAFFOLD = [
  'Your negotiation group',
  'Start negotiation',
  'Go negotiate',
  "We've finished",
  'We’ve finished',
  'report our outcome',
  'Waiting for the outcome',
  'Record placeholder result',
  'Placeholder result',
  'Your lead reported',
  'Does this match your group',
  'Waiting for your group',
  'Instructor intervention needed',
  'No deal',
  'Outcome locked',
]

async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
  let body = null; try { body = await res.json() } catch { /* */ }
  if (res.ok && body && 'result' in body) return { ok: true, result: body.result }
  return { ok: false, error: body?.error?.message ?? `http ${res.status}` }
}
const seedGroup = (gid) =>
  fetch(`${FUNCTIONS}/seedGroupForTest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game_instance_id: gid, group_id: 'g', lead_id: 'p1', bidder_participants: P }) })
const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })
const asDev = (gid, extra = {}) => ({ _dev: { game_instance_id: gid }, ...extra })
const open = (gid) => callFn('openAuction', asDev(gid, { group_id: 'g' }))
const bidAs = (gid, pid, lic, amt) => callFn('submitBid', asStudent(gid, pid, { group_id: 'g', license_id: lic, amount: amt }))
const dropAs = (gid, pid) => callFn('dropOut', asStudent(gid, pid, { group_id: 'g' }))
const studentUrl = (gid, pid) => `${FE}/?_pid=${pid}&_gid=${gid}&_session=tab`

let passed = 0, failed = 0
const log = []
function check(cond, label) { if (cond) { passed++; log.push(`  ✓ ${label}`) } else { failed++; log.push(`  ✗ FAIL: ${label}`) } }
function section(t) { log.push(`\n${t}`) }

/** Assert the page's full rendered text carries no banned scaffold copy and no names. */
async function assertClean(page, where) {
  const body = (await page.textContent('body')) ?? ''
  const hitScaffold = BANNED_SCAFFOLD.filter(s => body.includes(s))
  check(hitScaffold.length === 0, `[${where}] no negotiation-scaffold copy${hitScaffold.length ? ` — found ${JSON.stringify(hitScaffold)}` : ''}`)
  const hitNames = TEST_NAMES.filter(n => body.includes(n))
  check(hitNames.length === 0, `[${where}] no other-bidder names${hitNames.length ? ` — found ${JSON.stringify(hitNames)}` : ''}`)
  // Also catch a first-name-only or last-name-only leak.
  const parts = TEST_NAMES.flatMap(n => n.split(' '))
  const hitParts = parts.filter(n => new RegExp(`\\b${n}\\b`).test(body))
  check(hitParts.length === 0, `[${where}] no name fragments${hitParts.length ? ` — found ${JSON.stringify(hitParts)}` : ''}`)
}

async function main() {
  const browser = await chromium.launch({ headless: !process.env.HEADED })
  const ctx = await browser.newContext()

  // ── 1. Matched, auction NOT yet open → the auction room, not a group reveal ───
  section('1 pre-open: matched students land in the auction room (no group reveal)')
  {
    const gid = 'guard-room'; await seedGroup(gid)
    const page = await ctx.newPage()
    await page.goto(studentUrl(gid, 'p1'))
    await page.waitForSelector('[data-testid="auction-room"]', { timeout: 25000 })
    check(true, 'matched + auction closed → auction-room screen renders')
    check(!(await page.locator('button', { hasText: /negotiat/i }).count()), 'no "Start negotiation" button anywhere')
    await assertClean(page, 'auction-room')
    await page.close()
  }

  // ── 2. Auction open → bidder screen; bidders shown by NUMBER only ─────────────
  section('2 open: bidder screen identifies bidders by NUMBER only')
  {
    const gid = 'guard-open'; await seedGroup(gid); await open(gid)
    const page = await ctx.newPage()
    await page.goto(studentUrl(gid, 'p1'))
    await page.waitForSelector('[data-testid="saa-license-table"]', { timeout: 25000 })
    await assertClean(page, 'bidder-screen round 1')

    // Round 1 acts → round 2, so a revealed winner is on screen.
    await bidAs(gid, 'p1', 'A', 200); await bidAs(gid, 'p6', 'A', 300); await bidAs(gid, 'p2', 'B', 200)
    await bidAs(gid, 'p3', 'C', 200); await bidAs(gid, 'p4', 'D', 200); await bidAs(gid, 'p5', 'E', 200)
    await bidAs(gid, 'p7', 'C', 300)
    await page.waitForFunction(() => document.querySelector('[data-testid="saa-round"]')?.textContent === 'Round 2', null, { timeout: 15000 })
    const winnerA = (await page.textContent('[data-testid="saa-winner-A"]'))?.trim()
    check(/^Bidder \d+$/.test(winnerA ?? ''), `revealed winner rendered as a bidder NUMBER ("${winnerA}")`)
    await assertClean(page, 'bidder-screen round 2 (winner revealed)')

    // getBidderView payload itself must be name-free (server-side, not just the UI).
    const view = await callFn('getBidderView', asStudent(gid, 'p1', { group_id: 'g' }))
    const raw = JSON.stringify(view.result ?? {})
    const leaked = TEST_NAMES.flatMap(n => n.split(' ')).filter(n => raw.includes(n))
    check(view.ok && leaked.length === 0, `getBidderView payload carries no names${leaked.length ? ` — found ${JSON.stringify(leaked)}` : ''}`)
    check(view.ok && typeof view.result.bidderIndex === 'number', 'getBidderView identifies the caller by bidderIndex')
    await page.close()
  }

  // ── 3. Auction end → terminal result on the bidder screen, no outcome report ──
  section('3 ended: terminal result renders in place — no lead form, no confirm step')
  {
    const gid = 'guard-end'; await seedGroup(gid); await open(gid)
    const page = await ctx.newPage()
    await page.goto(studentUrl(gid, 'p1'))
    await page.waitForSelector('[data-testid="saa-license-table"]', { timeout: 25000 })

    // Drive to the end: two drop-outs terminate the auction (7 → 5 bidders).
    await bidAs(gid, 'p1', 'A', 200); await bidAs(gid, 'p2', 'B', 200); await bidAs(gid, 'p3', 'C', 200)
    await bidAs(gid, 'p4', 'D', 200); await bidAs(gid, 'p5', 'E', 200)
    await dropAs(gid, 'p6'); await dropAs(gid, 'p7')
    await page.waitForSelector('[data-testid="saa-terminal"]', { timeout: 20000 })
    check(true, 'auction end → terminal result screen (no outcome-reporting hand-off)')
    await assertClean(page, 'terminal')

    // A reload after the auction has ended must NOT route into a results/report screen.
    await page.reload()
    await page.waitForSelector('[data-testid="saa-terminal"]', { timeout: 25000 })
    check(true, 'reload after end stays on the terminal auction screen')
    await assertClean(page, 'terminal after reload')
    await page.close()
  }

  await browser.close()
  console.log(log.join('\n'))
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
}

main().catch(err => { console.error(err); process.exit(1) })
