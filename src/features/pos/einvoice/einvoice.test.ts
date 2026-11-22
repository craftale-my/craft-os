import { describe, expect, it } from 'vitest'
import {
  bannerMessages, buyerPayload, checkBuyer, checkSettings, cleanSettings, emptyBuyer, errorText, hasLiveDocument, isNeedsCheck, needsCheckDocs,
  isUnexpectedStatus, isWaitingToResend, openProblems, overdueMonths, retryFor, retryForAttempt, retryForMonth, runSummary,
  START_DATE_LOCKED, startDateProblem, unreportedLabel,
  type Attempt, type BannerInput, type EinvoiceDoc, type JobRun, type SettingsForm, type UnreportedMonth,
} from './einvoice'

const filled: SettingsForm = {
  supplier_name: 'Craftale Sdn Bhd', supplier_tin: 'c12345678090', supplier_brn: '2019 0101 2345',
  supplier_sst_no: '', supplier_ttx_no: '', msic_code: '56101', business_activity: 'Cafe',
  address_line: '1 Jalan Kepong', city: 'Kuala Lumpur', postcode: '52100', state_code: '14',
  phone: '+60 12-345 6789', email: '',
}

describe('cleanSettings', () => {
  it('trims, upper-cases the TIN, strips BRN spacing and turns blank SST/TTx into NA', () => {
    const c = cleanSettings(filled)
    expect(c.supplier_tin).toBe('C12345678090')
    expect(c.supplier_brn).toBe('201901012345')
    expect(c.supplier_sst_no).toBe('NA')
    expect(c.supplier_ttx_no).toBe('NA')
    expect(c.phone).toBe('+60123456789')
    expect(c.email).toBeNull()
  })
})

describe('checkSettings', () => {
  it('passes a complete company', () => {
    expect(checkSettings(cleanSettings(filled))).toEqual({})
  })

  it('names every required field that is blank', () => {
    const errs = checkSettings(cleanSettings({ ...filled, supplier_name: ' ', city: '', phone: '' }))
    expect(Object.keys(errs).sort()).toEqual(['city', 'phone', 'supplier_name'])
  })

  it('rejects malformed TIN, BRN, MSIC, state and postcode', () => {
    const errs = checkSettings(cleanSettings({
      ...filled, supplier_tin: '12345', supplier_brn: '1234567-A', msic_code: '5610', state_code: '18', postcode: '521',
    }))
    expect(Object.keys(errs).sort()).toEqual(['msic_code', 'postcode', 'state_code', 'supplier_brn', 'supplier_tin'])
  })
})

const doc = (over: Partial<EinvoiceDoc>): EinvoiceDoc => ({
  id: 'd1', kind: 'consolidated_invoice', environment: 'sandbox', branch_id: 'b1', code_number: 'CON-1',
  bill_id: null, period_start: '2026-09-01', period_end: '2026-09-30', buyer: null, total_sen: 100,
  status: 'valid', errors: null, created_at: '2026-10-01T00:00:00Z', lhdn_uuid: null, long_id: null,
  ...over,
})

describe('openProblems', () => {
  it('flags a rejected document that nothing replaced', () => {
    expect(openProblems([doc({ status: 'rejected' })]).map((d) => d.id)).toEqual(['d1'])
  })

  it('clears a rejected month once a later document for the same branch and month exists', () => {
    const docs = [
      doc({ id: 'old', status: 'rejected', created_at: '2026-10-01T00:00:00Z' }),
      doc({ id: 'new', status: 'submitted', created_at: '2026-10-02T00:00:00Z' }),
    ]
    expect(openProblems(docs)).toEqual([])
  })

  it('keeps branches and months apart', () => {
    const docs = [
      doc({ id: 'a', status: 'invalid' }),
      doc({ id: 'b', branch_id: 'b2', status: 'valid', created_at: '2026-10-05T00:00:00Z' }),
      doc({ id: 'c', period_start: '2026-08-01', status: 'valid', created_at: '2026-10-05T00:00:00Z' }),
    ]
    expect(openProblems(docs).map((d) => d.id)).toEqual(['a'])
  })

  it('groups single invoices by bill', () => {
    const docs = [
      doc({ id: 'x', kind: 'invoice', bill_id: 'bill1', period_start: null, status: 'rejected' }),
      doc({ id: 'y', kind: 'invoice', bill_id: 'bill2', period_start: null, status: 'valid', created_at: '2026-10-09T00:00:00Z' }),
    ]
    expect(openProblems(docs).map((d) => d.id)).toEqual(['x'])
  })

  it('never flags a draft as not accepted: one LHDN did not take waits to be sent again', () => {
    const waiting = doc({ status: 'draft', errors: { message: 'MyInvois POST → 503' }, needs_check: false, send_started_at: null })
    expect(openProblems([waiting])).toEqual([])
    expect(isWaitingToResend(waiting)).toBe(true)
    expect(isWaitingToResend(doc({ status: 'draft', errors: null }))).toBe(false)
    expect(isWaitingToResend({ ...waiting, send_started_at: '2026-11-01T00:00:00Z' })).toBe(false)   // being sent
    expect(isWaitingToResend({ ...waiting, needs_check: true })).toBe(false)
    expect(openProblems([doc({ status: 'draft', errors: null })])).toEqual([])
    expect(bannerMessages(quiet({ docs: [waiting] }))).toEqual([])
  })
})

