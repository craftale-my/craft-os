# Menu costing — design

Date: 2026-11-22. Owner approved the design in chat on 2026-11-22.
Branch: `feature/menu-costing`, cut from `feature/pos-demo` (7103c01) with `main` merged in. Dev first (`egznnbjmicebbhwasloy`); prod only with the POS rollout and the owner's go-ahead.

## Why

The owner prices dishes and drinks from a Google costing sheet. Inventory v2 (live on prod since 2026-10-30) knows every ingredient's purchase price and the prep recipes for semi-finished items; the POS branch (dev only) holds the menu. Menu costing joins the two so each menu size shows its ingredient cost and food cost %, updated whenever a purchase price changes. It replaces the sheet and later feeds POS sales depletion.

## Owner decisions (2026-11-22)

1. **Purpose:** food cost first. POS sales deducting stock comes later, on top of these recipes.
2. **Detail:** a recipe per menu variant (size / Hot / Cold), plus add-on recipes per modifier option that add or swap ingredients (extra shot adds coffee beans; oat milk adds oat milk and removes dairy milk).
3. **Source:** recipes are imported from the costing sheet (cleaned list reviewed by the owner first), then maintained in the app. The import runs once items and menu exist on prod; this spec covers the schema, costing and editor.

Decided by Claude (owner allows small decisions, see memory `decide-small-things`):
- Ingredient cost for menu costing = **standard cost**: raw/packaging item = `latest_price / conversion_rate`; a prep (semi-finished) item = its current active prep recipe rolled up from standard costs ÷ yield. Company-wide, not per branch. Inventory valuation keeps its moving average; the two are independent.
- Food cost % uses the variant's base `price_sen`, which **excludes SST** (the POS adds SST on top at checkout). Branch catalog price overrides are out of scope.
- Optional target food cost % per menu category; variants above target show red.
- Build on a branch from `feature/pos-demo` with `main` merged in, because the menu exists only there and the items only on main.

## Out of scope

POS sales depletion, theoretical-vs-actual variance, recipe version history, per-branch costs or catalog prices, the costing-sheet import itself (a later step with its own review list).

## Data model

New tables (RLS on; read and write need `manage_procurement`; writes only through RPCs):

- `menu_variant_recipe_lines` — `variant_id` → `menu_variants`, `item_id` → `items`, `qty_base numeric > 0` (base units of the item), `sort_order`. Primary key (`variant_id`, `item_id`). A variant with no lines has no recipe.
- `modifier_recipe_lines` — `option_id` → `modifier_options`, `item_id` → `items`, `qty_base numeric <> 0` (positive = adds, negative = removes, for swaps), `sort_order`. Primary key (`option_id`, `item_id`).
- `menu_category_targets` — `category_id` primary key → `menu_categories`, `target_food_cost_bp integer not null check (between 0 and 10000)` (2500 = 25%). A separate table, not a column on `menu_categories`, because the menu tables are readable by the QR ordering page and targets are internal.
- `menu_recipe_meta` — `variant_id` primary key, `updated_at`, `updated_by` (who last saved the recipe). Kept out of `menu_variants` so the POS tables stay unchanged.

Functions and views:

- `item_standard_cost(item_id) returns numeric` (RM per base unit; null when unknown; raises for callers without `manage_procurement`). Any other item: `latest_price / conversion_rate`. Item with a current recipe (`recipes` row with status `active` and the latest `effective_from` on or before today, as the prep screens use; normally `semi_finished`): sum(line qty × standard cost) ÷ `yield_qty`, recursively (prep inside prep), depth-limited to 5; null if any line's cost is null.
- `menu_variant_costs` view (security_invoker): `variant_id`, `product_id`, `category_id`, `price_sen`, `line_count`, `cost_rm` (null when any line has no cost), `missing_cost_items` (count), `food_cost_bp` (= cost ÷ price, null when no recipe/cost/price), `target_food_cost_bp`, `over_target` boolean.
- `modifier_option_costs` view: `option_id`, `cost_delta_rm` (may be negative), `price_delta_sen`, `missing_cost_items`.

RPCs (SECURITY DEFINER, `set search_path = public, pg_temp`, `manage_procurement`):

- `save_variant_recipe(p_variant_id uuid, p_lines jsonb)` — replaces the variant's lines (`[{item_id, qty_base}]`, array order = sort order), validates items exist and qty > 0, stamps `menu_recipe_meta`.
- `save_modifier_recipe(p_option_id uuid, p_lines jsonb)` — same for an add-on; qty may be negative but not zero.
- `copy_variant_recipe(p_from_variant uuid, p_to_variant uuid)` — overwrites the target with the source's lines.
- `set_category_target(p_category_id uuid, p_target_bp integer)` — null clears.
- `item_standard_costs(p_item_ids uuid[])` returns `(item_id, unit_cost)` — for the editor's live cost.

## Screens (Craft OS back office, English copy, `manage_procurement`)

- **Menu Costing** (`/procurement/menu-costing`): grouped by menu category (with its target), each product's variants as rows showing price, cost, food cost %, and a status chip: **No recipe**, **Missing price** (an ingredient without a cost), **Over target**. Filter by status, sort by food cost % (worst first). Phone-friendly cards, table on desktop.
- **Recipe editor** (`/procurement/menu-costing/:variantId`): variant name, price, live cost and food cost %. Ingredient lines with item search, quantity entered as packs + loose (same entry as the stock count; this branch does not have the stocktake code, so the small helpers live in `src/shared/lib/menuCosting.ts` — fold them together once both branches reach main), line cost, remove. **Copy from** another variant of the same product. Below: the product's add-on options with their own lines (add / remove quantities) and cost delta. Save per recipe; unsaved changes warn on leave.
- Nav entry **Menu Costing** under Inventory, `manage_procurement`.

## Edge cases

- Item price changes → costs change on next read (views are live); no stored cost to go stale.
- Inactive items stay in recipes but are flagged (they still have a price); inactive variants/options are hidden from the list but keep their recipes.
- Prep loops (A uses B uses A) cannot occur from the prep-recipe editor, but `item_standard_cost` stops at depth 5 and returns null.
- A variant price of 0 → food cost % null ("No price").

## Testing

- `supabase/VERIFY-2026-11-22-menu-costing.sql` on dev (raises its report so everything rolls back): standard cost for raw and prep items (incl. nested prep), null propagation, variant cost and food cost %, swap modifier with negative line, copy recipe, target and over-target flag, non-manager refused on every RPC and view, anon refused.
- Vitest for the pure cost helpers used by the editor (line cost, totals, food cost %, packs/loose entry).
- Browser check on dev at phone and desktop size: list, edit a recipe, copy Hot → Cold, add a swap add-on.
