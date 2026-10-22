import { strFromU8, unzipSync } from 'fflate'

/** A sheet as rows of cell text. Skipped cells are ''. */
export type Sheet = string[][]
export type Workbook = Record<string, Sheet>

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

const textOf = (el: Element): string =>
  Array.from(el.getElementsByTagNameNS(MAIN, 't'))
    .map((t) => t.textContent ?? '')
    .join('')

/** Reads every sheet of an .xlsx into strings. Only what Feedme's export
 *  uses: shared strings, inline strings and plain values (numbers stay text). */
export function readXlsx(bytes: Uint8Array): Workbook {
  const files = unzipSync(bytes)
  const parse = (path: string): Document | null => {
    const f = files[path]
    if (!f) return null
    const doc = new DOMParser().parseFromString(strFromU8(f), 'application/xml')
    // A malformed part must not read as an empty sheet — that would look like "no rows".
    if (doc.getElementsByTagName('parsererror').length > 0) throw new Error('Not an Excel (.xlsx) file')
    return doc
  }
  const book = parse('xl/workbook.xml')
  const rels = parse('xl/_rels/workbook.xml.rels')
  if (!book || !rels) throw new Error('Not an Excel (.xlsx) file')

  const shared = Array.from(parse('xl/sharedStrings.xml')?.getElementsByTagNameNS(MAIN, 'si') ?? []).map(textOf)
  const target = new Map<string, string>()
  for (const r of Array.from(rels.getElementsByTagName('Relationship'))) {
    target.set(r.getAttribute('Id') ?? '', r.getAttribute('Target') ?? '')
  }

  const out: Workbook = {}
  for (const sheet of Array.from(book.getElementsByTagNameNS(MAIN, 'sheet'))) {
    const t = target.get(sheet.getAttributeNS(REL, 'id') ?? '') ?? ''
    const path = t.startsWith('/') ? t.slice(1) : t.startsWith('xl/') ? t : `xl/${t}`
    const doc = parse(path)
    if (!doc) throw new Error('Not an Excel (.xlsx) file')
    const rows: Sheet = []
    for (const row of Array.from(doc.getElementsByTagNameNS(MAIN, 'row'))) {
      const cells: string[] = []
      for (const c of Array.from(row.getElementsByTagNameNS(MAIN, 'c'))) {
        const type = c.getAttribute('t')
        const v = c.getElementsByTagNameNS(MAIN, 'v')[0]?.textContent ?? ''
        cells[colIndex(c.getAttribute('r') ?? 'A1')] =
          type === 's' ? (shared[Number(v)] ?? '') : type === 'inlineStr' ? textOf(c) : v
      }
      rows.push(Array.from(cells, (x) => x ?? ''))
    }
    out[sheet.getAttribute('name') ?? path] = rows
  }
  return out
}
