import { describe, it, expect } from 'vitest'
import { ACTION_TITLES, DEFAULT_TEMPLATE, defaultTemplate, reasonProblem } from './reasons'

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

describe('Open drawer reasons (W4 spec §5)', () => {
  it('with no saved template: Give change, Check the cash, Swap a note; Other allowed; a reason required', () => {
    expect(defaultTemplate('open_drawer')).toEqual({ reasons: ['Give change', 'Check the cash', 'Swap a note'], compulsory: true, allowOther: true })
    expect(reasonProblem(defaultTemplate('open_drawer'), '')).toBe('Choose a reason')
    expect(reasonProblem(defaultTemplate('open_drawer'), 'Customer asked for coins')).toBeNull()
    expect(ACTION_TITLES.open_drawer).toBe('Open drawer')
  })
  it('the other actions keep "any reason, but one is required"', () => {
    expect(defaultTemplate('refund')).toEqual(DEFAULT_TEMPLATE)
  })
})
