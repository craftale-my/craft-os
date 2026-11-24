// CSV files for the accountant (spec §5): UTF-8 with a BOM (Excel then reads it as UTF-8), comma separated,
// CRLF line ends, ringgit with two decimals and no "RM", dates YYYY-MM-DD, times YYYY-MM-DD HH:MM in
// Malaysia time.

export type Cell = string | number | null

export function csvCell(c: Cell): string {
  const s = c === null ? '' : String(c)
  return /[",\r\n]/.test(s) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s
}

/** A text cell that Excel could read as a formula (first character = + - @ tab or CR) gets a leading apostrophe. */
export function safeText(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
}

export function toCsv(header: string[], rows: Cell[][]): string {
  return '\uFEFF' + [header.map(safeText), ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

/** 1230 → '12.30', -2 → '-0.02'. Integer arithmetic: exact for every sen. */
export function ringgit(sen: number): string {
  const a = Math.abs(sen)
  return `${sen < 0 ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`
}

/** An ISO time as 'YYYY-MM-DD HH:MM', Malaysia time. */
export function csvTime(iso: string): string {
  return new Date(Date.parse(iso) + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')
}

export function csvFileName(report: string, from: string, to: string): string {
  return `${report}_${from}_${to}.csv`
}

/** Saves the text as a file through a temporary link. */
export function downloadCsv(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
