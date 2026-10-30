// Claim Desk: classification vocabulary and pure helpers (no React, no Supabase),
// carried over from the prototype in docs/claim-desk/claim-desk.html.
// The terms follow docs/claim-desk/单据分类与入账指南.md (Malaysian audit wording).

export const DOC_TYPES = [
  'Supplier Invoice', 'Tax Invoice (SST)', 'Cash Bill / Receipt', 'Validated e-Invoice',
  'Foreign Purchase – Staff Expense Claim', 'Credit Note', 'Other Supporting Document',
] as const

export const ACCOUNTS_DEFAULT = [
  'Purchases (Cost of Sales)', 'Freight Inwards / Carriage Inwards', 'Packaging Materials',
  'Office Supplies & Stationery', 'Repair & Maintenance', 'Upkeep of Premises',
  'Transport & Delivery (Carriage Outwards)', 'Advertising & Promotion', 'Software & Subscriptions',
  'Telephone & Internet', 'Bank Charges', 'Payment Gateway / Merchant Fees',
  'Marketplace Commission & Fees (Shopee / Lazada)', 'Small Value Asset (≤ RM2,000)',
  'Fixed Asset – Equipment (PPE)', 'Staff Welfare', 'Entertainment', 'Sundry Expenses',
].map(name => ({ name, code: '' }))

export const TAX = [
  'Allowable expense (s33 ITA 1967)', 'Capital allowance (Schedule 3)',
  'Partly allowable (e.g. entertainment 50%)', 'Non-allowable / private', 'To be decided by tax agent',
] as const

export const PAYMENT = ['Unpaid (Accounts Payable)', 'Paid by company', 'Staff-paid (Reimbursement)'] as const
export const STATUS = ['Needs info', 'Draft', 'Reviewed', 'Posted to AutoCount', 'Cancelled'] as const
export const SELF_BILLED = ['Not required', 'Required – pending', 'Issued'] as const
export const PLATFORM = ['', 'Shopee', 'Taobao', 'Lazada', 'Walk-in / Direct', 'Other'] as const
export const CURRENCIES = ['MYR', 'CNY', 'USD', 'SGD'] as const

export type DocStatus = typeof STATUS[number]
export type DocSource = 'paper' | 'taobao' | 'claim' | 'einvoice'

export const SOURCE_LABEL: Record<DocSource, string> = {
  paper: 'Paper', taobao: 'Taobao', claim: 'Staff claim', einvoice: 'e-Invoice',
}

export interface AccountRow { name: string; code: string }

export interface DocFile {
  bucket?: string
  path?: string
  url?: string
  name: string
  type?: string
}

export interface DocItem {
  orderNo?: string
  descEn?: string
  descZh?: string
  qty?: number | null
  unitPriceCny?: number | null
  amountCny?: number | null
  amount?: number | null
}

/** One row of account_docs. */
export interface AccountDoc {
  id: string
  source: DocSource
  doc_type: string | null
  platform: string | null
  supplier: string | null
  supplier_ref: string | null
  doc_date: string
  currency: string
  amount: number | null
  rate: number | null
  amount_myr: number | null
  sst: number | null
  description: string | null
  gl_account: string | null
  tax_treatment: string | null
  payment: string | null
  claimant: string | null
  self_billed: string
  self_billed_uuid: string | null
  voucher_no: string | null
  status: DocStatus
  notes: string | null
  items: DocItem[]
  files: DocFile[]
  einvoice_uuid: string | null
  einvoice: Record<string, unknown> | null
  claim_id: string | null
  created_at: string
  updated_at: string
}

// ── numbers & dates ───────────────────────────────────────────────────────────

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export function numOf(v: unknown): number | null {
  const x = parseFloat(String(v ?? '').replace(/,/g, ''))
  return Number.isFinite(x) ? x : null
}

