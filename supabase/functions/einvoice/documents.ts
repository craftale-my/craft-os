// Which document a bill, a month or a refund becomes — built and checked to the sen before anything is
// created. Pure (imports ubl.ts only), so vitest runs it; index.ts and reconcile.ts call it.
// Design: docs/superpowers/specs/2026-10-26-myinvois-einvoice-design.md (W5.2, W5.5, W5.6)

import {
  billMix, buildDocument, dayLines, documentTotals, GENERAL_PUBLIC, ledgerBillLines, mixLines, refundMix, roundingOnly,
  type BillTotals, type DocInput, type DocKind, type DocRef, type LedgerLine, type Mix, type Party,
} from './ubl.ts'

/** RM 10,000: a bill over it is never consolidated and needs the buyer's details (spec W5.6). */
export const OVER_LIMIT_SEN = 1_000_000

/** Refused before anything was created; status is the HTTP status index.ts answers with. */
export class PlanError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message)
  }
}

export interface PlanCtx { supplier: Party; issuedAt: Date }
export interface Planned { kind: DocKind; totalSen: number; build: (codeNumber: string) => DocInput }

/** einvoice_bill_source (supabase/migration-2026-11-23-einvoice-w5.sql E4). */
export interface BillSource {
  bill: {
    id: string; branchId: string; billNo: string; status: string; businessDay: string | null
    totalSen: number; refundedSen: number; einvoiceFrom: string | null
  }
  totals: BillTotals | null
  lines: LedgerLine[]
}

/** A row of einvoice_unlinked_paid_bills. day = the business day. */
export interface MonthBill { id: string; billNo: string; day: string; totalSen: number; totals: BillTotals | null }

