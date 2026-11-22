import { describe, expect, it, vi } from 'vitest'
import {
  businessDay, ccnRef, cnRef, conRef, emptyReport, isLhdnErrorBody, isRealDay, jobSecretMatches, MAX_ATTEMPTS,
  MAX_CONSOLIDATIONS_PER_RUN, monthEnd, previousMonth, refOfDocument, refreshVerdict, runCreditNotes, runJob, runOutcome,
  sendDraft, submitFailureVerdict, type JobSteps, type SendPorts, type SubmitReply, type PendingDoc, type StepResult,
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
    unreportedMonths: vi.fn(async () => [] as { branchId: string; month: string }[]),
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
  it('knows months and real days', () => {
    expect(previousMonth('2026-11')).toBe('2026-10')
    expect(previousMonth('2026-01')).toBe('2025-12')
    expect(monthEnd('2026-02')).toBe('2026-02-28')
    expect(monthEnd('2028-02')).toBe('2028-02-29')
    expect(isRealDay('2026-02-28')).toBe(true)
    expect(isRealDay('2026-02-30')).toBe(false)
    expect(isRealDay('2026-13-01')).toBe(false)     // was a RangeError (500) in reconcile
    expect(isRealDay('2026-00-10')).toBe(false)
    expect(isRealDay('2026-1-01')).toBe(false)
    expect(isRealDay(20261101)).toBe(false)
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
    const d = (kind: string, periodStart: string | null, refundId: string | null = null): PendingDoc =>
      ({ id: 'd', codeNumber: 'X', kind, branchId: 'o1', periodStart, status: 'submitted', refundId })
    expect(refOfDocument(d('consolidated_invoice', '2026-10-01'))?.key).toBe('CON|o1|2026-10')
    expect(refOfDocument(d('consolidated_credit_note', '2026-10-15'))?.key).toBe('CCN|o1|2026-10')
    expect(refOfDocument(d('invoice', null))).toBeNull()
    expect(refOfDocument(d('credit_note', null, 'r1'))).toEqual(cnRef('o1', 'r1'))   // counts against its refund
    expect(refOfDocument(d('credit_note', null))).toBeNull()
  })
})

