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
import { LICENSE_IDS, valueFor, type LicenseId } from './auction/valueMatrix'
import { minIncrement } from './auction/increment'
import { provisionalProfit } from './auction/resolution'
import { winningLicenseOf, minToTake } from './auction/validateBid'

const isEmu = () => process.env.FUNCTIONS_EMULATOR === 'true'
const authHeaderOf = (req: CallableRequest): string | undefined =>
  req.rawRequest.headers.authorization as string | undefined

const CORS = { cors: saaGameDef.corsOrigins }

/** Efficiency denominator default — the efficient-allocation max surplus (§ report). */
const DEFAULT_EFFICIENT_MAX = 3119

// LIVE active-bidder count: `state.activeBidders` only sheds a drop-out at round CLOSE
// (see roundLoop.closeRound), so mid-round it still counts a bidder who has already
// dropped out or been forced out this round. Subtract those pending exits so every
// header (bidder screen + instructor dashboard) decrements the instant someone leaves,
// matching what closeRound will commit. Mirrors closeRound's droppedThisRound test.
function liveActiveCount(state: RoundLoopState): number {
  return state.activeBidders.filter((b) => {
    const t = state.actions[b]?.type
    return t !== 'dropout' && t !== 'forced_out'
  }).length
}

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
    if (result.state.status === 'ended') {
      writeEndOutcomes(tx, admin.firestore().collection('game_instances').doc(gameInstanceId), stored, result.state)
    }
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
    if (result.state.status === 'ended') {
      writeEndOutcomes(tx, admin.firestore().collection('game_instances').doc(gameInstanceId), stored, result.state)
    }
    return { ok: true as const, roundClosed: result.roundClosed, status: result.state.status, round: result.state.round }
  })
})

// ── getBidderView (student): the PARANOID §12 per-caller view for the screen ─────
// Returns ONLY: public standing (prices + revealed winners, both public per §12),
// the CALLER's own private value column + status, and count-based waiting info.
// It NEVER exposes another bidder's private values or their pending (un-closed) bid.
export const getBidderView = onCall(CORS, async (request) => {
  const data = request.data as Record<string, unknown>
  const { participantId, gameInstanceId } = await extractStudentOnCallIds(data, isEmu(), authHeaderOf(request))
  const groupId = String(data['group_id'] ?? '')
  if (!groupId) throw new HttpsError('invalid-argument', 'group_id required')

  const snap = await stateDoc(gameInstanceId, groupId).get()
  if (!snap.exists) throw new HttpsError('not-found', 'Auction not started.')
  const stored = snap.data() as StoredDoc
  const state = stored.state
  const bidderIndex = stored.index_by_pid[participantId]
  if (bidderIndex === undefined) throw new HttpsError('permission-denied', 'You are not a bidder in this auction.')

  const winningLicense = winningLicenseOf(bidderIndex, state.standing)
  const myAction = state.actions[bidderIndex]
  // A drop-out (or force-out) is permanent the instant it is submitted — reflect watch
  // mode immediately, even though activeBidders/droppedBidders only update at round close.
  const droppedOut =
    state.droppedBidders.includes(bidderIndex) || myAction?.type === 'dropout' || myAction?.type === 'forced_out'
  const active = state.activeBidders.includes(bidderIndex) && !droppedOut
  const isOpen = state.status === 'open'
  const hasActedThisRound = myAction !== undefined

  const licenses = LICENSE_IDS.map((l) => {
    const s = state.standing[l]
    // The minimum LEGAL bid for THIS caller on THIS license (server-authoritative hint):
    //   • non-winner → Case-A minToTake (200 if unheld, else standing+increment)
    //   • the caller's own held license → self-raise, standing+1
    //   • a winner on ANY other license → null (cannot switch)
    let minLegalBidForYou: number | null = null
    if (isOpen && active && !hasActedThisRound) {
      if (winningLicense === null) minLegalBidForYou = minToTake(l, state.standing)
      else if (l === winningLicense) minLegalBidForYou = s.standingPrice + 1
    }
    return {
      licenseId: l,
      yourValue: valueFor(l, bidderIndex), // caller's OWN column only — private
      currentHighBid: s.standingPrice,
      currentWinnerIndex: s.winnerBidderIndex,
      youAreWinner: s.winnerBidderIndex === bidderIndex,
      minIncrement: minIncrement(s.standingPrice), // per-license band (display)
      minLegalBidForYou,
    }
  })

  return {
    ok: true as const,
    status: state.status,
    round: state.round,
    bidderIndex,
    active,
    droppedOut,
    hasActedThisRound,
    isWinner: winningLicense !== null,
    winningLicense,
    currentBidOnWinningLicense: winningLicense ? state.standing[winningLicense].standingPrice : null,
    provisionalProfit: provisionalProfit(bidderIndex, state.standing),
    licenses,
    activeCount: liveActiveCount(state), // live — decrements on a mid-round drop/force-out
    actedCount: Object.keys(state.actions).length, // COUNT only — never others' amounts
    terminalAllocation: state.status === 'ended' ? state.terminalAllocation : null,
    yourTerminalLicense: state.status === 'ended' ? winningLicense : null,
    yourTerminalProfit: state.status === 'ended' ? provisionalProfit(bidderIndex, state.standing) : null,
  }
})

