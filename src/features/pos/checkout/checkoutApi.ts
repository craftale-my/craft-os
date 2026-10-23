// src/features/pos/checkout/checkoutApi.ts — Supabase calls for checkout, receipts,
// approvals, voids, move/merge, refunds and the checkout sections of /pos/settings.
import { supabase } from '../../../shared/lib/supabase'
import { writeOutcome } from '../../../shared/lib/db-write'
import type { BillOrderType, BillTotals, CashRounding, ServiceChargeRuleInput } from './bill'
import type { PaymentKind } from './tender'
import type { ReasonAction, ReasonTemplate } from './reasons'
import { parseCheckoutResult, parseRefundResult, unwrapAction, type CheckoutResult, type RefundResult } from './rpcResult'

const CHECKOUT_TIMEOUT_MS = 10_000
const DEFAULT_FOOTER = 'This is an official receipt. Thank you for visiting us.'

function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? 'Unknown error')
}

function saved(res: { data: unknown[] | null; error: { message: string } | null }, what: string): void {
  const out = writeOutcome(res)
  if (!out.ok) throw new Error(`${what} failed: ${out.reason}`)
}

export interface PosSettings {
  sstRegistered: boolean
  cashRounding: CashRounding
  receiptRoute: string | null
  receiptFooter: string
  qrRequiresOpenBill: boolean
}
export const DEFAULT_POS_SETTINGS: PosSettings = {
  sstRegistered: true, cashRounding: 'nearest_5_sen', receiptRoute: null, receiptFooter: DEFAULT_FOOTER, qrRequiresOpenBill: false,
}

export interface PaymentMethodRow {
  id: string
  branch_id: string
  name: string
  kind: PaymentKind
  needs_reference: boolean
  sort_order: number
  is_active: boolean
}

export interface ServiceChargeRuleRow {
  id: string
  branch_id: string
  rate_bp: number
  order_types: BillOrderType[]
  table_ids: string[] | null
  product_ids: string[] | null
  sort_order: number
  is_active: boolean
}

export interface ReasonTemplateRow {
  branch_id: string
  action: ReasonAction
  reasons: string[]
  compulsory: boolean
  allow_other: boolean
}

export interface ReceiptDetails {
  receiptTitle: string
  legalName: string
  registrationNo: string
  sstNo: string
  address: string
  phone: string
  email: string
  footer: string
  receiptRoute: string | null
  sstRegistered: boolean
  cashRounding: CashRounding
  qrRequiresOpenBill: boolean
}

export interface BillingConfig { settings: PosSettings; rules: ServiceChargeRuleInput[] }
export interface Approver { staffId: string; name: string; hasPin: boolean }
export interface PaymentInput { methodId: string; amountSen: number; tenderedSen: number | null; reference: string | null }
export interface ClosedBillRow {
  id: string
  bill_no: string
  table_id: string | null
  order_type: BillOrderType
  status: 'paid' | 'voided' | 'merged'
  closed_at: string
  total_sen: number | null
  refunded_sen: number
  merged_into: string | null
  dining_tables: { label: string } | null
}
export type { CheckoutResult }

interface SettingsRow { sst_registered: boolean; cash_rounding: CashRounding; receipt_route: string | null; receipt_footer: string; qr_requires_open_bill: boolean }
const toSettings = (r: SettingsRow | null): PosSettings => (r ? {
  sstRegistered: r.sst_registered, cashRounding: r.cash_rounding, receiptRoute: r.receipt_route,
  receiptFooter: r.receipt_footer, qrRequiresOpenBill: r.qr_requires_open_bill,
} : DEFAULT_POS_SETTINGS)

export async function fetchPosSettings(branchId: string): Promise<PosSettings> {
  const { data, error } = await supabase.from('branch_pos_settings')
    .select('sst_registered, cash_rounding, receipt_route, receipt_footer, qr_requires_open_bill')
    .eq('branch_id', branchId).maybeSingle()
  if (error) fail(error)
  return toSettings(data as SettingsRow | null)
}

export async function fetchServiceChargeRules(branchId: string): Promise<ServiceChargeRuleRow[]> {
  const { data, error } = await supabase.from('service_charge_rules')
    .select('id, branch_id, rate_bp, order_types, table_ids, product_ids, sort_order, is_active')
    .eq('branch_id', branchId).order('sort_order').order('created_at').order('id')
  if (error) fail(error)
  return (data ?? []) as ServiceChargeRuleRow[]
}

