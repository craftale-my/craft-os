import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../../shared/lib/supabase'
import type { AppNotification } from '../../shared/types'

export interface UseNotifications {
  items: AppNotification[]
  unread: number
  markRead: (id: string) => Promise<void>
}

/**
 * The signed-in user's inbox. RLS already limits rows to
 * `recipient_id = auth.uid()`, so no filter is needed here — and a filtered
 * subscription would silently miss rows that move out of the filtered set,
 * the same trap the task board hit (see useBoardTasks.ts).
 */
export function useNotifications(staffId: string | undefined): UseNotifications {
  const [items, setItems] = useState<AppNotification[]>([])

  // Guards a load()/markRead() that resolves after the component has already
  // unmounted from calling setState on it — the same discipline the task
  // board's realtime effect uses (its `live` flag), just not tied to a
  // debounce timer here since this hook has none.
  const liveRef = useRef(true)
  useEffect(() => {
    liveRef.current = true
    return () => { liveRef.current = false }
  }, [])

  const load = useCallback(async () => {
    if (!staffId) return
    const { data } = await supabase
      .from('notifications')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(30)
    if (!liveRef.current) return
    setItems((data as AppNotification[]) ?? [])
  }, [staffId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    if (!staffId) return
    // Own cleanup flag (separate from liveRef, which spans the whole mount):
    // this one stops a handler or SUBSCRIBED callback fired just before
    // unmount from scheduling a load() that lands after the channel is gone.
    let live = true
    const channel = supabase
      .channel(`notifications:${staffId}`)
      // Unfiltered on purpose — see the doc comment above.
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, () => {
        if (live) load()
      })
      .subscribe(status => {
        if (live && status === 'SUBSCRIBED') load()
      })
    return () => {
      live = false
      supabase.removeChannel(channel)
    }
  }, [staffId, load])

  const markRead = useCallback(async (id: string) => {
    // Only read_at — a BEFORE UPDATE trigger on the table rejects any update
    // that touches another column, so this must never grow a second field.
    const read_at = new Date().toISOString()
    await supabase.from('notifications').update({ read_at }).eq('id', id)
    if (!liveRef.current) return
    setItems(prev => prev.map(n => (n.id === id ? { ...n, read_at } : n)))
  }, [])

  return { items, unread: items.filter(n => !n.read_at).length, markRead }
}
