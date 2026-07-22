// ═══════════════════════════════════════════════════════════════════════════════
// SAA — the bot-fill REMAINDER matcher (Phase 3 rule, gameDefinition.ts TODO).
//
// The shared triggerMatching (unchanged) forms floor(n/7) FULL human groups of 7 and
// LEAVES the remainder ungrouped (perRoleCap:7 locks each group at exactly 7). This
// SAA-local, purely-ADDITIVE step picks up those ungrouped eligible humans and forms ONE
// final group padded to 7 with server-side bots (is_bot:true) — so a class whose turnout
// isn't a multiple of 7 can still run. Human matching and human bid behaviour are
// untouched; bots bypass the human eligibility gate by construction (no browser).
//
// Sequence in a live class:
//   n % 7 == 0 → triggerMatching forms all full groups; this is a no-op.
//   n  > 7     → triggerMatching forms floor(n/7) groups; this fills the remainder.
//   n  < 7     → triggerMatching can't form a base group; call THIS directly — it forms
//                the single (humans + bots) group on its own.
//
// SAA-LOCAL now (mirrors the shared matcher's eligibility gate + group-doc shape);
// factor into shared game-server later, across the 3 games.
// ═══════════════════════════════════════════════════════════════════════════════

import { randomUUID } from 'crypto'
import { onCall, HttpsError } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import { FieldValue } from 'firebase-admin/firestore'
import { extractInstructorGameId } from '@mygames/game-server'
import { saaGameDef } from './gameDefinition'

const GROUP_SIZE = 7 // spec §6 (fixed)

export const fillRemainderWithBots = onCall({ cors: saaGameDef.corsOrigins }, async (request) => {
  const data = request.data as Record<string, unknown>
  const isEmulator = process.env.FUNCTIONS_EMULATOR === 'true'
  const authHeader = request.rawRequest.headers.authorization as string | undefined
  const gameInstanceId = await extractInstructorGameId(data, isEmulator, authHeader)

  const db = admin.firestore()
  const instanceRef = db.collection('game_instances').doc(gameInstanceId)

  try {
    // Same human eligibility gate as the shared matcher: attended + valid role + present
    // in RTDB — MINUS anyone already grouped (the full human groups) or a bot.
    const [presenceSnap, participantsSnap] = await Promise.all([
      admin.database().ref(`presence/${gameInstanceId}`).once('value'),
      instanceRef.collection('participants').get(),
    ])
    const presentIds = new Set<string>(Object.keys((presenceSnap.val() ?? {}) as object))

    const ungroupedHumans = participantsSnap.docs
      .filter((doc) => {
        const d = doc.data()
        return (
          d['is_bot'] !== true &&
          d['attendance_confirmed_at'] != null &&
          d['role'] === 'bidder' &&
          presentIds.has(doc.id) &&
          d['group_id'] == null
        )
      })
      .map((doc) => doc.id)

    // Idempotent: nothing ungrouped → nothing to do (already filled, or a clean n%7==0).
    if (ungroupedHumans.length === 0) {
      return { ok: true as const, created: false, reason: 'No ungrouped eligible humans — nothing to fill.' }
    }
    // A full group's worth (or more) of ungrouped humans means shared matching wasn't run
    // (or couldn't). Refuse rather than silently under-group them into one padded 7.
    if (ungroupedHumans.length >= GROUP_SIZE) {
      throw new HttpsError(
        'failed-precondition',
        `${ungroupedHumans.length} ungrouped bidders (≥ ${GROUP_SIZE}). Run triggerMatching first so the full groups form; then fill the remainder.`,
      )
    }

    const humans = ungroupedHumans
    const botsNeeded = GROUP_SIZE - humans.length // 1..6 humans → 6..1 bots
    const groupId = randomUUID()
    const now = FieldValue.serverTimestamp()

    const batch = db.batch()
    const botPids: string[] = []
    for (let i = 0; i < botsNeeded; i++) {
      const botPid = `bot_${groupId.slice(0, 8)}_${i + 1}`
      botPids.push(botPid)
      batch.set(instanceRef.collection('participants').doc(botPid), {
        participant_id: botPid,
        game_instance_id: gameInstanceId,
        role: 'bidder',
        display_name: `Bot ${i + 1}`,
        is_bot: true,
        group_id: groupId,
        is_lead: false,
        // Fully "past setup" so nothing downstream waits on a bot's prep/attendance.
        prep_status: 'complete',
        knowledge_check_score: null,
        attendance_confirmed_at: now,
        confirmed_ready_at: now,
      })
    }

    // Humans first → bidderIndex 1..h, bots h+1..7. openAuction derives each seat's value
    // column from this order; the bot_participants set tells openAuction which are bots.
    const bidderParticipants = [...humans, ...botPids]
    const lead = humans[0] // a HUMAN is always the lead; a bot never leads.

    batch.set(instanceRef.collection('groups').doc(groupId), {
      group_id: groupId,
      game_instance_id: gameInstanceId,
      bidder_participants: bidderParticipants,
      bot_participants: botPids,
      bot_count: botsNeeded,
      lead_participant_id: lead,
      outcome: null,
      status: 'matched',
      matched_at: now,
    })
    for (const pid of humans) {
      batch.update(instanceRef.collection('participants').doc(pid), { group_id: groupId, is_lead: pid === lead })
    }

    await batch.commit()
    return {
      ok: true as const,
      created: true,
      group_id: groupId,
      humans: humans.length,
      bots: botsNeeded,
      bidder_participants: bidderParticipants,
    }
  } catch (err) {
    if (err instanceof HttpsError) throw err
    console.error('[fillRemainderWithBots] error:', err)
    throw new HttpsError('internal', 'Internal error')
  }
})
