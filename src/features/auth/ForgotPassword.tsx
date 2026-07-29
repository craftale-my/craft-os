import { useState, FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')

    const { error: err } = await supabase.auth.resetPasswordForEmail(
      email.trim().toLowerCase(),
      { redirectTo: `${window.location.origin}/reset-password` }
    )

    setLoading(false)

    // Safe to surface errors: GoTrue answers /recover with 200 whether or not
    // the address has an account, so a failure here is a real one (rate limit,
    // network, misconfigured SMTP) rather than a signal about the email.
    if (err) {
      setError(
        err.status === 429
          ? 'Too many attempts. Please wait a few minutes and try again.'
          : 'Could not send the reset email. Please try again, or contact your manager.'
      )
      return
    }
    setSent(true)
  }

  if (sent) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center px-4">
        <div className="w-full max-w-sm text-center">
          <div className="text-5xl mb-4">📧</div>
          <h2 className="font-display text-2xl font-bold text-[#3D2B1F] mb-2">Check Your Email</h2>
          <p className="text-brown-muted text-sm mb-6 leading-relaxed">
            If an account exists for <span className="font-medium text-brown-dark">{email.trim()}</span>,
            we've sent a link to reset your password. The link expires in 1 hour.
          </p>
          <p className="text-xs text-brown-faint mb-6">
            Don't see it? Check your spam folder.
          </p>
          <Link to="/login" className="text-[#8B6344] text-sm font-medium hover:underline">
            ← Back to Sign In
          </Link>
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
          <p className="text-brown-muted text-sm tracking-widest uppercase">Reset Password</p>
          <div className="mt-4 mx-auto w-12 h-px bg-[#C4A882]" />
        </div>

        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-card p-8 space-y-5">
          <p className="text-xs text-brown-muted leading-relaxed">
            Enter the email you use for Craft OS and we'll send you a link to set a new password.
          </p>

          <div>
            <label className="block text-xs text-brown-muted mb-1.5 font-medium tracking-widest uppercase">
              Email
            </label>
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full bg-canvas border border-border-mid rounded-lg px-3.5 py-2.5 text-sm text-brown-dark placeholder-brown-faint focus:outline-none focus:border-[#8B6344] focus:ring-2 focus:ring-[#8B634420] transition-all"
              placeholder="you@craftale.com"
            />
          </div>

          {error && <p className="text-red-600 text-sm">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-brown-btn hover:bg-brown-btn-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg py-2.5 text-sm transition-colors"
          >
            {loading ? 'Sending…' : 'Send Reset Link'}
          </button>
        </form>

        <div className="mt-6 space-y-2 text-center">
          <p className="text-xs text-brown-faint">
            <Link to="/login" className="hover:underline">
              ← Back to Sign In
            </Link>
          </p>
          <p className="text-xs text-brown-faint">
            No longer have access to this email? Contact your manager.
          </p>
        </div>
      </div>
    </div>
  )
}
