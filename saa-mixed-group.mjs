// ═══════════════════════════════════════════════════════════════════════════════
// SAA Phase 3 — the MIXED remainder-group proof (emulator).
//
// Drives matching THROUGH THE REAL INSTRUCTOR CALLABLE ('triggerMatching' — the exact
// name the shared game-ui dashboard button calls), NOT by calling the matcher functions
// directly. This is the coverage the first version lacked: it never noticed the button
// was unwired because it called fillRemainderWithBots directly.
//
// Seeds 10 eligible humans → real triggerMatching → proves:
//   • TWO groups form: one 7-human full group + one 3-human + 4-bot remainder;
//   • ZERO participants left with group_id == null (the stranded-remainder bug is gone);
//   • triggerMatching is idempotent (a second call adds nothing);
// then plays the mixed remainder group to termination and proves (as before):
//   • round-1 bots bid the MIN-LEGAL reserve (200) on their most-valued license;
//   • a duplicate bot delivery does NOT double-bid;
//   • the auction terminates; bots are EXCLUDED from the z-score pool + gradebook push.
//
// RUN (from games/saa): with the emulator up (functions :5005, firestore :8082,
// database :9002) —   node saa-mixed-group.mjs
// ═══════════════════════════════════════════════════════════════════════════════

import { decide } from './bot/dist/strategy.js' // canonical Slice-1 strategy — humans use it too

const PROJECT = 'saa-mygames-live'
const FUNCTIONS = `http://localhost:5005/${PROJECT}/us-central1`
const GID = 'mixed-group-test'
const HUMANS = Array.from({ length: 10 }, (_, i) => `h${i + 1}`) // 10 → 1 full group of 7 + remainder of 3

