export function toCSV(header: string[], rows: (string | number | null | undefined)[][]): string {
  return [header, ...rows].map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n')
}

export function downloadCSV(filename: string, csv: string) {
  const a = document.createElement('a')
  a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv)
  a.download = filename
  a.click()
}
