import { Navigate } from 'react-router-dom'
import { useAuth } from '../contexts/AuthContext'
import type { Rank } from '../types'

interface Props {
  children: React.ReactNode
  requireRank?: Rank[]
}

function Spinner() {
  return (
    <div className="min-h-screen bg-cream flex items-center justify-center">
      <div className="w-8 h-8 rounded-full border-2 border-[#8B6344] border-t-transparent animate-spin" />
    </div>
  )
}

/** All protected routes — requires auth + completed onboarding (managers exempt). */
export function ProtectedRoute({ children, requireRank }: Props) {
  const { user, staff, loading } = useAuth()

  if (loading) return <Spinner />
  if (!user) return <Navigate to="/login" replace />

  // Redirect to onboarding if not yet completed (managers bypass)
  if (staff && !staff.onboarding_completed && staff.rank !== 'manager') {
    return <Navigate to="/onboarding" replace />
  }

  if (requireRank && staff && !requireRank.includes(staff.rank)) {
    return <Navigate to="/profile" replace />
  }

  return <>{children}</>
}

/** Onboarding route — requires auth, redirects away if already onboarded. */
export function OnboardingRoute({ children }: { children: React.ReactNode }) {
  const { user, staff, loading } = useAuth()

  if (loading) return <Spinner />
  if (!user) return <Navigate to="/login" replace />

  if (staff?.onboarding_completed || staff?.rank === 'manager') {
    const dest = staff.rank === 'manager' || staff.rank === 'supervisor' ? '/dashboard' : '/profile'
    return <Navigate to={dest} replace />
  }

  return <>{children}</>
}
