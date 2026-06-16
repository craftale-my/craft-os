import type { ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ProtectedRoute, OnboardingRoute } from './components/ProtectedRoute'
import { Sidebar } from './components/Sidebar'
import { LoginPage } from './pages/Login'
import { OnboardingPage } from './pages/Onboarding'
import DashboardPage from './pages/Dashboard'
import { StaffProfilePage } from './pages/StaffProfile'
import { MissionsPage } from './pages/Missions'
import ProbationReviewPage from './pages/ProbationReview'
import TasksPage from './pages/Tasks'

function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-[#F5F0E8]">
      <Sidebar />
      <main className="sm:ml-60 pt-14 sm:pt-0 min-h-screen">{children}</main>
    </div>
  )
}

function AppRoutes() {
  const { user, staff } = useAuth()

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/profile" replace /> : <LoginPage />} />

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
