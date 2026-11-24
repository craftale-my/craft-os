import { createClient } from '@supabase/supabase-js'

/** The customer page is anonymous: no session is ever stored, so a phone that
 *  once signed in to the staff app cannot leak its JWT into these calls. */
export const qrClient = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
)
