// Pure rules behind the E-invoice screen: the company form, which documents still
// need the owner, and what Retry sends to the `einvoice` Edge Function.
// Design: docs/superpowers/specs/2026-10-26-myinvois-einvoice-design.md

export const SETTINGS_FIELDS = [
  'supplier_name', 'supplier_tin', 'supplier_brn', 'supplier_sst_no', 'supplier_ttx_no',
  'msic_code', 'business_activity', 'address_line', 'city', 'postcode', 'state_code', 'phone', 'email',
] as const
export type SettingsField = (typeof SETTINGS_FIELDS)[number]
export type SettingsForm = Record<SettingsField, string>
export type CleanSettings = Record<SettingsField, string | null>

/** Same list the Edge Function refuses to submit without (REQUIRED in index.ts). */
const REQUIRED: SettingsField[] = [
  'supplier_name', 'supplier_tin', 'supplier_brn', 'msic_code', 'business_activity',
  'address_line', 'city', 'state_code', 'phone',
]

/** LHDN state codes (e-Invoice code list). */
export const STATE_CODES: { code: string; name: string }[] = [
  { code: '01', name: 'Johor' }, { code: '02', name: 'Kedah' }, { code: '03', name: 'Kelantan' },
  { code: '04', name: 'Melaka' }, { code: '05', name: 'Negeri Sembilan' }, { code: '06', name: 'Pahang' },
  { code: '07', name: 'Pulau Pinang' }, { code: '08', name: 'Perak' }, { code: '09', name: 'Perlis' },
  { code: '10', name: 'Selangor' }, { code: '11', name: 'Terengganu' }, { code: '12', name: 'Sabah' },
  { code: '13', name: 'Sarawak' }, { code: '14', name: 'WP Kuala Lumpur' }, { code: '15', name: 'WP Labuan' },
  { code: '16', name: 'WP Putrajaya' }, { code: '17', name: 'Not applicable' },
]

export const emptySettings = (): SettingsForm =>
  Object.fromEntries(SETTINGS_FIELDS.map((f) => [f, ''])) as SettingsForm

/** A database row (nulls allowed) as form strings. */
export const toForm = (row: Partial<Record<SettingsField, string | null>> | null): SettingsForm => {
  const form = emptySettings()
  for (const f of SETTINGS_FIELDS) form[f] = row?.[f] ?? ''
  if (form.supplier_sst_no === 'NA') form.supplier_sst_no = ''
  if (form.supplier_ttx_no === 'NA') form.supplier_ttx_no = ''
  return form
}

/** The row to save: trimmed, blanks as null, LHDN's "NA" for no SST / tourism tax number. */
export function cleanSettings(form: SettingsForm): CleanSettings {
  const out = {} as CleanSettings
  for (const f of SETTINGS_FIELDS) out[f] = form[f].trim() || null
  out.supplier_tin = out.supplier_tin?.toUpperCase().replace(/\s+/g, '') ?? null
  out.supplier_brn = out.supplier_brn?.replace(/[\s-]+/g, '') ?? null
  out.phone = out.phone?.replace(/[\s-]+/g, '') ?? null
  out.supplier_sst_no = out.supplier_sst_no?.toUpperCase() ?? 'NA'
  out.supplier_ttx_no = out.supplier_ttx_no?.toUpperCase() ?? 'NA'
  return out
}

/** Field → message. Empty object means the company is ready to submit. */
export function checkSettings(s: CleanSettings): Partial<Record<SettingsField, string>> {
  const errs: Partial<Record<SettingsField, string>> = {}
  for (const f of REQUIRED) if (!s[f]) errs[f] = 'Required'
  const bad = (f: SettingsField, ok: boolean, msg: string) => { if (s[f] && !ok) errs[f] = msg }
  bad('supplier_tin', /^[A-Z]{1,2}\d{8,12}$/.test(s.supplier_tin ?? ''), 'A TIN looks like C12345678090')
  bad('supplier_brn', /^\d{12}$/.test(s.supplier_brn ?? ''), 'Use the 12-digit SSM number, e.g. 201901012345')
  bad('msic_code', /^\d{5}$/.test(s.msic_code ?? ''), 'MSIC is 5 digits')
  bad('state_code', /^(0[1-9]|1[0-7])$/.test(s.state_code ?? ''), 'Pick a state')
  bad('postcode', /^\d{5}$/.test(s.postcode ?? ''), 'Postcode is 5 digits')
  bad('phone', /^\+?\d{8,15}$/.test(s.phone ?? ''), 'Digits only, e.g. +60123456789')
  bad('email', /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email ?? ''), 'Not an email address')
  return errs
}

