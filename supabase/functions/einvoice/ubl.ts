// MyInvois documents as UBL 2.1 JSON, document version 1.0 (unsigned — sandbox only).
// Pure: no Deno or Node imports, so vitest runs it and the Edge Function bundles it.
// Money is integer sen everywhere until the document is written out in RM.
// The field choices for line discounts, the per-rate consolidated lines and credit notes (type 02,
// BillingReference) stay unverified until the first sandbox submission (spec W5.8).
//
// Design: docs/superpowers/specs/2026-10-26-myinvois-einvoice-design.md (W5.2, W5.5)

export type IdType = 'BRN' | 'NRIC' | 'PASSPORT' | 'ARMY'

export interface Party {
  name: string
  tin: string
  idType: IdType
  idValue: string
  sstNo?: string
  ttxNo?: string               // supplier only
  msicCode?: string            // supplier only
  activity?: string            // supplier only
  address: { line: string; city: string; postcode?: string; stateCode: string; countryCode: string }
  phone: string
  email?: string
}

/** LHDN's stand-in buyer for consolidated and walk-in documents. */
export const GENERAL_PUBLIC: Party = {
  name: 'General Public',
  tin: 'EI00000000010',
  idType: 'BRN',
  idValue: 'NA',
  sstNo: 'NA',
  address: { line: 'NA', city: 'NA', stateCode: '17', countryCode: 'MYS' },
  phone: 'NA',
}

/** One tax slice of a line: the amount taxed at rateBp and the tax charged on it. */
export interface TaxPart { rateBp: number; baseSen: number; taxSen: number }

export type DocKind = 'invoice' | 'credit_note' | 'consolidated_invoice' | 'consolidated_credit_note'
export const isCreditNote = (k: DocKind) => k === 'credit_note' || k === 'consolidated_credit_note'

export interface DocLine {
  description: string
  classification: string       // LHDN classification code: '022' others, '004' consolidated
  qty: number
  unitPriceSen: number
  allowanceSen: number         // the line's discounts: catalog + item + its share of the bill discount
  chargeSen: number            // a takeaway line's packaging fee, taxed with the line
  taxes: TaxPart[]             // bases add up to lineAmount(line)
}

/** What a line comes to before tax: price × qty − discounts + packaging. */
export const lineAmount = (l: DocLine) => l.qty * l.unitPriceSen - l.allowanceSen + l.chargeSen

/** The document a credit note corrects. */
export interface DocRef { codeNumber: string; uuid: string }

export interface DocInput {
  kind: DocKind
  codeNumber: string
  issuedAt: Date
  supplier: Party
  buyer: Party
  lines: DocLine[]
  docChargeSen: number         // untaxed whole-document charge (a single bill's service charge)
  docChargeReason?: string
  roundingSen: number
  period?: { start: string; end: string }   // YYYY-MM-DD
  references?: DocRef[]        // credit notes only: the documents they correct
}

// ── POS shapes the builders read ────────────────────────────────────────────
export interface SstGroup { rateBp: number; baseSen: number; amountSen: number }
/** bills.totals as checkout froze it (pos_compute_bill). */
export interface BillTotals {
  subtotalSen: number          // after catalog and item discounts, before the bill discount
  serviceChargeSen: number
  sstSen: number
  takeawayFeeSen: number
  roundingSen: number
  totalSen: number
  sstGroups: SstGroup[]
  billDiscountSen?: number     // W2; absent on older bills
}
/** One line of einvoice_bill_lines (pos_ledger_lines, supabase/migration-2026-11-23-einvoice-w5.sql). */
export interface LedgerLine {
  itemId: string
  name: string
  qty: number
  unitPriceSen: number
  grossSen: number
  catalogDiscountSen: number
  itemDiscountSen: number
  billShareSen: number
  netSen: number
  takeawayFeeSen: number
  sstBaseSen: number
  taxRateBp: number            // 0 = untaxed (0 % or the outlet charged no SST)
  sstSen: number
}
/** What a bill (or a refund of it) is made of: SST slices, untaxed goods, service charge, rounding. */
export interface Mix { taxed: TaxPart[]; untaxedSen: number; serviceChargeSen: number; roundingSen: number }
export interface DayEntry { billNo: string; day: string; mix: Mix }

