import { describe, expect, it, vi } from 'vitest'

vi.stubGlobal('__POS_BUILD__', 'b1')
const { markReloaded, newerBuild, reloadedFor, swUrl } = await import('./appUpdate')

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

describe('the build this tab reloaded for', () => {
  it('is remembered, so the same build never reloads twice', () => {
    const data = new Map<string, string>()
    const store = { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } } as unknown as Storage
    expect(reloadedFor(store)).toBeNull()
    markReloaded(store, 'b2')
    expect(reloadedFor(store)).toBe('b2')
  })
  it('a storage that throws reads as none', () => {
    const store = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } } as unknown as Storage
    expect(reloadedFor(store)).toBeNull()
    expect(() => markReloaded(store, 'b2')).not.toThrow()
  })
})
