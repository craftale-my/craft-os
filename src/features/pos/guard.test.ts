import { describe, it, expect } from 'vitest'
import { assertAgentDatabase, assertDevDatabase } from './guard'

describe('assertDevDatabase', () => {
  it('refuses the production project', () => {
    expect(() => assertDevDatabase('https://yfsoesxzurzjdwstszru.supabase.co')).toThrow('production')
  })

  it('refuses the production project however the URL is capitalised', () => {
    expect(() => assertDevDatabase('https://YFSOESXZURZJDWSTSZRU.supabase.co')).toThrow('production')
  })

  it('allows any other project', () => {
    expect(() => assertDevDatabase('https://abcdefgh.supabase.co')).not.toThrow()
  })
})

describe('assertAgentDatabase', () => {
  const prod = 'https://yfsoesxzurzjdwstszru.supabase.co'
  it('dev needs nothing', () => {
    expect(assertAgentDatabase('https://abcdefgh.supabase.co', undefined)).toBe('dev')
  })
  it('production is refused without the explicit switch, and says how to allow it', () => {
    expect(() => assertAgentDatabase(prod, undefined)).toThrow('PRINT_AGENT_ALLOW_PROD=1')
    expect(() => assertAgentDatabase(prod, '0')).toThrow('PRODUCTION')
    expect(() => assertAgentDatabase(prod, 'true')).toThrow('PRODUCTION')
  })
  it('production is allowed with PRINT_AGENT_ALLOW_PROD=1', () => {
    expect(assertAgentDatabase(prod, '1')).toBe('production')
    expect(assertAgentDatabase(prod.toUpperCase(), ' 1 ')).toBe('production')
  })
})
