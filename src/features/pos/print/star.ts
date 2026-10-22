import { escapeXml } from './xml'

/** Star WebPRNT: the print request is its own XML document, escaped once more
 *  and carried inside the <Request> element of the StarWebPrint envelope. */
export function buildStarXml(lines: string[]): string {
  const request =
    '<root>' + lines.map((l) => `<text>${escapeXml(l)}\n</text>`).join('') + '<cutpaper feed="true"/></root>'
  return (
    '<StarWebPrint xmlns="http://www.star-m.jp" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">' +
    `<Request>${escapeXml(request)}</Request></StarWebPrint>`
  )
}

const PRINTER_TIMEOUT_MS = 12000

export function starEndpoint(address: string): string {
  return `${address.replace(/\/$/, '')}/StarWebPRNT/SendMessage`
}

export async function printStar(address: string, lines: string[], fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn(starEndpoint(address), {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=UTF-8' },
    body: buildStarXml(lines),
    signal: AbortSignal.timeout(PRINTER_TIMEOUT_MS), // a printer that never answers must not hang the job
  })
  const body = await res.text()
  if (!res.ok || !/<success>\s*true\s*<\/success>/i.test(body)) {
    throw new Error(`Star printer refused the job (HTTP ${res.status}): ${body.slice(0, 200)}`)
  }
}
