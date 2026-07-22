// ═══════════════════════════════════════════════════════════════════════════════
// SAA Phase 3 — the MIXED remainder-group proof (emulator).
//
// A remainder group of 2 real (emulated) humans + 5 server bots plays a full SAA
// auction to termination. Humans act via the student callables (submitBid/holdBid/
// dropOut) driven by the SAME canonical decide() the browser bots use; bots act via the
// server runner (runBotActionsForTest — the emulator has no Cloud Tasks queue). Proves:
//   • the bot-fill matcher forms a 2-human + 5-bot group, bot_count recorded;
//   • openAuction assigns bot seats a bidderIndex + value column (bot_indices = [3..7]);
//   • round 1 bots bid the MIN-LEGAL reserve (200) on their most-valued license;
//   • a duplicate bot delivery (Cloud Task retry) does NOT double-bid (idempotent);
//   • rounds close with humans + bots acting together; the auction terminates;
//   • scoreAndRecord EXCLUDES bots from the z-score pool + gradebook push.
//
// RUN (from games/saa): with the emulator up (project saa-mygames-live, functions :5005,
// firestore :8082, database :9002) —   node saa-mixed-group.mjs
// ═══════════════════════════════════════════════════════════════════════════════

import { decide } from './bot/dist/strategy.js' // canonical Slice-1 strategy — humans use it too

const PROJECT = 'saa-mygames-live'
const FUNCTIONS = `http://localhost:5005/${PROJECT}/us-central1`
const GID = 'mixed-group-test'
const HUMANS = ['h1', 'h2']

