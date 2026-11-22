# Stocktake — design

Date: 2026-11-22. Owner approved the design in chat on 2026-11-22.
Branch: `feature/stocktake` (from main 2156d7d). Dev first (`egznnbjmicebbhwasloy`); prod only after the owner says so.

## Why

Inventory v2 (live since 2026-10-30) records stock in, wastage, transfers and production, but POS sales do not deduct stock yet. Stock on hand therefore drifts, and the only way to correct it is a stock count. A count also gives each branch its opening stock once items are imported.

## Owner decisions (2026-11-22)

1. **Cadence:** key items weekly, every item monthly. A count is either `weekly` (carried items flagged as key items) or `full` (every carried item).
   **Scope (decided 2026-11-22):** items are global (one catalogue for all branches), so a count at a branch covers only the items that branch *carries*: active AND (linked to an active storage location of that branch OR its stock balance there — sum of `inventory_transactions.quantity` for item + branch — is not zero). This replaced the earlier "every active item" / "every active key item". The rule lives in one SQL helper, `stock_count_scope_for(branch, kind)`, used by `start_stock_count`, `submit_stock_count` and `stock_count_scope`.
   **Nothing counted is lost (decided 2026-11-22):** a count covers its scope PLUS any active item with at least one entry in that count (`stock_count_items_for`, used by `stock_count_scope` and the submit write loop); the missing-spots check uses the scope alone.
2. **No approval step:** submitting a count adjusts stock immediately. Managers review the variance afterwards.
3. **Blind count:** the counting screen never shows the system quantity. Expected quantity and variance appear only after submit.
4. **Ordered by storage location:** each branch has its own locations (Chiller 1, Freezer, Dry Store, Bar …); the count list is grouped by location in walking order.

## Out of scope

POS sales depletion, manager approval, barcode scanning, freezing stock movements during a count, recounting part of a submitted count, editing a submitted count.

## Data model

New tables (all RLS on, reads follow `can_access_branch`, writes only through RPCs):

- `storage_locations` — `id`, `branch_id`, `name`, `sort_order`, `is_active`, `created_at`. Unique (`branch_id`, lower(`name`)).
- `item_locations` — `item_id`, `location_id`, `sort_order`; primary key (`item_id`, `location_id`). An item can sit in several locations at one branch (milk in the Bar chiller and the back chiller). An item with no location at a branch appears under **Unassigned** at the end of that branch's list.
- `stock_counts` — `id`, `branch_id`, `kind` (`weekly` | `full`), `status` (`in_progress` | `submitted` | `cancelled`), `started_by`, `started_at`, `submitted_by`, `submitted_at`, `business_date` (set on submit with `business_date_of`), `notes`, `gain_value`, `loss_value`, `net_value` (RM, set on submit). At most one `in_progress` count per branch (partial unique index).
- `stock_count_entries` — the raw counts as people enter them: `count_id`, `item_id`, `location_id` (null = Unassigned), `counted_base` (numeric ≥ 0, base units), `counted_by`, `counted_at`. Unique (`count_id`, `item_id`, coalesce(`location_id`)). Saved one at a time while counting, so a dropped connection or closed tab loses nothing and several people can count different locations at once.
- `stock_count_items` — the result, written on submit, one row per item: `count_id`, `item_id`, `counted_base` (sum over locations), `expected_base`, `variance_base`, `unit_cost`, `variance_value`, `transaction_id`.

Changes to existing objects:

- `items.count_weekly boolean not null default false` — the "Key item" flag.
- `inventory_transactions.transaction_type` gains `stocktake` (the check constraint keeps every existing type: `stock_in`, `adjustment`, `wastage`, `transfer_out`, `transfer_in`, `production_out`, `production_in`). `reference_type = 'stock_count'`, `reference_id = stock_counts.id`.

## RPCs (SECURITY DEFINER, `use_procurement` capability, branch checked with `can_access_branch`)

