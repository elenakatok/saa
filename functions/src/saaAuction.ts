// ═══════════════════════════════════════════════════════════════════════════════
// SAA Phase 2 — Slice 3: the round-loop CALLABLES (stateful Firestore shell).
//
// Thin shell over the PURE roundLoop.ts state machine: each action reads the state
// doc, calls applyAction (which validates via Slice 2 before recording and closes
// the round via Slice 1 when the last action lands), and writes the new state — all
// in one Firestore transaction so "the last action closes the round" is race-safe.
// Round-close/resolution is SERVER-AUTHORITATIVE; nothing resolves on a client.
//
// State doc: game_instances/{iid}/saa_auction/{groupId}
//   { state: RoundLoopState, group_id, pid_by_index, index_by_pid, updated_at }
// The whole RoundLoopState is nested under `state` and REPLACED wholesale on each
// write (full set, no merge) so its maps (actions/standing) never merge-accrete.
// ═══════════════════════════════════════════════════════════════════════════════

import { onCall, HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { extractStudentOnCallIds, extractInstructorGameId } from '@mygames/game-server'
import { saaGameDef } from './gameDefinition'
import {
  openState,
  applyAction,
  terminalBijectionOk,
  provisionalProfits,
  type RoundLoopState,
  type RoundAction,
} from './auction/roundLoop'
import type { LicenseId } from './auction/valueMatrix'

const isEmu = () => process.env.FUNCTIONS_EMULATOR === 'true'
const authHeaderOf = (req: CallableRequest): string | undefined =>
  req.rawRequest.headers.authorization as string | undefined

const CORS = { cors: saaGameDef.corsOrigins }

function stateDoc(gameInstanceId: string, groupId: string) {
  return admin.firestore().collection('game_instances').doc(gameInstanceId).collection('saa_auction').doc(groupId)
}

interface StoredDoc {
  state: RoundLoopState
  group_id: string
  pid_by_index: Record<string, string>
  index_by_pid: Record<string, number>
}

// ── openAuction (instructor): initialize round 1 for a group of bidders ─────────
export const openAuction = onCall(CORS, async (request) => {
  const data = request.data as Record<string, unknown>
  const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
  const groupId = String(data['group_id'] ?? '')
  if (!groupId) throw new HttpsError('invalid-argument', 'group_id required')

  const instanceRef = admin.firestore().collection('game_instances').doc(gameInstanceId)
  const groupSnap = await instanceRef.collection('groups').doc(groupId).get()
  if (!groupSnap.exists) throw new HttpsError('not-found', 'Group not found.')
  const bidderPids = (groupSnap.data()?.['bidder_participants'] as string[] | undefined) ?? []
  if (bidderPids.length === 0) throw new HttpsError('failed-precondition', 'Group has no bidders.')

  // Assign bidderIndex 1..N by the group's bidder order (feeds the value matrix).
  const pidByIndex: Record<string, string> = {}
  const indexByPid: Record<string, number> = {}
  bidderPids.forEach((pid, i) => {
    pidByIndex[String(i + 1)] = pid
    indexByPid[pid] = i + 1
  })

  const state = openState(bidderPids.map((_, i) => i + 1))
  await stateDoc(gameInstanceId, groupId).set({
    state,
    group_id: groupId,
    pid_by_index: pidByIndex,
    index_by_pid: indexByPid,
    updated_at: FieldValue.serverTimestamp(),
  })
  return { ok: true as const, round: state.round, activeBidders: state.activeBidders }
})

// ── shared student-action transaction ───────────────────────────────────────────
async function applyStudentAction(
  request: CallableRequest,
  buildAction: (bidderIndex: number, state: RoundLoopState) => RoundAction,
) {
  const data = request.data as Record<string, unknown>
  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmu(), authHeaderOf(request))
  const groupId = String(data['group_id'] ?? '')
  if (!groupId) throw new HttpsError('invalid-argument', 'group_id required')

  const db = admin.firestore()
  const ref = stateDoc(gameInstanceId, groupId)
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw new HttpsError('not-found', 'Auction not started.')
    const stored = snap.data() as StoredDoc
    const bidderIndex = stored.index_by_pid[participantId]
    if (bidderIndex === undefined) throw new HttpsError('permission-denied', 'You are not a bidder in this auction.')

    const result = applyAction(stored.state, bidderIndex, buildAction(bidderIndex, stored.state))
    if (!result.ok) {
      // No write on an illegal action — return the student-facing reason.
      return { ok: false as const, reason: result.reason, minimumRequired: result.minimumRequired }
    }
    tx.set(ref, {
      state: result.state,
      group_id: stored.group_id,
      pid_by_index: stored.pid_by_index,
      index_by_pid: stored.index_by_pid,
      updated_at: FieldValue.serverTimestamp(),
    })
    return {
      ok: true as const,
      roundClosed: result.roundClosed,
      status: result.state.status,
      round: result.state.round,
    }
  })
}

