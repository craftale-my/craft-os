import { useState, FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from './AuthContext'

const MIN_LENGTH = 8

/**
 * Landing page for the password recovery email link.
 *
 * The link arrives as `/reset-password#access_token=…&type=recovery`, and the
 * Supabase client turns that hash into a real session on startup
 * (detectSessionInUrl is on by default), so by the time this renders `user` is
 * already populated — App gates all routes behind AuthContext's `loading`.
 * A dead link instead leaves `#error=…` in the URL, which is what we read below.
 */
export function ResetPasswordPage() {
  const { user, signOut } = useAuth()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  // Read once at mount: the success path strips the hash, but the error path
  // leaves it in place.
  const [linkError] = useState(() => {
    const params = new URLSearchParams(window.location.hash.replace(/^#/, ''))
    return params.get('error_description') || params.get('error')
  })

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')

    if (password.length < MIN_LENGTH) {
      setError(`Password must be at least ${MIN_LENGTH} characters.`)
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setLoading(true)
    const { error: err } = await supabase.auth.updateUser({ password })
    setLoading(false)

    if (err) {
      setError(err.message)
      return
    }

    // Sign out so the new password is actually exercised at the login screen —
    // clicking an email link shouldn't leave a live session behind.
    setDone(true)
    await signOut()
  }

  // Checked before the session check: signOut() above clears `user`.
  if (done) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center px-4">
        <div className="w-full max-w-sm text-center">
          <div className="text-5xl mb-4">✅</div>
          <h2 className="font-display text-2xl font-bold text-[#3D2B1F] mb-2">Password Updated</h2>
          <p className="text-brown-muted text-sm mb-6">
            Your password has been changed. Sign in with your new password to continue.
          </p>
          <Link
            to="/login"
            className="inline-block bg-brown-btn hover:bg-brown-btn-hover text-white font-semibold rounded-lg px-6 py-2.5 text-sm transition-colors"
          >
            Sign In
          </Link>
        </div>
      </div>
    )
  }

  if (linkError || !user) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center px-4">
        <div className="w-full max-w-sm text-center">
          <div className="text-5xl mb-4">⚠️</div>
          <h2 className="font-display text-2xl font-bold text-[#3D2B1F] mb-2">Link Expired</h2>
          <p className="text-brown-muted text-sm mb-6 leading-relaxed">
            This reset link is no longer valid — it may have expired or already been used.
            Request a new one to continue.
          </p>
          <Link
            to="/forgot-password"
            className="inline-block bg-brown-btn hover:bg-brown-btn-hover text-white font-semibold rounded-lg px-6 py-2.5 text-sm transition-colors"
          >
            Request New Link
          </Link>
          <p className="text-xs text-brown-faint mt-6">
            <Link to="/login" className="hover:underline">
              ← Back to Sign In
            </Link>
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="font-display text-4xl font-bold text-[#3D2B1F] mb-1 tracking-tight">
            Craft OS
          </h1>
          <p className="text-brown-muted text-sm tracking-widest uppercase">Set New Password</p>
          <div className="mt-4 mx-auto w-12 h-px bg-[#C4A882]" />
        </div>

        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-card p-8 space-y-5">
          <p className="text-xs text-brown-muted leading-relaxed">
            Setting a new password for{' '}
            <span className="font-medium text-brown-dark">{user.email}</span>.
          </p>

          <div>
            <label className="block text-xs text-brown-muted mb-1.5 font-medium tracking-widest uppercase">
              New Password
            </label>
            <input
              type="password"
              required
              autoFocus
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full bg-canvas border border-border-mid rounded-lg px-3.5 py-2.5 text-sm text-brown-dark placeholder-brown-faint focus:outline-none focus:border-[#8B6344] focus:ring-2 focus:ring-[#8B634420] transition-all"
              placeholder="••••••••"
            />
            <p className="mt-1.5 text-xs text-brown-faint">At least {MIN_LENGTH} characters.</p>
          </div>

          <div>
            <label className="block text-xs text-brown-muted mb-1.5 font-medium tracking-widest uppercase">
              Confirm Password
            </label>
            <input
              type="password"
              required
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              className="w-full bg-canvas border border-border-mid rounded-lg px-3.5 py-2.5 text-sm text-brown-dark placeholder-brown-faint focus:outline-none focus:border-[#8B6344] focus:ring-2 focus:ring-[#8B634420] transition-all"
              placeholder="••••••••"
            />
          </div>

          {error && <p className="text-red-600 text-sm">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-brown-btn hover:bg-brown-btn-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg py-2.5 text-sm transition-colors"
          >
            {loading ? 'Updating…' : 'Update Password'}
          </button>
        </form>
      </div>
    </div>
  )
}