export function money(n: number | null | undefined): string {
  if (n == null || Number.isNaN(Number(n))) return '—'
  return Number(n).toLocaleString('en-MY', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** Today in Malaysia time, YYYY-MM-DD. */
export const todayMYT = (now = Date.now()) => new Date(now + 8 * 3600e3).toISOString().slice(0, 10)

export const isIsoDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)

/** First and last day of a 'YYYY-MM' month. */
export function monthRange(period: string): { from: string; to: string } {
  const [y, m] = period.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, '0')}` }
}

// ── supplier memory & vouchers ────────────────────────────────────────────────

/** Must match supplierKey() in supabase/functions/myinvois-inbox/parse.ts. */
export function supplierKey(name: string | null | undefined): string {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim()
}

/** PI (owed) / PV (company paid) / EC (staff claim) / CN (credit note) - YYMM - running number. */
export function voucherPrefix(d: { doc_type?: string | null; payment?: string | null }): 'PI' | 'PV' | 'EC' | 'CN' {
  if (d.doc_type === 'Credit Note') return 'CN'
  if (d.payment === 'Staff-paid (Reimbursement)') return 'EC'
  if (d.payment === 'Paid by company') return 'PV'
  return 'PI'
}

export function suggestVoucher(
  d: { doc_type?: string | null; payment?: string | null; doc_date?: string | null },
  existing: (string | null | undefined)[],
  today = todayMYT(),
): string {
  const yymm = (d.doc_date || today).slice(2, 7).replace('-', '')
  const head = `${voucherPrefix(d)}-${yymm}-`
  const max = existing
    .filter((v): v is string => !!v && v.startsWith(head))
    .map(v => parseInt(v.slice(head.length), 10) || 0)
    .reduce((a, b) => Math.max(a, b), 0)
  return head + String(max + 1).padStart(3, '0')
}

// ── AutoCount export ──────────────────────────────────────────────────────────

export const CSV_HEAD = [
  'Voucher No', 'Doc Type', 'Doc Date', 'Creditor / Supplier', 'Supplier Ref', 'Description', 'Account Code',
  'Account Name', 'Currency', 'Amount (Foreign)', 'Currency Rate', 'Amount (MYR)', 'SST (MYR)', 'Tax Treatment',
  'Payment', 'Claimant', 'Platform', 'e-Invoice UUID', 'Self-billed e-Invoice', 'Self-billed UUID', 'Status',
  'Attachments',
]

const csvCell = (v: unknown) => {
  const s = String(v ?? '')
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

/** UTF-8 BOM + CRLF so Excel and AutoCount open it with the right encoding. Cancelled rows are left out. */
export function buildAutoCountCsv(docs: AccountDoc[], accounts: AccountRow[]): { csv: string; rows: number; missing: number } {
  const code = (name: string | null) => accounts.find(a => a.name === name)?.code ?? ''
  const rows = docs.filter(d => d.status !== 'Cancelled')
  const lines = rows.map(d => [
    d.voucher_no, d.doc_type, d.doc_date, d.supplier, d.supplier_ref, d.description, code(d.gl_account), d.gl_account,
    d.currency || 'MYR', d.amount, d.rate, d.amount_myr, d.sst, d.tax_treatment, d.payment, d.claimant, d.platform,
    d.einvoice_uuid, d.self_billed, d.self_billed_uuid, d.status, (d.files ?? []).map(f => f.name).join('; '),
  ].map(csvCell).join(','))
  return {
    csv: '﻿' + [CSV_HEAD.join(','), ...lines].join('\r\n'),
    rows: rows.length,
    missing: rows.filter(d => !d.gl_account || d.amount_myr == null).length,
  }
}

// ── Taobao claim ──────────────────────────────────────────────────────────────

export interface TaobaoItem { descZh?: string; descEn?: string; qty?: number | null; unitPriceCny?: number | null; amountCny?: number | null }
export interface TaobaoOrder {
  orderNo?: string | null
  orderDate?: string | null
  sellerZh?: string | null
  sellerEn?: string | null
  items: TaobaoItem[]
  shippingCny?: number | null
  discountCny?: number | null
  totalPaidCny?: number | null
}
export interface TaobaoRead {
  orders: TaobaoOrder[]
  paymentMethod?: string | null
  suggestedAccount?: string | null
  notes?: string | null
}

/** Coerce whatever the model returned into the shape the form edits. */
export function normaliseTaobao(raw: unknown): TaobaoRead {
  const r = (raw ?? {}) as Record<string, unknown>
  const orders = (Array.isArray(r.orders) ? r.orders : []).map((o: Record<string, unknown>) => ({
    orderNo: o.orderNo ? String(o.orderNo) : '',
    orderDate: isIsoDate(o.orderDate) ? o.orderDate : '',
    sellerZh: o.sellerZh ? String(o.sellerZh) : '',
    sellerEn: o.sellerEn ? String(o.sellerEn) : '',
    items: (Array.isArray(o.items) ? o.items : []).map((i: Record<string, unknown>) => ({
      descZh: i.descZh ? String(i.descZh) : '',
      descEn: i.descEn ? String(i.descEn) : '',
      qty: numOf(i.qty),
      unitPriceCny: numOf(i.unitPriceCny),
      amountCny: numOf(i.amountCny),
    })),
    shippingCny: numOf(o.shippingCny),
    discountCny: numOf(o.discountCny),
    totalPaidCny: numOf(o.totalPaidCny),
  }))
  return {
    orders,
    paymentMethod: r.paymentMethod ? String(r.paymentMethod) : '',
    suggestedAccount: r.suggestedAccount ? String(r.suggestedAccount) : '',
    notes: r.notes ? String(r.notes) : '',
  }
}

/** Totals across orders: the paid total when every order shows one, else items + shipping − discount. */
export function taobaoTotals(orders: TaobaoOrder[]) {
  const sum = (f: (o: TaobaoOrder) => number | null | undefined) => round2(orders.reduce((t, o) => t + (f(o) ?? 0), 0))
  const items = sum(o => o.items.reduce((s, i) => s + (i.amountCny ?? 0), 0))
  const shipping = sum(o => o.shippingCny)
  const discount = sum(o => o.discountCny)
  const allPaid = orders.length > 0 && orders.every(o => o.totalPaidCny != null)
  return { items, shipping, discount, total: allPaid ? sum(o => o.totalPaidCny) : round2(items + shipping - discount) }
}

/** jsPDF's built-in fonts are Latin-1 only: fold accents and drop anything else (Chinese stays in Appendix A). */
export function ascii(s: unknown): string {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/×/g, 'x').replace(/≤/g, '<=')
    .replace(/[^\x20-\x7E\n]/g, '')
}

// ── images for the AI ─────────────────────────────────────────────────────────

/**
 * How to cut one image into slices the model can still read. A phone "long
 * screenshot" (1080×6000) shrunk whole would leave the text unreadable, so tall
 * images are cut into bands about twice as tall as wide, with a little overlap.
 */
export function slicePlan(width: number, height: number, maxWidth = 1100): { sy: number; sh: number; scale: number }[] {
  const scale = Math.min(1, maxWidth / width)
  const band = Math.round(width * 2)
  if (height <= band * 1.15) return [{ sy: 0, sh: height, scale: Math.min(scale, 1600 / Math.max(width, height)) }]
  const overlap = Math.round(width * 0.12)
  const out: { sy: number; sh: number; scale: number }[] = []
  for (let sy = 0; sy < height; sy += band - overlap) {
    const sh = Math.min(band, height - sy)
    out.push({ sy, sh, scale })
    if (sy + sh >= height) break
  }
  return out
}
