import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import type { User, Session } from '@supabase/supabase-js'
import { supabase } from '../../shared/lib/supabase'
import type { Staff } from '../../shared/types'

interface AuthContextValue {
  user: User | null
  session: Session | null
  staff: Staff | null
  loading: boolean
  signIn: (email: string, password: string) => Promise<{ error: Error | null }>
  signOut: () => Promise<void>
  refreshStaff: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [staff, setStaff] = useState<Staff | null>(null)
  const [loading, setLoading] = useState(true)

  async function fetchStaff(userId: string) {
    const { data, error } = await supabase
      .from('staff')
      .select('*')
      .eq('id', userId)
      .single()

    // If the auth session is valid but the staff row no longer exists (e.g. it
    // was deleted while the user was logged in), signing them out prevents an
    // infinite /profile ↔ /login redirect loop ("Maximum update depth exceeded"):
    // StaffProfile redirects to /login on a missing profile, while /login
    // redirects an authenticated user back to /profile. PGRST116 = "no rows
    // returned"; we intentionally do NOT sign out on transient/network errors.
    if (!data && error?.code === 'PGRST116') {
      setStaff(null)
      await supabase.auth.signOut()
      return
    }

    setStaff(data ?? null)
  }

  async function refreshStaff() {
    if (user) await fetchStaff(user.id)
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session)
      setUser(session?.user ?? null)
      if (session?.user) fetchStaff(session.user.id).finally(() => setLoading(false))
      else setLoading(false)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session)
      setUser(session?.user ?? null)
      if (session?.user) fetchStaff(session.user.id)
      else setStaff(null)
    })

    return () => subscription.unsubscribe()
  }, [])

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    return { error: error as Error | null }
  }

  async function signOut() {
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider value={{ user, session, staff, loading, signIn, signOut, refreshStaff }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}
