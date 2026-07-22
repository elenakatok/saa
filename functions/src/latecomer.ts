// SAA latecomer placement (Latecomer_Placement_Spec_v1 §3.1). Wired onto saaGameDef;
// consumed by the shared placeLatecomer via the code-entry path (makeVerifyAttendanceCode).
//
// SAA is the CLEANEST case (see SAA_Latecomer_Placement_Audit.md): the per-bidder value
// column does NOT exist at group creation — it is derived at openAuction from the bidder's
// POSITION in bidder_participants, purely from the locked VALUE_MATRIX. So there is nothing
// to stamp: placeLatecomer's arrayUnion(bidder_participants) + group_id + is_lead is the
// ENTIRE per-member setup, and openAuction assigns the index (and thus the value column)
// later. This game defines ONLY isJoinable and deliberately NO onPlace — a placement-time
// index would be a second, drift-prone source competing with openAuction's array order.

import * as admin from 'firebase-admin'
import type { JoinableContext } from '@mygames/game-server'
// Read-only import (the matrix is NOT modified). BIDDER_INDICES.length is the single
// source of truth for the bidder ceiling: valueFor() hard-throws above the last index,
// so tying the predicate's cap to it means the two can never drift apart.
import { BIDDER_INDICES } from './auction/valueMatrix'

const FIXED_GROUP_SIZE = BIDDER_INDICES.length // 7 (spec §6)

/**
 * Joinable when BOTH:
 *   (a) the auction has FEWER THAN 7 bidders — ctx.participantCount is handed in by
 *       placeLatecomer (= bidder_participants length for this single-role game), so this
 *       costs NO read; and
 *   (b) the auction has NOT started running — the per-group auction state doc
 *       game_instances/{iid}/saa_auction/{group_id} is created ONLY by openAuction
 *       (saaAuction.ts), so its ABSENCE means the auction has not opened.
 *
 * Async (one Firestore existence read, resolved from group.group_id — no RTDB, unlike
 * eBay's clock). The "not running" guard is load-bearing: once openAuction freezes the
 * bidder_index map, a pid added afterward is not in it and every action throws "not a
 * bidder" — so a latecomer who arrives after open must fall through to absent, never be
 * placed into a live auction.
 */
export async function saaIsJoinable(
  group: admin.firestore.DocumentData,
  ctx: JoinableContext,
): Promise<boolean> {
  // (a) room for another bidder — free from the handed-in count.
  if (ctx.participantCount >= FIXED_GROUP_SIZE) return false

  // (b) auction not yet opened — one existence read.
  const groupId = String(group['group_id'] ?? '')
  if (!groupId) return false // defensive: an id-less group cannot be targeted
  const running = (await admin.firestore()
    .collection('game_instances').doc(ctx.gameInstanceId)
    .collection('saa_auction').doc(groupId).get()).exists
  return !running
}
