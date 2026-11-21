import { useState } from 'react'
import { AVATARS, DEFAULT_NAME, NAME_MAX, cleanName, randomAvatar, type Guest } from './qrGuest'

/** "Who's ordering?" — an avatar and an optional name. `initial` null = a new guest (Start ordering);
 *  otherwise the guest is changing theirs (Save, and Cancel when given). */
export default function GuestCard({ initial, onDone, onCancel }: {
  initial: Guest | null
  /** the name is already cleaned ('Guest' when left empty) */
  onDone: (name: string, avatar: string) => void
  onCancel?: () => void
}) {
  const [avatar, setAvatar] = useState(() => initial?.avatar ?? randomAvatar())
  const [name, setName] = useState(initial && initial.name !== DEFAULT_NAME ? initial.name : '')
  return (
    <div className="m-3 rounded-2xl border border-border bg-card p-4">
      <h2 className="text-lg font-semibold text-brown-dark">Who's ordering?</h2>
      <div role="radiogroup" aria-label="Avatar" className="mt-3 grid grid-cols-4 gap-2">
        {AVATARS.map((a) => (
          <button key={a.key} type="button" role="radio" aria-checked={avatar === a.key} aria-label={`Avatar ${a.emoji}`}
            onClick={() => setAvatar(a.key)}
            className={`h-14 rounded-xl border-2 text-2xl ${avatar === a.key ? 'border-brown-btn bg-cream' : 'border-border'}`}>
            {a.emoji}
          </button>
        ))}
      </div>
      <label className="mt-3 block text-sm">
        Your name (optional)
        <input className="mt-1 w-full rounded-lg border border-border p-2 text-base" value={name} maxLength={NAME_MAX}
          autoComplete="given-name" onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="mt-4 flex gap-2">
        {onCancel && <button type="button" onClick={onCancel} className="flex-1 rounded-xl border border-border py-3">Cancel</button>}
        <button type="button" onClick={() => onDone(cleanName(name), avatar)}
          className="flex-[2] rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover">
          {initial ? 'Save' : 'Start ordering'}
        </button>
      </div>
    </div>
  )
}

/** The card over the page, reopened from the guest chip to change the name or avatar. */
export function GuestModal({ guest, onDone, onCancel }: { guest: Guest; onDone: (name: string, avatar: string) => void; onCancel: () => void }) {
  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 sm:items-center" onClick={onCancel}>
      <div className="w-full max-w-lg" onClick={(e) => e.stopPropagation()}>
        <GuestCard initial={guest} onDone={onDone} onCancel={onCancel} />
      </div>
    </div>
  )
}
