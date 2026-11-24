import { useEffect, useRef, useState } from 'react'
import type { ReceiptLogo } from '../print/logo'
import { drawLogo, readLogoFile } from './logoFile'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** POS Settings → Receipt → Logo (W4 spec §3): upload an image, see it as it will print (black dots on
 *  white, at most 384 × 240), remove it. Saved with the other receipt settings. */
export default function ReceiptLogoField({ logo, onChange }: {
  logo: ReceiptLogo | null
  onChange: (logo: ReceiptLogo | null) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (logo && canvas.current) drawLogo(canvas.current, logo) }, [logo])
  const pick = async (input: HTMLInputElement) => {
    const file = input.files?.[0]
    if (!file) return
    setError(null)
    setBusy(true)
    try { onChange(await readLogoFile(file)) } catch (e) { setError(msg(e)) } finally { setBusy(false); input.value = '' }
  }
  return (
    <div className="text-sm">
      <div>Logo</div>
      <p className="text-xs text-brown-muted">Printed in black and white at the top of the receipt, at most 384 × 240 dots.</p>
      {logo ? (
        <div className="mt-2 flex items-end gap-3">
          <canvas ref={canvas} width={logo.width} height={logo.height} aria-label="Logo preview" className="border border-border bg-white" />
          <span className="text-xs text-brown-muted">{`${logo.width} × ${logo.height} dots`}</span>
        </div>
      ) : (
        <p className="mt-1 text-xs text-brown-muted">No logo.</p>
      )}
      <div className="mt-2 flex gap-2">
        <label className="cursor-pointer rounded border border-border px-3 py-1">
          {busy ? 'Reading…' : logo ? 'Change logo' : 'Upload logo'}
          <input type="file" accept="image/*" className="sr-only" disabled={busy} onChange={(e) => void pick(e.currentTarget)} />
        </label>
        {logo && <button type="button" onClick={() => onChange(null)} className="rounded border border-border px-3 py-1 text-red-700">Remove</button>}
      </div>
      {error && <p role="alert" className="mt-1 text-xs text-red-700">{error}</p>}
    </div>
  )
}