/** Settings + active rules in sort order: the input computeBill needs besides the lines. */
export async function fetchBillingConfig(branchId: string): Promise<BillingConfig> {
  const [settings, rules] = await Promise.all([fetchPosSettings(branchId), fetchServiceChargeRules(branchId)])
  return {
    settings,
    rules: rules.filter((r) => r.is_active).map((r) => ({ rateBp: r.rate_bp, orderTypes: r.order_types, tableIds: r.table_ids, productIds: r.product_ids })),
  }
}

export async function fetchPaymentMethods(branchId: string, activeOnly: boolean): Promise<PaymentMethodRow[]> {
  let q = supabase.from('payment_methods').select('id, branch_id, name, kind, needs_reference, sort_order, is_active').eq('branch_id', branchId)
  if (activeOnly) q = q.eq('is_active', true)
  const { data, error } = await q.order('sort_order').order('name')
  if (error) fail(error)
  return (data ?? []) as PaymentMethodRow[]
}

export async function fetchReasonTemplates(branchId: string): Promise<ReasonTemplateRow[]> {
  const { data, error } = await supabase.from('reason_templates')
    .select('branch_id, action, reasons, compulsory, allow_other').eq('branch_id', branchId)
  if (error) fail(error)
  return (data ?? []) as ReasonTemplateRow[]
}

/** null = no template saved for the action (the server then requires any reason). */
export async function fetchReasonTemplate(branchId: string, action: ReasonAction): Promise<ReasonTemplate | null> {
  const row = (await fetchReasonTemplates(branchId)).find((t) => t.action === action)
  return row ? { reasons: row.reasons, compulsory: row.compulsory, allowOther: row.allow_other } : null
}

export async function fetchReceiptDetails(branchId: string): Promise<ReceiptDetails> {
  const [b, s] = await Promise.all([
    supabase.from('branches').select('name, receipt_title, legal_name, registration_no, sst_no, address, phone, email').eq('id', branchId).maybeSingle(),
    fetchPosSettings(branchId),
  ])
  if (b.error) fail(b.error)
  const r = (b.data ?? {}) as Record<string, string | null>
  return {
    receiptTitle: r.receipt_title ?? r.name ?? '', legalName: r.legal_name ?? '', registrationNo: r.registration_no ?? '',
    sstNo: r.sst_no ?? '', address: r.address ?? '', phone: r.phone ?? '', email: r.email ?? '',
    footer: s.receiptFooter, receiptRoute: s.receiptRoute, sstRegistered: s.sstRegistered,
    cashRounding: s.cashRounding, qrRequiresOpenBill: s.qrRequiresOpenBill,
  }
}

/** Server preview of the bill's totals (pos_bill_totals) — what checkout will charge. */
export async function fetchBillTotals(billId: string): Promise<BillTotals> {
  const { data, error } = await supabase.rpc('pos_bill_totals', { p_bill_id: billId })
  if (error) fail(error)
  if (!data) throw new Error('Bill not found')
  return data as BillTotals
}

/** A timeout or dropped connection throws — the sheet then offers Pay again with the
 *  SAME checkoutId, which the server answers with the first result (never charges twice). */
export async function checkoutBill(billId: string, payments: PaymentInput[], checkoutId: string): Promise<CheckoutResult> {
  const { data, error } = await supabase
    .rpc('checkout_bill', { p_bill_id: billId, p_payments: payments, p_checkout_id: checkoutId })
    .abortSignal(AbortSignal.timeout(CHECKOUT_TIMEOUT_MS))
  if (error) fail(error)
  return parseCheckoutResult(data)
}

export async function reprintReceipt(billId: string): Promise<void> {
  const { error } = await supabase.rpc('reprint_receipt', { p_bill_id: billId })
  if (error) fail(error)
}

export async function fetchApprovers(): Promise<Approver[]> {
  const { data, error } = await supabase.rpc('pos_approvers')
  if (error) fail(error)
  return ((data ?? []) as { staff_id: string; name: string; has_pin: boolean }[]).map((a) => ({ staffId: a.staff_id, name: a.name, hasPin: a.has_pin }))
}

export async function setMyPin(newPin: string, currentPin: string | null): Promise<void> {
  const { data, error } = await supabase.rpc('set_my_pos_pin', { p_new_pin: newPin, p_current_pin: currentPin })
  if (error) fail(error)
  unwrapAction(data)
}

