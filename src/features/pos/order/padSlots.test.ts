import { describe, expect, it } from 'vitest'
import { NO_WINDOWS, menuWindows, serverNow, slotProblem, tileSlotLabel } from './padSlots'

const json = {
  now: '2026-10-26T01:00:00.000Z',                                         // Mon 09:00 in Malaysia
  windows: [
    { productId: 'pancake', days: [1, 2, 3, 4, 5], start: '08:00', end: '11:30' },
    { productId: 'soup', days: [1, 2, 3, 4, 5], start: '11:00', end: '14:00' },
    { productId: 'soup', days: [1, 2, 3, 4, 5], start: '18:00', end: '21:00' },
  ],
}

describe('padSlots', () => {
  it('groups windows by product and measures the clock offset', () => {
    const w = menuWindows(json, Date.parse('2026-10-26T00:58:00.000Z'))   // this iPad is 2 minutes slow
    expect(w.offsetMs).toBe(120_000)
    expect(w.byProduct.get('soup')).toHaveLength(2)
    expect(w.byProduct.has('latte')).toBe(false)
    expect(serverNow(w, Date.parse('2026-10-26T00:58:00.000Z')).toISOString()).toBe('2026-10-26T01:00:00.000Z')
    expect(menuWindows({ now: 'nonsense', windows: [] }, 5).offsetMs).toBe(0)
  })

  it('labels a tile by the server time: on sale, the next window today, or not now', () => {
    const w = menuWindows(json, Date.parse(json.now))
    const at = (hm: string) => new Date(`2026-10-26T${hm}:00+08:00`)
    expect(tileSlotLabel(w, 'pancake', at('09:00'))).toBeNull()
    expect(tileSlotLabel(w, 'latte', at('03:00'))).toBeNull()                // no schedule: always on sale
    expect(tileSlotLabel(w, 'soup', at('09:00'))).toBe('Available 11:00–14:00')
    expect(tileSlotLabel(w, 'soup', at('15:00'))).toBe('Available 18:00–21:00')
    expect(tileSlotLabel(w, 'pancake', at('12:00'))).toBe('Not available now')
    expect(tileSlotLabel(NO_WINDOWS, 'pancake', at('12:00'))).toBeNull()
  })

  it('names the first cart line outside its slots in the server words', () => {
    const w = menuWindows(json, Date.parse(json.now))
    const names: Record<string, string> = { pancake: 'Pancake', soup: 'Soup', latte: 'Latte' }
    const lines = [{ productId: 'latte' }, { productId: 'soup' }, { productId: 'pancake' }]
    expect(slotProblem(w, lines, (id) => names[id], new Date('2026-10-26T09:00:00+08:00'))).toBe('Soup is not available at this time')
    expect(slotProblem(w, lines, (id) => names[id], new Date('2026-10-26T11:15:00+08:00'))).toBeNull()
  })
})
