// src/features/pos/menu/useMenuData.ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchMenu, type MenuProductRow } from './menuApi'
import { fetchLookups, type MenuLookups } from './menuEditorApi'
import { errorText } from './editorUi'

/** Every product and the lookups, loaded together (Products, Takeaway fees, Print routes). `load`
 *  never rejects — a failure lands in `loadError` — and an older reply never lands last. */
export function useMenuData() {
  const [rows, setRows] = useState<MenuProductRow[] | null>(null)
  const [lookups, setLookups] = useState<MenuLookups | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const loadSeq = useRef(0)
  const load = useCallback(async (): Promise<void> => {
    const seq = ++loadSeq.current
    try {
      const [r, l] = await Promise.all([fetchMenu(), fetchLookups()])
      if (seq !== loadSeq.current) return
      setRows(r)
      setLookups(l)
      setLoadError(null)
    } catch (e) {
      if (seq === loadSeq.current) setLoadError(errorText(e))
    }
  }, [])
  useEffect(() => { void load() }, [load])
  return { rows, setRows, lookups, loadError, load }
}
