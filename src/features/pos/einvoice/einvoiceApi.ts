import { supabase } from '../../../shared/lib/supabase'
import { writeOutcome } from '../../../shared/lib/db-write'
import type { CleanSettings, EinvoiceDoc, SettingsField } from './einvoice'

const DOC_COLUMNS =
  'id, kind, environment, branch_id, code_number, bill_id, period_start, period_end, buyer, total_sen, status, errors, created_at, lhdn_uuid, long_id, bill:bills!einvoice_documents_bill_id_fkey(bill_no)'

export type SettingsRow = Partial<Record<SettingsField, string | null>> & { environment: 'sandbox' | 'production' }

export async function fetchSettings(): Promise<SettingsRow | null> {
  const { data, error } = await supabase.from('einvoice_settings').select('*').eq('id', true).maybeSingle()
  if (error) throw new Error(`Loading the company details failed: ${error.message}`)
  return data as SettingsRow | null
}

export async function saveSettings(s: CleanSettings): Promise<void> {
  const out = writeOutcome(await supabase.from('einvoice_settings')
    .update({ ...s, updated_at: new Date().toISOString() }).eq('id', true).select('id'))
  if (!out.ok) throw new Error(`Saving the company details failed: ${out.reason}`)
}

/** The receipt details already kept on the branch — a starting point for an empty company form. */
export async function fetchReceiptDetails(branchId: string) {
  const { data, error } = await supabase.from('branches')
    .select('legal_name, registration_no, sst_no, address, phone, email').eq('id', branchId).maybeSingle()
  if (error) throw new Error(`Loading the receipt details failed: ${error.message}`)
  return data as { legal_name: string | null; registration_no: string | null; sst_no: string | null
    address: string | null; phone: string | null; email: string | null } | null
}

export async function fetchDocuments(limit = 200): Promise<EinvoiceDoc[]> {
  const { data, error } = await supabase.from('einvoice_documents').select(DOC_COLUMNS)
    .order('created_at', { ascending: false }).limit(limit)
  if (error) throw new Error(`Loading e-invoices failed: ${error.message}`)
  return (data ?? []) as unknown as EinvoiceDoc[] // bill is many-to-one, so PostgREST returns an object
}

export async function fetchBranchNames(): Promise<Record<string, string>> {
  const { data, error } = await supabase.from('branches').select('id, name')
  if (error) throw new Error(`Loading branches failed: ${error.message}`)
  return Object.fromEntries((data ?? []).map((b: { id: string; name: string }) => [b.id, b.name]))
}

export type CallResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** POST to the `einvoice` Edge Function; a non-2xx answer's reason is in its body. */
export async function callEinvoice<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<CallResult<T>> {
  const { data, error } = await supabase.functions.invoke('einvoice', { body })
  if (error) {
    let detail = error.message
    const ctx = (error as { context?: Response }).context
    if (ctx && typeof ctx.json === 'function') {
      try {
        const parsed = await ctx.json()
        if (parsed?.error) detail = parsed.error
      } catch {
        // not JSON — keep the generic message
      }
    }
    return { ok: false, error: detail }
  }
  if (data?.error) return { ok: false, error: data.error }
  return { ok: true, data: data as T }
}

export interface EinvoiceStatus {
  environment: 'sandbox' | 'production'
  credentials: { clientId: boolean; clientSecret: boolean }
  settingsMissing: string[]
  signing: string
  token: string
}

const PORTAL = { sandbox: 'https://preprod.myinvois.hasil.gov.my', production: 'https://myinvois.hasil.gov.my' }

/** LHDN's public validation page for a valid document (same link the receipt QR will carry). */
export const validationLink = (d: Pick<EinvoiceDoc, 'environment' | 'lhdn_uuid' | 'long_id'>) =>
  d.lhdn_uuid && d.long_id ? `${PORTAL[d.environment]}/${d.lhdn_uuid}/share/${d.long_id}` : null
