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
import { createServer } from 'http'

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
    check(await page.isDisabled('[data-testid="saa-dropout"]'), '(5) Drop Out is disabled for the winner (bids binding) — no note (rev)')
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

  // ── (D) instructor: eBay-style start box on the dashboard + /live watch + force-out
  section('(D) instructor — dashboard start box, /live watch, privacy, force-out')
  {
    const gid = 'ui-dash'; await seedGroup(gid) // matched, NOT opened
    const iview = async () => (await callFn('getInstructorAuctionView', asDev(gid, {}))).result

    // (rev2) MAIN dashboard: eBay-style start box above the roster, per-group Start Auction
    const dash = await ctx.newPage()
    await dash.goto(`${FE}/dashboard?_dev_game_instance_id=${gid}&_session=tab`)
    await dash.waitForSelector('[data-testid="saa-auction-controls"]', { timeout: 25000 })
    check(await seen(dash, 'saa-live-nav'), '(D-rev2) main dashboard shows the "Live auctions" nav link')
    await dash.waitForSelector('[data-testid="saa-start-auction-g"]', { timeout: 12000 })
    check(await seen(dash, 'saa-start-auction-g'), '(D-rev2) start box shows a per-group Start Auction button')
    check(!(await seen(dash, 'saa-dash-group-g')), '(D-rev2) the full auction panel is NOT on the main dashboard')
    // start the auction FROM THE DASHBOARD box
    await dash.click('[data-testid="saa-start-auction-g"]')
    await dash.waitForSelector('[data-testid="saa-start-status-g"]', { timeout: 12000 })
    check(/open/i.test((await txt(dash, 'saa-start-status-g')) ?? ''), '(D-rev2) group shows "Auction open" after Start')
    check(!(await seen(dash, 'saa-start-auction-g')), '(D-rev2) started group no longer shows a Start button (no duplicate)')
    await dash.close()

    // p1 (Ada) submits a DISTINCTIVE 777; round stays open.
    await bidAs(gid, 'p1', 'A', 777)
    const v = await iview()
    check(!JSON.stringify(v).includes('777'), '(D-privacy) pending amount (777) is NOT in the instructor view')
    const b1 = v.groups[0].bidders.find((x) => x.bidderIndex === 1)
    check(b1.hasActed === true && b1.amount === undefined && b1.licenseId === undefined, '(D-privacy) hasActed bool, no amount/license')

    // /live WATCH view — watch-only, NO start button
    const live = await ctx.newPage()
    await live.goto(`${FE}/live?_dev_game_instance_id=${gid}&_session=tab`)
    await live.waitForSelector('[data-testid="saa-dash-group-g"]', { timeout: 25000 })
    check(!(await seen(live, 'saa-start-auction-g')), '(D-rev2) /live is watch-only — no Start Auction button')
    check(await txt(live, 'saa-dash-round') === 'Round 1', '(D) /live shows Round 1')
    check(await txt(live, 'saa-dash-active') === '7', '(D) /live active-bidder count 7')
    await live.waitForTimeout(2500)
    const body = await live.evaluate(() => document.querySelector('[data-testid="saa-live-dashboard"]').innerText)
    check(body.includes('Ada Lovelace') && body.includes('Grace Kim'), '(D) real student names shown')
    check(!body.includes('777'), '(D-privacy) Live Dashboard UI does not render the pending amount')
    check(await txt(live, 'saa-dash-acted-1') === 'acted this round', '(D) acted bidder shows "acted this round"')
    check(await txt(live, 'saa-dash-acted-7') === 'still deciding', '(D) non-acted bidder shows "still deciding"')
    check(await seen(live, 'saa-dash-forceout-7'), '(D) Force Out present for a non-winner')

    // finish round 1 except p7 (non-responsive) → force out via the Live Dashboard
    await bidAs(gid, 'p2', 'B', 200); await bidAs(gid, 'p3', 'C', 200); await bidAs(gid, 'p4', 'D', 200)
    await bidAs(gid, 'p5', 'E', 200); await bidAs(gid, 'p6', 'A', 300)
    await live.waitForTimeout(2500)
    await live.click('[data-testid="saa-dash-forceout-7"]')
    await live.waitForSelector('[data-testid="saa-dash-forceout-confirm"]', { timeout: 8000 })
    check((await txt(live, 'saa-dash-forceout-confirm'))?.includes('Grace Kim'), '(D) force-out confirm names the bidder')
    await live.click('[data-testid="saa-dash-forceout-yes"]')
    await live.waitForFunction(() => document.querySelector('[data-testid="saa-dash-active"]')?.textContent === '6', null, { timeout: 12000 })
    check(await txt(live, 'saa-dash-active') === '6', '(D) force-out unblocked the round → active count 7→6')
    check(await txt(live, 'saa-dash-round') === 'Round 2', '(D) round advanced after the stuck round closed')
    check(await txt(live, 'saa-dash-acted-7') === 'dropped out', '(D) forced bidder now shows dropped out')
    check(!(await seen(live, 'saa-dash-forceout-1')), '(D) no Force Out for a winner (Ada now holds A)')
    check((await live.evaluate(() => document.querySelector('[data-testid="saa-dash-standing-A"]').innerText)).includes('Ada Lovelace'), '(D) standing A resolved to winner Ada Lovelace')
    await live.close()
  }

  // ── (E) grading + reports + dashboard profit — Slice 6 ────────────────────────
  section('(E) Slice 6 — participation grading, reports, dashboard profit')
  {
    const gid = 'ui-s6'; await seedGroup(gid); await open(gid)
    // full auction to termination: winners F(A@300) B(B@200) G(C@300) D(D@200) E(E@200);
    // Ada(1) & Chen(3) drop in round 2. (p1=Ada..p7=Grace.)
    await bidAs(gid, 'p1', 'A', 200); await bidAs(gid, 'p2', 'B', 200); await bidAs(gid, 'p3', 'C', 200)
    await bidAs(gid, 'p4', 'D', 200); await bidAs(gid, 'p5', 'E', 200); await bidAs(gid, 'p6', 'A', 300); await bidAs(gid, 'p7', 'C', 300)
    await holdAs(gid, 'p6'); await holdAs(gid, 'p2'); await holdAs(gid, 'p7'); await holdAs(gid, 'p4'); await holdAs(gid, 'p5')
    await dropAs(gid, 'p1'); await dropAs(gid, 'p3') // 2 drops → END

    // reports: revenue = sum standing prices; profit = sum winner surpluses
    const rep = (await callFn('getAuctionReport', asDev(gid, {}))).result
    const g0 = rep.groups[0]
    check(g0.status === 'ended' && g0.rounds === 2, '(E) auction report: 2 rounds, ended')
    check(g0.revenueSeries[0].revenue === 1200, `(E) revenue round 1 = Σ standing prices = 1200 (got ${g0.revenueSeries[0].revenue})`)
    check(g0.profitSeries[0].profit === 1345, `(E) profit round 1 = Σ winner surpluses = 1345 (got ${g0.profitSeries[0].profit})`)
    const farah = rep.bidders.find((b) => b.name === 'Farah Aziz')
    check(farah.totalProfit === 199 && farah.wonLicense === 'A', '(E) Farah won A, profit value(A,6)=499−300=199')
    const ada = rep.bidders.find((b) => b.name === 'Ada Lovelace')
    check(ada.totalProfit === 0 && ada.droppedOutAtRound === 2, '(E) Ada dropped @ round 2, profit 0')
    check(ada.roundsBid === 1, '(E) Ada rounds_bid = 1')

    // add a never-attended participant (no role) → must score −2
    const FS = `http://localhost:8082/v1/projects/saa-mygames-live/databases/(default)/documents`
    await fetch(`${FS}/game_instances/${gid}/participants/noshow1`, {
      method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { participant_id: { stringValue: 'noshow1' }, game_instance_id: { stringValue: gid }, display_name: { stringValue: 'Never Attended' } } }),
    })

    // participation push via a mock classroom callback (POST + 200)
    const received = []
    const mock = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => { try { received.push(JSON.parse(body)) } catch { /* */ } ; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}') })
    })
    await new Promise((r) => mock.listen(0, r))
    const mockPort = mock.address().port
    const scored = (await callFn('scoreAndRecord', { _dev: { game_instance_id: gid, callback_url: `http://localhost:${mockPort}`, callback_secret: 'test' } })).result
    check(scored?.ok === true, '(E) scoreAndRecord succeeded')
    check(scored.push?.succeeded >= 8 && scored.push?.failed?.length === 0, `(E) push: POST+200 for all results (${scored.push?.succeeded} ok, ${scored.push?.failed?.length} failed)`)
    mock.close()

    const byPid = new Map(received.map((r) => [r.participant_id, r]))
    // present bidders (incl. dropped) → completed + normalized 0 (degenerate pool); dropped ≠ no_show
    const adaR = byPid.get('p1'), farahR = byPid.get('p6'), noshowR = byPid.get('noshow1')
    check(farahR?.status === 'completed' && farahR?.normalized_score === 0, '(E) present bidder → completed, normalized 0')
    check(adaR?.status === 'completed' && adaR?.normalized_score === 0, '(E) a DROPPED-OUT bidder scores the participation point (completed, NOT no_show)')
    check(noshowR?.status === 'no_show' && noshowR?.normalized_score === -2, '(E) never-attended student → no_show, −2')
    // gradebook metadata rides in the details blob (NOT a score)
    check(farahR?.details?.rounds_bid === 1 && farahR?.details?.total_profit === 199, '(E) details blob carries rounds_bid + total_profit (metadata)')
    check(adaR?.details?.dropped_out_at_round === 2, '(E) details blob carries dropped_out_at_round')

    // per-group STATISTICS table (rev): revenue/profit/total/efficiency + A–E winner NUMBERS
    check(g0.finalRevenue === 1200, `(rev) stats revenue = Σ final winning prices = 1200 (got ${g0.finalRevenue})`)
    check(g0.finalProfit === 1345, '(rev) stats profit = Σ winner surpluses = 1345')
    check(g0.totalSurplus === 2545, '(rev) stats total surplus = revenue + profit = 2545')
    check(JSON.stringify(g0.winnersByLicense) === JSON.stringify({ A: 6, B: 2, C: 7, D: 4, E: 5 }), '(rev) A–E show winning bidder NUMBERS (A6 B2 C7 D4 E5)')
    check(rep.efficientMax === 3119, '(rev) default efficient max = 3119')
    check(g0.efficiency.toFixed(2) === '81.60', `(rev) efficiency @ default 3119 = 2545/3119×100 = 81.60 (got ${g0.efficiency.toFixed(2)})`)
    // the instructor setting feeds the denominator
    await callFn('updateGameConfig', asDev(gid, { efficient_max: 2545 }))
    const rep2 = (await callFn('getAuctionReport', asDev(gid, {}))).result
    check(rep2.efficientMax === 2545, '(rev) instructor-set efficient max (2545) is read back')
    check(rep2.groups[0].efficiency.toFixed(2) === '100.00', '(rev) efficiency @ 2545 = 100.00 — the setting feeds the denominator')

    // dashboard Outcome column shows PROFIT (browser)
    const dash = await ctx.newPage()
    await dash.goto(`${FE}/dashboard?_dev_game_instance_id=${gid}&_session=tab`)
    await dash.waitForSelector('[data-testid="roster-table"] table', { timeout: 25000 })
    await dash.waitForFunction(() => (document.querySelector('[data-testid="roster-table"]')?.textContent ?? '').includes('$199'), null, { timeout: 12000 })
    const roster = await dash.evaluate(() => document.querySelector('[data-testid="roster-table"]').textContent)
    check(roster.includes('$199'), '(E) dashboard Outcome column shows PROFIT ($199 for Farah)')
    check(roster.includes('Profit'), '(E) dashboard Outcome header relabeled to "Profit"')
    await dash.close()
  }

  await browser.close()
  console.log(log.join('\n'))
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2) })
