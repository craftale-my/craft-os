// Pure helpers for myinvois-inbox: no Deno or network APIs, so vitest can run them.

/** Same normalisation as the frontend's supplierKey(): the supplier_memory primary key. */
export function supplierKey(name: string | null | undefined): string {
  return String(name ?? '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, ' ').trim()
}

/** A calendar month in Malaysia time (UTC+8) as the UTC window Search Documents expects. */
export function monthWindow(month: string, now = new Date()): { from: string; to: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) throw new Error('month must be YYYY-MM')
  const y = Number(m[1]), mo = Number(m[2])
  if (mo < 1 || mo > 12) throw new Error('month must be YYYY-MM')
  const eight = 8 * 3600_000
  const from = Date.UTC(y, mo - 1, 1) - eight
  const to = Math.min(Date.UTC(y, mo, 1) - eight - 1000, now.getTime() - 60_000)
  if (to <= from) throw new Error('month is in the future')
  const iso = (t: number) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z')
  return { from: iso(from), to: iso(to) }
}

/** LHDN timestamps are UTC; the Register dates documents in Malaysia time. */
export function mytDate(utc: string | null | undefined): string | null {
  if (!utc) return null
  const t = Date.parse(utc)
  if (Number.isNaN(t)) return null
  return new Date(t + 8 * 3600_000).toISOString().slice(0, 10)
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100

export interface ReceivedDoc {
  uuid: string
  longId?: string | null
  internalId?: string | null
  typeName?: string | null
  typeVersionName?: string | null
  issuerTin?: string | null
  issuerName?: string | null
  supplierTIN?: string | null
  supplierTin?: string | null
  supplierName?: string | null
  dateTimeIssued?: string | null
  dateTimeReceived?: string | null
  dateTimeValidated?: string | null
  totalSales?: number | null
  totalDiscount?: number | null
  netAmount?: number | null
  total?: number | null
  status?: string | null
  cancelDateTime?: string | null
  documentStatusReason?: string | null
}

/** What one Search Documents row becomes in account_docs (classification fields excluded). */
export function registerFields(d: ReceivedDoc) {
  const supplier = d.supplierName || d.issuerName || ''
  const isCN = /credit/i.test(d.typeName ?? '')
  const total = typeof d.total === 'number' ? round2(d.total) : null
  const net = typeof d.netAmount === 'number' ? d.netAmount : null
  const tax = total != null && net != null && total - net > 0.004 ? round2(total - net) : null
  return {
    source: 'einvoice' as const,
    doc_type: isCN ? 'Credit Note' : 'Validated e-Invoice',
    supplier,
    supplier_ref: d.internalId ?? null,
    doc_date: mytDate(d.dateTimeIssued) ?? mytDate(d.dateTimeReceived),
    currency: 'MYR',
    amount: total,
    amount_myr: total,
    sst: tax,
    einvoice_uuid: d.uuid,
    einvoice: {
      uuid: d.uuid,
      longId: d.longId ?? null,
      number: d.internalId ?? null,
      type: d.typeName ?? null,
      typeVersion: d.typeVersionName ?? null,
      supplierTin: d.supplierTIN ?? d.supplierTin ?? d.issuerTin ?? null,
      issued: d.dateTimeIssued ?? null,
      validated: d.dateTimeValidated ?? null,
      status: d.status ?? null,
      cancelled: d.cancelDateTime ?? null,
      totalSales: d.totalSales ?? null,
      totalDiscount: d.totalDiscount ?? null,
      netAmount: d.netAmount ?? null,
      total: d.total ?? null,
    },
  }
}

export interface RawDetails {
  currency: string | null
  tax: number | null
  items: { descEn: string; qty: number | null; amount: number | null }[]
}

const num = (v: unknown): number | null => {
  const x = typeof v === 'number' ? v : parseFloat(String(v ?? ''))
  return Number.isFinite(x) ? x : null
}

/** UBL JSON wraps every value as [{ "_": value }]. */
const val = (node: unknown): unknown => (Array.isArray(node) ? (node[0] as Record<string, unknown>)?._ : undefined)
const first = (node: unknown): Record<string, unknown> | undefined =>
  Array.isArray(node) ? (node[0] as Record<string, unknown>) : undefined

/** Line descriptions, tax and currency from the raw document (UBL JSON or XML). */
export function parseRawDocument(raw: string): RawDetails {
  const text = raw.trim()
  if (text.startsWith('{')) {
    const doc = JSON.parse(text) as Record<string, unknown>
    const inv = first(doc.Invoice ?? doc.CreditNote ?? doc.DebitNote) ?? {}
    const lines = (inv.InvoiceLine ?? inv.CreditNoteLine ?? inv.DebitNoteLine ?? []) as Record<string, unknown>[]
    return {
      currency: (val(inv.DocumentCurrencyCode) as string) ?? null,
      tax: num(val(first(inv.TaxTotal)?.TaxAmount)),
      items: lines.map((l) => ({
        descEn: String(val(first(l.Item)?.Description) ?? '').trim(),
        qty: num(val(l.InvoicedQuantity ?? l.CreditedQuantity ?? l.DebitedQuantity)),
        amount: num(val(l.LineExtensionAmount)),
      })).filter((i) => i.descEn),
    }
  }
  const lineRe = /<cac:(?:Invoice|CreditNote|DebitNote)Line>([\s\S]*?)<\/cac:(?:Invoice|CreditNote|DebitNote)Line>/g
  const items: RawDetails['items'] = []
  for (const m of text.matchAll(lineRe)) {
    const block = m[1]
    const desc = /<cbc:Description>([\s\S]*?)<\/cbc:Description>/.exec(block)?.[1]?.trim()
    if (!desc) continue
    items.push({
      descEn: desc.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'),
      qty: num(/<cbc:(?:Invoiced|Credited|Debited)Quantity[^>]*>([^<]+)</.exec(block)?.[1]),
      amount: num(/<cbc:LineExtensionAmount[^>]*>([^<]+)</.exec(block)?.[1]),
    })
  }
  const header = text.replace(lineRe, '')
  return {
    currency: /<cbc:DocumentCurrencyCode>([^<]+)</.exec(header)?.[1]?.trim() ?? null,
    tax: num(/<cac:TaxTotal>[\s\S]*?<cbc:TaxAmount[^>]*>([^<]+)</.exec(header)?.[1]),
    items,
  }
}
