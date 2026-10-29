// src/features/pos/shift/shiftApi.ts — Supabase calls for shifts, Pay in / Pay out, the
// Z report and the Shifts settings (migration-2026-10-24-pos-shifts-fn.sql). pos_shifts and
// pos_cash_moves have no RLS policy: everything goes through these RPCs.
import { supabase } from '../../../shared/lib/supabase'
import type { Approval } from '../checkout/checkoutApi'
import type { ZReport } from '../print/zreport'
import {
  parseCashMoveResult, parseCloseResult, parseShiftList, parseShiftStatus, parseZReport,
  type CashMoveKind, type CashMoveResult, type CloseResult, type ShiftListRow, type ShiftStatus,
} from './shift'

const MONEY_TIMEOUT_MS = 10_000
const DEFAULT_LIMIT_SEN = 500

function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? 'Unknown error')
}

/** The top bar: the branch's open shift (never the expected cash), open bills, the last float. */
export async function fetchShiftStatus(): Promise<ShiftStatus> {
  const { data, error } = await supabase.rpc('pos_current_shift')
  if (error) fail(error)
  return parseShiftStatus(data)
}

export async function openShift(floatSen: number): Promise<ShiftStatus> {
  const { data, error } = await supabase.rpc('open_shift', { p_float_sen: floatSen })
  if (error) fail(error)
  return parseShiftStatus(data)
}

export interface CashMoveInput { id: string; kind: CashMoveKind; amountSen: number; reason: string; approverId: string | null; pin: string | null }

/** Idempotent on `id`: a resend after a lost reply records nothing twice. */
export async function recordCashMove(m: CashMoveInput): Promise<CashMoveResult> {
  const { data, error } = await supabase
    .rpc('record_cash_move', {
      p_id: m.id, p_kind: m.kind, p_amount_sen: m.amountSen, p_reason: m.reason, p_approver_id: m.approverId, p_pin: m.pin,
    })
    .abortSignal(AbortSignal.timeout(MONEY_TIMEOUT_MS))
  if (error) fail(error)
  return parseCashMoveResult(data)
}

/** The blind count. Without `approval` the server answers "needs approval" above the limit (or
 *  when the first count was above it); with it, `expectedSen` is the expected cash the approver
 *  was shown — changed meanwhile, the answer is "needs approval" again with the new figures.
 *  A resend of a close that went through answers the same report. */
export async function closeShift(shiftId: string, countedSen: number, approval: Approval | null,
                                 expectedSen: number | null): Promise<CloseResult> {
  const { data, error } = await supabase
    .rpc('close_shift', {
      p_shift_id: shiftId, p_counted_sen: countedSen,
      p_reason: approval?.reason ?? null, p_approver_id: approval?.approverId ?? null, p_pin: approval?.pin ?? null,
      p_expected_sen: expectedSen,
    })
    .abortSignal(AbortSignal.timeout(MONEY_TIMEOUT_MS))
  if (error) fail(error)
  return parseCloseResult(data)
}

/** The last 30 closed shifts of the branch (Approve POS voids & refunds). */
export async function fetchShiftList(): Promise<ShiftListRow[]> {
  const { data, error } = await supabase.rpc('pos_shift_list')
  if (error) fail(error)
  return parseShiftList(data)
}

export async function fetchShiftZReport(shiftId: string): Promise<ZReport> {
  const { data, error } = await supabase.rpc('pos_shift_zreport', { p_shift_id: shiftId })
  if (error) fail(error)
  return parseZReport(data)
}

export async function reprintZReport(shiftId: string): Promise<void> {
  const { error } = await supabase.rpc('reprint_zreport', { p_shift_id: shiftId })
  if (error) fail(error)
}

/** branch_pos_settings is readable by every signed-in staff member (pos_read); no row = the default. */
export async function fetchCashVarianceLimit(branchId: string): Promise<number> {
  const { data, error } = await supabase.from('branch_pos_settings')
    .select('cash_variance_limit_sen').eq('branch_id', branchId).maybeSingle()
  if (error) fail(error)
  return (data as { cash_variance_limit_sen: number } | null)?.cash_variance_limit_sen ?? DEFAULT_LIMIT_SEN
}

export async function saveCashVarianceLimit(branchId: string, limitSen: number): Promise<void> {
  const { error } = await supabase.rpc('save_shift_settings', { p_branch_id: branchId, p_cash_variance_limit_sen: limitSen })
  if (error) fail(error)
}
