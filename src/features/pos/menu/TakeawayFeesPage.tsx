// src/features/pos/menu/TakeawayFeesPage.tsx
import { feeLabel, groupByFee, parseNewFee } from './productGroups'
import ProductGroupsView, { type GroupedValue } from './ProductGroupsView'

/** /menu/takeaway-fees (Feedme's Takeaway page): the packaging fee a takeaway order adds per item,
 *  grouped by amount. No table of its own — each product keeps its own amount. */
const FEES: GroupedValue<number> = {
  title: 'Takeaway fees',
  hint: 'Added per item to takeaway orders. Products are grouped by their fee; add-on items are left out.',
  group: groupByFee,
  none: 0,
  valueOf: (p) => p.takeaway_fee_sen,
  patch: (sen) => ({ takeaway_fee_sen: sen }),
  label: feeLabel,
  allLabel: 'All fees',
  newButton: '+ New fee',
  newPrompt: 'Fee in RM',
  parseNew: (text) => parseNewFee(text),
  emptyText: 'No products with this fee yet.',
  noneNote: 'These products add no fee to a takeaway order. To give them one, open a fee and use Add products.',
}

export default function TakeawayFeesPage() {
  return <ProductGroupsView cfg={FEES} />
}
