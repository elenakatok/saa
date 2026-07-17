// ═══════════════════════════════════════════════════════════════════════════════
// SAA Phase 2 — Slice 3: the round-loop state machine (PURE transitions).
//
// This is the stateful heart of SAA, kept as PURE functions over a plain state
// object so it is exhaustively unit-/harness-testable; the Firestore/RTDB shell
// (saaAuction.ts) just reads → applyAction → writes inside a transaction.
//
// The locked action model (Elena 2026-07-17):
//   • Every ACTIVE bidder takes EXACTLY ONE action per round.
//   • A provisional WINNER is BOUND: they must Bid (self-raise, Slice-2 Case B) or
//     Hold (keep their standing bid). They can NEVER drop out and can never leave.
//   • A NON-winner: Bid (Slice-2 Case A) or "I'm Done" (permanent drop-out).
//   • NO CLOCK: a round closes exactly when actions == activeAtRoundStart (count).
//   • On close: validate (done at submit) → resolveRound → carry → apply drop-outs
//     → termination check → open next round or END.
//   • Termination: CUMULATIVE drop-outs (incl. instructor force-outs) == 2 ends the
//     auction (5 remain). Two drops in one round end it at that round's close.
//   • On end: each remaining bidder wins the license they provisionally hold, at
//     their first-price standing bid.
// ═══════════════════════════════════════════════════════════════════════════════

import { resolveRound, initialStanding, provisionalProfit, type StandingState, type SaaBid } from './resolution'
import { validateBid, winningLicenseOf } from './validateBid'
import { LICENSE_IDS, type LicenseId } from './valueMatrix'

/** The auction ends the moment cumulative drop-outs reach this (5 of 7 remain). */
export const TERMINATION_DROPOUTS = 2

export type ActionType = 'bid' | 'hold' | 'dropout' | 'forced_out'

export interface RoundAction {
  type: ActionType
  licenseId?: LicenseId // 'bid' only
  amount?: number // 'bid' only
  atMs?: number // 'bid' only — submission order, for the resolver's tie-break
}

export interface TerminalHolding {
  winnerBidderIndex: number | null
  standingPrice: number
}

export interface RoundLoopState {
  status: 'open' | 'ended'
  round: number
  standing: StandingState
  /** Bidder indices still in the auction. */
  activeBidders: number[]
  /** Snapshot of active bidders at the start of the current round (count-based close). */
  activeAtRoundStart: number[]
  /** bidderIndex → their one action this round. Keys are string in Firestore; number-indexed access works. */
  actions: Record<number, RoundAction>
  cumulativeDropouts: number
  droppedBidders: number[]
  /** Set once, on end: each license's final holder + first-price price. */
  terminalAllocation: Record<LicenseId, TerminalHolding> | null
}

export interface ApplyResult {
  ok: boolean
  reason?: string
  minimumRequired?: number
  /** True when this action was the last owed and the round (and maybe the auction) closed. */
  roundClosed: boolean
  state: RoundLoopState
}

/** Round-1 state: all five licenses at reserve 200 / no winner, all bidders active. */
export function openState(bidderIndices: number[]): RoundLoopState {
  const active = [...bidderIndices].sort((a, b) => a - b)
  return {
    status: 'open',
    round: 1,
    standing: initialStanding(),
    activeBidders: active,
    activeAtRoundStart: active,
    actions: {},
    cumulativeDropouts: 0,
    droppedBidders: [],
    terminalAllocation: null,
  }
}

function clone(state: RoundLoopState): RoundLoopState {
  return structuredClone(state)
}

/**
 * Apply one bidder's one action. Validates against the CURRENT round-start standing
 * (bids run Slice-2 validateBid before they are ever recorded), enforces the binding
 * winner rule, and — if this was the last action owed — closes the round.
 * Returns { ok:false, reason } WITHOUT recording on any illegal action.
 */
