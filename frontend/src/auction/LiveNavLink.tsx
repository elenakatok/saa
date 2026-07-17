import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { typography } from '@mygames/game-ui'

// A single "Live auctions →" nav link on the main instructor dashboard. It portals
// itself as the first child of the shared <main> (the shared action bar has no
// generic nav slot), and carries the query string through — Spectrum's pattern for
// its "Open live market dashboard →" link. The main dashboard is otherwise the plain
// shared roster; the live auction state lives on the separate /live route.
export default function LiveNavLink() {
  const [host, setHost] = useState<HTMLElement | null>(null)
  useEffect(() => {
    const main = document.querySelector('main')
    if (!main) return
    const node = document.createElement('div')
    node.setAttribute('data-saa-live-nav-host', '')
    node.style.margin = '0 0 1rem'
    main.insertBefore(node, main.firstChild)
    setHost(node)
    return () => { node.remove(); setHost(null) }
  }, [])
  if (!host) return null
  return createPortal(
    <a data-testid="saa-live-nav" href={`/live${window.location.search}`}
      style={{ color: '#D38626', fontWeight: 700, fontSize: typography.sizeTable, textDecoration: 'none' }}>
      Live auctions →
    </a>,
    host,
  )
}
