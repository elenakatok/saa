// ═══════════════════════════════════════════════════════════════════════════════
// SAA Phase 2 — Slice 4 harness: drives the REAL bidder screen (browser) for one
// caller (p1) while the other 6 bidders act via the callable path. Proves the §12
// UI: table render, legal/illegal bid, one-bid enforcement, winner pre-fill/hold/
// raise, drop-out-blocked-for-winner, watch mode, terminal outcome.
//
// RUN (from games/saa): with the emulator up on :5005 (project saa-mygames-live)
// and the frontend vite dev server up on :5173 —   node saa-bidder-playthrough.mjs
// (HEADED=1 to watch).
// ═══════════════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright'

const PROJECT = 'saa-mygames-live'
const FUNCTIONS = `http://localhost:5005/${PROJECT}/us-central1`
const FE = 'http://localhost:5173'
const P = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']

async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
  let body = null; try { body = await res.json() } catch { /* */ }
  if (res.ok && body && 'result' in body) return { ok: true, result: body.result }
  return { ok: false, error: body?.error?.message ?? `http ${res.status}` }
}
async function seedGroup(gid) {
  await fetch(`${FUNCTIONS}/seedGroupForTest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game_instance_id: gid, group_id: 'g', lead_id: 'p1', bidder_participants: P }) })
}
const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })
const asDev = (gid, extra = {}) => ({ _dev: { game_instance_id: gid }, ...extra })
const open = (gid) => callFn('openAuction', asDev(gid, { group_id: 'g' }))
const bidAs = (gid, pid, lic, amt) => callFn('submitBid', asStudent(gid, pid, { group_id: 'g', license_id: lic, amount: amt }))
const holdAs = (gid, pid) => callFn('holdBid', asStudent(gid, pid, { group_id: 'g' }))
const dropAs = (gid, pid) => callFn('dropOut', asStudent(gid, pid, { group_id: 'g' }))

const studentUrl = (gid, pid) => `${FE}/?_pid=${pid}&_gid=${gid}&_session=tab`

let passed = 0, failed = 0
const log = []
function check(cond, label) { if (cond) { passed++; log.push(`  ✓ ${label}`) } else { failed++; log.push(`  ✗ FAIL: ${label}`) } }
function section(t) { log.push(`\n${t}`) }
const txt = async (page, tid) => (await page.textContent(`[data-testid="${tid}"]`).catch(() => null))?.trim() ?? null
const seen = (page, tid) => page.locator(`[data-testid="${tid}"]`).count().then((n) => n > 0)
const waitRound = (page, n) => page.waitForFunction((r) => document.querySelector('[data-testid="saa-round"]')?.textContent === `Round ${r}`, n, { timeout: 15000 })

async function gotoBidder(ctx, gid, pid) {
  const page = await ctx.newPage()
  await page.goto(studentUrl(gid, pid))
  await page.waitForSelector('[data-testid="saa-license-table"]', { timeout: 25000 })
  return page
}

async function main() {
  const browser = await chromium.launch({ headless: !process.env.HEADED })
  const ctx = await browser.newContext()

  // warmup — pay vite/functions cold start
  { const g = 'ui-warm'; await seedGroup(g); await open(g); const w = await gotoBidder(ctx, g, 'p1'); await w.close() }

  // ── Scenario α: non-winner p1 — assertions 1,2,3,4,6 ──────────────────────────
  section('α non-winner p1 — table render, one-bid, illegal reject, legal bid, watch mode')
  {
    const gid = 'ui-alpha'; await seedGroup(gid); await open(gid)
    const page = await gotoBidder(ctx, gid, 'p1')

    // (1) table renders: own values, per-license increment, revealed winners
    check(await txt(page, 'saa-bidder') === 'Bidder 1', '(1) status shows "Bidder 1"')
    check(await txt(page, 'saa-value-A') === '600' && await txt(page, 'saa-value-D') === '356', '(1) own value column rendered (A=600, D=356)')
    check(await txt(page, 'saa-high-A') === '200', '(1) current high bid A = 200 (reserve)')
    check(await txt(page, 'saa-inc-A') === '100', '(1) per-license min increment A = 100 (band 200–299)')
    check(await txt(page, 'saa-winner-A') === '—', '(1) round-1 no current winner on A')
    check(await page.locator('[data-testid^="saa-row-"]').count() === 5, '(1) all five license rows present')
    check(await txt(page, 'saa-active') === '7', '(rev-2) active-bidder count shows 7 (server-sourced)')
    check((await txt(page, 'saa-submit'))?.trim() === 'Submit', '(rev-1) submit button label is just "Submit"')
    check((await txt(page, 'saa-dropout'))?.trim() === 'Drop Out', '(rev-1) drop-out button label is just "Drop Out"')

    // (4) one-bid enforcement: selecting A disables the other rows' inputs
    await page.fill('[data-testid="saa-bid-input-A"]', '300')
    check(await page.isDisabled('[data-testid="saa-bid-input-B"]'), '(4) selecting license A disables the B bid field (one bid/round)')

    // (3) illegal bid below the minimum → server rejection inline
    await page.fill('[data-testid="saa-bid-input-A"]', '150')
    await page.click('[data-testid="saa-submit"]')
    await page.waitForSelector('[data-testid="saa-error"]', { timeout: 8000 })
    const err = await txt(page, 'saa-error')
    check(/at least 200/i.test(err ?? ''), `(3) illegal 150 bid → inline server reason ("${err}")`)

    // (2) legal bid accepted → waiting → round advances after others act
    await page.fill('[data-testid="saa-bid-input-A"]', '200')
    await page.click('[data-testid="saa-submit"]')
    await page.waitForSelector('[data-testid="saa-waiting"]', { timeout: 8000 })
    check(await seen(page, 'saa-waiting'), '(2) legal bid accepted → "waiting for other bidders" state')
    // other 6 act (p6 out-bids A@300 so p1 becomes a non-winner)
    await bidAs(gid, 'p6', 'A', 300); await bidAs(gid, 'p2', 'B', 200); await bidAs(gid, 'p3', 'C', 200)
    await bidAs(gid, 'p4', 'D', 200); await bidAs(gid, 'p5', 'E', 200); await bidAs(gid, 'p7', 'C', 300)
    await waitRound(page, 2)
    check(await txt(page, 'saa-round') === 'Round 2', '(2) table refreshes to round 2 after the round closes')
    check(await txt(page, 'saa-winner-A') === 'Bidder 6', '(2) A now won by Bidder 6 (revealed); p1 lost it')
    check((await txt(page, 'saa-winning'))?.includes('not winning'), '(2) status: p1 is now winning nothing')

    // (rev-3) drop-out is guarded by a permanence confirmation; Cancel keeps you in
    await page.click('[data-testid="saa-dropout"]')
    await page.waitForSelector('[data-testid="saa-dropout-confirm"]', { timeout: 8000 })
    check(await seen(page, 'saa-dropout-confirm'), '(rev-3) Drop Out shows a permanence confirmation dialog')
    await page.click('[data-testid="saa-dropout-confirm-no"]')
    check(!(await seen(page, 'saa-dropout-confirm')) && await seen(page, 'saa-submit'), '(rev-3) Cancel returns to the bidder controls (still in)')
    // (6) Confirm actually drops → watch mode (no buttons), still sees the table
    await page.click('[data-testid="saa-dropout"]')
    await page.waitForSelector('[data-testid="saa-dropout-confirm"]', { timeout: 8000 })
    await page.click('[data-testid="saa-dropout-confirm-yes"]')
    await page.waitForSelector('[data-testid="saa-watch"]', { timeout: 8000 })
    check(await seen(page, 'saa-watch'), '(6) Confirm → drop-out → watch mode')
    check(!(await seen(page, 'saa-submit')) && !(await seen(page, 'saa-dropout')), '(6) watch mode has NO action buttons')
    check(await seen(page, 'saa-license-table'), '(6) watcher still sees the license table')
    await page.close()
  }

  // ── Scenario β: p1 becomes a WINNER — assertion 5 ─────────────────────────────
  section('β winner p1 — pre-fill, drop-out blocked, raise')
  {
    const gid = 'ui-beta'; await seedGroup(gid); await open(gid)
    const page = await gotoBidder(ctx, gid, 'p1')
    // round 1: p1 takes A@200 uncontested; others bid elsewhere
    await page.fill('[data-testid="saa-bid-input-A"]', '200'); await page.click('[data-testid="saa-submit"]')
    await page.waitForSelector('[data-testid="saa-waiting"]', { timeout: 8000 })
    await bidAs(gid, 'p2', 'B', 200); await bidAs(gid, 'p3', 'C', 200); await bidAs(gid, 'p4', 'D', 200)
    await bidAs(gid, 'p5', 'E', 200); await bidAs(gid, 'p6', 'B', 300); await bidAs(gid, 'p7', 'C', 300)
    await waitRound(page, 2)
    check((await txt(page, 'saa-winning'))?.includes('License A'), '(5) round 2: p1 is winning License A')
    // (5) winner's own row pre-filled with their standing bid (200)
    check(await page.inputValue('[data-testid="saa-bid-input-A"]') === '200', '(5) winner row A pre-filled with current standing bid (200)')
    // (5) drop-out blocked for a winner
    check(await page.isDisabled('[data-testid="saa-dropout"]'), '(5) Drop Out is disabled for the winner (bids binding)')
    check(await seen(page, 'saa-dropout-blocked'), '(5) winner sees the "cannot drop out" note')
    // (5) raise: edit up to 250 → accepted → next round A = You @250
    await page.fill('[data-testid="saa-bid-input-A"]', '250'); await page.click('[data-testid="saa-submit"]')
    await page.waitForSelector('[data-testid="saa-waiting"]', { timeout: 8000 })
    await holdAs(gid, 'p6'); await holdAs(gid, 'p7'); await holdAs(gid, 'p4'); await holdAs(gid, 'p5')
    await bidAs(gid, 'p2', 'D', 300); await bidAs(gid, 'p3', 'E', 300) // p2,p3 stay in (take D/E)
    await waitRound(page, 3)
    check(await txt(page, 'saa-winner-A') === 'You' && await txt(page, 'saa-high-A') === '250', '(5) self-raise applied — A now You @250')
    await page.close()
  }

  // ── Scenario γ: run to termination via UI — assertion 7 ───────────────────────
  section('γ termination — p1 sees the terminal outcome')
  {
    const gid = 'ui-gamma'; await seedGroup(gid); await open(gid)
    const page = await gotoBidder(ctx, gid, 'p1')
    // round 1: p1 wins A@200 uncontested; B/C contested; D/E taken → winners {1,6,7,4,5}, non-winners {2,3}
    await page.fill('[data-testid="saa-bid-input-A"]', '200'); await page.click('[data-testid="saa-submit"]')
    await page.waitForSelector('[data-testid="saa-waiting"]', { timeout: 8000 })
    await bidAs(gid, 'p2', 'B', 200); await bidAs(gid, 'p6', 'B', 300); await bidAs(gid, 'p3', 'C', 200)
    await bidAs(gid, 'p7', 'C', 300); await bidAs(gid, 'p4', 'D', 200); await bidAs(gid, 'p5', 'E', 200)
    await waitRound(page, 2)
    // round 2: p1 holds A (submit-as-is), other winners hold, the 2 non-winners drop → terminate
    check(await page.inputValue('[data-testid="saa-bid-input-A"]') === '200', 'γ winner A pre-filled 200 for hold')
    await page.click('[data-testid="saa-submit"]') // submit-as-is → hold
    await page.waitForSelector('[data-testid="saa-waiting"]', { timeout: 8000 })
    await holdAs(gid, 'p6'); await holdAs(gid, 'p7'); await holdAs(gid, 'p4'); await holdAs(gid, 'p5')
    await dropAs(gid, 'p2'); await dropAs(gid, 'p3') // 2 drops → end
    await page.waitForSelector('[data-testid="saa-terminal"]', { timeout: 15000 })
    check(await seen(page, 'saa-terminal'), '(7) auction ran to termination — terminal panel shown on the UI')
    const you = await txt(page, 'saa-terminal-you')
    check(/License A/.test(you ?? '') && /400/.test(you ?? ''), `(7) caller's terminal outcome: won A, profit 400 ("${you}")`)
    await page.close()
  }

  await browser.close()
  console.log(log.join('\n'))
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2) })
