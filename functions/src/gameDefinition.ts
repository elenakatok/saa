import type { Outcome, OutcomeSchema, RoleConfig } from '@mygames/game-engine'
import type { GameDefinition, PrepTextQuestion } from '@mygames/game-server'

// ═══════════════════════════════════════════════════════════════════════════════
// SAA — Simultaneous Ascending Auction — SINGLE-ROLE game (Part 1: SKELETON).
//
// There is ONE role: `bidder`. Part 1 stands up the generic platform skeleton on
// SAA's real identity (game_id, single-role bidder gate, fixed group of 7,
// participation-only grading) plus the REAL, approved Knowledge Check. Everything
// auction-specific is a LATER PHASE and is deliberately NOT here:
//   • Phase 2 (human-only game): round loop, activity rule ("use-it-or-lose-it"),
//     endogenous termination (auction ends when the 2nd non-winner drops out), the
//     §1.1 value matrix, sealed-round bidding, and the real bidder screen. The pure
//     resolver is already extracted (@mygames/game-engine/auction) and consumed by
//     functions/src/roundResolution.ts (Phase-1 extraction) — Phase 2 builds the
//     round loop AROUND it. NOT built here.
//   • Phase 3 (bots): a dominant-strategy bot engine + bot-fill matching. NOT here.
//
// GRADING (spec §13): PARTICIPATION + KC only. PROFIT IS NEVER GRADED. Same model as
// eBay. computeScoreBreakdown returns a FLAT participation point for every present
// bidder regardless of outcome, so the single-role z-score pool is intentionally
// DEGENERATE (sample SD 0 → every present student normalizes to 0); true no-shows
// are handled by the engine (status no_show → −2), never here.
//
// KC (real content, SAA_KC_Questions_v1.md): a single-option role gate ("What is your
// role?" → Bidder, always true for the single role) plus 12 graded MC (5 rules Q1–Q5,
// 7 article Q6–Q12; key B·A·C·B·C·B·A·C·B·C·A·B). The shared KC flow is gate-driven at
// BOTH ends (the KnowledgeCheck UI needs a gate to render; the graded-static submit
// needs the gate's completed_at marker), so the gate is REQUIRED. KC score = correct
// statics / 12 (the shared grader counts grading:'static' dynamically — no hardcoded
// denominator). Options shuffle per student; grading is content-keyed (option value),
// never a letter/position; explanations name the concept, never a slot.
// ═══════════════════════════════════════════════════════════════════════════════

// ── Role config (ONE role — `bidder`) ─────────────────────────────────────────

export const saaConfig: RoleConfig = {
  roles: [
    { key: 'bidder', label: 'Bidder', short: 'B' },
  ],
}

// ── Outcome schema (PLACEHOLDER — replaced by the live auction in Phase 2) ──────
// Grading is participation-only, so the outcome CONTENT never affects the score; this
// is a dummy field that just lets the generic outcome form + finalize path run.
export const saaSchema: OutcomeSchema = [
  { key: 'placeholder_result', type: 'decimal', min: 0, max: 100000, step: 1 }, // dummy; scoring ignores it
  { key: 'notes', type: 'text' }, // optional free-text; blank = '', excluded from scoring
]

// ── Score sense (value-sense) ──────────────────────────────────────────────────

export const saaScoreSense: Record<string, 'value' | 'cost'> = {
  bidder: 'value',
}

// ── Scoring (spec §13 — PARTICIPATION only; profit NEVER graded) ────────────────
// Every PRESENT bidder earns the SAME flat participation point (1), independent of the
// outcome. Deliberate (spec §13): the single-role z-score pool is DEGENERATE (sample
// SD = 0 → the engine's zero-SD guard normalizes every present student to 0). A
// "suspiciously uniform" report is CORRECT, not broken. A true no-show (no role / never
// matched) is handled by the engine (status no_show → raw null, z = −2), not here.
// The `outcome` argument is intentionally ignored — reading it into the grade would be
// exactly the leak §13 forbids.

export function computeScoreBreakdown(
  roleKey: string,
  _outcome: Outcome | null,
  _configData?: Record<string, unknown>,
): { value_or_cost: number; raw_score: number } {
  if (roleKey === 'bidder') return { value_or_cost: 1, raw_score: 1 }
  return { value_or_cost: 0, raw_score: 0 }
}

export function computeRawScore(
  roleKey: string,
  outcome: Outcome | null,
  configData?: Record<string, unknown>,
): number {
  return computeScoreBreakdown(roleKey, outcome, configData).raw_score
}

