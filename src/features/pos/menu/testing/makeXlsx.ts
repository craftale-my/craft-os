import { strToU8, zipSync } from 'fflate'
import type { Workbook } from '../xlsx'

const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function colName(i: number): string {
  let n = i + 1
  let s = ''
  while (n > 0) {
    const m = (n - 1) % 26
    s = String.fromCharCode(65 + m) + s
    n = Math.floor((n - 1) / 26)
  }
  return s
}

/** Builds a minimal .xlsx (inline strings) — enough for readXlsx tests. */
export function makeXlsx(wb: Workbook): Uint8Array {
  const names = Object.keys(wb)
  const files: Record<string, Uint8Array> = {
    'xl/workbook.xml': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>` +
        names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
        `</sheets></workbook>`,
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        names
          .map(
            (_, i) =>
              `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
          )
          .join('') +
        `</Relationships>`,
    ),
  }
  names.forEach((n, i) => {
    const rows = wb[n]
      .map(
        (row, ri) =>
          `<row r="${ri + 1}">` +
          row
            .map((v, ci) =>
              v === '' ? '' : `<c r="${colName(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`,
            )
            .join('') +
          `</row>`,
      )
      .join('')
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${MAIN}"><sheetData>${rows}</sheetData></worksheet>`,
    )
  })
  return zipSync(files)
}
