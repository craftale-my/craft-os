// src/features/pos/order/PosPage.tsx
import { useState } from 'react'
import MyPinDialog from '../checkout/MyPinDialog'
import { posAppUrl } from './posAppUrl'

/** /pos in Craft OS since C3: front-of-house runs only on activated devices (the POS app), so this
 *  page points there. It keeps My PIN — the only place staff set the PIN they sign in with. */
export default function PosPage({ appUrl = posAppUrl(import.meta.env.VITE_POS_APP_URL as string | undefined) }: { appUrl?: string | null }) {
  const [pinOpen, setPinOpen] = useState(false)
  return (
    <div className="mx-auto max-w-xl space-y-4 p-6">
      <h1 className="text-xl font-semibold text-brown-dark">The POS has moved to its own app.</h1>
      {appUrl
        ? <p><a href={appUrl} target="_blank" rel="noreferrer" className="break-all font-medium text-brown-dark underline">{appUrl}</a></p>
        : <p className="text-sm text-brown-muted">Ask HQ for the POS app address.</p>}
      <p className="text-sm text-brown-dark">Activate a tablet: open the address on it and approve it in Devices.</p>
      <div className="space-y-2 border-t border-border pt-4">
        <p className="text-sm text-brown-muted">Staff sign in on the tablet with their name and POS PIN.</p>
        <button type="button" onClick={() => setPinOpen(true)} className="min-h-12 rounded-xl border border-border-mid px-4 text-brown-dark">My PIN</button>
      </div>
      {pinOpen && <MyPinDialog onClose={() => setPinOpen(false)} />}
    </div>
  )
}
