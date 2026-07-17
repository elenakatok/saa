import { onRequest } from 'firebase-functions/v2/https'
import * as admin from 'firebase-admin'
import {
  makeGetInstructorSession,
  makeAssignRole,
  makeCompletePrep,
  makeConfirmReady,
  makeGenerateAttendanceCode,
  makeVerifyAttendanceCode,
  makeGetRoster,
  makeSyncRoster,
  makeTriggerMatching,
  makeStartNegotiation,
  makeSubmitLeadOutcome,
  makeSubmitConfirmation,
  makeSubmitInstructorOutcome,
  makeFinalizeInstance,
  makePushResultsToClassroom,
  makeGetGameConfig,
  makeUpdateGameConfig,
  makeGetStudentPrepQuestions,
  makeGetDebriefQuestions,
  makeSubmitKnowledgeCheck,
  makeSubmitStaticKnowledgeCheckQuestion,
  makeGetInfoUrls,
} from '@mygames/game-server'
import { saaGameDef } from './gameDefinition'

admin.initializeApp()

// SAA Part 1 (SKELETON). Single-role KC gate ('kc_gate_bidder', grading 'assigned_role')
// + 12 graded statics (SAA_KC_Questions_v1.md — see gameDefinition prepDefaults). The
// outcome path is the GENERIC lead/confirm flow (submitLeadOutcome → submitConfirmation),
// with a PLACEHOLDER outcome — the live per-license auction is Phase 2 and is NOT wired
// here (no startAuction/submitBid/endowment machinery). Grading is participation-only.

// ── Game endpoints (onCall, via game-server factories + SAA definition) ─────────

export const getInstructorSession  = makeGetInstructorSession(saaGameDef)
export const assignRole             = makeAssignRole(saaGameDef)
export const completePrep           = makeCompletePrep(saaGameDef)
export const confirmReady           = makeConfirmReady(saaGameDef)
export const generateAttendanceCode = makeGenerateAttendanceCode(saaGameDef)
export const verifyAttendanceCode   = makeVerifyAttendanceCode(saaGameDef)
export const getRoster              = makeGetRoster(saaGameDef)
export const syncRoster             = makeSyncRoster(saaGameDef)
export const triggerMatching            = makeTriggerMatching(saaGameDef)
export const startNegotiation           = makeStartNegotiation(saaGameDef)
export const submitLeadOutcome          = makeSubmitLeadOutcome(saaGameDef)
export const submitConfirmation         = makeSubmitConfirmation(saaGameDef)
export const submitInstructorOutcome    = makeSubmitInstructorOutcome(saaGameDef)
export const finalizeInstance       = makeFinalizeInstance(saaGameDef)
export const pushResultsToClassroom = makePushResultsToClassroom(saaGameDef)
export const getGameConfig          = makeGetGameConfig(saaGameDef)
export const updateGameConfig       = makeUpdateGameConfig(saaGameDef)
export const getStudentPrepQuestions            = makeGetStudentPrepQuestions(saaGameDef)
export const getDebriefQuestions                = makeGetDebriefQuestions(saaGameDef)
export const submitKnowledgeCheck               = makeSubmitKnowledgeCheck(saaGameDef)
export const submitStaticKnowledgeCheckQuestion = makeSubmitStaticKnowledgeCheckQuestion(saaGameDef)
export const getInfoUrls                        = makeGetInfoUrls(saaGameDef)
export { getReportData } from './getReportData'
export { scoreAndRecord } from './scoreAndRecord'

// ── Phase 2 Slice 3: the round-loop state machine (Firestore-backed callables) ──
// Stateful shell over the pure Slice-1/2 core (validate → resolve, server-authoritative
// round close). Bidder screen (Slice 4), instructor dashboard (Slice 5), and grading
// (Slice 6) are not built yet.
export { openAuction, submitBid, holdBid, dropOut, forceOut, getAuctionState, getBidderView } from './saaAuction'

// ── Non-game onRequest endpoints ────────────────────────────────────────────────

const CORS_ORIGINS = new Set(['https://saa.mygames.live'])

export const health = onRequest((req, res) => {
  const origin = req.headers.origin ?? ''
  if (CORS_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin)
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.set('Vary', 'Origin')
  }
  if (req.method === 'OPTIONS') { res.status(204).send(''); return }
  res.json({ ok: true, game: 'saa' })
})

// Emulator-only dev seed functions — onRequest, not game endpoints. Kept LOCKED
// (each returns 404 unless FUNCTIONS_EMULATOR==='true').
export { seedMatchTest, seedGroupForTest } from './seedFunctions'
