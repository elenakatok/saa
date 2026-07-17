import { type RoleConfig } from '@mygames/game-engine/roles'
import { type OutcomeField, type OutcomeSchema } from '@mygames/game-engine/outcome'

export type { RoleConfig, OutcomeField, OutcomeSchema }

// ── SINGLE ROLE — `bidder` ──────────────────────────────────────────────────────
// SAA has ONE role. A group is 7 identical bidders; the matcher marks one `is_lead`.
// Mirrors functions/src/gameDefinition.ts saaConfig.
export const saaConfig: RoleConfig = {
  roles: [
    { key: 'bidder', label: 'Bidder', short: 'B' },
  ],
}

// ── PLACEHOLDER outcome schema ────────────────────────────────────────────────
// Grading is participation-only, so outcome CONTENT is scoring-irrelevant. The live
// per-license auction (real outcome) is Phase 2. Mirrors gameDefinition.ts saaSchema.
export const saaSchema: OutcomeSchema = [
  { key: 'placeholder_result', type: 'decimal', min: 0, max: 100_000, step: 1 },
  { key: 'notes',              type: 'text' },  // optional free-text; blank = '', excluded from scoring
]

export const FIELD_LABELS: Readonly<Record<string, string>> = {
  placeholder_result: 'Placeholder result',
  notes:              'Notes',
}

export function formatField(field: OutcomeField, value: unknown): string {
  if (field.type === 'integer' || field.type === 'decimal') {
    return typeof value === 'number' ? value.toLocaleString('en-US') : String(value ?? '')
  }
  if (field.type === 'enum')    return String(value ?? '')
  if (field.type === 'boolean') return (value as boolean) ? 'Yes' : 'No'
  return String(value ?? '')
}