/**
 * Split `total` over `weights` in proportion, whole sen, largest remainder first,
 * so the parts always add back to `total` (ties go to the earlier part).
 */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum === 0) return weights.map((_, i) => (i === 0 ? total : 0))
  const exact = weights.map((w) => (total * w) / sum)
  const parts = exact.map(Math.floor)
  let left = total - parts.reduce((a, b) => a + b, 0)
  const order = exact.map((e, i) => ({ i, r: e - Math.floor(e) })).sort((a, b) => b.r - a.r || a.i - b.i)
  for (const { i } of order) {
    if (left <= 0) break
    parts[i] += 1
    left -= 1
  }
  return parts
}

/**
 * A paid bill as invoice lines, straight from the sales ledger: one line per item line with its
 * discounts as an allowance, a takeaway line's packaging as a charge, and the SST the ledger gave it.
 * The service charge and the rounding stay whole-document amounts.
 */
export function ledgerBillLines(lines: LedgerLine[], totals: BillTotals): {
  lines: DocLine[]; docChargeSen: number; roundingSen: number
} {
  if (lines.length === 0) throw new Error('The bill has no live lines')
  const out = lines.map((l): DocLine => {
    if (l.grossSen !== l.qty * l.unitPriceSen) throw new Error(`${l.name}: gross ${l.grossSen} sen is not ${l.qty} × ${l.unitPriceSen}`)
    if (l.sstBaseSen !== l.netSen + l.takeawayFeeSen) throw new Error(`${l.name}: SST base ${l.sstBaseSen} sen is not net + packaging`)
    return {
      description: l.name, classification: '022', qty: l.qty, unitPriceSen: l.unitPriceSen,
      allowanceSen: l.grossSen - l.netSen, chargeSen: l.takeawayFeeSen,
      taxes: [{ rateBp: l.taxRateBp, baseSen: l.sstBaseSen, taxSen: l.sstSen }],
    }
  })
  const tax = lines.reduce((a, l) => a + l.sstSen, 0)
  if (tax !== totals.sstSen) throw new Error(`The lines' SST adds up to ${tax} sen, the bill charged ${totals.sstSen}`)
  return { lines: out, docChargeSen: totals.serviceChargeSen, roundingSen: totals.roundingSen }
}

/** A bill's mix from its frozen totals. Goods = subtotal − bill discount + packaging; untaxed = goods − SST bases. */
export function billMix(t: BillTotals): Mix {
  const goods = t.subtotalSen - (t.billDiscountSen ?? 0) + t.takeawayFeeSen
  const taxed = t.sstGroups
    .filter((g) => g.baseSen > 0 || g.amountSen > 0)
    .map((g) => ({ rateBp: g.rateBp, baseSen: g.baseSen, taxSen: g.amountSen }))
    .sort((a, b) => a.rateBp - b.rateBp)
  const untaxedSen = goods - taxed.reduce((a, p) => a + p.baseSen, 0)
  if (untaxedSen < 0) throw new Error(`The bill's SST bases are ${-untaxedSen} sen more than its goods`)
  return { taxed, untaxedSen, serviceChargeSen: t.serviceChargeSen, roundingSen: t.roundingSen }
}

export const mixTotal = (m: Mix) =>
  m.taxed.reduce((a, p) => a + p.baseSen + p.taxSen, 0) + m.untaxedSen + m.serviceChargeSen + m.roundingSen

/**
 * What a refund of `refundSen` credits. The whole bill: its mix exactly. Part of it: spread by largest
 * remainder over each SST slice (base + tax), the untaxed goods and the service charge; inside a slice
 * the tax is its proportional part, never more than the slice's tax. No rounding on a partial refund.
 */
