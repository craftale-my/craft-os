// MyInvois documents as UBL 2.1 JSON, document version 1.0 (unsigned — sandbox only).
// Pure: no Deno or Node imports, so vitest runs it and the Edge Function bundles it.
// Money is integer sen everywhere until the document is written out in RM.
//
// Design: docs/superpowers/specs/2026-10-26-myinvois-einvoice-design.md

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

export interface DocLine {
  description: string
  classification: string       // LHDN classification code: '022' others, '004' consolidated
  qty: number
  unitPriceSen: number
  chargeSen: number            // untaxed line charge (a day's service charge on a consolidated line)
  chargeReason?: string
  taxes: TaxPart[]             // bases add up to qty × unitPriceSen + chargeSen
}

export interface DocInput {
  kind: 'invoice' | 'consolidated_invoice'
  codeNumber: string
  issuedAt: Date
  supplier: Party
  buyer: Party
  lines: DocLine[]
  docChargeSen: number         // untaxed whole-document charge (a single bill's service charge)
  docChargeReason?: string
  roundingSen: number
  period?: { start: string; end: string }   // YYYY-MM-DD
}

// ── POS shapes the builders read ────────────────────────────────────────────
export interface SstGroup { rateBp: number; baseSen: number; amountSen: number }
export interface BillTotals {
  subtotalSen: number
  serviceChargeSen: number
  sstSen: number
  takeawayFeeSen: number
  roundingSen: number
  totalSen: number
  sstGroups: SstGroup[]
}
export interface BillItem { name: string; qty: number; unitPriceSen: number; sstRateBp: number }
export interface DayBill { billNo: string; day: string; totals: BillTotals }

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
 * A paid bill as invoice lines: one per item, plus a "Takeaway packaging" line per
 * rate when the bill carried packaging fees. Each rate group's SST is split over its
 * lines, so the lines' tax equals what the receipt charged. Items whose rate has no
 * SST group (0 %, or a branch not registered) are untaxed. The service charge and the
 * rounding stay whole-document amounts.
 */
export function billLines(items: BillItem[], totals: BillTotals): {
  lines: DocLine[]; docChargeSen: number; roundingSen: number
} {
  const lines: DocLine[] = []
  const groups = new Map(totals.sstGroups.map((g) => [g.rateBp, g]))
  let feesPlaced = 0

  for (const g of totals.sstGroups) {
    const at = items.filter((it) => it.sstRateBp === g.rateBp)
    const itemSen = at.reduce((a, it) => a + it.unitPriceSen * it.qty, 0)
    const feeSen = g.baseSen - itemSen
    if (feeSen < 0) throw new Error(`SST group ${g.rateBp} bp is smaller than its items`)
    const weights = [...at.map((it) => it.unitPriceSen * it.qty), ...(feeSen > 0 ? [feeSen] : [])]
    const taxes = allocate(g.amountSen, weights)
    at.forEach((it, k) => lines.push(itemLine(it.name, it.qty, it.unitPriceSen, g.rateBp, taxes[k])))
    if (feeSen > 0) {
      lines.push(itemLine('Takeaway packaging', 1, feeSen, g.rateBp, taxes[at.length]))
      feesPlaced += feeSen
    }
  }
  for (const it of items) {
    if (!groups.has(it.sstRateBp)) lines.push(itemLine(it.name, it.qty, it.unitPriceSen, 0, 0))
  }
  const untaxedFee = totals.takeawayFeeSen - feesPlaced
  if (untaxedFee > 0) lines.push(itemLine('Takeaway packaging', 1, untaxedFee, 0, 0))

  const lineSen = lines.reduce((a, l) => a + l.qty * l.unitPriceSen, 0)
  if (lineSen !== totals.subtotalSen + totals.takeawayFeeSen) {
    throw new Error(`Bill lines add up to ${lineSen} sen, the bill says ${totals.subtotalSen + totals.takeawayFeeSen}`)
  }
  return { lines, docChargeSen: totals.serviceChargeSen, roundingSen: totals.roundingSen }
}

function itemLine(description: string, qty: number, unitPriceSen: number, rateBp: number, taxSen: number): DocLine {
  return {
    description, classification: '022', qty, unitPriceSen, chargeSen: 0,
    taxes: [{ rateBp, baseSen: qty * unitPriceSen, taxSen }],
  }
}