describe('runJob', () => {
  it('records "not set up" and calls nothing else', async () => {
    const s = steps({ setUp: vi.fn(async () => ({ ok: false as const, reason: 'MyInvois credentials are not set' })) })
    const r = await runJob(s, DAY1)
    expect(r).toMatchObject({ businessDay: '2026-11-01', setUp: false, notSetUp: 'MyInvois credentials are not set' })
    expect(runOutcome(r)).toBe('not_set_up')
    for (const f of [s.pendingDocuments, s.unreportedMonths, s.consolidate, s.singleRefunds, s.refundMonths]) expect(f).not.toHaveBeenCalled()
  })

  it('refreshes waiting documents first and counts an invalid consolidated invoice as a failed attempt', async () => {
    const docs: PendingDoc[] = [
      { id: 'd1', codeNumber: 'CON-1', kind: 'consolidated_invoice', branchId: 'o1', periodStart: '2026-10-01', status: 'submitted', refundId: null },
      { id: 'd2', codeNumber: 'INV-1', kind: 'invoice', branchId: 'o1', periodStart: null, status: 'submitted', refundId: null },
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

  it('consolidates every unreported closed month, oldest first', async () => {
    const s = steps({
      unreportedMonths: vi.fn(async () => [
        { branchId: 'o4', month: '2026-10' }, { branchId: 'o1', month: '2026-10' }, { branchId: 'o1', month: '2026-08' },
      ]),
    })
    const r = await runJob(s, DAY1)
    expect(s.consolidate.mock.calls).toEqual([['o1', '2026-08'], ['o1', '2026-10'], ['o4', '2026-10']])
    expect(r.consolidated.map((l) => [l.key, l.outcome]))
      .toEqual([['CON|o1|2026-08', 'issued'], ['CON|o1|2026-10', 'issued'], ['CON|o4|2026-10', 'issued']])
    expect(runOutcome(r)).toBe('ok')
  })

  it('catches up a missed month after the 7th too', async () => {
    const s = steps({ unreportedMonths: vi.fn(async () => [{ branchId: 'o1', month: '2026-10' }]) })
    await runJob(s, DAY8)
    expect(s.consolidate.mock.calls).toEqual([['o1', '2026-10']])
  })

  it(`tries at most ${MAX_CONSOLIDATIONS_PER_RUN} outlet-months per run and reports the rest as later; a stopped one costs no try`, async () => {
    const months = Array.from({ length: 9 }, (_, i) => ({ branchId: 'o1', month: `2026-0${i + 1}` }))
    const s = steps({ unreportedMonths: vi.fn(async () => months) })
    s.failuresMap.set('CON|o1|2026-02', MAX_ATTEMPTS)
    const r = await runJob(s, DAY8)
    expect(s.consolidate).toHaveBeenCalledTimes(MAX_CONSOLIDATIONS_PER_RUN)
    expect(r.consolidated.map((l) => l.outcome))
      .toEqual(['issued', 'stopped', 'issued', 'issued', 'issued', 'issued', 'issued', 'later', 'later'])
    expect(r.consolidated.slice(-2).map((l) => l.key)).toEqual(['CON|o1|2026-08', 'CON|o1|2026-09'])
  })

  it('a database error on one outlet-month is reported and the rest still run', async () => {
    const s = steps({
      unreportedMonths: vi.fn(async () => [{ branchId: 'o1', month: '2026-09' }, { branchId: 'o2', month: '2026-10' }]),
      failures: vi.fn(async (key: string) => { if (key === 'CON|o1|2026-09') throw new Error('db hiccup'); return 0 }),
      singleRefunds: vi.fn(async () => [refund({ refundId: 'r1' }), refund({ refundId: 'r2' })]),
      record: vi.fn(async () => { throw new Error('record failed') }),
      creditNote: vi.fn(async (x: PendingRefund): Promise<StepResult> =>
        x.refundId === 'r1' ? { outcome: 'refused', error: 'no' } : issued('CN-2')),
    })
    const r = await runJob(s, DAY8)
    expect(s.consolidate.mock.calls).toEqual([['o2', '2026-10']])
    expect(s.creditNote).toHaveBeenCalledTimes(2)
    expect(r.errors).toEqual(['CON|o1|2026-09: db hiccup', 'CN|r1: record failed'])
    expect(r.consolidated.map((l) => l.key)).toEqual(['CON|o2|2026-10'])
    expect(r.creditNotes.map((l) => l.key)).toEqual(['CN|r2'])
    expect(runOutcome(r)).toBe('errors')
  })

  it('stops after 3 failed attempts and says so', async () => {
    const s = steps({ unreportedMonths: vi.fn(async () => [{ branchId: 'o1', month: '2026-10' }]) })
    s.failuresMap.set('CON|o1|2026-10', MAX_ATTEMPTS)
    const r = await runJob(s, DAY1)
    expect(s.consolidate).not.toHaveBeenCalled()
    expect(r.consolidated).toEqual([{ key: 'CON|o1|2026-10', outcome: 'stopped' }])
    expect(runOutcome(r)).toBe('errors')
  })

  it('counts a refusal, a rejection or a throw; a document found valid resets the count', async () => {
    const results: (StepResult | Error)[] = [
      { outcome: 'refused', error: 'The document adds up to 1 sen, the bills are 2 sen' },
      { outcome: 'rejected', codeNumber: 'CON-2', status: 'rejected', error: 'TIN' },
      new Error('network down'),
      { outcome: 'issued', codeNumber: 'CON-3', status: 'valid' },
    ]
    const s = steps({
      unreportedMonths: vi.fn(async () => [{ branchId: 'o1', month: '2026-10' }]),
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

  it('a submitted document does not reset the count (it may still turn invalid); a refresh finding it valid does', async () => {
    const s = steps({ unreportedMonths: vi.fn(async () => [{ branchId: 'o1', month: '2026-10' }]) })
    s.failuresMap.set('CON|o1|2026-10', 2)
    await runJob(s, DAY8)
    expect(s.failuresMap.get('CON|o1|2026-10')).toBe(2)
    const doc: PendingDoc = { id: 'd1', codeNumber: 'CON-1', kind: 'consolidated_invoice', branchId: 'o1', periodStart: '2026-10-01', status: 'submitted', refundId: null }
    const t = steps({ pendingDocuments: vi.fn(async () => [doc]), refresh: vi.fn(async () => ({ status: 'valid' })) })
    t.failuresMap.set('CON|o1|2026-10', 2)
    await runJob(t, DAY8)
    expect(t.record).toHaveBeenCalledWith(conRef('o1', '2026-10'), true, null)
    expect(t.failuresMap.get('CON|o1|2026-10')).toBe(0)
  })

  it('a single credit note LHDN keeps finding invalid is re-issued at most until its refund has 3 failures', async () => {
    // each day: the refresh finds yesterday's credit note invalid (its refund link released), then the refund is due again
    let live: PendingDoc | null = null
    let n = 0
    const s = steps({
      pendingDocuments: vi.fn(async () => (live ? [live] : [])),
      refresh: vi.fn(async () => { live = null; return { status: 'invalid' } }),
      singleRefunds: vi.fn(async () => (live ? [] : [refund()])),
      creditNote: vi.fn(async (): Promise<StepResult> => {
        n++
        live = { id: `cn${n}`, codeNumber: `CN-${n}`, kind: 'credit_note', branchId: 'o1', periodStart: null, status: 'submitted', refundId: 'r1' }
        return issued(`CN-${n}`)
      }),
    })
    const outcomes: string[] = []
    for (let day = 0; day < 6; day++) {
      const r = await runJob(s, new Date(DAY8.getTime() + day * 86_400_000))
      outcomes.push(r.creditNotes.map((l) => l.outcome).join(','))
    }
    expect(s.creditNote).toHaveBeenCalledTimes(3)
    expect(s.failuresMap.get('CN|r1')).toBe(3)
    expect(outcomes).toEqual(['issued', 'issued', 'issued', 'stopped', 'stopped', 'stopped'])
  })

  it('leaves a document that is still on its way (waiting) or a month with nothing left uncounted', async () => {
    const s = steps({
      unreportedMonths: vi.fn(async () => [{ branchId: 'o1', month: '2026-10' }, { branchId: 'o2', month: '2026-10' }]),
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
    expect(r.creditNotes).toEqual([{ key: 'CN|r1', outcome: 'issued', codeNumber: 'CN-1', status: 'submitted' }])
    expect(s.record).toHaveBeenCalledWith(cnRef('o1', 'r1'), true, null)   // the owner's Retry clears the stop
  })
  it('the daily run (no force) leaves the count of a submitted credit note for LHDN\'s verdict', async () => {
    const s = steps({ singleRefunds: vi.fn(async () => [refund()]) })
    s.failuresMap.set('CN|r1', 2)
    const r = emptyReport('2026-11-08')
    await runCreditNotes(s, r, r.businessDay)
    expect(s.record).not.toHaveBeenCalled()
  })
})

describe('reading LHDN\'s verdict', () => {
  it('cancels only on Cancelled; any status we do not know is a check, never a release', () => {
    expect(refreshVerdict('Submitted')).toBe('waiting')
    expect(refreshVerdict('Valid')).toBe('valid')
    expect(refreshVerdict('Invalid')).toBe('invalid')
    expect(refreshVerdict('Cancelled')).toBe('cancelled')
    for (const odd of ['Rejected', 'cancelled', 'Processing', '', null, undefined, 3]) expect(refreshVerdict(odd)).toBe('unexpected')
  })
})

describe('sending a draft once', () => {
  const err = (status: number, body: unknown = { error: 'x' }) => Object.assign(new Error('x'), { status, body })
  it('classifies a failed submit', () => {
    expect(submitFailureVerdict(Object.assign(new Error('no token'), { notSent: true }))).toBe('release')
    expect(submitFailureVerdict(err(429))).toBe('release')
    expect(submitFailureVerdict(err(503))).toBe('release')
    expect(submitFailureVerdict(err(401))).toBe('release')
    expect(submitFailureVerdict(err(422))).toBe('needs_check')
    expect(submitFailureVerdict(err(400))).toBe('rejected')
    expect(submitFailureVerdict(err(400, null))).toBe('needs_check')     // a bodiless 4xx: proxy, firewall, 408
    expect(submitFailureVerdict(err(408, null))).toBe('needs_check')
    expect(submitFailureVerdict(err(400, { error: { code: 'BadStructure', message: 'x' } }))).toBe('rejected')
    expect(submitFailureVerdict(err(403, { code: 'IncorrectSubmitter' }))).toBe('rejected')
    expect(submitFailureVerdict(err(403, '<html>Forbidden</html>'))).toBe('needs_check')   // a gateway's page, not LHDN
    expect(submitFailureVerdict(err(404, { message: 'no Route matched' }))).toBe('needs_check')
    expect(submitFailureVerdict(err(400, [{ error: 'x' }]))).toBe('needs_check')
    expect(submitFailureVerdict(err(400, { code: 'SomethingElse' }))).toBe('needs_check')
    expect(submitFailureVerdict(err(500))).toBe('needs_check')
    expect(submitFailureVerdict(new TypeError('network'))).toBe('needs_check')
    expect(submitFailureVerdict(null)).toBe('needs_check')
  })

  const reply = (over: Partial<SubmitReply> = {}): SubmitReply =>
    ({ submissionUid: 'S1', accepted: [{ uuid: 'U1', codeNumber: 'CON-1' }], rejected: [], ...over })
  function ports(o: { claim?: boolean; submit?: () => Promise<SubmitReply>; failOn?: string[] } = {}) {
    const calls: string[] = []
    const step = (name: string) => async () => {
      calls.push(name)
      if (o.failOn?.includes(name)) throw new Error(`${name} failed`)
      return name
    }
    const p: SendPorts<string> = {
      claim: async () => { calls.push('claim'); return o.claim ?? true },
      lost: step('lost'),
      submit: async () => { calls.push('submit'); return (o.submit ?? (async () => reply()))() },
      markSubmitted: step('markSubmitted'),
      markRejected: step('markRejected'),
      releaseLinks: async () => { calls.push('releaseLinks') },
      markNeedsCheck: step('markNeedsCheck'),
      clearClaim: step('clearClaim'),
    }
    return { p, calls }
  }

  it('a second send of the same draft does not call submit', async () => {
    const { p, calls } = ports({ claim: false })
    expect(await sendDraft('CON-1', p)).toBe('lost')
    expect(calls).toEqual(['claim', 'lost'])
  })

  it('accepted: submitted with the uuid, links kept', async () => {
    const { p, calls } = ports()
    expect(await sendDraft('CON-1', p)).toBe('markSubmitted')
    expect(calls).toEqual(['claim', 'submit', 'markSubmitted'])
  })

  it('LHDN names a rejection: status saved before the links are released; a failed save releases nothing', async () => {
    const rej = () => Promise.resolve(reply({ accepted: [], rejected: [{ codeNumber: 'CON-1', error: 'bad' }] }))
    const ok = ports({ submit: rej })
    await sendDraft('CON-1', ok.p)
    expect(ok.calls).toEqual(['claim', 'submit', 'markRejected', 'releaseLinks'])
    const bad = ports({ submit: rej, failOn: ['markRejected'] })
    await expect(sendDraft('CON-1', bad.p)).rejects.toThrow('markRejected failed')
    expect(bad.calls).not.toContain('releaseLinks')
    expect(bad.calls).not.toContain('clearClaim')
  })

  it('a clear 4xx with a body rejects in the same order', async () => {
    const t = ports({ submit: () => Promise.reject(err(400)) })
    await sendDraft('CON-1', t.p)
    expect(t.calls).toEqual(['claim', 'submit', 'markRejected', 'releaseLinks'])
  })

  it('422, 5xx, a network error, a bodiless 4xx or an unnamed answer: needs_check, links kept', async () => {
    for (const failure of [err(422), err(500), new TypeError('network'), err(400, null)]) {
      const t = ports({ submit: () => Promise.reject(failure) })
      expect(await sendDraft('CON-1', t.p)).toBe('markNeedsCheck')
      expect(t.calls).toEqual(['claim', 'submit', 'markNeedsCheck'])
    }
    const t = ports({ submit: () => Promise.resolve(reply({ accepted: [] })) })
    expect(await sendDraft('CON-1', t.p)).toBe('markNeedsCheck')
  })

  it('429, 503, 401 and a token failure clear the claim', async () => {
    for (const failure of [err(429), err(503), err(401), Object.assign(new Error('token'), { notSent: true })]) {
      const t = ports({ submit: () => Promise.reject(failure) })
      expect(await sendDraft('CON-1', t.p)).toBe('clearClaim')
      expect(t.calls).toEqual(['claim', 'submit', 'clearClaim'])
    }
  })

  it('LHDN\'s error envelope: an object with an error field, or a known LHDN code', () => {
    expect(isLhdnErrorBody({ error: 'x' })).toBe(true)
    expect(isLhdnErrorBody({ error: { details: [] } })).toBe(true)
    expect(isLhdnErrorBody({ code: 'MaximumSizeExceeded' })).toBe(true)
    expect(isLhdnErrorBody({ error: null, message: 'x' })).toBe(false)
    expect(isLhdnErrorBody('error')).toBe(false)
    expect(isLhdnErrorBody(null)).toBe(false)
  })

  it('accepted without a submission id: needs a check, never submitted', async () => {
    const t = ports({ submit: () => Promise.resolve(reply({ submissionUid: null })) })
    expect(await sendDraft('CON-1', t.p)).toBe('markNeedsCheck')
    expect(t.calls).toEqual(['claim', 'submit', 'markNeedsCheck'])
  })

  it('accepted but the save fails: retried once, then an error carrying LHDN identifiers, no release, no clear', async () => {
    const t = ports({ failOn: ['markSubmitted'] })
    await expect(sendDraft('CON-1', t.p)).rejects.toThrow(/uuid U1, submission S1/)
    expect(t.calls).toEqual(['claim', 'submit', 'markSubmitted', 'markSubmitted'])
  })
})