export function refundMix(bill: Mix, refundSen: number): Mix {
  const total = mixTotal(bill)
  if (!Number.isInteger(refundSen) || refundSen <= 0 || refundSen > total) {
    throw new Error(`A refund of ${refundSen} sen does not fit a bill of ${total} sen`)
  }
  if (refundSen === total) return { ...bill, taxed: bill.taxed.map((p) => ({ ...p })) }
  const n = bill.taxed.length
  const shares = allocate(refundSen, [...bill.taxed.map((p) => p.baseSen + p.taxSen), bill.untaxedSen, bill.serviceChargeSen])
  const taxed = bill.taxed.map((p, i) => {
    const whole = p.baseSen + p.taxSen
    const taxSen = whole > 0 ? Math.min(p.taxSen, Math.round((shares[i] * p.taxSen) / whole)) : 0
    return { rateBp: p.rateBp, baseSen: shares[i] - taxSen, taxSen }
  })
  return { taxed, untaxedSen: shares[n], serviceChargeSen: shares[n + 1], roundingSen: 0 }
}

export function addMix(a: Mix, b: Mix): Mix {
  const byRate = new Map<number, TaxPart>()
  for (const p of [...a.taxed, ...b.taxed]) {
    const q = byRate.get(p.rateBp) ?? { rateBp: p.rateBp, baseSen: 0, taxSen: 0 }
    byRate.set(p.rateBp, { rateBp: p.rateBp, baseSen: q.baseSen + p.baseSen, taxSen: q.taxSen + p.taxSen })
  }
  return {
    taxed: [...byRate.values()].sort((x, y) => x.rateBp - y.rateBp),
    untaxedSen: a.untaxedSen + b.untaxedSen,
    serviceChargeSen: a.serviceChargeSen + b.serviceChargeSen,
    roundingSen: a.roundingSen + b.roundingSen,
  }
}

const pct = (bp: number) => `${bp / 100}%`

/** A mix as lines: one per SST rate, one for untaxed goods, one for the service charge (empty parts left out). */
export function mixLines(mix: Mix, label: string, classification: string): DocLine[] {
  const one = (description: string, sen: number, part: TaxPart): DocLine => ({
    description, classification, qty: 1, unitPriceSen: sen, allowanceSen: 0, chargeSen: 0, taxes: [part],
  })
  const out: DocLine[] = []
  for (const p of mix.taxed) {
    if (p.baseSen > 0 || p.taxSen > 0) out.push(one(`${label}, SST ${pct(p.rateBp)}`, p.baseSen, { ...p }))
  }
  if (mix.untaxedSen > 0) out.push(one(`${label}, no SST`, mix.untaxedSen, { rateBp: 0, baseSen: mix.untaxedSen, taxSen: 0 }))
  if (mix.serviceChargeSen > 0) {
    out.push(one(`${label}, service charge`, mix.serviceChargeSen, { rateBp: 0, baseSen: mix.serviceChargeSen, taxSen: 0 }))
  }
  return out
}

/**
 * General Public bills (or refunds) of a month as lines per business day:
 * "Receipts 261025-001 – 261025-212 (212), SST 6%", "…, no SST", "…, service charge".
 * Per-bill lines would pass LHDN's 300 KB document limit.
 */
export function dayLines(entries: DayEntry[], label = 'Receipts'): { lines: DocLine[]; roundingSen: number } {
  const days = new Map<string, DayEntry[]>()
  for (const e of entries) days.set(e.day, [...(days.get(e.day) ?? []), e])
  const lines: DocLine[] = []
  let roundingSen = 0
  for (const day of [...days.keys()].sort()) {
    const list = days.get(day)!
    const mix = list.map((e) => e.mix).reduce(addMix)
    roundingSen += mix.roundingSen
    const nos = list.map((e) => e.billNo).sort()
    lines.push(...mixLines(mix, `${label} ${nos[0]} – ${nos[nos.length - 1]} (${list.length})`, '004'))
  }
  return { lines, roundingSen }
}