/**
 * A month of General Public bills as one line per Malaysia-time day:
 * "Receipts 261025-001 – 261025-212 (212)". Price = the day's items and packaging,
 * line charge = the day's service charge, taxes = the day's SST groups plus an
 * untaxed slice for the rest. Per-bill lines would pass LHDN's 300 KB document limit.
 */
export function dayLines(bills: DayBill[]): { lines: DocLine[]; roundingSen: number } {
  const days = new Map<string, DayBill[]>()
  for (const b of bills) days.set(b.day, [...(days.get(b.day) ?? []), b])

  const lines: DocLine[] = []
  let roundingSen = 0
  for (const day of [...days.keys()].sort()) {
    const list = days.get(day)!
    let goods = 0
    let charge = 0
    const byRate = new Map<number, TaxPart>()
    for (const b of list) {
      const t = b.totals
      goods += t.subtotalSen + t.takeawayFeeSen
      charge += t.serviceChargeSen
      roundingSen += t.roundingSen
      for (const g of t.sstGroups) {
        const p = byRate.get(g.rateBp) ?? { rateBp: g.rateBp, baseSen: 0, taxSen: 0 }
        p.baseSen += g.baseSen
        p.taxSen += g.amountSen
        byRate.set(g.rateBp, p)
      }
    }
    const taxed = [...byRate.values()].sort((a, b) => a.rateBp - b.rateBp)
    const untaxed = goods + charge - taxed.reduce((a, p) => a + p.baseSen, 0)
    const taxes = untaxed > 0 ? [{ rateBp: 0, baseSen: untaxed, taxSen: 0 }, ...taxed] : taxed
    const nos = list.map((b) => b.billNo).sort()
    lines.push({
      description: `Receipts ${nos[0]} – ${nos[nos.length - 1]} (${list.length})`,
      classification: '004',
      qty: 1,
      unitPriceSen: goods,
      chargeSen: charge,
      chargeReason: 'Service charge',
      taxes,
    })
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

function chargeJson(sen: number, reason: string) {
  return [{ ChargeIndicator: [{ _: true }], AllowanceChargeReason: txt(reason), Amount: amt(sen) }]
}

/** Sum of the document: what LegalMonetaryTotal states and the checks below rely on. */
export function documentTotals(input: DocInput) {
  const lineExt = input.lines.reduce((a, l) => a + l.qty * l.unitPriceSen + l.chargeSen, 0)
  const tax = input.lines.reduce((a, l) => a + l.taxes.reduce((b, p) => b + p.taxSen, 0), 0)
  const taxExclusive = lineExt + input.docChargeSen
  const taxInclusive = taxExclusive + tax
  return { lineExt, tax, taxExclusive, taxInclusive, payable: taxInclusive + input.roundingSen }
}

export function buildDocument(input: DocInput): Record<string, unknown> {
  if (input.lines.length === 0) throw new Error('A document needs at least one line')
  for (const [i, l] of input.lines.entries()) {
    const base = l.taxes.reduce((a, p) => a + p.baseSen, 0)
    if (base !== l.qty * l.unitPriceSen + l.chargeSen) {
      throw new Error(`Line ${i + 1}: taxed bases ${base} sen do not cover the line`)
    }
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
      InvoiceTypeCode: [{ _: '01', listVersionID: '1.0' }],
      DocumentCurrencyCode: txt('MYR'),
      ...(input.period
        ? { InvoicePeriod: [{ StartDate: txt(input.period.start), EndDate: txt(input.period.end), Description: txt('Monthly') }] }
        : {}),
      AccountingSupplierParty: partyJson(input.supplier, true),
      AccountingCustomerParty: partyJson(input.buyer, false),
      ...(input.docChargeSen > 0 ? { AllowanceCharge: chargeJson(input.docChargeSen, input.docChargeReason ?? 'Service charge') } : {}),
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
        LineExtensionAmount: amt(l.qty * l.unitPriceSen + l.chargeSen),
        ...(l.chargeSen > 0 ? { AllowanceCharge: chargeJson(l.chargeSen, l.chargeReason ?? 'Service charge') } : {}),
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
