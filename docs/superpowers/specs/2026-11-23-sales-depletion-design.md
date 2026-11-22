# POS sales depletion and usage variance — design

Date: 2026-11-23. Owner approved the design in chat on 2026-11-23.
Branch: `feature/sales-depletion`, cut from `feature/menu-costing` (98c1787) with `main` merged in (stocktake). Dev first (`egznnbjmicebbhwasloy`); production only with the POS rollout and the owner's go-ahead.

## Why

Menu recipes (menu costing) say what each menu size and add-on uses. Stock counts (live since 2026-11-23) correct stock to what is on the shelf. Joining them: every paid POS bill deducts its ingredients, so the gap a stock count then finds is the unexplained loss (waste not logged, over-portioning, unrecorded sales). The usage variance report shows that gap per ingredient in RM.

## Owner decisions (2026-11-23)

1. **Deduct when the bill is paid** — only lines not voided. Lines voided before payment do not deduct; if the kitchen had already made them, the loss shows up as unexplained at the next count.
2. **Refunds do not return stock** — refunds stay money-only.
3. **Build the variance report in the same round.**
4. **Wastage may exceed the system on-hand** (stock may go negative, like sales); HQ shipping, production and manual negative adjustments keep their on-hand guards — `migration-2026-11-23-wastage-allow-negative.sql` (`log_wastage` without the on-hand refusal).

Decided by Claude (owner allows small decisions):
- One `sale` ledger row per ingredient per bill, costed at the branch's moving average (`inventory_avg_unit_cost`'s formula, computed once per bill in `deplete_bill`).
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
     **Cost precompute (2026-11-23 review):** the moving-average cost of every item in the bill is computed once, in one aggregate over the item set (same formula and fallbacks as `inventory_avg_unit_cost`; the helper is called only for items with no stock held at the branch), and each row is inserted with an explicit `unit_cost`, so `stamp_inventory_unit_cost` skips its per-row full-history lookup inside checkout. A covering index `inventory_transactions_item_branch_cover_idx (item_id, branch_id) include (quantity, unit_cost)` makes these lookups index-only.
  3. Count lines (not voided) whose variant has no recipe lines → `lines_without_recipe`.
  4. Insert `bill_depletions (status 'done')`.
- Trigger `bills_deplete_on_paid` — AFTER UPDATE OF status ON bills, `when (new.status = 'paid')`: calls `deplete_bill` inside `BEGIN … EXCEPTION WHEN OTHERS` — on error, insert `bill_depletions (status 'error', error = SQLERRM)` (itself inside a nested `BEGIN … EXCEPTION WHEN OTHERS THEN NULL`, so the marker can never block payment) and return normally so checkout commits.
  **Trigger condition (2026-11-23 review):** deliberately *not* "a transition to paid". Split-by-item parts (`checkout_items`) are inserted already `paid` with no lines, the lines are moved onto them, then `pos_pay_and_close` updates them to `paid` again — `old.status` is already `paid`, so a transition condition never fired for them. `deplete_bill`'s marker check and the `bill_depletions` primary key keep it to once per bill. No AFTER INSERT trigger (at insert the part has no lines).
- The stock-out guard trigger (adjustments only) does not apply to `sale` rows.

## Variance report (SQL)

