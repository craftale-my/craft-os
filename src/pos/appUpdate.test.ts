import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal('__POS_BUILD__', 'b1')
const { newerBuild, swUrl } = await import('./appUpdate')

describe('newerBuild', () => {
  it('names a build other than the running one', () => {
    expect(newerBuild({ version: 'b2' }, 'b1')).toBe('b2')
  })
  it('is null for the same build, or a reply that is not one', () => {
    expect(newerBuild({ version: 'b1' }, 'b1')).toBeNull()
    expect(newerBuild(null, 'b1')).toBeNull()
    expect(newerBuild({ version: 3 }, 'b1')).toBeNull()
    expect(newerBuild('<html>', 'b1')).toBeNull()
  })
  it('registers the worker per build', () => {
    expect(swUrl('2026-10-30T10:00:00.000Z')).toBe('/sw.js?v=2026-10-30T10%3A00%3A00.000Z')
  })
})
