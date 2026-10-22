import { useEffect, useState, type FormEvent } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../../../shared/lib/supabase'
import CounterOrder from './CounterOrder'
import LiveOrders from './LiveOrders'
import PrintHostPanel from './PrintHostPanel'
import { fetchTables, type SpikeTable } from './spikeApi'

function SignIn() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const { error: err } = await supabase.auth.signInWithPassword({ email, password })
    setError(err ? err.message : null)
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="mx-auto mt-16 max-w-sm space-y-3 p-4">
      <h1 className="text-xl font-semibold">POS spike — sign in (dev project)</h1>
      <input className="w-full rounded border p-2" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
      <input
        className="w-full rounded border p-2"
        placeholder="Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button className="w-full rounded bg-neutral-900 py-2 text-white">Sign in</button>
      {error && <p className="text-sm text-red-600">{error}</p>}
    </form>
  )
}

function TableLinks() {
  const [tables, setTables] = useState<SpikeTable[]>([])
  useEffect(() => {
    fetchTables().then(setTables).catch(() => undefined)
  }, [])
  return (
    <section className="rounded border p-4 text-sm">
      <h2 className="font-semibold">QR pages (open on a phone on the shop Wi-Fi)</h2>
      <ul className="mt-1 space-y-1">
        {tables.map((t) => {
          const url = `${window.location.origin}/spike/qr.html?t=${t.qr_token}`
          return (
            <li key={t.id}>
              Table {t.label}:{' '}
              <a className="break-all underline" href={url} target="_blank" rel="noreferrer">
                {url}
              </a>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export default function PosSpike() {
  const [session, setSession] = useState<Session | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    void supabase.auth
      .getSession()
      .then(({ data }) => setSession(data.session))
      .catch(() => undefined) // offline start: show the sign-in form rather than hang
      .finally(() => setReady(true))
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  if (!ready) return <p className="p-6">Loading…</p>
  if (!session) return <SignIn />

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4">
      <h1 className="text-xl font-semibold">POS spike — Phase 0</h1>
      <TableLinks />
      <PrintHostPanel />
      <LiveOrders />
      <CounterOrder />
    </main>
  )
}
