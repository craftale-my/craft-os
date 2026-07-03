import type { ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './features/auth/AuthContext'
import { ProtectedRoute, OnboardingRoute } from './features/auth/ProtectedRoute'
import { Sidebar } from './shared/components/Sidebar'
import { LoginPage } from './features/auth/Login'
import { RegisterPage } from './features/auth/Register'
import { OnboardingPage } from './features/onboarding/Onboarding'
import DashboardPage from './features/staff/Dashboard'
import { StaffProfilePage } from './features/staff/StaffProfile'
import { MissionsPage } from './features/missions/Missions'
import ProbationReviewPage from './features/reviews/ProbationReview'
import TasksPage from './features/tasks/Tasks'
import SettingsPage from './features/settings/Settings'
import HrAttendancePage from './features/hr/HrAttendance'
import HrSalaryPage from './features/hr/HrSalary'
import HrLeavePage from './features/hr/HrLeave'
import HrClaimsPage from './features/hr/HrClaims'
import SchedulePage from './features/schedule/Schedule'

function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F5F0E8]">
      <Sidebar />
      <main className="sm:ml-60 pt-14 sm:pt-0 min-h-screen">{children}</main>
    </div>
  )
}

function DeactivatedScreen() {
  const { signOut } = useAuth()
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[#F5F0E8] px-6 text-center">
      <div className="text-4xl mb-4">🔒</div>
      <h1 className="text-xl font-bold text-brown-dark mb-2">Account Deactivated</h1>
      <p className="text-sm text-brown-muted max-w-sm mb-6">
        This account has been marked as resigned and can no longer access Craft OS.
        Please contact your manager if you believe this is a mistake.
      </p>
      <button
        onClick={signOut}
        className="px-5 py-2.5 rounded-xl bg-[#C4813A] text-white text-sm font-semibold hover:bg-[#A86C2C] transition-colors"
      >
        Sign Out
      </button>
    </div>
  )
}

function AuthSpinner() {
  return (
    <div className="min-h-screen bg-cream flex items-center justify-center">
      <div className="w-8 h-8 rounded-full border-2 border-[#8B6344] border-t-transparent animate-spin" />
    </div>
  )
}

function AppRoutes() {
  const { user, staff, loading } = useAuth()

  // Auth is still settling. `user && !staff` covers the post-login window where
  // the session exists but the staff profile hasn't been fetched yet — without
  // this guard the app briefly renders routes with no staff and ping-pongs
  // between /profile and /login (blank screen until you refresh).
  // A genuinely missing staff row signs the user out (see AuthContext), which
  // clears `user` and drops through to /login rather than spinning forever.
  if (loading || (user && !staff)) {
    return <AuthSpinner />
  }

  // Resigned staff are blocked from using the app entirely (data is retained).
  if (user && staff?.status === 'resigned') {
    return <DeactivatedScreen />
  }

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <LoginPage />} />
      <Route path="/register" element={user ? <Navigate to="/" replace /> : <RegisterPage />} />

      <Route
        path="/onboarding"
        element={
          <OnboardingRoute>
            <OnboardingPage />
          </OnboardingRoute>
        }
      />

      <Route
        path="/dashboard"
        element={
          <ProtectedRoute requireRank={['supervisor', 'manager']}>
            <AppLayout><DashboardPage /></AppLayout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/staff/:id"
        element={
          <ProtectedRoute requireRank={['supervisor', 'manager']}>
            <AppLayout><StaffProfilePage /></AppLayout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/profile"
        element={
          <ProtectedRoute>
            <AppLayout><StaffProfilePage selfView /></AppLayout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/probation/:staffId"
        element={
          <ProtectedRoute requireRank={['supervisor', 'manager']}>
            <AppLayout><ProbationReviewPage /></AppLayout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/missions"
        element={
          <ProtectedRoute requireRank={['manager']}>
            <AppLayout><MissionsPage /></AppLayout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/tasks"
        element={
          <ProtectedRoute>
            <AppLayout><TasksPage /></AppLayout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/hr/attendance"
        element={
          <ProtectedRoute>
            <AppLayout><HrAttendancePage /></AppLayout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/hr/salary"
        element={
          <ProtectedRoute>
            <AppLayout><HrSalaryPage /></AppLayout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/hr/leave"
        element={
          <ProtectedRoute>
            <AppLayout><HrLeavePage /></AppLayout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/hr/claims"
        element={
          <ProtectedRoute>
            <AppLayout><HrClaimsPage /></AppLayout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/schedule"
        element={
          <ProtectedRoute requireRank={['supervisor', 'manager']}>
            <AppLayout><SchedulePage /></AppLayout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/settings"
        element={
          <ProtectedRoute requireRank={['manager']}>
            <AppLayout><SettingsPage /></AppLayout>
          </ProtectedRoute>
        }
      />

      <Route
        path="/"
        element={
          user
            ? <Navigate to={
                staff?.rank === 'manager' || staff?.rank === 'supervisor'
                  ? '/dashboard'
                  : '/profile'
              } replace />
            : <Navigate to="/login" replace />
        }
      />

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <div className="min-h-screen bg-cream text-brown-dark font-body">
          <AppRoutes />
        </div>
      </AuthProvider>
    </BrowserRouter>
  )
}
