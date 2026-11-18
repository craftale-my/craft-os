import ReportBody from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor } from './columns'
import { csvFileName } from './csv'
import { fetchAuditReport, type ReportQuery, type VoidBillRow, type VoidItemRow } from './reportsApi'
import { useReport } from './useReport'

const i = columnsFor<VoidItemRow>()
const ITEM_COLUMNS = [
  i.time('Time', (r) => r.at), i.text('Outlet', (r) => r.outlet), i.text('Bill', (r) => r.billNo), i.text('Item', (r) => r.name),
  i.count('Qty', (r) => r.qty), i.money('Value', (r) => r.valueSen), i.text('Reason', (r) => r.reason),
  i.text('By', (r) => r.by), i.text('Approved by', (r) => r.approvedBy),
]
const b = columnsFor<VoidBillRow>()
const BILL_COLUMNS = [
  b.time('Time', (r) => r.at), b.text('Outlet', (r) => r.outlet), b.text('Bill', (r) => r.billNo),
  b.money('Value', (r) => r.valueSen), b.text('Reason', (r) => r.reason), b.text('By', (r) => r.by),
  b.text('Approved by', (r) => r.approvedBy),
]

/** Spec §5.9: voided items (a voided bill's items too) and voided bills. */
export default function VoidsTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchAuditReport, query)
  const file = (name: string) => csvFileName(name, query.from, query.to)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => (
        <div className="space-y-4">
          <ReportTable title="Voided items" columns={ITEM_COLUMNS} rows={r.voidItems} fileName={file('voided-items')}
                       empty="No voided items in this range." />
          <ReportTable title="Voided bills" columns={BILL_COLUMNS} rows={r.voidBills} fileName={file('voided-bills')}
                       empty="No voided bills in this range." />
        </div>
      )}
    </ReportBody>
  )
}
