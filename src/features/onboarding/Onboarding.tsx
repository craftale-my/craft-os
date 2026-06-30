import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../../shared/lib/supabase'
import { useAuth } from '../auth/AuthContext'

// ─── Data ─────────────────────────────────────────────────────────────────────

const BRANCHES = [
  'Cheras (Taman Connaught)',
  'Puchong (Bandar Puteri)',
  'Other',
]

const DEPARTMENTS = [
  'Barista (Full Time)',
  'Service Crew',
  'Bakery',
  'Kitchen',
  'Other',
]

const EMPLOYMENT_TYPES = ['Full Time / Contract', 'Part Time']

const COMPANY_VALUES = [
  {
    icon: '☕',
    title: 'Craft Excellence',
    desc: 'We take pride in every cup, every dish, and every experience we deliver to our guests.',
  },
  {
    icon: '❤️',
    title: 'Serve with Heart',
    desc: 'We treat every customer and teammate with genuine care, warmth, and respect.',
  },
  {
    icon: '🌱',
    title: 'Grow Together',
    desc: 'We invest in each other\'s growth, celebrate every milestone, and lift each other up.',
  },
  {
    icon: '💪',
    title: 'Own Your Journey',
    desc: 'We take full ownership of our craft, our growth, and the impact we create.',
  },
]

// ─── Types ────────────────────────────────────────────────────────────────────

interface FormData {
  branch: string
  department: string
  employmentType: string
  nickname: string
  fullName: string
  icNumber: string
  address: string
  gender: string
  dateOfBirth: string
  contactNumber: string
  workingExperience: string
  education: string
}

type FormErrors = Partial<Record<keyof FormData, string>>

// ─── Main Page ────────────────────────────────────────────────────────────────

