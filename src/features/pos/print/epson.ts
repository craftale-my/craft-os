import { escapeXml } from './xml'

/** Epson ePOS-Print: the printer runs a small web service, so a web page can
 *  print with a plain HTTP POST — no driver, no app. lang="zh-hans" lets the
 *  printer render Chinese if its firmware has the font. */
export function buildEposXml(lines: string[]): string {
  const text = lines.map((l) => `${escapeXml(l)}&#10;`).join('')
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
    '<epos-print xmlns="http://www.epson-pos.com/schemas/2011/03/epos-print">' +
    `<text lang="zh-hans">${text}</text><feed line="3"/><cut type="feed"/>` +
    '</epos-print></s:Body></s:Envelope>'
  )
}

export function eposEndpoint(address: string): string {
  return `${address.replace(/\/$/, '')}/cgi-bin/epos/service.cgi?devid=local_printer&timeout=10000`
}

export async function printEpson(address: string, lines: string[], fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn(eposEndpoint(address), {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: '""' },
    body: buildEposXml(lines),
  })
  const body = await res.text()
  if (!res.ok || !/success="true"/.test(body)) {
    throw new Error(`Epson printer refused the job (HTTP ${res.status}): ${body.slice(0, 200)}`)
  }
}
