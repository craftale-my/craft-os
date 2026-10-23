import { describe, it, expect } from 'vitest'
import { DEFAULT_TEMPLATE, reasonProblem } from './reasons'

describe('reasonProblem', () => {
  const listed = { reasons: ['Customer changed mind', 'Wrong item keyed'], compulsory: true, allowOther: false }
  it('needs a reason when compulsory', () => {
    expect(reasonProblem(listed, '  ')).toBe('Choose a reason')
    expect(reasonProblem({ ...listed, compulsory: false }, '')).toBeNull()
  })
  it('keeps to the list when Other is not allowed', () => {
    expect(reasonProblem(listed, 'Wrong item keyed')).toBeNull()
    expect(reasonProblem(listed, 'Felt like it')).toBe('Choose one of the listed reasons')
    expect(reasonProblem({ ...listed, allowOther: true }, 'Felt like it')).toBeNull()
  })
  it('defaults to "any reason, but one is required"', () => {
    expect(reasonProblem(DEFAULT_TEMPLATE, '')).toBe('Choose a reason')
    expect(reasonProblem(DEFAULT_TEMPLATE, 'Spilled')).toBeNull()
  })
  it('caps the length', () => {
    expect(reasonProblem(DEFAULT_TEMPLATE, 'x'.repeat(201))).toBe('Reason is too long')
  })
})
