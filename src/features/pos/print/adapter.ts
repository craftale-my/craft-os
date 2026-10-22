import { renderTicketLines, type TicketPayload } from './ticket'
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

export async function printFromBrowser(
  route: PrintRoute,
  payload: TicketPayload,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const lines = renderTicketLines(payload, TICKET_COLS)
  if (route.kind === 'epson-epos') return printEpson(route.address, lines, fetchFn)
  if (route.kind === 'star-webprnt') return printStar(route.address, lines, fetchFn)
  throw new Error(`Route ${route.route} is printed by the print agent, not the browser`)
}
