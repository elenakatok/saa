// ═══════════════════════════════════════════════════════════════════════════════
// SAA Slice 6 revision — screenshot capture for the per-group Statistics table and
// the Settings screen (efficient-max field). Replays the harness auction to an
// ENDED state, then shoots /reports (Statistics) and /settings (efficient_max).
//
// RUN (from games/saa): emulator up on :5005 + vite dev on :5173 —
//   node saa-report-screens.mjs
// ═══════════════════════════════════════════════════════════════════════════════

import { chromium } from 'playwright'

const PROJECT = 'saa-mygames-live'
const FUNCTIONS = `http://localhost:5005/${PROJECT}/us-central1`
const FE = 'http://localhost:5173'
const ART = 'playthrough-artifacts'
const P = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']

async function callFn(name, data) {
  const res = await fetch(`${FUNCTIONS}/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data }) })
  let body = null; try { body = await res.json() } catch { /* */ }
  if (res.ok && body && 'result' in body) return body.result
  throw new Error(`${name}: ${body?.error?.message ?? `http ${res.status}`}`)
}
async function seedGroup(gid) {
  await fetch(`${FUNCTIONS}/seedGroupForTest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game_instance_id: gid, group_id: 'g', lead_id: 'p1', bidder_participants: P }) })
}
const asStudent = (gid, pid, extra = {}) => ({ _test: { participant_id: pid, game_instance_id: gid }, ...extra })
const asDev = (gid, extra = {}) => ({ _dev: { game_instance_id: gid }, ...extra })
const open = (gid) => callFn('openAuction', asDev(gid, { group_id: 'g' }))
const bidAs = (gid, pid, lic, amt) => callFn('submitBid', asStudent(gid, pid, { group_id: 'g', license_id: lic, amount: amt }))
const holdAs = (gid, pid) => callFn('holdBid', asStudent(gid, pid, { group_id: 'g' }))
const dropAs = (gid, pid) => callFn('dropOut', asStudent(gid, pid, { group_id: 'g' }))

async function main() {
  const browser = await chromium.launch({ headless: !process.env.HEADED })
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 } })
  const gid = 'shots'

  // Replay the (E) auction to termination (winners F(A@300) B(B@200) G(C@300) D(D@200) E(E@200)).
  await seedGroup(gid); await open(gid)
  await bidAs(gid, 'p1', 'A', 200); await bidAs(gid, 'p2', 'B', 200); await bidAs(gid, 'p3', 'C', 200)
  await bidAs(gid, 'p4', 'D', 200); await bidAs(gid, 'p5', 'E', 200); await bidAs(gid, 'p6', 'A', 300); await bidAs(gid, 'p7', 'C', 300)
  await holdAs(gid, 'p6'); await holdAs(gid, 'p2'); await holdAs(gid, 'p7'); await holdAs(gid, 'p4'); await holdAs(gid, 'p5')
  await dropAs(gid, 'p1'); await dropAs(gid, 'p3') // 2 drops → END

  // ── 16 — Statistics table (per-group) ────────────────────────────────────────
  {
    const page = await ctx.newPage()
    await page.goto(`${FE}/reports?_dev_game_instance_id=${gid}`)
    // Reports now render as a ReportBoard grid of tiles; open the Statistics tile → modal.
    await page.waitForSelector('[data-testid="saa-tile-stats"]', { timeout: 25000 })
    await page.click('[data-testid="saa-tile-stats"]')
    await page.waitForSelector('[data-testid="saa-stats-table"]', { timeout: 25000 })
    await page.waitForTimeout(400)
    // Tight shot of the Statistics table inside its modal.
    await page.locator('[data-testid="saa-stats-table"]').screenshot({ path: `${ART}/16-report-statistics.png` })
    console.log('shot: 16-report-statistics.png')
    await page.close()
  }

  // ── 18 — Settings screen showing the efficient-max field ─────────────────────
  {
    const page = await ctx.newPage()
    await page.goto(`${FE}/settings?_dev_game_instance_id=${gid}`)
    // Sections render as collapsed accordions — expand the AUCTION one (its
    // button wraps a <span>AUCTION</span>) so the efficient-max field is visible.
    await page.waitForSelector('button', { timeout: 25000 })
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('button')].find(b => /^AUCTION$/i.test(b.textContent.trim()))
      if (btn) btn.click()
    })
    await page.waitForFunction(() => /Efficient max/i.test(document.body.innerText), null, { timeout: 25000 })
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${ART}/18-settings-efficient-max.png`, fullPage: true })
    console.log('shot: 18-settings-efficient-max.png')
    await page.close()
  }

  await browser.close()
}
main().catch((e) => { console.error(e); process.exit(1) })
