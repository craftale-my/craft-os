import { useState, FormEvent } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuth } from './AuthContext'

export function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const { signIn } = useAuth()
  const navigate = useNavigate()

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setLoading(true)
    const { error } = await signIn(email, password)
    setLoading(false)
    if (error) {
      setError('Invalid email or password.')
      return
    }
    // Go to the index route, which redirects by rank once the staff profile has
    // loaded. Reading staff?.rank here is unreliable — the profile fetch kicked
    // off by the auth state change hasn't resolved yet.
    navigate('/', { replace: true })
  }

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center px-4">
      <div className="w-full max-w-sm">

        {/* Logo */}
        <div className="mb-10 text-center">
          <img
            src="/craft-logo.jpg"
            alt="Craft Cafe"
            className="w-20 h-20 mx-auto mb-3 rounded-full object-cover"
          />
          <h1 className="font-display text-4xl font-bold text-[#3D2B1F] mb-1 tracking-tight">
            Craft OS
          </h1>
          <p className="text-brown-muted text-sm tracking-widest uppercase">
            Craftale Staff Portal
          </p>
          <div className="mt-4 mx-auto w-12 h-px bg-[#C4A882]" />
        </div>

        <form
          onSubmit={handleSubmit}
          className="bg-white rounded-2xl shadow-card p-8 space-y-5"
        >
          <div>
            <label className="block text-xs text-brown-muted mb-1.5 font-medium tracking-widest uppercase">
              Email
            </label>
            <input
              type="email"
              required
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full bg-canvas border border-border-mid rounded-lg px-3.5 py-2.5 text-sm text-brown-dark placeholder-brown-faint focus:outline-none focus:border-[#8B6344] focus:ring-2 focus:ring-[#8B634420] transition-all"
              placeholder="you@craftale.com"
            />
          </div>

          <div>
            <label className="block text-xs text-brown-muted mb-1.5 font-medium tracking-widest uppercase">
              Password
            </label>
            <input
              type="password"
              required
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full bg-canvas border border-border-mid rounded-lg px-3.5 py-2.5 text-sm text-brown-dark placeholder-brown-faint focus:outline-none focus:border-[#8B6344] focus:ring-2 focus:ring-[#8B634420] transition-all"
              placeholder="••••••••"
            />
          </div>

          {error && (
            <p className="text-red-600 text-sm">{error}</p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-brown-btn hover:bg-brown-btn-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg py-2.5 text-sm transition-colors"
          >
            {loading ? 'Signing in…' : 'Sign In'}
          </button>
        </form>

        <div className="mt-6 space-y-2 text-center">
          <p className="text-sm text-brown-muted">
            New here?{' '}
            <Link
              to="/register"
              className="text-[#8B6344] font-medium hover:underline"
            >
              Request an account
            </Link>
          </p>
          <p className="text-xs text-brown-faint">
            Contact your manager if you can't access your account.
          </p>
        </div>
      </div>
    </div>
  )
}
