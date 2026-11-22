import { describe, expect, it, vi } from 'vitest'
import {
  businessDay, ccnRef, cnRef, conRef, emptyReport, inConsolidationWindow, jobSecretMatches, MAX_ATTEMPTS, monthEnd,
  previousMonth, refOfDocument, runCreditNotes, runJob, runOutcome, type JobSteps, type PendingDoc, type StepResult,
} from './job.ts'
import type { PendingRefund } from './documents.ts'

// 23:00 UTC = 07:00 Malaysia time the next day: the cron's moment
const DAY1 = new Date('2026-10-31T23:00:00Z')   // business day 2026-11-01
const DAY8 = new Date('2026-11-07T23:00:00Z')   // business day 2026-11-08

const issued = (codeNumber: string): StepResult => ({ outcome: 'issued', codeNumber, status: 'submitted' })

function steps(over: Partial<JobSteps> = {}) {
  const failures = new Map<string, number>()
  const s = {
    failuresMap: failures,
    setUp: vi.fn(async () => ({ ok: true as const })),
    pendingDocuments: vi.fn(async (): Promise<PendingDoc[]> => []),
    refresh: vi.fn(async () => ({ status: 'valid' })),
    outlets: vi.fn(async () => [] as { id: string; einvoiceFrom: string | null }[]),
    failures: vi.fn(async (key: string) => failures.get(key) ?? 0),
    record: vi.fn(async (ref: { key: string }, ok: boolean) => {
      failures.set(ref.key, ok ? 0 : (failures.get(ref.key) ?? 0) + 1)
    }),
    consolidate: vi.fn(async () => issued('CON-1')),
    singleRefunds: vi.fn(async (): Promise<PendingRefund[]> => []),
    creditNote: vi.fn(async () => issued('CN-1')),
    refundMonths: vi.fn(async () => [] as { branchId: string; month: string }[]),
    consolidatedCreditNote: vi.fn(async () => issued('CCN-1')),
    ...over,
  }
  return s as JobSteps & { failuresMap: Map<string, number> } & typeof s
}

const refund = (over: Partial<PendingRefund> = {}): PendingRefund => ({
  refundId: 'r1', billId: 'b1', branchId: 'o1', billNo: '261105-001', amountSen: 300, refundDay: '2026-11-06',
  totals: null, invoiceCode: 'INV-1', invoiceUuid: 'U1', invoiceBuyer: null, refundedBeforeSen: 0, ...over,
})

describe('the business-day calendar', () => {
  it('starts a business day at 06:00 Malaysia time', () => {
    expect(businessDay(new Date('2026-11-01T04:00:00Z'))).toBe('2026-11-01')   // 12:00
    expect(businessDay(new Date('2026-10-31T21:30:00Z'))).toBe('2026-10-31')   // 1 Nov 05:30
    expect(businessDay(new Date('2026-10-31T22:00:00Z'))).toBe('2026-11-01')   // 1 Nov 06:00
    expect(businessDay(DAY1)).toBe('2026-11-01')
  })
  it('knows months and the consolidation window', () => {
    expect(previousMonth('2026-11')).toBe('2026-10')
    expect(previousMonth('2026-01')).toBe('2025-12')
    expect(monthEnd('2026-02')).toBe('2026-02-28')
    expect(monthEnd('2028-02')).toBe('2028-02-29')
    expect(inConsolidationWindow('2026-11-01')).toBe(true)
    expect(inConsolidationWindow('2026-11-07')).toBe(true)
    expect(inConsolidationWindow('2026-11-08')).toBe(false)
  })
})

describe('jobSecretMatches', () => {
  const secret = 'a'.repeat(64)
  it('accepts only the exact secret, and never a short or missing one', () => {
    expect(jobSecretMatches(secret, secret)).toBe(true)
    expect(jobSecretMatches('a'.repeat(63) + 'b', secret)).toBe(false)
    expect(jobSecretMatches('a'.repeat(32), secret)).toBe(false)
    expect(jobSecretMatches(null, secret)).toBe(false)
    expect(jobSecretMatches('short', 'short')).toBe(false)
    expect(jobSecretMatches('', undefined)).toBe(false)
  })
})