describe('retryFor', () => {
  it('resends a draft and asks LHDN about a submitted document', () => {
    expect(retryFor(doc({ status: 'draft' }))).toEqual({ label: 'Resend', body: { action: 'refresh', documentId: 'd1' } })
    expect(retryFor(doc({ status: 'submitted' }))).toEqual({ label: 'Check with LHDN', body: { action: 'refresh', documentId: 'd1' } })
  })

  it('re-consolidates a rejected month for the same branch', () => {
    expect(retryFor(doc({ status: 'rejected' }))).toEqual({
      label: 'Retry', body: { action: 'consolidate', branchId: 'b1', month: '2026-09' },
    })
  })

  it('re-submits a rejected single invoice with its buyer', () => {
    const buyer = { name: 'Acme', tin: 'C1' }
    expect(retryFor(doc({ kind: 'invoice', bill_id: 'bill1', period_start: null, status: 'invalid', buyer }))).toEqual({
      label: 'Retry', body: { action: 'submit_bill', billId: 'bill1', buyer },
    })
  })

  it('offers nothing for a valid or cancelled document', () => {
    expect(retryFor(doc({ status: 'valid' }))).toBeNull()
    expect(retryFor(doc({ status: 'cancelled' }))).toBeNull()
  })

  it('issues the credit notes due again for a rejected credit note', () => {
    expect(retryFor(doc({ kind: 'consolidated_credit_note', status: 'rejected' }))).toEqual({ label: 'Retry', body: { action: 'credit_notes' } })
    expect(retryFor(doc({ kind: 'credit_note', bill_id: 'bill1', period_start: null, status: 'invalid' })))
      .toEqual({ label: 'Retry', body: { action: 'credit_notes' } })
  })
})

describe('errorText', () => {
  it('pulls readable messages out of nested LHDN errors', () => {
    expect(errorText([{ error: { details: [{ message: 'TIN does not match BRN' }] } }])).toBe('TIN does not match BRN')
    expect(errorText({ message: 'network down' })).toBe('network down')
    expect(errorText(null)).toBe('')
  })
})

describe('startDateProblem', () => {
  it('lets a start date be set, moved later or cleared while nothing was sent', () => {
    expect(startDateProblem('2026-12-01', null, false)).toBeNull()
    expect(startDateProblem('2026-12-15', '2026-12-01', true)).toBeNull()
    expect(startDateProblem('', '2026-12-01', false)).toBeNull()
    expect(startDateProblem('2026-11-01', '2026-12-01', false)).toBeNull()
  })
  it('refuses earlier or cleared once e-invoices were sent, and a malformed date', () => {
    expect(startDateProblem('2026-11-01', '2026-12-01', true)).toBe(START_DATE_LOCKED)
    expect(startDateProblem('', '2026-12-01', true)).toBe(START_DATE_LOCKED)
    expect(startDateProblem('1/12/2026', null, false)).toBe('Pick a date')
  })
  it('counts draft, submitted and valid documents as sent', () => {
    expect(hasLiveDocument([doc({ status: 'draft' })], 'b1')).toBe(true)
    expect(hasLiveDocument([doc({ status: 'rejected' }), doc({ status: 'valid', branch_id: 'b2' })], 'b1')).toBe(false)
  })
})

describe('the buyer form', () => {
  const filledBuyer = {
    ...emptyBuyer(), name: ' Acme Catering Sdn Bhd ', tin: 'c 9876543210', idValue: '2019-0101-2345',
    phone: '+60 12-345 6789', postcode: '52100', stateCode: '14',
  }
  it('cleans what submit_bill reads', () => {
    expect(buyerPayload(filledBuyer)).toEqual({
      name: 'Acme Catering Sdn Bhd', tin: 'C9876543210', idType: 'BRN', idValue: '201901012345',
      email: undefined, phone: '+60123456789',
      address: { line: undefined, city: undefined, postcode: '52100', stateCode: '14' },
    })
  })
  it('needs a name, a TIN and an ID number', () => {
    expect(checkBuyer(filledBuyer)).toEqual({})
    expect(Object.keys(checkBuyer(emptyBuyer())).sort()).toEqual(['idValue', 'name', 'tin'])
    expect(checkBuyer({ ...filledBuyer, tin: '123', email: 'nope', postcode: '1' })).toEqual({
      tin: 'A TIN looks like C12345678090 or IG12345678901', email: 'Not an email address', postcode: 'Postcode is 5 digits',
    })
  })
})

