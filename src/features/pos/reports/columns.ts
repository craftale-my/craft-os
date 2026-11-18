// One column of a report table: what the screen shows and what the CSV holds (spec §5: ringgit without
// "RM", dates YYYY-MM-DD, times in Malaysia time).
import { formatSen } from '../order/cart'
import { csvTime, ringgit, toCsv, type Cell } from './csv'
import { dayLabel, reportTime } from './reportView'

export interface Column<R> {
  label: string
  show: (r: R) => string
  csv: (r: R) => Cell
  numeric: boolean
}

/** Column builders for rows of type R. A missing value shows '—' and leaves the CSV cell empty. */
export function columnsFor<R>() {
  return {
    text: (label: string, get: (r: R) => string | null): Column<R> => ({
      label, numeric: false, show: (r) => get(r) ?? '—', csv: get,
    }),
    day: (label: string, get: (r: R) => string): Column<R> => ({
      label, numeric: false, show: (r) => dayLabel(get(r)), csv: get,
    }),
    time: (label: string, get: (r: R) => string | null, none = '—'): Column<R> => ({
      label,
      numeric: false,
      show: (r) => {
        const v = get(r)
        return v === null ? none : reportTime(v)
      },
      csv: (r) => {
        const v = get(r)
        return v === null ? null : csvTime(v)
      },
    }),
    count: (label: string, get: (r: R) => number | null): Column<R> => ({
      label,
      numeric: true,
      show: (r) => {
        const v = get(r)
        return v === null ? '—' : String(v)
      },
      csv: get,
    }),
    money: (label: string, get: (r: R) => number | null): Column<R> => ({
      label,
      numeric: true,
      show: (r) => {
        const v = get(r)
        return v === null ? '—' : formatSen(v)
      },
      csv: (r) => {
        const v = get(r)
        return v === null ? null : ringgit(v)
      },
    }),
  }
}

export function tableCsv<R>(columns: Column<R>[], rows: R[]): string {
  return toCsv(columns.map((c) => c.label), rows.map((r) => columns.map((c) => c.csv(r))))
}
