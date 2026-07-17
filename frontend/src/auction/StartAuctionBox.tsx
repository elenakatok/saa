import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { colors, typography, spacing } from '@mygames/game-ui'
import { getRoster, getInstructorAuctionView, openAuction, type InstructorGroupAuction, type RosterGroup } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// SAA Slice 5 (rev2): the eBay-style START box on the MAIN instructor dashboard.
// Mirrors eBay's EbayAuctionPanel — a box ABOVE the roster (portaled as the first
// child of the shared <main>), listing every matched group with a per-group "Start
// Auction" button; an already-started group shows a status instead of a duplicate
// button. Starting happens HERE (dashboard); watching happens on /live. Also carries
// the "Live auctions →" nav link to the watch view.
// ═══════════════════════════════════════════════════════════════════════════════

export default function StartAuctionBox() {
  const [rosterGroups, setRosterGroups] = useState<RosterGroup[]>([])
  const [auctions, setAuctions] = useState<InstructorGroupAuction[]>([])
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [host, setHost] = useState<HTMLElement | null>(null)

  // Host node as the first child of the shared dashboard's <main> (eBay pattern).
  useEffect(() => {
    const main = document.querySelector('main')
    if (!main) return
    const node = document.createElement('div')
    node.setAttribute('data-saa-start-host', '')
    main.insertBefore(node, main.firstChild)
    setHost(node)
    return () => { node.remove(); setHost(null) }
  }, [])

  // Poll roster (all matched groups) + the instructor view (which are started).
  useEffect(() => {
    let alive = true
    const tick = () =>
      Promise.all([getRoster().catch(() => null), getInstructorAuctionView().catch(() => null)])
        .then(([r, a]) => { if (!alive) return; if (r?.ok) setRosterGroups(r.groups); if (a?.ok) setAuctions(a.groups) })
    tick()
    const id = setInterval(tick, 3000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const start = (gid: string) => {
    setBusy((b) => ({ ...b, [gid]: true }))
    openAuction(gid).catch(() => { /* poll reflects the truth */ }).finally(() => setBusy((b) => ({ ...b, [gid]: false })))
  }

  if (!host) return null

  const auctionByGid = new Map(auctions.map((a) => [a.groupId, a]))
  const sorted = [...rosterGroups].sort((a, b) => a.group_id.localeCompare(b.group_id))

  return createPortal(
    <div data-testid="saa-auction-controls" style={{ margin: '0 0 1.5rem', padding: '0.75rem 1rem', border: `1px solid ${colors.borderMid}`, borderRadius: 8, background: colors.surfaceSubtle }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: spacing.gapSm }}>
        <span style={{ fontWeight: 700, fontSize: '1.05rem' }}>Live auctions</span>
        <a data-testid="saa-live-nav" href={`/live${window.location.search}`} style={{ color: '#D38626', fontWeight: 700, fontSize: typography.sizeSm, textDecoration: 'none' }}>
          Live auctions →
        </a>
      </div>

      {sorted.length === 0 ? (
        <div style={{ fontSize: typography.sizeSm, color: colors.textSecondary }}>Match students into groups to start their auctions.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: spacing.gapMd }}>
          {sorted.map((rg, i) => {
            const a = auctionByGid.get(rg.group_id)
            return (
              <div key={rg.group_id} data-testid={`saa-start-row-${rg.group_id}`} style={{ display: 'flex', alignItems: 'center', gap: spacing.gapBtn, paddingBottom: '0.4rem', borderBottom: `1px solid ${colors.borderFaint}` }}>
                <span style={{ minWidth: 70, fontWeight: 600 }}>Group {i + 1}</span>
                {!a ? (
                  <button data-testid={`saa-start-auction-${rg.group_id}`} disabled={busy[rg.group_id]} onClick={() => start(rg.group_id)}>
                    Start Auction
                  </button>
                ) : a.status === 'ended' ? (
                  <span data-testid={`saa-start-status-${rg.group_id}`} style={{ fontSize: typography.sizeSm, color: colors.textSecondary }}>Auction ended</span>
                ) : (
                  <span data-testid={`saa-start-status-${rg.group_id}`} style={{ fontSize: typography.sizeSm, color: colors.successText, fontWeight: 600 }}>
                    ● Auction open — round {a.round} · watch on the Live Dashboard
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>,
    host,
  )
}