// ── UBL JSON ────────────────────────────────────────────────────────────────
const rm = (sen: number) => Math.round(sen) / 100
const amt = (sen: number) => [{ _: rm(sen), currencyID: 'MYR' }]
const txt = (v: string) => [{ _: v }]
/** Tax type: SST on F&B is Service Tax (02); anything untaxed is Not Applicable (06). */
const taxType = (rateBp: number) => (rateBp > 0 ? '02' : '06')

function taxSubtotal(p: TaxPart) {
  return {
    TaxableAmount: amt(p.baseSen),
    TaxAmount: amt(p.taxSen),
    TaxCategory: [{
      ID: txt(taxType(p.rateBp)),
      Percent: [{ _: p.rateBp / 100 }],
      TaxScheme: [{ ID: [{ _: 'OTH', schemeID: 'UN/ECE 5153', schemeAgencyID: '6' }] }],
    }],
  }
}

function partyJson(p: Party, supplier: boolean) {
  const ids = [
    { ID: [{ _: p.tin, schemeID: 'TIN' }] },
    { ID: [{ _: p.idValue, schemeID: p.idType }] },
    { ID: [{ _: p.sstNo || 'NA', schemeID: 'SST' }] },
    ...(supplier ? [{ ID: [{ _: p.ttxNo || 'NA', schemeID: 'TTX' }] }] : []),
  ]
  const a = p.address
  return [{
    Party: [{
      ...(supplier ? { IndustryClassificationCode: [{ _: p.msicCode ?? '', name: p.activity ?? '' }] } : {}),
      PartyIdentification: ids,
      PostalAddress: [{
        CityName: txt(a.city),
        ...(a.postcode ? { PostalZone: txt(a.postcode) } : {}),
        CountrySubentityCode: txt(a.stateCode),
        AddressLine: [{ Line: txt(a.line) }],
        Country: [{ IdentificationCode: [{ _: a.countryCode, listID: 'ISO3166-1', listAgencyID: '6' }] }],
      }],
      PartyLegalEntity: [{ RegistrationName: txt(p.name) }],
      Contact: [{ Telephone: txt(p.phone), ...(p.email ? { ElectronicMail: txt(p.email) } : {}) }],
    }],
  }]
}

function chargeJson(sen: number, reason: string, charge: boolean) {
  return { ChargeIndicator: [{ _: charge }], AllowanceChargeReason: txt(reason), Amount: amt(sen) }
}

function lineCharges(l: DocLine) {
  return [
    ...(l.allowanceSen > 0 ? [chargeJson(l.allowanceSen, 'Discount', false)] : []),
    ...(l.chargeSen > 0 ? [chargeJson(l.chargeSen, 'Takeaway packaging', true)] : []),
  ]
}

/** Sum of the document: what LegalMonetaryTotal states and the checks below rely on. */
export function documentTotals(input: DocInput) {
  const lineExt = input.lines.reduce((a, l) => a + lineAmount(l), 0)
  const tax = input.lines.reduce((a, l) => a + l.taxes.reduce((b, p) => b + p.taxSen, 0), 0)
  const taxExclusive = lineExt + input.docChargeSen
  const taxInclusive = taxExclusive + tax
  return { lineExt, tax, taxExclusive, taxInclusive, payable: taxInclusive + input.roundingSen }
}