- `save_storage_location(id, branch_id, name, sort_order, is_active)`, `set_location_items(location_id, item_ids[])` (replaces that location's item list, in walking order), `set_item_count_weekly(item_id, value)` — manager+ (`manage_procurement`). Locations are deactivated, never deleted.
- `start_stock_count(branch_id, kind)` → count id. Fails if the branch already has an in-progress count (returns that count's id in the error so the screen can open it). Refuses an empty scope: weekly "No key items yet. A manager marks key items under Locations & key items."; full "No items to count at this branch yet. Give items a storage location under Locations & key items."
- `stock_count_scope(count_id)` → set of item ids the count covers (its branch and kind), computed live. Ids only, so the counting screen stays blind. `use_procurement` + `can_access_branch`. The helper `stock_count_scope_for(branch_id, kind)` is internal (not executable by clients).
- `save_count_entry(count_id, item_id, location_id, counted_base)` — upsert; only while `in_progress`; `counted_base ≥ 0`. A null `counted_base` deletes the entry (clears a mistaken number).
- `cancel_stock_count(count_id)` — only while `in_progress`; started_by or manager+.
- `submit_stock_count(count_id)`:
  1. Lock the count row; it must be `in_progress`.
  2. Build the item list from the scope (decided 2026-11-22): `full` = every item the branch carries; `weekly` = carried items with `count_weekly`. Carried = active AND (linked to an active location at the count's branch OR non-zero balance there). Entries for items outside the scope are ignored. Every listed item must have an entry (0 is valid) at every active location at the count's branch it is linked to; an item linked to no active location there needs an entry with `location_id` null (Unassigned) or, to tolerate layout changes mid-count, any entry at all. Entries at other locations still add to the item's total. Otherwise raise "N spot(s) not counted yet" (the screen lists them). Decided 2026-11-22 so a spot nobody counted is not silently written off as a loss.
  3. Per item, take the same advisory lock key as the other stock-out paths (`'stock_out:'||item||':'||branch`), then `expected_base` = current balance at the branch, `variance_base = counted − expected`.
  4. Unit cost = `inventory_avg_unit_cost(item, branch)`; if the branch holds no stock, fall back to `latest_price / conversion_rate`. A gain at this cost leaves the moving average unchanged.
  5. When `variance_base ≠ 0`, insert one `stocktake` ledger row with `quantity = variance_base` and the stamped `unit_cost`. Afterwards the balance equals the counted quantity, so it is never negative.
  6. Write `stock_count_items`, the RM totals, `submitted_by/at`, `business_date`; set status `submitted`.
  All in one transaction.

The existing stock-out guard only checks `adjustment` rows, so it does not block `stocktake` rows; step 5 cannot make a balance negative anyway.

## Screens (phone first, English copy, existing Stepper / sticky-bar patterns)

- **Procurement → Stock Count** (list): branch picker (`useBranchPicker`), an in-progress count card ("Resume · Weekly · 23/40 counted"), **Start weekly count** / **Start full count**, and history (date, kind, who, items, net RM coloured loss/gain).
- **Counting screen:** location tabs in `sort_order`, then Unassigned; progress per tab ("Chiller 1 · 12/18") and overall. Each item card shows name, pack size and two inputs, **packs** and **loose** in base units (e.g. 3 pack + 250 g); the total in base units is saved on blur. No system quantity anywhere. A **Not counted** filter jumps to gaps. Sticky bar: overall progress ("N of M spots counted", a spot being an item at one linked location) and **Submit count** (disabled until every linked location of every item has a number, 0 allowed, so an uncounted spot is not written off (decided 2026-11-22); the confirm sheet says stock will be set to these numbers).
- **Result screen** (after submit, also opened from history): totals (loss, gain, net RM), then items sorted by |variance value| descending: counted, expected, variance in packs + base units, RM.
- **Setup** (`/procurement/stock-counts/setup`, managers only, one phone screen): per branch, storage locations (add, rename, move up/down, deactivate); tap a location to tick the items kept there; a **Key items** list to tick the items counted weekly.

Supervisors see only their own branch; managers see all branches (same rule as the rest of procurement, `seesAllBranches`).

## Edge cases

- An item added after a count started is included at submit if it matches the kind and the branch carries it (scope is computed live), so it must be counted before submit.
- An item the branch does not carry (no location there, zero balance) never appears; to count stock found of such an item, a manager first gives it a location at that branch.
- Inactive items are left out of new counts; entries already saved for them are ignored.
- Two people entering the same item and location: last save wins (the entry shows who counted it).
- Counting while trading: expected stock is taken at submit, so receiving or wastage logged during the count is reflected. Staff are told to count before opening or after closing.

## Testing

- `supabase/VERIFY-2026-11-22-stocktake.sql` on dev (raises its report so everything rolls back): loss and gain rows, zero variance writes no ledger row, uncounted item blocks submit, one in-progress count per branch, entries locked after submit, supervisor blocked from another branch, anon blocked, moving average unchanged after a gain, fallback cost when the branch holds no stock.
- Vitest for packs + loose ↔ base conversion and the progress counts.
- Browser check on dev at phone size: start, count across two locations, submit, read the result.
