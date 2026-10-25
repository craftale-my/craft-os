// src/features/pos/menu/PrintRoutesPage.tsx
import { groupByRoute, parseNewRoute } from './productGroups'
import { routeChoices, routeText } from './productTable'
import ProductGroupsView, { type GroupedValue } from './ProductGroupsView'

/** /menu/print-routes: which kitchen ticket each product prints on, grouped by route name. No table
 *  of its own — each product keeps its route name, and each branch maps the name to a printer. */
const ROUTES: GroupedValue<string | null> = {
  title: 'Print routes',
  hint: 'Each branch maps a route name to a printer in POS settings. Products with no route print no kitchen ticket; add-on items are left out.',
  group: groupByRoute,
  none: null,
  valueOf: (p) => p.print_route,
  patch: (route) => ({ print_route: route }),
  label: routeText,
  allLabel: 'All routes',
  newButton: '+ New route',
  newPrompt: 'Route name',
  parseNew: (text, rows) => parseNewRoute(text, routeChoices(rows)),
  emptyText: 'No products on this route yet.',
  noneNote: 'These products print no kitchen ticket. To print them, open a route and use Add products.',
}

export default function PrintRoutesPage() {
  return <ProductGroupsView cfg={ROUTES} />
}
