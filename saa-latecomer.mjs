// ═══════════════════════════════════════════════════════════════════════════════
// SAA — latecomer auto-placement harness (Latecomer_Placement_Spec_v1 §3.1).
//
// Self-booting: builds functions, boots emulators (auth/functions/firestore/database),
// and drives the SHARED makeVerifyAttendanceCode → placeLatecomer → saaIsJoinable path,
// then the real auction (openAuction/getBidderView/submitBid) and scoreAndRecord.
//
// SAA is the predicate-only case: an async isJoinable and NO onPlace. These tests prove
// (2) placement into an under-7 unopened auction, (3) the placed latecomer gets bidder
// index 7 + value column 7 and BIDS, (4) the latecomer reaches the gradebook, (5) a
// running auction rejects (absent, not placed), (6) a full auction rejects, (7) two
// simultaneous latecomers into the same 6-auction → EXACTLY ONE placed (never 8), and
// (8) a mixed instance places into the sole joinable auction, never a running one.
//
//   node saa-latecomer.mjs        (env KEEP=1 leaves the stack up)
// ═══════════════════════════════════════════════════════════════════════════════

import { openSync, writeFileSync } from 'node:fs'
import { spawn, execSync } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT   = 'saa-mygames-live'
const ROOT      = path.dirname(fileURLToPath(import.meta.url))
const FUNCTIONS = `http://localhost:5005/${PROJECT}/us-central1`
const FIRESTORE = `http://localhost:8082/v1/projects/${PROJECT}/databases/(default)/documents`
const PORTS     = [9101, 5005, 8082, 9002]
const CB_PORT   = 5099    // mock classroom callback (test 4)

// bidderIndex 7's own value for license A, straight from the locked VALUE_MATRIX
// (valueMatrix.ts A:{...,7:535}). A latecomer placed 7th must see exactly this.
const A_VALUE_INDEX_7 = 535

// ── tiny harness ────────────────────────────────────────────────────────────────
let PASS = 0, FAIL = 0
const banner = m => console.log('\n' + '─'.repeat(70) + '\n' + m + '\n' + '─'.repeat(70))
function assert(cond, name) {
  if (cond) { PASS++; console.log(`  ✓ ${name}`) }
  else      { FAIL++; console.log(`  ✗ FAILED: ${name}`) }
}

// ── callable + REST helpers ───────────────────────────────────────────────────────
async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
  })
  let body = null
  try { body = await res.json() } catch { /* */ }
  if (res.ok && body && 'result' in body) return { ok: true, result: body.result }
  return { ok: false, error: body?.error?.message ?? `http ${res.status}`, status: body?.error?.status }
}
const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })
const asDev     = (gid, extra = {})      => ({ _dev: { game_instance_id: gid }, ...extra })

function encVal(v) {
  if (typeof v === 'string')  return { stringValue: v }
  if (typeof v === 'boolean') return { booleanValue: v }
  if (typeof v === 'number')  return { integerValue: String(v) }
  if (Array.isArray(v))       return { arrayValue: { values: v.map(encVal) } }
  if (v && typeof v === 'object' && '__ts' in v) return { timestampValue: v.__ts }
  throw new Error(`encVal: unsupported ${JSON.stringify(v)}`)
}
async function fsGet(gid, suffix) {
  const res = await fetch(`${FIRESTORE}/game_instances/${gid}/${suffix}`, { headers: { Authorization: 'Bearer owner' } })
  if (!res.ok) return null
  return res.json()
}
async function fsWrite(gid, suffix, obj, mask) {
  const fields = {}
  for (const [k, v] of Object.entries(obj)) fields[k] = encVal(v)
  const q = mask ? '?' + mask.map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&') : ''
  const res = await fetch(`${FIRESTORE}/game_instances/${gid}/${suffix}${q}`, {
    method: 'PATCH', headers: { Authorization: 'Bearer owner', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields }),
  })
  if (!res.ok) throw new Error(`fsWrite ${suffix} failed: ${res.status} ${await res.text()}`)
}
const nowTs = () => ({ __ts: new Date().toISOString() })
const strVal = f => f?.stringValue ?? null
const arrVal = f => (f?.arrayValue?.values ?? []).map(v => v.stringValue)
const numVal = f => (f?.integerValue != null ? parseInt(f.integerValue, 10) : (f?.doubleValue ?? null))

async function membersOf(gid, groupId) {
  const d = await fsGet(gid, `groups/${groupId}`)
  return arrVal(d?.fields?.bidder_participants)
}
async function pfields(gid, pid) { return (await fsGet(gid, `participants/${pid}`))?.fields ?? {} }

