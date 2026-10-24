import { describe, expect, it } from 'vitest'
import { branchFilter, branchIdFrom, isAgentJob, loginBranchProblem } from './branch.ts'

const DEMO = '0b6c2f3e-1d2a-4c5b-9e8f-7a6b5c4d3e2f'
const routes = new Map([['Bar', '192.168.0.8:9100'], ['Kitchen', '192.168.0.8:9100']])

describe('branchIdFrom — the agent refuses to start without its branch', () => {
  it('reads BRANCH_ID, trimmed and lower-cased', () => {
    expect(branchIdFrom({ BRANCH_ID: ` ${DEMO.toUpperCase()} ` })).toBe(DEMO)
  })
  it('throws when it is missing or not a uuid', () => {
    expect(() => branchIdFrom({})).toThrow('Missing BRANCH_ID in tools/print-agent/.env')
    expect(() => branchIdFrom({ BRANCH_ID: '  ' })).toThrow('Missing BRANCH_ID in tools/print-agent/.env')
    expect(() => branchIdFrom({ BRANCH_ID: 'Demo' })).toThrow('BRANCH_ID "Demo" is not a branch id (a uuid from branches.id)')
  })
})

describe('the branch filter', () => {
  it('filters Realtime by branch', () => {
    expect(branchFilter(DEMO)).toBe(`branch_id=eq.${DEMO}`)
  })
  it('prints only its branch jobs on its agent routes', () => {
    expect(isAgentJob({ branch_id: DEMO, route: 'Bar' }, DEMO, routes)).toBe(true)
    expect(isAgentJob({ branch_id: 'another-branch', route: 'Bar' }, DEMO, routes)).toBe(false)
    expect(isAgentJob({ route: 'Bar' }, DEMO, routes)).toBe(false)
    expect(isAgentJob({ branch_id: DEMO, route: 'Cashier' }, DEMO, routes)).toBe(false)
  })
  it('wants a login of the same branch', () => {
    expect(loginBranchProblem(DEMO.toUpperCase(), DEMO)).toBeNull()
    expect(loginBranchProblem(null, DEMO)).toMatch(/^AGENT_EMAIL has no branch/)
    expect(loginBranchProblem('another-branch', DEMO)).toMatch(/^AGENT_EMAIL is staff of another branch than BRANCH_ID/)
  })
})
