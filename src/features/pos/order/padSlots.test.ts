import { describe, expect, it } from 'vitest'
import { NO_WINDOWS, TICK_MARGIN_MS, menuWindows, msUntilServerMinute, serverNow, slotProblem, tileSlotLabel } from './padSlots'

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

  it('ticks just after the server\'s minute, not this iPad\'s', () => {
    const minute = Date.parse('2026-10-26T00:00:00.000Z')                 // 08:00 in Malaysia
    expect(TICK_MARGIN_MS).toBe(250)
    // same clocks, 10 s into the minute: 50 s to go, plus the margin
    expect(msUntilServerMinute(minute + 10_000, 0)).toBe(50_250)
    // the server is 200 ms behind this iPad: at the iPad's 08:00:00.000 the server is at 07:59:59.800
    expect(msUntilServerMinute(minute, -200)).toBe(450)
    expect(new Date(minute + 450 - 200).toISOString()).toBe('2026-10-26T00:00:00.250Z')
    // the server is ahead by 2 min 30 s: its minute starts 30 s after this iPad's
    expect(msUntilServerMinute(minute, 150_000)).toBe(30_250)
    // exactly on the server's minute: the next one, never 0
    expect(msUntilServerMinute(minute, 0)).toBe(60_250)
    expect(msUntilServerMinute(minute - 1, 0)).toBe(251)
    // a negative instant still lands on a minute
    expect(msUntilServerMinute(-10_000, 0)).toBe(10_250)
    for (const off of [-59_999, -200, 0, 1, 37_123]) {
      for (const t of [minute, minute + 1, minute + 59_999]) {
        const d = msUntilServerMinute(t, off)
        expect(d).toBeGreaterThan(TICK_MARGIN_MS)
        expect(d).toBeLessThanOrEqual(60_000 + TICK_MARGIN_MS)
        expect((t + off + d) % 60_000).toBe(TICK_MARGIN_MS)              // lands the margin after a server minute
      }
    }
  })
})
