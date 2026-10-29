import { supabase } from '../shared/lib/supabase'
import { POS_STORAGE_KEY } from './posSupabase'

/** Replaced by the real app in Task 6. Shows which client the build wired in. */
export default function PosApp() {
  const swapped = (supabase as unknown as { auth: { storageKey?: string } }).auth.storageKey === POS_STORAGE_KEY
  return <div className="p-8 text-center text-brown-dark">Craft POS · client {swapped ? 'POS' : 'Craft OS'}</div>
}
