import { useEffect, useRef, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { db } from '../firebase'
import { submitLeadOutcome, submitConfirmation, type CallArgs } from '../api'
import {
  SchemaField,
  parseForm,
  defaultFormValues,
  OutcomeCard,
  type OutcomeFormValues,
  type OutcomeFormLabels,
} from '@mygames/game-ui'
import {
  saaConfig,
  saaSchema,
  FIELD_LABELS,
  formatField,
} from '../gameConfig'

// ── Types ─────────────────────────────────────────────────────────────────────

type Confirmation = 'pending' | 'confirmed' | 'rejected'
type OutcomeFields = Record<string, unknown>

// SINGLE ROLE — the group holds `bidder_participants` (fieldFor('bidder','participants')).
// The lead reports; the other 6 bidders confirm. No second-role branching.
type GroupData = {
  status: string
  lead_outcome: OutcomeFields | null
  // Firestore Timestamp or null — we only check truthiness (non-null = submitted)
  lead_reported_at: object | null
  confirmations: Record<string, Confirmation>
  lead_participant_id: string
  reset_count: number | undefined
  agreement_reached: boolean | null
}

type Props = {
  groupId: string
  participantId: string
  gameInstanceId: string
  isLead: boolean
  args: CallArgs
  onComplete: () => void
}

// The one role's display label ('Bidder').
const ROLE_LABEL = saaConfig.roles[0].label

// Injected label/format hooks for the shared OutcomeForm helpers.
const OUTCOME_LABELS: OutcomeFormLabels = {
  fieldLabel:  (key) => FIELD_LABELS[key] ?? key,
  formatValue: (field, value) => formatField(field, value),
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function OutcomeReporting({
  groupId,
  participantId,
  gameInstanceId,
  isLead,
  args,
  onComplete,
}: Props) {
  const [groupData,     setGroupData]     = useState<GroupData | null>(null)
  const [formValues,    setFormValues]    = useState<OutcomeFormValues>(() => defaultFormValues(saaSchema))
  const [pendingDeal,   setPendingDeal]   = useState<OutcomeFields | null>(null)
  const [pendingNoDeal, setPendingNoDeal] = useState(false)
  const [submitting,    setSubmitting]    = useState(false)
  const [formError,     setFormError]     = useState<string | null>(null)
  const [actionError,   setActionError]   = useState<string | null>(null)

  const calledComplete  = useRef(false)
  const onCompleteRef   = useRef(onComplete)
  onCompleteRef.current = onComplete

  // ── Firestore snapshot ──────────────────────────────────────────────────────
  useEffect(() => {
    return onSnapshot(
      doc(db, 'game_instances', gameInstanceId, 'groups', groupId),
      snap => {
        if (!snap.exists()) return
        const d = snap.data() as GroupData
        setGroupData(d)
        if (d.status === 'completed' && !calledComplete.current) {
          calledComplete.current = true
          onCompleteRef.current()
        }
        // After a reset, clear form so lead can re-enter cleanly
        if (d.lead_reported_at == null && d.status === 'reporting') {
          setFormValues(defaultFormValues(saaSchema))
          setFormError(null)
          setActionError(null)
          setPendingDeal(null)
          setPendingNoDeal(false)
        }
      },
    )
  }, [groupId, gameInstanceId])

  // ── Shared submit wrapper ────────────────────────────────────────────────────
  const withSubmit = (fn: () => Promise<unknown>) => {
    setSubmitting(true)
    setActionError(null)
    fn()
      .catch((err: unknown) => {
        setActionError(err instanceof Error ? err.message : 'Something went wrong.')
      })
      .finally(() => setSubmitting(false))
  }

  // ── Lead handlers ─────────────────────────────────────────────────────────
  const handleFieldChange = (key: string, v: string | boolean) => {
    setFormValues(prev => ({ ...prev, [key]: v }))
    setFormError(null)
  }

  const handleSubmitForm = () => {
    const result = parseForm(formValues, saaSchema, OUTCOME_LABELS)
    if (!result.ok) { setFormError(result.error); return }
    setPendingDeal(result.outcome)
    setFormError(null)
  }

  const handleNoDeal = () => {
    setPendingNoDeal(true)
    setFormError(null)
    setActionError(null)
  }

  const handleCancelPending = () => {
    setPendingDeal(null)
    setPendingNoDeal(false)
  }

  const handleConfirmDeal = () => {
    const outcome = pendingDeal
    setPendingDeal(null)
    withSubmit(() => submitLeadOutcome(args, outcome))
  }

  const handleConfirmNoDeal = () => {
    setPendingNoDeal(false)
    withSubmit(() => submitLeadOutcome(args, null))
  }

  // ── Non-lead handlers ─────────────────────────────────────────────────────
  const handleConfirm = () => withSubmit(() => submitConfirmation(args, true))
  const handleReject  = () => withSubmit(() => submitConfirmation(args, false))

  // ── Loading ─────────────────────────────────────────────────────────────────
  if (!groupData) {
    return <main style={mainStyle}><p>Loading…</p></main>
  }

  const { status, lead_outcome, lead_reported_at, confirmations } = groupData
  const resetCount = groupData.reset_count ?? 0

  const confirmedCount = Object.values(confirmations ?? {}).filter(v => v === 'confirmed').length
  const totalCount     = Object.keys(confirmations ?? {}).length

  // ── Deadlock ─────────────────────────────────────────────────────────────────
  if (status === 'deadlocked') {
    return (
      <main style={mainStyle}>
        <p style={subtitleStyle}>You are a {ROLE_LABEL}</p>
        <h1 style={h1Style}>Instructor intervention needed</h1>
        <p style={{ fontSize: '1.05rem', lineHeight: 1.6, color: '#555' }}>
          Your group could not agree after several attempts. Your instructor will enter the outcome manually.
          Stay on this screen.
        </p>
      </main>
    )
  }

  // ── Completed ─────────────────────────────────────────────────────────────────
  if (status === 'completed') {
    return (
      <main style={mainStyle}>
        <p style={subtitleStyle}>You are a {ROLE_LABEL}</p>
        <h1 style={h1Style}>Outcome locked</h1>
        {groupData.agreement_reached && lead_outcome != null ? (
          <OutcomeCard schema={saaSchema} outcome={lead_outcome} labels={OUTCOME_LABELS} />
        ) : (
          <p style={{ fontSize: '1.05rem', color: '#555' }}>No deal reached.</p>
        )}
      </main>
    )
  }

  // ── Lead view ─────────────────────────────────────────────────────────────────
  if (isLead) {
    // Confirm dialog — deal
    if (pendingDeal != null) {
      return (
        <main style={mainStyle}>
          <p style={subtitleStyle}>You are a {ROLE_LABEL} (group lead)</p>
          <h1 style={h1Style}>Confirm outcome</h1>
          <p style={{ marginBottom: '0.5rem', fontSize: '0.95rem', color: '#555' }}>You entered:</p>
          <OutcomeCard schema={saaSchema} outcome={pendingDeal} labels={OUTCOME_LABELS} />
          <p style={{ marginBottom: '1rem', fontSize: '0.95rem' }}>Is that correct?</p>
          {actionError && <p style={errorStyle}>{actionError}</p>}
          <div style={btnRowStyle}>
            <button onClick={handleConfirmDeal} disabled={submitting}>
              {submitting ? 'Submitting…' : 'Yes, submit'}
            </button>
            <button onClick={handleCancelPending} disabled={submitting} style={ghostBtnStyle}>
              No, go back
            </button>
          </div>
        </main>
      )
    }

    // Confirm dialog — no deal
    if (pendingNoDeal) {
      return (
        <main style={mainStyle}>
          <p style={subtitleStyle}>You are a {ROLE_LABEL} (group lead)</p>
          <h1 style={h1Style}>Confirm no deal</h1>
          <p style={{ marginBottom: '1rem' }}>
            Submit <strong>no deal</strong> — confirm your group did not record a result?
          </p>
          {actionError && <p style={errorStyle}>{actionError}</p>}
          <div style={btnRowStyle}>
            <button onClick={handleConfirmNoDeal} disabled={submitting}>
              {submitting ? 'Submitting…' : 'Yes, no deal'}
            </button>
            <button onClick={handleCancelPending} disabled={submitting} style={ghostBtnStyle}>
              No, go back
            </button>
          </div>
        </main>
      )
    }

    // Submitted — waiting for group confirmations
    if (lead_reported_at != null) {
      return (
        <main style={mainStyle}>
          <p style={subtitleStyle}>You are a {ROLE_LABEL} (group lead)</p>
          <h1 style={h1Style}>Waiting for your group</h1>
          {lead_outcome != null
            ? <OutcomeCard schema={saaSchema} outcome={lead_outcome} labels={OUTCOME_LABELS} />
            : <p style={{ fontSize: '1.05rem', marginBottom: '1rem' }}>You reported: <strong>No deal</strong></p>}
          <p style={{ color: '#555' }}>
            {confirmedCount} of {totalCount} group member{totalCount !== 1 ? 's' : ''} confirmed.
          </p>
          {actionError && <p style={errorStyle}>{actionError}</p>}
        </main>
      )
    }

    // Entry form
    return (
      <main style={mainStyle}>
        <p style={subtitleStyle}>You are a {ROLE_LABEL} (group lead)</p>
        <h1 style={h1Style}>Record placeholder result</h1>
        <div style={placeholderNoticeStyle}>
          The live simultaneous ascending auction runs here in Phase 2. For now, record a
          placeholder result to complete the round.
        </div>
        {resetCount > 0 && (
          <div style={resetBannerStyle}>
            A group member disagreed — coordinate and re-enter the result.
          </div>
        )}
        <div style={{ marginBottom: '1rem' }}>
          {saaSchema.map(field => (
            <SchemaField
              key={field.key}
              field={field}
              value={formValues[field.key] ?? (field.type === 'boolean' ? false : '')}
              onChange={v => handleFieldChange(field.key, v)}
              disabled={submitting}
              labels={OUTCOME_LABELS}
            />
          ))}
        </div>
        {formError   && <p style={errorStyle}>{formError}</p>}
        {actionError && <p style={errorStyle}>{actionError}</p>}
        <div style={btnRowStyle}>
          <button onClick={handleSubmitForm} disabled={submitting}>
            Review &amp; submit
          </button>
          <button onClick={handleNoDeal} disabled={submitting} style={ghostBtnStyle}>
            No deal
          </button>
        </div>
      </main>
    )
  }

  // ── Non-lead view ─────────────────────────────────────────────────────────────

  // Waiting for lead to submit (or post-reset waiting)
  if (lead_reported_at == null) {
    return (
      <main style={mainStyle}>
        <p style={subtitleStyle}>You are a {ROLE_LABEL}</p>
        <h1 style={h1Style}>Waiting for the outcome</h1>
        <p style={{ fontSize: '1.05rem', lineHeight: 1.6, color: '#555' }}>
          {resetCount > 0
            ? 'A disagreement was logged. The lead is re-entering the result.'
            : 'Your group lead is reporting the result. Stay on this page.'}
        </p>
      </main>
    )
  }

  const myConf = confirmations[participantId]

  // Pending: show outcome for review
  if (myConf === 'pending') {
    return (
      <main style={mainStyle}>
        <p style={subtitleStyle}>You are a {ROLE_LABEL}</p>
        <h1 style={h1Style}>Confirm the outcome</h1>
        {lead_outcome != null ? (
          <>
            <p style={{ marginBottom: '0.5rem', fontSize: '0.95rem', color: '#555' }}>
              Your lead reported:
            </p>
            <OutcomeCard schema={saaSchema} outcome={lead_outcome} labels={OUTCOME_LABELS} />
          </>
        ) : (
          <p style={{ fontSize: '1.05rem', marginBottom: '1rem' }}>
            Your lead reported: <strong>No deal</strong>
          </p>
        )}
        <p style={{ color: '#555', marginBottom: '1.5rem' }}>Does this match your group?</p>
        {actionError && <p style={errorStyle}>{actionError}</p>}
        <div style={btnRowStyle}>
          <button onClick={handleConfirm} disabled={submitting}>
            {submitting ? '…' : 'Confirm'}
          </button>
          <button onClick={handleReject} disabled={submitting} style={ghostBtnStyle}>
            Reject
          </button>
        </div>
      </main>
    )
  }

  // Already responded — waiting for others
  return (
    <main style={mainStyle}>
      <p style={subtitleStyle}>You are a {ROLE_LABEL}</p>
      <h1 style={h1Style}>Waiting for your group</h1>
      {lead_outcome != null
        ? <OutcomeCard schema={saaSchema} outcome={lead_outcome} labels={OUTCOME_LABELS} />
        : <p style={{ fontSize: '1.05rem', marginBottom: '1rem' }}>You confirmed: <strong>No deal</strong></p>}
      <p style={{ color: '#555' }}>
        {confirmedCount} of {totalCount} member{totalCount !== 1 ? 's' : ''} confirmed.
      </p>
    </main>
  )
}

// ── Styles ────────────────────────────────────────────────────────────────────

const mainStyle = {
  padding: '2rem',
  maxWidth: '640px',
  margin: '0 auto',
  fontFamily: 'sans-serif',
}

const h1Style = { marginTop: 0 }

const subtitleStyle = {
  color: '#555',
  marginTop: 0,
  marginBottom: '1.25rem',
}

const errorStyle = {
  color: '#c00',
  marginBottom: '0.75rem',
}

const placeholderNoticeStyle = {
  color: '#7a4a00',
  background: '#fdf4e7',
  border: '1px solid #f0d9b5',
  padding: '0.6rem 0.8rem',
  borderRadius: 4,
  marginBottom: '1rem',
  fontSize: '0.95rem',
  lineHeight: 1.5,
}

const resetBannerStyle = {
  color: '#c00',
  background: '#fff5f5',
  padding: '0.6rem 0.8rem',
  borderRadius: 4,
  marginBottom: '1rem',
  fontSize: '0.95rem',
}

const btnRowStyle = {
  display: 'flex',
  gap: '0.75rem',
  flexWrap: 'wrap' as const,
  alignItems: 'center',
}

const ghostBtnStyle = {
  background: 'none',
  border: '1px solid #ccc',
}
