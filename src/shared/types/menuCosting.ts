/** One row of the menu_variant_costs view. Costs in RM, prices in sen. */
export interface MenuVariantCost {
  variant_id: string
  variant_name: string
  product_id: string
  product_name: string
  category_id: string | null
  category_name: string | null
  price_sen: number
  is_active: boolean
  line_count: number
  missing_cost_items: number
  /** Null when there is no recipe or an ingredient has no cost. */
  cost_rm: number | null
  /** cost ÷ price in basis points (2500 = 25%); null when not computable. */
  food_cost_bp: number | null
  target_food_cost_bp: number | null
  over_target: boolean
}

/** One row of the modifier_option_costs view. */
export interface ModifierOptionCost {
  option_id: string
  group_id: string
  option_name: string
  price_delta_sen: number
  line_count: number
  missing_cost_items: number
  /** May be negative (a swap that saves cost); null when an ingredient has no cost. */
  cost_delta_rm: number | null
}

/** A recipe line as saved: base units of the item. */
export interface RecipeLine {
  item_id: string
  qty_base: number
}

export type CostStatus = 'no_recipe' | 'missing_cost' | 'no_price' | 'over_target' | 'ok'

export const COST_STATUS_LABELS: Record<CostStatus, string> = {
  no_recipe:    'No recipe',
  missing_cost: 'Missing price',
  no_price:     'No selling price',
  over_target:  'Over target',
  ok:           'OK',
}
