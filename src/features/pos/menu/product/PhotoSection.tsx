// src/features/pos/menu/product/PhotoSection.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchProductExtras } from '../slotsApi'
import { publicPhotoUrl, removeProductPhoto, uploadProductPhoto } from '../photoUpload'
import { OutcomeLine, Section, errorText, linkBtnCls, type Outcome } from '../editorUi'

/** The product's photo, shown on the QR menu (the counter keeps text tiles). A new photo is
 *  resized in the browser, uploaded, and then replaces the old one, whose file is deleted.
 *  Saved on its own, with its outcome here. */
export default function PhotoSection({ productId, productName }: { productId: string; productName: string }) {
  const [path, setPath] = useState<string | null | undefined>(undefined)       // undefined = not loaded
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)                         // what is running, for the button
  const busyRef = useRef(false)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    const extras = await fetchProductExtras(productId)
    if (seq !== loadSeq.current) return
    setPath(extras.imagePath)
    setLoadError(null)
  }, [productId])
  useEffect(() => { load().catch((e) => setLoadError(errorText(e))) }, [load])

  const run = async (label: string, action: () => Promise<{ warning: string | null }>, ok: string) => {
    if (busyRef.current || loadError) return
    busyRef.current = true
    setBusy(label)
    setOutcome(null)
    try {
      const { warning } = await action()
      try {
        await load()
        setOutcome(warning ? { kind: 'error', text: warning } : { kind: 'ok', text: ok })
      } catch (e) {
        setLoadError(errorText(e))
        setOutcome({ kind: 'error', text: 'Saved, but reloading failed — try again before changing more.' })
      }
    } catch (e) {
      setOutcome({ kind: 'error', text: errorText(e) })
    } finally {
      busyRef.current = false
      setBusy(null)
    }
  }

  const pick = (file: File | undefined) => {
    if (file) void run('Uploading…', () => uploadProductPhoto(productId, file), 'Photo saved')
  }
  const remove = () => {
    if (window.confirm(`Remove the photo of ${productName}? The QR menu then shows it without a photo.`)) {
      void run('Removing…', () => removeProductPhoto(productId), 'Photo removed')
    }
  }

  const locked = busy !== null || !!loadError || path === undefined
  return (
    <Section title="Photo" hint="Shown on the QR menu. Any image under 10 MB; it is resized to 800 px wide before it is uploaded.">
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" disabled={busy !== null} onClick={() => { load().catch((e) => setLoadError(errorText(e))) }}>Try again</button>
        </div>
      )}
      <div className="flex flex-wrap items-start gap-4">
        {path
          ? <img src={publicPhotoUrl(path)} alt={productName} className="h-40 w-40 rounded-lg border border-border object-cover" />
          : <div className="flex h-40 w-40 items-center justify-center rounded-lg border border-dashed border-border text-sm text-brown-muted">
              {path === undefined && !loadError ? 'Loading…' : 'No photo'}
            </div>}
        <div className="space-y-2 text-sm">
          <label className={`${linkBtnCls} inline-block cursor-pointer ${locked ? 'pointer-events-none opacity-40' : ''}`}>
            {busy ?? (path ? 'Replace photo…' : 'Choose photo…')}
            <input type="file" accept="image/*" className="sr-only" disabled={locked} aria-label={`Photo of ${productName}`}
              onChange={(e) => { pick(e.target.files?.[0]); e.target.value = '' }} />
          </label>
          {path && <button type="button" className={`${linkBtnCls} block`} disabled={locked} onClick={remove}>Remove photo</button>}
        </div>
      </div>
      <OutcomeLine outcome={outcome} />
    </Section>
  )
}
