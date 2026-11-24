import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { checkPrinter, interpretStatus, isStatusByte, queryStatus } from './printerStatus.ts'

describe('isStatusByte', () => {
  it('accepts the ZY301 replies seen on site', () => {
    expect(isStatusByte(0x12)).toBe(true)
    expect(isStatusByte(0x16)).toBe(true)
  })

  it('rejects bytes that are not status replies', () => {
    expect(isStatusByte(0x00)).toBe(false)
    expect(isStatusByte(0xff)).toBe(false)
    expect(isStatusByte(0x41)).toBe(false)
  })
})

describe('interpretStatus', () => {
  it('is ok with no warnings when cover is closed and paper is present (ZY301 on site)', () => {
    expect(interpretStatus(0x12, 0x12)).toEqual({ ok: true, reason: null, warnings: [] })
  })

  it('refuses when the cover is open', () => {
    expect(interpretStatus(0x16, 0x12)).toMatchObject({ ok: false, reason: 'printer cover is open' })
  })

  it('refuses when printing stopped for paper end', () => {
    expect(interpretStatus(0x32, 0x12)).toMatchObject({ ok: false, reason: 'printer is out of paper' })
  })

  it('refuses when the printer reports an error', () => {
    expect(interpretStatus(0x52, 0x12)).toMatchObject({ ok: false, reason: 'printer reports an error' })
  })

  it('refuses when the paper sensor reports paper end', () => {
    expect(interpretStatus(0x12, 0x72)).toMatchObject({ ok: false, reason: 'printer is out of paper' })
  })

  it('prints but warns when paper is running low', () => {
    expect(interpretStatus(0x12, 0x1e)).toEqual({ ok: true, reason: null, warnings: ['paper is running low'] })
  })

  it('prints but warns when the printer gives no status', () => {
    expect(interpretStatus(null, 0x00)).toEqual({
      ok: true,
      reason: null,
      warnings: ['printer did not report its cover/error status', 'printer did not report its paper status'],
    })
  })
})

describe('queryStatus / checkPrinter against a fake printer', () => {
  let server: net.Server | null = null
  afterEach(() => {
    server?.close()
    server = null
  })

  // Answers DLE EOT n with replies[n]; never answers if replies[n] is undefined.
  async function fakePrinter(replies: Record<number, number>): Promise<string> {
    server = net.createServer((s) => {
      s.on('error', () => undefined)
      s.on('data', (buf) => {
        if (buf[0] === 0x10 && buf[1] === 0x04 && replies[buf[2]] !== undefined) s.write(Buffer.from([replies[buf[2]]]))
      })
    })
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()))
    return `127.0.0.1:${(server!.address() as net.AddressInfo).port}`
  }

  it('reads the status byte the printer sends back', async () => {
    const addr = await fakePrinter({ 4: 0x12 })
    expect(await queryStatus(addr, 4)).toBe(0x12)
  })

  it('returns null when the printer does not answer', async () => {
    const addr = await fakePrinter({})
    expect(await queryStatus(addr, 4, 200)).toBeNull()
  })

  it('rejects when nothing is listening', async () => {
    const addr = await fakePrinter({})
    server!.close()
    server = null
    await expect(queryStatus(addr, 4, 200)).rejects.toThrow()
  })

  it('reports an open cover end to end', async () => {
    const addr = await fakePrinter({ 2: 0x16, 4: 0x12 })
    expect(await checkPrinter(addr)).toMatchObject({ ok: false, reason: 'printer cover is open' })
  })
})
