// src/features/pos/order/usePadMenu.ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { readableError } from '../checkout/rpcResult'
import { fetchPosMenu } from './posApi'
import type { PosMenu } from './cart'

export interface PadMenu {
  /** The pad catalog's menu; null while it loads, after a failed first read, or with no catalog. */
  menu: PosMenu | null
  /** Why the last read failed (kept apart from the send errors, which every cart change clears). */
  error: string | null
  /** Reads the menu again (Retry, a sold-out change, a rejected order). */
  reload: () => Promise<void>
}


/** The order pad's menu (readiness W8): a failed read says why and offers Retry, and the menu is
 *  read again as soon as the iPad is back online, so a pad opened offline fills itself in. A
 *  failed read keeps the menu already shown; a slow reply for an earlier catalog is dropped. */
export function usePadMenu(catalogId: string | null): PadMenu {
  const [held, setHeld] = useState<{ catalogId: string; menu: PosMenu } | null>(null)
  const [failed, setFailed] = useState<{ catalogId: string; error: string } | null>(null)
  const seq = useRef(0)
  const idRef = useRef(catalogId)
  idRef.current = catalogId

  const reload = useCallback(async () => {
    const mine = ++seq.current
    const id = idRef.current
    if (!id) return
    try {
      const menu = await fetchPosMenu(id)
      if (mine === seq.current) { setHeld({ catalogId: id, menu }); setFailed(null) }
    } catch (e) {
      if (mine === seq.current) setFailed({ catalogId: id, error: readableError(e) })
    }
  }, [])

  useEffect(() => { void reload() }, [catalogId, reload])
  useEffect(() => {
    const online = () => { void reload() }
    window.addEventListener('online', online)
    return () => window.removeEventListener('online', online)
  }, [reload])

  return {
    menu: held && held.catalogId === catalogId ? held.menu : null,
    error: failed && failed.catalogId === catalogId ? failed.error : null,
    reload,
  }
}
