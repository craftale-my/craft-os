import { describe, expect, it } from 'vitest'
import { activeSection } from './useScrollSpy'

describe('activeSection', () => {
  it('is the last section whose top has reached the line under the bar', () => {
    expect(activeSection([-400, -10, 300], 50)).toBe(1)
    expect(activeSection([-400, -100, 50], 50)).toBe(2)
  })
  it('is the first section before any has reached the line', () => {
    expect(activeSection([200, 900], 50)).toBe(0)
  })
  it('is the last section once the page is scrolled to the bottom', () => {
    expect(activeSection([-900, -300, 400], 50, true)).toBe(2)
  })
  it('is -1 with no sections', () => {
    expect(activeSection([], 50)).toBe(-1)
  })
})