// ── Documents ───────────────────────────────────────────────────────────────
export type DocKind = 'invoice' | 'credit_note' | 'consolidated_invoice' | 'consolidated_credit_note'
export type DocStatus = 'draft' | 'submitted' | 'valid' | 'invalid' | 'rejected' | 'cancelled'

export interface EinvoiceDoc {
  id: string
  kind: DocKind
  environment: 'sandbox' | 'production'
  branch_id: string
  code_number: string
  bill_id: string | null
  period_start: string | null
  period_end: string | null
  buyer: unknown
  total_sen: number
  status: DocStatus
  errors: unknown
  created_at: string
  lhdn_uuid: string | null
  long_id: string | null
  /** Joined for display; absent in tests. */
  bill?: { bill_no: string } | null
}

export const KIND_LABEL: Record<DocKind, string> = {
  invoice: 'E-invoice',
  credit_note: 'Credit note',
  consolidated_invoice: 'Monthly consolidated',
  consolidated_credit_note: 'Monthly credit note',
}

/** What a document covers: a branch's month, or one bill. Later documents for the same key replace earlier ones. */
const coverKey = (d: EinvoiceDoc) =>
  d.kind.startsWith('consolidated') ? `${d.kind}|${d.branch_id}|${d.period_start}` : `${d.kind}|${d.bill_id}`

const needsOwner = (d: EinvoiceDoc) =>
  d.status === 'rejected' || d.status === 'invalid' || (d.status === 'draft' && d.errors != null)

/** Documents whose latest attempt failed — the only ones the owner has to look at. */
export function openProblems(docs: EinvoiceDoc[]): EinvoiceDoc[] {
  const latest = new Map<string, EinvoiceDoc>()
  for (const d of docs) {
    const k = coverKey(d)
    const cur = latest.get(k)
    if (!cur || d.created_at > cur.created_at) latest.set(k, d)
  }
  return [...latest.values()].filter(needsOwner).sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export interface Retry { label: string; body: Record<string, unknown> }

/** The Edge Function call that moves this document forward, or null when there is nothing to do. */
export function retryFor(d: EinvoiceDoc): Retry | null {
  if (d.status === 'draft') return { label: 'Resend', body: { action: 'refresh', documentId: d.id } }
  if (d.status === 'submitted') return { label: 'Check with LHDN', body: { action: 'refresh', documentId: d.id } }
  if (d.status !== 'rejected' && d.status !== 'invalid') return null
  if (d.kind === 'consolidated_invoice' && d.period_start) {
    return { label: 'Retry', body: { action: 'consolidate', branchId: d.branch_id, month: d.period_start.slice(0, 7) } }
  }
  if (d.kind === 'invoice' && d.bill_id) {
    return { label: 'Retry', body: { action: 'submit_bill', billId: d.bill_id, buyer: d.buyer ?? undefined } }
  }
  return null // credit notes: not built yet
}

/** LHDN's error payloads vary by endpoint; pull out something a person can read. */
export function errorText(errors: unknown): string {
  if (errors == null) return ''
  if (typeof errors === 'string') return errors
  const found: string[] = []
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || found.length >= 3 || v == null) return
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return }
    if (typeof v !== 'object') return
    const o = v as Record<string, unknown>
    for (const key of ['message', 'error', 'details']) {
      const m = o[key]
      if (typeof m === 'string' && m.trim()) { found.push(m.trim()); return }
    }
    Object.values(o).forEach((x) => walk(x, depth + 1))
  }
  walk(errors, 0)
  return found.length ? found.join(' · ') : JSON.stringify(errors).slice(0, 200)
}
