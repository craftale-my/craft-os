import { describe, expect, it } from 'vitest'
import { AI_PICK_COPY, aiPickSentence, type Situation } from './aiPickCopy'

const SITUATIONS: Situation[] = ['drinks_only', 'food_only', 'solo_small', 'mixed']
const all = SITUATIONS.flatMap((s) => AI_PICK_COPY[s].map((t) => [s, t] as const))

describe('AI Pick copy rules', () => {
  it('has at least five lines per situation, no two alike', () => {
    for (const s of SITUATIONS) {
      expect(AI_PICK_COPY[s].length).toBeGreaterThanOrEqual(5)
      expect(new Set(AI_PICK_COPY[s]).size).toBe(AI_PICK_COPY[s].length)
    }
  })
  it.each(all)('%s: "%s" obeys the rules', (_s, t) => {
    expect(t.split('{name}').length - 1).toBe(1)                      // the name once
    expect(t.length).toBeLessThanOrEqual(60)                          // before the name is filled in
    expect(t).not.toMatch(/\bbest\b/i)
    expect(t).not.toMatch(/health|allerg|gluten|vegan|vegetarian|halal|sugar|calorie|diet|nut-free|dairy/i)
    expect(t).not.toMatch(/price|\bRM\b|cheap|free\b|deal|discount|save|value|\d/i)
    expect(t).not.toContain('!')
    expect(t.trim()).toBe(t)
  })
})

describe('aiPickSentence', () => {
  it('fills in the name', () => {
    const t = aiPickSentence('mixed', 'p1', 'Iced Latte', 7)
    expect(t).toContain('Iced Latte')
    expect(t).not.toContain('{name}')
  })
  it('is stable for a seed and product, and comes from its situation', () => {
    for (const s of SITUATIONS) {
      const a = aiPickSentence(s, 'p1', 'X', 12345)
      expect(aiPickSentence(s, 'p1', 'X', 12345)).toBe(a)
      expect(AI_PICK_COPY[s].map((t) => t.replace('{name}', 'X'))).toContain(a)
    }
  })
  it('different seeds reach different lines', () => {
    const seen = new Set(Array.from({ length: 40 }, (_, i) => aiPickSentence('food_only', 'p1', 'X', i)))
    expect(seen.size).toBeGreaterThan(2)
  })
})