// ── per-participant auction outcome (written to participant docs at auction END) ─
// Lets getReportData (tables), the dashboard Outcome column, and scoreAndRecord read
// each bidder's total profit + gradebook metadata without re-reading the auction doc.
export interface ParticipantOutcome {
  pid: string
  total_profit: number
  won_license: LicenseId | null
  rounds_bid: number
  dropped_out_at_round: number | null
}
function participantOutcomes(state: RoundLoopState, pidByIndex: Record<string, string>): ParticipantOutcome[] {
  const out: ParticipantOutcome[] = []
  for (const key of Object.keys(pidByIndex)) {
    const idx = Number(key)
    const won = winningLicenseOf(idx, state.standing)
    const m = state.biddersMeta[idx] ?? { roundsBid: 0, droppedOutAtRound: null }
    out.push({
      pid: pidByIndex[key],
      total_profit: won ? valueFor(won, idx) - state.standing[won].standingPrice : 0,
      won_license: won,
      rounds_bid: m.roundsBid,
      dropped_out_at_round: m.droppedOutAtRound,
    })
  }
  return out
}

// On auction END, denormalize each bidder's outcome onto their participant doc and
// mark the group completed (so the generic finalize/grading path + getReportData +
// the dashboard read profit/metadata without re-reading the auction doc). Scoring is
// participation-only, so the group's outcome content is irrelevant to any grade.
function writeEndOutcomes(
  tx: FirebaseFirestore.Transaction,
  instanceRef: FirebaseFirestore.DocumentReference,
  stored: StoredDoc,
  state: RoundLoopState,
) {
  for (const o of participantOutcomes(state, stored.pid_by_index)) {
    tx.set(instanceRef.collection('participants').doc(o.pid), {
      // top-level for getReportData (tables) + the dashboard Outcome override
      total_profit: o.total_profit,
      won_license: o.won_license,
      rounds_bid: o.rounds_bid,
      dropped_out_at_round: o.dropped_out_at_round,
      // details blob rides to the gradebook via toGameResult (metadata, NOT a score)
      details: {
        rounds_bid: o.rounds_bid,
        dropped_out_at_round: o.dropped_out_at_round,
        total_profit: o.total_profit,
        won_license: o.won_license,
      },
    }, { merge: true })
  }
  tx.set(instanceRef.collection('groups').doc(stored.group_id), {
    status: 'completed',
    agreement_reached: true,
    outcome: { placeholder_result: 0 },
    saa_auction_ended_at: FieldValue.serverTimestamp(),
  }, { merge: true })
}

// ── getAuctionReport (instructor): chart series + per-bidder profit/metadata ──────
export const getAuctionReport = onCall(CORS, async (request) => {
  const data = request.data as Record<string, unknown>
  const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))
  const instanceRef = admin.firestore().collection('game_instances').doc(gameInstanceId)
  const [auctionsSnap, participantsSnap, configSnap] = await Promise.all([
    instanceRef.collection('saa_auction').get(),
    instanceRef.collection('participants').get(),
    instanceRef.collection('config').doc('main').get(),
  ])
  const nameByPid = new Map<string, string | null>()
  for (const p of participantsSnap.docs) {
    const d = p.data() as Record<string, unknown>
    nameByPid.set(p.id, (((d['display_name'] ?? d['name'] ?? '') as string).trim()) || null)
  }
  // Efficiency denominator — the instructor-set efficient-allocation max surplus.
  const cfg = (configSnap.data() ?? {}) as Record<string, unknown>
  const efficientMax = Number(cfg['efficient_max'] ?? DEFAULT_EFFICIENT_MAX) || DEFAULT_EFFICIENT_MAX
  const sorted = auctionsSnap.docs.slice().sort((a, b) => a.id.localeCompare(b.id))

  const groups = sorted.map((doc, gi) => {
    const stored = doc.data() as StoredDoc
    const state = stored.state
    const revenueSeries = state.history.map((h) => ({
      round: h.round,
      revenue: LICENSE_IDS.reduce((s, l) => s + h.standing[l].standingPrice, 0),
    }))
    const profitSeries = state.history.map((h) => ({
      round: h.round,
      profit: LICENSE_IDS.reduce((s, l) => {
        const w = h.standing[l].winnerBidderIndex
        return w !== null ? s + (valueFor(l, w) - h.standing[l].standingPrice) : s
      }, 0),
    }))
    // Final (auction-end) per-group statistics for the Statistics table.
    const finalRevenue = LICENSE_IDS.reduce((s, l) => s + state.standing[l].standingPrice, 0)
    const finalProfit = LICENSE_IDS.reduce((s, l) => {
      const w = state.standing[l].winnerBidderIndex
      return w !== null ? s + (valueFor(l, w) - state.standing[l].standingPrice) : s
    }, 0)
    const totalSurplus = finalRevenue + finalProfit
    const winnersByLicense = Object.fromEntries(
      LICENSE_IDS.map((l) => [l, state.standing[l].winnerBidderIndex]),
    ) as Record<LicenseId, number | null>
    return {
      groupId: stored.group_id, groupNumber: gi + 1, status: state.status, rounds: state.history.length,
      revenueSeries, profitSeries,
      finalRevenue, finalProfit, totalSurplus,
      efficiency: efficientMax > 0 ? (totalSurplus / efficientMax) * 100 : 0,
      winnersByLicense,
    }
  })

  const bidders = sorted.flatMap((doc, gi) => {
    const stored = doc.data() as StoredDoc
    const pidByIndex = stored.pid_by_index
    const nameFor = (idx: number) => (pidByIndex[String(idx)] ? nameByPid.get(pidByIndex[String(idx)]) : null) || `Bidder ${idx}`
    return participantOutcomes(stored.state, pidByIndex).map((o) => {
      const idx = Number(Object.keys(pidByIndex).find((k) => pidByIndex[k] === o.pid))
      return { participantId: o.pid, name: nameFor(idx), groupNumber: gi + 1, bidderIndex: idx, totalProfit: o.total_profit, wonLicense: o.won_license, roundsBid: o.rounds_bid, droppedOutAtRound: o.dropped_out_at_round }
    })
  })

  return { ok: true as const, efficientMax, groups, bidders }
})

