import React, { useEffect, useState } from 'react'
import { doc, getDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { auth, db, rtdb, functions } from '../firebase'
import { assignRole, confirmReady, verifyAttendanceCode, submitBid, holdBid, dropOut, CLASSROOM_URL } from '../api'
import { useSaaAuction } from '../auction/useSaaAuction'
import BidderScreen from '../auction/BidderScreen'
import {
  useStudentSession,
  KnowledgeCheck,
  InfoPage,
  PrepQuestions,
  GameHeader,
  WaitingRoom,
  typography,
  colors,
  layout,
  spacing,
} from '@mygames/game-ui'
import type { BootstrapArgs, InfoPageLink } from '@mygames/game-ui'

// ── Phase state ───────────────────────────────────────────────────────────────

// SAA is a self-resolving AUCTION — there is NO negotiation, no group reveal, no
// off-platform holding, no lead outcome report, no confirmation handshake, no
// deadlock. Once a student is matched they wait in the auction room; the live-auction
// overlay (useSaaAuction → BidderScreen) takes over the screen the moment the
// instructor opens the auction and stays through the terminal result. So the phase
// machine ends at 'matched' — everything after is the overlay.
//
// PRIVACY: bidders are identified ONLY by bidder NUMBER. No student-facing screen or
// student-authed payload carries a name (getBidderView returns bidderIndex only).
type GamePhase =
  | { name: 'loading' }
  | { name: 'error';           message: string }
  | { name: 'info';            roleLabel: string; links: InfoPageLink[]; publicLink: { label: string; url: string } | null }
  | { name: 'kc' }
  | { name: 'prep' }
  | { name: 'hold' }
  | { name: 'confirmation' }
  | { name: 'attendance-code' }
  | { name: 'waiting-room' }
  | { name: 'matched';         groupId: string }

// ── Phase routing ─────────────────────────────────────────────────────────────

type GetInfoUrlsResult = {
  ok: boolean
  roleLabel: string
  links: InfoPageLink[]
  publicLink: { label: string; url: string } | null
}

async function routeToPhase(participantId: string, gameInstanceId: string): Promise<GamePhase> {
  const snap = await getDoc(
    doc(db, 'game_instances', gameInstanceId, 'participants', participantId),
  )
  const d = snap.data() ?? {}

  if (d.prep_status !== 'complete') {
    if (d.knowledge_check_score != null) return { name: 'prep' }
    const fn = httpsCallable<object, GetInfoUrlsResult>(functions, 'getInfoUrls')
    const { data } = await fn({})
    return {
      name:       'info',
      roleLabel:  data.roleLabel,
      links:      data.links,
      publicLink: data.publicLink ?? null,
    }
  }

  // prep_status === 'complete' — Phase 2 routing
  if (!d.confirmed_ready_at)    return { name: 'hold' }
  if (!d.attendance_confirmed_at) return { name: 'confirmation' }
  if (!d.group_id)              return { name: 'waiting-room' }

  // Matched. The auction overlay (useSaaAuction) owns bidding + the terminal result
  // from here — it renders ON TOP of this phase the instant getBidderView answers.
  // Until then, 'matched' is the "waiting for the auction to start" room. There is NO
  // group-status branch: no reveal, no 'negotiating'/'reporting'/'deadlocked'/'completed'.
  return { name: 'matched', groupId: d.group_id as string }
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Play() {
  const p       = new URLSearchParams(window.location.search)
  const token   = p.get('token')
  const testPid = import.meta.env.DEV ? p.get('_pid') : null
  const testGid = import.meta.env.DEV ? p.get('_gid') : null

  const [phase, setPhase]             = useState<GamePhase>({ name: 'loading' })
  const [headerLinks, setHeaderLinks] = useState<InfoPageLink[] | null>(null)
  const [confError,   setConfError]   = useState<string | null>(null)
  const [confLoading, setConfLoading] = useState(false)
  const [codeValue,   setCodeValue]   = useState('')
  const [codeError,   setCodeError]   = useState<string | null>(null)
  const [codeLoading, setCodeLoading] = useState(false)

  // ── Session lifecycle ────────────────────────────────────────────────────

  const session = useStudentSession({
    auth,
    token,
    testIds: (testPid && testGid) ? { participantId: testPid, gameInstanceId: testGid } : null,
    bootstrap: async (args: BootstrapArgs) => {
      const r = await assignRole(args)
      return {
        participantId:  r.participant_id,
        gameInstanceId: r.game_instance_id,
        customToken:    r.customToken,
      }
    },
  })

  // ── Phase routing + header-link population ────────────────────────────────

  useEffect(() => {
    if (session.kind !== 'ready') return
    const { participantId, gameInstanceId } = session
    let cancelled = false

    const run = async () => {
      let p: GamePhase
      try {
        p = await routeToPhase(participantId, gameInstanceId)
      } catch (err) {
        if (!cancelled) setPhase({ name: 'error', message: err instanceof Error ? err.message : 'Failed to load session.' })
        return
      }
      if (cancelled) return
      setPhase(p)

      if (p.name === 'info') {
        if (!cancelled) setHeaderLinks(p.links)
      } else {
        const fn = httpsCallable<object, GetInfoUrlsResult>(functions, 'getInfoUrls')
        fn({}).then(({ data }) => { if (!cancelled) setHeaderLinks(data.links) }).catch(() => {})
      }
    }

    void run()
    return () => { cancelled = true }
  }, [session])

  // ── Live auction overlay (Slice 4) ────────────────────────────────────────
  // Once the student is matched, poll getBidderView; when the SAA auction is
  // open/ended it renders BidderScreen ON TOP of the phase machine (eBay overlay
  // pattern), so the auction takes over the moment the instructor opens it. Hook is
  // unconditional (idles while groupId is null).
  const auctionGroupId = phase.name === 'matched' ? phase.groupId : null
  const auction = useSaaAuction(auctionGroupId)

  // ── Render: pre-session states (no header) ────────────────────────────────

  if (session.kind === 'loading' || (session.kind === 'ready' && phase.name === 'loading')) {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}>
        <p>Loading…</p>
      </main>
    )
  }

  if (session.kind === 'no-token') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily, maxWidth: '480px', margin: '2rem auto' }}>
        <h2 style={{ marginBottom: '0.75rem' }}>Simultaneous Ascending Auction</h2>
        <p>Please launch this game from the classroom to join a session.</p>
        <p style={{ marginTop: '1.5rem' }}><a href={CLASSROOM_URL}>← Go to classroom</a></p>
      </main>
    )
  }

  if (session.kind === 'error') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}>
        <p style={{ color: '#c00' }}>{session.message}</p>
        <p><a href={CLASSROOM_URL}>← Return to classroom</a></p>
      </main>
    )
  }

  if (phase.name === 'error') {
    return (
      <main style={{ padding: '2rem', fontFamily: typography.fontFamily }}>
        <p style={{ color: '#c00' }}>{phase.message}</p>
        <p><a href={CLASSROOM_URL}>← Return to classroom</a></p>
      </main>
    )
  }

  const { participantId, gameInstanceId } = session

  // ── P2 inline handlers ────────────────────────────────────────────────────

  const handleConfirmReady = () => {
    setConfLoading(true)
    setConfError(null)
    confirmReady({})
      .then(() => setPhase({ name: 'attendance-code' }))
      .catch((err: unknown) => {
        setConfError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
        setConfLoading(false)
      })
  }

  const handleAttendanceCode = (e: React.FormEvent) => {
    e.preventDefault()
    const code = codeValue.trim()
    if (code.length < 4) return
    setCodeLoading(true)
    setCodeError(null)
    verifyAttendanceCode({}, code)
      .then(() => setPhase({ name: 'waiting-room' }))
      .catch((err: unknown) => {
        setCodeError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
        setCodeLoading(false)
      })
  }

  // ── Live auction: takes over the screen while it is open/ended ────────────
  if (auctionGroupId && auction.view && (auction.view.status === 'open' || auction.view.status === 'ended')) {
    return (
      <BidderScreen
        view={auction.view}
        headerLinks={headerLinks ?? []}
        onSubmitBid={(licenseId, amount) => submitBid(auctionGroupId, licenseId, amount)}
        onHold={() => holdBid(auctionGroupId)}
        onDropOut={() => dropOut(auctionGroupId)}
        onRefresh={auction.refresh}
      />
    )
  }

  // ── Render: session ready — header persists across all phases ─────────────

  return (
    <div style={{ fontFamily: typography.fontFamily }}>
      <GameHeader studentLinks={headerLinks} />

      {phase.name === 'info' && (
        <InfoPage
          roleLabel={phase.roleLabel}
          links={phase.links}
          publicLink={phase.publicLink}
          onContinue={() => setPhase({ name: 'kc' })}
        />
      )}

      {phase.name === 'kc' && (
        <KnowledgeCheck
          participantId={participantId}
          gameInstanceId={gameInstanceId}
          functions={functions}
          db={db}
          onComplete={() => setPhase({ name: 'prep' })}
        />
      )}

      {phase.name === 'prep' && (
        <PrepQuestions
          participantId={participantId}
          gameInstanceId={gameInstanceId}
          functions={functions}
          db={db}
          onComplete={() => setPhase({ name: 'hold' })}
        />
      )}

      {phase.name === 'hold' && (
        <main style={{ padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto' }}>
          <h1 style={{ marginTop: 0 }}>Preparation complete</h1>
          <p style={{ lineHeight: 1.6, marginBottom: spacing.gapSm }}>
            When class begins and your instructor starts the session, you&apos;ll see the group of
            bidders you&apos;ve been matched with.
          </p>
          <p style={{ color: colors.textSecondary, marginBottom: layout.pagePad }}>
            You can close this tab and come back later — your work has been saved.
          </p>
          <button onClick={() => setPhase({ name: 'confirmation' })}>
            I&apos;m in class — continue
          </button>
        </main>
      )}

      {phase.name === 'confirmation' && (
        <main style={{ padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto' }}>
          <h1 style={{ marginTop: 0 }}>Ready to bid?</h1>
          <p style={{ lineHeight: 1.6, marginBottom: spacing.gapSm }}>
            You&apos;ll be placed in a group of bidders. Only continue if you are in class and ready
            to take part right now.
          </p>
          {confError && (
            <p style={{ color: '#c00', marginBottom: spacing.gapSm }}>{confError}</p>
          )}
          <div style={{ display: 'flex', gap: spacing.gapBtn }}>
            <button onClick={handleConfirmReady} disabled={confLoading}>
              {confLoading ? 'Confirming…' : "Yes, I'm ready"}
            </button>
            <button
              onClick={() => setPhase({ name: 'hold' })}
              disabled={confLoading}
              style={{ background: 'none', border: '1px solid #ccc' }}
            >
              Not now
            </button>
          </div>
        </main>
      )}

      {phase.name === 'attendance-code' && (
        <main style={{ padding: layout.pagePad, maxWidth: '540px', margin: '0 auto' }}>
          <h1 style={{ marginTop: 0 }}>Enter attendance code</h1>
          <p style={{ lineHeight: 1.6, marginBottom: layout.pagePad }}>
            Enter the code your instructor is displaying.
          </p>
          <form onSubmit={handleAttendanceCode}>
            <input
              value={codeValue}
              onChange={e => setCodeValue(e.target.value.toUpperCase())}
              maxLength={6}
              placeholder="e.g. ABJKM"
              autoFocus
              autoCapitalize="characters"
              spellCheck={false}
              disabled={codeLoading}
              style={{
                fontSize:     '2rem',
                letterSpacing: '0.25em',
                width:         '100%',
                padding:       '0.5rem 0.75rem',
                boxSizing:     'border-box',
                fontFamily:    'monospace',
                textTransform: 'uppercase',
              }}
            />
            {codeError && (
              <p style={{ color: '#c00', marginTop: '0.75rem' }}>{codeError}</p>
            )}
            <button
              type="submit"
              disabled={codeLoading || codeValue.trim().length < 4}
              style={{ marginTop: spacing.gapMd }}
            >
              {codeLoading ? 'Checking…' : 'Submit'}
            </button>
          </form>
        </main>
      )}

      {phase.name === 'waiting-room' && (
        <WaitingRoom
          participantId={participantId}
          gameInstanceId={gameInstanceId}
          db={db}
          rtdb={rtdb}
          onMatched={(groupId) => setPhase({ name: 'matched', groupId })}
        />
      )}

      {phase.name === 'matched' && (
        <main data-testid="auction-room" style={{ padding: layout.pagePad, maxWidth: layout.contentWidth, margin: '0 auto' }}>
          <h1 style={{ marginTop: 0 }}>You&apos;re in the auction room</h1>
          <p style={{ lineHeight: 1.6, marginBottom: spacing.gapSm }}>
            You&apos;ve been placed in an auction with six other bidders. The bidding will
            begin the moment your instructor starts it — stay on this page and it will
            open automatically.
          </p>
          <p style={{ color: colors.textSecondary }}>
            Keep this tab open. When the auction opens you&apos;ll see the five licenses,
            your own private values, and be able to bid.
          </p>
        </main>
      )}
    </div>
  )
}
