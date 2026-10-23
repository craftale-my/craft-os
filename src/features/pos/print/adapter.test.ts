import { describe, it, expect, vi } from 'vitest'
import { escapeXml } from './xml'
import { buildEposXml, eposEndpoint } from './epson'
import { buildStarXml, starEndpoint } from './star'
import { printFromBrowser, type PrintRoute } from './adapter'
import type { TicketPayload } from './ticket'
import type { ReceiptPayload } from './receipt'

const payload: TicketPayload = {
  kind: 'ticket',
  route: 'Bar',
  tableLabel: 'A1',
  orderNo: 'TEST01',
  source: 'test',
  placedAt: '2026-10-22T03:48:00.000Z',
  lines: [{ qty: 1, name: 'Latte', note: null }],
}

function fakeFetch(status: number, body: string) {
  return vi.fn(async () => new Response(body, { status })) as unknown as typeof fetch
}

describe('escapeXml', () => {
  it('escapes the five characters XML cares about', () => {
    expect(escapeXml(`a&b<c>"d'`)).toBe('a&amp;b&lt;c&gt;&quot;d&apos;')
  })
})

describe('Epson ePOS-Print', () => {
  it('wraps lines in a SOAP epos-print document with feed and cut', () => {
    const xml = buildEposXml(['A & B', 'C'])
    expect(xml).toContain('<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">')
    expect(xml).toContain('<text lang="zh-cn">A &amp; B&#10;C&#10;</text>')
    expect(xml).toContain('<cut type="feed"/>')
  })

  it('builds the service URL and drops a trailing slash', () => {
    expect(eposEndpoint('https://192.168.1.50/')).toBe(
      'https://192.168.1.50/cgi-bin/epos/service.cgi?devid=local_printer&timeout=10000',
    )
  })
})

describe('Star WebPRNT', () => {
  it('escapes the inner request inside the StarWebPrint envelope', () => {
    const xml = buildStarXml(['A&B'])
    expect(xml.startsWith('<StarWebPrint xmlns="http://www.star-m.jp"')).toBe(true)
    expect(xml).toContain('&lt;root&gt;&lt;text&gt;A&amp;amp;B\n&lt;/text&gt;')
    expect(xml).toContain('&lt;cutpaper feed=&quot;true&quot;/&gt;')
  })

  it('builds the SendMessage URL', () => {
    expect(starEndpoint('https://10.0.0.9')).toBe('https://10.0.0.9/StarWebPRNT/SendMessage')
  })
})

describe('printFromBrowser', () => {
  const epson: PrintRoute = { route: 'Bar', kind: 'epson-epos', address: 'https://192.168.1.50' }
  const star: PrintRoute = { route: 'Bar', kind: 'star-webprnt', address: 'https://192.168.1.60' }

  it('posts to the Epson printer and accepts success="true"', async () => {
    const f = fakeFetch(200, '<response success="true" code="" status="251658262"/>')
    await printFromBrowser(epson, payload, f)
    expect(vi.mocked(f).mock.calls[0][0]).toBe(eposEndpoint(epson.address))
  })

  it('rejects when the Epson printer reports failure', async () => {
    const f = fakeFetch(200, '<response success="false" code="EPTR_COVER_OPEN"/>')
    await expect(printFromBrowser(epson, payload, f)).rejects.toThrow('EPTR_COVER_OPEN')
  })

  it('posts to the Star printer and accepts <success>true</success>', async () => {
    const f = fakeFetch(200, '<Response><success>true</success></Response>')
    await printFromBrowser(star, payload, f)
    expect(vi.mocked(f).mock.calls[0][0]).toBe(starEndpoint(star.address))
  })

  it('rejects when the Epson printer never answers (fetch aborts on timeout)', async () => {
    const f = vi.fn(async () => {
      throw new DOMException('timed out', 'TimeoutError')
    }) as unknown as typeof fetch
    await expect(printFromBrowser(epson, payload, f)).rejects.toThrow('timed out')
    expect(vi.mocked(f).mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('rejects when the Star printer never answers (fetch aborts on timeout)', async () => {
    const f = vi.fn(async () => {
      throw new DOMException('timed out', 'TimeoutError')
    }) as unknown as typeof fetch
    await expect(printFromBrowser(star, payload, f)).rejects.toThrow('timed out')
    expect(vi.mocked(f).mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal)
  })

  it('prints a receipt through the job dispatcher', async () => {
    const receipt: ReceiptPayload = {
      kind: 'receipt', route: 'Bar', reprint: false,
      header: { title: 'Craft Cafe', legalName: null, registrationNo: null, sstNo: null, address: null, phone: null, email: null },
      billNo: '261024-001', closedAt: '2026-10-24T05:00:00.000Z', cashier: 'Aina', tableLabel: 'T1', pax: 2,
      items: [{ qty: 1, name: 'Latte', unitSen: 1300, amountSen: 1300, mods: [] }], itemCount: 1,
      subtotalSen: 1300, sstGroups: [], serviceChargeGroups: [], takeawayFeeSen: 0, roundingSen: 0, totalSen: 1300,
      payments: [{ name: 'Cash', kind: 'cash', amountSen: 1300, tenderedSen: null, reference: null }], changeSen: 0, footer: 'Thanks',
    }
    const f = fakeFetch(200, '<response success="true" code="" status="251658262"/>')
    await printFromBrowser(epson, receipt, f)
    expect(String(vi.mocked(f).mock.calls[0][1]?.body)).toContain('Total (MYR)')
  })

  it('refuses routes that belong to the print agent', async () => {
    await expect(
      printFromBrowser({ route: 'Kitchen', kind: 'agent', address: '10.0.0.5:9100' }, payload, fakeFetch(200, '')),
    ).rejects.toThrow('print agent')
  })
})
