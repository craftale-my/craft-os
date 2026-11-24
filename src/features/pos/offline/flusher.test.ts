import { describe, expect, it } from 'vitest'
import { makeFlusher } from './flusher'

function deferred() {
  let resolve!: () => void, reject!: (e: Error) => void
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('makeFlusher', () => {
  it('never runs two passes at once', async () => {
    let active = 0, max = 0, runs = 0
    const gates: ReturnType<typeof deferred>[] = []
    const flush = makeFlusher(async () => {
      runs++; active++; max = Math.max(max, active)
      const g = deferred(); gates.push(g)
      await g.promise
      active--
    })
    const a = flush(), b = flush()
    await tick()
    expect(runs).toBe(1)
    gates[0].resolve(); await tick()
    gates[1].resolve()
    await Promise.all([a, b])
    expect(max).toBe(1)
    expect(runs).toBe(2) // the second call is guaranteed one follow-up pass
  })

  it('a call during the last await of a pass causes exactly one more pass', async () => {
    let runs = 0
    const gates: ReturnType<typeof deferred>[] = []
    const flush = makeFlusher(async () => { runs++; const g = deferred(); gates.push(g); await g.promise })
    const first = flush()
    await tick()
    flush() // lands while the only pass is still in its final await
    gates[0].resolve(); await tick()
    expect(runs).toBe(2)
    gates[1].resolve()
    await first
    expect(runs).toBe(2)
  })

  it('a rejecting run does not wedge the flusher', async () => {
    let n = 0
    const flush = makeFlusher(async () => { n++; if (n === 1) throw new Error('boom') })
    await expect(flush()).rejects.toThrow('boom')
    await expect(flush()).resolves.toBeUndefined()
    expect(n).toBe(2)
  })
})