const quiet = (over: Partial<BannerInput> = {}): BannerInput => ({
  docs: [], stopped: [], largeBills: [], lastRun: null, unreported: [], outlets: [], now: new Date('2026-11-23T04:00:00Z'), ...over,
})

describe('runSummary', () => {
  const run = (over: Partial<JobRun>): JobRun => ({
    id: 'j1', started_at: '2026-11-01T23:00:05Z', environment: 'sandbox', outcome: 'ok',
    report: { setUp: true, refreshed: [], consolidated: [], creditNotes: [], errors: [] }, ...over,
  })
  it('says why nothing was sent', () => {
    expect(runSummary(run({ outcome: 'not_set_up', report: { setUp: false, notSetUp: 'MyInvois credentials are not set' } })))
      .toBe('Not set up — nothing sent (MyInvois credentials are not set)')
  })
  it('counts what was checked and sent, and the problems', () => {
    expect(runSummary(run({
      outcome: 'errors',
      report: {
        setUp: true, refreshed: [{ codeNumber: 'CON-1', status: 'valid' }],
        consolidated: [{ key: 'CON|o1|2026-10', outcome: 'issued' }, { key: 'CON|o2|2026-10', outcome: 'stopped' }],
        creditNotes: [{ key: 'CN|r1', outcome: 'issued' }], errors: ['x'],
      },
    }))).toBe('1 checked with LHDN · 1 monthly sent · 1 credit note sent · 2 problems')
  })
  it('counts the months left for the next run', () => {
    expect(runSummary(run({
      report: { setUp: true, consolidated: [{ key: 'CON|o1|2026-01', outcome: 'issued' }, { key: 'CON|o1|2026-02', outcome: 'later' }] },
    }))).toBe('0 checked with LHDN · 1 monthly sent · 0 credit notes sent · 1 month left for the next run')
  })
  it('shows a running run, and one that never finished', () => {
    const started = '2026-11-22T23:00:00Z'
    expect(runSummary(run({ outcome: 'running', started_at: started, finished_at: null }), new Date('2026-11-22T23:05:00Z')))
      .toBe('Running…')
    expect(runSummary(run({ outcome: 'running', started_at: started, finished_at: null }), new Date('2026-11-23T01:00:00Z')))
      .toBe('Did not finish — it stopped before saving what it did')
  })
})

describe('stopped attempts and the banner', () => {
  const attempt = (over: Partial<Attempt>): Attempt => ({
    key: 'CON|b1|2026-10', kind: 'consolidated_invoice', branch_id: 'b1', period_start: '2026-10-01', refund_id: null,
    failures: 3, last_error: 'TIN', updated_at: '2026-11-03T23:00:00Z', ...over,
  })
  it('retries a stopped month by consolidating it, a stopped credit note by issuing what is due', () => {
    expect(retryForAttempt(attempt({}))).toEqual({ label: 'Retry', body: { action: 'consolidate', branchId: 'b1', month: '2026-10' } })
    expect(retryForAttempt(attempt({ kind: 'credit_note', period_start: null, refund_id: 'r1' })))
      .toEqual({ label: 'Retry', body: { action: 'credit_notes' } })
  })
  it('shows each W5.7 case, and the not-set-up one only in production', () => {
    const notSetUp = (environment: 'sandbox' | 'production'): JobRun => ({
      id: 'j', started_at: '2026-11-01T23:00:00Z', environment, outcome: 'not_set_up', report: { setUp: false },
    })
    expect(bannerMessages(quiet({ lastRun: notSetUp('sandbox') }))).toEqual([])
    expect(bannerMessages(quiet({
      docs: [doc({ status: 'rejected' })],
      stopped: [attempt({}), attempt({ key: 'CN|r1', kind: 'credit_note', failures: 2 })],
      largeBills: [{ id: 'x', branch_id: 'b1', bill_no: '261010-001', day: '2026-10-10', total_sen: 1100000 }],
      lastRun: notSetUp('production'),
      now: new Date('2026-11-02T00:00:00Z'),
    }))).toEqual([
      'LHDN did not accept an e-invoice.',
      'An e-invoice run stopped after 3 failed attempts.',
      "A bill over RM 10,000 needs the buyer's details for an individual e-invoice.",
      'E-invoicing is not set up: nothing is being sent to LHDN.',
    ])
  })
})

