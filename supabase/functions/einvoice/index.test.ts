import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')

describe('einvoice Edge Function wiring', () => {
  it('lets only run and reconcile in on the job secret; every other action needs a login with access_settings', () => {
    expect(src).toContain("const job = body.action === 'run' || body.action === 'reconcile'")
    expect(src).toMatch(/if \(job\) \{\s*if \(!jobSecretMatches\(req\.headers\.get\('x-einvoice-job-secret'\), Deno\.env\.get\('EINVOICE_JOB_SECRET'\)\)\)/)
    expect(src).toContain("asCaller.rpc('has_menu_cap', { p_cap: 'access_settings' })")
    for (const a of ['status', 'submit_bill', 'consolidate', 'refresh', 'resend', 'credit_notes', 'run', 'reconcile']) {
      expect(src).toContain(`case '${a}':`)
    }
  })

  it('never creates a document it has not checked: every issue() takes a plan', () => {
    expect([...src.matchAll(/await issue\(/g)]).toHaveLength(4)
    expect([...src.matchAll(/plan\(\(\) => plan(Invoice|Consolidated|CreditNote|ConsolidatedCreditNote)\(/g)]).toHaveLength(4)
  })

  it('records every run and reads the start date before consolidating', () => {
    expect(src).toContain("admin.from('einvoice_job_runs').insert(")
    expect(src).toContain("select('id, einvoice_from')")
  })

  it('sends only through sendDraft (claim, then submit), and saves a status before releasing links', () => {
    expect([...src.matchAll(/client\.submit\(/g)]).toHaveLength(1)
    expect(src).toContain("admin.rpc('einvoice_claim_send'")
    expect(src).toContain("lt('send_started_at', cutoff)")
    expect(src).toContain('Reconcile at most 3 months at a time')
    expect(src).toContain('The request body must be a JSON object')
    expect(src).toContain('This document has no bills left; it cannot be sent again.')
    // every releaseLinks call comes after a status write in the same function
    for (const m of src.matchAll(/await releaseLinks\(admin, row\.id\)/g)) {
      const before = src.slice(Math.max(0, m.index! - 400), m.index)
      expect(before).toMatch(/markRejected\(|status: summary\.status === 'Invalid'/)
    }
  })
})
