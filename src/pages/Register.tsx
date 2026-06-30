import { useState, FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { BRANCHES, DEPARTMENTS, EMPLOYMENT_TYPES } from '../types'

export function RegisterPage() {
  const [form, setForm] = useState({
    full_name: '',
    email: '',
    phone: '',
    branch: '',
    department: '',
    employment_type: '',
  })
  const [loading, setLoading] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [error, setError] = useState('')

  const set =
    (k: string) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!form.full_name.trim() || !form.email.trim()) {
      setError('Full name and email are required.')
      return
    }
    setLoading(true)
    setError('')

    const { error: err } = await supabase.from('registration_requests').insert({
      full_name: form.full_name.trim(),
      email: form.email.trim().toLowerCase(),
      phone: form.phone.trim() || null,
      branch: form.branch || null,
      department: form.department || null,
      employment_type: form.employment_type || null,
    })

    setLoading(false)
    if (err) {
      setError(err.message.includes('duplicate') ? 'An account request for this email already exists.' : 'Failed to submit. Please try again.')
      return
    }
    setSubmitted(true)
  }

  if (submitted) {
    return (
      <div className="min-h-screen bg-cream flex items-center justify-center px-4">
        <div className="w-full max-w-sm text-center">
          <div className="text-5xl mb-4">✅</div>
          <h2 className="font-display text-2xl font-bold text-[#3D2B1F] mb-2">Request Submitted</h2>
          <p className="text-brown-muted text-sm mb-6">
            Your request has been submitted. A manager will review it and contact you with login
            details.
          </p>
          <Link to="/login" className="text-[#8B6344] text-sm font-medium hover:underline">
            ← Back to Sign In
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-cream flex items-center justify-center px-4 py-8">
      <div className="w-full max-w-sm">
        {/* Header */}
        <div className="mb-8 text-center">
          <h1 className="font-display text-4xl font-bold text-[#3D2B1F] mb-1 tracking-tight">
            Craft OS
          </h1>
          <p className="text-brown-muted text-sm tracking-widest uppercase">Request an Account</p>
          <div className="mt-4 mx-auto w-12 h-px bg-[#C4A882]" />
        </div>

        <form onSubmit={handleSubmit} className="bg-white rounded-2xl shadow-card p-8 space-y-4">
          <p className="text-xs text-brown-muted leading-relaxed">
            Submit your details below. A manager or supervisor will review and approve your account.
          </p>

          {/* Full Name */}
          <div>
            <label className="block text-xs text-brown-muted mb-1.5 font-medium tracking-widest uppercase">
              Full Name *
            </label>
            <input
              type="text"
              required
              value={form.full_name}
              onChange={set('full_name')}
              className="w-full bg-canvas border border-border-mid rounded-lg px-3.5 py-2.5 text-sm text-brown-dark placeholder-brown-faint focus:outline-none focus:border-[#8B6344] focus:ring-2 focus:ring-[#8B634420] transition-all"
              placeholder="Your full name"
            />
          </div>

          {/* Email */}
          <div>
            <label className="block text-xs text-brown-muted mb-1.5 font-medium tracking-widest uppercase">
              Email *
            </label>
            <input
              type="email"
              required
              value={form.email}
              onChange={set('email')}
              className="w-full bg-canvas border border-border-mid rounded-lg px-3.5 py-2.5 text-sm text-brown-dark placeholder-brown-faint focus:outline-none focus:border-[#8B6344] focus:ring-2 focus:ring-[#8B634420] transition-all"
              placeholder="you@example.com"
            />
          </div>

          {/* Phone */}
          <div>
            <label className="block text-xs text-brown-muted mb-1.5 font-medium tracking-widest uppercase">
              Phone Number
            </label>
            <input
              type="tel"
              value={form.phone}
              onChange={set('phone')}
              className="w-full bg-canvas border border-border-mid rounded-lg px-3.5 py-2.5 text-sm text-brown-dark placeholder-brown-faint focus:outline-none focus:border-[#8B6344] focus:ring-2 focus:ring-[#8B634420] transition-all"
              placeholder="+60 12-345 6789"
            />
          </div>

          {/* Branch */}
          <div>
            <label className="block text-xs text-brown-muted mb-1.5 font-medium tracking-widest uppercase">
              Branch
            </label>
            <select
              value={form.branch}
              onChange={set('branch')}
              className="w-full bg-canvas border border-border-mid rounded-lg px-3.5 py-2.5 text-sm text-brown-dark focus:outline-none focus:border-[#8B6344] focus:ring-2 focus:ring-[#8B634420] transition-all"
            >
              <option value="">Select branch…</option>
              {BRANCHES.map(b => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>

          {/* Department */}
          <div>
            <label className="block text-xs text-brown-muted mb-1.5 font-medium tracking-widest uppercase">
              Department
            </label>
            <select
              value={form.department}
              onChange={set('department')}
              className="w-full bg-canvas border border-border-mid rounded-lg px-3.5 py-2.5 text-sm text-brown-dark focus:outline-none focus:border-[#8B6344] focus:ring-2 focus:ring-[#8B634420] transition-all"
            >
              <option value="">Select department…</option>
              {DEPARTMENTS.map(d => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </div>

          {/* Employment Type */}
          <div>
            <label className="block text-xs text-brown-muted mb-1.5 font-medium tracking-widest uppercase">
              Employment Type
            </label>
            <select
              value={form.employment_type}
              onChange={set('employment_type')}
              className="w-full bg-canvas border border-border-mid rounded-lg px-3.5 py-2.5 text-sm text-brown-dark focus:outline-none focus:border-[#8B6344] focus:ring-2 focus:ring-[#8B634420] transition-all"
            >
              <option value="">Select employment type…</option>
              {EMPLOYMENT_TYPES.map(t => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>

          {error && <p className="text-red-600 text-sm">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full bg-brown-btn hover:bg-brown-btn-hover disabled:opacity-50 disabled:cursor-not-allowed text-white font-semibold rounded-lg py-2.5 text-sm transition-colors"
          >
            {loading ? 'Submitting…' : 'Submit Request'}
          </button>
        </form>

        <p className="text-center text-xs text-brown-faint mt-6">
          <Link to="/login" className="hover:underline">
            ← Back to Sign In
          </Link>
        </p>
      </div>
    </div>
  )
}
