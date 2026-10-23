/** What one kitchen/bar ticket says. The pos_insert_order function builds
 *  exactly this shape into print_jobs.payload, so keep the two in step. */
export interface TicketLine {
  qty: number
  name: string
  note: string | null
  mods?: string[] // modifier names, e.g. ["Oat milk"]; absent on Phase 0 payloads
}

export interface TicketPayload {
  kind: 'ticket'
  route: string
  tableLabel: string | null // null = takeaway
  orderNo: string
  source: 'qr' | 'counter' | 'test'
  placedAt: string // ISO, UTC
  lines: TicketLine[]
  void?: true // a void ticket: the kitchen stops these lines
}

const MYT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kuala_Lumpur',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** "22/10/2026 11:48" in Malaysia time — the format Feedme's receipts use. */
export function formatMyt(iso: string): string {
  return MYT.format(new Date(iso)).replace(',', '')
}

/** Word-wraps on spaces. Width counts characters, so CJK text (two columns
 *  wide on a printer) can still overflow — recorded as a spike question. */
export function wrap(text: string, width: number, indent = ''): string[] {
  const out: string[] = []
  let current = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = current ? `${current} ${word}` : word
    if (!current || candidate.length <= width) {
      current = candidate
      continue
    }
    out.push(current)
    current = `${indent}${word}`
  }
  if (current) out.push(current)
  return out
}

export function renderTicketLines(t: TicketPayload, cols: number): string[] {
  const rule = '-'.repeat(cols)
  const body = t.lines.flatMap((l) => [
    ...wrap(`${l.qty} x ${l.name}`, cols, '    '),
    ...(l.mods ?? []).flatMap((m) => wrap(`+ ${m}`, cols - 4, '  ').map((s) => `    ${s}`)),
    ...(l.note ? wrap(`* ${l.note}`, cols - 4, '  ').map((s) => `    ${s}`) : []),
  ])
  return [
    ...(t.void ? ['*** VOID ***'] : []),
    `${t.route.toUpperCase()} TICKET`,
    t.tableLabel ? `Table: ${t.tableLabel}` : 'TAKEAWAY',
    `Order: ${t.orderNo} (${t.source.toUpperCase()})`,
    `Time: ${formatMyt(t.placedAt)}`,
    rule,
    ...body,
    rule,
  ]
}
