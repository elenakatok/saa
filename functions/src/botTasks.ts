// ═══════════════════════════════════════════════════════════════════════════════
// SAA bot scheduling — Cloud Tasks enqueue helper (SAA-local copy of Spectrum's
// auctionLifecycle enqueue pattern). Leaf module: imports only firebase-admin, so
// both saaAuction.ts (round-close re-enqueue) and botRunner.ts can use it with no
// import cycle.
//
// SAA-LOCAL now; factor into shared game-server later across the 3 games.
// ═══════════════════════════════════════════════════════════════════════════════

import { getFunctions } from 'firebase-admin/functions'

/** Randomized think-time window (SAA spec §7 — plausible pacing against real students). */
export const BOT_DELAY_MIN_MS = 30_000
export const BOT_DELAY_MAX_MS = 60_000

/** A randomized bot delay in [30s, 60s]. */
export function botDelayMs(): number {
  return BOT_DELAY_MIN_MS + Math.floor(Math.random() * (BOT_DELAY_MAX_MS - BOT_DELAY_MIN_MS))
}

/** Firestore doc ids are unrestricted, but Cloud Tasks names must be [A-Za-z0-9_-]. */
function sanitize(s: string): string {
  return s.replace(/[^A-Za-z0-9_-]/g, '')
}

/**
 * Enqueue one bot-action pass for (gameInstanceId, groupId, round), scheduled ~30–60s
 * out. Best-effort: a missing/unavailable task queue (e.g. the emulator, which has no
 * Cloud Tasks) must NOT fail the caller — the resolve-on-read backstop + the emulator
 * test trigger cover it. A deterministic task id dedupes repeat enqueues for the same
 * round to a single task.
 */
export async function enqueueBotTask(
  gameInstanceId: string,
  groupId: string,
  round: number,
  delayMs: number = botDelayMs(),
): Promise<void> {
  try {
    const queue = getFunctions().taskQueue('runBotActionsTask')
    await queue.enqueue(
      { game_instance_id: gameInstanceId, group_id: groupId, round },
      {
        scheduleTime: new Date(Date.now() + delayMs),
        id: sanitize(`bots_${gameInstanceId}_${groupId}_r${round}`),
      },
    )
  } catch (err) {
    console.warn('[enqueueBotTask] skipped:', err instanceof Error ? err.message : err)
  }
}
