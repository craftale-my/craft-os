import { renderJobDoc, renderJobLines, type JobPayload } from './printJob'
import { docPulses } from './doc'
import { printEpson } from './epson'
import { printStar } from './star'

export type PrinterKind = 'epson-epos' | 'star-webprnt' | 'agent'

export interface PrintRoute {
  route: string
  kind: PrinterKind
  address: string
}

/** 80 mm paper at the default font fits 42–48 characters; 42 is the safe
 *  value until the spike measures the real printers. */
export const TICKET_COLS = 42

/** Epson ePOS and Star WebPRNT print the text view (W4 spec §4: big text as normal text, no logo or QR)
 *  and pulse the drawer when the job is a drawer kick. */
export async function printFromBrowser(
  route: PrintRoute,
  payload: JobPayload,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const doc = renderJobDoc(payload, TICKET_COLS)
  const lines = renderJobLines(payload, TICKET_COLS)
  const opts = { pulse: docPulses(doc), paper: doc.paper }
  if (route.kind === 'epson-epos') return printEpson(route.address, lines, fetchFn, opts)
  if (route.kind === 'star-webprnt') return printStar(route.address, lines, fetchFn, opts)
  throw new Error(`Route ${route.route} is printed by the print agent, not the browser`)
}