export function OnboardingPage() {
  const navigate = useNavigate()
  const { user, staff, refreshStaff } = useAuth()

  const [step, setStep] = useState<1 | 2 | 3>(1)
  const [agreed, setAgreed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [errors, setErrors] = useState<FormErrors>({})

  const [formData, setFormData] = useState<FormData>({
    branch: '',
    department: '',
    employmentType: '',
    nickname: '',
    fullName: staff?.name ?? '',
    icNumber: staff?.ic_number ?? '',
    address: staff?.address ?? '',
    gender: staff?.gender ?? '',
    dateOfBirth: staff?.date_of_birth ?? '',
    contactNumber: staff?.contact_number ?? '',
    workingExperience: staff?.working_experience ?? '',
    education: staff?.education ?? '',
  })

  function update(field: keyof FormData, value: string) {
    setFormData(prev => ({ ...prev, [field]: value }))
    if (errors[field]) setErrors(prev => ({ ...prev, [field]: undefined }))
  }

  function validateStep2(): boolean {
    const required: (keyof FormData)[] = [
      'branch', 'department', 'employmentType',
      'fullName', 'icNumber', 'address', 'gender',
      'dateOfBirth', 'contactNumber', 'workingExperience', 'education',
    ]
    const next: FormErrors = {}
    for (const field of required) {
      if (!formData[field].trim()) next[field] = 'Required'
    }
    setErrors(next)
    return Object.keys(next).length === 0
  }

  async function handleSubmit() {
    if (!user) return
    setSaving(true)
    setSubmitError('')

    // Normalise department to lowercase for filter compatibility
    const deptMap: Record<string, string> = {
      'Barista (Full Time)': 'barista',
      'Service Crew':        'service crew',
      'Bakery':              'bakery',
      'Kitchen':             'kitchen',
    }

    const { error } = await supabase.from('staff').update({
      name:                 formData.fullName,
      nickname:             formData.nickname || null,
      department:           deptMap[formData.department] ?? formData.department.toLowerCase(),
      branch:               formData.branch,
      employment_type:      formData.employmentType,
      ic_number:            formData.icNumber,
      address:              formData.address,
      gender:               formData.gender,
      date_of_birth:        formData.dateOfBirth,
      contact_number:       formData.contactNumber,
      working_experience:   formData.workingExperience,
      education:            formData.education,
      onboarding_completed: true,
    }).eq('id', user.id)

    if (error) {
      setSubmitError(error.message)
      setSaving(false)
      return
    }

    await refreshStaff()
    navigate('/profile', { replace: true })
  }

  return (
    <div className="min-h-screen bg-cream">
      {/* Header */}
      <div className="bg-[#4A2E1A] py-4 px-4 sticky top-0 z-10">
        <div className="max-w-lg mx-auto flex items-center justify-between">
          <div>
            <p className="font-display text-[#F5F0E8] font-bold text-lg leading-none">Craft OS</p>
            <p className="text-[#C4A882] text-xs mt-0.5">New Staff Onboarding</p>
          </div>
          <span className="text-[#C4A882] text-xs">Step {step} of 3</span>
        </div>
      </div>

      <div className="max-w-lg mx-auto px-4 py-8 pb-16">
        <StepProgress current={step} />

        {step === 1 && (
          <WelcomeStep
            staffName={staff?.name}
            agreed={agreed}
            onAgreed={setAgreed}
            onNext={() => setStep(2)}
          />
        )}
        {step === 2 && (
          <InfoStep
            formData={formData}
            errors={errors}
            email={user?.email ?? ''}
            onUpdate={update}
            onBack={() => setStep(1)}
            onNext={() => { if (validateStep2()) setStep(3) }}
          />
        )}
        {step === 3 && (
          <ConfirmStep
            formData={formData}
            email={user?.email ?? ''}
            saving={saving}
            submitError={submitError}
            onBack={() => setStep(2)}
            onSubmit={handleSubmit}
          />
        )}
      </div>
    </div>
  )
}

// ─── Step Progress ────────────────────────────────────────────────────────────

function StepProgress({ current }: { current: number }) {
  const labels = ['Welcome', 'Your Info', 'Confirm']
  return (
    <div className="flex items-center justify-center mb-8">
      {labels.map((label, i) => {
        const n = i + 1
        const done = n < current
        const active = n === current
        return (
          <div key={n} className="flex items-center">
            <div className="flex flex-col items-center">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold transition-colors ${
                  done    ? 'bg-[#4A2E1A] text-[#F5F0E8]' :
                  active  ? 'bg-[#8B6344] text-white' :
                             'bg-[#EDE5D8] text-[#8B7355]'
                }`}
              >
                {done ? '✓' : n}
              </div>
              <span className={`text-xs mt-1.5 font-medium ${active ? 'text-[#3D2B1F]' : 'text-[#8B7355]'}`}>
                {label}
              </span>
            </div>
            {i < 2 && (
              <div
                className={`w-16 h-0.5 mb-5 mx-1 transition-colors ${n < current ? 'bg-[#4A2E1A]' : 'bg-[#EDE5D8]'}`}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

// ─── Step 1 — Welcome ─────────────────────────────────────────────────────────

function WelcomeStep({
  staffName,
  agreed,
  onAgreed,
  onNext,
}: {
  staffName?: string
  agreed: boolean
  onAgreed: (v: boolean) => void
  onNext: () => void
}) {
  return (
    <div className="space-y-6">
      {/* Hero */}
      <div className="bg-[#4A2E1A] rounded-2xl p-6 text-center">
        <p className="text-3xl mb-3">🎉</p>
        <h1 className="font-display text-2xl font-bold text-[#F5F0E8] mb-1">
          Welcome to Craftale{staffName ? `, ${staffName.split(' ')[0]}` : ''}!
        </h1>
        <p className="text-[#C4A882] text-sm leading-relaxed">
          We're thrilled to have you join our family. Before you dive in, take a moment to
          understand who we are and what we stand for.
        </p>
      </div>

      {/* Company intro */}
      <div className="bg-white rounded-2xl shadow-card p-6">
        <h2 className="font-display text-lg font-bold text-brown-dark mb-3">About Craftale Sdn Bhd</h2>
        <p className="text-sm text-brown-muted leading-relaxed">
          Craftale is a specialty cafe brand built on the belief that great coffee and genuine
          hospitality can change someone's day. We operate barista bars, a bakery, a kitchen,
          a coffee roastery, workshops, and B2B catering — all connected by one passion: craft.
        </p>
        <p className="text-sm text-brown-muted leading-relaxed mt-3">
          Every person on this team is a craftsperson. Whether you're behind the bar, in the
          kitchen, or supporting operations — your work matters, and so does your growth.
        </p>
      </div>

      {/* Company values */}
      <div>
        <h2 className="font-display text-lg font-bold text-brown-dark mb-3">Our Values</h2>
        <div className="space-y-3">
          {COMPANY_VALUES.map(v => (
            <div key={v.title} className="bg-white rounded-xl shadow-card p-4 flex gap-4">
              <span className="text-2xl shrink-0">{v.icon}</span>
              <div>
                <p className="text-sm font-semibold text-brown-dark">{v.title}</p>
                <p className="text-xs text-brown-muted mt-0.5 leading-relaxed">{v.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Acknowledgement */}
      <label className="flex items-start gap-3 cursor-pointer bg-white rounded-xl shadow-card p-4">
        <input
          type="checkbox"
          checked={agreed}
          onChange={e => onAgreed(e.target.checked)}
          className="w-4 h-4 mt-0.5 shrink-0 accent-[#8B6344]"
        />
        <span className="text-sm text-brown-dark leading-relaxed">
          I have read and understood Craftale's company values, and I commit to upholding them
          as a member of this team.
        </span>
      </label>

      <button
        onClick={onNext}
        disabled={!agreed}
        className="w-full bg-brown-btn hover:bg-brown-btn-hover disabled:opacity-40 disabled:cursor-not-allowed text-white font-semibold py-3 rounded-xl transition-colors text-sm"
      >
        Next: Fill Your Info →
      </button>
    </div>
  )
}

// ─── Step 2 — Personal Info ───────────────────────────────────────────────────

function InfoStep({
  formData,
  errors,
  email,
  onUpdate,
  onBack,
  onNext,
}: {
  formData: FormData
  errors: FormErrors
  email: string
  onUpdate: (field: keyof FormData, value: string) => void
  onBack: () => void
  onNext: () => void
}) {
  return (
    <div className="space-y-8">
      {/* Branch */}
      <FormSection title="Which branch will you be working at?" required>
        <div className="space-y-2">
          {BRANCHES.map(b => (
            <RadioTile
              key={b}
              value={b}
              selected={formData.branch === b}
              onChange={v => onUpdate('branch', v)}
            >
              {b}
            </RadioTile>
          ))}
        </div>
        {errors.branch && <FieldError>{errors.branch}</FieldError>}
      </FormSection>

      {/* Department */}
      <FormSection title="Your department" required>
        <div className="space-y-2">
          {DEPARTMENTS.map(d => (
            <RadioTile
              key={d}
              value={d}
              selected={formData.department === d}
              onChange={v => onUpdate('department', v)}
            >
              {d}
            </RadioTile>
          ))}
        </div>
        {errors.department && <FieldError>{errors.department}</FieldError>}
      </FormSection>

      {/* Employment Type */}
      <FormSection title="Employment type" required>
        <div className="space-y-2">
          {EMPLOYMENT_TYPES.map(t => (
            <RadioTile
              key={t}
              value={t}
              selected={formData.employmentType === t}
              onChange={v => onUpdate('employmentType', v)}
            >
              {t}
            </RadioTile>
          ))}
        </div>
        {errors.employmentType && <FieldError>{errors.employmentType}</FieldError>}
      </FormSection>

      {/* Personal Details */}
      <FormSection title="Personal details">
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <InputField
              label="Nickname"
              value={formData.nickname}
              onChange={v => onUpdate('nickname', v)}
              placeholder="What should we call you?"
            />
            <InputField
              label="Full Name"
              required
              value={formData.fullName}
              onChange={v => onUpdate('fullName', v)}
              placeholder="As per IC"
              error={errors.fullName}
            />
          </div>

          <InputField
            label="Malaysia IC Number"
            required
            value={formData.icNumber}
            onChange={v => onUpdate('icNumber', v)}
            placeholder="e.g. 900101-14-1234"
            error={errors.icNumber}
          />

          <InputField
            label="Address"
            required
            value={formData.address}
            onChange={v => onUpdate('address', v)}
            placeholder="Full residential address"
            multiline
            error={errors.address}
          />

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Gender */}
            <div>
              <label className="block text-xs text-brown-muted mb-1.5 font-medium tracking-widest uppercase">
                Gender <span className="text-[#C06242]">*</span>
              </label>
              <div className="flex gap-2">
                {['Man', 'Woman'].map(g => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => onUpdate('gender', g)}
                    className={`flex-1 py-2.5 rounded-xl border text-sm font-medium transition-all ${
                      formData.gender === g
                        ? 'border-[#8B6344] bg-[#8B634410] text-[#8B6344] ring-1 ring-[#8B634430]'
                        : 'border-[#EDE5D8] bg-white text-brown-muted hover:border-[#D4C5B0]'
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
              {errors.gender && <FieldError>{errors.gender}</FieldError>}
            </div>

            <InputField
              label="Date of Birth"
              required
              type="date"
              value={formData.dateOfBirth}
              onChange={v => onUpdate('dateOfBirth', v)}
              error={errors.dateOfBirth}
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <InputField
              label="Contact Number"
              required
              type="tel"
              value={formData.contactNumber}
              onChange={v => onUpdate('contactNumber', v)}
              placeholder="e.g. 012-345 6789"
              error={errors.contactNumber}
            />
            {/* Email is read-only — from auth */}
            <div>
              <label className="block text-xs text-brown-muted mb-1.5 font-medium tracking-widest uppercase">
                Email
              </label>
              <div className="w-full bg-[#F5F0E8] border border-[#EDE5D8] rounded-lg px-3.5 py-2.5 text-sm text-brown-muted">
                {email}
              </div>
            </div>
          </div>

          <InputField
            label="Working Experience"
            required
            value={formData.workingExperience}
            onChange={v => onUpdate('workingExperience', v)}
            placeholder="Describe your relevant work experience"
            multiline
            error={errors.workingExperience}
          />

          <InputField
            label="Education Background"
            required
            value={formData.education}
            onChange={v => onUpdate('education', v)}
            placeholder="Highest qualification & institution"
            multiline
            error={errors.education}
          />
        </div>
      </FormSection>

      {/* Nav */}
      <div className="flex gap-3">
        <button
          onClick={onBack}
          className="px-5 py-3 rounded-xl border border-border-mid text-brown-muted hover:text-brown-dark hover:border-[#B8A890] text-sm font-medium transition-colors"
        >
          ← Back
        </button>
        <button
          onClick={onNext}
          className="flex-1 bg-brown-btn hover:bg-brown-btn-hover text-white font-semibold py-3 rounded-xl transition-colors text-sm"
        >
          Review & Confirm →
        </button>
      </div>
    </div>
  )
}

// ─── Step 3 — Confirmation ────────────────────────────────────────────────────

function ConfirmStep({
  formData,
  email,
  saving,
  submitError,
  onBack,
  onSubmit,
}: {
  formData: FormData
  email: string
  saving: boolean
  submitError: string
  onBack: () => void
  onSubmit: () => void
}) {
  const sections: { label: string; value: string }[][] = [
    [
      { label: 'Branch',           value: formData.branch },
      { label: 'Department',       value: formData.department },
      { label: 'Employment',       value: formData.employmentType },
    ],
    [
      { label: 'Full Name',        value: formData.fullName },
      { label: 'Nickname',         value: formData.nickname || '—' },
      { label: 'IC Number',        value: formData.icNumber },
      { label: 'Gender',           value: formData.gender },
      { label: 'Date of Birth',    value: formData.dateOfBirth },
      { label: 'Contact',          value: formData.contactNumber },
      { label: 'Email',            value: email },
      { label: 'Address',          value: formData.address },
    ],
    [
      { label: 'Experience',       value: formData.workingExperience },
      { label: 'Education',        value: formData.education },
    ],
  ]

  return (
    <div className="space-y-6">
      <div className="text-center">
        <p className="text-3xl mb-2">🎯</p>
        <h2 className="font-display text-xl font-bold text-brown-dark">Almost there!</h2>
        <p className="text-brown-muted text-sm mt-1">Review your details before submitting.</p>
      </div>

      {sections.map((group, gi) => (
        <div key={gi} className="bg-white rounded-2xl shadow-card overflow-hidden">
          {group.map((row, ri) => (
            <div
              key={row.label}
              className={`flex gap-3 px-5 py-3 ${ri < group.length - 1 ? 'border-b border-[#F0E8DC]' : ''}`}
            >
              <span className="text-xs text-brown-muted uppercase tracking-wider font-medium w-24 shrink-0 pt-0.5">
                {row.label}
              </span>
              <span className="text-sm text-brown-dark break-words min-w-0">{row.value || '—'}</span>
            </div>
          ))}
        </div>
      ))}

      {submitError && (
        <div className="bg-[#C0624210] border border-[#C0624230] rounded-xl px-4 py-3">
          <p className="text-sm text-[#9E4A30]">Submission failed: {submitError}</p>
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={onBack}
          disabled={saving}
          className="px-5 py-3 rounded-xl border border-border-mid text-brown-muted hover:text-brown-dark hover:border-[#B8A890] text-sm font-medium transition-colors disabled:opacity-50"
        >
          ← Back
        </button>
        <button
          onClick={onSubmit}
          disabled={saving}
          className="flex-1 bg-[#4A2E1A] hover:bg-[#3A2010] disabled:opacity-50 text-[#F5F0E8] font-semibold py-3 rounded-xl transition-colors text-sm"
        >
          {saving ? 'Submitting…' : 'Submit & Start My Journey 🚀'}
        </button>
      </div>
    </div>
  )
}

// ─── Small components ─────────────────────────────────────────────────────────

function FormSection({
  title,
  required,
  children,
}: {
  title: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div>
      <h3 className="font-semibold text-brown-dark mb-3">
        {title}
        {required && <span className="text-[#C06242] ml-1">*</span>}
      </h3>
      {children}
    </div>
  )
}

function RadioTile({
  value,
  selected,
  onChange,
  children,
}: {
  value: string
  selected: boolean
  onChange: (v: string) => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(value)}
      className={`w-full text-left px-4 py-3 rounded-xl border transition-all ${
        selected
          ? 'border-[#8B6344] bg-[#8B634410] ring-1 ring-[#8B634430]'
          : 'border-[#EDE5D8] bg-white hover:border-[#D4C5B0]'
      }`}
    >
      <div className="flex items-center gap-3">
        <div
          className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${
            selected ? 'border-[#8B6344]' : 'border-[#D4C5B0]'
          }`}
        >
          {selected && <div className="w-2 h-2 rounded-full bg-[#8B6344]" />}
        </div>
        <span className="text-sm text-brown-dark">{children}</span>
      </div>
    </button>
  )
}

function InputField({
  label,
  value,
  onChange,
  placeholder = '',
  type = 'text',
  required,
  multiline,
  error,
}: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  type?: string
  required?: boolean
  multiline?: boolean
  error?: string
}) {
  const cls = `w-full bg-canvas border rounded-lg px-3.5 py-2.5 text-sm text-brown-dark placeholder-brown-faint focus:outline-none focus:ring-2 focus:ring-[#8B634420] transition-all ${
    error ? 'border-[#C06242] focus:border-[#C06242]' : 'border-border-mid focus:border-[#8B6344]'
  }`

  return (
    <div>
      <label className="block text-xs text-brown-muted mb-1.5 font-medium tracking-widest uppercase">
        {label}
        {required && <span className="text-[#C06242] ml-1">*</span>}
      </label>
      {multiline ? (
        <textarea
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          rows={2}
          className={`${cls} resize-none`}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={placeholder}
          className={cls}
        />
      )}
      {error && <FieldError>{error}</FieldError>}
    </div>
  )
}

function FieldError({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-[#C06242] mt-1">{children}</p>
}
