import { useEffect, useRef } from 'react'
import { getAuctionReport } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// SAA Slice 6 — the dashboard Outcome→PROFIT override (Spectrum's pattern). The
// shared RosterTable's "Outcome" column shows raw_score (the flat participation
// grade). raw_score stays load-bearing for GRADES; we NEVER touch it. Instead a
// MutationObserver + poll REPAINTS the displayed Outcome cell/header with each
// bidder's total profit — a display-only override, no shared-package change.
// Column order is the shared [Name, Role, Status, Group #, Outcome]: Outcome = last
// <td>, Name = first, Group # = second-to-last; keyed by "group::name".
//
// The shared table sorts the (renamed) column by raw_score, which is meaningless for
// profit, so when that column is the ACTIVE sort we also reorder the rows by the
// NUMERIC profit — ascending/descending per the header arrow, $0 sorting as 0, and
// bidders with no profit (nulls) pinned last in both directions. The reorder is
// idempotent (it only touches the DOM when the order actually changes), so it can't
// loop against the MutationObserver.
// ═══════════════════════════════════════════════════════════════════════════════
export default function OutcomeProfitOverride() {
  const profitByKey = useRef<Map<string, number>>(new Map())

  const tidy = () => {
    const table = document.querySelector('[data-testid="roster-table"] table')
    if (!table) return
    // Header: "Outcome" → "Profit". Detect this column's active sort direction from
    // its arrow (SortableTable appends ' ↑'/' ↓' to the active column's label).
    let profitSortDir: 'asc' | 'desc' | null = null
    for (const th of Array.from(table.querySelectorAll('thead th'))) {
      for (const node of Array.from(th.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE && node.nodeValue?.trim() === 'Outcome') node.nodeValue = 'Profit'
      }
      const label = (th.textContent ?? '')
      if (/^\s*Profit/.test(label)) profitSortDir = label.includes('↑') ? 'asc' : label.includes('↓') ? 'desc' : null
    }
    // Body: repaint the last <td> with the bidder's profit (idempotent).
    for (const tr of Array.from(table.querySelectorAll('tbody tr'))) {
      const tds = tr.querySelectorAll('td')
      if (tds.length < 2) continue
      const name = (tds[0].textContent ?? '').trim()
      const group = ((tds[tds.length - 2].textContent ?? '').match(/\d+/) ?? [''])[0]
      const profit = profitByKey.current.get(`${group}::${name}`)
      if (profit == null) continue
      const cell = tds[tds.length - 1] as HTMLElement
      const target = (cell.querySelector('span') ?? cell) as HTMLElement
      const shown = '$' + Math.round(profit).toLocaleString('en-US')
      if (target.textContent !== shown) { target.textContent = shown; target.style.color = '#333' }
    }
    // Sort: when the Profit column is active, order rows by NUMERIC profit.
    if (profitSortDir) reorderByProfit(table, profitSortDir)
  }

  const reorderByProfit = (table: Element, dir: 'asc' | 'desc') => {
    const tbody = table.querySelector('tbody')
    if (!tbody) return
    const trs = Array.from(tbody.querySelectorAll(':scope > tr'))
    const keyed = trs.map((tr) => {
      const tds = tr.querySelectorAll('td')
      const name = (tds[0]?.textContent ?? '').trim()
      const group = ((tds[tds.length - 2]?.textContent ?? '').match(/\d+/) ?? [''])[0]
      const p = profitByKey.current.get(`${group}::${name}`)
      return { tr, p: p == null ? null : p }
    })
    const sorted = [...keyed].sort((a, b) => {
      if ((a.p == null) !== (b.p == null)) return a.p == null ? 1 : -1  // nulls last, both dirs
      if (a.p == null) return 0
      const cmp = a.p - (b.p as number)
      return dir === 'asc' ? cmp : -cmp
    })
    // Idempotent: only re-append when the order actually differs, so a stable order
    // produces no mutation (and thus no observer feedback loop).
    if (sorted.some((x, i) => x.tr !== trs[i])) for (const x of sorted) tbody.appendChild(x.tr)
  }

  // Poll the auction report for name→profit.
  useEffect(() => {
    let alive = true
    const poll = () =>
      getAuctionReport().then((r) => {
        if (!alive || !r.ok) return
        const m = new Map<string, number>()
        for (const b of r.bidders) m.set(`${b.groupNumber}::${b.name}`, b.totalProfit)
        profitByKey.current = m
        tidy()
      }).catch(() => { /* session not ready — retry */ })
    poll()
    const id = setInterval(poll, 3000)
    return () => { alive = false; clearInterval(id) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-apply after the shared roster re-renders (it repaints raw_score back in).
  useEffect(() => {
    const obs = new MutationObserver(() => { obs.disconnect(); tidy(); obs.observe(document.body, { childList: true, subtree: true }) })
    tidy()
    obs.observe(document.body, { childList: true, subtree: true })
    return () => obs.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return null
}
