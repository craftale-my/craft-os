import { describe, expect, it } from 'vitest'
import { CONTEXT_CODES, contextCode } from './deviceErrors'

describe('contextCode', () => {
  it.each(CONTEXT_CODES)('knows %s', (code) => {
    expect(contextCode(code)).toBe(code)
  })

  it('is null for any other message, or none', () => {
    expect(contextCode('Item is not available: Latte')).toBeNull()
    expect(contextCode('no_session ')).toBeNull()
    expect(contextCode(undefined)).toBeNull()
    expect(contextCode(42)).toBeNull()
  })
})
