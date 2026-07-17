// ═══════════════════════════════════════════════════════════════════════════════
// SAA Phase 2 — Slice 3 harness: drives the round-loop CALLABLES against the
// emulator (not a browser, not unit tests). Proves the state machine + seams:
// validate-before-resolve, binding winner, count-based close, cumulative
// termination (incl. two-in-one-round + spanning), force-out, carry-over.
//
// RUN (from games/saa, with the emulator already up on :5005 for project
// saa-mygames-live):   node saa-round-loop.mjs
// ═══════════════════════════════════════════════════════════════════════════════

const PROJECT = 'saa-mygames-live'
const FUNCTIONS = `http://localhost:5005/${PROJECT}/us-central1`
const P = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'] // pid pN → bidderIndex N

async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  let body = null
  try { body = await res.json() } catch { /* */ }
  if (res.ok && body && 'result' in body) return { ok: true, result: body.result }
  return { ok: false, error: body?.error?.message ?? `http ${res.status}`, status: body?.error?.status }
}

async function seedGroup(gid) {
  const res = await fetch(`${FUNCTIONS}/seedGroupForTest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ game_instance_id: gid, group_id: 'g', lead_id: 'p1', bidder_participants: P }),
  })
  return res.ok
}

const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })
const asDev = (gid, extra = {}) => ({ _dev: { game_instance_id: gid }, ...extra })

const bidAs = (gid, pid, lic, amt) => callFn('submitBid', asStudent(gid, pid, { group_id: 'g', license_id: lic, amount: amt }))
const holdAs = (gid, pid) => callFn('holdBid', asStudent(gid, pid, { group_id: 'g' }))
const dropAs = (gid, pid) => callFn('dropOut', asStudent(gid, pid, { group_id: 'g' }))
const forceIdx = (gid, idx) => callFn('forceOut', asDev(gid, { group_id: 'g', bidder_index: idx }))
const state = async (gid) => (await callFn('getAuctionState', asDev(gid, { group_id: 'g' }))).result

async function setup(gid) {
  await seedGroup(gid)
  const o = await callFn('openAuction', asDev(gid, { group_id: 'g' }))
  return o.ok && o.result?.ok
}

// value-informed round-1 bids: 5 bidders take distinct licenses @200, p6/p7 contest A/C.
// After R1: A→idx6@300, B→idx2@200, C→idx7@300, D→idx4@200, E→idx5@200. Non-winners: idx1,idx3.
async function playRound1(gid) {
  await bidAs(gid, 'p1', 'A', 200)
  await bidAs(gid, 'p2', 'B', 200)
  await bidAs(gid, 'p3', 'C', 200)
  await bidAs(gid, 'p4', 'D', 200)
  await bidAs(gid, 'p5', 'E', 200)
  await bidAs(gid, 'p6', 'A', 300)
  await bidAs(gid, 'p7', 'C', 300) // last action → round 1 closes
}

// ── assertion framework ─────────────────────────────────────────────────────────
let passed = 0, failed = 0
const results = []
function check(cond, label) {
  if (cond) { passed++; results.push(`  ✓ ${label}`) }
  else { failed++; results.push(`  ✗ FAIL: ${label}`) }
}
function section(t) { results.push(`\n${t}`) }

async function main() {
  // ── (1) + (5a) full auction to termination via two-in-one-round ───────────────
  section('(1) full 7-bidder auction to termination + (5a) two drops in one round')
  {
    const gid = 's1-full'
    check(await setup(gid), 'open with 7 bidders')
    await playRound1(gid)
    let s = await state(gid)
    check(s.state.round === 2 && s.state.status === 'open', 'round 1 closed → round 2 open')
    check(s.state.standing.A.winnerBidderIndex === 6 && s.state.standing.A.standingPrice === 300, 'A→idx6@300 (first-price, contested)')
    check(s.state.standing.B.winnerBidderIndex === 2 && s.state.standing.B.standingPrice === 200, 'B→idx2@200')
    // round 2: winners hold, the two non-winners (1,3) drop in the SAME round
    await holdAs(gid, 'p6'); await holdAs(gid, 'p2'); await holdAs(gid, 'p7'); await holdAs(gid, 'p4'); await holdAs(gid, 'p5')
    await dropAs(gid, 'p1'); await dropAs(gid, 'p3') // last action → close → cumulative 2 → end
    s = await state(gid)
    check(s.state.status === 'ended', 'auction ENDED at 2nd cumulative drop')
    check(s.state.cumulativeDropouts === 2, 'cumulative dropouts == 2 (both in one round)')
    check(s.state.activeBidders.length === 5, 'exactly 5 active remain')
    check(s.terminalBijectionOk === true, 'each of the 5 holds exactly one license (clean bijection)')
    const holders = ['A', 'B', 'C', 'D', 'E'].map((l) => s.state.standing[l].winnerBidderIndex)
    check(JSON.stringify(holders) === JSON.stringify([6, 2, 7, 4, 5]), 'terminal allocation A6 B2 C7 D4 E5 at own first-price bids')
  }

  // ── (2) validation runs before resolution ─────────────────────────────────────
  section('(2) validation before resolution — illegal bid rejected, never resolved')
  {
    const gid = 's2-val'
    await setup(gid); await playRound1(gid) // B held at 200 by idx2
    const before = await state(gid)
    const r = await bidAs(gid, 'p1', 'B', 250) // 250 on B held@200 → needs ≥300
    check(r.ok && r.result.ok === false, 'illegal 250 bid REJECTED (not thrown, returns reason)')
    check(/at least 300/.test(r.result.reason ?? ''), 'reason states the real minimum (300)')
    const after = await state(gid)
    check(after.state.standing.B.standingPrice === 200 && after.state.standing.B.winnerBidderIndex === 2, 'standing B unchanged — resolver never saw the illegal bid')
    check(after.state.actions['1'] === undefined, 'no action recorded for the rejected bidder')
    check(after.state.round === before.state.round, 'round did NOT advance on a rejected bid')
    const ok = await bidAs(gid, 'p1', 'B', 300)
    check(ok.ok && ok.result.ok === true, 'legal 300 bid on B accepted')
  }

  // ── (3) winner is bound ───────────────────────────────────────────────────────
  section('(3) provisional winner is bound — no drop-out, no force-out')
  {
    const gid = 's3-bound'
    await setup(gid); await playRound1(gid) // idx2 wins B
    const d = await dropAs(gid, 'p2') // winner tries to drop
    check(d.ok && d.result.ok === false && /cannot drop out|binding/i.test(d.result.reason ?? ''), 'winner dropOut REJECTED (bids binding)')
    const f = await forceIdx(gid, 2) // instructor tries to force out the winner
    check(f.ok === false && /cannot be forced out|bound/i.test(f.error ?? ''), 'winner forceOut REJECTED (winner is bound)')
  }

  // ── (4) round closes only when ALL active have acted ──────────────────────────
  section('(4) count-based close — no clock')
  {
    const gid = 's4-close'
    await setup(gid)
    await bidAs(gid, 'p1', 'A', 200); await bidAs(gid, 'p2', 'B', 200); await bidAs(gid, 'p3', 'C', 200)
    await bidAs(gid, 'p4', 'D', 200); await bidAs(gid, 'p5', 'E', 200); await bidAs(gid, 'p6', 'A', 300)
    let s = await state(gid)
    check(s.state.round === 1 && s.state.status === 'open', 'after 6 of 7 actions round is still OPEN (round 1)')
    check(s.state.standing.A.winnerBidderIndex === null, 'standing NOT resolved while an action is owed')
    await bidAs(gid, 'p7', 'C', 300) // the 7th and last
    s = await state(gid)
    check(s.state.round === 2, 'round closes exactly when the last active bidder acts')
    check(s.state.standing.A.winnerBidderIndex === 6, 'resolution ran on close')
  }

  // ── (5b) cumulative termination spanning rounds ───────────────────────────────
  section('(5b) cumulative termination spanning rounds (drop R2, displaced-winner drops R3)')
  {
    const gid = 's5-span'
    await setup(gid); await playRound1(gid) // winners {6,2,7,4,5}, non-winners {1,3}
    // R2: p1 drops (cum 1); p3 takes D@300 from idx4 (idx4 holds, loses D); rest hold.
    await holdAs(gid, 'p6'); await holdAs(gid, 'p2'); await holdAs(gid, 'p7'); await holdAs(gid, 'p4'); await holdAs(gid, 'p5')
    await dropAs(gid, 'p1'); await bidAs(gid, 'p3', 'D', 300)
    let s = await state(gid)
    check(s.state.status === 'open' && s.state.cumulativeDropouts === 1, 'after R2: 1 cumulative drop, still open')
    check(s.state.standing.D.winnerBidderIndex === 3 && s.state.standing.D.standingPrice === 300, 'idx3 took D@300; idx4 displaced')
    // R3: idx4 is now a non-winner and drops → cumulative 2 → end
    await holdAs(gid, 'p6'); await holdAs(gid, 'p2'); await holdAs(gid, 'p7'); await holdAs(gid, 'p3'); await holdAs(gid, 'p5')
    await dropAs(gid, 'p4')
    s = await state(gid)
    check(s.state.status === 'ended' && s.state.cumulativeDropouts === 2, 'auction ENDED at cumulative 2 across rounds (R3)')
    check(s.state.activeBidders.length === 5, '5 remain at termination')
  }

  // ── (6) force-out unblocks a stuck round ──────────────────────────────────────
  section('(6) instructor force-out unblocks a round stuck on a non-responsive bidder')
  {
    const gid = 's6-force'
    await setup(gid); await playRound1(gid) // non-winners {1,3}
    // R2: winners hold, p1 drops, p3 is NON-RESPONSIVE (owes an action)
    await holdAs(gid, 'p6'); await holdAs(gid, 'p2'); await holdAs(gid, 'p7'); await holdAs(gid, 'p4'); await holdAs(gid, 'p5')
    await dropAs(gid, 'p1')
    let s = await state(gid)
    check(s.state.round === 2 && s.state.status === 'open', 'round stuck OPEN waiting on the non-responsive bidder (idx3)')
    check(s.state.actions['3'] === undefined, 'idx3 has not acted')
    const f = await forceIdx(gid, 3) // instructor force-out
    check(f.ok && f.result.ok === true, 'force-out of the non-winner accepted')
    s = await state(gid)
    check(s.state.status === 'ended', 'force-out completed the round (and here ended the auction)')
    check(s.state.cumulativeDropouts === 2 && s.state.droppedBidders.includes(3), 'forced bidder counts toward the cumulative-2 termination')
  }

  // ── (7) carry-over across rounds ──────────────────────────────────────────────
  section('(7) carry-over — a winner who holds keeps license/price into the next round')
  {
    const gid = 's7-carry'
    await setup(gid); await playRound1(gid) // idx2 wins B@200
    // R2: keep it going (only 1 drop): p1 drops, p3 takes A@400 (displaces idx6); rest hold incl idx2 holding B.
    await holdAs(gid, 'p6'); await holdAs(gid, 'p2'); await holdAs(gid, 'p7'); await holdAs(gid, 'p4'); await holdAs(gid, 'p5')
    await dropAs(gid, 'p1'); await bidAs(gid, 'p3', 'A', 400)
    const s = await state(gid)
    check(s.state.status === 'open' && s.state.round === 3, 'auction continues into round 3 (only 1 drop)')
    check(s.state.standing.B.winnerBidderIndex === 2 && s.state.standing.B.standingPrice === 200, 'idx2 still holds B@200 — carry-over preserved without re-bidding')
  }

  // ── report ────────────────────────────────────────────────────────────────────
  console.log(results.join('\n'))
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2) })