async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
  let body = null; try { body = await res.json() } catch { /* */ }
  if (res.ok && body && 'result' in body) return { ok: true, result: body.result }
  return { ok: false, error: body?.error?.message ?? `http ${res.status}` }
}
// onRequest helpers (seed + bot test trigger) take a plain body, not the callable envelope.
async function callReq(name, body) {
  const res = await fetch(`${FUNCTIONS}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let j = null; try { j = await res.json() } catch { /* */ }
  return { status: res.status, body: j }
}

const asStudent = (pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: GID }, ...extra })
const asDev = (extra = {}) => ({ _dev: { game_instance_id: GID }, ...extra })

let GROUP_ID = null
const runBots = () => callReq('runBotActionsForTest', { game_instance_id: GID, group_id: GROUP_ID })
const state = async () => (await callFn('getAuctionState', asDev({ group_id: GROUP_ID }))).result
const viewOf = (pid) => callFn('getBidderView', asStudent(pid, { group_id: GROUP_ID }))

let passed = 0, failed = 0
const log = []
const check = (c, m) => { if (c) { passed++; log.push(`  ✓ ${m}`) } else { failed++; log.push(`  ✗ FAIL: ${m}`) } }
const section = (t) => log.push(`\n${t}`)

// Round-1 dominant-strategy choice per bidder index (argmax of the value matrix, @200).
// A/B/C/D/E values → the license each bidder most values (used to assert min-legal bids).
const EXPECT_R1_BOT = { 3: 'B', 4: 'A', 5: 'B', 6: 'E', 7: 'C' } // bots occupy indices 3..7

// Drive one human seat for the current round via the SAME decide() the bots use.
async function driveHuman(pid) {
  const v = (await viewOf(pid)).result
  if (!v || v.status === 'ended') return
  if (!v.active || v.hasActedThisRound) return
  const d = decide(v)
  if (d === null) return
  if (d.action === 'bid') await callFn('submitBid', asStudent(pid, { group_id: GROUP_ID, license_id: d.license, amount: d.amount }))
  else if (d.action === 'hold') await callFn('holdBid', asStudent(pid, { group_id: GROUP_ID }))
  else if (d.action === 'drop') await callFn('dropOut', asStudent(pid, { group_id: GROUP_ID }))
}

async function main() {
  // ── Setup: 2 eligible ungrouped humans → bot-fill the remainder → open the auction ──
  section('SETUP — seed 2 humans, fill remainder with 5 bots, open auction')
  const seed = await callReq('seedMatchTest', { game_instance_id: GID, participants: HUMANS.map((id) => ({ id, role: 'bidder' })) })
  check(seed.body?.ok, `seeded ${HUMANS.length} eligible humans`)

  const fill = await callFn('fillRemainderWithBots', asDev())
  check(fill.ok && fill.result?.created, `fillRemainderWithBots created the group [${fill.error ?? ''}]`)
  GROUP_ID = fill.result?.group_id
  check(fill.result?.humans === 2, `2 humans in the remainder group (got ${fill.result?.humans})`)
  check(fill.result?.bots === 5, `bot_count = 5 recorded (got ${fill.result?.bots})`)
  // Humans first → indices 1,2; bots → indices 3..7.
  check(JSON.stringify(fill.result?.bidder_participants?.slice(0, 2)) === JSON.stringify(HUMANS), 'humans occupy bidder indices 1,2 (value columns 1,2)')

  const opened = await callFn('openAuction', asDev({ group_id: GROUP_ID }))
  check(opened.ok && opened.result?.round === 1, `openAuction → round 1 [${opened.error ?? ''}]`)
  const s0 = await state()
  check(JSON.stringify(s0.botIndices) === JSON.stringify([3, 4, 5, 6, 7]), `bot seats got indices [3..7] (got ${JSON.stringify(s0.botIndices)})`)

  // ── Round 1: bots act (min-legal reserve on most-valued license) ──
  section('ROUND 1 — bots bid min-legal (200) on their most-valued license')
  const r1 = await runBots()
  check(r1.body?.acted === 5, `all 5 bots acted (got ${r1.body?.acted})`)
  const s1 = await state()
  check(s1.state.round === 1 && s1.state.status === 'open', 'round still 1, open (2 humans not yet acted)')
  let allMinLegal = true
  for (const idx of [3, 4, 5, 6, 7]) {
    const a = s1.state.actions[idx]
    const ok = a && a.type === 'bid' && a.licenseId === EXPECT_R1_BOT[idx] && a.amount === 200
    if (!ok) { allMinLegal = false; log.push(`      bot ${idx}: ${JSON.stringify(a)} (expected bid ${EXPECT_R1_BOT[idx]}@200)`) }
  }
  check(allMinLegal, 'every bot bid the min-legal reserve 200 on its argmax license (per §7.1)')

  // ── Idempotency: a duplicate delivery (Cloud Task retry) must NOT double-bid ──
  section('IDEMPOTENCY — a duplicate bot delivery is a no-op')
  const before = Object.keys(s1.state.actions).length
  const dup = await runBots()
  const s1b = await state()
  const after = Object.keys(s1b.state.actions).length
  check(dup.body?.acted === 0, `second delivery acted 0 (got ${dup.body?.acted})`)
  check(before === after && after === 5, `action count unchanged at 5 (no double-bid; ${before}→${after})`)

  // ── Play to termination: humans + bots act each round via the same strategy ──
  section('PLAYTHROUGH — humans + bots play to endogenous termination')
  // Finish round 1 (humans act → round closes), then loop rounds until ended.
  for (const h of HUMANS) await driveHuman(h)
  let ended = false
  for (let tick = 0; tick < 60; tick++) {
    const st = await state()
    if (st.state.status === 'ended') { ended = true; break }
    await runBots()                       // bots act this round (idempotent if already did)
    for (const h of HUMANS) await driveHuman(h)
  }
  const sEnd = await state()
  check(ended || sEnd.state.status === 'ended', 'auction reached endogenous termination')
  check(sEnd.state.cumulativeDropouts >= 2, `terminated on ≥2 cumulative drop-outs (got ${sEnd.state.cumulativeDropouts})`)
  check(sEnd.state.terminalAllocation !== null, 'terminal allocation computed on end')

  // ── Grading: bots EXCLUDED from the z-score pool + gradebook push ──
  section('SCORING — bots excluded from the z-score pool + push')
  const scored = await callFn('scoreAndRecord', asDev()) // no callback override → push skipped, scores written
  check(scored.ok, `scoreAndRecord ran [${scored.error ?? ''}]`)
  check(scored.result?.scored === HUMANS.length, `only the ${HUMANS.length} humans scored — bots excluded (got ${scored.result?.scored})`)

  // ── Report ──
  console.log(log.join('\n'))
  console.log(`\n${failed === 0 ? '✅' : '❌'}  ${passed} passed, ${failed} failed\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
