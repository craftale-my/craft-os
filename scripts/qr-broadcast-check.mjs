// scripts/qr-broadcast-check.mjs
// One-off: can two anon clients on the dev project exchange a Realtime Broadcast message?
// Run from the repo root: node scripts/qr-broadcast-check.mjs
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => {
    const i = l.indexOf('=')
    return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
  }),
)
if (!String(env.VITE_SUPABASE_URL).includes('egznnbjmicebbhwasloy')) {
  console.error('Refusing: .env.local does not point at the dev project')
  process.exit(2)
}
const make = () => createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
})
const listener = make()
const sender = make()
const topic = `qr-check-${Date.now()}`

const heard = new Promise((resolve) => {
  listener.channel(topic).on('broadcast', { event: 'changed' }, () => resolve(true)).subscribe((s) => {
    if (s !== 'SUBSCRIBED') return
    const ch = sender.channel(topic)
    ch.subscribe((s2) => { if (s2 === 'SUBSCRIBED') void ch.send({ type: 'broadcast', event: 'changed', payload: {} }) })
  })
})
const ok = await Promise.race([heard, new Promise((r) => setTimeout(() => r(false), 8000))])
console.log(ok ? 'BROADCAST OK' : 'BROADCAST FAILED')
process.exit(ok ? 0 : 1)