describe('needs-check drafts', () => {
  const nc = (over: Partial<EinvoiceDoc> = {}) => doc({ status: 'draft', needs_check: true, errors: 'LHDN did not answer', ...over })
  it('are not rejections, and are listed separately', () => {
    expect(isNeedsCheck(nc())).toBe(true)
    expect(isNeedsCheck(doc({ status: 'draft', needs_check: false }))).toBe(false)
    expect(openProblems([nc()])).toEqual([])
    expect(needsCheckDocs([nc(), doc({ id: 'ok', branch_id: 'b2' })]).map((d) => d.id)).toEqual(['d1'])
  })
  it('clear once a later document covers the same month', () => {
    expect(needsCheckDocs([nc(), doc({ id: 'n', status: 'submitted', created_at: '2026-10-02T00:00:00Z' })])).toEqual([])
  })
  it('Send again calls resend, not refresh', () => {
    expect(retryFor(nc())).toEqual({ label: 'Send again', body: { action: 'resend', documentId: 'd1' } })
  })
  it('adds a fifth banner case', () => {
    expect(bannerMessages(quiet({ docs: [nc()] }))).toEqual(['An e-invoice needs checking in the MyInvois portal.'])
  })
})

describe('a submitted document with an unexpected LHDN status', () => {
  const odd = doc({ status: 'submitted', needs_check: true, errors: { message: 'LHDN reports an unexpected status: Frozen' } })
  it('is a check in the portal, not a rejection, and is never sent again', () => {
    expect(isUnexpectedStatus(odd)).toBe(true)
    expect(isNeedsCheck(odd)).toBe(false)
    expect(openProblems([odd])).toEqual([])
    expect(needsCheckDocs([odd]).map((d) => d.id)).toEqual(['d1'])
    expect(retryFor(odd)?.label).toBe('Check with LHDN')
    expect(bannerMessages(quiet({ docs: [odd] }))).toEqual(['An e-invoice needs checking in the MyInvois portal.'])
  })
})

describe('closed months not reported yet', () => {
  const oct: UnreportedMonth = { branch_id: 'b1', month: '2026-10-01', bills: 212, total_sen: 1234550 }
  const run = (started_at: string): JobRun => ({ id: 'j', started_at, environment: 'sandbox', outcome: 'ok', report: {} })
  it('labels a month and retries it by consolidating it', () => {
    expect(unreportedLabel(oct, 'Kepong')).toBe('Kepong · October 2026 · 212 bills · RM 12345.50')
    expect(unreportedLabel({ ...oct, bills: 1, total_sen: 1060 }, 'Kepong')).toBe('Kepong · October 2026 · 1 bill · RM 10.60')
    expect(retryForMonth(oct)).toEqual({ label: 'Retry', body: { action: 'consolidate', branchId: 'b1', month: '2026-10' } })
  })
  it('are overdue once a run started after the month closed (not between 06:00 and the 07:00 run on the 1st)', () => {
    expect(overdueMonths([oct], run('2026-10-31T23:00:00Z'))).toEqual([oct])   // 1 Nov 07:00 run
    expect(overdueMonths([oct], run('2026-10-30T23:00:00Z'))).toEqual([])      // 31 Oct 07:00: November's first run not yet
    expect(overdueMonths([oct], null)).toEqual([oct])
  })
  it('raise the banner', () => {
    expect(bannerMessages(quiet({ unreported: [oct], lastRun: run('2026-11-22T23:00:00Z'), outlets: [{ einvoice_from: '2026-10-01' }] })))
      .toEqual(["Some months' sales have not been reported to LHDN yet."])
  })
})

describe('the daily run not running', () => {
  const now = new Date('2026-11-23T04:00:00Z')
  const run = (started_at: string): JobRun => ({ id: 'j', started_at, environment: 'sandbox', outcome: 'ok', report: {} })
  const late = 'The daily e-invoice run has not run for 2 days.'
  it('raises the banner after 48 hours without a run, or with none, once an outlet has a start date', () => {
    const outlets = [{ einvoice_from: null }, { einvoice_from: '2026-11-01' }]
    expect(bannerMessages(quiet({ now, outlets, lastRun: run('2026-11-22T23:00:00Z') }))).toEqual([])
    expect(bannerMessages(quiet({ now, outlets, lastRun: run('2026-11-21T03:59:00Z') }))).toEqual([late])
    expect(bannerMessages(quiet({ now, outlets, lastRun: null }))).toEqual([late])
  })
  it('says nothing while no outlet is reported by us', () => {
    expect(bannerMessages(quiet({ now, outlets: [{ einvoice_from: null }], lastRun: null }))).toEqual([])
  })
})