`stock_count_usage(p_count_id uuid)` — SECURITY DEFINER, `use_procurement` + `can_access_branch`; returns rows per item for a **submitted** count C at branch B, over the period from the previous submitted count at B (`submitted_at` before C's) to C's `submitted_at` (if no previous count: from C's `submitted_at − 30 days`, flagged `period_from_previous = false`):
- `item_id`, `sold_base` (−sum of `sale` rows in the period, base units), `sold_value` (−sum quantity×unit_cost), `wasted_base`, `wasted_value` (from `wastage` rows), `unexplained_base` / `unexplained_value` = C's `stock_count_items.variance_base` / `variance_value` for the item (0 if the item was not in C), `unexplained_pct` = unexplained loss ÷ sold (null when sold is 0).
- Per-item start (2026-11-23, owner's delegate): weekly counts cover only key items, so each item's window starts at the latest earlier submitted count at the branch that contains the item, falling back to the summary-level start above; rows add `period_start` and `counted` (item in C; `unexplained_pct` is null when not counted). Summary totals are the sum of the per-item rows and add `rows_without_cost`.
- Bounds (2026-11-23): items not in C use the summary-level start; no window reaches back more than 180 days before C's `submitted_at`; the ledger index is partial (sale/wastage rows only).
- Plus summary: period start/end, totals in RM, `bills_paid`, `lines_without_recipe` (sum from `bill_depletions` in the period), `depletion_errors` count.
- **Partial period (2026-11-23 review):** `depletion_started_at` = the earliest `bill_depletions.depleted_at` at the branch (null if none) and `partial_period` = true when it is null or later than the window's start (the earliest counted item's start, never later than `period_start`). Sales before deduction began were never deducted, so the first count after go-live would show them as unexplained loss; the screen says so.

`stock_count_unrecipe_sales(p_count_id uuid)` — same access and period; returns menu product/variant name and quantity sold for paid, non-voided lines whose variant has no recipe lines (top 50 by quantity).

## Screen (English copy)

On the stock count result view (`StockCountResult`), a new section **Since last count** below the variance list:
- period line ("22 Nov 02:32 → 30 Nov 23:10 · 412 bills paid", "1 bill paid"), totals: Sold RM, Wasted RM, Unexplained signed (−RM red for a loss, +RM green for a gain, neutral at 0);
- when `partial_period`: "Sales deduction started <date> — sales before that are not included, so this period's unexplained figure is overstated." (or "Sales deduction has not started at this branch yet" when there is no start);
- table/cards per ingredient sorted by unexplained RM loss: sold, wasted, unexplained (qty + RM + % of sold);
- a warning box when there are lines sold without a recipe ("38 order lines had no recipe, so usage is understated." — it counts lines, not units) with the top dishes, linking managers to Menu Costing;
- a warning when depletion errors happened in the period ("2 paid bills could not deduct stock. Ask a manager to check.").

## Edge cases

- Split bills / part payments: depletion runs when the bill itself becomes `paid` (once). Split-by-item parts are inserted already `paid` and set `paid` again after their lines move on — the trigger condition covers this (see Depletion).
- Merged bills: the source bill never becomes `paid`; its lines move to the target bill, which deducts them.
- Recipe changes after a sale do not change past `sale` rows (quantities are fixed at payment).
- An item inactive later still deducts if it is in a recipe.
- Bills on a branch with no items/recipes: depletion inserts nothing and records `lines_without_recipe`.

## Testing

- `supabase/VERIFY-2026-11-23-sales-depletion.sql` on dev (raises its report so it rolls back): paying a bill writes the expected `sale` rows (variant + add-on incl. a negative swap line), voided lines excluded, second payment transition does not double-deduct, a split part inserted `paid` then set `paid` again deducts once, the real `checkout_items` RPC (as a POS tablet) deducts the paid part only, `partial_period`, a recipe error does not block the status change and records `error`, the merged source bill deducts nothing, anon/authenticated cannot call internal functions, `stock_count_usage` numbers for a fixture with two counts, a sale and a wastage.
- Vitest for pure formatting/sorting helpers of the usage section.
- Browser check on dev: pay a POS bill for an item with a recipe, see stock drop, submit a count, read "Since last count".

## Prod rollout

1. Confirm POS, menu costing and stocktake are live on prod (the depletion migration's guard refuses otherwise).
2. Recipes entered in Menu Costing for the menu (lines without a recipe deduct nothing).
3. Pick a quiet window (outside trading hours): both migrations `set lock_timeout = '5s'` and fail fast rather than queue behind checkouts; just retry.
4. Apply `migration-2026-11-23-stock-count-usage.sql` (ledger index), then `migration-2026-11-23-sales-depletion.sql` (constraint, covering index, trigger), then `migration-2026-11-23-wastage-allow-negative.sql` (changes behaviour already live on prod: wastage no longer refused above on-hand) — one transaction each. Never re-run `migration-2026-10-29-owner-decisions.sql` afterwards (it puts the refusal back).
5. Immediately run a baseline **full** count per branch, so the first "Since last count" window starts after deduction began (otherwise it is a partial period).
6. Deploy the frontend.
7. For a week, watch `bill_depletions` for `status = 'error'` rows and checkout latency.
8. Never re-run an older migration that rebuilds `inventory_transactions_transaction_type_check` (they would drop `sale` and later sales would fail into `bill_depletions` errors).
