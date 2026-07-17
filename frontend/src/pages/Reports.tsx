import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { httpsCallable } from 'firebase/functions'
import { signInWithCustomToken, signOut } from 'firebase/auth'
import { auth, functions } from '../firebase'
import { GameHeader } from '@mygames/game-ui'
import { saaConfig, FIELD_LABELS, formatField, type OutcomeSchema } from '../gameConfig'
import type { ReportRow, ReportQuestionMeta } from '../api'

// ── Role label (single role — `bidder`) ───────────────────────────────────────

const ROLE_LABELS: Record<string, string> = Object.fromEntries(
  saaConfig.roles.map(r => [r.key, r.label]),
)

function fmtNum(n: number | null): string {
  return n == null ? '—' : n.toLocaleString('en-US')
}

// ── Page component ────────────────────────────────────────────────────────────

export default function Reports() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const devGameInstanceId = import.meta.env.DEV
    ? searchParams.get('_dev_game_instance_id')
    : null
  const tokenParam          = searchParams.get('token')
  const gameInstanceIdParam = searchParams.get('game_instance_id')

  const [sessionReady, setSessionReady] = useState(false)
  const [authError,    setAuthError]    = useState<string | null>(null)

  const makeLink = (base: string): string => {
    if (devGameInstanceId) return `${base}?_dev_game_instance_id=${encodeURIComponent(devGameInstanceId)}`
    if (tokenParam && gameInstanceIdParam)
      return `${base}?token=${encodeURIComponent(tokenParam)}&game_instance_id=${encodeURIComponent(gameInstanceIdParam)}`
    return base
  }

  // ── Auth bootstrap ─────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false
    const establish = async () => {
      await auth.authStateReady()
      if (cancelled) return
      if (auth.currentUser) {
        const expectedUid = devGameInstanceId
          ? `instructor_${devGameInstanceId}`
          : gameInstanceIdParam ? `instructor_${gameInstanceIdParam}` : null
        if (expectedUid && auth.currentUser.uid === expectedUid) { setSessionReady(true); return }
        await signOut(auth)
        if (cancelled) return
      }
      const args = devGameInstanceId
        ? { _dev: { game_instance_id: devGameInstanceId } }
        : tokenParam ? { token: tokenParam } : null
      if (!args) { setAuthError('No launch token found.'); return }
      try {
        const fn = httpsCallable<object, { customToken: string }>(functions, 'getInstructorSession')
        const res = await fn(args)
        if (cancelled) return
        await signInWithCustomToken(auth, res.data.customToken)
        if (cancelled) return
        setSessionReady(true)
      } catch (err) {
        if (cancelled) return
        setAuthError(err instanceof Error ? err.message : 'Failed to establish session.')
      }
    }
    void establish()
    return () => { cancelled = true }
  }, [devGameInstanceId, tokenParam]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Data load ──────────────────────────────────────────────────────────────
  const [rows,      setRows]      = useState<ReportRow[] | null>(null)
  const [questions, setQuestions] = useState<ReportQuestionMeta[]>([])
  const [schema,    setSchema]    = useState<OutcomeSchema | null>(null)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState<string | null>(null)

  useEffect(() => {
    if (!sessionReady) return
    setLoading(true)
    setError(null)
    const fn = httpsCallable<object, { ok: boolean; rows: ReportRow[]; questions: ReportQuestionMeta[]; schema: OutcomeSchema }>(functions, 'getReportData')
    fn({}).then(r => {
      setRows(r.data.rows)
      setQuestions(r.data.questions)
      setSchema(r.data.schema)
      setLoading(false)
    }).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Failed to load report data.')
      setLoading(false)
    })
  }, [sessionReady])

  // Placeholder outcome fields to surface as columns (non-text schema fields).
  const outcomeCols = (schema ?? []).filter(f => f.type !== 'text')
  const textFields  = questions.map(q => q.field)

  // ── Render ─────────────────────────────────────────────────────────────────
  if (authError) {
    return (
      <div style={{ padding: '2rem', textAlign: 'center' }}>
        <p style={{ color: '#c00' }}>{authError}</p>
      </div>
    )
  }

  const thStyle: React.CSSProperties = {
    textAlign: 'left', padding: '0.4rem 0.6rem', borderBottom: '2px solid #ddd',
    fontSize: '0.8rem', fontWeight: 600, whiteSpace: 'nowrap', background: '#faf7f2',
  }
  const tdStyle: React.CSSProperties = {
    padding: '0.35rem 0.6rem', borderBottom: '1px solid #eee', fontSize: '0.85rem',
  }
  const numTd: React.CSSProperties = { ...tdStyle, fontVariantNumeric: 'tabular-nums' }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <GameHeader />

      <div style={{ padding: '1rem 1.5rem 0.5rem', display: 'flex', alignItems: 'center', gap: '1rem' }}>
        <button
          onClick={() => navigate(makeLink('/dashboard'))}
          style={{ background: 'none', border: '1px solid #ccc', borderRadius: 4, padding: '0.3rem 0.8rem', cursor: 'pointer', fontSize: '0.85rem' }}
        >
          ← Dashboard
        </button>
        <h2 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Reports — SAA</h2>
      </div>

      <main style={{ flex: 1, padding: '1rem 1.5rem' }}>
        {error && <p style={{ color: '#c00', marginBottom: '1rem' }}>{error}</p>}

        <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', color: '#666' }}>
          Read-only participation + Knowledge Check report. Grading is participation-only, so raw
          scores are intentionally uniform across present bidders. The placeholder outcome is a
          Phase-1 stand-in for the live auction result.
        </p>

        {rows == null ? (
          <p style={{ color: '#888', fontSize: '0.9rem' }}>{loading ? 'Loading…' : 'No data.'}</p>
        ) : rows.length === 0 ? (
          <p style={{ color: '#888', fontSize: '0.9rem' }}>No finalized participants yet.</p>
        ) : (
          <div style={{ overflowX: 'auto', border: '1px solid #ddd', borderRadius: 6 }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 640 }}>
              <thead>
                <tr>
                  <th style={thStyle}>Name</th>
                  <th style={thStyle}>Group #</th>
                  <th style={thStyle}>Role</th>
                  <th style={thStyle}>KC score</th>
                  <th style={thStyle}>Raw score</th>
                  {outcomeCols.map(f => (
                    <th key={f.key} style={thStyle}>{FIELD_LABELS[f.key] ?? f.key}</th>
                  ))}
                  {textFields.map(field => {
                    const q = questions.find(qq => qq.field === field)
                    return <th key={field} style={thStyle}>{q?.prompt ?? field}</th>
                  })}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.participant_id}>
                    <td style={tdStyle}>{r.display_name}</td>
                    <td style={numTd}>{r.group_number ?? '—'}</td>
                    <td style={tdStyle}>{ROLE_LABELS[r.role] ?? r.role}</td>
                    <td style={numTd}>{fmtNum(r.knowledge_check_score)}</td>
                    <td style={numTd}>{fmtNum(r.raw_score)}</td>
                    {outcomeCols.map(f => (
                      <td key={f.key} style={numTd}>
                        {r.outcome && r.outcome[f.key] != null ? formatField(f, r.outcome[f.key]) : '—'}
                      </td>
                    ))}
                    {textFields.map(field => (
                      <td key={field} style={tdStyle}>
                        {r.text_answers[field]
                          ? <span style={{ whiteSpace: 'pre-wrap', display: 'inline-block', maxWidth: 260, overflowWrap: 'anywhere' }}>{r.text_answers[field]}</span>
                          : '—'}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  )
}
