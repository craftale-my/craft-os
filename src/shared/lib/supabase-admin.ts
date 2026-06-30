import { createClient } from '@supabase/supabase-js'

// Uses the service_role key to bypass RLS — required for admin operations
// (creating auth users from the manager dashboard). Add VITE_SUPABASE_SERVICE_ROLE_KEY
// to .env.local. Never expose this key in a public-facing app.
export const supabaseAdmin = import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY
  ? createClient(
      import.meta.env.VITE_SUPABASE_URL as string,
      import.meta.env.VITE_SUPABASE_SERVICE_ROLE_KEY as string,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )
  : null
