/** What one kitchen/bar ticket says. The pos_insert_order function builds
 *  exactly this shape into print_jobs.payload, so keep the two in step. */
export interface TicketLine {
  qty: number
  name: string
  note: string | null
  mods?: string[] // modifier names, e.g. ["Oat milk"]; absent on Phase 0 payloads
  guest?: string // QR table cart: the guest who added the line ("Eric", "Guest 2"); absent for the counter
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

// Local copy of toAscii's rule (receipt.ts imports this file, so importing back would be a cycle):
// printable ASCII is kept, every other character becomes "?".
function asciiOnly(text: string): string {
  let out = ''
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0x3f
    out += code >= 0x20 && code < 0x7f ? ch : '?'
  }
  return out
}

/** The guest's name as a ticket can print it: ASCII only (toAscii), trimmed. A name with no ASCII letter
 *  or digit left (e.g. all Chinese: "??") prints as nothing — "?" marks tell the kitchen nothing. */
export function ticketGuest(guest: string | undefined): string {
  if (!guest) return ''
  const ascii = asciiOnly(guest).trim()
  return /[A-Za-z0-9]/.test(ascii) ? ascii : ''
}

export function renderTicketLines(t: TicketPayload, cols: number): string[] {
  const rule = '-'.repeat(cols)
  const body = t.lines.flatMap((l) => {
    const g = ticketGuest(l.guest)
    return [
      ...wrap(`${l.qty} x ${l.name}${g ? ` - ${g}` : ''}`, cols, '    '),
      ...(l.mods ?? []).flatMap((m) => wrap(`+ ${m}`, cols - 4, '  ').map((s) => `    ${s}`)),
      ...(l.note ? wrap(`* ${l.note}`, cols - 4, '  ').map((s) => `    ${s}`) : []),
    ]
  })
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
