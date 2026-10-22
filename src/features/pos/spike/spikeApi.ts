import { supabase } from '../../../shared/lib/supabase'
import { toSendResult, type QueuedOrder, type SendResult } from '../offline/orderQueue'
import type { PrintRoute } from '../print/adapter'
import type { PrintJob } from '../print/printHost'
import type { TicketPayload } from '../print/ticket'

export interface SpikeTable {
  id: string
  label: string
  qr_token: string
}

export interface SpikeMenuItem {
  id: string
  name: string
  price_sen: number
  route: string
  is_available: boolean
}

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message)
}

export async function fetchTables(): Promise<SpikeTable[]> {
  const { data, error } = await supabase.from('spike_tables').select('id, label, qr_token').eq('is_active', true).order('label')
  fail(error)
  return data ?? []
}

export async function fetchMenu(): Promise<SpikeMenuItem[]> {
  const { data, error } = await supabase.from('spike_menu_items').select('id, name, price_sen, route, is_available').order('name')
  fail(error)
  return data ?? []
}

export async function fetchRoutes(): Promise<PrintRoute[]> {
  const { data, error } = await supabase.from('spike_print_routes').select('route, kind, address').order('route')
  fail(error)
  return data ?? []
}

export async function fetchServerNow(): Promise<string> {
  const { data, error } = await supabase.rpc('spike_server_now')
  fail(error)
  return data as string
}

export async function fetchOrderTableLabel(orderId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('spike_orders')
    .select('spike_bills(spike_tables(label))')
    .eq('id', orderId)
    .single()
  fail(error)
  const row = data as unknown as { spike_bills: { spike_tables: { label: string } | null } | null } | null
  return row?.spike_bills?.spike_tables?.label ?? null
}

export async function sendCounterOrder(o: QueuedOrder): Promise<SendResult> {
  try {
    const { error } = await supabase.rpc('spike_place_counter_order', {
      p_table_id: o.tableId,
      p_items: o.items,
      p_client_order_id: o.clientOrderId,
    })
    return toSendResult(error) // keeps the Postgres code, so only real rejections are final
  } catch (e) {
    return { ok: false, retryable: true, reason: e instanceof Error ? e.message : String(e) }
  }
}

export async function countOrdersWithClientId(clientOrderId: string): Promise<number> {
  const { count, error } = await supabase
    .from('spike_orders')
    .select('id', { count: 'exact', head: true })
    .eq('client_order_id', clientOrderId)
  fail(error)
  return count ?? 0
}

export async function claimJob(id: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('spike_claim_print_job', { p_id: id })
  fail(error)
  return data === true
}

export async function finishJob(id: string, ok: boolean, err: string | null): Promise<void> {
  const { error } = await supabase.rpc('spike_finish_print_job', { p_id: id, p_ok: ok, p_error: err })
  fail(error)
}

export async function requeueJob(id: string): Promise<void> {
  const { error } = await supabase.rpc('spike_requeue_print_job', { p_id: id })
  fail(error)
}

export async function fetchPendingJobs(routes: string[]): Promise<PrintJob[]> {
  if (routes.length === 0) return []
  const { data, error } = await supabase
    .from('spike_print_jobs')
    .select('id, route, payload, status')
    .eq('status', 'pending')
    .in('route', routes)
    .order('created_at')
  fail(error)
  return (data ?? []) as PrintJob[]
}

export async function insertTestJob(route: string): Promise<void> {
  const payload: TicketPayload = {
    kind: 'ticket',
    route,
    tableLabel: 'TEST',
    orderNo: 'TEST01',
    source: 'test',
    placedAt: new Date().toISOString(),
    lines: [
      { qty: 1, name: 'Test print — if you can read this, the route works', note: null },
      { qty: 1, name: 'Chinese check: 咸蛋酱 测试', note: 'Record whether these characters printed' },
    ],
  }
  const { error } = await supabase.from('spike_print_jobs').insert({ route, payload })
  fail(error)
}
