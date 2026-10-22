// Craft POS print agent — prints print_jobs for routes of kind 'agent'
// Sends raw ESC/POS bytes to the printer on TCP 9100.
// Run:  node --env-file=tools/print-agent/.env tools/print-agent/agent.ts
import { createClient } from '@supabase/supabase-js'
import { renderTicketLines } from '../../src/features/pos/print/ticket.ts'
import { encodeEscPos } from '../../src/features/pos/print/escpos.ts'
import { processJob, type PrintHostDeps, type PrintJob } from '../../src/features/pos/print/printHost.ts'
import { assertDevDatabase } from '../../src/features/pos/guard.ts'
import { sendRaw } from './sendRaw.ts'
import { checkPrinter, interpretStatus, PAPER_STATUS, queryStatus } from './printerStatus.ts'

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
  let maxAgeMin = 30
  if (process.env.MAX_AGE_MIN !== undefined) {
    const parsed = Number(process.env.MAX_AGE_MIN)
    if (Number.isFinite(parsed) && parsed > 0) maxAgeMin = parsed
    else console.warn(`Invalid MAX_AGE_MIN "${process.env.MAX_AGE_MIN}"; using 30.`)
  }
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
    .from('print_routes')
    .select('name, address')
    .eq('kind', 'agent')
  if (routeError) throw routeError
  const addressOf = new Map<string, string>((routes ?? []).map((r: { name: string; address: string }) => [r.name, r.address]))
  console.log('agent routes:', Object.fromEntries(addressOf))
  console.log('Routes are read at startup; restart the agent after changing print_routes.')
  if (addressOf.size === 0) {
    console.warn("No route has kind 'agent', so there is nothing to print. Waiting; point a route at the agent and restart.")
  }

  // Cheap LAN printers accept one connection at a time: a second ticket sent while
  // the first is still open gets ECONNRESET (seen on the ZyWell ZY301, 2026-10-22,
  // when an order's Bar and Kitchen tickets went to the same printer 30 ms apart).
  // So sends to one address are queued; different printers still print in parallel.
  // The status queries share the queue: they are connections to the same printer.
  const printerQueues = new Map<string, Promise<void>>()
  const printChecked = async (address: string, bytes: Uint8Array): Promise<void> => {
    const before = await checkPrinter(address)
    for (const w of before.warnings) console.warn(`${address}: ${w}`)
    if (!before.ok) throw new Error(`Not sent: ${before.reason}`)
    await sendRaw(address, bytes)
    // A roll that runs out mid-ticket leaves a partial or blank ticket behind:
    // count it as failed so staff reprint it, rather than as printed.
    const after = interpretStatus(null, await queryStatus(address, PAPER_STATUS))
    if (!after.ok) throw new Error(`Paper ran out while printing — check the ticket and reprint (${after.reason})`)
  }
  const sendInTurn = (address: string, bytes: Uint8Array): Promise<void> => {
    const turn = (printerQueues.get(address) ?? Promise.resolve()).then(() => printChecked(address, bytes))
    printerQueues.set(address, turn.catch(() => undefined))
    return turn
  }

  // Never rejects: it is called from the sweep, a Realtime callback and an interval.
  const handle = async (job: PrintJob & { created_at?: string }): Promise<void> => {
    if (!addressOf.has(job.route)) return
    const id8 = job.id.slice(0, 8)
    // An old ticket stays pending (the iPad shows it as "Waiting") so staff decide, not a backlog dump.
    if (job.created_at) {
      const ageMin = (Date.now() - Date.parse(job.created_at)) / 60_000
      if (ageMin > maxAgeMin) {
        console.log(`skipped old ticket ${job.route} ${id8} (${Math.round(ageMin)} min)`)
        return
      }
    }
    // Per call, so a concurrent handler of the same job cannot mislabel the log.
    let printed = false
    const deps: PrintHostDeps = {
      claim: async (id) => {
        const { data, error } = await supabase.rpc('claim_print_job', { p_id: id })
        if (error) throw error
        return data === true
      },
      finish: async (id, ok, err) => {
        const { error } = await supabase.rpc('finish_print_job', { p_id: id, p_ok: ok, p_error: err })
        if (error) throw error
      },
      print: async (j) => {
        await sendInTurn(addressOf.get(j.route)!, encodeEscPos(renderTicketLines(j.payload, cols)))
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
        .from('print_jobs')
        .select('id, route, payload, status, created_at')
        .eq('status', 'pending')
        .in('route', [...addressOf.keys()])
        .order('created_at')
      if (error) {
        console.error('sweep failed:', error.message)
        return
      }
      for (const job of (data ?? []) as (PrintJob & { created_at?: string })[]) await handle(job)
    } catch (e) {
      console.error('sweep failed:', errMessage(e))
    } finally {
      sweeping = false
    }
  }

  supabase
    .channel(`print-agent-${crypto.randomUUID()}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'print_jobs' }, (p) => {
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
