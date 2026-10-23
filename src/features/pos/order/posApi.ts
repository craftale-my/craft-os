// src/features/pos/order/posApi.ts
import { supabase } from '../../../shared/lib/supabase'
import { writeOutcome } from '../../../shared/lib/db-write'
import type { PrintJob } from '../print/printHost'
import type { PrintRoute } from '../print/adapter'
import { counterOrderArgs, toSendResult, type QueuedOrder, type SendResult, type OrderType } from '../offline/orderQueue'
import {
  buildPosMenu, type CatalogProductRow, type GroupRow, type LinkRow, type OptionPriceRow, type PosMenu, type ProductRow,
  type SoldOutRow, type VariantPriceRow,
} from './cart'
import type { BranchCatalogRow, BranchCatalogSettings, BranchCatalogs, CatalogRow } from './catalogs'

const SEND_TIMEOUT_MS = 8000

function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? 'Unknown error')
}

export interface TableRow { id: string; label: string; qr_token: string; qr_paused: boolean; is_active: boolean; sort_order: number }
export interface OpenBillRow { id: string; bill_no: string; table_id: string | null; order_type: OrderType; pax: number | null; opened_at: string }
export interface BillItemRow {
  id: string
  order_id: string
  product_id: string | null
  name_snapshot: string
  unit_price_sen: number
  sst_rate_bp: number
  takeaway_fee_sen: number
  qty: number
  note: string | null
  modifiers_snapshot: { name: string }[]
  voided_at: string | null
  orders: { order_no: string; source: 'counter' | 'qr'; placed_at: string }
}
export interface PrintJobRow extends PrintJob {
  branch_id: string
  attempts: number
  last_error: string | null
  claimed_at: string | null
  created_at: string
}

/** The counter menu of one catalog: flat reads (RLS menu_read) shaped by the pure
 *  builder. Products and prices come from the catalog, never from the master list. */
export async function fetchPosMenu(branchId: string, catalogId: string): Promise<PosMenu> {
  const [p, g, l, s, cp, vp, op] = await Promise.all([
    supabase.from('menu_products')
      .select('id, name, description, is_addon, is_active, sort_order, category:menu_categories(name, sort_order), ' +
              'menu_variants(id, name, is_active, sort_order, feedme_variant_key)')
      .eq('is_active', true).order('sort_order').order('name'),
    supabase.from('modifier_groups')
      .select('id, name, min_select, max_select, is_active, sort_order, ' +
              'modifier_options(id, name, price_delta_sen, is_default, availability, sort_order, product_id)'),
    supabase.from('product_modifier_groups').select('product_id, group_id, sort_order'),
    supabase.from('branch_menu_status').select('product_id, is_sold_out').eq('branch_id', branchId),
    supabase.from('catalog_products').select('product_id, availability, sort_order').eq('catalog_id', catalogId),
    supabase.from('catalog_variant_prices').select('variant_id, price_sen').eq('catalog_id', catalogId),
    supabase.from('catalog_option_prices').select('option_id, price_delta_sen').eq('catalog_id', catalogId),
  ])
  for (const r of [p, g, l, s, cp, vp, op]) if (r.error) fail(r.error)
  return buildPosMenu(
    (p.data ?? []) as unknown as ProductRow[], (g.data ?? []) as unknown as GroupRow[],
    (l.data ?? []) as LinkRow[], (s.data ?? []) as SoldOutRow[], 'counter',
    {
      products: (cp.data ?? []) as CatalogProductRow[],
      prices: (vp.data ?? []) as VariantPriceRow[],
      optionPrices: (op.data ?? []) as OptionPriceRow[],
    },
  )
}

/** Every catalog (for names) and this branch's assignments. */
export async function fetchBranchCatalogs(branchId: string): Promise<BranchCatalogs> {
  const [c, a] = await Promise.all([
    supabase.from('menu_catalogs').select('id, name, is_active, sort_order').order('sort_order').order('name'),
    supabase.from('branch_catalogs').select('role, catalog_id').eq('branch_id', branchId),
  ])
  if (c.error) fail(c.error)
  if (a.error) fail(a.error)
  return { catalogs: (c.data ?? []) as CatalogRow[], assignments: (a.data ?? []) as BranchCatalogRow[] }
}

/** POS settings → Menu catalogs, for the caller's own branch (save_branch_catalogs checks access_settings). */
export async function saveBranchCatalogs(s: BranchCatalogSettings): Promise<void> {
  const { error } = await supabase.rpc('save_branch_catalogs', { p: s })
  if (error) fail(error)
}

