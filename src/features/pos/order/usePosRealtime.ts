import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../../shared/lib/supabase'
import type { PrintJobRow } from './posApi'

export interface OrderInsert { id: string; bill_id: string; branch_id: string; order_no: string; source: 'counter' | 'qr'; placed_at: string }

interface Handlers {
  onOrder?: (row: OrderInsert) => void
  onPrintJob?: (row: PrintJobRow) => void
  /** Called on SUBSCRIBED and every 15 s: refetch whatever Realtime may have missed. */
  onSweep?: () => void
}

/** One channel per mount (unique name: supabase.channel() reuses a same-named
 *  channel that is still being torn down — Phase 0). Filtered to the branch. */
export function usePosRealtime(branchId: string | null, handlers: Handlers): string {
  const [status, setStatus] = useState('idle')
  const h = useRef(handlers)
  h.current = handlers
  useEffect(() => {
    if (!branchId) return
    const filter = `branch_id=eq.${branchId}`
    const channel = supabase
      .channel(`pos-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders', filter }, (p) => h.current.onOrder?.(p.new as OrderInsert))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'print_jobs', filter }, (p) => h.current.onPrintJob?.(p.new as PrintJobRow))
      .subscribe((s) => {
        setStatus(s)
        if (s === 'SUBSCRIBED') h.current.onSweep?.()
      })
    const timer = window.setInterval(() => h.current.onSweep?.(), 15_000)
    return () => {
      window.clearInterval(timer)
      void supabase.removeChannel(channel)
    }
  }, [branchId])
  return status
}