export async function clearPin(staffId: string): Promise<void> {
  const { error } = await supabase.rpc('clear_pos_pin', { p_staff_id: staffId })
  if (error) fail(error)
}

export interface Approval { reason: string; approverId: string | null; pin: string | null }

export async function voidItem(itemId: string, a: Approval): Promise<void> {
  const { data, error } = await supabase.rpc('void_order_item', { p_item_id: itemId, p_reason: a.reason, p_approver_id: a.approverId, p_pin: a.pin })
  if (error) fail(error)
  unwrapAction(data)
}

export async function voidBill(billId: string, a: Approval): Promise<void> {
  const { data, error } = await supabase.rpc('void_bill', { p_bill_id: billId, p_reason: a.reason, p_approver_id: a.approverId, p_pin: a.pin })
  if (error) fail(error)
  unwrapAction(data)
}

export async function moveBill(billId: string, tableId: string): Promise<void> {
  const { error } = await supabase.rpc('move_bill', { p_bill_id: billId, p_table_id: tableId })
  if (error) fail(error)
}

export async function mergeBills(fromBillId: string, intoBillId: string): Promise<void> {
  const { error } = await supabase.rpc('merge_bills', { p_from_bill: fromBillId, p_into_bill: intoBillId })
  if (error) fail(error)
}

/** Answers what the server recorded — on a resend after a lost reply, that is the
 *  FIRST call's refund, so the till pays out the recorded amount, not the typed one. */
export async function refundBill(refundId: string, billId: string, amountSen: number, methodId: string, a: Approval): Promise<RefundResult> {
  const { data, error } = await supabase.rpc('refund_bill', {
    p_refund_id: refundId, p_bill_id: billId, p_amount_sen: amountSen, p_method_id: methodId,
    p_reason: a.reason, p_approver_id: a.approverId, p_pin: a.pin,
  })
  if (error) fail(error)
  return parseRefundResult(data)
}

export async function openTable(tableId: string, pax: number | null): Promise<string> {
  const { data, error } = await supabase.rpc('open_table', { p_table_id: tableId, p_pax: pax })
  if (error) fail(error)
  return data as string
}

/** Paid, voided and merged bills of the branch closed since `sinceIso` (newest first). */
export async function fetchClosedBillsSince(branchId: string, sinceIso: string): Promise<ClosedBillRow[]> {
  const { data, error } = await supabase.from('bills')
    .select('id, bill_no, table_id, order_type, status, closed_at, total_sen, refunded_sen, merged_into, dining_tables(label)')
    .eq('branch_id', branchId).in('status', ['paid', 'voided', 'merged']).gte('closed_at', sinceIso)
    .order('closed_at', { ascending: false })
  if (error) fail(error)
  return (data ?? []) as unknown as ClosedBillRow[]
}

// ── /pos/settings ───────────────────────────────────────────────────────────
/** Orderable products (no add-ons), for choosing which products a service-charge rule covers. */
export async function fetchProductNames(): Promise<{ id: string; name: string }[]> {
  const { data, error } = await supabase.from('menu_products').select('id, name')
    .eq('is_active', true).eq('is_addon', false).order('name')
  if (error) fail(error)
  return (data ?? []) as { id: string; name: string }[]
}

export async function saveReceiptDetails(d: ReceiptDetails): Promise<void> {
  const { error } = await supabase.rpc('save_receipt_settings', { p: d })
  if (error) fail(error)
}

export async function savePaymentMethod(row: Omit<PaymentMethodRow, 'id'> & { id?: string }): Promise<void> {
  saved(await supabase.from('payment_methods').upsert(row).select('id'), 'Saving the payment method')
}

export async function saveServiceChargeRule(row: Omit<ServiceChargeRuleRow, 'id'> & { id?: string }): Promise<void> {
  saved(await supabase.from('service_charge_rules').upsert(row).select('id'), 'Saving the service-charge rule')
}

export async function deleteServiceChargeRule(id: string): Promise<void> {
  saved(await supabase.from('service_charge_rules').delete().eq('id', id).select('id'), 'Removing the rule')
}

export async function saveReasonTemplate(row: ReasonTemplateRow): Promise<void> {
  saved(await supabase.from('reason_templates').upsert(row).select('action'), 'Saving the reasons')
}
