// src/features/pos/order/posApi.ts
import { supabase } from '../../../shared/lib/supabase'
import { writeOutcome } from '../../../shared/lib/db-write'
import type { PrintJob } from '../print/printHost'
import type { PrintRoute } from '../print/adapter'
import { counterOrderArgs, toSendResult, type QueuedOrder, type SendResult, type OrderType } from '../offline/orderQueue'
import { buildPosMenu, type CatalogRows, type GroupRow, type LinkRow, type PosMenu, type ProductRow, type SoldOutRow } from './cart'
import type { BranchCatalogRow, BranchCatalogSettings, BranchCatalogs, CatalogRow } from './catalogs'
import { menuWindows, type MenuWindows, type MenuWindowsJson } from './padSlots'
import { parseBillSummaries, type BillSummary } from './billSummaries'
import { padProductInfo, type PadProductInfo, type PadProductRow } from './padInfo'
import { productThumbUrl } from '../menu/photoUpload'

const SEND_TIMEOUT_MS = 8000

function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? 'Unknown error')
}

export interface TableRow {
  id: string; label: string; qr_token: string; qr_paused: boolean; is_active: boolean; sort_order: number
  /** the floor area for the home screen's tabs (null = only under All) */
  area: string | null
}
export interface OpenBillRow { id: string; bill_no: string; table_id: string | null; order_type: OrderType; pax: number | null; opened_at: string }
export interface BillItemRow {
  id: string
  order_id: string
  product_id: string | null
  name_snapshot: string
  unit_price_sen: number
  sst_rate_bp: number
  takeaway_fee_sen: number
  order_type: OrderType           // the order type it was ordered under (a merged takeaway keeps 'takeaway')
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

/** What pos_menu_rows returns: the flat rows buildPosMenu takes, in one JSON value. */
interface PosMenuRows {
  products: ProductRow[]
  groups: GroupRow[]
  links: LinkRow[]
  soldOut: SoldOutRow[]
  catalog: CatalogRows
}

/** The counter menu of one catalog in one call (pos_menu_rows: one JSON value, so
 *  PostgREST's 1000-row cap never cuts it short), shaped by the pure builder. Products
 *  and prices come from the catalog; sold-out is the caller's own branch. */
export async function fetchPosMenu(catalogId: string): Promise<PosMenu> {
  const { data, error } = await supabase.rpc('pos_menu_rows', { p_catalog_id: catalogId })
  if (error) fail(error)
  const rows = data as PosMenuRows
  return buildPosMenu(rows.products, rows.groups, rows.links, rows.soldOut, 'counter', rows.catalog)
}

/** The time slots of one catalog's products, with the server's clock (pos_menu_windows):
 *  the pad greys out a product outside its slots by the server's time. */
export async function fetchMenuWindows(catalogId: string): Promise<MenuWindows> {
  const { data, error } = await supabase.rpc('pos_menu_windows', { p_catalog_id: catalogId })
  if (error) fail(error)
  return menuWindows(data as MenuWindowsJson, Date.now())
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

/** POS settings → Menu catalogs of an outlet in the caller's scope (save_branch_catalogs checks access_settings). */
export async function saveBranchCatalogs(branchId: string, s: BranchCatalogSettings): Promise<void> {
  const { error } = await supabase.rpc('save_branch_catalogs', { p_branch_id: branchId, p: s })
  if (error) fail(error)
}

export async function fetchTables(branchId: string): Promise<TableRow[]> {
  const { data, error } = await supabase.from('dining_tables')
    .select('id, label, qr_token, qr_paused, is_active, sort_order, area')
    .eq('branch_id', branchId).eq('is_active', true).order('sort_order').order('label')
  if (error) fail(error)
  return (data ?? []) as TableRow[]
}

/** Every open bill of the branch with the total checkout would charge (pos_bill_totals) and its
 *  live item count, keyed by bill id. Staff of the branch only. */
export async function fetchOpenBillSummaries(branchId: string): Promise<Map<string, BillSummary>> {
  const { data, error } = await supabase.rpc('pos_open_bill_summaries', { p_branch_id: branchId })
  if (error) fail(error)
  return parseBillSummaries(data)
}

/** The bill an order landed on, by the id this iPad gave it; null while it has not reached the
 *  server (still in this iPad's queue). Send & pay uses it to open Payment on the right bill. */
export async function fetchOrderBillId(clientOrderId: string): Promise<string | null> {
  const { data, error } = await supabase.from('orders').select('bill_id').eq('client_order_id', clientOrderId).maybeSingle()
  if (error) fail(error)
  return (data as { bill_id: string } | null)?.bill_id ?? null
}

/** SST rate, packaging fee and photo of every orderable product (padInfo.ts), read 1000 rows at a
 *  time so PostgREST's row cap never cuts the list short. */
export async function fetchPadProductInfo(): Promise<Map<string, PadProductInfo>> {
  const rows: PadProductRow[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('menu_products')
      .select('id, sst_rate_bp, takeaway_fee_sen, image_path, image_updated_at')
      .eq('is_active', true).eq('is_addon', false).order('id').range(from, from + 999)
    if (error) fail(error)
    const page = (data ?? []) as PadProductRow[]
    rows.push(...page)
    if (page.length < 1000) break
  }
  return padProductInfo(rows, productThumbUrl)
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
    .select('id, order_id, product_id, name_snapshot, unit_price_sen, sst_rate_bp, takeaway_fee_sen, order_type, qty, note, modifiers_snapshot, voided_at, ' +
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

/** A test ticket on a route: the caller's home branch (the POS), or an outlet they manage (POS settings). */
export async function insertTestPrint(route: string, branchId?: string): Promise<void> {
  const { error } = await supabase.rpc('insert_test_print', { p_route: route, ...(branchId ? { p_branch_id: branchId } : {}) })
  if (error) fail(error)
}
