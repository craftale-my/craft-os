import ReportBody, { NoSales } from './ReportBody'
import ReportTable from './ReportTable'
import { columnsFor } from './columns'
import { csvFileName } from './csv'
import { fetchProductsReport, type AddOnRow, type CategoryRow, type ProductRow, type ReportQuery } from './reportsApi'
import { useReport } from './useReport'

const p = columnsFor<ProductRow>()
const PRODUCT_COLUMNS = [
  p.text('Product', (r) => r.name), p.text('Category', (r) => r.category ?? 'No category'), p.count('Qty', (r) => r.qty),
  p.money('Gross', (r) => r.grossSen), p.money('Discounts', (r) => r.discountSen), p.money('Net', (r) => r.netSen),
]
const a = columnsFor<AddOnRow>()
const ADD_ON_COLUMNS = [a.text('Add-on', (r) => r.name), a.count('Count', (r) => r.count), a.money('Value', (r) => r.valueSen)]
const k = columnsFor<CategoryRow>()
const CATEGORY_COLUMNS = [
  k.text('Category', (r) => r.category ?? 'No category'), k.count('Qty', (r) => r.qty), k.money('Net', (r) => r.netSen),
]

/** Spec §5.5: per product (gross = price × qty, net after every discount), add-ons, categories (today's). */
export default function ProductsTab({ query }: { query: ReportQuery }) {
  const { load, retry } = useReport(fetchProductsReport, query)
  const file = (name: string) => csvFileName(name, query.from, query.to)
  return (
    <ReportBody load={load} retry={retry}>
      {(r) => (r.products.length === 0 ? <NoSales /> : (
        <div className="space-y-4">
          <ReportTable title="Products" columns={PRODUCT_COLUMNS} rows={r.products} fileName={file('products')} />
          <ReportTable title="Add-ons" columns={ADD_ON_COLUMNS} rows={r.addOns} fileName={file('add-ons')}
                       empty="No add-ons in this range." />
          <ReportTable title="Categories" columns={CATEGORY_COLUMNS} rows={r.categories} fileName={file('categories')} />
          <p className="text-xs text-brown-muted">A product's category is its category today.</p>
        </div>
      ))}
    </ReportBody>
  )
}