// Seed a matched (not-yet-opened) auction group + its bidder participant docs, directly
// (bypasses seedGroupForTest, which clears the whole instance — we need several groups).
async function seedGroup(gid, groupId, bidderPids, lead) {
  const leadId = lead ?? bidderPids[0]
  await fsWrite(gid, `groups/${groupId}`, {
    group_id: groupId, game_instance_id: gid, bidder_participants: bidderPids,
    lead_participant_id: leadId, status: 'matched',
  })
  for (const pid of bidderPids) {
    await fsWrite(gid, `participants/${pid}`, {
      participant_id: pid, game_instance_id: gid, role: 'bidder',
      group_id: groupId, is_lead: pid === leadId,
      prep_status: 'complete', knowledge_check_score: 1,
      confirmed_ready_at: nowTs(), attendance_confirmed_at: nowTs(),
    })
  }
}
// An UNPLACED, confirmed-ready latecomer (no group_id) — what verifyAttendanceCode places.
async function seedLatecomer(gid, pid) {
  await fsWrite(gid, `participants/${pid}`, {
    participant_id: pid, game_instance_id: gid, role: 'bidder',
    prep_status: 'complete', knowledge_check_score: 1, confirmed_ready_at: nowTs(),
  })
}
const setCode = (gid, code) => fsWrite(gid, 'attendance_code/current', { code })
const verify  = (gid, pid, code) => callFn('verifyAttendanceCode', asStudent(gid, pid, { code }))

