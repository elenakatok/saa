import { useCallback, useEffect, useRef, useState } from 'react'
import { getBidderView, type BidderView } from '../api'

// Firestore rules DENY direct client reads of the saa_auction doc (sealed-bid
// privacy), so the bidder screen POLLS the sanitized getBidderView callable rather
// than onSnapshot-ing the raw state. Polling also fits SAA's clockless, turn-based
// rounds: the next round's standing appears within one poll of the round closing.
const POLL_MS = 2000

export interface SaaAuction {
  view: BidderView | null
  /** true once getBidderView has answered "auction not started yet" (not-found). */
  notStarted: boolean
  refresh: () => void
}

export function useSaaAuction(groupId: string | null): SaaAuction {
  const [view, setView] = useState<BidderView | null>(null)
  const [notStarted, setNotStarted] = useState(false)
  const viewRef = useRef<BidderView | null>(null)
  viewRef.current = view

  const load = useCallback(async () => {
    if (!groupId) return
    try {
      const v = await getBidderView(groupId)
      setView(v)
      setNotStarted(false)
    } catch {
      // not-found / not-yet-a-bidder → auction not open for us. Don't wipe an
      // existing view on a transient poll error.
      if (viewRef.current === null) setNotStarted(true)
    }
  }, [groupId])

  useEffect(() => {
    if (!groupId) return
    let cancelled = false
    const tick = () => { if (!cancelled) void load() }
    tick()
    const id = window.setInterval(() => {
      // Stop polling once the auction has ended — nothing more changes.
      if (viewRef.current?.status === 'ended') { window.clearInterval(id); return }
      tick()
    }, POLL_MS)
    return () => { cancelled = true; window.clearInterval(id) }
  }, [groupId, load])

  return { view, notStarted, refresh: load }
}