export async function fetchTables(branchId: string): Promise<TableRow[]> {
  const { data, error } = await supabase.from('dining_tables')
    .select('id, label, qr_token, qr_paused, is_active, sort_order')
    .eq('branch_id', branchId).eq('is_active', true).order('sort_order').order('label')
  if (error) fail(error)
  return data ?? []
}

export async function fetchOpenBills(branchId: string): Promise<OpenBillRow[]> {
  const { data, error } = await supabase.from('bills')
    .select('id, bill_no, table_id, order_type, pax, opened_at')
    .eq('branch_id', branchId).eq('status', 'open').order('opened_at')
  if (error) fail(error)
  return (data ?? []) as OpenBillRow[]
}

export async function fetchBillItems(billId: string): Promise<BillItemRow[]> {
  const { data, error } = await supabase.from('order_items')
    .select('id, order_id, product_id, name_snapshot, unit_price_sen, sst_rate_bp, takeaway_fee_sen, qty, note, modifiers_snapshot, voided_at, ' +
            'orders!inner(order_no, source, placed_at)')
    .eq('bill_id', billId)
  if (error) fail(error)
  return ((data ?? []) as unknown as BillItemRow[])
    .sort((a, b) => a.orders.placed_at.localeCompare(b.orders.placed_at) || a.name_snapshot.localeCompare(b.name_snapshot))
}

/** The queue's sender: a thrown/timed-out call is retryable, a Postgres rejection is final. */
export async function sendCounterOrder(o: QueuedOrder): Promise<SendResult> {
  try {
    const { error } = await supabase
      .rpc('place_counter_order', counterOrderArgs(o))
      .abortSignal(AbortSignal.timeout(SEND_TIMEOUT_MS))
    return toSendResult(error)
  } catch (e) {
    return { ok: false, retryable: true, reason: e instanceof Error ? e.message : String(e) }
  }
}

export async function setSoldOut(branchId: string, productId: string, soldOut: boolean): Promise<void> {
  const res = await supabase.from('branch_menu_status')
    .upsert({ branch_id: branchId, product_id: productId, is_sold_out: soldOut, updated_at: new Date().toISOString() })
    .select('product_id')
  const out = writeOutcome(res)
  if (!out.ok) throw new Error(`Sold-out change failed: ${out.reason}`)
}

export async function setTablePaused(tableId: string, paused: boolean): Promise<void> {
  const res = await supabase.from('dining_tables').update({ qr_paused: paused }).eq('id', tableId).select('id')
  const out = writeOutcome(res)
  if (!out.ok) throw new Error(`Table change failed: ${out.reason}`)
}

export async function fetchRoutes(branchId: string): Promise<PrintRoute[]> {
  const { data, error } = await supabase.from('print_routes').select('name, kind, address').eq('branch_id', branchId).order('name')
  if (error) fail(error)
  return (data ?? []).map((r) => ({ route: r.name, kind: r.kind as PrintRoute['kind'], address: r.address }))
}

/** Distinct print routes the active menu points at (to spot routes with no printer). */
export async function fetchMenuRoutes(): Promise<string[]> {
  const { data, error } = await supabase.from('menu_products').select('print_route').eq('is_active', true).not('print_route', 'is', null)
  if (error) fail(error)
  return [...new Set((data ?? []).map((r) => (r as { print_route: string | null }).print_route).filter((x): x is string => !!x))]
}

export async function fetchBranchName(branchId: string): Promise<string | null> {
  const { data, error } = await supabase.from('branches').select('name').eq('id', branchId).maybeSingle()
  if (error) fail(error)
  return (data as { name: string } | null)?.name ?? null
}

export async function fetchPrintJobs(branchId: string, statuses: string[]): Promise<PrintJobRow[]> {
  const { data, error } = await supabase.from('print_jobs')
    .select('id, branch_id, route, payload, status, attempts, last_error, claimed_at, created_at')
    .eq('branch_id', branchId).in('status', statuses).order('created_at')
  if (error) fail(error)
  return (data ?? []) as unknown as PrintJobRow[]
}

export async function claimJob(id: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('claim_print_job', { p_id: id })
  if (error) fail(error)
  return data === true
}

export async function finishJob(id: string, ok: boolean, err: string | null): Promise<void> {
  const { error } = await supabase.rpc('finish_print_job', { p_id: id, p_ok: ok, p_error: err })
  if (error) fail(error)
}

export async function requeueJob(id: string): Promise<void> {
  const { error } = await supabase.rpc('requeue_print_job', { p_id: id })
  if (error) fail(error)
}

export async function insertTestPrint(route: string): Promise<void> {
  const { error } = await supabase.rpc('insert_test_print', { p_route: route })
  if (error) fail(error)
}