// ── mock classroom callback (test 4) ──────────────────────────────────────────────
const cbBodies = []
let cbServer = null
function startCallback() {
  return new Promise((resolve) => {
    cbServer = http.createServer((req, res) => {
      let b = ''
      req.on('data', c => (b += c))
      req.on('end', () => { cbBodies.push(b); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}') })
    })
    cbServer.listen(CB_PORT, '127.0.0.1', () => resolve())
  })
}

// ── stack lifecycle ───────────────────────────────────────────────────────────────
const children = []
function freePorts() { for (const p of [...PORTS, CB_PORT]) { try { execSync(`lsof -ti tcp:${p} -sTCP:LISTEN | xargs kill -9`, { stdio: 'ignore' }) } catch { /* */ } } }
async function waitHttp(url, label, maxMs = 90_000) {
  const start = Date.now()
  for (;;) {
    try { const r = await fetch(url); if (r.status > 0) return } catch { /* */ }
    if (Date.now() - start > maxMs) throw new Error(`${label} never ready`)
    await sleep(600)
  }
}
async function bringUp() {
  banner('CLEAN-START — build functions, boot emulators (auth/functions/firestore/database)')
  freePorts(); await sleep(1000)
  execSync('npm run build', { cwd: path.join(ROOT, 'functions'), stdio: 'inherit' })
  const emuLog = openSync(path.join(ROOT, 'latecomer-emu.log'), 'a')
  const child = spawn('firebase', ['emulators:start', '--only', 'auth,functions,firestore,database', '--project', PROJECT],
    { cwd: ROOT, detached: true, stdio: ['ignore', emuLog, emuLog] })
  children.push(child)
  await waitHttp('http://localhost:8082/', 'firestore')
  await waitHttp('http://localhost:9002/.json', 'database')
  // health is a real onRequest fn — a 200 means functions are LOADED (the hub 404s until then).
  const start = Date.now()
  for (;;) {
    try { const r = await fetch(`${FUNCTIONS}/health`); if (r.ok) break } catch { /* */ }
    if (Date.now() - start > 120_000) throw new Error('functions never finished loading')
    await sleep(800)
  }
  await startCallback()
  await sleep(1200)
  console.log('  Stack ready ✅ (functions loaded, callback mock up)')
}
function tearDown() {
  if (cbServer) try { cbServer.close() } catch { /* */ }
  if (process.env.KEEP === '1') return
  for (const c of children) { try { process.kill(-c.pid, 'SIGKILL') } catch { /* */ } }
  freePorts()
}

// ── the suite ─────────────────────────────────────────────────────────────────────
async function main() {
  await bringUp()

  // ══ TEST 2 — join a 6-bidder unopened auction → placed as the 7th ══
  banner('TEST 2 — latecomer joins a 6-bidder unopened auction → placed as the 7th bidder')
  const gid2 = 'saa-late-2'
  {
    await seedGroup(gid2, 'g', ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])
    await seedLatecomer(gid2, 'late')
    await setCode(gid2, 'SAA1')
    const r = await verify(gid2, 'late', 'SAA1')
    assert(r.ok, `T2: verifyAttendanceCode triggers placement [${r.error ?? ''}]`)
    const m = await membersOf(gid2, 'g')
    const p = await pfields(gid2, 'late')
    assert(m.length === 7 && m[6] === 'late', `T2: appended as the 7th in bidder_participants [${m.join(',')}]`)
    assert(strVal(p.group_id) === 'g' && p.is_lead?.booleanValue === false, `T2: latecomer stamped group_id=g, is_lead=false`)
  }

  // ══ TEST 3 — openAuction → latecomer gets index 7 + value column 7 → BIDS ══
  banner('TEST 3 (CRITICAL) — openAuction assigns index 7; latecomer sees column 7 and bids')
  {
    // Pre-open: no auction doc → the latecomer cannot bid yet (no index exists).
    const early = await callFn('getBidderView', asStudent(gid2, 'late', { group_id: 'g' }))
    assert(!early.ok && /not started/i.test(early.error ?? ''), `T3: before openAuction there is no index/auction to bid in [${early.error ?? ''}]`)

    const o = await callFn('openAuction', asDev(gid2, { group_id: 'g' }))
    assert(o.ok && o.result?.ok && o.result.activeBidders.length === 7, `T3: openAuction opened with all 7 bidders active`)

    const v = (await callFn('getBidderView', asStudent(gid2, 'late', { group_id: 'g' }))).result
    const aRow = v?.licenses?.find(x => x.licenseId === 'A')
    assert(v?.bidderIndex === 7, `T3: the latecomer is bidder index 7 (array order) [${v?.bidderIndex}]`)
    assert(aRow?.yourValue === A_VALUE_INDEX_7, `T3: value column 7 from the matrix (A=${A_VALUE_INDEX_7}) [${aRow?.yourValue}]`)

    const bid = await callFn('submitBid', asStudent(gid2, 'late', { group_id: 'g', license_id: 'A', amount: 200 }))
    assert(bid.ok && bid.result?.ok === true, `T3: the placed latecomer BIDS successfully [${bid.error ?? JSON.stringify(bid.result)}]`)
    const s = (await callFn('getAuctionState', asDev(gid2, { group_id: 'g' }))).result
    assert(s?.state?.actions?.['7']?.type === 'bid', `T3: the bid is recorded as index 7's action (a valid index → can bid)`)
  }

  // ══ TEST 4 — the latecomer's result reaches the gradebook ══
  banner('TEST 4 — scoreAndRecord grades the placed latecomer and pushes to the gradebook')
  {
    const before = cbBodies.length
    // scoreAndRecord reads the callback override from INSIDE _dev (scoreAndRecord.ts:22).
    const r = await callFn('scoreAndRecord', { _dev: { game_instance_id: gid2, callback_url: `http://127.0.0.1:${CB_PORT}/cb`, callback_secret: 'test' } })
    assert(r.ok, `T4: scoreAndRecord ran [${r.error ?? ''}]`)
    const p = await pfields(gid2, 'late')
    assert(numVal(p.raw_score) === 1 && p.finalized_at != null, `T4: latecomer scored (participation raw_score=1, finalized) [raw=${numVal(p.raw_score)}]`)
    const pushed = cbBodies.slice(before).join('\n')
    assert(cbBodies.length > before && pushed.includes('late'), `T4: the push reached the classroom callback and carries the latecomer`)
  }

  // ══ TEST 5 — running auction (state doc exists) → absent, NOT placed ══
  banner('TEST 5 — a latecomer to a RUNNING auction is absent (the "not a bidder" throw is never reached)')
  {
    const gid = 'saa-late-5'
    await seedGroup(gid, 'g', ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])   // 6 (<7): count is fine
    await callFn('openAuction', asDev(gid, { group_id: 'g' }))         // → saa_auction/g exists = running
    await seedLatecomer(gid, 'late5'); await setCode(gid, 'SAA5')
    const r = await verify(gid, 'late5', 'SAA5')
    const p = await pfields(gid, 'late5')
    assert(r.ok, `T5: verifyAttendanceCode still succeeds (attendance recorded) [${r.error ?? ''}]`)
    assert(p.group_id == null && p.latecomer_absent?.booleanValue === true, `T5: latecomer is ABSENT (no group_id, latecomer_absent), NOT placed into the running auction`)
    assert(!(await membersOf(gid, 'g')).includes('late5'), `T5: the running auction's bidder_participants is untouched (never an 8th mid-run)`)
  }

  // ══ TEST 6 — full auction (7 bidders) → absent ══
  banner('TEST 6 — a latecomer to a FULL (7-bidder) auction is absent')
  {
    const gid = 'saa-late-6'
    await seedGroup(gid, 'g', ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'])  // full, NOT opened
    await seedLatecomer(gid, 'late6'); await setCode(gid, 'SAA6')
    const r = await verify(gid, 'late6', 'SAA6')
    const p = await pfields(gid, 'late6')
    assert(r.ok && p.group_id == null && p.latecomer_absent?.booleanValue === true, `T6: full-auction latecomer is ABSENT (count guard)`)
    assert((await membersOf(gid, 'g')).length === 7, `T6: the full auction stays at 7 (never an 8th)`)
  }

  // ══ TEST 7 (CONCURRENCY) — two latecomers into the same 6-auction → EXACTLY ONE placed ══
  banner('TEST 7 (CONCURRENCY) — two simultaneous latecomers into one 6-auction: exactly one placed, never 8')
  {
    const gid = 'saa-late-7'
    await seedGroup(gid, 'g', ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])   // 6 → one seat left
    await seedLatecomer(gid, 'la'); await seedLatecomer(gid, 'lb')
    await setCode(gid, 'SAA7')
    const [ra, rb] = await Promise.all([verify(gid, 'la', 'SAA7'), verify(gid, 'lb', 'SAA7')])
    const m = await membersOf(gid, 'g')
    const fa = await pfields(gid, 'la'), fb = await pfields(gid, 'lb')
    const placedCount = [strVal(fa.group_id), strVal(fb.group_id)].filter(x => x === 'g').length
    const absentCount = [fa.latecomer_absent?.booleanValue, fb.latecomer_absent?.booleanValue].filter(x => x === true).length
    assert(ra.ok && rb.ok, `T7: both verify calls returned ok (attendance recorded for both)`)
    assert(m.length === 7, `T7: the auction reaches EXACTLY 7 bidders — never 8 [${m.length}: ${m.join(',')}]`)
    assert(placedCount === 1 && absentCount === 1, `T7: exactly ONE latecomer placed, the OTHER rejected by the re-evaluated predicate [placed=${placedCount} absent=${absentCount}]`)
    // openAuction must run cleanly on the 7 — valueFor never throws (no index 8).
    const o = await callFn('openAuction', asDev(gid, { group_id: 'g' }))
    const placedPid = strVal(fa.group_id) === 'g' ? 'la' : 'lb'
    const v = (await callFn('getBidderView', asStudent(gid, placedPid, { group_id: 'g' }))).result
    assert(o.ok && o.result?.activeBidders.length === 7 && v?.bidderIndex === 7, `T7: openAuction opens on 7; the placed latecomer is index 7; valueFor never throws`)
  }

  // ══ TEST 8 — mixed instance: one joinable under-7 among full + running → picks the joinable ══
  banner('TEST 8 — mixed: full + running + one joinable under-7 → the joinable one is chosen, never a running one')
  {
    const gid = 'saa-late-8'
    await seedGroup(gid, 'gA', ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'])         // full → not joinable (count)
    await seedGroup(gid, 'gB', ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'])               // 6 → the ONLY joinable
    await seedGroup(gid, 'gD', ['d1', 'd2', 'd3', 'd4', 'd5'])                     // 5 (smaller!) but RUNNING
    await callFn('openAuction', asDev(gid, { group_id: 'gD' }))                    // gD → running
    await seedLatecomer(gid, 'late8'); await setCode(gid, 'SAA8')
    const r = await verify(gid, 'late8', 'SAA8')
    const p = await pfields(gid, 'late8')
    assert(r.ok && strVal(p.group_id) === 'gB', `T8: placed into the sole joinable auction gB — NOT the smaller-but-running gD [${strVal(p.group_id)}]`)
    assert((await membersOf(gid, 'gB')).includes('late8'), `T8: latecomer is in gB.bidder_participants (now 7)`)
    assert(!(await membersOf(gid, 'gD')).includes('late8') && !(await membersOf(gid, 'gA')).includes('late8'), `T8: never added to the running gD or the full gA`)
  }

  banner(`RESULT — ${PASS}/${PASS + FAIL} green${FAIL ? `  (${FAIL} FAILED)` : ''}`)
}

;(async () => {
  try { await main() }
  catch (err) { FAIL++; console.error('\n✗ FATAL:', err?.message ?? err) }
  finally {
    console.log(`\nDONE — ${PASS} passed, ${FAIL} failed`)
    tearDown()
    process.exit(FAIL ? 1 : 0)
  }
})()
