import { httpsCallable } from 'firebase/functions'
import { FirebaseError } from 'firebase/app'
import { functions } from './firebase'
import type { OutcomeSchema } from './gameConfig'

// ── Helper ────────────────────────────────────────────────────────────────────
// Single wrapper: the Firebase SDK auto-attaches the ID token Bearer when
// auth.currentUser exists, and sends nothing when there is no session —
// covering both bootstrap (getInstructorSession, assignRole) and authed calls.

async function callFn<T>(name: string, data: object = {}): Promise<T> {
  const fn = httpsCallable<object, T>(functions, name)
  const result = await fn(data)
  return result.data
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type TestArgs   = { _test: { participant_id: string; game_instance_id: string } }
export type TokenArgs  = { token: string }
export type BearerArgs = Record<string, never>   // empty — auth is in Authorization header
export type CallArgs   = TestArgs | TokenArgs | BearerArgs

export type OutcomeFields = Record<string, unknown>

export type AssignRoleResult = {
  ok:               boolean
  role:             string
  customToken:      string
  participant_id:   string
  game_instance_id: string
}

export const CLASSROOM_URL = import.meta.env.DEV
  ? 'http://localhost:5173'
  : 'https://classroom.mygames.live'

// onCall auth errors arrive as FirebaseError with code 'functions/permission-denied'
// or 'functions/unauthenticated' — not HTTP status strings.
export function isAuthError(err: unknown): boolean {
  if (!(err instanceof FirebaseError)) return false
  return (
    err.code === 'functions/permission-denied' ||
    err.code === 'functions/unauthenticated'
  )
}

// ── Student API ─────────────────────────────────────────────────────────────────

/** Bootstrap — no session yet; classroom JWT or _test bypass travels in data. */
export const assignRole = (args: CallArgs) =>
  callFn<AssignRoleResult>('assignRole', args)

export const completePrep = (args: CallArgs = {} as BearerArgs) =>
  callFn<{ ok: boolean }>('completePrep', args)

export const confirmReady = (args: CallArgs) =>
  callFn<{ ok: boolean }>('confirmReady', args)

export const verifyAttendanceCode = (args: CallArgs, code: string) =>
  callFn<{ ok: boolean }>('verifyAttendanceCode', { ...args, code })

export const startNegotiation = (args: CallArgs) =>
  callFn<{ ok: boolean }>('startNegotiation', args)

export const submitLeadOutcome = (args: CallArgs, outcome: OutcomeFields | null) =>
  callFn<{ ok: boolean }>('submitLeadOutcome', { ...args, outcome })

export const submitConfirmation = (args: CallArgs, confirmed: boolean) =>
  callFn<{ ok: boolean; outcome: string }>('submitConfirmation', { ...args, confirmed })

// ── Student content callables ─────────────────────────────────────────────────
// The shared @mygames/game-ui components (InfoPage/KnowledgeCheck/PrepQuestions,
// via getInfoUrls) usually invoke these directly through httpsCallable; they are
// exposed + typed here so the game's full callable surface is discoverable.

export type InfoPageLink = { key: string; label: string; url: string }
export type GetInfoUrlsResult = {
  ok:         boolean
  roleLabel:  string
  links:      InfoPageLink[]
  publicLink: { label: string; url: string } | null
}

export const getInfoUrls = () =>
  callFn<GetInfoUrlsResult>('getInfoUrls', {})

export const getStudentPrepQuestions = () =>
  callFn<{ ok: boolean; questions: unknown[] }>('getStudentPrepQuestions', {})

export const getDebriefQuestions = () =>
  callFn<{ ok: boolean; questions: unknown[] }>('getDebriefQuestions', {})

export const submitKnowledgeCheck = (data: object = {}) =>
  callFn<{ ok: boolean }>('submitKnowledgeCheck', data)

export const submitStaticKnowledgeCheckQuestion = (data: object = {}) =>
  callFn<{ ok: boolean; correct?: boolean }>('submitStaticKnowledgeCheckQuestion', data)

// ── Auction API (Phase 2 Slice 3/4 — the bidder screen) ─────────────────────────
// Student-authed; the SDK attaches the Firebase Bearer from the signed-in session.

export type LicenseId = 'A' | 'B' | 'C' | 'D' | 'E'

export type BidderLicenseRow = {
  licenseId:          LicenseId
  yourValue:          number         // the caller's OWN private value for this license
  currentHighBid:     number         // standing price
  currentWinnerIndex: number | null  // revealed (public per §12)
  youAreWinner:       boolean
  minIncrement:       number         // per-license band increment (100/50/25)
  minLegalBidForYou:  number | null  // the caller's min legal bid on this license (null = not allowed)
}

export type TerminalHolding = { winnerBidderIndex: number | null; standingPrice: number }

export type BidderView = {
  ok:                          boolean
  status:                      'open' | 'ended'
  round:                       number
  bidderIndex:                 number
  active:                      boolean
  droppedOut:                  boolean
  hasActedThisRound:           boolean
  isWinner:                    boolean
  winningLicense:              LicenseId | null
  currentBidOnWinningLicense:  number | null
  provisionalProfit:           number
  licenses:                    BidderLicenseRow[]
  activeCount:                 number
  actedCount:                  number
  terminalAllocation:          Record<LicenseId, TerminalHolding> | null
  yourTerminalLicense:         LicenseId | null
  yourTerminalProfit:          number | null
}

export type ActionResult = {
  ok:              boolean
  reason?:         string   // server-authoritative student-facing rejection reason
  minimumRequired?: number
  roundClosed?:    boolean
  status?:         string
  round?:          number
}

export const getBidderView = (groupId: string) =>
  callFn<BidderView>('getBidderView', { group_id: groupId })

export const submitBid = (groupId: string, licenseId: LicenseId, amount: number) =>
  callFn<ActionResult>('submitBid', { group_id: groupId, license_id: licenseId, amount })

export const holdBid = (groupId: string) =>
  callFn<ActionResult>('holdBid', { group_id: groupId })

export const dropOut = (groupId: string) =>
  callFn<ActionResult>('dropOut', { group_id: groupId })

// ── Instructor API ────────────────────────────────────────────────────────────

export type InstructorSessionArgs =
  | { token: string }
  | { _dev: { game_instance_id: string } }

export type RosterParticipant = {
  participant_id: string
  display_name:   string
  role:           string | null
  role_label:     string | null
  group_id:       string | null
  is_lead:        boolean | null
  attended:       boolean
  finalized:      boolean
}

export type RosterGroup = {
  group_id:             string
  status:               string
  lead_participant_id:  string
  participants_by_role: Record<string, string[]>
  agreement_reached:    boolean | null
  outcome:              Record<string, unknown> | null
}

export type PushSummary = {
  total:     number
  succeeded: number
  failed:    { participant_id: string; reason: string }[]
}

/** Bootstrap — no session yet; JWT travels in data; SDK attaches nothing. */
export const getInstructorSession = (args: InstructorSessionArgs) =>
  callFn<{ ok: boolean; customToken: string }>('getInstructorSession', args)

/** Remaining instructor calls: SDK auto-attaches Firebase Bearer when session exists. */
export const syncRoster = () =>
  callFn<{ ok: boolean; synced: number; skipped: number }>('syncRoster', {})

export const generateAttendanceCode = () =>
  callFn<{ ok: boolean; code: string }>('generateAttendanceCode', {})

export const getRoster = () =>
  callFn<{ ok: boolean; participants: RosterParticipant[]; groups: RosterGroup[] }>('getRoster', {})

export const triggerMatching = () =>
  callFn<{ ok: boolean; groups: unknown[]; alreadyMatched?: boolean }>('triggerMatching', {})

export const submitInstructorOutcome = (groupId: string, outcome: OutcomeFields | null) =>
  callFn<{ ok: boolean }>('submitInstructorOutcome', { group_id: groupId, outcome })

export const finalizeInstance = () =>
  callFn<{ ok: boolean }>('finalizeInstance', {})

export const pushResultsToClassroom = () =>
  callFn<{ ok: boolean } & PushSummary>('pushResultsToClassroom', {})

export const scoreAndRecord = () =>
  callFn<{ ok: boolean }>('scoreAndRecord', {})

// ── Instructor auction dashboard (Slice 5) ──────────────────────────────────────
// Instructor-authed (SDK Bearer from the instructor session, like getRoster).

export type InstructorLicenseStanding = {
  licenseId:          LicenseId
  standingPrice:      number
  winnerBidderIndex:  number | null
  winnerName:         string | null
}
export type InstructorBidder = {
  bidderIndex:    number
  participantId:  string
  name:           string
  hasActed:       boolean   // BOOL only — pending bid amount is never sent (sealed-bid)
  active:         boolean
  droppedOut:     boolean
  isWinner:       boolean
  winningLicense: LicenseId | null
}
export type InstructorGroupAuction = {
  groupId:            string
  round:              number
  status:             'open' | 'ended'
  activeCount:        number
  actedCount:         number
  cumulativeDropouts: number
  standing:           InstructorLicenseStanding[]
  bidders:            InstructorBidder[]
  terminalAllocation: InstructorLicenseStanding[] | null
}
export type InstructorAuctionView = { ok: boolean; groups: InstructorGroupAuction[] }

export const getInstructorAuctionView = () =>
  callFn<InstructorAuctionView>('getInstructorAuctionView', {})

export const forceOut = (groupId: string, bidderIndex: number) =>
  callFn<{ ok: boolean; roundClosed?: boolean; status?: string }>('forceOut', { group_id: groupId, bidder_index: bidderIndex })

// ── Config API (SettingsPage) ─────────────────────────────────────────────────

export const getGameConfig = () =>
  callFn<{ ok: boolean; config: Record<string, unknown> }>('getGameConfig', {})

export const updateGameConfig = (config: Record<string, unknown>) =>
  callFn<{ ok: boolean }>('updateGameConfig', { config })

// ── Report API (read-only Reports page) ───────────────────────────────────────

export type ReportRow = {
  participant_id:        string
  display_name:          string
  group_number:          number | null
  group_id:              string | null
  role:                  string
  value_or_cost:         number | null
  raw_score:             number | null
  knowledge_check_score: number | null
  text_answers:          Record<string, string>
  outcome:               Record<string, unknown> | null
}

export type ReportQuestionMeta = { field: string; prompt: string; role_target: string }

export type GetReportDataResult = {
  ok:        boolean
  rows:      ReportRow[]
  questions: ReportQuestionMeta[]
  schema:    OutcomeSchema
}

export const getReportData = () =>
  callFn<GetReportDataResult>('getReportData', {})
