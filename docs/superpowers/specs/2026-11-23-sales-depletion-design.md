# POS sales depletion and usage variance — design

Date: 2026-11-23. Owner approved the design in chat on 2026-11-23.
Branch: `feature/sales-depletion`, cut from `feature/menu-costing` (98c1787) with `main` merged in (stocktake). Dev first (`egznnbjmicebbhwasloy`); production only with the POS rollout and the owner's go-ahead.

## Why

Menu recipes (menu costing) say what each menu size and add-on uses. Stock counts (live since 2026-11-23) correct stock to what is on the shelf. Joining them: every paid POS bill deducts its ingredients, so the gap a stock count then finds is the unexplained loss (waste not logged, over-portioning, unrecorded sales). The usage variance report shows that gap per ingredient in RM.

## Owner decisions (2026-11-23)

1. **Deduct when the bill is paid** — only lines not voided. Lines voided before payment do not deduct; if the kitchen had already made them, the loss shows up as unexplained at the next count.
2. **Refunds do not return stock** — refunds stay money-only.
3. **Build the variance report in the same round.**

Decided by Claude (owner allows small decisions):
- One `sale` ledger row per ingredient per bill, costed at the branch's moving average (`inventory_avg_unit_cost`, stamped by the existing trigger).
- Stock may go negative from sales; sales are never blocked.
- Depletion never blocks checkout: on any error the payment still completes and the error is recorded for the report.
- No back-fill: bills paid before the depletion migration are not deducted.
- Variance report lives on the stock count result page ("Since last count"), same access as stock counts.

## Out of scope

Grab orders (not POS bills yet), refund stock returns, back-filling old bills, per-branch catalogs/recipes, editing or reversing a deduction (a stock count corrects stock).

## Data model (SQL, dev first)

- `inventory_transactions.transaction_type` gains `sale` (keep all eight existing types: `stock_in`, `adjustment`, `wastage`, `transfer_out`, `transfer_in`, `production_out`, `production_in`, `stocktake`). `reference_type = 'bill'`, `reference_id = bills.id`.
- `bill_depletions` — `bill_id` primary key → `bills`, `branch_id`, `depleted_at`, `status` (`done` | `error`), `error text`, `lines_without_recipe int`. One row per paid bill once depletion ran; the primary key makes depletion run once per bill.
- RLS: select for `use_procurement` + `can_access_branch(branch_id)`; no client writes.

## Depletion (SQL)

- `deplete_bill(p_bill_id uuid)` — SECURITY DEFINER, internal (revoked from public/anon/authenticated). For the bill (status `paid`) and only if no `bill_depletions` row exists:
  1. Ingredient quantities = for each `order_items` row of the bill with `voided_at is null`: `qty ×` the variant's `menu_variant_recipe_lines.qty_base`, plus for each element of `modifiers_snapshot` with an `optionId`: `qty ×` that option's `modifier_recipe_lines.qty_base` (negative lines reduce, e.g. a swap). Sum per item.
  2. For each item with a non-zero total: insert one `sale` row with `quantity = −total` (a net negative modifier total that exceeds the variant's use inserts a positive row — allowed, it is still a `sale`), `reference_type 'bill'`, `reference_id` the bill, branch = `bills.branch_id`.
  3. Count lines (not voided) whose variant has no recipe lines → `lines_without_recipe`.
  4. Insert `bill_depletions (status 'done')`.
- Trigger `bills_deplete_on_paid` — AFTER UPDATE OF status ON bills, when `old.status <> 'paid' and new.status = 'paid'`: calls `deplete_bill` inside `BEGIN … EXCEPTION WHEN OTHERS` — on error, insert `bill_depletions (status 'error', error = SQLERRM)` and return normally so checkout commits.
- The stock-out guard trigger (adjustments only) does not apply to `sale` rows.

## Variance report (SQL)

`stock_count_usage(p_count_id uuid)` — SECURITY DEFINER, `use_procurement` + `can_access_branch`; returns rows per item for a **submitted** count C at branch B, over the period from the previous submitted count at B (`submitted_at` before C's) to C's `submitted_at` (if no previous count: from C's `submitted_at − 30 days`, flagged `period_from_previous = false`):
- `item_id`, `sold_base` (−sum of `sale` rows in the period, base units), `sold_value` (−sum quantity×unit_cost), `wasted_base`, `wasted_value` (from `wastage` rows), `unexplained_base` / `unexplained_value` = C's `stock_count_items.variance_base` / `variance_value` for the item (0 if the item was not in C), `unexplained_pct` = unexplained loss ÷ sold (null when sold is 0).
- Plus summary: period start/end, totals in RM, `bills_paid`, `lines_without_recipe` (sum from `bill_depletions` in the period), `depletion_errors` count.

`stock_count_unrecipied(p_count_id uuid)` — same access and period; returns menu product/variant name and quantity sold for paid, non-voided lines whose variant has no recipe lines (top 50 by quantity).

## Screen (English copy)

On the stock count result view (`StockCountResult`), a new section **Since last count** below the variance list:
- period line ("22 Nov 02:32 → 30 Nov 23:10 · 412 bills"), totals: Sold RM, Wasted RM, Unexplained RM (red when a loss);
- table/cards per ingredient sorted by unexplained RM loss: sold, wasted, unexplained (qty + RM + % of sold);
- a warning box when there are lines sold without a recipe ("38 items sold had no recipe — usage is understated") with the top dishes, linking managers to Menu Costing;
- a warning when depletion errors happened in the period.

## Edge cases

- Split bills / part payments: depletion runs when the bill itself becomes `paid` (once).
- Merged bills: the source bill never becomes `paid`; its lines move to the target bill, which deducts them.
- Recipe changes after a sale do not change past `sale` rows (quantities are fixed at payment).
- An item inactive later still deducts if it is in a recipe.
- Bills on a branch with no items/recipes: depletion inserts nothing and records `lines_without_recipe`.

## Testing

- `supabase/VERIFY-2026-11-23-sales-depletion.sql` on dev (raises its report so it rolls back): paying a bill writes the expected `sale` rows (variant + add-on incl. a negative swap line), voided lines excluded, second payment transition does not double-deduct, a recipe error does not block the status change and records `error`, the merged source bill deducts nothing, anon/authenticated cannot call internal functions, `stock_count_usage` numbers for a fixture with two counts, a sale and a wastage.
- Vitest for pure formatting/sorting helpers of the usage section.
- Browser check on dev: pay a POS bill for an item with a recipe, see stock drop, submit a count, read "Since last count".