/** A row of einvoice_pending_single_refunds / einvoice_pending_consolidated_refunds. */
export interface PendingRefund {
  refundId: string
  billId: string
  branchId: string
  billNo: string
  amountSen: number
  refundDay: string
  totals: BillTotals | null
  invoiceCode: string
  invoiceUuid: string
  invoiceBuyer: Party | null
  refundedBeforeSen: number   // the same bill's refunds booked before this one
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function checked(p: Planned, what: string): Planned {
  const input = p.build('check')
  try {
    buildDocument(input)
  } catch (e) {
    throw new PlanError(message(e))
  }
  const payable = documentTotals(input).payable
  if (payable !== p.totalSen) throw new PlanError(`The document adds up to ${payable} sen, ${what} ${p.totalSen} sen`)
  return p
}

function mixOf(totals: BillTotals | null, billNo: string): Mix {
  if (!totals) throw new PlanError(`Bill ${billNo} has no checkout totals`)
  try {
    return billMix(totals)
  } catch (e) {
    throw new PlanError(`Bill ${billNo}: ${message(e)}`)
  }
}

function refundShare(r: PendingRefund): Mix {
  const bill = mixOf(r.totals, r.billNo)
  try {
    return refundMix(bill, r.amountSen, r.refundedBeforeSen)
  } catch (e) {
    throw new PlanError(`Refund of ${r.billNo}: ${message(e)}`)
  }
}

/** One bill as its own e-invoice from its ledger lines. No outlet rules: planInvoice adds them. */
export function billInvoice(
  lines: LedgerLine[], totals: BillTotals | null, totalSen: number, ctx: PlanCtx, buyer: Party | null,
): Planned {
  if (!totals) throw new PlanError('This bill has no checkout totals')
  let parts: ReturnType<typeof ledgerBillLines>
  try {
    parts = ledgerBillLines(lines, totals)
  } catch (e) {
    throw new PlanError(message(e))
  }
  return checked({
    kind: 'invoice',
    totalSen,
    build: (codeNumber) => ({
      kind: 'invoice', codeNumber, issuedAt: ctx.issuedAt, supplier: ctx.supplier, buyer: buyer ?? GENERAL_PUBLIC,
      lines: parts.lines, docChargeSen: parts.docChargeSen, docChargeReason: 'Service charge', roundingSen: parts.roundingSen,
    }),
  }, 'the bill is')
}

/** A paid bill of an outlet we report, on or after its start date; over RM 10,000 only with a buyer. */
export function planInvoice(src: BillSource, ctx: PlanCtx, buyer: Party | null): Planned {
  const b = src.bill
  if (b.status !== 'paid') throw new PlanError(`Only a paid bill can be e-invoiced (this one is ${b.status})`, 409)
  if (!b.einvoiceFrom) {
    throw new PlanError('This outlet is not reported by us yet: set "Report e-invoices from" on the E-invoice screen first', 409)
  }
  if (!b.businessDay || b.businessDay < b.einvoiceFrom) {
    throw new PlanError(`This bill is from before ${b.einvoiceFrom}, when this outlet's e-invoices start: Feedme reports it`, 409)
  }
  if (b.totalSen > OVER_LIMIT_SEN && !buyer) throw new PlanError("A bill over RM 10,000 needs the buyer's details", 409)
  return billInvoice(src.lines, src.totals, b.totalSen, ctx, buyer)
}

/** A month's remaining bills as one consolidated invoice to General Public, lines per business day and rate. */
export function planConsolidated(bills: MonthBill[], period: { start: string; end: string }, ctx: PlanCtx): Planned {
  if (bills.length === 0) throw new PlanError('No bills to consolidate')
  const parts = dayLines(bills.map((b) => ({ billNo: b.billNo, day: b.day, mix: mixOf(b.totals, b.billNo) })), 'Receipts')
  return checked({
    kind: 'consolidated_invoice',
    totalSen: bills.reduce((a, b) => a + b.totalSen, 0),
    build: (codeNumber) => ({
      kind: 'consolidated_invoice', codeNumber, issuedAt: ctx.issuedAt, supplier: ctx.supplier, buyer: GENERAL_PUBLIC,
      lines: parts.lines, docChargeSen: 0, roundingSen: parts.roundingSen, period,
    }),
  }, 'the bills are')
}

/** A refund of an individually invoiced bill: a credit note to the same buyer, naming that invoice. */
export function planCreditNote(r: PendingRefund, ctx: PlanCtx): Planned {
  const mix = refundShare(r)
  const lines = mixLines(mix, `Refund of receipt ${r.billNo}`, '022')
  const ref: DocRef = { codeNumber: r.invoiceCode, uuid: r.invoiceUuid }
  return checked({
    kind: 'credit_note',
    totalSen: r.amountSen,
    build: (codeNumber) => ({
      kind: 'credit_note', codeNumber, issuedAt: ctx.issuedAt, supplier: ctx.supplier, buyer: r.invoiceBuyer ?? GENERAL_PUBLIC,
      lines, docChargeSen: 0, roundingSen: roundingOnly(mix) ? 0 : mix.roundingSen, references: [ref],
    }),
  }, 'the refund is')
}

/** A month's refunds of consolidated bills: one consolidated credit note naming each consolidated invoice once. */
export function planConsolidatedCreditNote(
  refunds: PendingRefund[], period: { start: string; end: string }, ctx: PlanCtx,
): Planned {
  if (refunds.length === 0) throw new PlanError('No refunds to credit')
  const parts = dayLines(refunds.map((r) => ({ billNo: r.billNo, day: r.refundDay, mix: refundShare(r) })), 'Refunds of receipts')
  const references = [...new Map(refunds.map((r) => [r.invoiceUuid, { codeNumber: r.invoiceCode, uuid: r.invoiceUuid }])).values()]
  return checked({
    kind: 'consolidated_credit_note',
    totalSen: refunds.reduce((a, r) => a + r.amountSen, 0),
    build: (codeNumber) => ({
      kind: 'consolidated_credit_note', codeNumber, issuedAt: ctx.issuedAt, supplier: ctx.supplier, buyer: GENERAL_PUBLIC,
      lines: parts.lines, docChargeSen: 0, roundingSen: parts.roundingSen, period, references,
    }),
  }, 'the refunds are')
}
