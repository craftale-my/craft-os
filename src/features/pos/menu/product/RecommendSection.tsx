// src/features/pos/menu/product/RecommendSection.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchProductExtras, setProductRecommended } from '../slotsApi'
import { OutcomeLine, errorText, type Outcome } from '../editorUi'

/** The words under the switch (spec §6). */
export const RECOMMEND_HINT = 'Shown under Popular here, and suggested with other items, until sales are enough to choose by themselves.'

/** Recommend on QR menu (docs/superpowers/specs/2026-11-17-menu-picks-design.md §6): a saved
 *  product's switch, saved on its own by set_product_recommended the moment it is flipped, with its
 *  outcome here — like Photo and Time slots, not through Save product. */
export default function RecommendSection({ productId }: { productId: string }) {
  const [on, setOn] = useState<boolean | null>(null)                 // null = not loaded yet
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const savingRef = useRef(false)                                    // a second flip in the same render is refused too
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const loadSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++loadSeq.current                                    // a reply to an older load is dropped
    try {
      const extras = await fetchProductExtras(productId)
      if (seq !== loadSeq.current) return
      setOn(extras.isRecommended === true)
      setLoadError(null)
    } catch (e) {
      if (seq === loadSeq.current) setLoadError(errorText(e))
    }
  }, [productId])
  useEffect(() => { void load() }, [load])

  const flip = async (next: boolean) => {
    if (savingRef.current || on === null) return
    savingRef.current = true
    setSaving(true)
    setOutcome(null)
    try {
      await setProductRecommended(productId, next)
      setOn(next)
      setOutcome({ kind: 'ok', text: 'Saved' })
    } catch (e) {
      setOutcome({ kind: 'error', text: errorText(e) })
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }

  return (
    <section className="space-y-2 rounded-xl border border-border bg-card p-4">
      {on === null && !loadError && <p className="text-sm">Loading…</p>}
      {loadError && (
        <div className="flex items-center gap-3">
          <OutcomeLine outcome={{ kind: 'error', text: loadError }} />
          <button className="text-sm underline" onClick={() => void load()}>Try again</button>
        </div>
      )}
      {on !== null && (
        <label className="flex items-center gap-2 font-semibold">
          <input type="checkbox" role="switch" checked={on} disabled={saving} onChange={(e) => void flip(e.target.checked)} />
          Recommend on QR menu
        </label>
      )}
      <p className="text-xs text-brown-muted">{RECOMMEND_HINT}</p>
      <OutcomeLine outcome={outcome} />
    </section>
  )
}