async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
  let body = null; try { body = await res.json() } catch { /* */ }
  if (res.ok && body && 'result' in body) return { ok: true, result: body.result }
  return { ok: false, error: body?.error?.message ?? `http ${res.status}` }
}
async function callReq(name, body) {
  const res = await fetch(`${FUNCTIONS}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let j = null; try { j = await res.json() } catch { /* */ }
  return { status: res.status, body: j }
}

const asStudent = (pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: GID }, ...extra })
const asDev = (extra = {}) => ({ _dev: { game_instance_id: GID }, ...extra })

let GROUP_ID = null
let MIXED_HUMANS = []
let BOT_INDICES = []
const runBots = () => callReq('runBotActionsForTest', { game_instance_id: GID, group_id: GROUP_ID })
const state = async () => (await callFn('getAuctionState', asDev({ group_id: GROUP_ID }))).result
const viewOf = (pid) => callFn('getBidderView', asStudent(pid, { group_id: GROUP_ID }))

let passed = 0, failed = 0
const log = []
const check = (c, m) => { if (c) { passed++; log.push(`  ✓ ${m}`) } else { failed++; log.push(`  ✗ FAIL: ${m}`) } }
const section = (t) => log.push(`\n${t}`)

// Round-1 dominant choice per BOT bidder index (argmax of the value matrix column, @200).
// In a 3-human + 4-bot remainder, bots occupy indices 4..7 (humans take 1,2,3).
const EXPECT_R1_BOT = { 4: 'A', 5: 'B', 6: 'E', 7: 'C' }

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
  // ── THE BUG FIX: 10 humans → real triggerMatching → 2 groups, zero stranded ──
  section('MATCHING (via the REAL triggerMatching callable) — 10 humans → 7-human group + 3-human/4-bot group')
  const seed = await callReq('seedMatchTest', { game_instance_id: GID, participants: HUMANS.map((id) => ({ id, role: 'bidder' })) })
  check(seed.body?.ok, `seeded ${HUMANS.length} eligible humans`)

  const m = await callFn('triggerMatching', asDev()) // ← the exact callable the dashboard button hits
  check(m.ok, `triggerMatching ran [${m.error ?? ''}]`)
  const fullGroups = m.result?.human?.groups ?? []
  check(fullGroups.length === 1, `1 full human group formed (got ${fullGroups.length})`)
  check(fullGroups[0]?.bidder_participants?.length === 7, `the full group has 7 humans (got ${fullGroups[0]?.bidder_participants?.length})`)
  check(m.result?.remainder?.created === true, 'remainder group was bot-filled (created)')
  check(m.result?.remainder?.humans === 3, `remainder has 3 humans (got ${m.result?.remainder?.humans})`)
  check(m.result?.remainder?.bots === 4, `remainder padded with 4 bots → 7 (got ${m.result?.remainder?.bots})`)

  // The definitive anti-regression assertion: read the roster, prove NOBODY is stranded.
  const roster = await callFn('getRoster', asDev())
  const humanRows = (roster.result?.participants ?? []).filter((p) => HUMANS.includes(p.participant_id))
  const stranded = humanRows.filter((p) => !p.group_id)
  check(humanRows.length === 10, `all 10 humans present in the roster (got ${humanRows.length})`)
  check(stranded.length === 0, `ZERO humans stranded with group_id == null — THE BUG (got ${stranded.length} stranded)`)
  check((roster.result?.groups ?? []).length === 2, `exactly 2 groups exist (got ${(roster.result?.groups ?? []).length})`)

  // Idempotent: a second matching call adds nothing.
  const m2 = await callFn('triggerMatching', asDev())
  check(m2.ok && m2.result?.remainder?.created === false, 'triggerMatching is idempotent (second call creates no new group)')
  const roster2 = await callFn('getRoster', asDev())
  check((roster2.result?.groups ?? []).length === 2, 'still exactly 2 groups after the second call (no duplicates)')

  // Play the MIXED remainder group. Its bidder order is humans-first, then bots.
  GROUP_ID = m.result.remainder.group_id
  MIXED_HUMANS = m.result.remainder.bidder_participants.slice(0, 3)
  BOT_INDICES = [4, 5, 6, 7]

  const opened = await callFn('openAuction', asDev({ group_id: GROUP_ID }))
  check(opened.ok && opened.result?.round === 1, `openAuction → round 1 [${opened.error ?? ''}]`)
  const s0 = await state()
  check(JSON.stringify(s0.botIndices) === JSON.stringify(BOT_INDICES), `bot seats got indices [4..7] (got ${JSON.stringify(s0.botIndices)})`)

  // ── Round 1: bots bid min-legal (200) on their most-valued license ──
  section('ROUND 1 — bots bid min-legal (200) on their most-valued license')
  const r1 = await runBots()
  check(r1.body?.acted === 4, `all 4 bots acted (got ${r1.body?.acted})`)
  const s1 = await state()
  check(s1.state.round === 1 && s1.state.status === 'open', 'round still 1, open (3 humans not yet acted)')
  let allMinLegal = true
  for (const idx of BOT_INDICES) {
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
  check(before === after && after === 4, `action count unchanged at 4 (no double-bid; ${before}→${after})`)

  // ── Play to termination: 3 humans + 4 bots act each round via the same strategy ──
  section('PLAYTHROUGH — humans + bots play to endogenous termination')
  for (const h of MIXED_HUMANS) await driveHuman(h)
  let ended = false
  for (let tick = 0; tick < 60; tick++) {
    const st = await state()
    if (st.state.status === 'ended') { ended = true; break }
    await runBots()
    for (const h of MIXED_HUMANS) await driveHuman(h)
  }
  const sEnd = await state()
  check(ended || sEnd.state.status === 'ended', 'auction reached endogenous termination')
  check(sEnd.state.cumulativeDropouts >= 2, `terminated on ≥2 cumulative drop-outs (got ${sEnd.state.cumulativeDropouts})`)
  check(sEnd.state.terminalAllocation !== null, 'terminal allocation computed on end')

  // ── Grading: bots EXCLUDED from the z-score pool + gradebook push ──
  section('SCORING — bots excluded from the z-score pool + push')
  const scored = await callFn('scoreAndRecord', asDev()) // no callback override → push skipped, scores written
  check(scored.ok, `scoreAndRecord ran [${scored.error ?? ''}]`)
  check(scored.result?.scored === 10, `all 10 humans scored, 4 bots excluded (got ${scored.result?.scored})`)

  console.log(log.join('\n'))
  console.log(`\n${failed === 0 ? '✅' : '❌'}  ${passed} passed, ${failed} failed\n`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1) })