// ── Graded-KC data-object helper ──────────────────────────────────────────────
// Every graded static question is a DATA OBJECT built via gq() (the admin-defaults
// screen is a future addition and must stay small — never hand-write inline literals).
// grading 'static' + a locked correct_value keyed to option CONTENT (value), never a
// letter position (getStudentPrepQuestions shuffles the options per student).
const gq = (
  field: string, order: number, correct_value: string,
  prompt: string, options: { value: string; label: string }[], explanation: string,
): PrepTextQuestion => ({
  field, type: 'mc', system: false, category: 'knowledge_check', format: 'multiple_choice',
  grading: 'static', correct_value, role_target: 'bidder', prompt,
  placeholder: '', order, hidden: false, deletable: false, options, explanation,
})

// ── GameDefinition ────────────────────────────────────────────────────────────

export const saaGameDef: GameDefinition = {
  game_id: 'saa',
  roles:   saaConfig,
  scoreSense: saaScoreSense,

  // ⚠ FIXED group size 7 (spec §6). The design — 5 licenses, 7 bidders, 2 drop-outs —
  // depends structurally on 7. This is the OPPOSITE of eBay's 4→7 flex.
  //   • composition {bidder:7} sets the base group to 7.
  //   • perRoleCap:7 EQUAL to composition LOCKS each group at exactly 7 — no flex.
  //     (Omitting perRoleCap would make the cap = eligible.length, letting one group
  //     absorb the remainder ABOVE 7 — expansion we do NOT want. See
  //     game-server makeTriggerMatching.resolvePerRoleCap.)
  // Leftover students (turnout not a multiple of 7) are simply not placed in Part 1.
  // TODO Phase 3 — the real matching rule: floor(n/7) full HUMAN groups of 7; the
  //   remainder becomes ONE final group, bot-filled to 7, with bot valuations assigned
  //   in bidder-number order 1,2,3,…. Implement via remnantGroup + a bot-fill matcher.
  //   NOT built in Part 1.
  // TODO Phase 3 — bots themselves: dominant-strategy engine, 30–60s randomized pacing,
  //   drop-out like a human. Brand-new capability, built last. NOT built in Part 1.
  composition: { bidder: 7 },
  perRoleCap: 7,
  // deadlockThreshold omitted → factory defaults to 5.

  outcomeSchema: saaSchema,
  computeRawScore,
  computeScoreBreakdown,
  // reservations: PLACEHOLDER — real bidder valuations arrive with the auction (Phase 2).
  reservations: { bidder: 0 },
  corsOrigins: ['https://saa.mygames.live'],
  classroom: { callbackSecretId: 'saa_v1' },

  // Settings page config fields (ONE role — `bidder`). Real bidder case sheet is a
  // PLACEHOLDER PDF for Part 1; Elena supplies the real sheet in Phase 2.
  configFields: [
    { key: 'bidder_role_name', kind: 'string', default: 'Bidder' },
    { key: 'bidder_sheet_url', kind: 'url',    default: '/role-info/saa.pdf' },
  ],

  // Info page links — keys must appear in configFields above.
  roleInfoLinks: [
    { roleKey: 'bidder', links: [{ key: 'bidder_sheet_url', label: 'Role sheet' }] },
  ],

  // ── prepDefaults: KC gate + 12 graded statics ─────────────────────────────────
  // AUTHORITY: SAA_KC_Questions_v1.md (approved). Gate (Q0) is a single-option role
  // question — SAA has ONE role, so "Bidder" is always the true answer and it passes on
  // the first click; graded 'assigned_role' (server-side, against the real role), NOT
  // part of the KC score. Q1–Q12 are graded MC via gq() as DATA OBJECTS:
  //   • Q1–Q5  the SAA rules and procedures (Katok, 2019)
  //   • Q6–Q12 the Binmore & Klemperer UK 3G article (2002)
  // KC score = correct statics / 12 (the shared grader counts grading:'static'
  // dynamically — no hardcoded denominator). Answer key B·A·C·B·C·B·A·C·B·C·A·B.
  // Q5–Q9 double as a rules-correctness SPEC for Phase 2: if the built auction
  // contradicts any of these answers, the game is wrong, not the key.
  prepDefaults: [
    // ── Q0: role gate (system, ungraded — single option; always passes) ──────────
    {
      field: 'kc_gate_bidder', type: 'mc', system: true,
      category: 'knowledge_check', format: 'multiple_choice',
      grading: 'assigned_role', role_target: 'bidder',
      prompt: 'What is your role in this auction?',
      placeholder: '', order: 0, hidden: false, deletable: false,
      options: [
        { value: 'bidder', label: 'Bidder' },
      ],
      explanation: 'You are a Bidder in the simultaneous ascending auction.',
    },

    // ── Part I — Rules and Procedures (Q1–Q5) ─────────────────────────────────────
    gq('kc_bid_one_license', 1, 'exactly_one',
      'In each round of the auction, you may place a bid on:',
      [
        { value: 'as_many',     label: 'as many licenses as you wish.' },
        { value: 'exactly_one', label: 'exactly one license.' },
        { value: 'not_winning', label: 'every license you are not already winning.' },
        { value: 'any_two',     label: 'any two licenses.' },
      ],
      'Each bidder submits a bid on a single license per round. The whole strategic problem — where to go given where everyone else went — exists precisely because you can commit to only one license at a time.'),

    gq('kc_increment_decreases', 2, 'decreases',
      'The minimum bid increment required to raise the price on a license:',
      [
        { value: 'decreases',   label: 'decreases as the auction goes on.' },
        { value: 'increases',   label: 'increases as the auction goes on.' },
        { value: 'stays_same',  label: 'stays the same in every round.' },
        { value: 'chosen_free', label: 'is chosen freely by each bidder.' },
      ],
      'The required increment is announced each round and shrinks as prices climb (100, then 50, then 25). Big early steps move prices quickly; smaller later steps let bidders fine-tune near their values.'),

    gq('kc_provisional_renew', 3, 'renew_no_switch',
      'If you are the provisional winner on a license at the start of a round, you are:',
      [
        { value: 'must_raise',      label: 'required to raise your own bid to stay in.' },
        { value: 'may_switch',      label: 'allowed to switch and bid on a different license instead.' },
        { value: 'renew_no_switch', label: 'allowed to renew at the same bid level, but not to switch to a different license.' },
        { value: 'auto_dropped',    label: 'automatically dropped from the auction.' },
      ],
      "A provisional winner's bid carries forward and may simply be renewed at the same level — they need not raise it. But a provisional winner may not switch which license they are bidding on; that lock is what keeps a winning position binding."),

    gq('kc_use_it_or_lose_it', 4, 'drops_out',
      'Under the "use-it-or-lose-it" rule, a bidder who does not place a bid in a round:',
      [
        { value: 'keeps_place', label: 'keeps their place and may bid again next round.' },
        { value: 'drops_out',   label: 'drops out of the auction and cannot bid in any future round.' },
        { value: 'penalty',     label: 'is charged a penalty but stays active.' },
        { value: 'wins_cheap',  label: 'automatically wins the cheapest remaining license.' },
      ],
      'You must bid every round or you are out — permanently. This activity rule is what makes the auction end on its own: it forces every bidder to either stay engaged or exit for good.'),

    gq('kc_auction_ends', 5, 'nonwinners_dropped',
      'The auction ends when:',
      [
        { value: 'fixed_rounds',       label: 'a fixed number of rounds has been completed.' },
        { value: 'all_bid_once',       label: 'every license has been bid on at least once.' },
        { value: 'nonwinners_dropped', label: 'all bidders who are not provisional winners have dropped out.' },
        { value: 'auctioneer_closes',  label: 'the auctioneer decides to close it.' },
      ],
      'Termination is endogenous: once every non-provisional-winner has dropped out, no one is left to raise a price, so the auction stops. The provisional winners then win at the price of their standing bids. There is no clock and no fixed round count.'),

    // ── Part II — The Binmore & Klemperer article (Q6–Q12) ────────────────────────
    gq('kc_one_licence_max', 6, 'more_than_one',
      'To promote competition, the UK 3G auction rule was that no bidder could win:',
      [
        { value: 'more_than_one', label: 'more than one licence.' },
        { value: 'fewer_than_two', label: 'fewer than two licences.' },
        { value: 'smaller_ones',   label: 'any of the smaller licences.' },
        { value: 'unless_entrant', label: 'a licence unless they were a new entrant.' },
      ],
      'Holding each bidder to at most one licence spread the spectrum across more firms and sharpened competition. It is also the rule that makes every bidder simply a winner or a loser, with no middle ground to bargain over.'),

    gq('kc_top_priority_efficiency', 7, 'efficiency',
      "The government's stated top priority for the auction was to:",
      [
        { value: 'revenue',         label: 'raise as much revenue as possible.' },
        { value: 'protect_2g',      label: 'protect the incumbent 2G operators.' },
        { value: 'efficiency',      label: 'assign the spectrum efficiently — to the bidders who valued it most.' },
        { value: 'sell_fast',       label: 'sell the licences as quickly as possible.' },
      ],
      'Efficiency took priority over revenue: the aim was to place licences with the operators who had the best business plans, who generally value the spectrum most. Revenue was expected to follow from competition rather than being the target itself.'),

    gq('kc_simple_strategy_gap', 8, 'greatest_gap',
      'According to the article, the simple recommended bidding strategy is, in each round, to bid the minimum raise on the licence with:',
      [
        { value: 'highest_price', label: 'the highest current price.' },
        { value: 'lowest_price',  label: 'the lowest current price.' },
        { value: 'greatest_gap',  label: "the greatest gap between the bidder's value and the minimum required bid." },
        { value: 'fewest_rivals', label: 'the fewest competing bidders.' },
      ],
      'Never raise by more than the minimum, and always pick the licence where your value most exceeds the required bid — the biggest remaining surplus. Chasing raw price level or headcount ignores where your profit actually is.'),

    gq('kc_collusion_winner_loser', 9, 'no_middle_ground',
      'Why does restricting each bidder to at most one licence make collusion harder?',
      [
        { value: 'divide_advance',   label: 'It lets bidders divide the licences among themselves in advance.' },
        { value: 'no_middle_ground', label: 'Every bidder is either a winner or a loser, with no middle ground to bargain over.' },
        { value: 'guarantees_revenue', label: 'It guarantees the government the highest possible revenue.' },
        { value: 'removes_activity', label: 'It removes the need for an activity rule.' },
      ],
      'With one licence each, there is no partial allocation to trade — a bidder is simply in or out. That all-or-nothing structure leaves nothing to split, which is exactly what makes a collusive deal hard to sustain.'),

    gq('kc_five_licences', 10, 'five_instead_of_four',
      'The auction switched to a simultaneous ascending design (rather than the Anglo-Dutch design) once it was learned that:',
      [
        { value: 'four_only',            label: 'only four licences could be offered.' },
        { value: 'resale_permitted',     label: 'resale of licences would be permitted.' },
        { value: 'five_instead_of_four', label: 'five licences could be made available instead of four.' },
        { value: 'incumbents_dropped',   label: 'the incumbents had dropped out.' },
      ],
      'When engineering advice changed and five licences (against only four incumbents) became available, the entry problem eased — a new entrant was guaranteed a licence — so the team advised the simpler simultaneous ascending design over the Anglo-Dutch hybrid built to protect entry.'),

    gq('kc_horses_for_courses', 11, 'tailored',
      'The authors\' central "horses for courses" lesson about auction design is that:',
      [
        { value: 'tailored',       label: 'an auction design must be tailored to its specific circumstances, not taken off the shelf.' },
        { value: 'copy_exactly',   label: 'the same proven design should be copied exactly in every country.' },
        { value: 'revenue_first',  label: 'revenue should always be the primary goal.' },
        { value: 'sealed_superior', label: 'sealed-bid auctions are always superior to ascending ones.' },
      ],
      'The bad mistake is taking a design off the shelf. Each environment — its bidders, entry conditions, and number of licences — needs a design fitted to it. One size does not fit all.'),

    gq('kc_entry_incumbents', 12, 'entry_incumbents',
      'A recurring concern the authors emphasize as more important than the informational issues auction theory usually focuses on is:',
      [
        { value: 'high_reserve',      label: 'setting the reserve price as high as possible.' },
        { value: 'entry_incumbents',  label: 'attracting entry and dealing with the advantage held by incumbents.' },
        { value: 'run_slowly',        label: 'running the auction as slowly as possible.' },
        { value: 'allow_withdrawal',  label: 'allowing bidders to withdraw their bids.' },
      ],
      'The authors stress industrial-organisation issues — above all attracting entrants against advantaged incumbents, and handling alliances and mergers — as mattering more in practice than the informational subtleties auction theory usually emphasizes.'),
  ],

  // Legacy stub fields — must be present but content is served via prepDefaults above.
  content: {
    infoPDFs:      {} as Record<string, { private: string; public?: string }>,
    kcQuestions:   [],
    prepQuestions: [],
    scenarioText:  {},
  },
}
