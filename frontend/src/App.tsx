import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { auth, functions } from './firebase'
import Play from './pages/Play'
import InstructorDashboard from './pages/InstructorDashboard'
import LiveDashboard from './pages/LiveDashboard'
import Configure from './pages/Configure'
import Reports from './pages/Reports'
import { SettingsPage } from '@mygames/game-ui'

// SINGLE ROLE — `bidder`. (Winemaster had two: winemaster + home_base.)
const saaRoleLabels: Record<string, string> = {
  bidder: 'Bidder',
}

const saaInfoLinks = [
  { roleKey: 'bidder', links: [
    { key: 'bidder_sheet_url', label: 'Role sheet' },
  ]},
]

// Instructor-editable settings beyond role names / sheets (mirrors Spectrum's
// spectrumConfigSections). The efficiency-benchmark denominator lives here.
const saaConfigSections = [
  {
    id: 'auction',
    title: 'Auction',
    fields: [
      { key: 'efficient_max', label: 'Efficient max surplus (efficiency benchmark)', kind: 'positiveInt' as const, placeholder: '3119' },
    ],
  },
]

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"          element={<Play />} />
        <Route path="/dashboard" element={<InstructorDashboard />} />
        <Route path="/live"      element={<LiveDashboard />} />
        <Route path="/configure" element={<Configure />} />
        <Route path="/reports"   element={<Reports />} />
        <Route path="/settings"  element={
          <SettingsPage
            title="Settings — SAA"
            functions={functions}
            auth={auth}
            roleLabels={saaRoleLabels}
            roleInfoLinks={saaInfoLinks}
            configSections={saaConfigSections}
          />
        } />
      </Routes>
    </BrowserRouter>
  )
}
