import { describe, it, expect } from 'vitest'
import { assertDevDatabase } from './guard'

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