// ── getInstructorAuctionView (instructor): the SANITIZED dashboard view ──────────
// Same paranoid discipline as getBidderView, for the projector: it NEVER exposes a
// pending (un-closed-round) bid amount — only WHO has acted (a bool). Standing state
// (resolved prices + winners) is safe. Real student names are joined from the roster.
// Returns EVERY group's auction in the instance (SAA's dashboard is per-group cards).
export const getInstructorAuctionView = onCall(CORS, async (request) => {
  const data = request.data as Record<string, unknown>
  const gameInstanceId = await extractInstructorGameId(data, isEmu(), authHeaderOf(request))

  const instanceRef = admin.firestore().collection('game_instances').doc(gameInstanceId)
  const [auctionsSnap, participantsSnap] = await Promise.all([
    instanceRef.collection('saa_auction').get(),
    instanceRef.collection('participants').get(),
  ])

  const nameByPid = new Map<string, string | null>()
  for (const p of participantsSnap.docs) {
    const d = p.data() as Record<string, unknown>
    const nm = ((d['display_name'] ?? d['name'] ?? '') as string).trim()
    nameByPid.set(p.id, nm || null)
  }

  const groups = auctionsSnap.docs.map((doc) => {
    const stored = doc.data() as StoredDoc
    const state = stored.state
    const pidByIndex = stored.pid_by_index
    const nameFor = (idx: number): string => {
      const pid = pidByIndex[String(idx)]
      return (pid ? nameByPid.get(pid) : null) || `Bidder ${idx}`
    }

    const standing = LICENSE_IDS.map((l) => {
      const s = state.standing[l]
      return {
        licenseId: l,
        standingPrice: s.standingPrice,
        winnerBidderIndex: s.winnerBidderIndex,
        winnerName: s.winnerBidderIndex !== null ? nameFor(s.winnerBidderIndex) : null,
      }
    })

    const indices = Object.keys(pidByIndex).map(Number).sort((a, b) => a - b)
    const bidders = indices.map((idx) => {
      const winningLicense = winningLicenseOf(idx, state.standing)
      const myAction = state.actions[idx]
      const droppedOut =
        state.droppedBidders.includes(idx) || myAction?.type === 'dropout' || myAction?.type === 'forced_out'
      return {
        bidderIndex: idx,
        participantId: pidByIndex[String(idx)],
        name: nameFor(idx),
        // hasActed is a BOOL — the amount/license they bid is deliberately NOT included
        // for the open round (sealed-bid privacy on the projector).
        hasActed: myAction !== undefined,
        active: state.activeBidders.includes(idx) && !droppedOut,
        droppedOut,
        isWinner: winningLicense !== null,
        winningLicense,
      }
    })

    return {
      groupId: stored.group_id,
      round: state.round,
      status: state.status,
      activeCount: liveActiveCount(state), // live — decrements on a mid-round drop/force-out
      actedCount: Object.keys(state.actions).length,
      cumulativeDropouts: state.cumulativeDropouts,
      standing,
      bidders,
      terminalAllocation: state.status === 'ended' ? standing : null,
    }
  })

  return { ok: true as const, groups }
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