export function applyAction(state: RoundLoopState, bidderIndex: number, action: RoundAction): ApplyResult {
  if (state.status !== 'open') {
    return { ok: false, reason: 'The auction has ended.', roundClosed: false, state }
  }
  if (!state.activeAtRoundStart.includes(bidderIndex)) {
    return { ok: false, reason: 'You are not an active bidder this round.', roundClosed: false, state }
  }
  if (state.actions[bidderIndex] !== undefined) {
    return { ok: false, reason: 'You have already acted this round.', roundClosed: false, state }
  }

  const winningLicense = winningLicenseOf(bidderIndex, state.standing)
  let recorded: RoundAction

  switch (action.type) {
    case 'bid': {
      if (action.licenseId === undefined || action.amount === undefined) {
        return { ok: false, reason: 'A bid needs a license and an amount.', roundClosed: false, state }
      }
      // VALIDATE BEFORE RESOLUTION — the resolver assumes only-legal bids reach it.
      const v = validateBid({
        bidderIndex,
        bids: [{ licenseId: action.licenseId, amount: action.amount }],
        standing: state.standing,
      })
      if (!v.ok) return { ok: false, reason: v.reason, minimumRequired: v.minimumRequired, roundClosed: false, state }
      recorded = { type: 'bid', licenseId: action.licenseId, amount: action.amount, atMs: action.atMs ?? 0 }
      break
    }
    case 'hold': {
      // Only a provisional winner may hold (keep their standing bid).
      if (winningLicense === null) {
        return { ok: false, reason: 'You hold no license — you must place a bid or drop out.', roundClosed: false, state }
      }
      recorded = { type: 'hold' }
      break
    }
    case 'dropout':
    case 'forced_out': {
      // A provisional winner is BOUND — cannot drop out and cannot be forced out.
      if (winningLicense !== null) {
        const reason =
          action.type === 'forced_out'
            ? `Bidder is currently winning license ${winningLicense} and is bound — a provisional winner cannot be forced out.`
            : `You are currently winning license ${winningLicense} and cannot drop out — bids are binding.`
        return { ok: false, reason, roundClosed: false, state }
      }
      recorded = { type: action.type }
      break
    }
    default:
      return { ok: false, reason: 'Unknown action.', roundClosed: false, state }
  }

  const next = clone(state)
  next.actions[bidderIndex] = recorded

  const allActed = next.activeAtRoundStart.every((b) => next.actions[b] !== undefined)
  if (!allActed) return { ok: true, roundClosed: false, state: next }

  return { ok: true, roundClosed: true, state: closeRound(next) }
}

/** Close the round: resolve the validated bids, carry standing, apply drops, terminate or advance. */
function closeRound(state: RoundLoopState): RoundLoopState {
  // 1. Gather this round's submitted bids (already validated at submit time).
  const roundBids: SaaBid[] = []
  for (const b of state.activeAtRoundStart) {
    const a = state.actions[b]
    if (a.type === 'bid') {
      roundBids.push({ bidderIndex: b, licenseId: a.licenseId as LicenseId, amount: a.amount as number, atMs: a.atMs ?? 0 })
    }
  }

  // 2. Resolve on the validated set (never on an unvalidated bid).
  const newStanding = resolveRound(state.standing, roundBids)

  // 3. Apply drop-outs (dropout + instructor force-out; winners can do neither).
  const droppedThisRound = state.activeAtRoundStart.filter((b) => {
    const t = state.actions[b].type
    return t === 'dropout' || t === 'forced_out'
  })
  const activeBidders = state.activeBidders.filter((b) => !droppedThisRound.includes(b))
  const cumulativeDropouts = state.cumulativeDropouts + droppedThisRound.length
  const droppedBidders = [...state.droppedBidders, ...droppedThisRound]

  const next = clone(state)
  next.standing = newStanding
  next.activeBidders = activeBidders
  next.cumulativeDropouts = cumulativeDropouts
  next.droppedBidders = droppedBidders
  next.actions = {}

  // 4. Termination (cumulative). Two-in-one-round ends here too.
  if (cumulativeDropouts >= TERMINATION_DROPOUTS) {
    next.status = 'ended'
    next.terminalAllocation = computeTerminalAllocation(newStanding)
    next.activeAtRoundStart = activeBidders
    return next
  }

  // 5. Open the next round.
  next.round = state.round + 1
  next.activeAtRoundStart = activeBidders
  return next
}

function computeTerminalAllocation(standing: StandingState): Record<LicenseId, TerminalHolding> {
  const alloc = {} as Record<LicenseId, TerminalHolding>
  for (const l of LICENSE_IDS) {
    alloc[l] = { winnerBidderIndex: standing[l].winnerBidderIndex, standingPrice: standing[l].standingPrice }
  }
  return alloc
}

/**
 * Does the terminal state cleanly give each remaining active bidder exactly one
 * license (supply == demand, bijection)? Surfaced rather than assumed — a degenerate
 * end (an unheld license, or an active bidder holding nothing) is reported, not hidden.
 */
export function terminalBijectionOk(state: RoundLoopState): boolean {
  if (state.status !== 'ended') return false
  const holders = LICENSE_IDS.map((l) => state.standing[l].winnerBidderIndex)
  const allHeld = holders.every((h) => h !== null)
  const distinct = new Set(holders).size === holders.length
  const activeAllHold = state.activeBidders.every((b) => holders.includes(b))
  return allHeld && distinct && activeAllHold && state.activeBidders.length === LICENSE_IDS.length
}

/** Per-active-bidder provisional profit (value of held license − standing bid; 0 if none). */
export function provisionalProfits(state: RoundLoopState): Record<number, number> {
  const out: Record<number, number> = {}
  for (const b of state.activeBidders) out[b] = provisionalProfit(b, state.standing)
  return out
}