export function buildDocument(input: DocInput): Record<string, unknown> {
  if (input.lines.length === 0) throw new Error('A document needs at least one line')
  if (isCreditNote(input.kind) && !input.references?.length) throw new Error('A credit note needs the document it corrects')
  for (const [i, l] of input.lines.entries()) {
    if (l.allowanceSen < 0 || l.chargeSen < 0 || l.allowanceSen > l.qty * l.unitPriceSen) {
      throw new Error(`Line ${i + 1}: discount or charge out of range`)
    }
    const base = l.taxes.reduce((a, p) => a + p.baseSen, 0)
    if (base !== lineAmount(l)) throw new Error(`Line ${i + 1}: taxed bases ${base} sen do not cover the line`)
  }
  const t = documentTotals(input)

  // Whole-document tax: every line's slices by rate, plus the document charge as untaxed.
  const byRate = new Map<number, TaxPart>()
  const add = (p: TaxPart) => {
    const q = byRate.get(p.rateBp) ?? { rateBp: p.rateBp, baseSen: 0, taxSen: 0 }
    q.baseSen += p.baseSen
    q.taxSen += p.taxSen
    byRate.set(p.rateBp, q)
  }
  input.lines.forEach((l) => l.taxes.forEach(add))
  if (input.docChargeSen > 0) add({ rateBp: 0, baseSen: input.docChargeSen, taxSen: 0 })

  const iso = input.issuedAt.toISOString()
  return {
    _D: 'urn:oasis:names:specification:ubl:schema:xsd:Invoice-2',
    _A: 'urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2',
    _B: 'urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2',
    Invoice: [{
      ID: txt(input.codeNumber),
      IssueDate: txt(iso.slice(0, 10)),
      IssueTime: txt(iso.slice(11, 19) + 'Z'),
      InvoiceTypeCode: [{ _: isCreditNote(input.kind) ? '02' : '01', listVersionID: '1.0' }],
      DocumentCurrencyCode: txt('MYR'),
      ...(input.period
        ? { InvoicePeriod: [{ StartDate: txt(input.period.start), EndDate: txt(input.period.end), Description: txt('Monthly') }] }
        : {}),
      ...(input.references?.length
        ? { BillingReference: input.references.map((r) => ({ InvoiceDocumentReference: [{ ID: txt(r.codeNumber), UUID: txt(r.uuid) }] })) }
        : {}),
      AccountingSupplierParty: partyJson(input.supplier, true),
      AccountingCustomerParty: partyJson(input.buyer, false),
      ...(input.docChargeSen > 0
        ? { AllowanceCharge: [chargeJson(input.docChargeSen, input.docChargeReason ?? 'Service charge', true)] }
        : {}),
      TaxTotal: [{
        TaxAmount: amt(t.tax),
        TaxSubtotal: [...byRate.values()].sort((a, b) => a.rateBp - b.rateBp).map(taxSubtotal),
      }],
      LegalMonetaryTotal: [{
        LineExtensionAmount: amt(t.lineExt),
        TaxExclusiveAmount: amt(t.taxExclusive),
        TaxInclusiveAmount: amt(t.taxInclusive),
        ...(input.docChargeSen > 0 ? { ChargeTotalAmount: amt(input.docChargeSen) } : {}),
        ...(input.roundingSen !== 0 ? { PayableRoundingAmount: amt(input.roundingSen) } : {}),
        PayableAmount: amt(t.payable),
      }],
      InvoiceLine: input.lines.map((l, i) => ({
        ID: txt(String(i + 1)),
        InvoicedQuantity: [{ _: l.qty, unitCode: 'C62' }],
        LineExtensionAmount: amt(lineAmount(l)),
        ...(lineCharges(l).length ? { AllowanceCharge: lineCharges(l) } : {}),
        TaxTotal: [{
          TaxAmount: amt(l.taxes.reduce((a, p) => a + p.taxSen, 0)),
          TaxSubtotal: l.taxes.map(taxSubtotal),
        }],
        Item: [{
          CommodityClassification: [{ ItemClassificationCode: [{ _: l.classification, listID: 'CLASS' }] }],
          Description: txt(l.description),
        }],
        Price: [{ PriceAmount: amt(l.unitPriceSen) }],
        ItemPriceExtension: [{ Amount: amt(l.qty * l.unitPriceSen) }],
      })),
    }],
  }
}