describe('attempt keys', () => {
  it('names what can fail repeatedly', () => {
    expect(conRef('o1', '2026-10')).toEqual({ key: 'CON|o1|2026-10', kind: 'consolidated_invoice', branchId: 'o1', periodStart: '2026-10-01', refundId: null })
    expect(ccnRef('o1', '2026-10')).toEqual({ key: 'CCN|o1|2026-10', kind: 'consolidated_credit_note', branchId: 'o1', periodStart: '2026-10-01', refundId: null })
    expect(cnRef('o1', 'r1')).toEqual({ key: 'CN|r1', kind: 'credit_note', branchId: 'o1', periodStart: null, refundId: 'r1' })
  })
  it('counts LHDN turning down a consolidated document against its month', () => {
    const d = (kind: string, periodStart: string | null): PendingDoc => ({ id: 'd', codeNumber: 'X', kind, branchId: 'o1', periodStart, status: 'submitted' })
    expect(refOfDocument(d('consolidated_invoice', '2026-10-01'))?.key).toBe('CON|o1|2026-10')
    expect(refOfDocument(d('consolidated_credit_note', '2026-10-15'))?.key).toBe('CCN|o1|2026-10')
    expect(refOfDocument(d('invoice', null))).toBeNull()
  })
})

describe('runJob', () => {
  it('records "not set up" and calls nothing else', async () => {
    const s = steps({ setUp: vi.fn(async () => ({ ok: false as const, reason: 'MyInvois credentials are not set' })) })
    const r = await runJob(s, DAY1)
    expect(r).toMatchObject({ businessDay: '2026-11-01', setUp: false, notSetUp: 'MyInvois credentials are not set' })
    expect(runOutcome(r)).toBe('not_set_up')
    for (const f of [s.pendingDocuments, s.outlets, s.consolidate, s.singleRefunds, s.refundMonths]) expect(f).not.toHaveBeenCalled()
  })

  it('refreshes waiting documents first and counts an invalid consolidated invoice as a failed attempt', async () => {
    const docs: PendingDoc[] = [
      { id: 'd1', codeNumber: 'CON-1', kind: 'consolidated_invoice', branchId: 'o1', periodStart: '2026-10-01', status: 'submitted' },
      { id: 'd2', codeNumber: 'INV-1', kind: 'invoice', branchId: 'o1', periodStart: null, status: 'submitted' },
    ]
    const s = steps({
      pendingDocuments: vi.fn(async () => docs),
      refresh: vi.fn(async (d: PendingDoc) => ({ status: d.id === 'd1' ? 'invalid' : 'valid' })),
    })
    const r = await runJob(s, DAY8)
    expect(r.refreshed).toEqual([{ codeNumber: 'CON-1', status: 'invalid' }, { codeNumber: 'INV-1', status: 'valid' }])
    expect(s.record).toHaveBeenCalledTimes(1)
    expect(s.record).toHaveBeenCalledWith(conRef('o1', '2026-10'), false, 'LHDN: CON-1 is invalid')
  })

  it('on days 1–7 consolidates last month for every outlet whose start date falls in or before it', async () => {
    const s = steps({
      outlets: vi.fn(async () => [
        { id: 'o1', einvoiceFrom: '2026-10-01' }, { id: 'o2', einvoiceFrom: null },
        { id: 'o3', einvoiceFrom: '2026-11-15' }, { id: 'o4', einvoiceFrom: '2026-10-31' },
      ]),
    })
    const r = await runJob(s, DAY1)
    expect(s.consolidate.mock.calls).toEqual([['o1', '2026-10'], ['o4', '2026-10']])
    expect(r.consolidated.map((l) => [l.key, l.outcome])).toEqual([['CON|o1|2026-10', 'issued'], ['CON|o4|2026-10', 'issued']])
    expect(runOutcome(r)).toBe('ok')
  })

  it('does not consolidate after the 7th', async () => {
    const s = steps({ outlets: vi.fn(async () => [{ id: 'o1', einvoiceFrom: '2026-10-01' }]) })
    await runJob(s, DAY8)
    expect(s.outlets).not.toHaveBeenCalled()
    expect(s.consolidate).not.toHaveBeenCalled()
  })

  it('stops after 3 failed attempts and says so', async () => {
    const s = steps({ outlets: vi.fn(async () => [{ id: 'o1', einvoiceFrom: '2026-10-01' }]) })
    s.failuresMap.set('CON|o1|2026-10', MAX_ATTEMPTS)
    const r = await runJob(s, DAY1)
    expect(s.consolidate).not.toHaveBeenCalled()
    expect(r.consolidated).toEqual([{ key: 'CON|o1|2026-10', outcome: 'stopped' }])
    expect(runOutcome(r)).toBe('errors')
  })

  it('counts a refusal, a rejection or a throw; a later success resets the count', async () => {
    const results: (StepResult | Error)[] = [
      { outcome: 'refused', error: 'The document adds up to 1 sen, the bills are 2 sen' },
      { outcome: 'rejected', codeNumber: 'CON-2', status: 'rejected', error: 'TIN' },
      new Error('network down'),
      issued('CON-3'),
    ]
    const s = steps({
      outlets: vi.fn(async () => [{ id: 'o1', einvoiceFrom: '2026-10-01' }]),
      consolidate: vi.fn(async () => {
        const next = results.shift()!
        if (next instanceof Error) throw next
        return next
      }),
    })
    const seen: number[] = []
    for (let i = 0; i < 4; i++) {
      s.failuresMap.set('CON|o1|2026-10', Math.min(s.failuresMap.get('CON|o1|2026-10') ?? 0, 2))   // stay under the stop
      await runJob(s, DAY1)
      seen.push(s.failuresMap.get('CON|o1|2026-10') ?? 0)
    }
    expect(seen).toEqual([1, 2, 3, 0])
    expect(s.record).toHaveBeenLastCalledWith(conRef('o1', '2026-10'), true, null)
  })

  it('leaves a document that is still on its way (waiting) or a month with nothing left uncounted', async () => {
    const s = steps({
      outlets: vi.fn(async () => [{ id: 'o1', einvoiceFrom: '2026-10-01' }, { id: 'o2', einvoiceFrom: '2026-10-01' }]),
      consolidate: vi.fn(async (id: string): Promise<StepResult> =>
        id === 'o1' ? { outcome: 'waiting', codeNumber: 'CON-1', status: 'draft' } : { outcome: 'nothing' }),
    })
    const r = await runJob(s, DAY1)
    expect(s.record).not.toHaveBeenCalled()
    expect(runOutcome(r)).toBe('ok')
  })

  it('issues the credit notes due every day: single ones, then each past month of consolidated refunds', async () => {
    const s = steps({
      singleRefunds: vi.fn(async () => [refund()]),
      refundMonths: vi.fn(async () => [{ branchId: 'o1', month: '2026-10' }]),
    })
    const r = await runJob(s, DAY8)
    expect(s.creditNote).toHaveBeenCalledWith(refund())
    expect(s.refundMonths).toHaveBeenCalledWith('2026-11-01')
    expect(s.consolidatedCreditNote).toHaveBeenCalledWith('o1', '2026-10')
    expect(r.creditNotes.map((l) => [l.key, l.outcome])).toEqual([['CN|r1', 'issued'], ['CCN|o1|2026-10', 'issued']])
  })

  it('keeps going when a step cannot even list its work', async () => {
    const s = steps({
      pendingDocuments: vi.fn(async () => { throw new Error('db down') }),
      singleRefunds: vi.fn(async () => { throw new Error('db down') }),
    })
    const r = await runJob(s, DAY1)
    expect(r.errors).toEqual(['Pending documents: db down', 'Credit notes: db down'])
    expect(runOutcome(r)).toBe('errors')
  })
})

describe('runCreditNotes with force (the screen’s Retry)', () => {
  it('tries a stopped credit note again', async () => {
    const s = steps({ singleRefunds: vi.fn(async () => [refund()]) })
    s.failuresMap.set('CN|r1', MAX_ATTEMPTS)
    const r = emptyReport('2026-11-08')
    await runCreditNotes(s, r, r.businessDay, true)
    expect(s.creditNote).toHaveBeenCalledTimes(1)
    expect(s.record).toHaveBeenCalledWith(cnRef('o1', 'r1'), true, null)
  })
})