// ── submitBid (student): a validated bid (non-winner take OR winner self-raise) ──
export const submitBid = onCall(CORS, async (request) => {
  const data = request.data as Record<string, unknown>
  const licenseId = String(data['license_id'] ?? '') as LicenseId
  const amount = Number(data['amount'])
  return applyStudentAction(request, () => ({
    type: 'bid',
    licenseId,
    amount,
    atMs: Timestamp.now().toMillis(),
  }))
})

// ── holdBid (student, winner only): keep the standing bid this round ─────────────
export const holdBid = onCall(CORS, async (request) => {
  return applyStudentAction(request, () => ({ type: 'hold' }))
})

// ── dropOut (student, non-winner only): "I'm Done" — permanent ──────────────────
export const dropOut = onCall(CORS, async (request) => {
  return applyStudentAction(request, () => ({ type: 'dropout' }))
})

// ── forceOut (instructor): force out a NON-winner (the only round unblocker) ─────
export const forceOut = onCall(CORS, async (request) => {
  const data = request.data as Record<string, unknown>
  const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
  const groupId = String(data['group_id'] ?? '')
  if (!groupId) throw new HttpsError('invalid-argument', 'group_id required')

  const db = admin.firestore()
  const ref = stateDoc(gameInstanceId, groupId)
  return await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw new HttpsError('not-found', 'Auction not started.')
    const stored = snap.data() as StoredDoc

    // Target by bidder_index, or by participant_id via the map.
    let bidderIndex: number | undefined
    if (data['bidder_index'] !== undefined) bidderIndex = Number(data['bidder_index'])
    else if (data['participant_id'] !== undefined) bidderIndex = stored.index_by_pid[String(data['participant_id'])]
    if (bidderIndex === undefined || Number.isNaN(bidderIndex)) {
      throw new HttpsError('invalid-argument', 'bidder_index or participant_id required')
    }

    const result = applyAction(stored.state, bidderIndex, { type: 'forced_out' })
    if (!result.ok) {
      throw new HttpsError('failed-precondition', result.reason ?? 'Cannot force out this bidder.')
    }
    tx.set(ref, {
      state: result.state,
      group_id: stored.group_id,
      pid_by_index: stored.pid_by_index,
      index_by_pid: stored.index_by_pid,
      updated_at: FieldValue.serverTimestamp(),
    })
    return { ok: true as const, roundClosed: result.roundClosed, status: result.state.status, round: result.state.round }
  })
})

// ── getAuctionState (instructor): full state view (Slice 5 dashboard/harness) ────
export const getAuctionState = onCall(CORS, async (request) => {
  const data = request.data as Record<string, unknown>
  const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
  const groupId = String(data['group_id'] ?? '')
  if (!groupId) throw new HttpsError('invalid-argument', 'group_id required')

  const snap = await stateDoc(gameInstanceId, groupId).get()
  if (!snap.exists) throw new HttpsError('not-found', 'Auction not started.')
  const stored = snap.data() as StoredDoc
  return {
    ok: true as const,
    state: stored.state,
    pidByIndex: stored.pid_by_index,
    terminalBijectionOk: terminalBijectionOk(stored.state),
    provisionalProfits: provisionalProfits(stored.state),
  }
})
