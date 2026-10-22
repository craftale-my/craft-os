// POS spike print agent: prints every spike_print_jobs row whose route is
// kind 'agent', by sending raw ESC/POS bytes to the printer on TCP 9100.
// Run:  node --env-file=tools/print-agent/.env tools/print-agent/agent.ts
import { createClient } from '@supabase/supabase-js'
import { renderTicketLines } from '../../src/features/pos/print/ticket.ts'
import { encodeEscPos } from '../../src/features/pos/print/escpos.ts'
import { processJob, type PrintHostDeps, type PrintJob } from '../../src/features/pos/print/printHost.ts'
import { assertDevDatabase } from '../../src/features/pos/spike/guard.ts'
import { sendRaw } from './sendRaw.ts'

function env(key: string): string {
  const value = process.env[key]
  if (!value) throw new Error(`Missing ${key} in tools/print-agent/.env`)
  return value
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

async function main(): Promise<void> {
  const url = env('SUPABASE_URL')
  assertDevDatabase(url)
  const supabase = createClient(url, env('SUPABASE_ANON_KEY'), { auth: { persistSession: false } })
  let cols = 42
  if (process.env.TICKET_COLS !== undefined) {
    const parsed = Number(process.env.TICKET_COLS)
    if (Number.isInteger(parsed) && parsed > 0) cols = parsed
    else console.warn(`Invalid TICKET_COLS "${process.env.TICKET_COLS}"; using 42.`)
  }

  const { error: authError } = await supabase.auth.signInWithPassword({
    email: env('AGENT_EMAIL'),
    password: env('AGENT_PASSWORD'),
  })
  if (authError) throw authError

  const { data: routes, error: routeError } = await supabase
    .from('spike_print_routes')
    .select('route, address')
    .eq('kind', 'agent')
  if (routeError) throw routeError
  const addressOf = new Map<string, string>((routes ?? []).map((r: { route: string; address: string }) => [r.route, r.address]))
  console.log('agent routes:', Object.fromEntries(addressOf))
  console.log('Routes are read at startup; restart the agent after changing spike_print_routes.')
  if (addressOf.size === 0) {
    console.warn("No route has kind 'agent', so there is nothing to print. Waiting; point a route at the agent and restart.")
  }

  // Never rejects: it is called from the sweep, a Realtime callback and an interval.
  const handle = async (job: PrintJob): Promise<void> => {
    if (!addressOf.has(job.route)) return
    const id8 = job.id.slice(0, 8)
    // Per call, so a concurrent handler of the same job cannot mislabel the log.
    let printed = false
    const deps: PrintHostDeps = {
      claim: async (id) => {
        const { data, error } = await supabase.rpc('spike_claim_print_job', { p_id: id })
        if (error) throw error
        return data === true
      },
      finish: async (id, ok, err) => {
        const { error } = await supabase.rpc('spike_finish_print_job', { p_id: id, p_ok: ok, p_error: err })
        if (error) throw error
      },
      print: async (j) => {
        await sendRaw(addressOf.get(j.route)!, encodeEscPos(renderTicketLines(j.payload, cols)))
        printed = true
      },
    }
    try {
      const result = await processJob(job, deps)
      console.log(new Date().toISOString(), job.route, id8, result)
    } catch (e) {
      if (printed) console.error(`${job.route} ${id8} printed but could not record it: ${errMessage(e)}`)
      else console.error(`${job.route} ${id8} failed: ${errMessage(e)}`)
    }
  }

  // Realtime can drop events while reconnecting; the sweep catches anything missed.
  let sweeping = false
  const sweep = async (): Promise<void> => {
    if (sweeping || addressOf.size === 0) return
    sweeping = true
    try {
      const { data, error } = await supabase
        .from('spike_print_jobs')
        .select('id, route, payload, status')
        .eq('status', 'pending')
        .in('route', [...addressOf.keys()])
        .order('created_at')
      if (error) {
        console.error('sweep failed:', error.message)
        return
      }
      for (const job of (data ?? []) as PrintJob[]) await handle(job)
    } catch (e) {
      console.error('sweep failed:', errMessage(e))
    } finally {
      sweeping = false
    }
  }

  supabase
    .channel('print-agent')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'spike_print_jobs' }, (p) => {
      void handle(p.new as PrintJob)
    })
    .subscribe((status) => {
      console.log('realtime:', status)
      if (status === 'SUBSCRIBED') void sweep()
    })
  setInterval(() => void sweep(), 10_000)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
