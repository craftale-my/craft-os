# POS Split Bill and Move Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a table pay in parts the Feedme way: by item (the paid units become their own paid bill, Part A), equally or by amount (part payments on the open bill, Part B), and move selected items to another table.

**Architecture:** Part A adds one migration (`supabase/migration-2026-11-16-pos-split-bill.sql`) with a server-priced preview (`pos_split_totals`), a one-call split payment (`checkout_items`, which inserts an already-paid bill and moves the chosen units to it) and `move_items`; checkout_bill's payment-writing code moves into shared helpers so both paths can never drift. The client gets a pure selection module, a picker screen and a split mode of the existing Payment screen. Part B adds a second migration (`supabase/migration-2026-11-17-pos-bill-parts.sql`) with `bill_parts`, `pos_part_quote` and `pay_bill_part`; `checkout_bill` takes the balance; guards stop anything that could make a paid part exceed the bill. The app works after Part A alone.

**Tech Stack:** Supabase Postgres (plpgsql / sql functions, RLS), React 19 + TypeScript + Vite + Tailwind, vitest + @testing-library/react (jsdom).

**Spec (the requirements):** `docs/superpowers/specs/2026-11-16-pos-split-bill-design.md`. Read it before any task.

## Global Constraints

- UI copy in English.
- Money in integer sen.
- Every new RPC security definer, set search_path = public, pg_temp, revoke from public/anon, grant to authenticated only (except none here are anon).
- Dev only; never prod.
- No bare git stash.
- Commit trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Every UI string exactly as in the spec §7 and §3.5.
- Run every command from the worktree `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo` (branch `feature/pos-demo`). Never `cd` to the main checkout.
- PROD (`yfsoesxzurzjdwstszru`) is never touched. SQL goes to the DEV project only (`egznnbjmicebbhwasloy`), through the procedure in `/private/tmp/claude-502/-Users-USER-Desktop-Craft-OS/61468934-8271-4d57-a865-7622f45e3055/scratchpad/dev-sql-howto.md`.
- Internal SQL helpers (not RPCs) are `revoke all … from public, anon, authenticated` and never granted.
- Every `UPDATE` / `DELETE` inside a function has a `WHERE` (pg-safeupdate; `src/features/pos/sqlSafeUpdate.test.ts` scans every `migration-*-pos-*.sql`).
- Re-created functions keep their exact live text except the lines marked with this plan's marker (`-- S…` in Part A, `-- B…` in Part B).

UI strings from the spec, used verbatim (do not reword):
`Split / Move items`, `Pay selected`, `Move to table`, `Select all`, `Clear`, `2 of 3` (`<k> of <q>`), `Split needs a connection`, `Remove the bill discount before moving items`, `The bill changed. Check the items again.`, `Moved 2 items to T7` (`Moved <n> item(s) to <table>`), `Split from <bill no> · <table>`, `Table T5 · Split`, `By item`, `Equally`, `By amount`, `Split into N`, `Share 1 of 3 · RM 23.45`, `25%` / `33%` / `50%`, `Paid 1 of 3 · RM 23.45 (Cash)`, `Balance due`, `Part paid · RM 23.45`, `This bill has a part payment. Pay the rest first.`, `Part 2 of 3` / `Part 2`, `Paid before`, `Part payment — the official receipt prints when the bill is paid in full.`

## Spec notes (gaps and the decisions taken)

1. **No `opened_by` on bills.** §4.4 says a new target bill is "opened by the actor", but `bills` has no opener column (open_table records none either). `move_items` inserts the bill like `open_table` does; nothing else is recorded.
2. **One input builder.** `pos_bill_totals` is re-created as `pos_compute_bill(pos_bill_input(id))`, and `pos_split_input` starts from `pos_bill_input`, so the part is priced with exactly the same settings, rules, `orderType` and `tableId` (§4.2). Numbers do not change (the discounts verify re-run proves it).
3. **The paid part's frozen totals are the preview's.** `checkout_items` validates the payments against `pos_compute_bill(pos_split_input(...))` — the numbers `pos_split_totals` showed — and freezes those, with the cut rows' new ids written into `totals.lines` (the receipt and the Z report read line discounts by id). Recomputing after the move could, in rare cases, land a bill discount's leftover sen on another line (cut rows get new ids, lines are ordered by id) and differ by a sen from what the cashier was shown.
4. **Following a split payment.** `pos_checkout_state.result` also returns a paid part of this bill paid under one of the given checkout ids, and `followBill` treats an open bill with a result as "paid here". Without it, Check bill after a lost reply would find the table bill still open and unlock with a new id, and the part could be paid twice. Split checkout ids are kept apart from whole-bill ids in PosTill (key `split:<billId>`).
5. **Z report sources by item.** `pos_shift_report.sources` counted orders by `orders.bill_id`; split and moved units keep their `order_id`, so a paid part's items would be missed (or counted on the wrong shift). Sources now count by `order_items.bill_id` (orders = distinct orders with an item on a shift bill). Kitchen VOID tickets keep printing the order's original table (`pos_queue_void_tickets` unchanged — the kitchen matches the void to the original ticket).
6. **Selection limits.** A qty that is not a whole number from 1 to 100 is `Invalid selection` (keeps the casts safe); a qty above the line's qty is `The bill changed. Check the items again.` as §4.2 says.
7. **Discount log rows.** Only bill-discount changes are logged with `action = 'split'` (§5 names bill rows). When the table bill's amount discount is used up, its row is `kind 'amount', value 0`. Item-discount shares are not logged.
8. **One guard for split paths.** Part B's part-payment guard sits in `pos_split_check`, so `pos_split_totals` (the picker preview) refuses too, besides `checkout_items` and `move_items`. `clear_item_discount` / `clear_bill_discount` are not guarded (they only raise the balance; §4.6 does not list them).
9. **`bill_parts` extras.** It gets `receipt_queued boolean not null default false` (a replay must answer `receiptQueued`), and `device_id` references `pos_devices(id) on delete set null` like `payments.device_id`.
10. **Quote details.** `pos_part_quote(…, null)` returns `ways` and `shareSen` null even when an equal split is fixed (the by-amount view); the client reads the fixed N from the parts list. The share formula counts only equal shares paid (`sharesPaid`, an extra reply field), so by-amount parts paid earlier just lower the balance that the remaining shares divide.
11. **Part replays.** A part id already used on another bill gives `This part id belongs to another bill` (as checkout ids do); an amount below 1 sen gives `Invalid payment amount`; a 21st part gives `Too many parts on one bill`.
12. **Change on a bill with parts.** `pos_checkout_result.changeSen` and the final receipt's `changeSen` count only the final checkout's payments; on the final receipt a part's cash payment prints its amount, not the cash received (each part receipt already showed its own change).
13. **By amount input.** The amount is typed in an `Amount (RM)` decimal field with the 25% / 33% / 50% chips; the number pad stays what it is today (cash received / split tender amount).
14. **Labels the spec does not give:** a by-amount part reads `Paid part 2 · RM 10.00 (Card)`; after a part is paid the screen shows `Part 1 paid · RM 23.45 · Change RM 26.55`; the item-move grid hint is `an empty table gets a new bill, a table with a bill takes the items`.
15. **Printer ASCII.** The receipt printer is ASCII-only: `·` is mapped to `-`, so `Split from 261116-009 · T5` prints as `Split from 261116-009 - T5`.
16. **Entry rules.** Split / Move items with unsent items on the order screen asks to discard them first (as Move does). "Pay selected" is disabled with no open shift (`Open a shift to take payment`, as the Payment button). By item in Part B's Split row is disabled when the bill has a part payment or fewer than two units.
17. **Offline.** `PosTill` gets an `online` prop from the POS app (`useOnline`); Craft OS `/pos` passes nothing (treated as online).
18. **Moves.** A takeaway bill's items may move to a table (they keep `order_type 'takeaway'`, like a merge); moving into a bill with a part payment is allowed (it only adds items).
19. **Order screen Payment button** shows the balance (total − part payments) once a bill has parts.
20. **Verify re-runs.** "The existing checkout verify vectors pass" (§8) is checked by re-running `migration-2026-10-24-pos-checkout-verify.sql`, `migration-2026-10-25-pos-hardening-verify.sql` (both made to accept the discount keys in e0383d1 / 5646307), `migration-2026-10-29-pos-device-till-verify.sql` and `migration-2026-10-30-pos-discounts-verify.sql` (vectors, checkout, merge, discounts). Take a baseline of all four on dev before the first SQL task; after A1, A2 and B2 each must give the same result as its baseline.

## File structure

| File | Task | Responsibility |
|---|---|---|
| `supabase/migration-2026-11-16-pos-split-bill.sql` (new) | A1–A4 | Part A schema and functions; each task appends its section |
| `supabase/migration-2026-11-16-pos-split-bill-verify.sql` (new) | A1–A4 | Part A self-check; one DO block per section, ids in a temp table |
| `supabase/migration-2026-11-17-pos-bill-parts.sql` (new) | B1–B3 | Part B schema and functions |
| `supabase/migration-2026-11-17-pos-bill-parts-verify.sql` (new) | B1–B3 | Part B self-check |
| `src/features/pos/print/receipt.ts` (+ test) | A4, B3 | `splitFrom` line; part receipt; part labels on payments |
| `src/features/pos/print/printJob.ts` (+ test) | B3 | the `part` print kind |
| `src/features/pos/order/splitSelection.ts` (new, + test) | A5 | pure selection state and copy |
| `src/features/pos/order/SplitItemsScreen.tsx` (new, + test) | A5 | the item picker |
| `src/features/pos/order/moveTargets.ts`, `MoveToGrid.tsx` (+ tests) | A5 | item-move targets, grid hint |
| `src/features/pos/order/posApi.ts` | A5 | `moveItems` |
| `src/features/pos/checkout/checkoutApi.ts` | A5, A6, B4 | `splitTotals`, `checkoutItems`, `partQuote`, `payBillPart` |
| `src/features/pos/checkout/follow.ts` (+ test) | A6, B4 | open bill with a result = paid here; `paidSen` / `parts` |
| `src/features/pos/checkout/PaymentScreen.tsx` (+ test) | A6, B4 | split mode; Split row, part payments |
| `src/features/pos/order/billActions.ts`, `ActionsOverlay.tsx`, `BillActionsOverlay.tsx`, `OrderScreen.tsx`, `posScreen.ts`, `PosTill.tsx`, `src/pos/PosApp.tsx` | A7 | entry and routing |
| `src/features/pos/checkout/partSplit.ts` (new, + test) | B4 | pure Part B state, labels, parsers |
| `src/features/pos/order/billSummaries.ts`, `HomeScreen.tsx`, `BillColumn.tsx` (+ tests) | B5 | "Part paid · RM x" |

## How SQL tasks run (every SQL task)

1. Apply the whole migration file on dev via the procedure in `dev-sql-howto.md` (it is idempotent; each task's section was appended to it). Expected result row: the file's last `select '… applied' as result`.
2. Run the whole verify file the same way. Expected result: `VERIFY OK`. A failure shows `ERROR: FAIL <label>: …` — fix and run both again.
3. `npx vitest run src/features/pos/sqlSafeUpdate.test.ts` → PASS.

Before Task A1 (once): run `supabase/migration-2026-10-24-pos-checkout-verify.sql`, `supabase/migration-2026-10-25-pos-hardening-verify.sql`, `supabase/migration-2026-10-29-pos-device-till-verify.sql` and `supabase/migration-2026-10-30-pos-discounts-verify.sql` on dev and write down their results (the baseline). Tasks A1, A2 and B2 re-run all four ("the baselines") and each must give the same result as before.

**Shared worktree.** Other sessions work in this worktree (at the time of writing: uncommitted edits in `OrderScreen.tsx`, `BillColumn.tsx`, `BillColumn.test.tsx`, `posApi.ts`, `ProductTiles.tsx`). Before a task, run `git status`; if a file your task touches has changes that are not yours, stop and tell the controller — never stash, revert or commit someone else's changes. Edits in this plan are given by anchor text (not line numbers) for those files, so they apply on top of the other work.

---

### Task A1: Split schema, shared bill input, selection check and `pos_split_totals`

**Files:**
- Create: `supabase/migration-2026-11-16-pos-split-bill.sql`
- Create: `supabase/migration-2026-11-16-pos-split-bill-verify.sql`

**Interfaces:**
- Consumes: `pos_compute_bill(jsonb)`, `pos_my_branch()` (existing).
- Produces (later tasks rely on these exact names):
  - columns `bills.split_from uuid`, `order_items.split_from_item uuid`; `pos_discount_log.action` allows `'split'`
  - `pos_bill_input(p_bill_id uuid) returns jsonb` — the input `pos_bill_totals` computes on (granted to authenticated, like `pos_bill_totals`)
  - `pos_split_line_discount(p_kind text, p_value integer, p_line_qty integer, p_take integer) returns jsonb` — internal; `{kind, value}` or null
  - `pos_split_check(p_bill bills, p_items jsonb) returns integer` — internal; raises the §4.2 messages; returns the units selected
  - `pos_split_input(p_bill_id uuid, p_items jsonb) returns jsonb` — internal; the part's `pos_compute_bill` input; its `billDiscount` is the part's share (object or JSON null)
  - RPC `pos_split_totals(p_bill_id uuid, p_items jsonb) returns jsonb` — a `BillTotals` object
  - verify helpers `pg_temp.id(text) returns uuid`, `pg_temp.put(text, uuid)`, `pg_temp.sel(uuid, integer) returns jsonb`, `pg_temp.card(integer) returns jsonb`, fixture keys listed in Step 1

- [ ] **Step 1: Write the verify file (it fails until the migration exists)**

Create `supabase/migration-2026-11-16-pos-split-bill-verify.sql`:

```sql
-- Self-check for POS split bill and move items (Part A). Run on craft-os-dev after
-- migration-2026-11-16-pos-split-bill.sql. Everything is rolled back. Success = a result row
-- "VERIFY OK". Sections (one DO block each; the fixture's ids are kept in the temp table
-- fixture): FIXTURE; A1 schema, grants, discount shares, preview and selection checks;
-- A2 checkout_items; A3 move_items; A4 receipt and Z report.
-- Numbers: Latte 13.00 and Cake 15.00, both SST 6%; service charge 10% on dine-in; 5 sen rounding.
begin;

-- expect_error(sql, message, label): runs sql and insists it raises exactly message.
create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message using errcode = 'assert_failure';
exception when raise_exception then
  if sqlerrm is distinct from p_message then
    raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
  end if;
end $$;

-- act(user id): the next calls run as this signed-in user (a staff login or a POS device)
create function pg_temp.act(p_user uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

-- the fixture's ids, by name, for every section
create temp table fixture (k text primary key, v uuid);
create function pg_temp.put(p_k text, p_v uuid) returns void
language sql as $$ insert into pg_temp.fixture(k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.id(p_k text) returns uuid
language sql as $$ select v from pg_temp.fixture where k = p_k $$;
-- one p_items entry, and one card payment of an amount
create function pg_temp.sel(p_item uuid, p_qty integer) returns jsonb
language sql as $$ select jsonb_build_object('itemId', p_item, 'qty', p_qty) $$;
create function pg_temp.card(p_sen integer) returns jsonb
language sql as $$ select jsonb_build_array(jsonb_build_object('methodId', pg_temp.id('card'), 'amountSen', p_sen)) $$;

-- ── FIXTURE: outlet VERIFY S with tables S1–S9, Latte 13.00 and Cake 15.00 (SST 6%), service
--    charge 10% on dine-in, a card and a cash method, a cashier and a supervisor with PINs, one
--    tablet with the cashier signed in and a shift open; then these bills:
--    S1 (pax 4): Latte ×3 (L1), Cake ×1 (C1), and a voided Cake (C1v) on a second order
--    S2 (pax 2): Latte ×3 (L2) with an item discount of RM 3.00, Cake ×1 (C2)
--    S3 (pax 2): Latte ×3 (L3) with an item discount of RM 1.00, Cake ×1 (C3)
--    S5 (pax 2): Latte ×3 (L5), Cake ×1 (C5), bill discount RM 10.00
--    S6 (pax 2): Latte ×3 (L6), Cake ×1 (C6), bill discount 10%
--    S9 (pax 1): Latte ×1 (L9)
do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-0000000005a1';   -- cashier of VERIFY S
  v_sup   uuid := 'eeeeeeee-0000-0000-0000-0000000005a2';   -- supervisor of VERIFY S (approves)
  v_dev   uuid := 'eeeeeeee-0000-0000-0000-0000000005a3';   -- a tablet of VERIFY S
  v_a uuid; v_t uuid; v_cat uuid; v_catalog uuid; v_latte uuid; v_latte_v uuid; v_cake uuid; v_cake_v uuid;
  v_order uuid; v_bill uuid; v_res jsonb; v_items jsonb; r record; i integer;
begin
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;                                                                         -- code defaults
  insert into branches(name, address) values ('VERIFY S', 's') returning id into v_a;
  perform pg_temp.put('branch', v_a);
  for i in 1..9 loop
    insert into dining_tables(branch_id, label, sort_order) values (v_a, 'S' || i, i) returning id into v_t;
    perform pg_temp.put('t' || i, v_t);
  end loop;
  insert into print_routes(branch_id, name, kind, address) values (v_a, 'Bar', 'agent', '127.0.0.1:9100');
  insert into branch_pos_settings(branch_id, receipt_route) values (v_a, 'Bar');
  insert into service_charge_rules(branch_id, rate_bp, order_types, sort_order) values (v_a, 1000, array['dine_in'], 1);
  insert into menu_categories(name, sort_order) values ('VERIFY S DRINKS', 900) returning id into v_cat;
  insert into menu_products(name, category_id, sst_rate_bp) values ('Verify S Latte', v_cat, 600) returning id into v_latte;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_latte, '', 'Regular', 1300) returning id into v_latte_v;
  insert into menu_products(name, category_id, sst_rate_bp) values ('Verify S Cake', v_cat, 600) returning id into v_cake;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_cake, '', 'Regular', 1500) returning id into v_cake_v;
  insert into menu_catalogs(name, sort_order) values ('VERIFY S MENU', 900) returning id into v_catalog;
  insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_latte, 'all'), (v_catalog, v_cake, 'all');
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_latte_v, 1300), (v_catalog, v_cake_v, 1500);
  insert into branch_catalogs(branch_id, role, catalog_id) values (v_a, 'dine_in', v_catalog), (v_a, 'takeaway', v_catalog), (v_a, 'qr', v_catalog);
  perform pg_temp.put('catalog', v_catalog);
  perform pg_temp.put('latte', v_latte); perform pg_temp.put('latte_v', v_latte_v);
  perform pg_temp.put('cake', v_cake);   perform pg_temp.put('cake_v', v_cake_v);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_a, 'S Card', 'card', 1) returning id into v_t;
  perform pg_temp.put('card', v_t);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_a, 'S Cash', 'cash', 2) returning id into v_t;
  perform pg_temp.put('cash', v_t);
  update staff set branch_id = v_a where id = v_owner;
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_cash), (v_sup), (v_dev);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_cash, 'Verify S Cashier',    'trainee', true, current_date, 'staff', v_a),
    (v_sup,  'Verify S Supervisor', 'trainee', true, current_date, 'staff', v_a);
  update staff set system_role = 'supervisor' where id = v_sup;
  for r in select * from (values (v_cash, '1111'), (v_sup, '2222')) as x(id, pin) loop
    perform pg_temp.act(r.id);
    if not coalesce((set_my_pos_pin(r.pin, null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: PIN of %', r.id; end if;
  end loop;
  insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by) values (v_dev, v_a, 'pos', 'S Counter', 'ipad', true, v_owner);
  perform pg_temp.put('owner', v_owner); perform pg_temp.put('sup', v_sup); perform pg_temp.put('cashier', v_cash); perform pg_temp.put('dev', v_dev);
  perform pg_temp.act(v_dev);
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: cashier sign-in: %', v_res; end if;
  v_res := open_shift(10000);
  perform pg_temp.put('shift', (v_res->'shift'->>'id')::uuid);

  -- the bills (as the tablet)
  v_items := jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_latte_v, 'qty', 3),
                               jsonb_build_object('productId', v_cake, 'variantId', v_cake_v));
  for r in select * from (values (1, 4), (2, 2), (3, 2), (5, 2), (6, 2)) as x(n, pax) loop
    v_order := place_counter_order(pg_temp.id('t' || r.n), 'dine_in', r.pax, v_items, gen_random_uuid());
    perform pg_temp.put('b' || r.n, (select bill_id from orders where id = v_order));
    perform pg_temp.put('L' || r.n, (select id from order_items where order_id = v_order and product_id = v_latte));
    perform pg_temp.put('C' || r.n, (select id from order_items where order_id = v_order and product_id = v_cake));
  end loop;
  v_order := place_counter_order(pg_temp.id('t1'), 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_cake, 'variantId', v_cake_v)), gen_random_uuid());
  perform pg_temp.put('C1v', (select id from order_items where order_id = v_order));
  v_res := void_order_item(pg_temp.id('C1v'), 'Wrong item keyed', v_sup, '2222');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: void C1v: %', v_res; end if;
  v_order := place_counter_order(pg_temp.id('t9'), 'dine_in', 1,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_latte_v)), gen_random_uuid());
  perform pg_temp.put('b9', (select bill_id from orders where id = v_order));
  perform pg_temp.put('L9', (select id from order_items where order_id = v_order));
  v_res := set_item_discount(pg_temp.id('L2'), 'amount', 300, 'Regular', v_sup, '2222');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: item discount L2: %', v_res; end if;
  v_res := set_item_discount(pg_temp.id('L3'), 'amount', 100, 'Regular', v_sup, '2222');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: item discount L3: %', v_res; end if;
  v_res := set_bill_discount(pg_temp.id('b5'), 'amount', 1000, 'Regular', v_sup, '2222');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: bill discount b5: %', v_res; end if;
  v_res := set_bill_discount(pg_temp.id('b6'), 'percent', 1000, 'Regular', v_sup, '2222');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: bill discount b6: %', v_res; end if;
end $$;

-- ── A1. Schema, grants, discount shares (§5), the preview and the selection checks (§4.2) ──
do $$
declare
  v_tot jsonb;
  v_b1 uuid := pg_temp.id('b1');
  r record;
begin
  -- schema and grants
  for r in select t, c from (values ('bills', 'split_from'), ('order_items', 'split_from_item')) as x(t, c) loop
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = r.t and column_name = r.c) then
      raise exception 'FAIL A1 schema: %.% is missing', r.t, r.c;
    end if;
  end loop;
  if pg_get_constraintdef((select oid from pg_constraint where conname = 'pos_discount_log_action_check')) not like '%split%' then
    raise exception 'FAIL A1 schema: pos_discount_log.action does not allow split';
  end if;
  if not has_function_privilege('authenticated', 'pos_split_totals(uuid,jsonb)', 'execute')
     or has_function_privilege('anon', 'pos_split_totals(uuid,jsonb)', 'execute')
     or not has_function_privilege('authenticated', 'pos_bill_input(uuid)', 'execute') then
    raise exception 'FAIL A1 grants: pos_split_totals / pos_bill_input';
  end if;
  for r in select f from unnest(array['pos_split_check(bills,jsonb)', 'pos_split_input(uuid,jsonb)',
                                      'pos_split_line_discount(text,integer,integer,integer)']) as f loop
    if has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL A1 grants: % is internal', r.f; end if;
  end loop;

  -- §5 item discount shares: percent copied; amount floor(value × k / q); all of it for the whole line; 0 → none
  if pos_split_line_discount('amount', 300, 3, 1) is distinct from '{"kind": "amount", "value": 100}'::jsonb
     or pos_split_line_discount('amount', 100, 3, 2) is distinct from '{"kind": "amount", "value": 66}'::jsonb
     or pos_split_line_discount('amount', 300, 3, 3) is distinct from '{"kind": "amount", "value": 300}'::jsonb
     or pos_split_line_discount('percent', 1000, 3, 1) is distinct from '{"kind": "percent", "value": 1000}'::jsonb
     or pos_split_line_discount('amount', 2, 3, 1) is not null
     or pos_split_line_discount(null, null, 3, 1) is not null then
    raise exception 'FAIL A1 item discount shares';
  end if;

  perform pg_temp.act(pg_temp.id('dev'));
  -- pos_bill_totals is unchanged by its re-creation: Latte ×3 + Cake = 54.00 + SC 5.40 + SST 3.24 = 62.64 → 62.65
  v_tot := pos_bill_totals(v_b1);
  if (v_tot->>'totalSen')::int is distinct from 6265 or (v_tot->>'subtotalSen')::int is distinct from 5400 then
    raise exception 'FAIL A1 pos_bill_totals: %', v_tot;
  end if;
  -- 1 of 3 lattes + the cake: 28.00 + SC 2.80 + SST 1.68 = 32.48 → 32.50
  v_tot := pos_split_totals(v_b1, jsonb_build_array(pg_temp.sel(pg_temp.id('L1'), 1), pg_temp.sel(pg_temp.id('C1'), 1)));
  if (v_tot->>'totalSen')::int is distinct from 3250 or (v_tot->>'subtotalSen')::int is distinct from 2800
     or (v_tot->>'serviceChargeSen')::int is distinct from 280 or (v_tot->>'sstSen')::int is distinct from 168
     or jsonb_array_length(v_tot->'lines') <> 2 then
    raise exception 'FAIL A1 preview S1: %', v_tot;
  end if;
  -- item amount RM 3.00 on 3 lattes, take 1 → 1.00 off: 12.00 + SC 1.20 + SST 0.72 = 13.92 → 13.90
  v_tot := pos_split_totals(pg_temp.id('b2'), jsonb_build_array(pg_temp.sel(pg_temp.id('L2'), 1)));
  if (v_tot->>'itemDiscountSen')::int is distinct from 100 or (v_tot->>'totalSen')::int is distinct from 1390 then
    raise exception 'FAIL A1 preview item share 100: %', v_tot;
  end if;
  -- item amount RM 1.00 on 3 lattes, take 2 → 0.66 off
  v_tot := pos_split_totals(pg_temp.id('b3'), jsonb_build_array(pg_temp.sel(pg_temp.id('L3'), 2)));
  if (v_tot->>'itemDiscountSen')::int is distinct from 66 then raise exception 'FAIL A1 preview item share 66: %', v_tot; end if;
  -- bill amount RM 10.00 on a 54.00 base, take the cake (15.00): round(1000 × 1500 / 5400) = 2.78;
  -- 15.00 − 2.78 = 12.22 + SC 1.22 + SST 0.73 = 14.17 → 14.15
  v_tot := pos_split_totals(pg_temp.id('b5'), jsonb_build_array(pg_temp.sel(pg_temp.id('C5'), 1)));
  if (v_tot->>'billDiscountSen')::int is distinct from 278 or (v_tot->>'totalSen')::int is distinct from 1415 then
    raise exception 'FAIL A1 preview bill amount share: %', v_tot;
  end if;
  -- bill 10%, take the cake: 15.00 − 1.50 = 13.50 + SC 1.35 + SST 0.81 = 15.66 → 15.65
  v_tot := pos_split_totals(pg_temp.id('b6'), jsonb_build_array(pg_temp.sel(pg_temp.id('C6'), 1)));
  if (v_tot->>'billDiscountSen')::int is distinct from 150 or (v_tot->>'totalSen')::int is distinct from 1565 then
    raise exception 'FAIL A1 preview bill percent: %', v_tot;
  end if;

  -- §4.2 messages
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_b1,
      jsonb_build_array(pg_temp.sel(pg_temp.id('L1'), 3), pg_temp.sel(pg_temp.id('C1'), 1))),
    'Select fewer items, or pay the whole bill', 'A1 every unit');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_b1, jsonb_build_array(pg_temp.sel(pg_temp.id('L1'), 4))),
    'The bill changed. Check the items again.', 'A1 more units than the line');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_b1, jsonb_build_array(pg_temp.sel(pg_temp.id('C1v'), 1))),
    'The bill changed. Check the items again.', 'A1 voided item');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_b1, jsonb_build_array(pg_temp.sel(pg_temp.id('L2'), 1))),
    'The bill changed. Check the items again.', 'A1 item of another bill');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_b1,
      jsonb_build_array(pg_temp.sel(pg_temp.id('L1'), 1), pg_temp.sel(pg_temp.id('L1'), 1))),
    'Invalid selection', 'A1 same item twice');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_b1, '[]'), 'Invalid selection', 'A1 empty');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_b1, '{"itemId": "x"}'), 'Invalid selection', 'A1 not an array');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_b1, jsonb_build_array(pg_temp.sel(pg_temp.id('L1'), 0))),
    'Invalid selection', 'A1 qty 0');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_b1,
      jsonb_build_array(jsonb_build_object('itemId', pg_temp.id('L1'), 'qty', 1.5))), 'Invalid selection', 'A1 qty 1.5');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_b1,
      jsonb_build_array(jsonb_build_object('itemId', 'not-a-uuid', 'qty', 1))), 'Invalid selection', 'A1 bad uuid');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', gen_random_uuid(), jsonb_build_array(pg_temp.sel(pg_temp.id('L1'), 1))),
    'Bill not found', 'A1 unknown bill');
end $$;

select 'VERIFY OK' as result;
rollback;
```

Later tasks insert their DO blocks **above** the final `select 'VERIFY OK' as result;` line.

- [ ] **Step 2: Run the verify file on dev to see it fail**

Apply nothing yet; run the verify file via `dev-sql-howto.md`.
Expected: `ERROR: … function pos_split_line_discount(…) does not exist` (or `column … split_from` missing).

- [ ] **Step 3: Write the migration**

Create `supabase/migration-2026-11-16-pos-split-bill.sql`:

```sql
-- ============================================================================
-- Craft OS — POS split bill and move items, Part A (2026-11-16). Run on craft-os-dev after
-- migration-2026-10-30-pos-discounts.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-11-17-pos-split-bill.md
-- Design: docs/superpowers/specs/2026-11-16-pos-split-bill-design.md (§3–§6, Part A)
--
-- S1  Schema: bills.split_from (set only on a paid part: the table bill it came from),
--     order_items.split_from_item (a row cut from a line's quantity), pos_discount_log action
--     'split'. The order_items insert triggers leave a cut row's catalog discount and order type
--     as its line was ordered.
-- S2  Preview: pos_bill_input (the input pos_bill_totals computes on; pos_bill_totals re-created
--     on it, numbers unchanged), pos_split_line_discount, pos_split_check, pos_split_input and
--     the RPC pos_split_totals.
-- S3  checkout_items: one call pays the selected units as their own, already paid bill.
--     checkout_bill's payment writing moves into pos_check_payments / pos_insert_payments /
--     pos_pay_and_close, used by both. pos_checkout_state also answers a split part paid under
--     one of the screen's checkout ids. pos_move_units cuts or moves the units.
-- S4  move_items: selected units to another table (its open bill, or a new one).
-- S5  Receipt "Split from <bill> · <table>"; the Z report's sources count by order_items.bill_id.
-- Re-run hazards: re-running migration-2026-10-30-pos-discounts.sql puts back the old
-- order_items_catalog_discount, pos_bill_totals and pos_receipt_payload, and
-- migration-2026-10-25-pos-hardening.sql the old order_items_order_type and pos_checkout_state;
-- migration-2026-10-29-pos-device-till.sql the old checkout_bill — re-run this file after any of
-- them (and migration-2026-11-17-pos-bill-parts.sql after this one, once it exists).
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_check_discount(text,integer)') is null then
    raise exception 'STOP: run migration-2026-10-30-pos-discounts.sql first (pos_check_discount is missing)';
  end if;
end $$;

-- ── S1. Schema ──────────────────────────────────────────────────────────────
alter table bills       add column if not exists split_from      uuid references bills(id);
alter table order_items add column if not exists split_from_item uuid references order_items(id);
create index if not exists bills_split_from_idx on bills(split_from) where split_from is not null;
alter table pos_discount_log drop constraint if exists pos_discount_log_action_check;
alter table pos_discount_log add constraint pos_discount_log_action_check check (action in ('set', 'clear', 'split'));

-- order_items_catalog_discount: the live text of migration-2026-10-30-pos-discounts.sql with the
-- line marked S1 added — a cut row keeps the catalog discount its line was ordered with.
create or replace function order_items_catalog_discount() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.split_from_item is not null then return new; end if;                          -- S1
  select c.discount_bp, case when c.discount_bp > 0 then c.name end
    into new.catalog_discount_bp, new.catalog_discount_name
    from orders o join menu_catalogs c on c.id = o.catalog_id
   where o.id = new.order_id;
  new.catalog_discount_bp := coalesce(new.catalog_discount_bp, 0);
  return new;
end $$;
revoke all on function order_items_catalog_discount() from public, anon, authenticated;

-- order_items_order_type: the live text of migration-2026-10-25-pos-hardening.sql with the line
-- marked S1 added — a cut row keeps its line's order type (a merged takeaway stays takeaway).
create or replace function order_items_order_type() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.split_from_item is not null then return new; end if;                          -- S1
  select b.order_type into new.order_type from bills b where b.id = new.bill_id;
  return new;
end $$;
revoke all on function order_items_order_type() from public, anon, authenticated;

-- ── S2. The bill input, shared ──────────────────────────────────────────────
-- The object pos_bill_totals (migration-2026-10-30-pos-discounts.sql) built inline, unchanged.
create or replace function pos_bill_input(p_bill_id uuid) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'orderType', b.order_type,
    'tableId', b.table_id,
    'sstRegistered', coalesce(s.sst_registered, true),
    'cashRounding', coalesce(s.cash_rounding, 'nearest_5_sen'),
    'rules', coalesce((
      select jsonb_agg(jsonb_build_object('rateBp', r.rate_bp, 'orderTypes', to_jsonb(r.order_types),
                                          'tableIds', to_jsonb(r.table_ids), 'productIds', to_jsonb(r.product_ids))
                       order by r.sort_order, r.created_at, r.id)
        from service_charge_rules r where r.branch_id = b.branch_id and r.is_active), '[]'::jsonb),
    'billDiscount', case when b.discount_kind is null then null
                         else jsonb_build_object('kind', b.discount_kind, 'value', b.discount_value) end,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object('id', oi.id,
                                          'productId', oi.product_id, 'unitPriceSen', oi.unit_price_sen, 'qty', oi.qty,
                                          'sstRateBp', oi.sst_rate_bp, 'takeawayFeeSen', oi.takeaway_fee_sen,
                                          'voided', oi.voided_at is not null,
                                          'orderType', oi.order_type,
                                          'catalogDiscountBp', oi.catalog_discount_bp,
                                          'discount', case when oi.discount_kind is null then null
                                                           else jsonb_build_object('kind', oi.discount_kind, 'value', oi.discount_value) end)
                       order by oi.id)
        from order_items oi where oi.bill_id = b.id), '[]'::jsonb))
  from bills b
  left join branch_pos_settings s on s.branch_id = b.branch_id
  where b.id = p_bill_id
$$;
revoke all on function pos_bill_input(uuid) from public, anon;
grant execute on function pos_bill_input(uuid) to authenticated;   -- pos_bill_totals is security invoker and calls it

-- pos_bill_totals: re-created on pos_bill_input (S2); null for an unknown bill, as before.
create or replace function pos_bill_totals(p_bill_id uuid) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select pos_compute_bill(x.i) from (select pos_bill_input(p_bill_id) as i) x where x.i is not null
$$;
revoke all on function pos_bill_totals(uuid) from public, anon;
grant execute on function pos_bill_totals(uuid) to authenticated;

-- ── S2. The selected part ───────────────────────────────────────────────────
-- An item discount carried by p_take of a line's p_line_qty units (spec §5): a percent as it is;
-- an amount shared by value, floor(value × take / qty) — all of it for the whole line; none when
-- the share is 0. Internal.
create or replace function pos_split_line_discount(p_kind text, p_value integer, p_line_qty integer, p_take integer) returns jsonb
language sql immutable set search_path = public, pg_temp as $$
  select case
    when p_kind is null then null
    when p_kind = 'percent' then jsonb_build_object('kind', 'percent', 'value', p_value)
    when p_take >= p_line_qty then jsonb_build_object('kind', 'amount', 'value', p_value)
    when floor(p_value::numeric * p_take / p_line_qty) > 0
      then jsonb_build_object('kind', 'amount', 'value', floor(p_value::numeric * p_take / p_line_qty)::integer)
  end
$$;
revoke all on function pos_split_line_discount(text, integer, integer, integer) from public, anon, authenticated;

-- p_items = [{ "itemId": uuid, "qty": int }] checked against the bill (spec §4.2). The callers that
-- write hold the bill's row lock. Returns the number of units selected. Internal.
create or replace function pos_split_check(p_bill bills, p_items jsonb) returns integer
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_e     jsonb;
  v_id    uuid;
  v_qty   integer;
  v_line  order_items;
  v_seen  uuid[] := '{}';
  v_units integer := 0;
  v_live  integer;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 100 then
    raise exception 'Invalid selection';
  end if;
  for v_e in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_e) <> 'object' or jsonb_typeof(v_e->'itemId') is distinct from 'string'
       or (v_e->>'itemId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(v_e->'qty') is distinct from 'number'
       or (v_e->'qty')::numeric <> trunc((v_e->'qty')::numeric)
       or (v_e->'qty')::numeric < 1 or (v_e->'qty')::numeric > 100 then
      raise exception 'Invalid selection';
    end if;
    v_id  := (v_e->>'itemId')::uuid;
    v_qty := (v_e->'qty')::numeric::integer;
    if v_id = any (v_seen) then raise exception 'Invalid selection'; end if;
    v_seen := v_seen || v_id;
    select * into v_line from order_items where id = v_id;
    if not found or v_line.bill_id <> p_bill.id or v_line.voided_at is not null or v_line.qty < v_qty then
      raise exception 'The bill changed. Check the items again.';
    end if;
    v_units := v_units + v_qty;
  end loop;
  select coalesce(sum(qty), 0)::integer into v_live from order_items where bill_id = p_bill.id and voided_at is null;
  if v_units >= v_live then raise exception 'Select fewer items, or pay the whole bill'; end if;
  return v_units;
end $$;
revoke all on function pos_split_check(bills, jsonb) from public, anon, authenticated;

-- The pos_compute_bill input of the selected part (spec §4.2, §5): the bill's own input with only
-- the selected lines, each at its chosen qty with its share of an item amount discount; a percent
-- bill discount copied; an amount bill discount V shared as round(V × part base / bill base), the
-- bases being the line nets after catalog and item discounts (pos_compute_bill's subtotalSen).
-- Checked first by pos_split_check. Internal.
create or replace function pos_split_input(p_bill_id uuid, p_items jsonb) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_bill      bills;
  v_input     jsonb := pos_bill_input(p_bill_id);
  v_part      jsonb;
  v_part_base numeric;
  v_bill_base numeric;
  v_share     integer;
begin
  select * into v_bill from bills where id = p_bill_id;
  v_part := jsonb_set(v_input, '{lines}', coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', oi.id, 'productId', oi.product_id, 'unitPriceSen', oi.unit_price_sen, 'qty', s.qty,
             'sstRateBp', oi.sst_rate_bp, 'takeawayFeeSen', oi.takeaway_fee_sen, 'voided', false,
             'orderType', oi.order_type, 'catalogDiscountBp', oi.catalog_discount_bp,
             'discount', pos_split_line_discount(oi.discount_kind, oi.discount_value, oi.qty, s.qty))
           order by oi.id)
      from (select (e->>'itemId')::uuid as item_id, (e->'qty')::numeric::integer as qty
              from jsonb_array_elements(p_items) e) s
      join order_items oi on oi.id = s.item_id), '[]'::jsonb));
  v_part := jsonb_set(v_part, '{billDiscount}', 'null'::jsonb);
  if v_bill.discount_kind = 'percent' then
    v_part := jsonb_set(v_part, '{billDiscount}', jsonb_build_object('kind', 'percent', 'value', v_bill.discount_value));
  elsif v_bill.discount_kind = 'amount' then
    v_part_base := (pos_compute_bill(v_part)->>'subtotalSen')::numeric;
    v_bill_base := (pos_compute_bill(jsonb_set(v_input, '{billDiscount}', 'null'::jsonb))->>'subtotalSen')::numeric;
    v_share := case when v_bill_base > 0 then round(v_bill.discount_value * v_part_base / v_bill_base)::integer else 0 end;
    if v_share > 0 then
      v_part := jsonb_set(v_part, '{billDiscount}', jsonb_build_object('kind', 'amount', 'value', v_share));
    end if;
  end if;
  return v_part;
end $$;
revoke all on function pos_split_input(uuid, jsonb) from public, anon, authenticated;

-- The selected part's totals, read by the picker after each change (spec §4.2). Read-only, no lock.
create or replace function pos_split_totals(p_bill_id uuid, p_items jsonb) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_bill bills;
begin
  select * into v_bill from bills where id = p_bill_id and branch_id = pos_my_branch();
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.status <> 'open' then
    raise exception 'This bill is already %', case v_bill.status when 'paid' then 'paid'
                                                                 when 'voided' then 'voided'
                                                                 else 'merged into another bill' end;
  end if;
  perform pos_split_check(v_bill, p_items);
  return pos_compute_bill(pos_split_input(v_bill.id, p_items));
end $$;
revoke all on function pos_split_totals(uuid, jsonb) from public, anon;
grant execute on function pos_split_totals(uuid, jsonb) to authenticated;

notify pgrst, 'reload schema';
select 'pos split bill applied' as result;
```

Later tasks insert their sections **above** the final `notify pgrst, 'reload schema';` line.

- [ ] **Step 4: Apply the migration on dev, run the verify file**

Per "How SQL tasks run": apply `supabase/migration-2026-11-16-pos-split-bill.sql` → `pos split bill applied`; run `supabase/migration-2026-11-16-pos-split-bill-verify.sql` → `VERIFY OK`.

- [ ] **Step 5: Re-run the baselines and the safe-update scan**

Re-run the baselines (the four verify files listed under "How SQL tasks run") on dev → each gives the same result as its baseline (proves `pos_bill_totals` and the triggers are unchanged for normal orders).
Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migration-2026-11-16-pos-split-bill.sql supabase/migration-2026-11-16-pos-split-bill-verify.sql
git commit -m "$(cat <<'EOF'
feat(pos): split bill schema and the server-priced split preview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task A2: `checkout_items`, the shared payment helpers and `checkout_bill` on them

**Files:**
- Modify: `supabase/migration-2026-11-16-pos-split-bill.sql` (insert section S3 above `notify pgrst, 'reload schema';`)
- Modify: `supabase/migration-2026-11-16-pos-split-bill-verify.sql` (insert block A2 above `select 'VERIFY OK' as result;`)

**Interfaces:**
- Consumes (Task A1): `pos_split_check(bills, jsonb)`, `pos_split_input(uuid, jsonb)`, `pos_split_line_discount(text, integer, integer, integer)`, `bills.split_from`, `order_items.split_from_item`, `pos_discount_log` action `'split'`.
- Produces:
  - `pos_check_payments(p_branch uuid, p_payments jsonb, p_due integer) returns void` — internal; checkout_bill's validation and messages, against `p_due`
  - `pos_insert_payments(p_bill_id uuid, p_branch uuid, p_shift uuid, p_payments jsonb, p_part_id uuid default null) returns void` — internal; `line_no` from 1. `p_part_id` is ignored until Task B1 re-creates it to write `payments.part_id`
  - `pos_pay_and_close(p_bill_id uuid, p_branch uuid, p_shift uuid, p_payments jsonb, p_totals jsonb, p_checkout_id uuid) returns jsonb` — internal; inserts the payments, freezes totals, marks paid, queues the receipt, returns `pos_checkout_result`
  - `pos_move_units(p_items jsonb, p_to uuid) returns jsonb` — internal; moves whole lines / cuts part lines onto `p_to`; returns `{ "<line id>": "<cut row id>" }` for cut lines
  - RPC `checkout_items(p_bill_id uuid, p_items jsonb, p_payments jsonb, p_checkout_id uuid) returns jsonb` — `{ billId, billNo, totalSen, changeSen, receiptQueued }` of the paid part (same shape as `checkout_bill`)
  - `pos_checkout_state(p_bill_id, p_checkout_ids)`: `result` is also the paid part of this bill whose `checkout_id` is in `p_checkout_ids`
  - verify fixture keys added: `p1` (paid part of S1), `L1cut`, `p2`, `p5`, `p6`

- [ ] **Step 1: Write the failing verify block**

Insert into `supabase/migration-2026-11-16-pos-split-bill-verify.sql`, above `select 'VERIFY OK' as result;`:

```sql
-- ── A2. checkout_items (spec §4.3; §8 tests 1–4) ──────────────────────────────
do $$
declare
  v_b1  uuid := pg_temp.id('b1');
  v_sel jsonb := jsonb_build_array(pg_temp.sel(pg_temp.id('L1'), 1), pg_temp.sel(pg_temp.id('C1'), 1));
  v_cid uuid := gen_random_uuid();
  v_res jsonb; v_res2 jsonb; v_part bills; v_cut order_items; v_tot jsonb;
begin
  perform pg_temp.act(pg_temp.id('dev'));
  -- payments are checked against the part's total, with checkout_bill's words
  perform pg_temp.expect_error(format('select checkout_items(%L, %L, %L, %L)', v_b1, v_sel, pg_temp.card(3000), gen_random_uuid()),
    'Payments (RM 30.00) do not match the total (RM 32.50)', 'A2 wrong amount');
  perform pg_temp.expect_error(format('select checkout_items(%L, %L, %L, null)', v_b1, v_sel, pg_temp.card(3250)),
    'Checkout id is missing', 'A2 no checkout id');
  -- 1. 1 of 3 lattes + the cake: their own paid bill of RM 32.50
  v_res := checkout_items(v_b1, v_sel, pg_temp.card(3250), v_cid);
  select * into v_part from bills where id = (v_res->>'billId')::uuid;
  if v_part.id is null or v_part.id = v_b1 or v_part.split_from is distinct from v_b1 or v_part.status <> 'paid'
     or v_part.pax is not null or v_part.table_id is distinct from pg_temp.id('t1') or v_part.order_type <> 'dine_in'
     or v_part.total_sen <> 3250 or v_part.checkout_id <> v_cid or v_part.shift_id is distinct from pg_temp.id('shift')
     or v_part.closed_by is distinct from pg_temp.id('cashier') or v_part.closed_device_id is distinct from pg_temp.id('dev')
     or (v_res->>'totalSen')::int <> 3250 or not (v_res->>'receiptQueued')::boolean
     or v_part.bill_no = (select bill_no from bills where id = v_b1) then
    raise exception 'FAIL A2 paid part: % %', v_res, row_to_json(v_part);
  end if;
  -- the table bill keeps 2 lattes on the same row and stays open; the part has the cut latte and the cake
  select * into v_cut from order_items where split_from_item = pg_temp.id('L1');
  if (select qty from order_items where id = pg_temp.id('L1')) <> 2
     or (select bill_id from order_items where id = pg_temp.id('L1')) <> v_b1
     or v_cut.id is null or v_cut.bill_id <> v_part.id or v_cut.qty <> 1
     or v_cut.order_id <> (select order_id from order_items where id = pg_temp.id('L1'))
     or (select bill_id from order_items where id = pg_temp.id('C1')) <> v_part.id
     or (select status from bills where id = v_b1) <> 'open'
     or (select count(*) from order_items where bill_id = v_part.id) <> 2 then
    raise exception 'FAIL A2 units';
  end if;
  if (select count(*) from payments where bill_id = v_part.id and amount_sen = 3250 and line_no = 1) <> 1
     or exists (select 1 from payments where bill_id = v_b1) then
    raise exception 'FAIL A2 payments';
  end if;
  -- what is left: Latte ×2 = 26.00 + SC 2.60 + SST 1.56 = 30.16 → 30.15
  v_tot := pos_bill_totals(v_b1);
  if (v_tot->>'totalSen')::int <> 3015 then raise exception 'FAIL A2 rest: %', v_tot; end if;
  -- the frozen lines carry the cut row's new id (the receipt reads line discounts by id)
  if not exists (select 1 from jsonb_array_elements(v_part.totals->'lines') l where l->>'id' = v_cut.id::text) then
    raise exception 'FAIL A2 frozen lines: %', v_part.totals;
  end if;
  if (select count(*) from print_jobs where payload->>'kind' = 'receipt' and payload->>'billNo' = v_part.bill_no) <> 1 then
    raise exception 'FAIL A2 receipt job';
  end if;
  -- 2. a resend with the same id and payments gets the first answer (the selection is gone now)
  v_res2 := checkout_items(v_b1, v_sel, pg_temp.card(3250), v_cid);
  if v_res2 <> v_res then raise exception 'FAIL A2 replay: % vs %', v_res2, v_res; end if;
  perform pg_temp.expect_error(format('select checkout_items(%L, %L, %L, %L)', v_b1, v_sel, pg_temp.card(3000), v_cid),
    'This payment was already recorded with other amounts — check Today''s bills', 'A2 replay other amounts');
  perform pg_temp.expect_error(format('select checkout_items(%L, %L, %L, %L)', pg_temp.id('b2'), v_sel, pg_temp.card(3250), v_cid),
    'This checkout id belongs to another bill', 'A2 replay on another bill');
  perform pg_temp.expect_error(format('select checkout_bill(%L, %L, %L)', v_b1, pg_temp.card(3250), v_cid),
    'This checkout id belongs to another bill', 'A2 checkout_bill with a split id');
  -- the Payment screen's follow: the table bill is open, and the result is the part paid under its id
  v_res2 := pos_checkout_state(v_b1, array[v_cid]);
  if v_res2->>'status' <> 'open' or (v_res2->'result'->>'billId')::uuid is distinct from v_part.id then
    raise exception 'FAIL A2 checkout state: %', v_res2;
  end if;
  if pos_checkout_state(v_b1, array[gen_random_uuid()])->'result' <> 'null'::jsonb then
    raise exception 'FAIL A2 checkout state with another id';
  end if;
  perform pg_temp.put('p1', v_part.id);
  perform pg_temp.put('L1cut', v_cut.id);

  -- 3. item amount RM 3.00 on 3 lattes, take 1: the cut row 1.00, the line keeps 2.00 (pays 13.90)
  v_res := checkout_items(pg_temp.id('b2'), jsonb_build_array(pg_temp.sel(pg_temp.id('L2'), 1)), pg_temp.card(1390), gen_random_uuid());
  select * into v_cut from order_items where split_from_item = pg_temp.id('L2');
  if v_cut.bill_id <> (v_res->>'billId')::uuid or v_cut.discount_kind <> 'amount' or v_cut.discount_value <> 100
     or v_cut.discount_reason <> 'Regular' or v_cut.discount_approved_by <> pg_temp.id('sup')
     or (select discount_value from order_items where id = pg_temp.id('L2')) <> 200
     or (select qty from order_items where id = pg_temp.id('L2')) <> 2
     or (pos_bill_totals(pg_temp.id('b2'))->>'itemDiscountSen')::int <> 200 then
    raise exception 'FAIL A2 item share: % %', v_res, row_to_json(v_cut);
  end if;
  perform pg_temp.put('p2', (v_res->>'billId')::uuid);

  -- 4a. bill amount RM 10.00: the cake's part carries 2.78, the table bill keeps 7.22, both logged.
  --     The rest: Latte ×3 = 39.00 − 7.22 = 31.78 + SC 3.18 + SST 1.91 = 36.87 → 36.85
  v_res := checkout_items(pg_temp.id('b5'), jsonb_build_array(pg_temp.sel(pg_temp.id('C5'), 1)), pg_temp.card(1415), gen_random_uuid());
  select * into v_part from bills where id = (v_res->>'billId')::uuid;
  if v_part.discount_kind <> 'amount' or v_part.discount_value <> 278 or v_part.discount_reason <> 'Regular'
     or v_part.discount_approved_by <> pg_temp.id('sup') or (v_part.totals->>'billDiscountSen')::int <> 278
     or (select discount_value from bills where id = pg_temp.id('b5')) <> 722
     or (pos_bill_totals(pg_temp.id('b5'))->>'totalSen')::int <> 3685 then
    raise exception 'FAIL A2 bill amount share: %', row_to_json(v_part);
  end if;
  if (select count(*) from pos_discount_log where bill_id = v_part.id and action = 'split' and kind = 'amount' and value = 278
         and reason = 'Regular' and approved_by = pg_temp.id('sup') and actor = pg_temp.id('cashier')) <> 1
     or (select count(*) from pos_discount_log where bill_id = pg_temp.id('b5') and action = 'split' and kind = 'amount' and value = 722) <> 1 then
    raise exception 'FAIL A2 discount log (amount)';
  end if;
  perform pg_temp.put('p5', v_part.id);
  -- 4b. bill 10%: copied onto the part, kept by the table bill, one log row (the part's)
  v_res := checkout_items(pg_temp.id('b6'), jsonb_build_array(pg_temp.sel(pg_temp.id('C6'), 1)), pg_temp.card(1565), gen_random_uuid());
  select * into v_part from bills where id = (v_res->>'billId')::uuid;
  if v_part.discount_kind <> 'percent' or v_part.discount_value <> 1000
     or (select discount_kind || ':' || discount_value from bills where id = pg_temp.id('b6')) <> 'percent:1000'
     or (select count(*) from pos_discount_log where bill_id = v_part.id and action = 'split') <> 1
     or (select count(*) from pos_discount_log where bill_id = pg_temp.id('b6') and action = 'split') <> 0 then
    raise exception 'FAIL A2 bill percent: %', row_to_json(v_part);
  end if;
  perform pg_temp.put('p6', v_part.id);

  -- checkout_bill on the shared helpers, as before: Latte 13.00 + SC 1.30 + SST 0.78 = 15.08 → 15.10; cash 20.00
  perform pg_temp.expect_error(format('select checkout_bill(%L, %L, %L)', pg_temp.id('b9'), pg_temp.card(1500), gen_random_uuid()),
    'Payments (RM 15.00) do not match the total (RM 15.10)', 'A2 checkout_bill wrong amount');
  v_res := checkout_bill(pg_temp.id('b9'), jsonb_build_array(jsonb_build_object('methodId', pg_temp.id('cash'), 'amountSen', 1510,
                                                                                 'tenderedSen', 2000)), gen_random_uuid());
  if (v_res->>'totalSen')::int <> 1510 or (v_res->>'changeSen')::int <> 490 or (select status from bills where id = pg_temp.id('b9')) <> 'paid'
     or (select count(*) from payments where bill_id = pg_temp.id('b9') and tendered_sen = 2000 and change_sen = 490 and line_no = 1) <> 1 then
    raise exception 'FAIL A2 checkout_bill: %', v_res;
  end if;
end $$;
```

- [ ] **Step 2: Run the verify file on dev to see it fail**

Expected: `ERROR: function checkout_items(uuid, jsonb, jsonb, uuid) does not exist`.

- [ ] **Step 3: Add section S3 to the migration**

Insert into `supabase/migration-2026-11-16-pos-split-bill.sql`, above `notify pgrst, 'reload schema';`:

```sql
-- ── S3. Payments, shared by checkout_bill and checkout_items ─────────────────
-- checkout_bill's checks of p_payments (migration-2026-10-29-pos-device-till.sql), unchanged, against
-- p_due. Nothing is written. Internal.
create or replace function pos_check_payments(p_branch uuid, p_payments jsonb, p_due integer) returns void
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_p   jsonb;
  v_m   payment_methods;
  v_sum integer := 0;
begin
  if p_payments is null or jsonb_typeof(p_payments) <> 'array' then raise exception 'Invalid payments'; end if;
  if jsonb_array_length(p_payments) > 10 then raise exception 'Too many payments on one bill'; end if;
  for v_p in select * from jsonb_array_elements(p_payments) loop
    if jsonb_typeof(v_p) <> 'object' or jsonb_typeof(v_p->'methodId') is distinct from 'string'
       or (v_p->>'methodId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Invalid payment';
    end if;
    if jsonb_typeof(v_p->'amountSen') is distinct from 'number'
       or (v_p->'amountSen')::numeric <> trunc((v_p->'amountSen')::numeric)
       or (v_p->'amountSen')::numeric <= 0 or (v_p->'amountSen')::numeric > 10000000 then
      raise exception 'Invalid payment amount';
    end if;
    select * into v_m from payment_methods
     where id = (v_p->>'methodId')::uuid and branch_id = p_branch and is_active;
    if not found then raise exception 'Payment method is not available at this branch'; end if;
    if jsonb_typeof(v_p->'tenderedSen') = 'number' then
      if (v_p->'tenderedSen')::numeric <> trunc((v_p->'tenderedSen')::numeric)
         or (v_p->'tenderedSen')::numeric > 10000000 then
        raise exception 'Invalid cash received';
      end if;
      if v_m.kind <> 'cash' then raise exception 'Only cash can be tendered above the amount'; end if;
      if (v_p->'tenderedSen')::numeric < (v_p->'amountSen')::numeric then
        raise exception 'Cash received is less than the amount';
      end if;
    elsif v_p->'tenderedSen' is not null and jsonb_typeof(v_p->'tenderedSen') <> 'null' then
      raise exception 'Invalid cash received';
    end if;
    if v_m.needs_reference
       and nullif(trim(case when jsonb_typeof(v_p->'reference') = 'string' then v_p->>'reference' end), '') is null then
      raise exception 'Enter the reference for %', v_m.name;
    end if;
    v_sum := v_sum + (v_p->'amountSen')::numeric::integer;
  end loop;
  if v_sum <> p_due then
    raise exception 'Payments (RM %) do not match the total (RM %)',
      to_char(v_sum / 100.0, 'FM999999990.00'), to_char(p_due / 100.0, 'FM999999990.00');
  end if;
end $$;
revoke all on function pos_check_payments(uuid, jsonb, integer) from public, anon, authenticated;

-- The payment rows of one checked p_payments, line_no from 1 (checkout_bill's insert, unchanged).
-- p_part_id: Part B (migration-2026-11-17-pos-bill-parts.sql) writes it to payments.part_id. Internal.
create or replace function pos_insert_payments(p_bill_id uuid, p_branch uuid, p_shift uuid, p_payments jsonb,
                                               p_part_id uuid default null) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_p        jsonb;
  v_m        payment_methods;
  v_amount   integer;
  v_tendered integer;
  v_n        integer := 0;
begin
  for v_p in select * from jsonb_array_elements(p_payments) loop
    v_n := v_n + 1;
    select * into v_m from payment_methods where id = (v_p->>'methodId')::uuid;
    v_amount   := (v_p->'amountSen')::numeric::integer;
    v_tendered := case when v_m.kind = 'cash' and jsonb_typeof(v_p->'tenderedSen') = 'number'
                       then (v_p->'tenderedSen')::numeric::integer end;
    insert into payments(bill_id, branch_id, method_id, method_name, kind, amount_sen, tendered_sen,
                         change_sen, reference, taken_by, line_no, shift_id)
    values (p_bill_id, p_branch, v_m.id, v_m.name, v_m.kind, v_amount, v_tendered,
            coalesce(v_tendered - v_amount, 0),
            nullif(trim(left(case when jsonb_typeof(v_p->'reference') = 'string' then v_p->>'reference' end, 60)), ''),
            pos_actor(), v_n, p_shift);
  end loop;
end $$;
revoke all on function pos_insert_payments(uuid, uuid, uuid, jsonb, uuid) from public, anon, authenticated;

-- A checked checkout written (checkout_bill's tail, unchanged): the payments, the bill paid with its
-- frozen totals and the six money columns, the receipt queued. Internal.
create or replace function pos_pay_and_close(p_bill_id uuid, p_branch uuid, p_shift uuid, p_payments jsonb,
                                             p_totals jsonb, p_checkout_id uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_queued boolean;
begin
  perform pos_insert_payments(p_bill_id, p_branch, p_shift, p_payments);
  update bills
     set status = 'paid', closed_at = now(), closed_by = pos_actor(), closed_device_id = pos_current_device(), checkout_id = p_checkout_id,
         shift_id = p_shift,
         totals = p_totals,
         subtotal_sen       = (p_totals->>'subtotalSen')::integer,
         service_charge_sen = (p_totals->>'serviceChargeSen')::integer,
         sst_sen            = (p_totals->>'sstSen')::integer,
         takeaway_fee_sen   = (p_totals->>'takeawayFeeSen')::integer,
         rounding_sen       = (p_totals->>'roundingSen')::integer,
         total_sen          = (p_totals->>'totalSen')::integer
   where id = p_bill_id;
  v_queued := pos_queue_receipt(p_bill_id, false);
  update bills set receipt_queued = v_queued where id = p_bill_id;
  return pos_checkout_result(p_bill_id);
end $$;
revoke all on function pos_pay_and_close(uuid, uuid, uuid, jsonb, jsonb, uuid) from public, anon, authenticated;

-- checkout_bill: the live text of migration-2026-10-29-pos-device-till.sql with the lines marked S3
-- changed — the checks and writing of the payments are pos_check_payments and pos_pay_and_close.
-- Same checks in the same order, same messages, same rows written.
CREATE OR REPLACE FUNCTION checkout_bill(p_bill_id uuid, p_payments jsonb, p_checkout_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch    uuid := pos_my_branch();
  v_bill      bills;
  v_totals    jsonb;
  v_shift     uuid;                                                -- 4a
begin
  if p_checkout_id is null then raise exception 'Checkout id is missing'; end if;
  -- a resend of a checkout that already went through gets the first answer —
  -- but only for the same bill of the caller's branch
  select * into v_bill from bills where checkout_id = p_checkout_id;
  if found then
    if v_bill.id <> p_bill_id or v_bill.branch_id <> v_branch then
      raise exception 'This checkout id belongs to another bill';
    end if;
    -- H2: the first result is replayed only for the very same payments
    if not pos_checkout_same_payments(v_bill.id, p_payments) then
      raise exception 'This payment was already recorded with other amounts — check Today''s bills';
    end if;
    return pos_checkout_result(v_bill.id);
  end if;

  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.checkout_id is not distinct from p_checkout_id then  -- won by the same checkout while we waited
    if not pos_checkout_same_payments(v_bill.id, p_payments) then                                   -- H2
      raise exception 'This payment was already recorded with other amounts — check Today''s bills';  -- H2
    end if;                                                                                          -- H2
    return pos_checkout_result(v_bill.id);
  end if;
  -- 4a: money moves only inside the branch's open shift. FOR SHARE lets checkouts run
  -- side by side, while close_shift (FOR UPDATE) waits for one in flight and then counts it.
  select id into v_shift from pos_shifts where branch_id = v_branch and status = 'open' for share;
  if not found then raise exception 'Open the shift first'; end if;
  if v_bill.status <> 'open' then
    raise exception 'This bill is already %', case v_bill.status when 'paid' then 'paid'
                                                                 when 'voided' then 'voided'
                                                                 else 'merged into another bill' end;
  end if;
  if not exists (select 1 from order_items where bill_id = v_bill.id and voided_at is null) then
    raise exception 'This bill has no items to pay for';
  end if;

  v_totals := pos_bill_totals(v_bill.id);
  perform pos_check_payments(v_branch, p_payments, (v_totals->>'totalSen')::integer);          -- S3: validate before writing
  return pos_pay_and_close(v_bill.id, v_branch, v_shift, p_payments, v_totals, p_checkout_id); -- S3: payments, paid, receipt
end $function$;

-- ── S3. Moving units (spec §4.5), shared by checkout_items and move_items ─────
-- Each entry of a checked p_items onto bill p_to: a whole line keeps its row (same id, order,
-- discounts, void history); part of a line is cut into a copy with qty = taken (every snapshot
-- column copied, its share of an item amount discount, split_from_item = the line) and the line
-- keeps the rest. Returns { "<line id>": "<cut row id>" } for the cut lines. Internal.
create or replace function pos_move_units(p_items jsonb, p_to uuid) returns jsonb
language plpgsql set search_path = public, pg_temp as $$
declare
  v_e    jsonb;
  v_line order_items;
  v_take integer;
  v_cut  jsonb;
  v_new  uuid;
  v_map  jsonb := '{}'::jsonb;
begin
  for v_e in select * from jsonb_array_elements(p_items) loop
    select * into v_line from order_items where id = (v_e->>'itemId')::uuid;
    v_take := (v_e->'qty')::numeric::integer;
    if v_take >= v_line.qty then
      update order_items set bill_id = p_to where id = v_line.id;
    else
      v_cut := pos_split_line_discount(v_line.discount_kind, v_line.discount_value, v_line.qty, v_take);
      insert into order_items(order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen, sst_rate_bp,
                              modifiers_snapshot, print_route, qty, note, takeaway_fee_sen, order_type,
                              catalog_discount_bp, catalog_discount_name,
                              discount_kind, discount_value, discount_reason, discount_approved_by, discount_by, discount_at,
                              split_from_item)
      values (v_line.order_id, p_to, v_line.product_id, v_line.variant_id, v_line.name_snapshot, v_line.unit_price_sen, v_line.sst_rate_bp,
              v_line.modifiers_snapshot, v_line.print_route, v_take, v_line.note, v_line.takeaway_fee_sen, v_line.order_type,
              v_line.catalog_discount_bp, v_line.catalog_discount_name,
              v_cut->>'kind', (v_cut->>'value')::integer,
              case when v_cut is not null then v_line.discount_reason end,
              case when v_cut is not null then v_line.discount_approved_by end,
              case when v_cut is not null then v_line.discount_by end,
              case when v_cut is not null then v_line.discount_at end,
              v_line.id)
      returning id into v_new;
      update order_items
         set qty = qty - v_take,
             discount_value = case when discount_kind = 'amount'
                                   then discount_value - coalesce((v_cut->>'value')::integer, 0) else discount_value end
       where id = v_line.id;
      v_map := v_map || jsonb_build_object(v_line.id::text, v_new);
    end if;
  end loop;
  return v_map;
end $$;
revoke all on function pos_move_units(jsonb, uuid) from public, anon, authenticated;

-- ── S3. Pay selected (spec §4.3): the selected units become their own bill, already paid ──
create or replace function checkout_items(p_bill_id uuid, p_items jsonb, p_payments jsonb, p_checkout_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
  v_part   bills;
  v_shift  uuid;
  v_input  jsonb;
  v_totals jsonb;
  v_disc   jsonb;
  v_map    jsonb;
  v_left   integer;
begin
  if p_checkout_id is null then raise exception 'Checkout id is missing'; end if;
  -- 1. a resend of a split payment that went through gets the first answer
  select * into v_part from bills where checkout_id = p_checkout_id;
  if found then
    if v_part.split_from is distinct from p_bill_id or v_part.branch_id <> v_branch then
      raise exception 'This checkout id belongs to another bill';
    end if;
    if not pos_checkout_same_payments(v_part.id, p_payments) then
      raise exception 'This payment was already recorded with other amounts — check Today''s bills';
    end if;
    return pos_checkout_result(v_part.id);
  end if;
  -- 2. the table's bill locked, then the id once more (a resend that waited behind the first), the shift
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  select * into v_part from bills where checkout_id = p_checkout_id;
  if found then
    if v_part.split_from is distinct from p_bill_id then raise exception 'This checkout id belongs to another bill'; end if;
    if not pos_checkout_same_payments(v_part.id, p_payments) then
      raise exception 'This payment was already recorded with other amounts — check Today''s bills';
    end if;
    return pos_checkout_result(v_part.id);
  end if;
  select id into v_shift from pos_shifts where branch_id = v_branch and status = 'open' for share;
  if not found then raise exception 'Open the shift first'; end if;
  if v_bill.status <> 'open' then
    raise exception 'This bill is already %', case v_bill.status when 'paid' then 'paid'
                                                                 when 'voided' then 'voided'
                                                                 else 'merged into another bill' end;
  end if;
  perform pos_split_check(v_bill, p_items);
  -- 3. the part's money exactly as pos_split_totals showed it; the payments checked before any write
  v_input  := pos_split_input(v_bill.id, p_items);
  v_totals := pos_compute_bill(v_input);
  v_disc   := case when jsonb_typeof(v_input->'billDiscount') = 'object' then v_input->'billDiscount' end;
  perform pos_check_payments(v_branch, p_payments, (v_totals->>'totalSen')::integer);
  -- 4. the paid part: same table and order type, no pax, its bill discount share with the original approval
  insert into bills(branch_id, bill_no, table_id, order_type, status, split_from, checkout_id, shift_id,
                    closed_at, closed_by, closed_device_id,
                    discount_kind, discount_value, discount_reason, discount_approved_by, discount_by, discount_at)
  values (v_branch, pos_next_bill_no(v_branch), v_bill.table_id, v_bill.order_type, 'paid', v_bill.id, p_checkout_id, v_shift,
          now(), pos_actor(), pos_current_device(),
          v_disc->>'kind', (v_disc->>'value')::integer,
          case when v_disc is not null then v_bill.discount_reason end,
          case when v_disc is not null then v_bill.discount_approved_by end,
          case when v_disc is not null then v_bill.discount_by end,
          case when v_disc is not null then v_bill.discount_at end)
  returning * into v_part;
  -- 5. the selected units
  v_map := pos_move_units(p_items, v_part.id);
  -- 6. the bill discount (spec §5): the part's share logged; an amount's rest stays on the table bill
  if v_disc is not null then
    insert into pos_discount_log(branch_id, bill_id, action, kind, value, reason, approved_by, actor)
    values (v_branch, v_part.id, 'split', v_disc->>'kind', (v_disc->>'value')::integer,
            v_bill.discount_reason, v_bill.discount_approved_by, pos_actor());
    if v_bill.discount_kind = 'amount' then
      v_left := v_bill.discount_value - (v_disc->>'value')::integer;
      if v_left > 0 then
        update bills set discount_value = v_left where id = v_bill.id;
      else
        update bills
           set discount_kind = null, discount_value = null, discount_reason = null,
               discount_approved_by = null, discount_by = null, discount_at = null
         where id = v_bill.id;
      end if;
      insert into pos_discount_log(branch_id, bill_id, action, kind, value, reason, approved_by, actor)
      values (v_branch, v_bill.id, 'split', 'amount', greatest(v_left, 0), v_bill.discount_reason, v_bill.discount_approved_by, pos_actor());
    end if;
  end if;
  -- 7. the cut rows' new ids in the frozen lines, then the payments, the receipt, the result
  v_totals := jsonb_set(v_totals, '{lines}', coalesce((
    select jsonb_agg(case when v_map ? (x.l->>'id') then jsonb_set(x.l, '{id}', v_map->(x.l->>'id')) else x.l end order by x.ord)
      from jsonb_array_elements(v_totals->'lines') with ordinality as x(l, ord)), '[]'::jsonb));
  update bills set updated_at = now() where id = v_bill.id;      -- a bills event: the other tablets refresh the table
  return pos_pay_and_close(v_part.id, v_branch, v_shift, p_payments, v_totals, p_checkout_id);
end $$;
revoke all on function checkout_items(uuid, jsonb, jsonb, uuid) from public, anon;
grant execute on function checkout_items(uuid, jsonb, jsonb, uuid) to authenticated;

-- pos_checkout_state: the live text of migration-2026-10-25-pos-hardening.sql with the lines marked
-- S3 added — the result is also a part of this bill paid under one of the screen's checkout ids
-- (the Payment screen's split mode follows the table bill, which stays open).
create or replace function pos_checkout_state(p_bill_id uuid, p_checkout_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
begin
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch;
  if not found then raise exception 'Bill not found'; end if;
  return jsonb_build_object(
    'status', v_bill.status,
    'billNo', v_bill.bill_no,
    'mergedIntoBillNo', (select m.bill_no from bills m where m.id = v_bill.merged_into),
    'totals', case when v_bill.status = 'open' then pos_bill_totals(v_bill.id) end,
    'result', case when v_bill.status = 'paid' and v_bill.checkout_id = any(coalesce(p_checkout_ids, '{}'::uuid[]))
                   then pos_checkout_result(v_bill.id)
                   else (select pos_checkout_result(p.id) from bills p                                    -- S3
                          where p.split_from = v_bill.id                                                  -- S3
                            and p.checkout_id = any(coalesce(p_checkout_ids, '{}'::uuid[]))               -- S3
                          order by p.closed_at limit 1) end);                                             -- S3
end $$;
revoke all on function pos_checkout_state(uuid, uuid[]) from public, anon;
grant execute on function pos_checkout_state(uuid, uuid[]) to authenticated;
```

- [ ] **Step 4: Apply the migration on dev, run the verify file**

Apply `supabase/migration-2026-11-16-pos-split-bill.sql` → `pos split bill applied`; run the verify file → `VERIFY OK`.

- [ ] **Step 5: Re-run the baselines and the safe-update scan**

Re-run the baselines (the four verify files listed under "How SQL tasks run") on dev → each the same as its baseline (checkout_bill on the shared helpers behaves as before).
Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migration-2026-11-16-pos-split-bill.sql supabase/migration-2026-11-16-pos-split-bill-verify.sql
git commit -m "$(cat <<'EOF'
feat(pos): checkout_items pays selected units as their own bill

checkout_bill's payment checks and writing move into shared helpers.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task A3: `move_items`

**Files:**
- Modify: `supabase/migration-2026-11-16-pos-split-bill.sql` (insert section S4 above `notify pgrst, 'reload schema';`)
- Modify: `supabase/migration-2026-11-16-pos-split-bill-verify.sql` (insert block A3 above `select 'VERIFY OK' as result;`)

**Interfaces:**
- Consumes: `pos_split_check(bills, jsonb)` (A1), `pos_move_units(jsonb, uuid)` (A2).
- Produces: RPC `move_items(p_bill_id uuid, p_items jsonb, p_table_id uuid) returns jsonb` — `{ "targetBillId": uuid, "targetBillNo": text, "movedUnits": int }`.

- [ ] **Step 1: Write the failing verify block**

Insert above `select 'VERIFY OK' as result;`:

```sql
-- ── A3. move_items (spec §4.4, §4.5; §8 tests 3 and 6) ──────────────────────
do $$
declare
  v_b3 uuid := pg_temp.id('b3');
  v_res jsonb; v_res2 jsonb; v_target bills; v_cut order_items; v_order uuid; v_b7 uuid; v_take uuid;
  v_l7 uuid; v_l7t uuid; v_items jsonb;
begin
  perform pg_temp.act(pg_temp.id('dev'));
  -- 2 of 3 lattes (item discount RM 1.00) to the free table S4: a new open bill there, pax 1;
  -- the moved cut row carries 0.66, the line keeps 0.34
  v_res := move_items(v_b3, jsonb_build_array(pg_temp.sel(pg_temp.id('L3'), 2)), pg_temp.id('t4'));
  select * into v_target from bills where id = (v_res->>'targetBillId')::uuid;
  select * into v_cut from order_items where split_from_item = pg_temp.id('L3');
  if v_target.table_id <> pg_temp.id('t4') or v_target.status <> 'open' or v_target.pax <> 1 or v_target.order_type <> 'dine_in'
     or v_res->>'targetBillNo' <> v_target.bill_no or (v_res->>'movedUnits')::int <> 2
     or v_cut.bill_id <> v_target.id or v_cut.qty <> 2 or v_cut.discount_value <> 66
     or (select qty from order_items where id = pg_temp.id('L3')) <> 1
     or (select discount_value from order_items where id = pg_temp.id('L3')) <> 34
     or exists (select 1 from payments where bill_id = v_target.id) then
    raise exception 'FAIL A3 to a free table: % %', v_res, row_to_json(v_cut);
  end if;
  -- the whole cake line to S4, which now has a bill: the same row moves onto that bill
  v_res2 := move_items(v_b3, jsonb_build_array(pg_temp.sel(pg_temp.id('C3'), 1)), pg_temp.id('t4'));
  if (v_res2->>'targetBillId')::uuid <> v_target.id or (v_res2->>'movedUnits')::int <> 1
     or (select bill_id from order_items where id = pg_temp.id('C3')) <> v_target.id
     or exists (select 1 from order_items where split_from_item = pg_temp.id('C3')) then
    raise exception 'FAIL A3 to a table with a bill: %', v_res2;
  end if;
  -- refusals
  perform pg_temp.expect_error(format('select move_items(%L, %L, %L)', v_b3, jsonb_build_array(pg_temp.sel(pg_temp.id('L3'), 1)), pg_temp.id('t4')),
    'Select fewer items, or pay the whole bill', 'A3 every unit');
  perform pg_temp.expect_error(format('select move_items(%L, %L, %L)', v_target.id, jsonb_build_array(pg_temp.sel(pg_temp.id('C3'), 1)), pg_temp.id('t4')),
    'Invalid table', 'A3 its own table');
  perform pg_temp.expect_error(format('select move_items(%L, %L, %L)', v_target.id, jsonb_build_array(pg_temp.sel(pg_temp.id('C3'), 1)), gen_random_uuid()),
    'Invalid table', 'A3 unknown table');
  perform pg_temp.expect_error(format('select move_items(%L, %L, %L)', pg_temp.id('b6'), jsonb_build_array(pg_temp.sel(pg_temp.id('L6'), 1)), pg_temp.id('t8')),
    'Remove the bill discount before moving items', 'A3 source with a bill discount');
  perform pg_temp.expect_error(format('select move_items(%L, %L, %L)', v_target.id, jsonb_build_array(pg_temp.sel(pg_temp.id('L3'), 1)), pg_temp.id('t8')),
    'The bill changed. Check the items again.', 'A3 an item of another bill');

  -- a cut row keeps its catalog discount and order type: S7 gets 2 lattes at 50% (catalog), then
  -- the catalog goes back to 0% and a takeaway of 2 lattes is merged in; one of each moves to S8
  perform pg_temp.act(pg_temp.id('owner'));
  perform menu_set_catalog_discount(pg_temp.id('catalog'), 5000);
  perform pg_temp.act(pg_temp.id('dev'));
  v_items := jsonb_build_array(jsonb_build_object('productId', pg_temp.id('latte'), 'variantId', pg_temp.id('latte_v'), 'qty', 2));
  v_order := place_counter_order(pg_temp.id('t7'), 'dine_in', 2, v_items, gen_random_uuid());
  v_b7 := (select bill_id from orders where id = v_order);
  v_l7 := (select id from order_items where order_id = v_order);
  perform pg_temp.act(pg_temp.id('owner'));
  perform menu_set_catalog_discount(pg_temp.id('catalog'), 0);
  perform pg_temp.act(pg_temp.id('dev'));
  v_order := place_counter_order(null, 'takeaway', null, v_items, gen_random_uuid());
  v_take := (select bill_id from orders where id = v_order);
  v_l7t := (select id from order_items where order_id = v_order);
  perform merge_bills(v_take, v_b7);
  if (select catalog_discount_bp from order_items where id = v_l7) <> 5000
     or (select order_type from order_items where id = v_l7t) <> 'takeaway' then
    raise exception 'FAIL A3 setup of S7';
  end if;
  v_res := move_items(v_b7, jsonb_build_array(pg_temp.sel(v_l7, 1), pg_temp.sel(v_l7t, 1)), pg_temp.id('t8'));
  if (select catalog_discount_bp || ':' || catalog_discount_name || ':' || order_type from order_items where split_from_item = v_l7)
       <> '5000:VERIFY S MENU:dine_in'
     or (select catalog_discount_bp || ':' || order_type from order_items where split_from_item = v_l7t) <> '0:takeaway'
     or (select bill_id from order_items where split_from_item = v_l7t) <> (v_res->>'targetBillId')::uuid
     or (select order_type from bills where id = (v_res->>'targetBillId')::uuid) <> 'dine_in' then
    raise exception 'FAIL A3 cut rows keep catalog discount and order type: %', v_res;
  end if;
end $$;
```

- [ ] **Step 2: Run the verify file on dev to see it fail**

Expected: `ERROR: function move_items(uuid, jsonb, uuid) does not exist`.

- [ ] **Step 3: Add section S4 to the migration**

Insert above `notify pgrst, 'reload schema';`:

```sql
-- ── S4. Move selected items to another table (spec §4.4) ──────────────────────
-- No idempotency key: no money moves, the button is offline-disabled, and the client re-reads the
-- bill instead of retrying; a resend that finds the items gone gets "The bill changed".
create or replace function move_items(p_bill_id uuid, p_items jsonb, p_table_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
  v_target bills;
  v_label  text;
  v_units  integer;
begin
  select label into v_label from dining_tables where id = p_table_id and branch_id = v_branch and is_active;
  if not found then raise exception 'Invalid table'; end if;
  -- the source and the target table's open bill locked in one fixed order (as merge_bills)
  perform 1 from bills
   where (id = p_bill_id and branch_id = v_branch) or (table_id = p_table_id and status = 'open')
   order by id for update;
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.status <> 'open' then
    raise exception 'This bill is already %', case v_bill.status when 'paid' then 'paid'
                                                                 when 'voided' then 'voided'
                                                                 else 'merged into another bill' end;
  end if;
  if v_bill.table_id is not distinct from p_table_id then raise exception 'Invalid table'; end if;
  if v_bill.discount_kind is not null then raise exception 'Remove the bill discount before moving items'; end if;
  v_units := pos_split_check(v_bill, p_items);
  select * into v_target from bills where table_id = p_table_id and status = 'open';
  if not found then
    begin
      insert into bills(branch_id, bill_no, table_id, order_type, pax)
      values (v_branch, pos_next_bill_no(v_branch), p_table_id, 'dine_in', 1)
      returning * into v_target;
    exception when unique_violation then
      raise exception 'Table % just got a bill. Try again.', v_label;
    end;
  end if;
  perform pos_move_units(p_items, v_target.id);
  update bills set updated_at = now() where id in (v_bill.id, v_target.id);   -- both tables refresh on every tablet
  return jsonb_build_object('targetBillId', v_target.id, 'targetBillNo', v_target.bill_no, 'movedUnits', v_units);
end $$;
revoke all on function move_items(uuid, jsonb, uuid) from public, anon;
grant execute on function move_items(uuid, jsonb, uuid) to authenticated;
```

- [ ] **Step 4: Apply the migration on dev, run the verify file**

Apply → `pos split bill applied`; verify → `VERIFY OK`.

- [ ] **Step 5: Safe-update scan**

Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts` → PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migration-2026-11-16-pos-split-bill.sql supabase/migration-2026-11-16-pos-split-bill-verify.sql
git commit -m "$(cat <<'EOF'
feat(pos): move_items moves selected units to another table

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task A4: Receipt "Split from" and the Z report's sources

**Files:**
- Modify: `supabase/migration-2026-11-16-pos-split-bill.sql` (insert section S5 above `notify pgrst, 'reload schema';`)
- Modify: `supabase/migration-2026-11-16-pos-split-bill-verify.sql` (insert block A4 above `select 'VERIFY OK' as result;`)
- Modify: `src/features/pos/print/receipt.ts`
- Test: `src/features/pos/print/receipt.test.ts`

**Interfaces:**
- Consumes: `bills.split_from` (A1); the paid parts `p1`, `p2`, `p5`, `p6` and the paid `b9` of the A2 verify block.
- Produces:
  - `pos_receipt_payload` adds `"splitFrom": { "billNo": text, "table": text | null } | null`
  - `ReceiptPayload.splitFrom?: { billNo: string; table: string | null } | null` and `splitFromLine(s: { billNo: string; table: string | null }): string` in `receipt.ts`
  - `pos_shift_report.sources[*].orders` / `.itemSen` count items by `order_items.bill_id`

- [ ] **Step 1: Write the failing verify block**

Insert above `select 'VERIFY OK' as result;`:

```sql
-- ── A4. Receipt "Split from" and the Z report (spec §6; §8 test 7) ──────────
do $$
declare
  v_res jsonb;
begin
  perform pg_temp.act(pg_temp.id('dev'));
  v_res := pos_receipt_payload(pg_temp.id('p1'), false);
  if v_res->'splitFrom' is distinct from jsonb_build_object('billNo', (select bill_no from bills where id = pg_temp.id('b1')), 'table', 'S1')
     or v_res->'pax' <> 'null'::jsonb or (v_res->>'totalSen')::int <> 3250 or jsonb_array_length(v_res->'items') <> 2 then
    raise exception 'FAIL A4 receipt of the part: %', v_res;
  end if;
  if pos_receipt_payload(pg_temp.id('b9'), false)->'splitFrom' <> 'null'::jsonb then
    raise exception 'FAIL A4 receipt of a whole bill has splitFrom';
  end if;
  -- the cut latte of S2's part keeps its 1.00 item discount on the receipt (found by the cut row's id)
  v_res := pos_receipt_payload(pg_temp.id('p2'), false);
  if not exists (select 1 from jsonb_array_elements(v_res->'items') i, jsonb_array_elements(i->'discounts') d
                  where d->>'label' = 'Discount' and (d->>'amountSen')::int = 100) then
    raise exception 'FAIL A4 receipt discount of a cut row: %', v_res;
  end if;
  -- the rest of S1 (Latte ×2: 30.15) paid: the shift now has 6 paid bills — the 4 parts (pax null),
  -- S9 (pax 1) and S1 (pax 4); 32.50 + 13.90 + 14.15 + 15.65 + 15.10 + 30.15 = 121.45
  perform checkout_bill(pg_temp.id('b1'), pg_temp.card(3015), gen_random_uuid());
  v_res := pos_shift_report(pg_temp.id('shift'));
  if (v_res->'summary'->>'billCount')::int <> 6 or (v_res->'summary'->>'pax')::int <> 5
     or (v_res->'summary'->>'nettSen')::int <> 12145 then
    raise exception 'FAIL A4 Z summary: %', v_res->'summary';
  end if;
  -- sources by item: orders S1/1, S1/2 (the voided cake), S2/1, S5/1, S6/1, S9/1; items
  -- 13.00 + 15.00 (part 1) + 26.00 (S1) + 13.00 (S2 part) + 15.00 + 15.00 + 13.00 (S9) = 110.00
  if (select (s->>'orders')::int from jsonb_array_elements(v_res->'sources') s where s->>'source' = 'counter') <> 6
     or (select (s->>'itemSen')::int from jsonb_array_elements(v_res->'sources') s where s->>'source' = 'counter') <> 11000 then
    raise exception 'FAIL A4 Z sources: %', v_res->'sources';
  end if;
end $$;
```

- [ ] **Step 2: Run the verify file on dev to see it fail**

Expected: `ERROR: FAIL A4 receipt of the part: …` (no `splitFrom` yet).

- [ ] **Step 3: Add section S5 to the migration**

Insert above `notify pgrst, 'reload schema';`:

```sql
-- ── S5. Receipt: the live text of migration-2026-10-30-pos-discounts.sql with the lines marked S5
--    added — a paid part names the table bill it was split from. Exactly ReceiptPayload
--    (src/features/pos/print/receipt.ts). ─
create or replace function pos_receipt_payload(p_bill_id uuid, p_reprint boolean) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'kind', 'receipt',
    'route', s.receipt_route,
    'reprint', p_reprint,
    'header', jsonb_build_object(
      'title', coalesce(nullif(trim(br.receipt_title), ''), br.name),
      'legalName', nullif(trim(br.legal_name), ''),
      'registrationNo', nullif(trim(br.registration_no), ''),
      'sstNo', nullif(trim(br.sst_no), ''),
      'address', nullif(trim(br.address), ''),
      'phone', nullif(trim(br.phone), ''),
      'email', nullif(trim(br.email), '')),
    'billNo', b.bill_no,
    'splitFrom', (select jsonb_build_object('billNo', sf.bill_no, 'table', sft.label)                 -- S5
                    from bills sf left join dining_tables sft on sft.id = sf.table_id                 -- S5
                   where sf.id = b.split_from),                                                       -- S5
    'closedAt', to_char(b.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'cashier', (select st.name from staff st where st.id = b.closed_by),
    'tableLabel', t.label,
    'pax', b.pax,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'qty', oi.qty, 'name', oi.name_snapshot, 'unitSen', oi.unit_price_sen,
               'amountSen', oi.unit_price_sen * oi.qty,
               'mods', (select coalesce(jsonb_agg(m->>'name' order by ord), '[]'::jsonb)
                          from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)),
               'discounts', (select coalesce(jsonb_agg(d.j order by d.k), '[]'::jsonb) from (
                   select 1 as k, jsonb_build_object(
                            'label', coalesce(oi.catalog_discount_name, 'Catalog') || ' ' || (oi.catalog_discount_bp / 100) || '%',
                            'amountSen', (ln.l->>'catalogDiscountSen')::integer) as j
                    where coalesce((ln.l->>'catalogDiscountSen')::integer, 0) > 0
                   union all
                   select 2, jsonb_build_object(
                            'label', case when oi.discount_kind = 'percent' then 'Discount ' || (oi.discount_value / 100) || '%'
                                          else 'Discount' end,
                            'amountSen', (ln.l->>'itemDiscountSen')::integer)
                    where coalesce((ln.l->>'itemDiscountSen')::integer, 0) > 0) d))
             order by o.placed_at, oi.name_snapshot, oi.id)
        from order_items oi join orders o on o.id = oi.order_id
        left join lateral (select x.l from jsonb_array_elements(coalesce(b.totals->'lines', '[]'::jsonb)) as x(l)
                            where x.l->>'id' = oi.id::text) ln on true
       where oi.bill_id = b.id and oi.voided_at is null), '[]'::jsonb),
    'itemCount', (select coalesce(sum(oi.qty), 0) from order_items oi where oi.bill_id = b.id and oi.voided_at is null),
    'subtotalSen', b.subtotal_sen,
    'billDiscountSen', coalesce((b.totals->>'billDiscountSen')::integer, 0),
    'sstGroups', coalesce(b.totals->'sstGroups', '[]'::jsonb),
    'serviceChargeGroups', coalesce(b.totals->'serviceChargeGroups', '[]'::jsonb),
    'takeawayFeeSen', b.takeaway_fee_sen,
    'roundingSen', b.rounding_sen,
    'totalSen', b.total_sen,
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.method_name, 'kind', p.kind, 'amountSen', p.amount_sen,
                                          'tenderedSen', p.tendered_sen, 'reference', p.reference)
                       order by p.line_no, p.id)
        from payments p where p.bill_id = b.id), '[]'::jsonb),
    'changeSen', (select coalesce(sum(p.change_sen), 0) from payments p where p.bill_id = b.id),
    'footer', coalesce(s.receipt_footer, 'This is an official receipt. Thank you for visiting us.'))
  from bills b
  join branches br on br.id = b.branch_id
  left join branch_pos_settings s on s.branch_id = b.branch_id
  left join dining_tables t on t.id = b.table_id
  where b.id = p_bill_id
$$;
revoke all on function pos_receipt_payload(uuid, boolean) from public, anon, authenticated;
```

Then, in the same section, re-create `pos_shift_report`:

1. Add this comment line, then copy lines 534–684 of `supabase/migration-2026-10-30-pos-discounts.sql` verbatim (from `create or replace function pos_shift_report(p_shift_id uuid) returns jsonb` through `revoke all on function pos_shift_report(uuid) from public, anon, authenticated;`):

```sql
-- ── S5. Z report: the live text of migration-2026-10-30-pos-discounts.sql with the lines marked S5
--    changed — sources count by order_items.bill_id: a split or moved unit keeps its order_id,
--    whose bill_id is the bill it was ordered on. Internal. ─
```

2. In the copy, replace the two subqueries of `'sources'` (the copied lines 622–625):

```sql
               'orders', (select count(*)::integer from orders o where o.bill_id in (select sb.id from sb) and o.source = x.src),
               'itemSen', (select coalesce(sum(oi.unit_price_sen * oi.qty), 0)::integer
                             from order_items oi join orders o on o.id = oi.order_id
                            where o.bill_id in (select sb.id from sb) and o.source = x.src and oi.voided_at is null))
```

with:

```sql
               'orders', (select count(distinct oi.order_id)::integer                                         -- S5
                            from order_items oi join orders o on o.id = oi.order_id                           -- S5
                           where oi.bill_id in (select sb.id from sb) and o.source = x.src),                  -- S5
               'itemSen', (select coalesce(sum(oi.unit_price_sen * oi.qty), 0)::integer
                             from order_items oi join orders o on o.id = oi.order_id
                            where oi.bill_id in (select sb.id from sb) and o.source = x.src and oi.voided_at is null))   -- S5
```

Nothing else in `pos_shift_report` changes.

- [ ] **Step 4: Apply the migration on dev, run the verify file**

Apply → `pos split bill applied`; verify → `VERIFY OK`. Also re-run `supabase/migration-2026-10-30-pos-discounts-verify.sql` → same as the baseline (its section E checks this receipt and Z report).

- [ ] **Step 5: Write the failing receipt tests**

In `src/features/pos/print/receipt.test.ts` change the import to:

```ts
import { money, toAscii, renderReceiptLines, renderRefundSlipLines, splitFromLine, type ReceiptPayload, type RefundSlipPayload } from './receipt'
```

and add at the end of the file:

```ts
describe('split from (split bill §6)', () => {
  it('the line under the invoice number names the table bill and its table', () => {
    expect(splitFromLine({ billNo: '261116-009', table: 'T5' })).toBe('Split from 261116-009 · T5')
    expect(splitFromLine({ billNo: '261116-004', table: null })).toBe('Split from 261116-004')
  })
  it('prints under the invoice number, in ASCII', () => {
    const lines = renderReceiptLines({ ...r87846, splitFrom: { billNo: '261116-009', table: 'T5' } }, 48)
    const at = lines.findIndex((l) => l.startsWith('Invoice no'))
    expect(lines[at + 1]).toBe('Split from 261116-009 - T5')
    expect(lines[at + 2].startsWith('Date')).toBe(true)
  })
  it('a receipt with splitFrom null prints no such line', () => {
    expect(renderReceiptLines({ ...r87846, splitFrom: null }, 48)).toEqual(renderReceiptLines(r87846, 48))
  })
  it('maps the middle dot to a hyphen for the printer', () => {
    expect(toAscii('a · b')).toBe('a - b')
  })
})
```

- [ ] **Step 6: Run the tests to see them fail**

Run: `npx vitest run src/features/pos/print/receipt.test.ts`
Expected: FAIL — `splitFromLine` is not exported.

- [ ] **Step 7: Implement in `src/features/pos/print/receipt.ts`**

In `ReceiptPayload`, after `billNo: string`, add:

```ts
  splitFrom?: { billNo: string; table: string | null } | null // a paid part of a split bill: its table bill (absent before split bill)
```

In `ASCII_MAP`, add the entry `'·': '-',` (after `'•': '-',`).

After the `money` function, add:

```ts
/** "Split from 261116-009 · T5" (split bill §6); a takeaway table bill has no table. */
export function splitFromLine(s: { billNo: string; table: string | null }): string {
  return s.table ? `Split from ${s.billNo} · ${s.table}` : `Split from ${s.billNo}`
}
```

In `renderReceiptLines`, change the header's invoice line from

```ts
    ...lr('Invoice no', r.billNo, cols),
```

to

```ts
    ...lr('Invoice no', r.billNo, cols),
    ...(r.splitFrom ? wrap(toAscii(splitFromLine(r.splitFrom)), cols) : []),   // r is ASCII already; the · added here is not
```

- [ ] **Step 8: Run the tests to see them pass**

Run: `npx vitest run src/features/pos/print/receipt.test.ts src/features/pos/print/printJob.test.ts src/features/pos/sqlSafeUpdate.test.ts`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add supabase/migration-2026-11-16-pos-split-bill.sql supabase/migration-2026-11-16-pos-split-bill-verify.sql src/features/pos/print/receipt.ts src/features/pos/print/receipt.test.ts
git commit -m "$(cat <<'EOF'
feat(pos): receipt names the bill a paid part was split from

The Z report counts sources by the item's bill, so split and moved units count once.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task A5: Selection module and the item picker (`SplitItemsScreen`)

**Files:**
- Create: `src/features/pos/order/splitSelection.ts`, `src/features/pos/order/splitSelection.test.ts`
- Create: `src/features/pos/order/SplitItemsScreen.tsx`, `src/features/pos/order/SplitItemsScreen.test.tsx`
- Modify: `src/features/pos/order/moveTargets.ts`, `src/features/pos/order/moveTargets.test.ts`
- Modify: `src/features/pos/order/MoveToGrid.tsx`, `src/features/pos/order/MoveToGrid.test.tsx`
- Modify: `src/features/pos/order/posApi.ts` (`moveItems`)
- Modify: `src/features/pos/checkout/checkoutApi.ts` (`splitTotals`)

**Interfaces:**
- Consumes: RPCs `pos_split_totals(p_bill_id, p_items)` (A1) and `move_items(p_bill_id, p_items, p_table_id)` (A3); existing `moveBill`, `mergeBills`, `fetchBillItems`, `moveTargets`, `MoveToGrid`, `ConfirmDialog`, `NO_SHIFT_PAY`.
- Produces:
  - `splitSelection.ts`: `SplitItem { itemId: string; qty: number }`, `SplitLine`, `Picked = Readonly<Record<string, number>>`, `splitLines(items)`, `liveUnits(lines)`, `canSplit(liveUnitCount)`, `setQty(p, lines, id, qty)`, `selectAll(lines)`, `pickedUnits(p)`, `everythingSelected(p, lines)`, `toSplitItems(p, lines)`, `prune(p, lines)`, `ofLabel(k, q)`, `movedNotice(units, table)`, `splitTitle(title)`, `parseMoveItemsResult(data)`, `MoveItemsResult`, constants `SPLIT_OFFLINE`, `MOVE_NEEDS_NO_DISCOUNT`, `BILL_CHANGED_ITEMS`, `SPLIT_ACTION_LABEL`
  - `moveTargets.ts`: `itemMoveTargets(from, tables, bills, summaries): MoveTarget[]`, `ITEM_MOVE_HINT`
  - `MoveToGrid` prop `hint?: string`
  - `posApi.moveItems(billId: string, items: SplitItem[], tableId: string): Promise<MoveItemsResult>`
  - `checkoutApi.splitTotals(billId: string, items: SplitItem[]): Promise<BillTotals>`
  - `SplitItemsScreen` default export with props `{ bill, title, tables, bills, summaries, refreshKey, online, shiftOpen, initialPicked?, onBack, onPay(items, picked), onPayWhole(), onMoved(notice), onWholeMoved(to: OrderTarget) }`; `PREVIEW_DEBOUNCE_MS = 300`

- [ ] **Step 1: Write the failing tests for the pure module**

Create `src/features/pos/order/splitSelection.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { BillItemRow } from './posApi'
import {
  canSplit, everythingSelected, liveUnits, movedNotice, ofLabel, parseMoveItemsResult, pickedUnits, prune, selectAll, setQty,
  splitLines, splitTitle, toSplitItems, SPLIT_ACTION_LABEL, SPLIT_OFFLINE, MOVE_NEEDS_NO_DISCOUNT, BILL_CHANGED_ITEMS,
} from './splitSelection'

const row = (id: string, name: string, qty: number, unit: number, voided = false): BillItemRow => ({
  id, order_id: 'o1', product_id: `p-${id}`, name_snapshot: name, unit_price_sen: unit, sst_rate_bp: 600, takeaway_fee_sen: 0,
  order_type: 'dine_in', qty, note: id === 'i2' ? 'no sugar' : null, modifiers_snapshot: id === 'i1' ? [{ name: 'Oat milk' }] : [],
  voided_at: voided ? '2026-11-16T04:10:00Z' : null, catalog_discount_bp: 0, catalog_discount_name: null,
  discount_kind: null, discount_value: null, discount_reason: null,
  orders: { order_no: '261116-009/1', source: 'counter', placed_at: '2026-11-16T04:00:00Z' },
})
const lines = splitLines([row('i1', 'Latte', 3, 1300), row('i2', 'Cake', 1, 1500), row('i3', 'Soup', 1, 900, true)])

describe('splitLines', () => {
  it('lists the live lines in bill order with name, modifiers, note and line price', () => {
    expect(lines).toEqual([
      { id: 'i1', name: 'Latte', mods: ['Oat milk'], note: null, qty: 3, amountSen: 3900 },
      { id: 'i2', name: 'Cake', mods: [], note: 'no sugar', qty: 1, amountSen: 1500 },
    ])
    expect(liveUnits(lines)).toBe(4)
  })
})

describe('the stepper and the tick box', () => {
  it('a stepper goes 0…qty and never past either end', () => {
    let p = setQty({}, lines, 'i1', 2)
    expect(p).toEqual({ i1: 2 })
    p = setQty(p, lines, 'i1', 5)
    expect(p).toEqual({ i1: 3 })
    p = setQty(p, lines, 'i1', -1)
    expect(p).toEqual({})
  })
  it('an unknown line changes nothing', () => {
    const p = { i1: 1 }
    expect(setQty(p, lines, 'nope', 1)).toBe(p)
  })
  it('select all picks every unit; clear is the empty pick', () => {
    expect(selectAll(lines)).toEqual({ i1: 3, i2: 1 })
    expect(pickedUnits(selectAll(lines))).toBe(4)
    expect(pickedUnits({})).toBe(0)
  })
})

describe('everything selected', () => {
  it('only when every unit of every live line is picked', () => {
    expect(everythingSelected(selectAll(lines), lines)).toBe(true)
    expect(everythingSelected({ i1: 2, i2: 1 }, lines)).toBe(false)
    expect(everythingSelected({}, [])).toBe(false)
  })
})

describe('toSplitItems and prune', () => {
  it('p_items in bill order, picked lines only', () => {
    expect(toSplitItems({ i2: 1, i1: 1 }, lines)).toEqual([{ itemId: 'i1', qty: 1 }, { itemId: 'i2', qty: 1 }])
    expect(toSplitItems({}, lines)).toEqual([])
  })
  it('after the bill changed: a gone line is dropped, a smaller line caps its pick', () => {
    const after = splitLines([row('i1', 'Latte', 2, 1300)])
    expect(prune({ i1: 3, i2: 1 }, after)).toEqual({ i1: 2 })
  })
})

describe('copy', () => {
  it('is the spec words', () => {
    expect(ofLabel(2, 3)).toBe('2 of 3')
    expect(movedNotice(2, 'T7')).toBe('Moved 2 items to T7')
    expect(movedNotice(1, 'T7')).toBe('Moved 1 item to T7')
    expect(splitTitle('Table T5')).toBe('Table T5 · Split')
    expect(SPLIT_ACTION_LABEL).toBe('Split / Move items')
    expect(SPLIT_OFFLINE).toBe('Split needs a connection')
    expect(MOVE_NEEDS_NO_DISCOUNT).toBe('Remove the bill discount before moving items')
    expect(BILL_CHANGED_ITEMS).toBe('The bill changed. Check the items again.')
  })
  it('a bill splits with at least two units', () => {
    expect(canSplit(1)).toBe(false)
    expect(canSplit(2)).toBe(true)
  })
})

describe('parseMoveItemsResult', () => {
  it('reads move_items\' answer', () => {
    expect(parseMoveItemsResult({ targetBillId: 'b7', targetBillNo: '261116-011', movedUnits: 2 }))
      .toEqual({ targetBillId: 'b7', targetBillNo: '261116-011', movedUnits: 2 })
  })
  it('refuses anything else', () => {
    expect(() => parseMoveItemsResult(null)).toThrow('Unexpected reply from the server')
    expect(() => parseMoveItemsResult({ targetBillId: 'b7', movedUnits: 2 })).toThrow('Unexpected reply from the server')
  })
})
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run src/features/pos/order/splitSelection.test.ts`
Expected: FAIL — cannot resolve `./splitSelection`.

- [ ] **Step 3: Write `src/features/pos/order/splitSelection.ts`**

```ts
// src/features/pos/order/splitSelection.ts
/** Split / Move items (docs/superpowers/specs/2026-11-16-pos-split-bill-design.md §3.2): which units of
 *  a bill's live lines are picked. Pure. The server prices and checks every pick (pos_split_totals);
 *  the client never computes the part's money. */
import type { BillItemRow } from './posApi'

/** One entry of p_items: an order item and how many of its units. */
export interface SplitItem { itemId: string; qty: number }
/** A live line of the bill, as the picker lists it. */
export interface SplitLine { id: string; name: string; mods: string[]; note: string | null; qty: number; amountSen: number }
/** item id → units picked; a line that is not in it has none picked. */
export type Picked = Readonly<Record<string, number>>
/** move_items' answer. */
export interface MoveItemsResult { targetBillId: string; targetBillNo: string; movedUnits: number }

export const SPLIT_ACTION_LABEL = 'Split / Move items'
export const SPLIT_OFFLINE = 'Split needs a connection'
export const MOVE_NEEDS_NO_DISCOUNT = 'Remove the bill discount before moving items'
export const BILL_CHANGED_ITEMS = 'The bill changed. Check the items again.'
/** "2 of 3": a stepper's units picked of the line's units. */
export const ofLabel = (k: number, q: number): string => `${k} of ${q}`
export const movedNotice = (units: number, table: string): string => `Moved ${units} item${units === 1 ? '' : 's'} to ${table}`
/** "Table T5 · Split", "Takeaway 261116-004 · Split". */
export const splitTitle = (title: string): string => `${title} · Split`
/** Split / Move items is offered from two live units up (spec §3.1). */
export const canSplit = (liveUnitCount: number): boolean => liveUnitCount >= 2

/** The live lines in bill order (fetchBillItems already sorts them). */
export function splitLines(items: BillItemRow[]): SplitLine[] {
  return items.filter((i) => i.voided_at === null).map((i) => ({
    id: i.id, name: i.name_snapshot, mods: i.modifiers_snapshot.map((m) => m.name), note: i.note, qty: i.qty,
    amountSen: i.unit_price_sen * i.qty,
  }))
}

export const liveUnits = (lines: SplitLine[]): number => lines.reduce((n, l) => n + l.qty, 0)

/** A line's pick set to qty, kept within 0…the line's qty; an unknown line changes nothing. */
export function setQty(p: Picked, lines: SplitLine[], id: string, qty: number): Picked {
  const line = lines.find((l) => l.id === id)
  if (!line) return p
  const q = Math.max(0, Math.min(line.qty, Math.trunc(qty)))
  const next: Record<string, number> = { ...p }
  if (q === 0) delete next[id]
  else next[id] = q
  return next
}

export const selectAll = (lines: SplitLine[]): Picked => Object.fromEntries(lines.map((l) => [l.id, l.qty]))
export const pickedUnits = (p: Picked): number => Object.values(p).reduce((n, q) => n + q, 0)

/** Every unit of every live line: Pay selected and Move to table then run the whole-bill flows. */
export function everythingSelected(p: Picked, lines: SplitLine[]): boolean {
  return lines.length > 0 && lines.every((l) => (p[l.id] ?? 0) === l.qty)
}

/** p_items for pos_split_totals / checkout_items / move_items: picked lines in bill order. */
export function toSplitItems(p: Picked, lines: SplitLine[]): SplitItem[] {
  return lines.flatMap((l) => ((p[l.id] ?? 0) > 0 ? [{ itemId: l.id, qty: p[l.id] }] : []))
}

/** The pick after the bill was read again: lines that are gone are dropped, a smaller line caps its pick. */
export function prune(p: Picked, lines: SplitLine[]): Picked {
  const out: Record<string, number> = {}
  for (const l of lines) {
    const q = Math.min(p[l.id] ?? 0, l.qty)
    if (q > 0) out[l.id] = q
  }
  return out
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)

/** Throws "Unexpected reply from the server" for anything that is not move_items' shape. */
export function parseMoveItemsResult(data: unknown): MoveItemsResult {
  if (!isObj(data) || typeof data.targetBillId !== 'string' || typeof data.targetBillNo !== 'string' || typeof data.movedUnits !== 'number') {
    throw new Error('Unexpected reply from the server')
  }
  return { targetBillId: data.targetBillId, targetBillNo: data.targetBillNo, movedUnits: data.movedUnits }
}
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run src/features/pos/order/splitSelection.test.ts` → PASS.

- [ ] **Step 5: Item-move targets and the grid hint — failing tests**

Append to `src/features/pos/order/moveTargets.test.ts` (keep its existing imports; add `itemMoveTargets` to the import from `./moveTargets`, and define the fixtures locally if the file's own fixtures differ):

```ts
describe('itemMoveTargets (split spec §3.2)', () => {
  const tbl = (id: string, label: string) => ({ id, label, qr_token: `q-${id}`, qr_paused: false, is_active: true, sort_order: 1, area: null })
  const open = (id: string, tableId: string | null, billNo: string) => ({
    id, bill_no: billNo, table_id: tableId, order_type: (tableId ? 'dine_in' : 'takeaway') as 'dine_in' | 'takeaway', pax: 2,
    opened_at: '2026-11-16T04:00:00Z', discount_kind: null, discount_value: null, discount_reason: null,
  })
  it('every other table: an empty one gets a new bill, one with a bill takes the items; takeaways are not offered', () => {
    const tables = [tbl('t5', 'T5'), tbl('t7', 'T7'), tbl('t8', 'T8')]
    const bills = [open('b5', 't5', '261116-009'), open('b8', 't8', '261116-012'), open('bt', null, '261116-013')]
    const summaries = new Map([['b8', { billId: 'b8', totalSen: 2500, itemCount: 1 }]])
    expect(itemMoveTargets(bills[0], tables, bills, summaries)).toEqual([
      { tableId: 't7', label: 'T7', kind: 'move' },
      { tableId: 't8', label: 'T8', kind: 'merge', intoBillId: 'b8', intoBillNo: '261116-012', totalSen: 2500 },
    ])
  })
  it('a takeaway bill may move items to any table', () => {
    const tables = [tbl('t5', 'T5')]
    expect(itemMoveTargets(open('bt', null, '261116-013'), tables, [], new Map())).toEqual([{ tableId: 't5', label: 'T5', kind: 'move' }])
  })
})
```

Append to `src/features/pos/order/MoveToGrid.test.tsx` inside its `describe`:

```tsx
  it('takes another hint for moving items', () => {
    render(<MoveToGrid billNo="261116-009" targets={targets} busy={false} hint="an empty table gets a new bill, a table with a bill takes the items"
      onPick={() => {}} onClose={() => {}} />)
    expect(screen.getByText('Bill 261116-009 · an empty table gets a new bill, a table with a bill takes the items')).toBeTruthy()
  })
```

Run: `npx vitest run src/features/pos/order/moveTargets.test.ts src/features/pos/order/MoveToGrid.test.tsx`
Expected: FAIL — `itemMoveTargets` is not exported; the hint text is not found.

- [ ] **Step 6: Implement them**

In `src/features/pos/order/moveTargets.ts` append:

```ts
export const ITEM_MOVE_HINT = 'an empty table gets a new bill, a table with a bill takes the items'

/** Move items (split spec §3.2, move_items): every active table but the bill's own. An empty table
 *  gets a new bill there (`move`); a table with a bill takes the items onto it (shown as `merge`, with
 *  its total). Takeaway bills are never a target. */
export function itemMoveTargets(
  from: Pick<OpenBillRow, 'table_id'>, tables: TableRow[], bills: OpenBillRow[], summaries: ReadonlyMap<string, BillSummary>,
): MoveTarget[] {
  const byTable = new Map(bills.flatMap((b) => (b.table_id ? [[b.table_id, b] as const] : [])))
  return tables.filter((t) => t.id !== from.table_id).map((t): MoveTarget => {
    const there = byTable.get(t.id)
    return there
      ? { tableId: t.id, label: t.label, kind: 'merge', intoBillId: there.id, intoBillNo: there.bill_no, totalSen: summaries.get(there.id)?.totalSen ?? null }
      : { tableId: t.id, label: t.label, kind: 'move' }
  })
}
```

In `src/features/pos/order/MoveToGrid.tsx`: add `hint` to the props (`hint?: string  // the line under the title (default: the whole-bill rule)`), destructure it as `hint = 'an empty table moves it, a table with a bill merges it in'`, and change the header span to:

```tsx
          <span className="text-sm text-brown-muted">Bill {billNo} · {hint}</span>
```

Run: `npx vitest run src/features/pos/order/moveTargets.test.ts src/features/pos/order/MoveToGrid.test.tsx` → PASS.

- [ ] **Step 7: The two API calls**

In `src/features/pos/order/posApi.ts`, add to the imports `import { parseMoveItemsResult, type MoveItemsResult, type SplitItem } from './splitSelection'` and append:

```ts
/** Move selected units to another table (move_items, split spec §4.4): its open bill, or a new one.
 *  No retry on a lost reply: the bill is read again instead (a resend would find the items gone). */
export async function moveItems(billId: string, items: SplitItem[], tableId: string): Promise<MoveItemsResult> {
  const { data, error } = await supabase.rpc('move_items', { p_bill_id: billId, p_items: items, p_table_id: tableId })
  if (error) fail(error)
  return parseMoveItemsResult(data)
}
```

In `src/features/pos/checkout/checkoutApi.ts`, add `import type { SplitItem } from '../order/splitSelection'` and, after `fetchCheckoutState`, add:

```ts
/** The selected part's totals (pos_split_totals, split spec §4.2): the picker's footer and the Payment
 *  screen's split mode. Raises the server's words for a selection it refuses. */
export async function splitTotals(billId: string, items: SplitItem[]): Promise<BillTotals> {
  const { data, error } = await supabase
    .rpc('pos_split_totals', { p_bill_id: billId, p_items: items })
    .abortSignal(AbortSignal.timeout(CHECKOUT_TIMEOUT_MS))
  if (error) fail(error)
  if (typeof data !== 'object' || data === null || typeof (data as { totalSen?: unknown }).totalSen !== 'number') {
    throw new Error('Unexpected reply from the server')
  }
  return data as BillTotals
}
```

Run: `npx tsc -b` → no errors.

- [ ] **Step 8: Write the failing picker tests**

Create `src/features/pos/order/SplitItemsScreen.test.tsx`:

```tsx
// @vitest-environment jsdom
// The item picker (split spec §3.2): drive it the way a cashier does and check what goes to the server.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const api = vi.hoisted(() => ({
  fetchBillItems: vi.fn(), moveItems: vi.fn(), splitTotals: vi.fn(), moveBill: vi.fn(), mergeBills: vi.fn(),
}))
vi.mock('./posApi', () => ({ fetchBillItems: api.fetchBillItems, moveItems: api.moveItems }))
vi.mock('../checkout/checkoutApi', () => ({ splitTotals: api.splitTotals, moveBill: api.moveBill, mergeBills: api.mergeBills }))

import SplitItemsScreen, { PREVIEW_DEBOUNCE_MS } from './SplitItemsScreen'
import type { BillItemRow, OpenBillRow, TableRow } from './posApi'

const row = (id: string, name: string, qty: number, unit: number): BillItemRow => ({
  id, order_id: 'o1', product_id: `p-${id}`, name_snapshot: name, unit_price_sen: unit, sst_rate_bp: 600, takeaway_fee_sen: 0,
  order_type: 'dine_in', qty, note: null, modifiers_snapshot: [], voided_at: null, catalog_discount_bp: 0, catalog_discount_name: null,
  discount_kind: null, discount_value: null, discount_reason: null,
  orders: { order_no: '261116-009/1', source: 'counter', placed_at: '2026-11-16T04:00:00Z' },
})
const bill: OpenBillRow = {
  id: 'b5', bill_no: '261116-009', table_id: 't5', order_type: 'dine_in', pax: 4, opened_at: '2026-11-16T04:00:00Z',
  discount_kind: null, discount_value: null, discount_reason: null,
}
const table = (id: string, label: string): TableRow => ({ id, label, qr_token: `q-${id}`, qr_paused: false, is_active: true, sort_order: 1, area: null })
const tables = [table('t5', 'T5'), table('t7', 'T7')]
const partTotals = {
  subtotalSen: 2800, serviceChargeSen: 280, sstSen: 168, takeawayFeeSen: 0, beforeRoundingSen: 3248, roundingSen: 2, totalSen: 3250,
  sstGroups: [], serviceChargeGroups: [], grossSen: 2800, catalogDiscountSen: 0, itemDiscountSen: 0, billDiscountSen: 0, lines: [],
}
const flush = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve() })
const wait = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms) }); await flush() }
const press = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }))
const button = (name: string | RegExp) => screen.getByRole('button', { name }) as HTMLButtonElement

type Props = Parameters<typeof SplitItemsScreen>[0]
function renderPicker(over: Partial<Props> = {}) {
  const props: Props = {
    bill, title: 'Table T5', tables, bills: [bill], summaries: new Map([['b5', { billId: 'b5', totalSen: 6265, itemCount: 4 }]]),
    refreshKey: 0, online: true, shiftOpen: true,
    onBack: vi.fn(), onPay: vi.fn(), onPayWhole: vi.fn(), onMoved: vi.fn(), onWholeMoved: vi.fn(), ...over,
  }
  render(<SplitItemsScreen {...props} />)
  return props
}

beforeEach(() => {
  vi.useFakeTimers()
  api.fetchBillItems.mockResolvedValue([row('i1', 'Latte', 3, 1300), row('i2', 'Cake', 1, 1500)])
  api.splitTotals.mockReset().mockResolvedValue(partTotals)
  api.moveItems.mockReset()
})
afterEach(() => { cleanup(); vi.useRealTimers() })

describe('SplitItemsScreen', () => {
  it('lists the lines: a tick box for one unit, a stepper "k of q" for more; both buttons wait for a pick', async () => {
    renderPicker()
    await flush()
    expect(screen.getByText('Table T5 · Split')).toBeTruthy()
    expect(screen.getByRole('checkbox', { name: 'Cake' })).toBeTruthy()
    expect(screen.getByText('0 of 3')).toBeTruthy()
    expect(button('Pay selected').disabled).toBe(true)
    expect(button('Move to table').disabled).toBe(true)
    press('More Latte'); press('More Latte')
    expect(screen.getByText('2 of 3')).toBeTruthy()
    press('Fewer Latte')
    expect(screen.getByText('1 of 3')).toBeTruthy()
  })

  it('asks the server for the part 300 ms after the last change; Pay selected sends the picked units', async () => {
    const p = renderPicker()
    await flush()
    press('More Latte')
    fireEvent.click(screen.getByRole('checkbox', { name: 'Cake' }))
    expect(screen.getByLabelText('Selected total').textContent).toBe('…')
    await wait(PREVIEW_DEBOUNCE_MS - 1)
    expect(api.splitTotals).not.toHaveBeenCalled()
    await wait(1)
    expect(api.splitTotals).toHaveBeenCalledTimes(1)
    expect(api.splitTotals).toHaveBeenCalledWith('b5', [{ itemId: 'i1', qty: 1 }, { itemId: 'i2', qty: 1 }])
    expect(screen.getByLabelText('Selected total').textContent).toBe('RM 32.50')
    press('Pay selected')
    expect(p.onPay).toHaveBeenCalledWith([{ itemId: 'i1', qty: 1 }, { itemId: 'i2', qty: 1 }], { i1: 1, i2: 1 })
  })

  it('shows the server\'s refusal and keeps Pay selected off', async () => {
    api.splitTotals.mockRejectedValue(new Error('The bill changed. Check the items again.'))
    renderPicker()
    await flush()
    press('More Latte')
    await wait(PREVIEW_DEBOUNCE_MS)
    expect(screen.getByText('The bill changed. Check the items again.')).toBeTruthy()
    expect(button('Pay selected').disabled).toBe(true)
  })

  it('every unit picked: Pay selected opens the normal Payment, with no preview call', async () => {
    const p = renderPicker()
    await flush()
    press('Select all')
    await wait(PREVIEW_DEBOUNCE_MS)
    expect(api.splitTotals).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Selected total').textContent).toBe('RM 62.65')
    press('Pay selected')
    expect(p.onPayWhole).toHaveBeenCalledTimes(1)
    expect(p.onPay).not.toHaveBeenCalled()
    press('Clear')
    expect(button('Pay selected').disabled).toBe(true)
  })

  it('a bill discount turns Move to table off, with the note', async () => {
    const discounted = { ...bill, discount_kind: 'percent' as const, discount_value: 1000, discount_reason: 'Regular' }
    renderPicker({ bill: discounted, bills: [discounted] })
    await flush()
    press('More Latte')
    expect(button('Move to table').disabled).toBe(true)
    expect(screen.getByText('Remove the bill discount before moving items')).toBeTruthy()
  })

  it('offline: both buttons stay off and say why', async () => {
    renderPicker({ online: false })
    await flush()
    press('More Latte')
    expect(button('Pay selected').disabled).toBe(true)
    expect(button('Move to table').disabled).toBe(true)
    expect(screen.getByText('Split needs a connection')).toBeTruthy()
  })

  it('Move to table moves the picked units and reports "Moved 2 items to T7"', async () => {
    api.moveItems.mockResolvedValue({ targetBillId: 'b7', targetBillNo: '261116-011', movedUnits: 2 })
    const p = renderPicker()
    await flush()
    press('More Latte'); press('More Latte')
    press('Move to table')
    expect(screen.getByText(/a table with a bill takes the items/)).toBeTruthy()
    press(/T7\s*Empty/)
    await flush()
    expect(api.moveItems).toHaveBeenCalledWith('b5', [{ itemId: 'i1', qty: 2 }], 't7')
    expect(p.onMoved).toHaveBeenCalledWith('Moved 2 items to T7')
  })

  it('opens with the selection Payment\'s Cancel kept', async () => {
    renderPicker({ initialPicked: { i1: 2 } })
    await flush()
    expect(screen.getByText('2 of 3')).toBeTruthy()
  })
})
```

Run: `npx vitest run src/features/pos/order/SplitItemsScreen.test.tsx`
Expected: FAIL — cannot resolve `./SplitItemsScreen`.

- [ ] **Step 9: Write `src/features/pos/order/SplitItemsScreen.tsx`**

```tsx
// src/features/pos/order/SplitItemsScreen.tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Minus, Plus } from 'lucide-react'
import { formatSen } from './cart'
import type { BillSummary } from './billSummaries'
import { NO_SHIFT_PAY } from './billView'
import MoveToGrid from './MoveToGrid'
import { ITEM_MOVE_HINT, itemMoveTargets, moveTargets, type MoveTarget } from './moveTargets'
import type { OrderTarget } from './orderTarget'
import { fetchBillItems, moveItems, type BillItemRow, type OpenBillRow, type TableRow } from './posApi'
import {
  MOVE_NEEDS_NO_DISCOUNT, SPLIT_OFFLINE, everythingSelected, movedNotice, ofLabel, pickedUnits, prune, selectAll, setQty,
  splitLines, splitTitle, toSplitItems, type Picked, type SplitItem,
} from './splitSelection'
import { mergeBills, moveBill, splitTotals } from '../checkout/checkoutApi'
import { storedDiscount } from '../checkout/discounts'
import ConfirmDialog, { type ConfirmRequest } from '../shell/ConfirmDialog'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** The footer asks the server this long after the last change. */
export const PREVIEW_DEBOUNCE_MS = 300
const BILL_GONE = 'This bill is no longer open.'

type Preview = { kind: 'none' } | { kind: 'loading' } | { kind: 'total'; sen: number } | { kind: 'error'; message: string }

/** Split / Move items (docs/superpowers/specs/2026-11-16-pos-split-bill-design.md §3.2): every live
 *  line of the bill — a tick box for one unit, a stepper for more — with Select all / Clear, the
 *  part's total from the server after each change (pos_split_totals, debounced), Pay selected and
 *  Move to table. Every unit picked runs the whole-bill flows instead (normal Payment, move / merge). */
export default function SplitItemsScreen({
  bill, title, tables, bills, summaries, refreshKey, online, shiftOpen, initialPicked,
  onBack, onPay, onPayWhole, onMoved, onWholeMoved,
}: {
  bill: OpenBillRow
  title: string                              // "Table T5", "Takeaway 261116-004"
  tables: TableRow[]
  bills: OpenBillRow[]                       // the branch's open bills (PosTill keeps them fresh)
  summaries: ReadonlyMap<string, BillSummary>
  refreshKey: number                         // bumped on every bills event, order and 15 s sweep
  online: boolean
  shiftOpen: boolean | null
  initialPicked?: Picked                     // the selection Payment's Cancel kept
  onBack: () => void
  onPay: (items: SplitItem[], picked: Picked) => void
  onPayWhole: () => void
  onMoved: (notice: string) => void
  onWholeMoved: (to: OrderTarget) => void
}) {
  const [items, setItems] = useState<BillItemRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [localKey, setLocalKey] = useState(0)
  const [picked, setPicked] = useState<Picked>(initialPicked ?? {})
  const [preview, setPreview] = useState<Preview>({ kind: 'none' })
  const [moving, setMoving] = useState(false)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null)
  const previewSeq = useRef(0)

  useEffect(() => {
    let live = true
    fetchBillItems(bill.id).then(
      (rows) => { if (live) { setItems(rows); setLoadError(null) } },
      (e) => { if (live) setLoadError(msg(e)) },
    )
    return () => { live = false }
  }, [bill.id, refreshKey, localKey])
  const lines = useMemo(() => splitLines(items ?? []), [items])
  useEffect(() => { if (items) setPicked((p) => prune(p, lines)) }, [items, lines])

  const current = bills.find((b) => b.id === bill.id) ?? null
  const gone = current === null
  const hasDiscount = storedDiscount(current ?? bill) !== null
  const units = pickedUnits(picked)
  const all = everythingSelected(picked, lines)
  const chosen = useMemo(() => toSplitItems(picked, lines), [picked, lines])
  const chosenKey = JSON.stringify(chosen)

  useEffect(() => {
    const seq = ++previewSeq.current
    if (chosen.length === 0 || all || !online) { setPreview({ kind: 'none' }); return }
    setPreview({ kind: 'loading' })
    const timer = setTimeout(() => {
      splitTotals(bill.id, chosen).then(
        (t) => { if (seq === previewSeq.current) setPreview({ kind: 'total', sen: t.totalSen }) },
        (e) => { if (seq === previewSeq.current) setPreview({ kind: 'error', message: msg(e) }) },
      )
    }, PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [bill.id, chosenKey, all, online, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError(null)
    try { await fn() } catch (e) { setError(msg(e)); setMoving(false); setLocalKey((k) => k + 1) } finally { busyRef.current = false; setBusy(false) }
  }

  const pay = () => { if (all) onPayWhole(); else onPay(chosen, picked) }

  const targets = all
    ? moveTargets(current ?? bill, tables, bills, summaries, hasDiscount)
    : itemMoveTargets(current ?? bill, tables, bills, summaries)
  const pickTarget = (t: MoveTarget) => {
    if (t.kind === 'refused' || busyRef.current) return
    const label = t.label
    if (!all) {
      const tableId = t.tableId
      if (tableId === null) return
      void run(async () => {
        const r = await moveItems(bill.id, chosen, tableId)
        onMoved(movedNotice(r.movedUnits, label))
      })
      return
    }
    if (t.kind === 'move') {
      const to = t.tableId
      void run(async () => { await moveBill(bill.id, to); onWholeMoved({ kind: 'table', tableId: to, pax: null }) })
      return
    }
    const intoBillId = t.intoBillId
    const into: OrderTarget = t.tableId !== null ? { kind: 'table', tableId: t.tableId, pax: null } : { kind: 'takeaway', billId: intoBillId }
    setMoving(false)
    setConfirm({
      title: `Merge into ${label}?`,
      message: `Every item of bill ${bill.bill_no} moves onto bill ${t.intoBillNo}, and this bill closes.`,
      confirmLabel: 'Merge',
      onConfirm: () => void run(async () => { await mergeBills(bill.id, intoBillId); onWholeMoved(into) }),
    })
  }

  const wholeSen = summaries.get(bill.id)?.totalSen
  const footer = units === 0 ? '—'
    : all ? (wholeSen === undefined ? '…' : formatSen(wholeSen))
    : preview.kind === 'total' ? formatSen(preview.sen)
    : preview.kind === 'error' ? '' : '…'
  const blocked = units === 0 || gone || busy || !online
  const payDisabled = blocked || shiftOpen !== true || (!all && preview.kind !== 'total')
  const moveDisabled = blocked || hasDiscount
  const stepBtn = 'flex h-11 w-11 items-center justify-center rounded-lg border border-border-mid disabled:opacity-40'

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-cream">
      <header className="flex items-center gap-3 border-b border-border bg-card p-3">
        <button type="button" onClick={onBack} disabled={busy} aria-label="Back to the bill" className={stepBtn}><ArrowLeft size={20} /></button>
        <h2 className="flex-1 truncate text-lg font-semibold text-brown-dark">{splitTitle(title)}</h2>
        <span className="text-sm text-brown-muted">Bill {bill.bill_no}</span>
        <button type="button" onClick={() => setPicked(selectAll(lines))} disabled={busy || lines.length === 0}
          className="min-h-11 rounded-xl border border-border-mid px-4 text-sm font-medium text-brown-dark disabled:opacity-40">Select all</button>
        <button type="button" onClick={() => setPicked({})} disabled={busy || units === 0}
          className="min-h-11 rounded-xl border border-border-mid px-4 text-sm font-medium text-brown-dark disabled:opacity-40">Clear</button>
      </header>
      {gone && <p role="alert" className="m-3 rounded bg-red-50 p-2 text-sm text-red-700">{BILL_GONE}</p>}
      {loadError && <p role="alert" className="m-3 rounded bg-red-50 p-2 text-sm text-red-700">{loadError}</p>}
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {items === null && !loadError && <p className="text-brown-muted">Loading…</p>}
        {lines.map((l) => {
          const k = picked[l.id] ?? 0
          return (
            <div key={l.id} className={`flex items-center gap-3 rounded-xl border-2 bg-card p-3 ${k > 0 ? 'border-brown-btn' : 'border-border'}`}>
              {l.qty === 1 ? (
                <input type="checkbox" aria-label={l.name} className="h-7 w-7" checked={k === 1} disabled={busy}
                  onChange={() => setPicked((p) => setQty(p, lines, l.id, k === 1 ? 0 : 1))} />
              ) : (
                <div className="flex items-center gap-2">
                  <button type="button" aria-label={`Fewer ${l.name}`} disabled={busy || k === 0} className={stepBtn}
                    onClick={() => setPicked((p) => setQty(p, lines, l.id, k - 1))}><Minus size={18} /></button>
                  <span className="w-16 text-center text-sm font-medium tabular-nums">{ofLabel(k, l.qty)}</span>
                  <button type="button" aria-label={`More ${l.name}`} disabled={busy || k === l.qty} className={stepBtn}
                    onClick={() => setPicked((p) => setQty(p, lines, l.id, k + 1))}><Plus size={18} /></button>
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="font-medium text-brown-dark">{l.qty} × {l.name}</div>
                {l.mods.map((m, i) => <div key={i} className="pl-4 text-xs text-brown-muted">+ {m}</div>)}
                {l.note && <div className="pl-4 text-xs italic text-brown-muted">{l.note}</div>}
              </div>
              <span className="tabular-nums">{formatSen(l.amountSen)}</span>
            </div>
          )
        })}
      </div>
      <footer className="border-t border-border bg-card p-3">
        <div className="flex items-baseline justify-between">
          <span className="text-sm text-brown-muted">Selected · {units} item{units === 1 ? '' : 's'}</span>
          <span aria-label="Selected total" className="text-2xl font-semibold tabular-nums text-brown-dark">{footer}</span>
        </div>
        {preview.kind === 'error' && <p role="alert" className="mt-2 rounded bg-red-50 p-2 text-sm text-red-700">{preview.message}</p>}
        {error && <p role="alert" className="mt-2 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        {!online && <p className="mt-2 text-sm text-amber-800">{SPLIT_OFFLINE}</p>}
        {online && shiftOpen !== true && <p className="mt-2 text-sm text-amber-800">{NO_SHIFT_PAY}</p>}
        {hasDiscount && <p className="mt-2 text-sm text-amber-800">{MOVE_NEEDS_NO_DISCOUNT}</p>}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" onClick={() => setMoving(true)} disabled={moveDisabled}
            className="min-h-16 rounded-xl border border-border-mid text-lg font-semibold text-brown-dark disabled:opacity-40">Move to table</button>
          <button type="button" onClick={pay} disabled={payDisabled}
            className="min-h-16 rounded-xl bg-brown-btn text-lg font-semibold text-white hover:bg-brown-btn-hover disabled:opacity-40">Pay selected</button>
        </div>
      </footer>
      {moving && (
        <MoveToGrid billNo={bill.bill_no} targets={targets} busy={busy} hint={all ? undefined : ITEM_MOVE_HINT}
          onPick={pickTarget} onClose={() => setMoving(false)} />
      )}
      {confirm && (
        <ConfirmDialog {...confirm} busy={busy} onCancel={() => setConfirm(null)}
          onConfirm={() => { const c = confirm; setConfirm(null); c.onConfirm() }} />
      )}
    </div>
  )
}
```

If `ConfirmDialog` has no `busy` prop, drop `busy={busy}` (OrderScreen passes it, so it should exist).

- [ ] **Step 10: Run the picker tests to see them pass**

Run: `npx vitest run src/features/pos/order/SplitItemsScreen.test.tsx src/features/pos/order/splitSelection.test.ts`
Expected: PASS. If the "every unit" footer test reads `…`, check `wholeSen` comes from `summaries.get(bill.id)`.

- [ ] **Step 11: Type check**

Run: `npx tsc -b` → no errors.

- [ ] **Step 12: Commit**

```bash
git add src/features/pos/order/splitSelection.ts src/features/pos/order/splitSelection.test.ts \
  src/features/pos/order/SplitItemsScreen.tsx src/features/pos/order/SplitItemsScreen.test.tsx \
  src/features/pos/order/moveTargets.ts src/features/pos/order/moveTargets.test.ts \
  src/features/pos/order/MoveToGrid.tsx src/features/pos/order/MoveToGrid.test.tsx \
  src/features/pos/order/posApi.ts src/features/pos/checkout/checkoutApi.ts
git commit -m "$(cat <<'EOF'
feat(pos): split item picker with server-priced preview

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task A6: Payment screen split mode and `checkoutItems`

**Files:**
- Modify: `src/features/pos/checkout/checkoutApi.ts` (`checkoutItems`)
- Modify: `src/features/pos/checkout/follow.ts`, `src/features/pos/checkout/follow.test.ts`
- Modify: `src/features/pos/checkout/PaymentScreen.tsx`, `src/features/pos/checkout/PaymentScreen.test.tsx`

**Interfaces:**
- Consumes: `splitTotals(billId, items)` (A5), `SplitItem` (A5), RPC `checkout_items` (A2), `pos_checkout_state.result` for split parts (A2).
- Produces:
  - `checkoutItems(billId: string, items: SplitItem[], payments: PaymentInput[], checkoutId: string): Promise<CheckoutResult>`
  - `followBill`: an **open** bill whose state carries a `result` → `{ kind: 'paidHere', result }`
  - `PaymentScreen` prop `split?: { items: SplitItem[] }` (title comes from the caller: `splitTitle(...)`)

- [ ] **Step 1: Failing follow test**

In `src/features/pos/checkout/follow.test.ts`, inside `describe('followBill — the checkout sheet follows its bill', …)`, add:

```ts
  it('split by item: the table bill stays open, and a part paid under this screen\'s id is shown as paid here', () => {
    expect(followBill(state({ status: 'open', totals: totals(3015), result }), 3250)).toEqual({ kind: 'paidHere', result })
  })
```

Run: `npx vitest run src/features/pos/checkout/follow.test.ts` → FAIL (gets `reload`).

- [ ] **Step 2: Implement it in `src/features/pos/checkout/follow.ts`**

In `followBill`, change the `case 'open':` block to start with the result check:

```ts
    case 'open':
      if (state.result) return { kind: 'paidHere', result: state.result }   // split: a part this screen paid (the table bill stays open)
      if (!state.totals) return { kind: 'keep' }
      if (shownTotalSen === null) return { kind: 'reload', totals: state.totals, note: null }
      if (state.totals.totalSen !== shownTotalSen) return { kind: 'reload', totals: state.totals, note: BILL_CHANGED }
      return { kind: 'keep' }
```

Run: `npx vitest run src/features/pos/checkout/follow.test.ts` → PASS.

- [ ] **Step 3: `checkoutItems` in `src/features/pos/checkout/checkoutApi.ts`**

After `checkoutBill`, add:

```ts
/** Pay selected (checkout_items, split spec §4.3): the units become their own bill, paid. A timeout or a
 *  dropped connection throws — Try again resends with the SAME checkoutId, which the server answers
 *  with the first result (never charges twice). */
export async function checkoutItems(billId: string, items: SplitItem[], payments: PaymentInput[], checkoutId: string): Promise<CheckoutResult> {
  const { data, error } = await supabase
    .rpc('checkout_items', { p_bill_id: billId, p_items: items, p_payments: payments, p_checkout_id: checkoutId })
    .abortSignal(AbortSignal.timeout(CHECKOUT_TIMEOUT_MS))
  if (error) fail(error)
  return parseCheckoutResult(data)
}
```

- [ ] **Step 4: Failing Payment screen tests**

In `src/features/pos/checkout/PaymentScreen.test.tsx`:

Replace the `api` / `vi.mock('./checkoutApi', …)` block with:

```tsx
const api = vi.hoisted(() => ({
  fetchCheckoutState: vi.fn(),
  fetchPaymentMethods: vi.fn(),
  checkoutBill: vi.fn(),
  checkoutItems: vi.fn(),
  splitTotals: vi.fn(),
  fetchBillItems: vi.fn(),
}))
vi.mock('./checkoutApi', () => ({
  fetchCheckoutState: api.fetchCheckoutState,
  fetchPaymentMethods: api.fetchPaymentMethods,
  checkoutBill: api.checkoutBill,
  checkoutItems: api.checkoutItems,
  splitTotals: api.splitTotals,
}))
```

Add `api.checkoutItems.mockReset(); api.splitTotals.mockReset()` to `beforeEach`, and append this `describe` at the end of the file:

```tsx
describe('PaymentScreen — split by item (split spec §3.3)', () => {
  const itemRow = (id: string, name: string, qty: number, unit: number) => ({
    id, order_id: 'o1', product_id: `p-${id}`, name_snapshot: name, unit_price_sen: unit, sst_rate_bp: 600, takeaway_fee_sen: 0,
    order_type: 'dine_in', qty, note: null, modifiers_snapshot: [], voided_at: null, catalog_discount_bp: 0, catalog_discount_name: null,
    discount_kind: null, discount_value: null, discount_reason: null,
    orders: { order_no: '261116-009/1', source: 'counter', placed_at: '2026-11-16T04:00:00Z' },
  })
  const partTotals = { ...totals, subtotalSen: 2800, serviceChargeSen: 280, sstSen: 168, beforeRoundingSen: 3248, roundingSen: 2, totalSen: 3250 }
  const picked = [{ itemId: 'i1', qty: 1 }, { itemId: 'i2', qty: 1 }]
  const renderSplit = (onClose = vi.fn(), onPaid = vi.fn()) => {
    render(<PaymentScreen branchId="br" bill={bill} title="Table T3 · Split" refreshKey={0} earlierIds={[]} split={{ items: picked }}
      onSendIds={() => {}} onClose={onClose} onPaid={onPaid} />)
    return { onClose, onPaid }
  }
  beforeEach(() => {
    api.fetchBillItems.mockResolvedValue([itemRow('i1', 'Latte', 3, 1300), itemRow('i2', 'Cake', 1, 1500), itemRow('i3', 'Soup', 1, 900)])
    api.splitTotals.mockResolvedValue(partTotals)
  })

  it('shows the split title, only the picked units and the part\'s totals', async () => {
    renderSplit()
    await flush()
    expect(screen.getByText('Table T3 · Split')).toBeTruthy()
    expect(screen.getByText('1 × Latte')).toBeTruthy()
    expect(screen.getByText('1 × Cake')).toBeTruthy()
    expect(screen.queryByText(/Soup/)).toBeNull()
    expect(api.splitTotals).toHaveBeenCalledWith('b1', picked)
    expect(screen.getByRole('button', { name: 'Pay RM 32.50' })).toBeTruthy()
  })

  it('Pay goes through checkout_items with the picked units, never checkout_bill', async () => {
    api.checkoutItems.mockResolvedValue({ billId: 'p1', billNo: '261116-010', totalSen: 3250, changeSen: 0, receiptQueued: true })
    const { onPaid } = renderSplit()
    await flush()
    press('Cash')
    press('Pay RM 32.50')
    await flush()
    expect(api.checkoutBill).not.toHaveBeenCalled()
    expect(api.checkoutItems).toHaveBeenCalledTimes(1)
    expect(api.checkoutItems.mock.calls[0].slice(0, 3)).toEqual(['b1', picked, [{ methodId: 'm-cash', amountSen: 3250, tenderedSen: null, reference: null }]])
    expect(screen.getByText('Bill 261116-010 paid · RM 32.50')).toBeTruthy()
    press('Done')
    expect(onPaid).toHaveBeenCalledTimes(1)
  })

  it('Cancel payment goes back (PosTill reopens the picker with the selection kept)', async () => {
    const { onClose } = renderSplit()
    await flush()
    press('Cancel payment')
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('a selection the server refuses locks the screen with its words', async () => {
    api.splitTotals.mockRejectedValue(new Error('The bill changed. Check the items again.'))
    renderSplit()
    await flush()
    expect(screen.getByText('The bill changed. Check the items again.')).toBeTruthy()
    expect(screen.getAllByRole('button', { name: 'Close' }).length).toBeGreaterThan(0)
  })

  it('a part this screen paid shows as paid (the reply was lost), though the table bill is open', async () => {
    api.fetchCheckoutState.mockResolvedValue({ status: 'open', billNo: bill.bill_no, mergedIntoBillNo: null, totals,
      result: { billId: 'p1', billNo: '261116-010', totalSen: 3250, changeSen: 0, receiptQueued: true } })
    renderSplit()
    await flush()
    expect(screen.getByText('Bill 261116-010 paid · RM 32.50')).toBeTruthy()
  })
})
```

Run: `npx vitest run src/features/pos/checkout/PaymentScreen.test.tsx`
Expected: the new tests FAIL (no `split` prop yet); the old ones PASS.

- [ ] **Step 5: Implement split mode in `src/features/pos/checkout/PaymentScreen.tsx`**

Make these edits (the rest of the file is unchanged):

1. Imports — add `SplitItem`, `checkoutItems`, `splitTotals`:

```tsx
import { fetchBillItems, type BillItemRow, type OpenBillRow } from '../order/posApi'
import type { SplitItem } from '../order/splitSelection'
import type { BillTotals } from './bill'
import { checkoutBill, checkoutItems, fetchCheckoutState, fetchPaymentMethods, splitTotals, type CheckoutResult } from './checkoutApi'
```

2. The doc comment gets one more sentence, and the props gain `split` (destructured as `byItem`, since `split` is already the Split payment state):

```tsx
 *  pad on the right; Split payment for several payments. With `split` (split spec §3.3) only the picked
 *  units are paid: their totals are pos_split_totals', Pay is checkout_items, and the table bill stays
 *  open (the screen still follows it: paid, voided or merged elsewhere locks it). */
export default function PaymentScreen({ branchId, bill, title, refreshKey, earlierIds, split: byItem, onSendIds, onClose, onPaid }: {
  branchId: string
  bill: OpenBillRow
  title: string                 // "Table T3", "Takeaway 261024-004", "Table T3 · Split"
  refreshKey: number            // bumped on every bills event, order and 15 s sweep: re-read the bill
  earlierIds: string[]          // checkout ids an earlier Payment of this bill used on this iPad
  split?: { items: SplitItem[] }   // split by item: pay only these units, as their own bill
  onSendIds: (ids: string[]) => void   // every id used so far, at each send: PosPage keeps them per bill
  onClose: () => void           // Cancel payment: back to the bill (split: back to the picker)
  onPaid: () => void            // Done on the success screen: back home (split: back to the bill)
}) {
```

3. `follow` reads the part's totals in split mode:

```tsx
  const follow = async () => {
    const seq = ++readSeq.current
    try {
      let state = await fetchCheckoutState(bill.id, checkoutIds(sessionRef.current))
      if (byItem && state.status === 'open' && !state.result) {
        try {
          state = { ...state, totals: await splitTotals(bill.id, byItem.items) }
        } catch (e) {
          if (looksOffline(msg(e))) throw e
          if (seq === readSeq.current) apply({ kind: 'lock', note: msg(e) })   // the picked units changed: back to the picker
          return
        }
      }
      if (seq !== readSeq.current) return
      apply(followBill(state, totalsRef.current?.totalSen ?? null))
      if (loadFailed.current) { loadFailed.current = false; setError(null) }
    } catch (e) {
      if (seq === readSeq.current && !totalsRef.current) { loadFailed.current = true; setError(msg(e)) }
    }
  }
```

4. In `send`, the call:

```tsx
    try {
      setResult(byItem
        ? await checkoutItems(bill.id, byItem.items, toPayments(sending), s.checkoutId)
        : await checkoutBill(bill.id, toPayments(sending), s.checkoutId))
    } catch (e) {
```

5. The left column lists the picked units only. Replace

```tsx
  const live = (items ?? []).filter((i) => !i.voided_at)
  const itemCount = live.reduce((n, i) => n + i.qty, 0)
```

with

```tsx
  const live = (items ?? []).filter((i) => !i.voided_at)
  const shown = byItem
    ? byItem.items.flatMap((s) => { const it = live.find((i) => i.id === s.itemId); return it ? [{ ...it, qty: s.qty }] : [] })
    : live
  const itemCount = shown.reduce((n, i) => n + i.qty, 0)
```

and in the JSX change `{live.map((i) => (` to `{shown.map((i) => (`.

`checkBill` needs no change: `pos_checkout_state` returns the part as `result`, and `followBill` maps an open bill with a result to `paidHere`.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run src/features/pos/checkout/PaymentScreen.test.tsx src/features/pos/checkout/follow.test.ts`
Expected: PASS (old and new).

- [ ] **Step 7: Type check and commit**

Run: `npx tsc -b` → no errors.

```bash
git add src/features/pos/checkout/checkoutApi.ts src/features/pos/checkout/follow.ts src/features/pos/checkout/follow.test.ts \
  src/features/pos/checkout/PaymentScreen.tsx src/features/pos/checkout/PaymentScreen.test.tsx
git commit -m "$(cat <<'EOF'
feat(pos): Payment screen split mode pays picked units via checkout_items

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task A7: Wiring — the entry in Bill actions, routing in the till, offline state

**Files:**
- Modify: `src/features/pos/order/billActions.ts`, `src/features/pos/order/billActions.test.ts`
- Modify: `src/features/pos/order/ActionsOverlay.tsx`, `src/features/pos/order/BillActionsOverlay.tsx`
- Modify: `src/features/pos/order/OrderScreen.tsx`
- Modify: `src/features/pos/order/posScreen.ts`, `src/features/pos/order/posScreen.test.ts`
- Modify: `src/features/pos/order/PosTill.tsx`
- Modify: `src/pos/PosApp.tsx`

**Interfaces:**
- Consumes: `SplitItemsScreen` (A5), `PaymentScreen` `split` prop (A6), `splitTitle`, `SPLIT_ACTION_LABEL`, `SPLIT_OFFLINE`, `canSplit`, `Picked`, `SplitItem` (A5).
- Produces:
  - `BillAction` gains `'split'` (label `Split / Move items`), offered after `'move'` when the bill is loaded with ≥ 2 live units
  - `OverlayAction` gains `disabled?: boolean; note?: string`; `BillActionsOverlay` prop `notes?: Partial<Record<BillAction, string>>` (an action with a note is shown disabled with it)
  - `Screen` gains `{ kind: 'split'; bill; back; picked? }`; `payment` gains `split?: { items: SplitItem[]; picked: Picked }`; `order` gains `notice?: string | null`; helpers `cancelPayment(s)` and `payIdsKey(s)`
  - `OrderScreen` props `online?: boolean`, `initialNotice?: string | null`, `onSplit: (bill: OpenBillRow) => void`
  - `TillProps.online?: boolean` (default `true`); `PosApp` passes `online`

- [ ] **Step 1: Failing tests for the action list and the screen helpers**

Replace the `describe('billActions', …)` block of `src/features/pos/order/billActions.test.ts` with:

```ts
describe('billActions', () => {
  it('a table bill with items: Move, Split / Move items, Discount bill, Void bill, Pax, Pause QR', () => {
    expect(billActions(table)).toEqual(['move', 'split', 'discount_bill', 'void_bill', 'pax', 'pause_qr'])
  })
  it('one live unit: nothing to split', () => {
    expect(billActions({ ...table, liveSentCount: 1 })).toEqual(['move', 'discount_bill', 'void_bill', 'pax', 'pause_qr'])
  })
  it('drafts add Send first; a bill with nothing live offers Close empty bill instead of Void bill', () => {
    expect(billActions({ ...table, draftCount: 2, liveSentCount: 0 })).toEqual(['send', 'move', 'close_empty', 'pax', 'pause_qr'])
  })
  it('neither split, void nor close before the items are loaded', () => {
    expect(billActions({ ...table, loaded: false })).toEqual(['move', 'pax', 'pause_qr'])
  })
  it('an empty table: Pax and the QR switches; Open for QR only when QR waits for an open bill', () => {
    const empty = { ...table, hasBill: false, liveSentCount: 0, qrPaused: true }
    expect(billActions(empty)).toEqual(['pax', 'resume_qr'])
    expect(billActions({ ...empty, qrRequiresOpenBill: true })).toEqual(['pax', 'resume_qr', 'open_qr'])
  })
  it('a takeaway bill: Move, Split / Move items, Discount bill and Void bill', () => {
    expect(billActions({ ...table, isTable: false })).toEqual(['move', 'split', 'discount_bill', 'void_bill'])
    expect(billActions({ ...table, isTable: false, hasBill: false, draftCount: 1 })).toEqual(['send'])
  })
  it('a bill with a discount offers Edit and Remove instead; Remove stays even when nothing is live', () => {
    expect(billActions({ ...table, billDiscount: true })).toEqual(['move', 'split', 'edit_bill_discount', 'remove_bill_discount', 'void_bill', 'pax', 'pause_qr'])
    expect(billActions({ ...table, billDiscount: true, liveSentCount: 0 })).toEqual(['move', 'edit_bill_discount', 'remove_bill_discount', 'close_empty', 'pax', 'pause_qr'])
  })
  it('the split action reads Split / Move items', () => {
    expect(BILL_ACTION_LABEL.split).toBe('Split / Move items')
  })
})
```

and change the file's import to `import { BILL_ACTION_LABEL, billActions, itemActions } from './billActions'`.

Append to `src/features/pos/order/posScreen.test.ts` (add `cancelPayment, payIdsKey` to its import from `./posScreen`):

```ts
describe('split payment screens', () => {
  const bill = { id: 'b5', bill_no: '261116-009', table_id: 't5', order_type: 'dine_in' as const, pax: 4, opened_at: '2026-11-16T04:00:00Z',
    discount_kind: null, discount_value: null, discount_reason: null }
  const back = { kind: 'table' as const, tableId: 't5', pax: null }
  it('Cancel payment in split mode reopens the picker with the selection kept; a whole-bill Payment has no such screen', () => {
    const split = { items: [{ itemId: 'i1', qty: 1 }], picked: { i1: 1 } }
    expect(cancelPayment({ kind: 'payment', bill, back, split })).toEqual({ kind: 'split', bill, back, picked: { i1: 1 } })
    expect(cancelPayment({ kind: 'payment', bill, back })).toBeNull()
  })
  it('a split payment keeps its checkout ids apart from the whole bill\'s', () => {
    expect(payIdsKey({ kind: 'payment', bill, back })).toBe('b5')
    expect(payIdsKey({ kind: 'payment', bill, back, split: { items: [], picked: {} } })).toBe('split:b5')
  })
})
```

Run: `npx vitest run src/features/pos/order/billActions.test.ts src/features/pos/order/posScreen.test.ts`
Expected: FAIL.

- [ ] **Step 2: `billActions.ts`**

```ts
export type BillAction = 'send' | 'move' | 'split' | 'discount_bill' | 'edit_bill_discount' | 'remove_bill_discount'
  | 'void_bill' | 'close_empty' | 'pax' | 'pause_qr' | 'resume_qr' | 'open_qr'

export const BILL_ACTION_LABEL: Record<BillAction, string> = {
  send: 'Send', move: 'Move', split: 'Split / Move items', discount_bill: 'Discount bill', edit_bill_discount: 'Edit discount',
  remove_bill_discount: 'Remove discount', void_bill: 'Void bill', close_empty: 'Close empty bill', pax: 'Pax',
  pause_qr: 'Pause QR', resume_qr: 'Resume QR', open_qr: 'Open for QR',
}
```

and in `billActions` (doc comment: add "Split / Move items once loaded with two live units or more (split spec §3.1)"):

```ts
  if (p.hasBill) out.push('move')
  if (p.hasBill && p.loaded) {
    if (p.liveSentCount >= 2) out.push('split')
    if (p.billDiscount) out.push('edit_bill_discount', 'remove_bill_discount')
```

(the rest of the function unchanged).

- [ ] **Step 3: `posScreen.ts`**

Add imports `import type { Picked, SplitItem } from './splitSelection'` and change `Screen` to:

```ts
export type Screen =
  | { kind: 'home' }
  | { kind: 'order'; session: number; target: OrderTarget; lines?: OrderLine[]; catalogId?: string | null; notice?: string | null }
  | { kind: 'payment'; bill: OpenBillRow; back: OrderTarget; split?: { items: SplitItem[]; picked: Picked } }
  | { kind: 'split'; bill: OpenBillRow; back: OrderTarget; picked?: Picked }
  | { kind: 'transaction' }
```

Append:

```ts
type PaymentScreenState = Extract<Screen, { kind: 'payment' }>
/** Cancel payment in split mode (split spec §3.3): back to the picker with the selection kept;
 *  null for a whole-bill Payment (it goes back to the bill). */
export function cancelPayment(s: PaymentScreenState): Screen | null {
  return s.split ? { kind: 'split', bill: s.bill, back: s.back, picked: s.split.picked } : null
}
/** Where PosTill keeps a Payment's checkout ids: a split payment's apart from the whole bill's, so a
 *  late split part never reads as the whole bill paid, nor the other way round. */
export const payIdsKey = (s: PaymentScreenState): string => (s.split ? `split:${s.bill.id}` : s.bill.id)
```

Run: `npx vitest run src/features/pos/order/billActions.test.ts src/features/pos/order/posScreen.test.ts` → PASS.

- [ ] **Step 4: Overlays**

`src/features/pos/order/ActionsOverlay.tsx` — `OverlayAction` gains two fields and the button shows them:

```tsx
export interface OverlayAction<A extends string> {
  id: A
  label: string
  icon: ComponentType<{ size?: number }>
  danger?: boolean
  disabled?: boolean            // shown but not available now (its note says why)
  note?: string
}
```

```tsx
        {actions.map(({ id, label, icon: Icon, danger, disabled: off, note }) => (
          <button key={id} type="button" role="menuitem" disabled={disabled || off} onClick={() => onPick(id)}
            className="flex w-24 flex-col items-center gap-2 text-cream disabled:opacity-40">
            <span className={`flex h-20 w-20 items-center justify-center rounded-full ${danger ? 'bg-red-700 text-white' : 'bg-cream text-brown-dark'}`}><Icon size={30} /></span>
            <span className="text-center text-sm font-medium">{label}</span>
            {note && <span className="text-center text-xs">{note}</span>}
          </button>
        ))}
```

`src/features/pos/order/BillActionsOverlay.tsx`:

```tsx
import { ArrowRightLeft, Ban, CircleX, Pause, Percent, Play, QrCode, Scissors, Send, Undo2, Users } from 'lucide-react'
```

```tsx
const ICON: Record<BillAction, ComponentType<{ size?: number }>> = {
  send: Send, move: ArrowRightLeft, split: Scissors, discount_bill: Percent, edit_bill_discount: Percent, remove_bill_discount: Undo2,
  void_bill: Ban, close_empty: CircleX, pax: Users, pause_qr: Pause, resume_qr: Play, open_qr: QrCode,
}

/** The bill's actions (billActions()); Void bill and Close empty bill are red. An action with a note
 *  (e.g. Split / Move items offline) is shown disabled with the note under it. */
export default function BillActionsOverlay({ title, actions, disabled, notes, onPick, onClose }: {
  title: string
  actions: BillAction[]
  disabled: boolean             // a bill action is already running
  notes?: Partial<Record<BillAction, string>>
  onPick: (a: BillAction) => void
  onClose: () => void
}) {
  return (
    <ActionsOverlay title={title} menuLabel="Bill actions" empty="Nothing to do on this bill yet." disabled={disabled}
      onPick={onPick} onClose={onClose}
      actions={actions.map((a) => ({
        id: a, label: BILL_ACTION_LABEL[a], icon: ICON[a], danger: a === 'void_bill' || a === 'close_empty',
        disabled: !!notes?.[a], note: notes?.[a],
      }))} />
  )
}
```

- [ ] **Step 5: `OrderScreen.tsx`**

1. Import `SPLIT_OFFLINE` — add `import { SPLIT_OFFLINE } from './splitSelection'`.
2. Props: add to the destructuring `online = true, initialNotice = null, onSplit,` and to the type:

```tsx
  online?: boolean                           // the server answers (POS app); Split / Move items needs it
  initialNotice?: string | null              // e.g. "Moved 2 items to T7" after a move from the picker
  onSplit: (bill: OpenBillRow) => void       // Split / Move items: the picker (PosTill)
```

3. `const [notice, setNotice] = useState<string | null>(null)` becomes `useState<string | null>(initialNotice)`.
4. In `pickAction`, after the `else if (a === 'move') …` branch add:

```tsx
    else if (a === 'split' && bill) {
      if (!online) return
      if (view.draftCount > 0) {
        setConfirm({ title: discardQuestion(view.draftCount), message: 'Then Split / Move items opens.', confirmLabel: 'Discard', danger: true,
          onConfirm: () => onSplit(bill) })
        return
      }
      onSplit(bill)
    }
```

5. The overlay passes the offline note:

```tsx
        <BillActionsOverlay title={title} actions={actions} disabled={busy || sending} notes={online ? undefined : { split: SPLIT_OFFLINE }}
          onPick={pickAction} onClose={() => setDialog(null)} />
```

- [ ] **Step 6: `PosTill.tsx`**

1. Imports: add `import SplitItemsScreen from './SplitItemsScreen'`, `import { splitTitle } from './splitSelection'`, and `cancelPayment, payIdsKey` to the import from `./posScreen`.
2. `TillProps` gains:

```tsx
  /** The server answers (the POS app's useOnline). Split / Move items needs it. Craft OS: always true. */
  online?: boolean
```

and the destructuring gains `online = true`.
3. The checkout-id cleanup keeps split keys of open bills:

```tsx
  useEffect(() => {
    const open = new Set(bills.map((b) => b.id))
    for (const k of checkoutIdsByBill.current.keys()) {
      const id = k.startsWith('split:') ? k.slice('split:'.length) : k
      if (!open.has(id)) checkoutIdsByBill.current.delete(k)
    }
  }, [bills])
```

4. `openOrder` takes a notice:

```tsx
  const openOrder = (target: OrderTarget, lines?: OrderLine[], catalogId?: string | null, notice?: string | null) => {
    setNotice(null)
    editingFrom.current = null                      // editRejected sets it again after opening
    setDrafts(lines?.reduce((n, l) => n + l.qty, 0) ?? 0)
    setScreen({ kind: 'order', session: ++session.current, target, lines, catalogId, notice })
  }
```

5. The lock closes the picker too: in the lock effect change the condition to
`if (screenRef.current.kind === 'payment' || screenRef.current.kind === 'transaction' || screenRef.current.kind === 'split') goHome()`.
6. Titles: 

```tsx
  const title = screen.kind === 'home' ? 'Tables'
    : screen.kind === 'order' ? targetTitle(screen.target, orderBill, tables)
    : screen.kind === 'transaction' ? 'Transaction' : screen.kind === 'split' ? 'Split' : 'Payment'
  const current: MenuItem | null = screen.kind === 'transaction' ? 'transaction' : screen.kind === 'payment' || screen.kind === 'split' ? null : 'order'
```

7. `OrderScreen` gets `online={online}`, `initialNotice={screen.notice ?? null}` and

```tsx
          onSplit={(bill) => { setDrafts(0); setScreen({ kind: 'split', bill, back: screen.target }) }}
```

8. The picker, after the `OrderScreen` block:

```tsx
      {screen.kind === 'split' && (
        <SplitItemsScreen key={screen.bill.id} bill={screen.bill} title={billTitle(screen.bill.table_id, screen.bill.bill_no, tables)}
          tables={tables} bills={bills} summaries={summaries} refreshKey={refreshKey} online={online} shiftOpen={shift.open}
          initialPicked={screen.picked}
          onBack={() => openOrder(screen.back)}
          onPay={(items, picked) => { loadBilling(); setScreen({ kind: 'payment', bill: screen.bill, back: screen.back, split: { items, picked } }) }}
          onPayWhole={() => { loadBilling(); setScreen({ kind: 'payment', bill: screen.bill, back: screen.back }) }}
          onMoved={(notice) => { bump(); openOrder(screen.back, undefined, undefined, notice) }}
          onWholeMoved={(to) => { bump(); openOrder(to) }} />
      )}
```

9. The Payment block becomes:

```tsx
      {screen.kind === 'payment' && (
        <PaymentScreen key={`${screen.bill.id}:${screen.split ? 'split' : 'whole'}`} branchId={branchId} bill={screen.bill} refreshKey={refreshKey}
          title={screen.split ? splitTitle(billTitle(screen.bill.table_id, screen.bill.bill_no, tables)) : billTitle(screen.bill.table_id, screen.bill.bill_no, tables)}
          split={screen.split ? { items: screen.split.items } : undefined}
          earlierIds={checkoutIdsByBill.current.get(payIdsKey(screen)) ?? []}
          onSendIds={(ids) => checkoutIdsByBill.current.set(payIdsKey(screen), ids)}
          onClose={() => { const back = cancelPayment(screen); if (back) setScreen(back); else openOrder(screen.back) }}
          onPaid={() => {
            checkoutIdsByBill.current.delete(payIdsKey(screen))
            if (screen.split) openOrder(screen.back)        // split: back to the table's bill, which shows what is left
            else goHome()
            bump()
          }} />
      )}
```

10. The bottom bar is hidden on the picker as on Payment: `{screen.kind !== 'payment' && screen.kind !== 'split' && (`.

- [ ] **Step 7: `src/pos/PosApp.tsx`**

Pass the online state to the till: in the `<PosTill … />` element add `online={online}` (the `online` from `useOnline()` already in scope).

- [ ] **Step 8: Run the order tests, type check, build**

Run: `npx vitest run src/features/pos/order src/features/pos/checkout` → PASS.
Run: `npx tsc -b` → no errors.
Run: `npm run build:pos` → succeeds.

- [ ] **Step 9: Commit**

```bash
git add src/features/pos/order/billActions.ts src/features/pos/order/billActions.test.ts \
  src/features/pos/order/ActionsOverlay.tsx src/features/pos/order/BillActionsOverlay.tsx src/features/pos/order/OrderScreen.tsx \
  src/features/pos/order/posScreen.ts src/features/pos/order/posScreen.test.ts src/features/pos/order/PosTill.tsx src/pos/PosApp.tsx
git commit -m "$(cat <<'EOF'
feat(pos): Split / Move items in Bill actions, routed through the picker

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

**Part A ends here: the app is complete and working without Part B.**

---

### Task B1: `bill_parts`, `pos_part_quote`, `pay_bill_part` and the part receipt payload

**Files:**
- Create: `supabase/migration-2026-11-17-pos-bill-parts.sql`
- Create: `supabase/migration-2026-11-17-pos-bill-parts-verify.sql`

**Interfaces:**
- Consumes (Part A): `pos_check_payments(uuid, jsonb, integer)`, `pos_insert_payments(uuid, uuid, uuid, jsonb, uuid)` (re-created here), `pos_bill_totals`, `pos_my_branch`, `pos_actor`, `pos_current_device`.
- Produces:
  - table `bill_parts(id, bill_id, branch_id, part_no, ways, amount_sen, shift_id, taken_by, device_id, taken_at, receipt_queued)`; `payments.part_id`
  - `pos_bill_paid_parts(p_bill_id uuid) returns integer` — internal
  - `pos_part_same_payments(p_part_id uuid, p_payments jsonb) returns boolean`, `pos_part_result(p_part_id uuid) returns jsonb`, `pos_part_replay(bill_parts, uuid, uuid, integer, jsonb) returns jsonb` — internal
  - `pos_part_receipt_payload(p_part_id uuid) returns jsonb` (payload `kind: 'part'`), `pos_queue_part_receipt(p_part_id uuid) returns boolean` — internal
  - RPC `pos_part_quote(p_bill_id uuid, p_ways integer) returns jsonb` — `{ totalSen, paidSen, balanceSen, partsPaid, sharesPaid, ways, shareSen }`
  - RPC `pay_bill_part(p_bill_id uuid, p_part_id uuid, p_amount_sen integer, p_ways integer, p_payments jsonb, p_paid_sen integer default null) returns jsonb` (p_paid_sen added in B2: when given it must equal the bill's paid parts, else `The bill changed. Check the split again.`) — `{ partId, partNo, ways, amountSen, paidSen, balanceSen, payments, changeSen, receiptQueued }`
  - verify fixture keys: `branch`, `t1`…`t6`, `cash`, `card`, `seta`, `seta_v`, `setb`, `setb_v`, `extra`, `extra_v`, `shift`, `dev`, `sup`, `cashier`, `owner`, bills `bX` (P1), `bY` (P2), `bZ` (P3), `bW` (P4), `bV` (P5), items `Wx` (W's extra), parts `x1`, `x2`, `y1`, `y2`, `z1`, `z2`, `w1`

- [ ] **Step 1: Write the verify file**

Create `supabase/migration-2026-11-17-pos-bill-parts-verify.sql`:

```sql
-- Self-check for POS part payments (split equally / by amount, Part B). Run on craft-os-dev after
-- migration-2026-11-17-pos-bill-parts.sql. Everything is rolled back. Success = a result row
-- "VERIFY OK". Sections (one DO block each, ids in the temp table fixture): FIXTURE; B1 quote and
-- part payments; B2 the balance by checkout_bill and the guards; B3 receipts and screen reads.
-- Numbers: no service charge, 0% SST, 5 sen rounding; Set A 70.35, Set B 70.40, Extra 3.00.
begin;

create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message using errcode = 'assert_failure';
exception when raise_exception then
  if sqlerrm is distinct from p_message then
    raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
  end if;
end $$;
create function pg_temp.act(p_user uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
create temp table fixture (k text primary key, v uuid);
create function pg_temp.put(p_k text, p_v uuid) returns void
language sql as $$ insert into pg_temp.fixture(k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.id(p_k text) returns uuid
language sql as $$ select v from pg_temp.fixture where k = p_k $$;
create function pg_temp.card(p_sen integer) returns jsonb
language sql as $$ select jsonb_build_array(jsonb_build_object('methodId', pg_temp.id('card'), 'amountSen', p_sen)) $$;
-- one order of products on a table (or onto its open bill); returns the order id
create function pg_temp.order_on(p_table text, p_products text[]) returns uuid
language sql as $$
  select place_counter_order(pg_temp.id(p_table), 'dine_in', 2,
           (select jsonb_agg(jsonb_build_object('productId', pg_temp.id(p), 'variantId', pg_temp.id(p || '_v'))) from unnest(p_products) p),
           gen_random_uuid())
$$;

-- ── FIXTURE: outlet VERIFY P, tables P1–P6, Set A 70.35, Set B 70.40, Extra 3.00 (0% SST), no
--    service charge, a card and a cash method, staff with PINs, one tablet signed in, a shift open;
--    bills X (P1: Set A), Y (P2: Set B), Z (P3: Set A), W (P4: Set A + Extra), V (P5: Set A) ──
do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-0000000006a1';
  v_sup   uuid := 'eeeeeeee-0000-0000-0000-0000000006a2';
  v_dev   uuid := 'eeeeeeee-0000-0000-0000-0000000006a3';
  v_a uuid; v_t uuid; v_cat uuid; v_catalog uuid; v_p uuid; v_v uuid; v_res jsonb; v_order uuid; r record; i integer;
begin
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;
  insert into branches(name, address) values ('VERIFY P', 'p') returning id into v_a;
  perform pg_temp.put('branch', v_a);
  for i in 1..6 loop
    insert into dining_tables(branch_id, label, sort_order) values (v_a, 'P' || i, i) returning id into v_t;
    perform pg_temp.put('t' || i, v_t);
  end loop;
  insert into print_routes(branch_id, name, kind, address) values (v_a, 'Bar', 'agent', '127.0.0.1:9100');
  insert into branch_pos_settings(branch_id, receipt_route) values (v_a, 'Bar');
  insert into menu_categories(name, sort_order) values ('VERIFY P SETS', 900) returning id into v_cat;
  insert into menu_catalogs(name, sort_order) values ('VERIFY P MENU', 900) returning id into v_catalog;
  for r in select * from (values ('seta', 'Verify P Set A', 7035), ('setb', 'Verify P Set B', 7040), ('extra', 'Verify P Extra', 300)) as x(k, name, sen) loop
    insert into menu_products(name, category_id, sst_rate_bp) values (r.name, v_cat, 0) returning id into v_p;
    insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_p, '', 'Regular', r.sen) returning id into v_v;
    insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_p, 'all');
    insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_v, r.sen);
    perform pg_temp.put(r.k, v_p); perform pg_temp.put(r.k || '_v', v_v);
  end loop;
  insert into branch_catalogs(branch_id, role, catalog_id) values (v_a, 'dine_in', v_catalog), (v_a, 'takeaway', v_catalog), (v_a, 'qr', v_catalog);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_a, 'P Card', 'card', 1) returning id into v_t;
  perform pg_temp.put('card', v_t);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_a, 'P Cash', 'cash', 2) returning id into v_t;
  perform pg_temp.put('cash', v_t);
  update staff set branch_id = v_a where id = v_owner;
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_cash), (v_sup), (v_dev);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_cash, 'Verify P Cashier',    'trainee', true, current_date, 'staff', v_a),
    (v_sup,  'Verify P Supervisor', 'trainee', true, current_date, 'staff', v_a);
  update staff set system_role = 'supervisor' where id = v_sup;
  for r in select * from (values (v_cash, '1111'), (v_sup, '2222')) as x(id, pin) loop
    perform pg_temp.act(r.id);
    if not coalesce((set_my_pos_pin(r.pin, null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: PIN of %', r.id; end if;
  end loop;
  insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by) values (v_dev, v_a, 'pos', 'P Counter', 'ipad', true, v_owner);
  perform pg_temp.put('owner', v_owner); perform pg_temp.put('sup', v_sup); perform pg_temp.put('cashier', v_cash); perform pg_temp.put('dev', v_dev);
  perform pg_temp.act(v_dev);
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: cashier sign-in: %', v_res; end if;
  v_res := open_shift(10000);
  perform pg_temp.put('shift', (v_res->'shift'->>'id')::uuid);
  for r in select * from (values ('bX', 't1', array['seta']), ('bY', 't2', array['setb']), ('bZ', 't3', array['seta']),
                                 ('bW', 't4', array['seta', 'extra']), ('bV', 't5', array['seta'])) as x(k, t, products) loop
    v_order := pg_temp.order_on(r.t, r.products);
    perform pg_temp.put(r.k, (select bill_id from orders where id = v_order));
    if r.k = 'bW' then perform pg_temp.put('Wx', (select id from order_items where order_id = v_order and product_id = pg_temp.id('extra'))); end if;
  end loop;
  for r in select k from unnest(array['x1', 'x2', 'y1', 'y2', 'z1', 'z2', 'w1']) k loop
    perform pg_temp.put(r.k, gen_random_uuid());
  end loop;
end $$;

-- ── B1. Quotes and part payments (spec §4.6; §8 Part B) ──────────────────────
do $$
declare
  v_x uuid := pg_temp.id('bX');
  v_q jsonb; v_res jsonb; v_cash jsonb;
  r record;
begin
  -- schema and grants
  if not (select relrowsecurity from pg_class where relname = 'bill_parts' and relnamespace = 'public'::regnamespace)
     or has_table_privilege('authenticated', 'bill_parts', 'insert')
     or not has_table_privilege('authenticated', 'bill_parts', 'select')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'payments' and column_name = 'part_id') then
    raise exception 'FAIL B1 schema: bill_parts RLS / privileges / payments.part_id';
  end if;
  for r in select f from unnest(array['pos_part_quote(uuid,integer)', 'pay_bill_part(uuid,uuid,integer,integer,jsonb)']) f loop
    if not has_function_privilege('authenticated', r.f, 'execute') or has_function_privilege('anon', r.f, 'execute') then
      raise exception 'FAIL B1 grants: %', r.f;
    end if;
  end loop;
  for r in select f from unnest(array['pos_bill_paid_parts(uuid)', 'pos_part_result(uuid)', 'pos_part_same_payments(uuid,jsonb)',
                                      'pos_part_receipt_payload(uuid)', 'pos_queue_part_receipt(uuid)']) f loop
    if has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL B1 grants: % is internal', r.f; end if;
  end loop;

  perform pg_temp.act(pg_temp.id('dev'));
  -- RM 70.35 in 3: floor(7035 / 3 / 5) × 5 = 23.45
  v_q := pos_part_quote(v_x, 3);
  if v_q is distinct from '{"totalSen": 7035, "paidSen": 0, "balanceSen": 7035, "partsPaid": 0, "sharesPaid": 0, "ways": 3, "shareSen": 2345}'::jsonb then
    raise exception 'FAIL B1 quote X: %', v_q;
  end if;
  v_q := pos_part_quote(v_x, null);
  if v_q->'ways' <> 'null'::jsonb or v_q->'shareSen' <> 'null'::jsonb or (v_q->>'balanceSen')::int <> 7035 then
    raise exception 'FAIL B1 quote by amount: %', v_q;
  end if;
  perform pg_temp.expect_error(format('select pos_part_quote(%L, 1)', v_x), 'Invalid split', 'B1 1 way');
  perform pg_temp.expect_error(format('select pos_part_quote(%L, 21)', v_x), 'Invalid split', 'B1 21 ways');

  -- share 1 of 3 in cash, RM 50.00 received: change 26.55
  v_cash := jsonb_build_array(jsonb_build_object('methodId', pg_temp.id('cash'), 'amountSen', 2345, 'tenderedSen', 5000));
  v_res := pay_bill_part(v_x, pg_temp.id('x1'), 2345, 3, v_cash);
  if (v_res->>'partId')::uuid <> pg_temp.id('x1') or (v_res->>'partNo')::int <> 1 or (v_res->>'ways')::int <> 3
     or (v_res->>'amountSen')::int <> 2345 or (v_res->>'paidSen')::int <> 2345 or (v_res->>'balanceSen')::int <> 4690
     or (v_res->>'changeSen')::int <> 2655 or not (v_res->>'receiptQueued')::boolean
     or jsonb_array_length(v_res->'payments') <> 1
     or (select count(*) from payments where part_id = pg_temp.id('x1') and bill_id = v_x and line_no = 1
            and tendered_sen = 5000 and change_sen = 2655 and shift_id = pg_temp.id('shift')) <> 1
     or (select status from bills where id = v_x) <> 'open'
     or (select taken_by from bill_parts where id = pg_temp.id('x1')) <> pg_temp.id('cashier') then
    raise exception 'FAIL B1 part 1 of X: %', v_res;
  end if;
  -- a resend gets the first answer; other amounts or another bill are refused
  if pay_bill_part(v_x, pg_temp.id('x1'), 2345, 3, v_cash) <> v_res or (select count(*) from bill_parts where bill_id = v_x) <> 1 then
    raise exception 'FAIL B1 replay';
  end if;
  perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 2340, 3, %L)', v_x, pg_temp.id('x1'), pg_temp.card(2340)),
    'This payment was already recorded with other amounts — check Today''s bills', 'B1 replay other amount');
  perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 2345, 3, %L)', v_x, pg_temp.id('x1'), pg_temp.card(2345)),
    'This payment was already recorded with other amounts — check Today''s bills', 'B1 replay other payments');
  perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 2345, 3, %L)', pg_temp.id('bY'), pg_temp.id('x1'), v_cash),
    'This part id belongs to another bill', 'B1 replay on another bill');
  -- the N is now fixed at 3
  v_q := pos_part_quote(v_x, 5);
  if (v_q->>'ways')::int <> 3 or (v_q->>'sharesPaid')::int <> 1 or (v_q->>'partsPaid')::int <> 1 or (v_q->>'shareSen')::int <> 2345 then
    raise exception 'FAIL B1 fixed N: %', v_q;
  end if;
  perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 2345, 4, %L)', v_x, gen_random_uuid(), pg_temp.card(2345)),
    'The bill changed. Check the split again.', 'B1 another N');
  v_res := pay_bill_part(v_x, pg_temp.id('x2'), 2345, 3, pg_temp.card(2345));
  if (v_res->>'partNo')::int <> 2 or (v_res->>'balanceSen')::int <> 2345 then raise exception 'FAIL B1 part 2 of X: %', v_res; end if;
  -- the last share and anything at or above the balance are not parts
  perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 2345, 3, %L)', v_x, gen_random_uuid(), pg_temp.card(2345)),
    'Pay the rest with Pay, not as a part', 'B1 last share');
  perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 3000, null, %L)', v_x, gen_random_uuid(), pg_temp.card(3000)),
    'The amount is more than the balance', 'B1 above the balance');
  perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 0, null, %L)', v_x, gen_random_uuid(), '[]'),
    'Invalid payment amount', 'B1 zero');
  perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 1000, null, %L)', v_x, gen_random_uuid(), pg_temp.card(900)),
    'Payments (RM 9.00) do not match the total (RM 10.00)', 'B1 payments short');
  perform pg_temp.expect_error(format('select pay_bill_part(%L, null, 1000, null, %L)', v_x, pg_temp.card(1000)),
    'Part id is missing', 'B1 no part id');

  -- RM 70.40 in 3: 23.45, 23.45 (the last, 23.50, by checkout_bill in B2)
  v_res := pay_bill_part(pg_temp.id('bY'), pg_temp.id('y1'), 2345, 3, pg_temp.card(2345));
  v_q := pos_part_quote(pg_temp.id('bY'), 3);
  if (v_q->>'shareSen')::int <> 2345 or (v_q->>'balanceSen')::int <> 4695 then raise exception 'FAIL B1 Y share 2: %', v_q; end if;
  v_res := pay_bill_part(pg_temp.id('bY'), pg_temp.id('y2'), 2345, 3, pg_temp.card(2345));
  if (v_res->>'balanceSen')::int <> 2350 then raise exception 'FAIL B1 Y after 2 shares: %', v_res; end if;

  -- Z: an item added after share 1 changes share 2 (49.90 left in 2 → 24.95); the old share is refused
  v_res := pay_bill_part(pg_temp.id('bZ'), pg_temp.id('z1'), 2345, 3, pg_temp.card(2345));
  perform pg_temp.order_on('t3', array['extra']);
  v_q := pos_part_quote(pg_temp.id('bZ'), 3);
  if (v_q->>'balanceSen')::int <> 4990 or (v_q->>'shareSen')::int <> 2495 then raise exception 'FAIL B1 Z re-quote: %', v_q; end if;
  perform pg_temp.expect_error(format('select pay_bill_part(%L, %L, 2345, 3, %L)', pg_temp.id('bZ'), gen_random_uuid(), pg_temp.card(2345)),
    'The bill changed. Check the split again.', 'B1 stale share');
  v_res := pay_bill_part(pg_temp.id('bZ'), pg_temp.id('z2'), 2495, 3, pg_temp.card(2495));
  if (v_res->>'balanceSen')::int <> 2495 then raise exception 'FAIL B1 Z share 2: %', v_res; end if;

  -- W: by amount, RM 10.00 of 73.35
  v_res := pay_bill_part(pg_temp.id('bW'), pg_temp.id('w1'), 1000, null, pg_temp.card(1000));
  if (v_res->>'partNo')::int <> 1 or v_res->'ways' <> 'null'::jsonb or (v_res->>'balanceSen')::int <> 6335 then
    raise exception 'FAIL B1 W by amount: %', v_res;
  end if;

  -- one part receipt per part; a part's cash counts in its shift though no bill closed yet
  if (select count(*) from print_jobs where branch_id = pg_temp.id('branch') and payload->>'kind' = 'part') <> 7 then
    raise exception 'FAIL B1 part receipts queued';
  end if;
  v_res := pos_shift_report(pg_temp.id('shift'));
  if (v_res->'cash'->>'cashSalesSen')::int <> 2345 or (v_res->'summary'->>'billCount')::int <> 0 then
    raise exception 'FAIL B1 Z report: % %', v_res->'cash', v_res->'summary';
  end if;
end $$;

select 'VERIFY OK' as result;
rollback;
```

Later tasks insert their DO blocks above `select 'VERIFY OK' as result;`.

- [ ] **Step 2: Run the verify file on dev to see it fail**

Expected: `ERROR: FAIL B1 schema …` or `relation "bill_parts" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migration-2026-11-17-pos-bill-parts.sql`:

```sql
-- ============================================================================
-- Craft OS — POS part payments: split equally / by amount (2026-11-17). Run on craft-os-dev after
-- migration-2026-11-16-pos-split-bill.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-11-17-pos-split-bill.md
-- Design: docs/superpowers/specs/2026-11-16-pos-split-bill-design.md (§3.5, §4.6, §6, Part B)
--
-- B1  bill_parts (one row per part paid on an open bill) and payments.part_id; pos_part_quote (the
--     equal share, a multiple of 5 sen; the last share takes the rest); pay_bill_part (one part,
--     replay-safe by its client id); the part receipt (not an official receipt).
-- B2  checkout_bill takes the balance (total − parts); its replay, pos_checkout_same_payments and
--     pos_checkout_result look at the final payments only. Guards: void item / bill, item / bill
--     discount, merge as the source, and every split path (pos_split_check) refuse a bill with a part.
-- B3  The final receipt lists the parts' payments first, labelled; pos_checkout_state and
--     pos_open_bill_summaries carry paidSen.
-- Re-run hazards: re-running migration-2026-11-16-pos-split-bill.sql puts back the part-less
-- pos_insert_payments, checkout_bill, pos_split_check, pos_receipt_payload and pos_checkout_state;
-- migration-2026-10-29-pos-device-till.sql the unguarded void_bill / void_order_item;
-- migration-2026-10-30-pos-discounts.sql the unguarded discounts and merge_bills;
-- migration-2026-10-26-pos-frontend.sql the old pos_open_bill_summaries (paid_sen gone) — re-run
-- this file after any of them.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('checkout_items(uuid,jsonb,jsonb,uuid)') is null then
    raise exception 'STOP: run migration-2026-11-16-pos-split-bill.sql first (checkout_items is missing)';
  end if;
end $$;

-- ── B1. Schema ──────────────────────────────────────────────────────────────
create table if not exists bill_parts (
  id             uuid primary key,                          -- client-generated: a resend is safe
  bill_id        uuid not null references bills(id),
  branch_id      uuid not null references branches(id),
  part_no        integer not null check (part_no between 1 and 20),
  ways           integer check (ways between 2 and 20),     -- an equal split's N; null = by amount
  amount_sen     integer not null check (amount_sen > 0),
  shift_id       uuid not null references pos_shifts(id),
  taken_by       uuid references staff(id),
  device_id      uuid references pos_devices(id) on delete set null,
  taken_at       timestamptz not null default now(),
  receipt_queued boolean not null default false,            -- a replay answers it too
  unique (bill_id, part_no)
);
alter table bill_parts enable row level security;
revoke all on bill_parts from public, anon, authenticated;
grant select on bill_parts to authenticated;
drop policy if exists pos_read on bill_parts;
create policy pos_read on bill_parts for select to authenticated
  using (branch_id in (select pos_readable_branches()));
alter table payments add column if not exists part_id uuid references bill_parts(id);
create index if not exists payments_part_idx on payments(part_id) where part_id is not null;

-- ── B1. Reads ───────────────────────────────────────────────────────────────
-- What the bill's parts have paid so far. Internal.
create or replace function pos_bill_paid_parts(p_bill_id uuid) returns integer
language sql stable set search_path = public, pg_temp as $$
  select coalesce(sum(amount_sen), 0)::integer from bill_parts where bill_id = p_bill_id
$$;
revoke all on function pos_bill_paid_parts(uuid) from public, anon, authenticated;

-- pos_insert_payments: the text of migration-2026-11-16-pos-split-bill.sql (S3) with the lines marked
-- B1 changed — p_part_id is written to payments.part_id. Internal.
create or replace function pos_insert_payments(p_bill_id uuid, p_branch uuid, p_shift uuid, p_payments jsonb,
                                               p_part_id uuid default null) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_p        jsonb;
  v_m        payment_methods;
  v_amount   integer;
  v_tendered integer;
  v_n        integer := 0;
begin
  for v_p in select * from jsonb_array_elements(p_payments) loop
    v_n := v_n + 1;
    select * into v_m from payment_methods where id = (v_p->>'methodId')::uuid;
    v_amount   := (v_p->'amountSen')::numeric::integer;
    v_tendered := case when v_m.kind = 'cash' and jsonb_typeof(v_p->'tenderedSen') = 'number'
                       then (v_p->'tenderedSen')::numeric::integer end;
    insert into payments(bill_id, branch_id, method_id, method_name, kind, amount_sen, tendered_sen,
                         change_sen, reference, taken_by, line_no, shift_id, part_id)                    -- B1: part_id
    values (p_bill_id, p_branch, v_m.id, v_m.name, v_m.kind, v_amount, v_tendered,
            coalesce(v_tendered - v_amount, 0),
            nullif(trim(left(case when jsonb_typeof(v_p->'reference') = 'string' then v_p->>'reference' end, 60)), ''),
            pos_actor(), v_n, p_shift, p_part_id);                                                       -- B1: p_part_id
  end loop;
end $$;
revoke all on function pos_insert_payments(uuid, uuid, uuid, jsonb, uuid) from public, anon, authenticated;

-- A part's payments compared with a resend's (pos_checkout_same_payments over payments.part_id). Internal.
create or replace function pos_part_same_payments(p_part_id uuid, p_payments jsonb) returns boolean
language sql stable set search_path = public, pg_temp as $$
  with given as (
    select case when jsonb_typeof(p_payments) = 'array' then p_payments else null end as arr
  )
  select given.arr is not null
     and jsonb_array_length(given.arr) = (select count(*) from payments p where p.part_id = p_part_id)
     and not exists (
       select 1
         from jsonb_array_elements(coalesce(given.arr, '[]'::jsonb)) with ordinality as x(v, n)
         left join payments p on p.part_id = p_part_id and p.line_no = x.n
        where p.id is null
           or lower(x.v->>'methodId') is distinct from p.method_id::text
           or (case when jsonb_typeof(x.v->'amountSen') = 'number' then (x.v->>'amountSen')::numeric end)
                is distinct from p.amount_sen::numeric
           or (case when jsonb_typeof(x.v->'tenderedSen') = 'number' then (x.v->>'tenderedSen')::numeric end)
                is distinct from p.tendered_sen::numeric)
  from given
$$;
revoke all on function pos_part_same_payments(uuid, jsonb) from public, anon, authenticated;

-- pay_bill_part's answer for a part (a replay gives it again). Internal.
create or replace function pos_part_result(p_part_id uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'partId', bp.id, 'partNo', bp.part_no, 'ways', bp.ways, 'amountSen', bp.amount_sen,
    'paidSen', pos_bill_paid_parts(bp.bill_id),
    'balanceSen', coalesce((pos_bill_totals(bp.bill_id)->>'totalSen')::integer, 0) - pos_bill_paid_parts(bp.bill_id),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.method_name, 'kind', p.kind, 'amountSen', p.amount_sen,
                                          'tenderedSen', p.tendered_sen, 'reference', p.reference)
                       order by p.line_no, p.id)
        from payments p where p.part_id = bp.id), '[]'::jsonb),
    'changeSen', (select coalesce(sum(p.change_sen), 0) from payments p where p.part_id = bp.id),
    'receiptQueued', bp.receipt_queued)
  from bill_parts bp where bp.id = p_part_id
$$;
revoke all on function pos_part_result(uuid) from public, anon, authenticated;

-- A part id seen before: the first answer for the same bill, amount and payments. Internal.
create or replace function pos_part_replay(p_part bill_parts, p_bill_id uuid, p_branch uuid, p_amount_sen integer,
                                           p_payments jsonb) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
begin
  if p_part.bill_id <> p_bill_id or p_part.branch_id <> p_branch then
    raise exception 'This part id belongs to another bill';
  end if;
  if p_part.amount_sen is distinct from p_amount_sen or not pos_part_same_payments(p_part.id, p_payments) then
    raise exception 'This payment was already recorded with other amounts — check Today''s bills';
  end if;
  return pos_part_result(p_part.id);
end $$;
revoke all on function pos_part_replay(bill_parts, uuid, uuid, integer, jsonb) from public, anon, authenticated;

-- ── B1. The quote (spec §4.6) ────────────────────────────────────────────────
-- The caller branch's open bill: its total, what the parts paid, the balance, and for p_ways the
-- equal share — the bill's earlier N when an equal share was paid (p_ways is then ignored), else
-- p_ways (2…20); floor(balance / shares left / 5) × 5, the last share the whole balance. p_ways
-- null: the by-amount view, ways and shareSen null. sharesPaid counts equal shares only.
create or replace function pos_part_quote(p_bill_id uuid, p_ways integer) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_bill    bills;
  v_total   integer;
  v_paid    integer;
  v_parts   integer;
  v_shares  integer;
  v_fixed   integer;
  v_ways    integer;
  v_share   integer;
begin
  select * into v_bill from bills where id = p_bill_id and branch_id = pos_my_branch();
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.status <> 'open' then
    raise exception 'This bill is already %', case v_bill.status when 'paid' then 'paid'
                                                                 when 'voided' then 'voided'
                                                                 else 'merged into another bill' end;
  end if;
  v_total := coalesce((pos_bill_totals(v_bill.id)->>'totalSen')::integer, 0);
  v_paid  := pos_bill_paid_parts(v_bill.id);
  select count(*)::integer, (count(*) filter (where ways is not null))::integer into v_parts, v_shares
    from bill_parts where bill_id = v_bill.id;
  if p_ways is not null then
    select ways into v_fixed from bill_parts where bill_id = v_bill.id and ways is not null order by part_no desc limit 1;
    v_ways := coalesce(v_fixed, p_ways);
    if v_ways < 2 or v_ways > 20 then raise exception 'Invalid split'; end if;
    v_share := case when v_ways - v_shares <= 1 then v_total - v_paid
                    else (floor((v_total - v_paid)::numeric / (v_ways - v_shares) / 5) * 5)::integer end;
  end if;
  return jsonb_build_object('totalSen', v_total, 'paidSen', v_paid, 'balanceSen', v_total - v_paid,
                            'partsPaid', v_parts, 'sharesPaid', v_shares, 'ways', v_ways, 'shareSen', v_share);
end $$;
revoke all on function pos_part_quote(uuid, integer) from public, anon;
grant execute on function pos_part_quote(uuid, integer) to authenticated;

-- ── B1. The part receipt (spec §6): the bill as on a pre-bill, then this part. Not an official
--    receipt. Exactly PartReceiptPayload (src/features/pos/print/receipt.ts). Internal. ─
create or replace function pos_part_receipt_payload(p_part_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'kind', 'part',
    'route', s.receipt_route,
    'reprint', false,
    'header', jsonb_build_object(
      'title', coalesce(nullif(trim(br.receipt_title), ''), br.name),
      'legalName', nullif(trim(br.legal_name), ''),
      'registrationNo', nullif(trim(br.registration_no), ''),
      'sstNo', nullif(trim(br.sst_no), ''),
      'address', nullif(trim(br.address), ''),
      'phone', nullif(trim(br.phone), ''),
      'email', nullif(trim(br.email), '')),
    'billNo', b.bill_no,
    'closedAt', to_char(bp.taken_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'cashier', (select st.name from staff st where st.id = bp.taken_by),
    'tableLabel', t.label,
    'pax', b.pax,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'qty', oi.qty, 'name', oi.name_snapshot, 'unitSen', oi.unit_price_sen,
               'amountSen', oi.unit_price_sen * oi.qty,
               'mods', (select coalesce(jsonb_agg(m->>'name' order by ord), '[]'::jsonb)
                          from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)),
               'discounts', (select coalesce(jsonb_agg(d.j order by d.k), '[]'::jsonb) from (
                   select 1 as k, jsonb_build_object(
                            'label', coalesce(oi.catalog_discount_name, 'Catalog') || ' ' || (oi.catalog_discount_bp / 100) || '%',
                            'amountSen', (ln.l->>'catalogDiscountSen')::integer) as j
                    where coalesce((ln.l->>'catalogDiscountSen')::integer, 0) > 0
                   union all
                   select 2, jsonb_build_object(
                            'label', case when oi.discount_kind = 'percent' then 'Discount ' || (oi.discount_value / 100) || '%'
                                          else 'Discount' end,
                            'amountSen', (ln.l->>'itemDiscountSen')::integer)
                    where coalesce((ln.l->>'itemDiscountSen')::integer, 0) > 0) d))
             order by o.placed_at, oi.name_snapshot, oi.id)
        from order_items oi join orders o on o.id = oi.order_id
        left join lateral (select x.l from jsonb_array_elements(coalesce(tot.t->'lines', '[]'::jsonb)) as x(l)
                            where x.l->>'id' = oi.id::text) ln on true
       where oi.bill_id = b.id and oi.voided_at is null), '[]'::jsonb),
    'itemCount', (select coalesce(sum(oi.qty), 0) from order_items oi where oi.bill_id = b.id and oi.voided_at is null),
    'subtotalSen', (tot.t->>'subtotalSen')::integer,
    'billDiscountSen', coalesce((tot.t->>'billDiscountSen')::integer, 0),
    'sstGroups', coalesce(tot.t->'sstGroups', '[]'::jsonb),
    'serviceChargeGroups', coalesce(tot.t->'serviceChargeGroups', '[]'::jsonb),
    'takeawayFeeSen', (tot.t->>'takeawayFeeSen')::integer,
    'roundingSen', (tot.t->>'roundingSen')::integer,
    'totalSen', (tot.t->>'totalSen')::integer,
    'partNo', bp.part_no,
    'ways', bp.ways,
    'amountSen', bp.amount_sen,
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.method_name, 'kind', p.kind, 'amountSen', p.amount_sen,
                                          'tenderedSen', p.tendered_sen, 'reference', p.reference)
                       order by p.line_no, p.id)
        from payments p where p.part_id = bp.id), '[]'::jsonb),
    'changeSen', (select coalesce(sum(p.change_sen), 0) from payments p where p.part_id = bp.id),
    'paidBeforeSen', (select coalesce(sum(x.amount_sen), 0) from bill_parts x where x.bill_id = b.id and x.part_no < bp.part_no),
    'balanceSen', (tot.t->>'totalSen')::integer
                  - (select coalesce(sum(x.amount_sen), 0) from bill_parts x where x.bill_id = b.id and x.part_no <= bp.part_no),
    'footer', 'Part payment — the official receipt prints when the bill is paid in full.')
  from bill_parts bp
  join bills b on b.id = bp.bill_id
  join branches br on br.id = b.branch_id
  left join branch_pos_settings s on s.branch_id = b.branch_id
  left join dining_tables t on t.id = b.table_id
  cross join lateral (select pos_bill_totals(b.id) as t) tot
  where bp.id = p_part_id
$$;
revoke all on function pos_part_receipt_payload(uuid) from public, anon, authenticated;

-- The part receipt on the outlet's receipt route (pos_queue_receipt's way). Internal.
create or replace function pos_queue_part_receipt(p_part_id uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid;
  v_route  text;
begin
  select bp.branch_id, s.receipt_route into v_branch, v_route
    from bill_parts bp left join branch_pos_settings s on s.branch_id = bp.branch_id
   where bp.id = p_part_id;
  if v_route is null then return false; end if;
  insert into print_jobs(branch_id, route, kind, payload)
  values (v_branch, v_route, 'receipt', pos_part_receipt_payload(p_part_id));
  update bill_parts set receipt_queued = true where id = p_part_id;
  return true;
end $$;
revoke all on function pos_queue_part_receipt(uuid) from public, anon, authenticated;

-- ── B1. Pay one part (spec §4.6) ─────────────────────────────────────────────
create or replace function pay_bill_part(p_bill_id uuid, p_part_id uuid, p_amount_sen integer, p_ways integer,
                                         p_payments jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
  v_part   bill_parts;
  v_shift  uuid;
  v_total  integer;
  v_paid   integer;
  v_fixed  integer;
  v_no     integer;
begin
  if p_part_id is null then raise exception 'Part id is missing'; end if;
  -- 1. a resend of a part that went through gets the first answer
  select * into v_part from bill_parts where id = p_part_id;
  if found then return pos_part_replay(v_part, p_bill_id, v_branch, p_amount_sen, p_payments); end if;
  -- 2. the bill locked, the id once more (a resend that waited), the shift, an open bill with items
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  select * into v_part from bill_parts where id = p_part_id;
  if found then return pos_part_replay(v_part, p_bill_id, v_branch, p_amount_sen, p_payments); end if;
  select id into v_shift from pos_shifts where branch_id = v_branch and status = 'open' for share;
  if not found then raise exception 'Open the shift first'; end if;
  if v_bill.status <> 'open' then
    raise exception 'This bill is already %', case v_bill.status when 'paid' then 'paid'
                                                                 when 'voided' then 'voided'
                                                                 else 'merged into another bill' end;
  end if;
  if not exists (select 1 from order_items where bill_id = v_bill.id and voided_at is null) then
    raise exception 'This bill has no items to pay for';
  end if;
  -- 3. a part is less than the balance; the balance itself is paid with checkout_bill
  v_total := (pos_bill_totals(v_bill.id)->>'totalSen')::integer;
  v_paid  := pos_bill_paid_parts(v_bill.id);
  if p_amount_sen is null or p_amount_sen < 1 then raise exception 'Invalid payment amount'; end if;
  if p_amount_sen = v_total - v_paid then raise exception 'Pay the rest with Pay, not as a part'; end if;
  if p_amount_sen > v_total - v_paid then raise exception 'The amount is more than the balance'; end if;
  -- 4. an equal share is the share quoted now (same N; no item added since the quote)
  if p_ways is not null then
    select ways into v_fixed from bill_parts where bill_id = v_bill.id and ways is not null order by part_no desc limit 1;
    if v_fixed is not null and v_fixed <> p_ways then raise exception 'The bill changed. Check the split again.'; end if;
    if p_ways < 2 or p_ways > 20 then raise exception 'Invalid split'; end if;
    if p_amount_sen is distinct from (pos_part_quote(v_bill.id, p_ways)->>'shareSen')::integer then
      raise exception 'The bill changed. Check the split again.';
    end if;
  end if;
  -- 5. the payments, checkout_bill's rules, against the part
  perform pos_check_payments(v_branch, p_payments, p_amount_sen);
  -- 6. the part, its payments (in this shift), a bills event, the part receipt
  select coalesce(max(part_no), 0) + 1 into v_no from bill_parts where bill_id = v_bill.id;
  if v_no > 20 then raise exception 'Too many parts on one bill'; end if;
  insert into bill_parts(id, bill_id, branch_id, part_no, ways, amount_sen, shift_id, taken_by, device_id)
  values (p_part_id, v_bill.id, v_branch, v_no, p_ways, p_amount_sen, v_shift, pos_actor(), pos_current_device());
  perform pos_insert_payments(v_bill.id, v_branch, v_shift, p_payments, p_part_id);
  update bills set updated_at = now() where id = v_bill.id;
  perform pos_queue_part_receipt(p_part_id);
  return pos_part_result(p_part_id);
end $$;
revoke all on function pay_bill_part(uuid, uuid, integer, integer, jsonb) from public, anon;
grant execute on function pay_bill_part(uuid, uuid, integer, integer, jsonb) to authenticated;

notify pgrst, 'reload schema';
select 'pos bill parts applied' as result;
```

Later tasks insert their sections above `notify pgrst, 'reload schema';`.

- [ ] **Step 4: Apply on dev, run the verify file, run the scan**

Apply `supabase/migration-2026-11-17-pos-bill-parts.sql` → `pos bill parts applied`; verify → `VERIFY OK`. Re-run `supabase/migration-2026-11-16-pos-split-bill-verify.sql` → `VERIFY OK` (payments without a part are unchanged).
Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts` → PASS.

Note: until Task B3 ships the `part` print kind, a part receipt job on dev fails on the print host with `Unknown print job kind: part`; that is expected between B1 and B3.

- [ ] **Step 5: Commit**

```bash
git add supabase/migration-2026-11-17-pos-bill-parts.sql supabase/migration-2026-11-17-pos-bill-parts-verify.sql
git commit -m "$(cat <<'EOF'
feat(pos): part payments on an open bill (equal shares and by amount)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task B2: `checkout_bill` takes the balance; the part-payment guards

**Files:**
- Modify: `supabase/migration-2026-11-17-pos-bill-parts.sql` (insert section B2 above `notify pgrst, 'reload schema';`)
- Modify: `supabase/migration-2026-11-17-pos-bill-parts-verify.sql` (insert block B2 above `select 'VERIFY OK' as result;`)

**Interfaces:**
- Consumes: `pos_bill_paid_parts` (B1); `pos_check_payments`, `pos_pay_and_close` (A2).
- Produces:
  - `pos_no_parts(p_bill_id uuid) returns void` — internal; raises `This bill has a part payment. Pay the rest first.`
  - `checkout_bill`: payments must add up to `totalSen − paid parts`; `pos_checkout_same_payments` and `pos_checkout_result.changeSen` count only `part_id is null` rows
  - guarded: `void_order_item`, `void_bill`, `set_item_discount`, `set_bill_discount`, `merge_bills` (source), `pos_split_check` (so `pos_split_totals`, `checkout_items`, `move_items`)

- [ ] **Step 0: Baseline**

Run the four baseline verify files (see "How SQL tasks run") and `supabase/migration-2026-11-16-pos-split-bill-verify.sql` on dev and note the results.

- [ ] **Step 1: Write the failing verify block**

Insert above `select 'VERIFY OK' as result;` of the Part B verify file:

```sql
-- ── B2. The balance by checkout_bill; the guards (spec §4.6) ─────────────────
do $$
declare
  v_x   uuid := pg_temp.id('bX');
  v_w   uuid := pg_temp.id('bW');
  v_v   uuid := pg_temp.id('bV');
  v_cid uuid := gen_random_uuid();
  v_res jsonb; v_res2 jsonb; v_order uuid;
  v_wx  jsonb := jsonb_build_array(jsonb_build_object('itemId', pg_temp.id('Wx'), 'qty', 1));
  v_msg text := 'This bill has a part payment. Pay the rest first.';
begin
  perform pg_temp.act(pg_temp.id('dev'));
  -- X (70.35, two shares paid): checkout_bill takes exactly the balance, 23.45
  perform pg_temp.expect_error(format('select checkout_bill(%L, %L, %L)', v_x, pg_temp.card(7035), gen_random_uuid()),
    'Payments (RM 70.35) do not match the total (RM 23.45)', 'B2 the whole total');
  v_res := checkout_bill(v_x, pg_temp.card(2345), v_cid);
  if (v_res->>'billId')::uuid <> v_x or (v_res->>'totalSen')::int <> 7035 or (v_res->>'changeSen')::int <> 0
     or (select status from bills where id = v_x) <> 'paid' or (select total_sen from bills where id = v_x) <> 7035
     or (select count(*) from payments where bill_id = v_x) <> 3
     or (select count(*) from payments where bill_id = v_x and part_id is null and line_no = 1 and amount_sen = 2345) <> 1 then
    raise exception 'FAIL B2 X paid: %', v_res;
  end if;
  -- its replay still works; other amounts are refused
  v_res2 := checkout_bill(v_x, pg_temp.card(2345), v_cid);
  if v_res2 <> v_res then raise exception 'FAIL B2 replay: % vs %', v_res2, v_res; end if;
  perform pg_temp.expect_error(format('select checkout_bill(%L, %L, %L)', v_x, pg_temp.card(2340), v_cid),
    'This payment was already recorded with other amounts — check Today''s bills', 'B2 replay other amounts');
  -- Y: the last share 23.50; Z: 24.95 after the extra item
  v_res := checkout_bill(pg_temp.id('bY'), pg_temp.card(2350), gen_random_uuid());
  if (v_res->>'totalSen')::int <> 7040 then raise exception 'FAIL B2 Y: %', v_res; end if;
  v_res := checkout_bill(pg_temp.id('bZ'), pg_temp.card(2495), gen_random_uuid());
  if (v_res->>'totalSen')::int <> 7335 then raise exception 'FAIL B2 Z: %', v_res; end if;

  -- guards on W (RM 10.00 paid as a part)
  perform pg_temp.expect_error(format('select void_order_item(%L, %L, %L, %L)', pg_temp.id('Wx'), 'Wrong item keyed', pg_temp.id('sup'), '2222'),
    v_msg, 'B2 void item');
  perform pg_temp.expect_error(format('select void_bill(%L, %L, %L, %L)', v_w, 'Customer left', pg_temp.id('sup'), '2222'),
    v_msg, 'B2 void bill');
  perform pg_temp.expect_error(format('select set_item_discount(%L, %L, 1000, %L, %L, %L)', pg_temp.id('Wx'), 'percent', 'Regular', pg_temp.id('sup'), '2222'),
    v_msg, 'B2 item discount');
  perform pg_temp.expect_error(format('select set_bill_discount(%L, %L, 1000, %L, %L, %L)', v_w, 'percent', 'Regular', pg_temp.id('sup'), '2222'),
    v_msg, 'B2 bill discount');
  perform pg_temp.expect_error(format('select merge_bills(%L, %L)', v_w, v_v), v_msg, 'B2 merge it away');
  perform pg_temp.expect_error(format('select pos_split_totals(%L, %L)', v_w, v_wx), v_msg, 'B2 split preview');
  perform pg_temp.expect_error(format('select checkout_items(%L, %L, %L, %L)', v_w, v_wx, pg_temp.card(300), gen_random_uuid()),
    v_msg, 'B2 split by item');
  perform pg_temp.expect_error(format('select move_items(%L, %L, %L)', v_w, v_wx, pg_temp.id('t6')), v_msg, 'B2 move items');
  -- allowed: merge another bill into it, move it to a free table, add items
  perform merge_bills(v_v, v_w);
  perform move_bill(v_w, pg_temp.id('t6'));
  v_order := pg_temp.order_on('t6', array['extra']);
  if (select bill_id from orders where id = v_order) <> v_w or (select table_id from bills where id = v_w) <> pg_temp.id('t6')
     or (select status from bills where id = v_v) <> 'merged' then
    raise exception 'FAIL B2 merge in, move, add items on W';
  end if;

  -- Z report: 3 bills closed (X, Y, Z = 214.10); every payment in its shift (cash 23.45, card 200.65)
  v_res := pos_shift_report(pg_temp.id('shift'));
  if (v_res->'summary'->>'billCount')::int <> 3 or (v_res->'summary'->>'nettSen')::int <> 21410
     or (v_res->'cash'->>'cashSalesSen')::int <> 2345
     or (select (p->>'amountSen')::int from jsonb_array_elements(v_res->'payments') p where p->>'name' = 'P Card') <> 20065 then
    raise exception 'FAIL B2 Z report: % % %', v_res->'summary', v_res->'cash', v_res->'payments';
  end if;
end $$;
```

- [ ] **Step 2: Run the verify file on dev to see it fail**

Expected: `ERROR: FAIL B2 the whole total: no error (expected "Payments (RM 70.35) do not match the total (RM 23.45)")` — today's checkout_bill still accepts the whole total.

- [ ] **Step 3: Add section B2 to the migration**

Insert above `notify pgrst, 'reload schema';`:

```sql
-- ── B2. The guard ───────────────────────────────────────────────────────────
-- A paid part never exceeds the bill: nothing that lowers it, splits it or merges it away while it has parts. Internal.
create or replace function pos_no_parts(p_bill_id uuid) returns void
language plpgsql stable set search_path = public, pg_temp as $$
begin
  if exists (select 1 from bill_parts where bill_id = p_bill_id) then
    raise exception 'This bill has a part payment. Pay the rest first.';
  end if;
end $$;
revoke all on function pos_no_parts(uuid) from public, anon, authenticated;

-- ── B2. checkout_bill: the text of migration-2026-11-16-pos-split-bill.sql (S3) with the lines marked
--    B2 changed — the payments add up to the balance (total − parts). No parts: exactly as before. ─
CREATE OR REPLACE FUNCTION checkout_bill(p_bill_id uuid, p_payments jsonb, p_checkout_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch    uuid := pos_my_branch();
  v_bill      bills;
  v_totals    jsonb;
  v_shift     uuid;                                                -- 4a
begin
  if p_checkout_id is null then raise exception 'Checkout id is missing'; end if;
  -- a resend of a checkout that already went through gets the first answer —
  -- but only for the same bill of the caller's branch
  select * into v_bill from bills where checkout_id = p_checkout_id;
  if found then
    if v_bill.id <> p_bill_id or v_bill.branch_id <> v_branch then
      raise exception 'This checkout id belongs to another bill';
    end if;
    -- H2: the first result is replayed only for the very same payments
    if not pos_checkout_same_payments(v_bill.id, p_payments) then
      raise exception 'This payment was already recorded with other amounts — check Today''s bills';
    end if;
    return pos_checkout_result(v_bill.id);
  end if;

  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.checkout_id is not distinct from p_checkout_id then  -- won by the same checkout while we waited
    if not pos_checkout_same_payments(v_bill.id, p_payments) then                                   -- H2
      raise exception 'This payment was already recorded with other amounts — check Today''s bills';  -- H2
    end if;                                                                                          -- H2
    return pos_checkout_result(v_bill.id);
  end if;
  -- 4a: money moves only inside the branch's open shift. FOR SHARE lets checkouts run
  -- side by side, while close_shift (FOR UPDATE) waits for one in flight and then counts it.
  select id into v_shift from pos_shifts where branch_id = v_branch and status = 'open' for share;
  if not found then raise exception 'Open the shift first'; end if;
  if v_bill.status <> 'open' then
    raise exception 'This bill is already %', case v_bill.status when 'paid' then 'paid'
                                                                 when 'voided' then 'voided'
                                                                 else 'merged into another bill' end;
  end if;
  if not exists (select 1 from order_items where bill_id = v_bill.id and voided_at is null) then
    raise exception 'This bill has no items to pay for';
  end if;

  v_totals := pos_bill_totals(v_bill.id);
  perform pos_check_payments(v_branch, p_payments,
                             (v_totals->>'totalSen')::integer - pos_bill_paid_parts(v_bill.id));    -- B2: the balance
  return pos_pay_and_close(v_bill.id, v_branch, v_shift, p_payments, v_totals, p_checkout_id); -- S3: payments, paid, receipt
end $function$;

-- pos_checkout_same_payments: the live text of migration-2026-10-25-pos-hardening.sql with the lines
-- marked B2 changed — only the final checkout's payments (part_id null) are compared.
create or replace function pos_checkout_same_payments(p_bill_id uuid, p_payments jsonb) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  with given as (
    select case when jsonb_typeof(p_payments) = 'array' then p_payments else null end as arr
  )
  select given.arr is not null
     and jsonb_array_length(given.arr) = (select count(*) from payments p where p.bill_id = p_bill_id and p.part_id is null)   -- B2
     and not exists (
       select 1
         from jsonb_array_elements(coalesce(given.arr, '[]'::jsonb)) with ordinality as x(v, n)
         left join payments p on p.bill_id = p_bill_id and p.part_id is null and p.line_no = x.n                                 -- B2
        where p.id is null
           or lower(x.v->>'methodId') is distinct from p.method_id::text
           or (case when jsonb_typeof(x.v->'amountSen') = 'number' then (x.v->>'amountSen')::numeric end)
                is distinct from p.amount_sen::numeric
           or (case when jsonb_typeof(x.v->'tenderedSen') = 'number' then (x.v->>'tenderedSen')::numeric end)
                is distinct from p.tendered_sen::numeric)
  from given
$$;
revoke all on function pos_checkout_same_payments(uuid, jsonb) from public, anon, authenticated;

-- pos_checkout_result: the live text of migration-2026-10-24-pos-checkout-fn.sql with the line marked
-- B2 changed — the change of the final checkout only (each part's change was given with its part).
create or replace function pos_checkout_result(p_bill_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'billId', b.id, 'billNo', b.bill_no, 'totalSen', b.total_sen,
    'changeSen', (select coalesce(sum(p.change_sen), 0) from payments p where p.bill_id = b.id and p.part_id is null),   -- B2
    'receiptQueued', coalesce(b.receipt_queued, false))
  from bills b where b.id = p_bill_id
$$;
revoke all on function pos_checkout_result(uuid) from public, anon, authenticated;

-- ── B2. Guards: each re-created from its live text with only the line marked B2 added ─────────
-- pos_split_check: migration-2026-11-16-pos-split-bill.sql (S2). Covers pos_split_totals, checkout_items, move_items.
create or replace function pos_split_check(p_bill bills, p_items jsonb) returns integer
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_e     jsonb;
  v_id    uuid;
  v_qty   integer;
  v_line  order_items;
  v_seen  uuid[] := '{}';
  v_units integer := 0;
  v_live  integer;
begin
  perform pos_no_parts(p_bill.id);                                                                      -- B2
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 100 then
    raise exception 'Invalid selection';
  end if;
  for v_e in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_e) <> 'object' or jsonb_typeof(v_e->'itemId') is distinct from 'string'
       or (v_e->>'itemId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(v_e->'qty') is distinct from 'number'
       or (v_e->'qty')::numeric <> trunc((v_e->'qty')::numeric)
       or (v_e->'qty')::numeric < 1 or (v_e->'qty')::numeric > 100 then
      raise exception 'Invalid selection';
    end if;
    v_id  := (v_e->>'itemId')::uuid;
    v_qty := (v_e->'qty')::numeric::integer;
    if v_id = any (v_seen) then raise exception 'Invalid selection'; end if;
    v_seen := v_seen || v_id;
    select * into v_line from order_items where id = v_id;
    if not found or v_line.bill_id <> p_bill.id or v_line.voided_at is not null or v_line.qty < v_qty then
      raise exception 'The bill changed. Check the items again.';
    end if;
    v_units := v_units + v_qty;
  end loop;
  select coalesce(sum(qty), 0)::integer into v_live from order_items where bill_id = p_bill.id and voided_at is null;
  if v_units >= v_live then raise exception 'Select fewer items, or pay the whole bill'; end if;
  return v_units;
end $$;
revoke all on function pos_split_check(bills, jsonb) from public, anon, authenticated;

-- void_order_item: migration-2026-10-29-pos-device-till.sql
CREATE OR REPLACE FUNCTION void_order_item(p_item_id uuid, p_reason text, p_approver_id uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_my_branch();
  v_item   order_items;
  v_bill   bills;
  v_reason text;
  v_err    text;
begin
  select * into v_item from order_items where id = p_item_id;
  if not found then raise exception 'Item not found'; end if;
  select * into v_bill from bills where id = v_item.bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Item not found'; end if;
  select * into v_item from order_items where id = p_item_id;            -- again, under the bill lock
  if v_item.bill_id <> v_bill.id then raise exception 'The bill just changed — please try again'; end if;
  if v_item.voided_at is not null then return jsonb_build_object('ok', true); end if;   -- a retry
  perform pos_no_parts(v_bill.id);                                                                       -- B2
  if v_bill.status <> 'open' then
    raise exception 'Only items on an open bill can be voided — refund a paid bill instead';
  end if;
  v_reason := pos_check_reason(v_branch, 'void_item', p_reason);
  v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  update order_items
     set voided_at = now(), voided_by = pos_actor(), voided_device_id = pos_current_device(), void_reason = v_reason, void_approved_by = p_approver_id
   where id = p_item_id;
  update bills set updated_at = now() where id = v_bill.id;   -- H3: a bills event, so other iPads hear of it at once
  perform pos_queue_void_tickets(array[p_item_id]);
  return jsonb_build_object('ok', true);
end $function$;

-- void_bill: migration-2026-10-29-pos-device-till.sql
CREATE OR REPLACE FUNCTION void_bill(p_bill_id uuid, p_reason text, p_approver_id uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
  v_reason text;
  v_err    text;
  v_ids    uuid[];
begin
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.status = 'voided' then return jsonb_build_object('ok', true); end if;      -- a retry
  perform pos_no_parts(v_bill.id);                                                                       -- B2
  if v_bill.status = 'paid' then raise exception 'This bill is paid — refund it instead'; end if;
  if v_bill.status <> 'open' then raise exception 'This bill was merged into another bill'; end if;
  select coalesce(array_agg(id), '{}') into v_ids from order_items where bill_id = v_bill.id and voided_at is null;
  if cardinality(v_ids) > 0 then
    v_reason := pos_check_reason(v_branch, 'void_bill', p_reason);
    v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
    if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
    update order_items
       set voided_at = now(), voided_by = pos_actor(), voided_device_id = pos_current_device(), void_reason = v_reason, void_approved_by = p_approver_id
     where id = any (v_ids);
  else
    v_reason := nullif(trim(left(p_reason, 200)), '');
  end if;
  update bills
     set status = 'voided', closed_at = now(), closed_by = pos_actor(), closed_device_id = pos_current_device(), void_reason = v_reason,
         void_approved_by = case when cardinality(v_ids) > 0 then p_approver_id end
   where id = v_bill.id;
  perform pos_queue_void_tickets(v_ids);
  return jsonb_build_object('ok', true);
end $function$;

-- set_item_discount: migration-2026-10-30-pos-discounts.sql
create or replace function set_item_discount(p_item_id uuid, p_kind text, p_value integer, p_reason text,
                                             p_approver_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_item   order_items;
  v_bill   bills;
  v_reason text;
  v_err    text;
begin
  perform pos_check_discount(p_kind, p_value);
  select * into v_item from order_items where id = p_item_id;
  if not found then raise exception 'Item not found'; end if;
  select * into v_bill from bills where id = v_item.bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Item not found'; end if;
  select * into v_item from order_items where id = p_item_id;            -- again, under the bill lock
  if v_item.bill_id <> v_bill.id then raise exception 'The bill just changed — please try again'; end if;
  perform pos_no_parts(v_bill.id);                                                                       -- B2
  if v_bill.status <> 'open' then raise exception 'Only an open bill can be discounted'; end if;
  if v_item.voided_at is not null then raise exception 'A voided item cannot be discounted'; end if;
  v_reason := pos_check_reason(v_branch, 'discount', p_reason);
  v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  update order_items
     set discount_kind = p_kind, discount_value = p_value, discount_reason = v_reason,
         discount_approved_by = p_approver_id, discount_by = pos_actor(), discount_at = now()
   where id = p_item_id;
  insert into pos_discount_log(branch_id, bill_id, order_item_id, action, kind, value, reason, approved_by, actor)
  values (v_branch, v_bill.id, p_item_id, 'set', p_kind, p_value, v_reason, p_approver_id, pos_actor());
  update bills set updated_at = now() where id = v_bill.id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function set_item_discount(uuid, text, integer, text, uuid, text) from public, anon;
grant execute on function set_item_discount(uuid, text, integer, text, uuid, text) to authenticated;

-- set_bill_discount: migration-2026-10-30-pos-discounts.sql
create or replace function set_bill_discount(p_bill_id uuid, p_kind text, p_value integer, p_reason text,
                                             p_approver_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
  v_reason text;
  v_err    text;
begin
  perform pos_check_discount(p_kind, p_value);
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  perform pos_no_parts(v_bill.id);                                                                       -- B2
  if v_bill.status <> 'open' then raise exception 'Only an open bill can be discounted'; end if;
  v_reason := pos_check_reason(v_branch, 'discount', p_reason);
  v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  update bills
     set discount_kind = p_kind, discount_value = p_value, discount_reason = v_reason,
         discount_approved_by = p_approver_id, discount_by = pos_actor(), discount_at = now(), updated_at = now()
   where id = p_bill_id;
  insert into pos_discount_log(branch_id, bill_id, action, kind, value, reason, approved_by, actor)
  values (v_branch, p_bill_id, 'set', p_kind, p_value, v_reason, p_approver_id, pos_actor());
  return jsonb_build_object('ok', true);
end $$;
revoke all on function set_bill_discount(uuid, text, integer, text, uuid, text) from public, anon;
grant execute on function set_bill_discount(uuid, text, integer, text, uuid, text) to authenticated;

-- merge_bills: migration-2026-10-30-pos-discounts.sql — the source must have no part (the target may)
CREATE OR REPLACE FUNCTION merge_bills(p_from_bill uuid, p_into_bill uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_my_branch();
  v_from   bills;
  v_into   bills;
begin
  if p_from_bill is null or p_into_bill is null or p_from_bill = p_into_bill then
    raise exception 'Choose two different bills';
  end if;
  -- lock both in one fixed order, so two iPads merging the same pair cannot deadlock
  perform 1 from bills where id in (p_from_bill, p_into_bill) order by id for update;
  select * into v_from from bills where id = p_from_bill and branch_id = v_branch;
  select * into v_into from bills where id = p_into_bill and branch_id = v_branch;
  if v_from.id is null or v_into.id is null then raise exception 'Bill not found'; end if;
  perform pos_no_parts(v_from.id);                                                                       -- B2
  if v_from.status <> 'open' or v_into.status <> 'open' then raise exception 'Only open bills can be merged'; end if;
  if v_from.discount_kind is not null then raise exception 'Remove the bill discount before merging'; end if;   -- D
  if v_from.order_type = 'dine_in' and v_into.order_type = 'takeaway' then
    raise exception 'Merge the takeaway bill into the table''s bill, not the other way round';
  end if;
  update orders set bill_id = v_into.id where bill_id = v_from.id;
  update order_items set bill_id = v_into.id where bill_id = v_from.id;
  update bills
     set pax = case when v_into.pax is null and v_from.pax is null then null
                    else least(99, coalesce(v_into.pax, 0) + coalesce(v_from.pax, 0)) end
   where id = v_into.id;
  update bills
     set status = 'merged', merged_into = v_into.id, closed_at = now(), closed_by = pos_actor(), closed_device_id = pos_current_device()
   where id = v_from.id;
end $function$;
```

- [ ] **Step 4: Apply on dev, run all verify files**

Apply `supabase/migration-2026-11-17-pos-bill-parts.sql` → `pos bill parts applied`.
Run `supabase/migration-2026-11-17-pos-bill-parts-verify.sql` → `VERIFY OK`.
Re-run `supabase/migration-2026-11-16-pos-split-bill-verify.sql` and the four baseline verify files → each the same as in Step 0 (a bill with no parts behaves as before).
Run: `npx vitest run src/features/pos/sqlSafeUpdate.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add supabase/migration-2026-11-17-pos-bill-parts.sql supabase/migration-2026-11-17-pos-bill-parts-verify.sql
git commit -m "$(cat <<'EOF'
feat(pos): checkout_bill takes the balance after part payments; part-payment guards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task B3: Part receipt, part labels on the final receipt, `paidSen` on the screens' reads

**Files:**
- Modify: `supabase/migration-2026-11-17-pos-bill-parts.sql` (insert section B3 above `notify pgrst, 'reload schema';`)
- Modify: `supabase/migration-2026-11-17-pos-bill-parts-verify.sql` (insert block B3 above `select 'VERIFY OK' as result;`)
- Modify: `src/features/pos/print/receipt.ts`, `src/features/pos/print/receipt.test.ts`
- Modify: `src/features/pos/print/printJob.ts`, `src/features/pos/print/printJob.test.ts`

**Interfaces:**
- Consumes: `pos_part_receipt_payload` (B1), the `pos_receipt_payload` of Task A4, the `pos_checkout_state` of Task A2.
- Produces:
  - `pos_receipt_payload.payments[*].part: integer | null`; parts first; a part's `tenderedSen` null; `changeSen` of the final payments only
  - `pos_checkout_state` adds `"paidSen": int` and `"parts": [{ "id", "partNo", "ways", "amountSen", "methods": [text] }]` (open bills; `0` / `[]` otherwise)
  - `pos_open_bill_summaries` returns `(bill_id, total_sen, item_count, paid_sen)`
  - `receipt.ts`: `ReceiptPayment.part?: number | null`, `PartReceiptPayload`, `partLabel(partNo, ways)`, `renderPartReceiptLines(payload, cols)`
  - `printJob.ts`: `JobPayload` includes `PartReceiptPayload`; `renderJobLines` / `jobLabel` handle `kind: 'part'`

- [ ] **Step 1: Write the failing verify block**

Insert above `select 'VERIFY OK' as result;`:

```sql
-- ── B3. Part receipt, the final receipt's parts, the screens' reads (spec §4.6, §6) ──
do $$
declare
  v_w   uuid := pg_temp.id('bW');
  v_res jsonb;
begin
  perform pg_temp.act(pg_temp.id('dev'));
  -- X share 1: the bill as a pre-bill, then Part 1 of 3, its cash and change, paid before, balance
  v_res := pos_part_receipt_payload(pg_temp.id('x1'));
  if v_res->>'kind' <> 'part' or (v_res->>'partNo')::int <> 1 or (v_res->>'ways')::int <> 3 or (v_res->>'amountSen')::int <> 2345
     or (v_res->>'paidBeforeSen')::int <> 0 or (v_res->>'balanceSen')::int <> 4690 or (v_res->>'totalSen')::int <> 7035
     or (v_res->>'changeSen')::int <> 2655 or (v_res->'payments'->0->>'tenderedSen')::int <> 5000
     or v_res->>'footer' <> 'Part payment — the official receipt prints when the bill is paid in full.'
     or jsonb_array_length(v_res->'items') <> 1 or v_res->>'tableLabel' <> 'P1' or v_res->>'route' <> 'Bar' then
    raise exception 'FAIL B3 part receipt of X1: %', v_res;
  end if;
  -- Z share 2 after the extra item: paid before 23.45, balance 24.95 of 73.35
  v_res := pos_part_receipt_payload(pg_temp.id('z2'));
  if (v_res->>'partNo')::int <> 2 or (v_res->>'paidBeforeSen')::int <> 2345 or (v_res->>'balanceSen')::int <> 2495
     or (v_res->>'totalSen')::int <> 7335 then
    raise exception 'FAIL B3 part receipt of Z2: %', v_res;
  end if;
  if pos_part_receipt_payload(pg_temp.id('w1'))->'ways' <> 'null'::jsonb then raise exception 'FAIL B3 part receipt of W1'; end if;
  -- X's final receipt: the parts' payments first and labelled, a part's cash at its amount; the change of the last payment only
  v_res := pos_receipt_payload(pg_temp.id('bX'), false);
  if v_res->'payments' is distinct from jsonb_build_array(
        jsonb_build_object('name', 'P Cash', 'kind', 'cash', 'amountSen', 2345, 'tenderedSen', null, 'reference', null, 'part', 1),
        jsonb_build_object('name', 'P Card', 'kind', 'card', 'amountSen', 2345, 'tenderedSen', null, 'reference', null, 'part', 2),
        jsonb_build_object('name', 'P Card', 'kind', 'card', 'amountSen', 2345, 'tenderedSen', null, 'reference', null, 'part', null))
     or (v_res->>'changeSen')::int <> 0 or (v_res->>'totalSen')::int <> 7035 then
    raise exception 'FAIL B3 final receipt of X: %', v_res;
  end if;
  -- the Payment screen and the home tile read what the parts paid
  v_res := pos_checkout_state(v_w, '{}'::uuid[]);
  if (v_res->>'paidSen')::int <> 1000 or jsonb_array_length(v_res->'parts') <> 1
     or ((v_res->'parts'->0) - 'id') is distinct from '{"partNo": 1, "ways": null, "amountSen": 1000, "methods": ["P Card"]}'::jsonb
     or (v_res->'parts'->0->>'id')::uuid <> pg_temp.id('w1') then
    raise exception 'FAIL B3 checkout state of W: %', v_res;
  end if;
  v_res := pos_checkout_state(pg_temp.id('bX'), '{}'::uuid[]);
  if (v_res->>'paidSen')::int <> 0 or v_res->'parts' <> '[]'::jsonb then raise exception 'FAIL B3 a paid bill shows parts: %', v_res; end if;
  -- W: Set A + Extra + V's Set A (merged in) + Extra (added on P6) = 146.70, 10.00 paid
  if (select s.paid_sen from pos_open_bill_summaries(pg_temp.id('branch')) s where s.bill_id = v_w) <> 1000
     or (select s.total_sen from pos_open_bill_summaries(pg_temp.id('branch')) s where s.bill_id = v_w) <> 14670 then
    raise exception 'FAIL B3 summaries of W';
  end if;
end $$;
```

- [ ] **Step 2: Run the verify file on dev to see it fail**

Expected: `ERROR: FAIL B3 final receipt of X: …` (no `part` labels yet).

- [ ] **Step 3: Add section B3 to the migration**

Insert above `notify pgrst, 'reload schema';`:

1. `pos_receipt_payload` — copy the whole `create or replace function pos_receipt_payload … revoke all on function pos_receipt_payload(uuid, boolean) from public, anon, authenticated;` block from section S5 of `supabase/migration-2026-11-16-pos-split-bill.sql`, put this comment above it:

```sql
-- ── B3. Receipt: the text of migration-2026-11-16-pos-split-bill.sql (S5) with the lines marked B3
--    changed — the parts' payments come first, labelled with their part, a part's cash at its amount
--    (its change was given with its part receipt); the change is the final payments'. ─
```

and in the copy replace its `'payments'` and `'changeSen'` entries:

```sql
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.method_name, 'kind', p.kind, 'amountSen', p.amount_sen,
                                          'tenderedSen', p.tendered_sen, 'reference', p.reference)
                       order by p.line_no, p.id)
        from payments p where p.bill_id = b.id), '[]'::jsonb),
    'changeSen', (select coalesce(sum(p.change_sen), 0) from payments p where p.bill_id = b.id),
```

with:

```sql
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.method_name, 'kind', p.kind, 'amountSen', p.amount_sen,
                                          'tenderedSen', case when p.part_id is null then p.tendered_sen end,      -- B3
                                          'reference', p.reference,
                                          'part', bp.part_no)                                                       -- B3
                       order by bp.part_no nulls last, p.line_no, p.id)                                            -- B3
        from payments p left join bill_parts bp on bp.id = p.part_id                                               -- B3
       where p.bill_id = b.id), '[]'::jsonb),
    'changeSen', (select coalesce(sum(p.change_sen), 0) from payments p where p.bill_id = b.id and p.part_id is null),   -- B3
```

2. `pos_checkout_state` and `pos_open_bill_summaries`:

```sql
-- pos_checkout_state: the text of migration-2026-11-16-pos-split-bill.sql (S3) with the lines marked B3
-- added — what the parts of an open bill paid, for the Payment screen.
create or replace function pos_checkout_state(p_bill_id uuid, p_checkout_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
begin
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch;
  if not found then raise exception 'Bill not found'; end if;
  return jsonb_build_object(
    'status', v_bill.status,
    'billNo', v_bill.bill_no,
    'mergedIntoBillNo', (select m.bill_no from bills m where m.id = v_bill.merged_into),
    'totals', case when v_bill.status = 'open' then pos_bill_totals(v_bill.id) end,
    'result', case when v_bill.status = 'paid' and v_bill.checkout_id = any(coalesce(p_checkout_ids, '{}'::uuid[]))
                   then pos_checkout_result(v_bill.id)
                   else (select pos_checkout_result(p.id) from bills p                                    -- S3
                          where p.split_from = v_bill.id                                                  -- S3
                            and p.checkout_id = any(coalesce(p_checkout_ids, '{}'::uuid[]))               -- S3
                          order by p.closed_at limit 1) end,                                              -- S3
    'paidSen', case when v_bill.status = 'open' then pos_bill_paid_parts(v_bill.id) else 0 end,           -- B3
    'parts', case when v_bill.status <> 'open' then '[]'::jsonb else coalesce((                            -- B3
      select jsonb_agg(jsonb_build_object(
               'id', bp.id, 'partNo', bp.part_no, 'ways', bp.ways, 'amountSen', bp.amount_sen,
               'methods', (select coalesce(jsonb_agg(m.n order by m.first), '[]'::jsonb)
                             from (select p.method_name as n, min(p.line_no) as first
                                     from payments p where p.part_id = bp.id group by p.method_name) m))
             order by bp.part_no)
        from bill_parts bp where bp.bill_id = v_bill.id), '[]'::jsonb) end);                               -- B3
end $$;
revoke all on function pos_checkout_state(uuid, uuid[]) from public, anon;
grant execute on function pos_checkout_state(uuid, uuid[]) to authenticated;

-- pos_open_bill_summaries: the live text of migration-2026-10-26-pos-frontend.sql with the column
-- marked B3 added (paid_sen: the home tile's "Part paid"). A new result column needs a drop first.
drop function if exists pos_open_bill_summaries(uuid);
create or replace function pos_open_bill_summaries(p_branch_id uuid)
returns table (bill_id uuid, total_sen integer, item_count integer, paid_sen integer)                    -- B3: paid_sen
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_branch_id is distinct from pos_my_branch() then
    raise exception 'Not your branch';
  end if;
  return query
    select b.id,
           (pos_bill_totals(b.id)->>'totalSen')::integer,
           coalesce((select sum(oi.qty) from order_items oi
                      where oi.bill_id = b.id and oi.voided_at is null), 0)::integer,
           pos_bill_paid_parts(b.id)                                                                       -- B3
      from bills b
     where b.branch_id = p_branch_id and b.status = 'open'
     order by b.opened_at, b.id;
end $$;
revoke all on function pos_open_bill_summaries(uuid) from public, anon;
grant execute on function pos_open_bill_summaries(uuid) to authenticated;
```

- [ ] **Step 4: Apply on dev, run the verify files**

Apply → `pos bill parts applied`; Part B verify → `VERIFY OK`; Part A verify → `VERIFY OK`; discounts verify → same as baseline.

- [ ] **Step 5: Failing renderer tests**

In `src/features/pos/print/receipt.test.ts` extend the import with `lr, center, partLabel, renderPartReceiptLines, type PartReceiptPayload` and append:

```ts
describe('part payments on receipts (split bill §6)', () => {
  it('the final receipt labels each part\'s payment; a part\'s cash prints its amount', () => {
    const lines = renderReceiptLines({
      ...r87846,
      payments: [
        { name: 'Cash', kind: 'cash', amountSen: 2320, tenderedSen: null, reference: null, part: 1 },
        { name: 'Visa', kind: 'card', amountSen: 2320, tenderedSen: null, reference: 'A1', part: 2 },
        { name: 'Cash', kind: 'cash', amountSen: 4640, tenderedSen: 5000, reference: null, part: null },
      ],
      changeSen: 360,
    }, 48)
    expect(lines).toContain(lr('Part 1 - Cash', '23.20', 48)[0])
    expect(lines).toContain(lr('Part 2 - Visa', '23.20', 48)[0])
    expect(lines).toContain(lr('Cash', '50.00', 48)[0])
    expect(lines).toContain(lr('Change', '3.60', 48)[0])
  })

  it('a part receipt: the bill, then the part, its payment and change, paid before and the balance', () => {
    const part: PartReceiptPayload = {
      ...r87846, kind: 'part', partNo: 2, ways: 4, amountSen: 2320, paidBeforeSen: 2320, balanceSen: 4640,
      payments: [{ name: 'Cash', kind: 'cash', amountSen: 2320, tenderedSen: 5000, reference: null }], changeSen: 2680,
      footer: 'Part payment — the official receipt prints when the bill is paid in full.',
    }
    const lines = renderPartReceiptLines(part, 48)
    const total = lines.indexOf(lr('Total (MYR)', '92.80', 48)[0])
    expect(total).toBeGreaterThan(0)
    expect(lines.slice(total)).toEqual(expect.arrayContaining([
      center('Part 2 of 4', 48)[0].trimEnd(),
      lr('This part (MYR)', '23.20', 48)[0],
      lr('Cash', '50.00', 48)[0],
      lr('Change', '26.80', 48)[0],
      lr('Paid before', '23.20', 48)[0],
      lr('Balance due', '46.40', 48)[0],
    ]))
    expect(lines.join('\n')).toContain('Part payment - the official receipt')
    expect(lines.join('\n')).not.toContain('Charges summary')
  })

  it('labels a part with its N, or alone for a part by amount', () => {
    expect(partLabel(2, 3)).toBe('Part 2 of 3')
    expect(partLabel(2, null)).toBe('Part 2')
  })
})
```

In `src/features/pos/print/printJob.test.ts` append (import `renderPartReceiptLines, type PartReceiptPayload` from `./receipt` and `jobLabel` from `./printJob` if not imported):

```ts
describe('part receipts (split bill §6)', () => {
  const part = {
    kind: 'part', route: 'Bar', reprint: false,
    header: { title: 'Craft Cafe', legalName: null, registrationNo: null, sstNo: null, address: null, phone: null, email: null },
    billNo: '261117-003', closedAt: '2026-11-17T06:00:00.000Z', cashier: 'Aina', tableLabel: 'T5', pax: 3,
    items: [{ qty: 1, name: 'Set A', unitSen: 7035, amountSen: 7035, mods: [] }], itemCount: 1, subtotalSen: 7035, billDiscountSen: 0,
    sstGroups: [], serviceChargeGroups: [], takeawayFeeSen: 0, roundingSen: 0, totalSen: 7035,
    partNo: 1, ways: 3, amountSen: 2345, paidBeforeSen: 0, balanceSen: 4690,
    payments: [{ name: 'Cash', kind: 'cash', amountSen: 2345, tenderedSen: 5000, reference: null }], changeSen: 2655,
    footer: 'Part payment — the official receipt prints when the bill is paid in full.',
  } satisfies PartReceiptPayload
  it('renders through renderPartReceiptLines and is labelled with its part', () => {
    expect(renderJobLines(part, 42)).toEqual(renderPartReceiptLines(part, 42))
    expect(jobLabel(part)).toBe('Part receipt 261117-003 · Part 1 of 3')
  })
})
```

Run: `npx vitest run src/features/pos/print`
Expected: FAIL — `renderPartReceiptLines` / `partLabel` / `lr` usage not exported or the `part` field unknown.

- [ ] **Step 6: Implement in `src/features/pos/print/receipt.ts`**

1. `ReceiptPayment` gains `part?: number | null // a part payment's part number on the final receipt (split bill §6); null = the final payment`.
2. Add after `RefundSlipPayload`:

```ts
/** A part paid on an open bill (split bill §4.6, §6): the bill as on a pre-bill (current items and
 *  totals), then this part. Not an official receipt. pos_part_receipt_payload builds exactly this. */
export interface PartReceiptPayload extends Omit<ReceiptPayload, 'kind' | 'splitFrom'> {
  kind: 'part'
  partNo: number
  ways: number | null       // an equal split's N; null = by amount
  amountSen: number         // this part
  paidBeforeSen: number     // the parts before this one
  balanceSen: number        // what is left after this part
}

/** "Part 2 of 3"; "Part 2" for a part by amount. */
export const partLabel = (partNo: number, ways: number | null): string => (ways ? `Part ${partNo} of ${ways}` : `Part ${partNo}`)
```

3. Split `renderReceiptLines` into shared pieces and add the part renderer. Replace the whole `renderReceiptLines` function with:

```ts
type HeadInput = Pick<ReceiptPayload, 'reprint' | 'header' | 'billNo' | 'closedAt' | 'cashier' | 'pax' | 'tableLabel' | 'splitFrom'>
type BodyInput = Pick<ReceiptPayload, 'items' | 'itemCount' | 'subtotalSen' | 'billDiscountSen' | 'sstGroups' | 'serviceChargeGroups'
  | 'takeawayFeeSen' | 'roundingSen' | 'totalSen'>

/** Title, outlet details, invoice no (and Split from), date, cashier, pax, table. `r` is ASCII already. */
function headLines(r: HeadInput, cols: number): string[] {
  const h = r.header
  return [
    ...(r.reprint ? center('*** REPRINT ***', cols) : []),
    ...center(h.title, cols),
    ...(h.legalName ? center(h.legalName, cols) : []),
    ...(h.registrationNo ? center(`REG NO: ${h.registrationNo}`, cols) : []),
    ...(h.sstNo ? center(`SST NO: ${h.sstNo}`, cols) : []),
    ...(h.address ? center(h.address, cols) : []),
    ...(h.phone ? center(`TEL: ${h.phone}`, cols) : []),
    ...(h.email ? center(h.email, cols) : []),
    '',
    ...lr('Invoice no', r.billNo, cols),
    ...(r.splitFrom ? wrap(toAscii(splitFromLine(r.splitFrom)), cols) : []),
    ...lr('Date', formatMyt(r.closedAt), cols),
    ...lr('Cashier', r.cashier ?? '-', cols),
    ...(r.pax !== null ? lr('Table pax', String(r.pax), cols) : []),
    ...center(r.tableLabel ? `ORDER ${r.tableLabel}` : 'TAKEAWAY', cols),
  ]
}

/** The items, the totals and the Total (MYR) band. */
function bodyLines(r: BodyInput, cols: number): string[] {
  const rule = '-'.repeat(cols)
  return [
    rule,
    ...r.items.flatMap((it) => itemLines(it, cols)),
    rule,
    ...lr('Item count', String(r.itemCount), cols),
    ...lr('Subtotal', money(r.subtotalSen), cols),
    ...((r.billDiscountSen ?? 0) > 0 ? lr('Discount', money(-(r.billDiscountSen ?? 0)), cols) : []),
    ...r.sstGroups.flatMap((g) => lr(`SST (${pct(g.rateBp)})`, money(g.amountSen), cols)),
    ...r.serviceChargeGroups.flatMap((g) => lr(`SERVICE CHARGE (${pct(g.rateBp)})`, money(g.amountSen), cols)),
    ...(r.takeawayFeeSen > 0 ? lr('Takeaway packaging', money(r.takeawayFeeSen), cols) : []),
    ...lr('Bill rounding', money(r.roundingSen), cols),
    '='.repeat(cols),
    ...lr('Total (MYR)', money(r.totalSen), cols),
    '='.repeat(cols),
  ]
}

/** Each payment (a part's labelled "Part 1 - Cash"; cash shows what was handed over), then Change. */
function paymentLines(payments: ReceiptPayment[], changeSen: number, cols: number): string[] {
  return [
    ...payments.flatMap((p) => [
      ...lr(p.part ? toAscii(`Part ${p.part} · ${p.name}`) : p.name, money(p.kind === 'cash' ? (p.tenderedSen ?? p.amountSen) : p.amountSen), cols),
      ...(p.reference ? wrap(`Ref: ${p.reference}`, cols - 2).map((s) => `  ${s}`) : []),
    ]),
    ...lr('Change', money(changeSen), cols),
  ]
}

export function renderReceiptLines(input: ReceiptPayload, cols: number): string[] {
  const r = asciiDeep(input)
  const rule = '-'.repeat(cols)
  const charges = r.sstGroups.length + r.serviceChargeGroups.length > 0
    ? [
        'Charges summary',
        chargeRow('', 'Base Amt', 'Amount', cols),
        ...r.sstGroups.map((g) => chargeRow(`SST ${pct(g.rateBp)}`, money(g.baseSen), money(g.amountSen), cols)),
        ...r.serviceChargeGroups.map((g) => chargeRow(`SERVICE CHARGE ${pct(g.rateBp)}`, money(g.baseSen), money(g.amountSen), cols)),
        rule,
      ]
    : []
  return [
    ...headLines(r, cols),
    ...bodyLines(r, cols),
    ...paymentLines(r.payments, r.changeSen, cols),
    rule,
    ...charges,
    ...center(r.footer, cols),
  ].map((l) => l.trimEnd())
}

/** A part receipt: the bill, then "Part 2 of 3", this part's payments and change, Paid before and Balance due. */
export function renderPartReceiptLines(input: PartReceiptPayload, cols: number): string[] {
  const r = asciiDeep(input)
  return [
    ...headLines(r, cols),
    ...bodyLines(r, cols),
    ...center(partLabel(r.partNo, r.ways), cols),
    ...lr('This part (MYR)', money(r.amountSen), cols),
    ...paymentLines(r.payments, r.changeSen, cols),
    ...lr('Paid before', money(r.paidBeforeSen), cols),
    ...lr('Balance due', money(r.balanceSen), cols),
    '-'.repeat(cols),
    ...center(r.footer, cols),
  ].map((l) => l.trimEnd())
}
```

(The Task A4 edit to the invoice line moves into `headLines` above; the receipt #87846 test must still pass unchanged.)

4. `src/features/pos/print/printJob.ts`:

```ts
import { partLabel, renderPartReceiptLines, renderReceiptLines, renderRefundSlipLines, type PartReceiptPayload, type ReceiptPayload, type RefundSlipPayload } from './receipt.ts'
```

```ts
export type JobPayload = TicketPayload | ReceiptPayload | PartReceiptPayload | RefundSlipPayload | ZReportPayload
```

in `renderJobLines` add `case 'part': return renderPartReceiptLines(payload, cols)` after `case 'receipt'`, and in `jobLabel` add as its second line:

```ts
  if (payload.kind === 'part') return `Part receipt ${payload.billNo} · ${partLabel(payload.partNo, payload.ways)}`
```

- [ ] **Step 7: Run the print tests**

Run: `npx vitest run src/features/pos/print src/features/pos/sqlSafeUpdate.test.ts`
Expected: PASS (including the unchanged receipt #87846 layout test).

- [ ] **Step 8: Commit**

```bash
git add supabase/migration-2026-11-17-pos-bill-parts.sql supabase/migration-2026-11-17-pos-bill-parts-verify.sql \
  src/features/pos/print/receipt.ts src/features/pos/print/receipt.test.ts src/features/pos/print/printJob.ts src/features/pos/print/printJob.test.ts
git commit -m "$(cat <<'EOF'
feat(pos): part receipts, part labels on the final receipt, paidSen reads

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task B4: Payment screen — Split row, equal shares and amounts, paid parts and the balance

**Files:**
- Create: `src/features/pos/checkout/partSplit.ts`, `src/features/pos/checkout/partSplit.test.ts`
- Modify: `src/features/pos/checkout/checkoutApi.ts` (`partQuote`, `payBillPart`)
- Modify: `src/features/pos/checkout/follow.ts`, `src/features/pos/checkout/follow.test.ts`
- Modify: `src/features/pos/checkout/PaymentScreen.tsx`, `src/features/pos/checkout/PaymentScreen.test.tsx`
- Modify: `src/features/pos/order/PosTill.tsx`

**Interfaces:**
- Consumes: RPCs `pos_part_quote`, `pay_bill_part` (B1); `pos_checkout_state.paidSen` / `.parts` (B3); `checkout_bill` taking the balance (B2); `SPLIT_OFFLINE` (A5); `PaymentScreen` `split` (A6).
- Produces:
  - `partSplit.ts`: `PartMode = 'none' | 'equal' | 'amount'`, `BillPart { id; partNo; ways: number | null; amountSen; methods: string[] }`, `PartQuote`, `PartResult`, `PartDone`, `MIN_WAYS`, `MAX_WAYS`, `PERCENT_CHIPS`, `SPLIT_MODE_LABEL`, `BALANCE_DUE`, `AMOUNT_OVER_BALANCE`, `ENTER_AMOUNT`, `SHARE_LOADING`, `clampWays`, `fixedWays`, `splitIntoLabel`, `shareLabel`, `paidPartLabel`, `partPaidTag`, `partPaidNote`, `percentChipSen`, `partProblem`, `parsePartQuote`, `parsePartResult`, `parseBillParts`
  - `checkoutApi.partQuote(billId, ways: number | null): Promise<PartQuote>`, `checkoutApi.payBillPart(billId, partId, amountSen, ways: number | null, payments): Promise<PartResult>`
  - `CheckoutState.paidSen?: number`, `CheckoutState.parts?: BillPart[]`; `followBill(state, shownDueSen)` compares the balance (`totalSen − paidSen`)
  - `PaymentScreen` props `online?: boolean` (default `true`), `onSplitByItem?: () => void`

- [ ] **Step 1: Failing tests for the pure module**

Create `src/features/pos/checkout/partSplit.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  AMOUNT_OVER_BALANCE, BALANCE_DUE, ENTER_AMOUNT, PERCENT_CHIPS, SHARE_LOADING, SPLIT_MODE_LABEL, clampWays, fixedWays, paidPartLabel,
  parseBillParts, parsePartQuote, parsePartResult, partPaidNote, partPaidTag, partProblem, percentChipSen, shareLabel, splitIntoLabel,
  type BillPart,
} from './partSplit'

const parts: BillPart[] = [
  { id: 'x1', partNo: 1, ways: 3, amountSen: 2345, methods: ['Cash'] },
  { id: 'x2', partNo: 2, ways: null, amountSen: 1000, methods: ['Card', 'Cash'] },
  { id: 'x3', partNo: 3, ways: 3, amountSen: 2345, methods: [] },
]

describe('labels (split spec §3.5)', () => {
  it('are the spec words', () => {
    expect(SPLIT_MODE_LABEL).toEqual({ item: 'By item', equal: 'Equally', amount: 'By amount' })
    expect(splitIntoLabel(3)).toBe('Split into 3')
    expect(shareLabel(1, 3, 2345)).toBe('Share 1 of 3 · RM 23.45')
    expect(BALANCE_DUE).toBe('Balance due')
    expect(partPaidTag(2345)).toBe('Part paid · RM 23.45')
    expect(PERCENT_CHIPS).toEqual([25, 33, 50])
  })
  it('a paid part: "Paid k of N" counts equal shares only; a part by amount by its number', () => {
    expect(paidPartLabel(parts[0], parts)).toBe('Paid 1 of 3 · RM 23.45 (Cash)')
    expect(paidPartLabel(parts[1], parts)).toBe('Paid part 2 · RM 10.00 (Card, Cash)')
    expect(paidPartLabel(parts[2], parts)).toBe('Paid 2 of 3 · RM 23.45')
  })
  it('the note after a part is paid', () => {
    expect(partPaidNote({ partNo: 1, amountSen: 2345, changeSen: 2655, paidSen: 2345 })).toBe('Part 1 paid · RM 23.45 · Change RM 26.55')
    expect(partPaidNote({ partNo: 2, amountSen: 1000, changeSen: null, paidSen: 3345 })).toBe('Part 2 paid · RM 10.00')
  })
})

describe('the equal split', () => {
  it('N is 2…20, and fixed by the last equal share paid', () => {
    expect(clampWays(1)).toBe(2)
    expect(clampWays(25)).toBe(20)
    expect(clampWays(4)).toBe(4)
    expect(fixedWays([])).toBeNull()
    expect(fixedWays([parts[1]])).toBeNull()
    expect(fixedWays(parts)).toBe(3)
  })
})

describe('percent chips: of the bill total, down to 5 sen, below the balance', () => {
  it('rounds down to 5 sen', () => {
    expect(percentChipSen(7035, 33, 7035)).toBe(2320)
    expect(percentChipSen(7035, 25, 7035)).toBe(1755)
    expect(percentChipSen(7035, 50, 7035)).toBe(3515)
  })
  it('stays below the balance, or is not offered', () => {
    expect(percentChipSen(7035, 50, 2345)).toBe(2340)
    expect(percentChipSen(100, 25, 5)).toBeNull()
  })
})

describe('partProblem: what Pay checks before a part goes out', () => {
  it('by amount: an amount, not above the balance (equal to it pays the rest)', () => {
    expect(partProblem('amount', null, 7035)).toBe(ENTER_AMOUNT)
    expect(partProblem('amount', 0, 7035)).toBe(ENTER_AMOUNT)
    expect(partProblem('amount', 8000, 7035)).toBe(AMOUNT_OVER_BALANCE)
    expect(AMOUNT_OVER_BALANCE).toBe('The amount is more than the balance')
    expect(partProblem('amount', 7035, 7035)).toBeNull()
    expect(partProblem('amount', 2000, 7035)).toBeNull()
  })
  it('equally: the share must have come', () => {
    expect(partProblem('equal', null, 7035)).toBe(SHARE_LOADING)
    expect(partProblem('equal', 2345, 7035)).toBeNull()
    expect(partProblem('none', null, 7035)).toBeNull()
  })
})

describe('parsers', () => {
  it('pos_part_quote', () => {
    const q = { totalSen: 7035, paidSen: 0, balanceSen: 7035, partsPaid: 0, sharesPaid: 0, ways: 3, shareSen: 2345 }
    expect(parsePartQuote(q)).toEqual(q)
    expect(parsePartQuote({ ...q, ways: null, shareSen: null })).toEqual({ ...q, ways: null, shareSen: null })
    expect(() => parsePartQuote({ totalSen: 1 })).toThrow('Unexpected reply from the server')
  })
  it('pay_bill_part', () => {
    const r = { partId: 'x1', partNo: 1, ways: 3, amountSen: 2345, paidSen: 2345, balanceSen: 4690, payments: [], changeSen: 2655, receiptQueued: true }
    expect(parsePartResult(r)).toEqual({ partId: 'x1', partNo: 1, ways: 3, amountSen: 2345, paidSen: 2345, balanceSen: 4690, changeSen: 2655, receiptQueued: true })
    expect(() => parsePartResult({ partId: 'x1' })).toThrow('Unexpected reply from the server')
  })
  it('pos_checkout_state parts', () => {
    expect(parseBillParts([{ id: 'x1', partNo: 1, ways: 3, amountSen: 2345, methods: ['Cash'] }])).toEqual([parts[0]])
    expect(() => parseBillParts([{ id: 'x1' }])).toThrow('Unexpected reply from the server')
  })
})
```

Run: `npx vitest run src/features/pos/checkout/partSplit.test.ts` → FAIL (no module).

- [ ] **Step 2: Write `src/features/pos/checkout/partSplit.ts`**

```ts
// src/features/pos/checkout/partSplit.ts
/** Split equally / by amount (docs/superpowers/specs/2026-11-16-pos-split-bill-design.md §3.5, §4.6):
 *  the Payment screen's part payments. Pure. The server quotes every equal share (pos_part_quote);
 *  the client never divides the bill itself. */
import { formatSen } from '../order/cart'

export type PartMode = 'none' | 'equal' | 'amount'
/** A part already paid on the open bill (pos_checkout_state.parts). */
export interface BillPart { id: string; partNo: number; ways: number | null; amountSen: number; methods: string[] }
/** pos_part_quote's answer. ways / shareSen null for the by-amount view. */
export interface PartQuote {
  totalSen: number; paidSen: number; balanceSen: number; partsPaid: number; sharesPaid: number
  ways: number | null; shareSen: number | null
}
/** pay_bill_part's answer (the fields the screen uses). */
export interface PartResult {
  partId: string; partNo: number; ways: number | null; amountSen: number; paidSen: number; balanceSen: number
  changeSen: number; receiptQueued: boolean
}
/** A part that went through: from pay_bill_part, or found by Check bill (change then unknown). */
export interface PartDone { partNo: number; amountSen: number; changeSen: number | null; paidSen: number }

export const MIN_WAYS = 2
export const MAX_WAYS = 20
export const PERCENT_CHIPS = [25, 33, 50] as const
export const SPLIT_MODE_LABEL = { item: 'By item', equal: 'Equally', amount: 'By amount' } as const
export const BALANCE_DUE = 'Balance due'
export const AMOUNT_OVER_BALANCE = 'The amount is more than the balance'
export const ENTER_AMOUNT = 'Enter the amount'
export const SHARE_LOADING = 'Getting the share — try again in a moment'

export const clampWays = (n: number): number => Math.max(MIN_WAYS, Math.min(MAX_WAYS, Math.trunc(n)))
/** The N of the bill's equal split once a share was paid (it is then fixed); null before. */
export function fixedWays(parts: BillPart[]): number | null {
  const equal = parts.filter((p) => p.ways !== null)
  return equal.length > 0 ? equal[equal.length - 1].ways : null
}
export const splitIntoLabel = (n: number): string => `Split into ${n}`
export const shareLabel = (k: number, n: number, sen: number): string => `Share ${k} of ${n} · ${formatSen(sen)}`
/** "Paid 1 of 3 · RM 23.45 (Cash)" for an equal share (k counts equal shares only); "Paid part 2 · RM 10.00 (Card)" by amount. */
export function paidPartLabel(part: BillPart, parts: BillPart[]): string {
  const how = part.methods.length > 0 ? ` (${part.methods.join(', ')})` : ''
  if (part.ways !== null) {
    const k = parts.filter((p) => p.ways !== null && p.partNo <= part.partNo).length
    return `Paid ${k} of ${part.ways} · ${formatSen(part.amountSen)}${how}`
  }
  return `Paid part ${part.partNo} · ${formatSen(part.amountSen)}${how}`
}
/** The bill header and the home tile while a bill has parts. */
export const partPaidTag = (sen: number): string => `Part paid · ${formatSen(sen)}`
export function partPaidNote(r: PartDone): string {
  return `Part ${r.partNo} paid · ${formatSen(r.amountSen)}${r.changeSen !== null ? ` · Change ${formatSen(r.changeSen)}` : ''}`
}

/** A percent of the bill total, rounded down to 5 sen and kept below the balance; null when nothing is left to offer. */
export function percentChipSen(totalSen: number, pct: number, balanceSen: number): number | null {
  const want = Math.floor((totalSen * pct) / 100 / 5) * 5
  const cap = Math.floor((balanceSen - 1) / 5) * 5
  const sen = Math.min(want, cap)
  return sen > 0 ? sen : null
}

/** Pay's check of a part before it goes out. An amount equal to the balance is fine: it pays the rest (checkout_bill). */
export function partProblem(mode: PartMode, dueSen: number | null, balanceSen: number): string | null {
  if (mode === 'amount') {
    if (dueSen === null || dueSen <= 0) return ENTER_AMOUNT
    if (dueSen > balanceSen) return AMOUNT_OVER_BALANCE
    return null
  }
  if (mode === 'equal' && dueSen === null) return SHARE_LOADING
  return null
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const isNum = (x: unknown): x is number => typeof x === 'number'
const numOrNull = (x: unknown): x is number | null => x === null || typeof x === 'number'
const unexpected = (): never => { throw new Error('Unexpected reply from the server') }

export function parsePartQuote(d: unknown): PartQuote {
  if (!isObj(d) || !isNum(d.totalSen) || !isNum(d.paidSen) || !isNum(d.balanceSen) || !isNum(d.partsPaid) || !isNum(d.sharesPaid)
      || !numOrNull(d.ways) || !numOrNull(d.shareSen)) return unexpected()
  return { totalSen: d.totalSen, paidSen: d.paidSen, balanceSen: d.balanceSen, partsPaid: d.partsPaid, sharesPaid: d.sharesPaid,
           ways: d.ways, shareSen: d.shareSen }
}

export function parsePartResult(d: unknown): PartResult {
  if (!isObj(d) || typeof d.partId !== 'string' || !isNum(d.partNo) || !numOrNull(d.ways) || !isNum(d.amountSen) || !isNum(d.paidSen)
      || !isNum(d.balanceSen) || !isNum(d.changeSen) || typeof d.receiptQueued !== 'boolean') return unexpected()
  return { partId: d.partId, partNo: d.partNo, ways: d.ways, amountSen: d.amountSen, paidSen: d.paidSen, balanceSen: d.balanceSen,
           changeSen: d.changeSen, receiptQueued: d.receiptQueued }
}

export function parseBillParts(d: unknown): BillPart[] {
  if (!Array.isArray(d)) return unexpected()
  return d.map((p) => {
    if (!isObj(p) || typeof p.id !== 'string' || !isNum(p.partNo) || !numOrNull(p.ways) || !isNum(p.amountSen)
        || !Array.isArray(p.methods) || !p.methods.every((m) => typeof m === 'string')) return unexpected()
    return { id: p.id, partNo: p.partNo, ways: p.ways, amountSen: p.amountSen, methods: p.methods as string[] }
  })
}
```

Run: `npx vitest run src/features/pos/checkout/partSplit.test.ts` → PASS.

- [ ] **Step 3: API calls**

In `src/features/pos/checkout/checkoutApi.ts` add `import { parsePartQuote, parsePartResult, type PartQuote, type PartResult } from './partSplit'` and, after `checkoutItems`:

```ts
/** The equal share (pos_part_quote, split spec §4.6); ways null = the by-amount view (no share). */
export async function partQuote(billId: string, ways: number | null): Promise<PartQuote> {
  const { data, error } = await supabase
    .rpc('pos_part_quote', { p_bill_id: billId, p_ways: ways })
    .abortSignal(AbortSignal.timeout(CHECKOUT_TIMEOUT_MS))
  if (error) fail(error)
  return parsePartQuote(data)
}

/** One part payment on the open bill (pay_bill_part). partId is the attempt's id: a lost reply is
 *  resent with the SAME id and gets the first answer (never charged twice). */
export async function payBillPart(billId: string, partId: string, amountSen: number, ways: number | null,
                                  payments: PaymentInput[]): Promise<PartResult> {
  const { data, error } = await supabase
    .rpc('pay_bill_part', { p_bill_id: billId, p_part_id: partId, p_amount_sen: amountSen, p_ways: ways, p_payments: payments })
    .abortSignal(AbortSignal.timeout(CHECKOUT_TIMEOUT_MS))
  if (error) fail(error)
  return parsePartResult(data)
}
```

- [ ] **Step 4: `follow.ts` reads the parts and follows the balance — failing tests first**

Append inside `describe('followBill — …')` of `src/features/pos/checkout/follow.test.ts`:

```ts
  it('with parts paid it follows the balance: a part paid on another iPad reloads with the note', () => {
    expect(followBill(state({ totals: totals(7035), paidSen: 2345 }), 4690)).toEqual({ kind: 'keep' })
    expect(followBill(state({ totals: totals(7035), paidSen: 4690 }), 4690)).toEqual({ kind: 'reload', totals: totals(7035), note: BILL_CHANGED })
  })
```

and inside `describe('parseCheckoutState', …)`:

```ts
  it('reads what the parts paid', () => {
    const open = { status: 'open', billNo: '261117-001', mergedIntoBillNo: null, totals: totals(7035), result: null,
      paidSen: 2345, parts: [{ id: 'x1', partNo: 1, ways: 3, amountSen: 2345, methods: ['Cash'] }] }
    expect(parseCheckoutState(open)).toEqual(open)
    expect(() => parseCheckoutState({ ...open, parts: [{ id: 'x1' }] })).toThrow('Unexpected reply from the server')
  })
```

Run: `npx vitest run src/features/pos/checkout/follow.test.ts` → FAIL.

Then in `src/features/pos/checkout/follow.ts`:

```ts
import { parseBillParts, type BillPart } from './partSplit'
```

`CheckoutState` gains:

```ts
  paidSen?: number                // what the parts of an open bill paid (split spec §4.6); absent = 0
  parts?: BillPart[]              // those parts, oldest first
```

`followBill` (its parameter is now the amount due on screen — the balance):

```ts
/** shownDueSen: the balance on screen now — total minus parts (null before the first load). */
export function followBill(state: CheckoutState, shownDueSen: number | null): FollowAction {
  switch (state.status) {
    case 'paid':
      return state.result ? { kind: 'paidHere', result: state.result } : { kind: 'lock', note: PAID_ELSEWHERE }
    case 'voided':
      return { kind: 'lock', note: VOIDED_ELSEWHERE }
    case 'merged':
      return { kind: 'lock', note: mergedElsewhere(state.mergedIntoBillNo) }
    case 'open': {
      if (state.result) return { kind: 'paidHere', result: state.result }   // split: a part this screen paid (the table bill stays open)
      if (!state.totals) return { kind: 'keep' }
      const due = state.totals.totalSen - (state.paidSen ?? 0)
      if (shownDueSen === null) return { kind: 'reload', totals: state.totals, note: null }
      if (due !== shownDueSen) return { kind: 'reload', totals: state.totals, note: BILL_CHANGED }
      return { kind: 'keep' }
    }
  }
}
```

and `parseCheckoutState` returns two more fields (absent ones stay `undefined`):

```ts
  return {
    status: data.status as BillStatus,
    billNo: data.billNo,
    mergedIntoBillNo: data.mergedIntoBillNo as string | null,
    totals: data.totals as BillTotals | null,
    result: data.result === null ? null : parseCheckoutResult(data.result),
    paidSen: typeof data.paidSen === 'number' ? data.paidSen : undefined,
    parts: data.parts === undefined || data.parts === null ? undefined : parseBillParts(data.parts),
  }
```

Run: `npx vitest run src/features/pos/checkout/follow.test.ts` → PASS.

- [ ] **Step 5: Failing Payment screen tests**

In `src/features/pos/checkout/PaymentScreen.test.tsx` add `partQuote: vi.fn(), payBillPart: vi.fn()` to `api` and `partQuote: api.partQuote, payBillPart: api.payBillPart` to the `vi.mock('./checkoutApi', …)` object; add `api.partQuote.mockReset(); api.payBillPart.mockReset()` to the first `beforeEach`. Append:

```tsx
describe('PaymentScreen — split equally / by amount (split spec §3.5)', () => {
  const t7035 = { ...totals, subtotalSen: 7035, sstSen: 0, beforeRoundingSen: 7035, roundingSen: 0, totalSen: 7035 }
  const openState = (paidSen: number, parts: unknown[]) =>
    ({ status: 'open', billNo: bill.bill_no, mergedIntoBillNo: null, totals: t7035, result: null, paidSen, parts })
  const quote = (ways: number, sharesPaid: number, paidSen: number, shareSen: number) =>
    ({ totalSen: 7035, paidSen, balanceSen: 7035 - paidSen, partsPaid: sharesPaid, sharesPaid, ways, shareSen })
  const renderParts = (over: { online?: boolean; onSplitByItem?: () => void } = {}) =>
    render(<PaymentScreen branchId="br" bill={bill} title="Table T3" refreshKey={0} earlierIds={[]} online={over.online}
      onSplitByItem={over.onSplitByItem} onSendIds={() => {}} onClose={() => {}} onPaid={() => {}} />)

  it('Equally: the share comes from the server; Pay records a part and the screen stays on the bill', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(0, []))
    api.partQuote.mockImplementation(async (_id: string, ways: number) => quote(ways, 0, 0, ways === 2 ? 3515 : 2345))
    renderParts()
    await flush()
    press('Equally')
    await flush()
    expect(api.partQuote).toHaveBeenLastCalledWith('b1', 2)
    expect(screen.getByText('Share 1 of 2 · RM 35.15')).toBeTruthy()
    press('More ways')
    await flush()
    expect(screen.getByText('Split into 3')).toBeTruthy()
    expect(screen.getByText('Share 1 of 3 · RM 23.45')).toBeTruthy()
    api.payBillPart.mockResolvedValue({ partId: 'x1', partNo: 1, ways: 3, amountSen: 2345, paidSen: 2345, balanceSen: 4690, changeSen: 0, receiptQueued: true })
    api.fetchCheckoutState.mockResolvedValue(openState(2345, [{ id: 'x1', partNo: 1, ways: 3, amountSen: 2345, methods: ['Cash'] }]))
    press('Cash')
    press('Pay RM 23.45')
    await flush()
    expect(api.checkoutBill).not.toHaveBeenCalled()
    expect(api.payBillPart).toHaveBeenCalledTimes(1)
    const [billId, partId, amount, ways, payments] = api.payBillPart.mock.calls[0]
    expect([billId, typeof partId, amount, ways, payments]).toEqual(['b1', 'string', 2345, 3, [{ methodId: 'm-cash', amountSen: 2345, tenderedSen: null, reference: null }]])
    expect(screen.getByText('Part 1 paid · RM 23.45 · Change RM 0.00')).toBeTruthy()
    expect(screen.getByText('Paid 1 of 3 · RM 23.45 (Cash)')).toBeTruthy()
    expect(screen.getAllByText('Balance due').length).toBeGreaterThan(0)
    expect(screen.getAllByText('RM 46.90').length).toBeGreaterThan(0)
  })

  it('the last share is paid with checkout_bill: exactly the balance', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(4690, [
      { id: 'x1', partNo: 1, ways: 3, amountSen: 2345, methods: ['Cash'] }, { id: 'x2', partNo: 2, ways: 3, amountSen: 2345, methods: ['Card'] }]))
    api.partQuote.mockResolvedValue(quote(3, 2, 4690, 2345))
    api.checkoutBill.mockResolvedValue({ billId: 'b1', billNo: bill.bill_no, totalSen: 7035, changeSen: 0, receiptQueued: true })
    renderParts()
    await flush()
    press('Equally')
    await flush()
    expect(api.partQuote).toHaveBeenLastCalledWith('b1', 3)
    expect((screen.getByRole('button', { name: 'More ways' }) as HTMLButtonElement).disabled).toBe(true)   // N is fixed
    press('Cash')
    press('Pay RM 23.45')
    await flush()
    expect(api.payBillPart).not.toHaveBeenCalled()
    expect(api.checkoutBill.mock.calls[0][1]).toEqual([{ methodId: 'm-cash', amountSen: 2345, tenderedSen: null, reference: null }])
  })

  it('By amount: the 33% chip is a third of the total, down to 5 sen; more than the balance is refused', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(0, []))
    api.payBillPart.mockResolvedValue({ partId: 'x1', partNo: 1, ways: null, amountSen: 2320, paidSen: 2320, balanceSen: 4715, changeSen: 0, receiptQueued: true })
    renderParts()
    await flush()
    press('By amount')
    press('33%')
    expect((screen.getByLabelText('Amount (RM)') as HTMLInputElement).value).toBe('23.20')
    press('Cash')
    press('Pay RM 23.20')
    await flush()
    expect(api.payBillPart.mock.calls[0].slice(2, 4)).toEqual([2320, null])
    fireEvent.change(screen.getByLabelText('Amount (RM)'), { target: { value: '80' } })
    press('Cash')
    press('Pay RM 80.00')
    expect(screen.getByText('The amount is more than the balance')).toBeTruthy()
    expect(api.payBillPart).toHaveBeenCalledTimes(1)
  })

  it('offline the Split row is off and says why; By item opens the picker', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(0, []))
    api.fetchBillItems.mockResolvedValue([
      { id: 'i1', order_id: 'o1', product_id: 'p1', name_snapshot: 'Latte', unit_price_sen: 1300, sst_rate_bp: 0, takeaway_fee_sen: 0,
        order_type: 'dine_in', qty: 2, note: null, modifiers_snapshot: [], voided_at: null, catalog_discount_bp: 0, catalog_discount_name: null,
        discount_kind: null, discount_value: null, discount_reason: null, orders: { order_no: 'x/1', source: 'counter', placed_at: '2026-11-17T04:00:00Z' } },
    ])
    renderParts({ online: false })
    await flush()
    expect((screen.getByRole('button', { name: 'Equally' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Split needs a connection')).toBeTruthy()
    cleanup()
    const onSplitByItem = vi.fn()
    renderParts({ onSplitByItem })
    await flush()
    press('By item')
    expect(onSplitByItem).toHaveBeenCalledTimes(1)
  })

  it('By item is off once a part is paid; the Split row is not shown in split-by-item mode', async () => {
    api.fetchCheckoutState.mockResolvedValue(openState(1000, [{ id: 'x1', partNo: 1, ways: null, amountSen: 1000, methods: ['Card'] }]))
    renderParts({ onSplitByItem: vi.fn() })
    await flush()
    expect((screen.getByRole('button', { name: 'By item' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('Paid part 1 · RM 10.00 (Card)')).toBeTruthy()
    cleanup()
    render(<PaymentScreen branchId="br" bill={bill} title="Table T3 · Split" refreshKey={0} earlierIds={[]} split={{ items: [{ itemId: 'i1', qty: 1 }] }}
      onSendIds={() => {}} onClose={() => {}} onPaid={() => {}} />)
    await flush()
    expect(screen.queryByRole('group', { name: 'Split bill' })).toBeNull()
  })
})
```

Run: `npx vitest run src/features/pos/checkout/PaymentScreen.test.tsx`
Expected: the new tests FAIL; earlier ones PASS.

- [ ] **Step 6: Write the Part B version of `src/features/pos/checkout/PaymentScreen.tsx`**

Replace the whole file with:

```tsx
// src/features/pos/checkout/PaymentScreen.tsx
import { useEffect, useRef, useState } from 'react'
import { formatSen } from '../order/cart'
import { fetchBillItems, type BillItemRow, type OpenBillRow } from '../order/posApi'
import { SPLIT_OFFLINE, type SplitItem } from '../order/splitSelection'
import type { BillTotals } from './bill'
import {
  checkoutBill, checkoutItems, fetchCheckoutState, fetchPaymentMethods, partQuote, payBillPart, splitTotals, type CheckoutResult,
} from './checkoutApi'
import CheckoutTotals from './CheckoutTotals'
import DiscountRows from './DiscountRows'
import { catalogTag, discountLabel, lineDiscountRows, linesById, storedDiscount } from './discounts'
import { billChangedAtPay, followBill, type CheckoutState, type FollowAction } from './follow'
import {
  BALANCE_DUE, MAX_WAYS, MIN_WAYS, PERCENT_CHIPS, SPLIT_MODE_LABEL, clampWays, fixedWays, paidPartLabel, partPaidNote, partProblem,
  percentChipSen, shareLabel, splitIntoLabel, type BillPart, type PartDone, type PartMode, type PartQuote,
} from './partSplit'
import { CHECKED_OPEN, UNSURE, checkoutIds, linesLocked, newPaySession, nextPay, type PayEvent, type PaySession } from './paySession'
import { looksOffline } from './rpcResult'
import {
  changeSen, lineProblem, parseRinggit, payProblem, quickTenders, remainingSen, toPayments,
  type TenderLine, type TenderMethod,
} from './tender'
import { NUMPAD_KEYS, liveChangeSen, numpadPress, payTabs, singleLines, type PayTab } from './payTabs'

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e))
const money = (sen: number) => (Math.max(0, sen) / 100).toFixed(2)
const SPLIT_MODES = ['item', 'equal', 'amount'] as const

/** Full-screen Payment (spec §4), replacing the Checkout sheet. Its logic is the sheet's, unchanged:
 *  the server's totals (pos_checkout_state, re-read on every bills event and sweep), one checkout id
 *  per attempt (paySession: Try again after a lost reply never charges twice, Check bill), the
 *  follow rules (paid / voided / merged on another iPad locks the screen) and tender.ts' checks.
 *  New is only the layout: the bill on the left; the amount, method tabs, quick tender and number
 *  pad on the right; Split payment for several payments. With `split` (split spec §3.3) only the picked
 *  units are paid: their totals are pos_split_totals', Pay is checkout_items, and the table bill stays
 *  open (the screen still follows it: paid, voided or merged elsewhere locks it).
 *  The Split row (split spec §3.5): By item opens the picker; Equally pays the server's share
 *  (pos_part_quote) and By amount an amount below the balance, each as a part (pay_bill_part, the
 *  attempt's id is the part's id); the last share, or an amount equal to the balance, is a normal
 *  checkout_bill of the balance. The paid parts and the balance show above the totals. */
export default function PaymentScreen({ branchId, bill, title, refreshKey, earlierIds, split: byItem, online = true, onSplitByItem,
  onSendIds, onClose, onPaid }: {
  branchId: string
  bill: OpenBillRow
  title: string                 // "Table T3", "Takeaway 261024-004", "Table T3 · Split"
  refreshKey: number            // bumped on every bills event, order and 15 s sweep: re-read the bill
  earlierIds: string[]          // checkout ids an earlier Payment of this bill used on this iPad
  split?: { items: SplitItem[] }   // split by item: pay only these units, as their own bill
  online?: boolean              // the server answers: the Split row needs it
  onSplitByItem?: () => void    // Split → By item: the picker (PosTill)
  onSendIds: (ids: string[]) => void   // every id used so far, at each send: PosPage keeps them per bill
  onClose: () => void           // Cancel payment: back to the bill (split: back to the picker)
  onPaid: () => void            // Done on the success screen: back home (split: back to the bill)
}) {
  const [totals, setTotals] = useState<BillTotals | null>(null)
  const [methods, setMethods] = useState<TenderMethod[]>([])
  const [items, setItems] = useState<BillItemRow[] | null>(null)
  const [lines, setLines] = useState<TenderLine[]>([])
  const [split, setSplit] = useState(false)
  const [tab, setTab] = useState<PayTab | null>(null)
  const [method, setMethod] = useState<TenderMethod | null>(null)
  const [entry, setEntry] = useState('')            // the number pad: cash received (whole bill) or this payment's amount (split)
  const [entryFresh, setEntryFresh] = useState(false) // split: the entry was pre-filled, so the next digit replaces it
  const [tenderedText, setTenderedText] = useState('') // split, cash: cash received for this part ('' = exact)
  const [reference, setReference] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [methodsError, setMethodsError] = useState<string | null>(null)
  const [changeNote, setChangeNote] = useState<string | null>(null)   // the bill changed on another iPad
  const [lockNote, setLockNote] = useState<string | null>(null)       // paid, voided or merged on another iPad
  const [result, setResult] = useState<CheckoutResult | null>(null)
  const [session, setSession] = useState<PaySession>(() => newPaySession(crypto.randomUUID(), earlierIds))
  // part payments (split spec §3.5)
  const [paidSen, setPaidSen] = useState(0)
  const [parts, setParts] = useState<BillPart[]>([])
  const [partMode, setPartMode] = useState<PartMode>('none')
  const [ways, setWays] = useState(MIN_WAYS)
  const [quote, setQuote] = useState<PartQuote | null>(null)
  const [quoteError, setQuoteError] = useState<string | null>(null)
  const [amountText, setAmountText] = useState('')
  const [partNote, setPartNote] = useState<string | null>(null)       // "Part 1 paid · RM 23.45 · Change RM 26.55"
  const sessionRef = useRef(session)
  const totalsRef = useRef<BillTotals | null>(null)
  const paidRef = useRef(0)                                           // paidSen as last read: the balance follow compares
  const sentPartRef = useRef<{ amountSen: number; ways: number | null } | null>(null)   // an unsure part: Try again resends exactly it
  const loadFailed = useRef(false)
  const [methodsKey, setMethodsKey] = useState(0)    // bumped by Retry after the payment methods failed to load
  const readSeq = useRef(0)
  const keySeq = useRef(0)
  const quoteSeq = useRef(0)
  // The amount the cashier is paying against with Split off (the balance): set by the first load, moved
  // only by a Pay that found the bill changed. Pay never records an amount the cashier has not seen.
  const payingForRef = useRef<number | null>(null)

  // ── the Checkout sheet's follow logic ──
  const step = (e: PayEvent): PaySession => {
    const s = nextPay(sessionRef.current, e)
    sessionRef.current = s
    setSession(s)
    if (e.type === 'send') onSendIds(checkoutIds(s))
    return s
  }
  const apply = (a: FollowAction) => {
    if (a.kind === 'paidHere') setResult(a.result)
    else if (a.kind === 'lock') { setLockNote(a.note); setMethod(null); setError(null); setChangeNote(null) }
    else if (a.kind === 'reload') {
      totalsRef.current = a.totals
      if (payingForRef.current === null) payingForRef.current = a.totals.totalSen - paidRef.current
      setTotals(a.totals)
      if (a.note) setChangeNote(a.note)
    }
  }
  /** Takes in what the parts paid, then the follow rules on the balance give the action. */
  const absorb = (state: CheckoutState): FollowAction => {
    const shown = totalsRef.current ? totalsRef.current.totalSen - paidRef.current : null
    paidRef.current = state.paidSen ?? 0
    setPaidSen(paidRef.current)
    setParts(state.parts ?? [])
    return followBill(state, shown)
  }
  const follow = async () => {
    const seq = ++readSeq.current
    try {
      let state = await fetchCheckoutState(bill.id, checkoutIds(sessionRef.current))
      if (byItem && state.status === 'open' && !state.result) {
        try {
          state = { ...state, totals: await splitTotals(bill.id, byItem.items) }
        } catch (e) {
          if (looksOffline(msg(e))) throw e
          if (seq === readSeq.current) apply({ kind: 'lock', note: msg(e) })   // the picked units changed: back to the picker
          return
        }
      }
      if (seq !== readSeq.current) return
      apply(absorb(state))
      if (loadFailed.current) { loadFailed.current = false; setError(null) }
    } catch (e) {
      if (seq === readSeq.current && !totalsRef.current) { loadFailed.current = true; setError(msg(e)) }
    }
  }
  useEffect(() => {
    let live = true
    setMethodsError(null)
    fetchPaymentMethods(branchId, true)
      .then((rows) => { if (live) setMethods(rows.map((m) => ({ id: m.id, name: m.name, kind: m.kind, needsReference: m.needs_reference }))) })
      .catch((e) => { if (live) setMethodsError(msg(e)) })
    return () => { live = false }
  }, [branchId, methodsKey])
  useEffect(() => {
    const phase = sessionRef.current.phase
    if (!result && !lockNote && phase !== 'paying' && phase !== 'checking') void follow()
  }, [bill.id, refreshKey]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let live = true
    fetchBillItems(bill.id).then((rows) => { if (live) setItems(rows) }, () => undefined)   // the list is for reading; the totals are the server's
    return () => { live = false }
  }, [bill.id, refreshKey])
  // an equal split already started fixes N; the share is the server's, quoted again whenever the bill moves
  useEffect(() => { const f = fixedWays(parts); if (f !== null) setWays(f) }, [parts])
  useEffect(() => {
    if (partMode !== 'equal') { setQuote(null); setQuoteError(null); return }
    const seq = ++quoteSeq.current
    setQuoteError(null)
    partQuote(bill.id, ways).then(
      (q) => { if (seq === quoteSeq.current) setQuote(q) },
      (e) => { if (seq === quoteSeq.current) { setQuote(null); setQuoteError(msg(e)) } },
    )
  }, [bill.id, partMode, ways, paidSen, totals?.totalSen])

  const billTotal = totals?.totalSen ?? 0
  const balance = billTotal - paidSen
  const partDue = partMode === 'equal' ? quote?.shareSen ?? null : partMode === 'amount' ? parseRinggit(amountText) : null
  const total = partMode === 'none' ? balance : partDue ?? 0          // what this Pay records
  const isPart = partMode !== 'none' && partDue !== null && partDue > 0 && partDue < balance
  const fixed = fixedWays(parts)
  const left = remainingSen(total, lines)
  const locked = linesLocked(session) || lockNote !== null
  const busy = session.phase === 'paying' || session.phase === 'checking'
  const tabs = payTabs(methods)
  const shownTab = tabs.find((t) => t.tab === tab) ?? tabs[0] ?? null
  const due = split ? left : total

  const pick = (m: TenderMethod) => {
    if (locked) return
    setMethod(m); setError(null); setReference(''); setTenderedText('')
    setEntry(split ? money(left) : ''); setEntryFresh(split)
  }
  // A tab only shows its methods: the cashier taps the method itself before Pay (none is pre-chosen)
  const chooseTab = (t: PayTab) => {
    if (!tabs.some((x) => x.tab === t) || locked) return
    setTab(t); setMethod(null); setError(null); setReference(''); setTenderedText('')
    setEntry(''); setEntryFresh(false)
  }
  const toggleSplit = () => {
    if (locked) return
    const next = !split
    setSplit(next); setLines([]); setError(null); setReference(''); setTenderedText('')
    setEntry(next ? money(total) : ''); setEntryFresh(next)
  }
  // The Split row: By item opens the picker; Equally / By amount toggle a part payment
  const chooseMode = (m: (typeof SPLIT_MODES)[number]) => {
    if (locked || busy || !online) return
    if (m === 'item') { onSplitByItem?.(); return }
    setPartMode((cur) => (cur === m ? 'none' : m))
    setLines([]); setEntry(''); setEntryFresh(false); setTenderedText(''); setReference(''); setError(null); setPartNote(null)
  }
  const pressKey = (k: string) => {
    setEntry((t) => numpadPress(entryFresh && k !== '⌫' ? '' : t, k)); setEntryFresh(false)
  }

  // Split: add one payment (CheckoutSheet's add, unchanged rules)
  const add = (tenderedOverride?: number | null) => {
    if (!method || locked) return
    const amountSen = parseRinggit(entry)
    if (amountSen === null) { setError('Enter the amount'); return }
    let tenderedSen: number | null = null
    if (method.kind === 'cash') {
      if (tenderedOverride !== undefined) tenderedSen = tenderedOverride
      else if (tenderedText.trim()) {
        tenderedSen = parseRinggit(tenderedText)
        if (tenderedSen === null) { setError('Enter the cash received'); return }
      }
    }
    const line = { method, amountSen, tenderedSen, reference: reference.trim() || null }
    const problem = lineProblem(line, left)
    if (problem) { setError(problem); return }
    const next = [...lines, { ...line, key: String(++keySeq.current) }]
    setLines(next); setReference(''); setTenderedText(''); setError(null)
    setEntry(money(remainingSen(total, next))); setEntryFresh(true)
  }

  /** A part went through: a fresh attempt id for the next one, the screen stays on the bill. */
  const partDone = (r: PartDone) => {
    const fresh = newPaySession(crypto.randomUUID(), checkoutIds(sessionRef.current))
    sessionRef.current = fresh; setSession(fresh)
    sentPartRef.current = null
    paidRef.current = r.paidSen; setPaidSen(r.paidSen)
    payingForRef.current = (totalsRef.current?.totalSen ?? 0) - r.paidSen
    setPartNote(partPaidNote(r)); setError(null)
    setLines([]); setMethod(null); setEntry(''); setEntryFresh(false); setTenderedText(''); setReference(''); setAmountText(''); setSplit(false)
  }

  // Pay (editing) and Try again (unsure): Try again resends the SAME lines (and the same part) under the session's id
  const send = async (toSend: TenderLine[]) => {
    const s = sessionRef.current
    if (!totals || lockNote || (s.phase !== 'editing' && s.phase !== 'unsure')) return
    const sending = s.phase === 'unsure' ? lines : toSend
    if (s.phase === 'editing') {
      const problem = payProblem(total, sending)
      if (problem) { setError(problem); return }
      setLines(sending)
      sentPartRef.current = isPart ? { amountSen: total, ways: partMode === 'equal' ? quote?.ways ?? ways : null } : null
    }
    const part = sentPartRef.current
    step({ type: 'send' }); setError(null); setChangeNote(null); setPartNote(null)
    try {
      if (part) {
        const r = await payBillPart(bill.id, s.checkoutId, part.amountSen, part.ways, toPayments(sending))
        partDone({ partNo: r.partNo, amountSen: r.amountSen, changeSen: r.changeSen, paidSen: r.paidSen })
        void follow()
        return
      }
      setResult(byItem
        ? await checkoutItems(bill.id, byItem.items, toPayments(sending), s.checkoutId)
        : await checkoutBill(bill.id, toPayments(sending), s.checkoutId))
    } catch (e) {
      const m = msg(e)
      if (looksOffline(m)) { step({ type: 'noReply' }); setError(UNSURE); void follow() }
      else {
        step({ type: 'refused' }); setError(m)
        if (!split) setLines([])                         // a refused one-go payment does not linger
        sentPartRef.current = null                       // a refused part recorded nothing: the next Pay sends what is on screen
        void follow()
      }
    }
  }
  const pay = () => {
    if (session.phase === 'unsure') { void send(lines); return }
    if (partMode !== 'none') {
      const problem = partProblem(partMode, partDue, balance)
      if (problem) { setError(problem); return }
    }
    if (split) { void send(lines); return }
    if (payingForRef.current !== null && payingForRef.current !== balance) {
      // the bill changed since the cashier started: show it, and take a second, deliberate Pay
      payingForRef.current = balance
      setError(billChangedAtPay(method)); setReference(''); setEntry('')
      return
    }
    if (total === 0) { void send([]); return }          // RM 0.00 closes with no payment, as on the Checkout sheet
    if (!method) { setError('Choose how the bill is paid'); return }
    const r = singleLines(method, total, entry, reference)
    if ('problem' in r) { setError(r.problem); return }
    void send(r.lines.map((l) => ({ ...l, key: String(++keySeq.current) })))
  }

  // Check bill: paid by this screen → its result; a part of this screen landed → it is paid; open → unlock with a new id; else lock
  const checkBill = async () => {
    if (sessionRef.current.phase !== 'unsure') return
    step({ type: 'check' }); setError(null)
    ++readSeq.current
    try {
      const state = await fetchCheckoutState(bill.id, checkoutIds(sessionRef.current))
      const landed = sentPartRef.current ? (state.parts ?? []).find((p) => p.id === sessionRef.current.checkoutId) : undefined
      const a = absorb(state)
      if (landed) partDone({ partNo: landed.partNo, amountSen: landed.amountSen, changeSen: null, paidSen: state.paidSen ?? 0 })
      else {
        apply(a)
        if (a.kind === 'keep' || a.kind === 'reload') {
          step({ type: 'checkedOpen', newCheckoutId: crypto.randomUUID() }); setError(CHECKED_OPEN)
          sentPartRef.current = null
          if (!split) setLines([])                       // the one-go payment is rebuilt by the next Pay
        }
        else step({ type: 'checkEnded' })
      }
    } catch (e) {
      step({ type: 'checkEnded' }); setError(`Could not check the bill: ${msg(e)}`)
    }
    void follow()
  }

  if (result) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-cream p-6">
        <div className="w-full max-w-md rounded-2xl bg-card p-8 text-center shadow-card">
          <div className="text-sm text-brown-muted">Bill {result.billNo} paid · {formatSen(result.totalSen)}</div>
          <div className="mt-6 text-sm uppercase tracking-wide text-brown-muted">Change</div>
          <div className="text-6xl font-semibold text-brown-dark tabular-nums">{formatSen(result.changeSen)}</div>
          <p className="mt-6 text-sm text-brown-muted">
            {result.receiptQueued ? 'Receipt printing…' : 'No receipt printer is set — choose one in POS settings.'}
          </p>
          <button type="button" onClick={onPaid} className="mt-8 min-h-14 w-full rounded-xl bg-brown-btn text-lg font-semibold text-white hover:bg-brown-btn-hover">Done</button>
        </div>
      </div>
    )
  }

  const live = (items ?? []).filter((i) => !i.voided_at)
  const shown = byItem
    ? byItem.items.flatMap((s) => { const it = live.find((i) => i.id === s.itemId); return it ? [{ ...it, qty: s.qty }] : [] })
    : live
  const itemCount = shown.reduce((n, i) => n + i.qty, 0)
  const showPad = !locked && method !== null && (split || method.kind === 'cash')
  const change = !split && method?.kind === 'cash' ? liveChangeSen(total, entry) : null
  const quick = method?.kind === 'cash' ? quickTenders(split ? parseRinggit(entry) ?? left : total) : []
  const key = 'flex h-14 items-center justify-center rounded-xl border border-border-mid bg-card text-xl font-semibold text-brown-dark disabled:opacity-40'
  const lineTotals = linesById(totals)
  const billDisc = storedDiscount(bill)
  const tag = catalogTag(items ?? [])
  const partsOff = locked || busy || !online
  return (
    <div className="flex min-h-0 flex-1 bg-cream">
      <section aria-label="Bill" className="flex w-[40%] shrink-0 flex-col border-r border-border bg-card p-4 text-sm">
        <div className="text-lg font-semibold text-brown-dark">{title}</div>
        <div className="text-xs text-brown-muted">
          Bill {bill.bill_no} · {itemCount} item{itemCount === 1 ? '' : 's'}
          {tag && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-medium text-amber-800">{tag}</span>}
        </div>
        <div className="mt-3 flex-1 space-y-1 overflow-y-auto">
          {items === null && <p className="text-brown-muted">Loading…</p>}
          {shown.map((i) => (
            <div key={i.id} className="flex justify-between gap-2">
              <span>
                {i.qty} × {i.name_snapshot}
                {i.modifiers_snapshot.map((m, k) => <span key={k} className="block pl-4 text-xs text-brown-muted">+ {m.name}</span>)}
                <DiscountRows rows={lineDiscountRows(i, lineTotals.get(i.id))} />
              </span>
              <span className="tabular-nums">{formatSen(i.unit_price_sen * i.qty)}</span>
            </div>
          ))}
        </div>
        <div className="mt-3 border-t border-border pt-3"><CheckoutTotals totals={totals} billDiscountLabel={billDisc ? discountLabel(billDisc, true) : undefined} /></div>
        {parts.length > 0 && (
          <div aria-label="Paid parts" className="mt-2 space-y-1 border-t border-border pt-2">
            {parts.map((p) => <div key={p.id} className="text-brown-muted">{paidPartLabel(p, parts)}</div>)}
            <div className="flex justify-between text-base font-semibold text-brown-dark">
              <span>{BALANCE_DUE}</span><span className="tabular-nums">{formatSen(balance)}</span>
            </div>
          </div>
        )}
        {changeNote && <p role="status" className="mt-2 rounded bg-amber-50 p-2 text-amber-800">{changeNote}</p>}
        <button type="button" onClick={onClose} disabled={busy}
          className="mt-3 min-h-14 rounded-xl border border-border-mid font-medium text-brown-dark disabled:opacity-40">
          {lockNote ? 'Close' : 'Cancel payment'}
        </button>
      </section>

      <section aria-label="Payment" className="flex min-w-0 flex-1 flex-col p-4">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {!byItem && (
            <div role="group" aria-label="Split bill" className="mr-auto flex flex-wrap items-center gap-2">
              <span className="text-sm text-brown-muted">Split</span>
              {SPLIT_MODES.map((m) => (
                <button key={m} type="button" onClick={() => chooseMode(m)} aria-pressed={m !== 'item' && partMode === m}
                  disabled={partsOff || (m === 'item' && (!onSplitByItem || paidSen > 0 || itemCount < 2))}
                  className={`min-h-11 rounded-xl px-3 text-sm font-medium disabled:opacity-40 ${m !== 'item' && partMode === m ? 'bg-brown-dark text-cream' : 'border border-border-mid text-brown-dark'}`}>
                  {SPLIT_MODE_LABEL[m]}
                </button>
              ))}
              {!online && <span className="text-xs text-amber-800">{SPLIT_OFFLINE}</span>}
            </div>
          )}
          <button type="button" onClick={toggleSplit} disabled={locked} aria-pressed={split}
            className={`min-h-11 rounded-xl px-4 text-sm font-medium disabled:opacity-40 ${split ? 'bg-brown-dark text-cream' : 'border border-border-mid text-brown-dark'}`}>
            Split payment
          </button>
        </div>
        {partMode === 'equal' && (
          <div className="mt-2 flex items-center justify-center gap-3">
            <button type="button" aria-label="Fewer ways" disabled={partsOff || fixed !== null || ways <= MIN_WAYS}
              onClick={() => setWays((w) => clampWays(w - 1))} className={`${key} w-14`}>−</button>
            <span className="min-w-32 text-center font-medium text-brown-dark">{splitIntoLabel(fixed ?? ways)}</span>
            <button type="button" aria-label="More ways" disabled={partsOff || fixed !== null || ways >= MAX_WAYS}
              onClick={() => setWays((w) => clampWays(w + 1))} className={`${key} w-14`}>+</button>
          </div>
        )}
        {partMode === 'amount' && (
          <div className="mx-auto mt-2 flex w-full max-w-md items-end gap-2">
            <label className="flex-1 text-sm">Amount (RM)
              <input inputMode="decimal" disabled={partsOff} className="mt-1 h-12 w-full rounded-xl border border-border-mid px-3 text-base"
                value={amountText} onChange={(e) => { setAmountText(e.target.value); setLines([]); setError(null) }} />
            </label>
            {PERCENT_CHIPS.map((pct) => {
              const sen = percentChipSen(billTotal, pct, balance)
              return (
                <button key={pct} type="button" disabled={partsOff || sen === null}
                  onClick={() => { if (sen !== null) { setAmountText((sen / 100).toFixed(2)); setLines([]); setError(null) } }}
                  className="h-12 rounded-xl border border-border-mid px-3 text-sm font-medium text-brown-dark disabled:opacity-40">{pct}%</button>
              )
            })}
          </div>
        )}
        {lockNote && <p role="alert" className="mt-3 rounded bg-red-50 p-3 font-semibold text-red-700">{lockNote}</p>}
        <div className="mt-2 text-center">
          {partMode === 'equal' && quote && quote.ways !== null && quote.shareSen !== null && (
            <div className="text-sm font-medium text-brown-dark">{shareLabel(quote.sharesPaid + 1, quote.ways, quote.shareSen)}</div>
          )}
          <div className="text-sm uppercase tracking-wide text-brown-muted">
            {split ? 'Left to pay' : paidSen > 0 && partMode === 'none' ? BALANCE_DUE : 'Amount due'}
          </div>
          <div className="text-5xl font-semibold text-brown-dark tabular-nums">{totals ? formatSen(due) : '…'}</div>
          {!split && method?.kind === 'cash' && (
            <div className="mt-1 text-sm text-brown-muted">
              Received {entry ? `RM ${entry}` : 'exact'} · Change {change === null ? '—' : formatSen(change)}
            </div>
          )}
          {split && <div className="mt-1 text-sm text-brown-muted">This payment RM {entry || '0'}</div>}
        </div>
        {split && method?.kind === 'cash' && !locked && (
          <label className="mx-auto mt-3 block w-full max-w-sm text-sm">Cash received (RM)
            <input inputMode="decimal" placeholder="exact" className="mt-1 h-12 w-full rounded-xl border border-border-mid px-3 text-base"
              value={tenderedText} onChange={(e) => setTenderedText(e.target.value)} />
          </label>
        )}
        {method?.needsReference && !locked && (
          <label className="mx-auto mt-3 block w-full max-w-sm text-sm">Reference
            <input className="mt-1 h-12 w-full rounded-xl border border-border-mid px-3 text-base" value={reference} onChange={(e) => setReference(e.target.value)} />
          </label>
        )}
        <div className="mt-3 grid grid-cols-3 gap-2">
          {shownTab?.methods.map((m) => (
            <button key={m.id} type="button" onClick={() => pick(m)} disabled={busy || locked} aria-pressed={method?.id === m.id}
              className={`min-h-14 rounded-xl border px-3 text-left font-medium disabled:opacity-40 ${method?.id === m.id ? 'border-brown-btn bg-brown-btn text-white' : 'border-border-mid bg-card text-brown-dark'}`}>
              {m.name}
            </button>
          ))}
          {methods.length === 0 && (methodsError
            ? (
              <p role="alert" className="col-span-3 rounded bg-red-50 p-2 text-sm text-red-700">
                {methodsError} <button type="button" className="min-h-11 px-2 underline" onClick={() => setMethodsKey((k) => k + 1)}>Retry</button>
              </p>
            )
            : <p className="col-span-3 text-sm text-brown-muted">No payment methods — add them in POS settings.</p>)}
        </div>
        {showPad && (
          <div className="mt-3 flex min-h-0 flex-1 gap-3">
            <div className="grid flex-1 grid-cols-3 content-start gap-2">
              {NUMPAD_KEYS.map((k) => (
                <button key={k} type="button" className={key} disabled={busy} onClick={() => pressKey(k)}>{k}</button>
              ))}
            </div>
            <div className="flex w-40 flex-col gap-2">
              {method?.kind === 'cash' && !split && (
                <button type="button" className={key} disabled={busy} onClick={() => setEntry('')}>Exact</button>
              )}
              {quick.map((n) => (
                <button key={n} type="button" className={key} disabled={busy}
                  onClick={() => (split ? add(n) : setEntry((n / 100).toFixed(0)))}>RM {n / 100}</button>
              ))}
              <button type="button" className={key} disabled={busy} onClick={() => { setEntry(''); setEntryFresh(false) }}>C</button>
              {split && (
                <button type="button" onClick={() => add()} disabled={busy}
                  className="min-h-14 rounded-xl bg-brown-dark font-semibold text-cream disabled:opacity-40">Add {method?.name}</button>
              )}
            </div>
          </div>
        )}
        {!showPad && <div className="flex-1" />}
        {split && lines.length > 0 && (
          <div className="mt-3 space-y-1 text-sm">
            {lines.map((l) => (
              <div key={l.key} className="flex items-center justify-between rounded-lg bg-card p-2">
                <span>{l.method.name}{l.reference ? ` · ${l.reference}` : ''}{l.tenderedSen !== null ? ` · received ${formatSen(l.tenderedSen)}` : ''}</span>
                <span className="flex items-center gap-3 tabular-nums">{formatSen(l.amountSen)}
                  <button type="button" disabled={locked} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    className="min-h-11 px-2 text-xs text-red-700 underline disabled:opacity-40">Remove</button>
                </span>
              </div>
            ))}
            <div className="flex justify-between px-2"><span>Change</span><b className="tabular-nums">{formatSen(changeSen(lines))}</b></div>
          </div>
        )}
        {partNote && <p role="status" className="mt-3 rounded bg-green-50 p-2 text-sm text-green-800">{partNote}</p>}
        {quoteError && <p role="alert" className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{quoteError}</p>}
        {error && <p role="alert" className="mt-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        {lockNote ? (
          <button type="button" onClick={onClose} disabled={busy} className="mt-3 min-h-16 rounded-xl bg-brown-btn text-lg font-semibold text-white">Close</button>
        ) : session.phase === 'unsure' || session.phase === 'checking' ? (
          <div className="mt-3 grid grid-cols-2 gap-2">
            <button type="button" disabled={busy} onClick={pay} className="min-h-16 rounded-xl bg-brown-btn text-lg font-semibold text-white disabled:opacity-40">Try again</button>
            <button type="button" disabled={busy} onClick={() => void checkBill()} className="min-h-16 rounded-xl border border-border-mid text-lg disabled:opacity-40">
              {session.phase === 'checking' ? 'Checking…' : 'Check bill'}
            </button>
          </div>
        ) : (
          <button type="button" onClick={pay} disabled={busy || !totals || (split ? left !== 0 : !method && total !== 0) || (partMode === 'equal' && !quote)}
            className="mt-3 min-h-16 rounded-xl bg-brown-btn text-lg font-semibold text-white hover:bg-brown-btn-hover disabled:opacity-40">
            {busy ? 'Paying…' : `Pay ${formatSen(total)}`}
          </button>
        )}
        {tabs.length > 0 && (
          <div role="tablist" aria-label="Payment type" className="mt-3 grid gap-2" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
            {tabs.map((t) => (
              <button key={t.tab} type="button" role="tab" aria-selected={shownTab?.tab === t.tab} disabled={busy || locked} onClick={() => chooseTab(t.tab)}
                className={`min-h-12 rounded-xl font-medium disabled:opacity-40 ${shownTab?.tab === t.tab ? 'bg-brown-dark text-cream' : 'bg-card text-brown-dark'}`}>
                {t.label}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
```

- [ ] **Step 7: PosTill passes the online state and By item**

In `src/features/pos/order/PosTill.tsx`, on the `<PaymentScreen … />` element add:

```tsx
          online={online}
          onSplitByItem={screen.split ? undefined : () => setScreen({ kind: 'split', bill: screen.bill, back: screen.back })}
```

- [ ] **Step 8: Run the checkout tests, type check**

Run: `npx vitest run src/features/pos/checkout src/features/pos/order`
Expected: PASS (all earlier Payment screen tests included: with no parts the balance is the total).
Run: `npx tsc -b` → no errors.

- [ ] **Step 9: Commit**

```bash
git add src/features/pos/checkout/partSplit.ts src/features/pos/checkout/partSplit.test.ts src/features/pos/checkout/checkoutApi.ts \
  src/features/pos/checkout/follow.ts src/features/pos/checkout/follow.test.ts \
  src/features/pos/checkout/PaymentScreen.tsx src/features/pos/checkout/PaymentScreen.test.tsx src/features/pos/order/PosTill.tsx
git commit -m "$(cat <<'EOF'
feat(pos): split equally or by amount on the Payment screen

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task B5: "Part paid · RM x" on the home tile and the bill header

**Files:**
- Modify: `src/features/pos/order/billSummaries.ts`, `src/features/pos/order/billSummaries.test.ts`
- Modify: `src/features/pos/order/HomeScreen.tsx`
- Create: `src/features/pos/order/HomeScreen.test.tsx`
- Modify: `src/features/pos/order/BillColumn.tsx`, `src/features/pos/order/BillColumn.test.tsx`
- Modify: `src/features/pos/order/OrderScreen.tsx`

**Interfaces:**
- Consumes: `pos_open_bill_summaries.paid_sen` (B3), `partPaidTag(sen)` (B4).
- Produces: `BillSummary.paidSen?: number` (optional, so existing literals stay valid; the parser always fills it); `BillColumn` prop `partPaidSen?: number`.

- [ ] **Step 1: Failing tests**

In `src/features/pos/order/billSummaries.test.ts` replace the first test with:

```ts
  it('keys the rows by bill id, with what the bill\'s parts paid (0 before Part B or with none)', () => {
    const m = parseBillSummaries([
      { bill_id: 'b1', total_sen: 10670, item_count: 4, paid_sen: 2345 },
      { bill_id: 'b2', total_sen: 0, item_count: 0 },
    ])
    expect([...m.values()]).toEqual([
      { billId: 'b1', totalSen: 10670, itemCount: 4, paidSen: 2345 },
      { billId: 'b2', totalSen: 0, itemCount: 0, paidSen: 0 },
    ])
    expect(m.get('b1')?.totalSen).toBe(10670)
  })
```

Create `src/features/pos/order/HomeScreen.test.tsx`:

```tsx
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import HomeScreen from './HomeScreen'
import type { OpenBillRow, TableRow } from './posApi'

afterEach(cleanup)

const table: TableRow = { id: 't5', label: 'T5', qr_token: 'q5', qr_paused: false, is_active: true, sort_order: 1, area: null }
const open = (id: string, tableId: string | null): OpenBillRow => ({
  id, bill_no: `261117-00${id.slice(1)}`, table_id: tableId, order_type: tableId ? 'dine_in' : 'takeaway', pax: 2,
  opened_at: new Date().toISOString(), discount_kind: null, discount_value: null, discount_reason: null,
})

describe('HomeScreen part payments (split spec §3.5)', () => {
  it('a table tile and a takeaway with a part paid say "Part paid · RM x"', () => {
    const bills = [open('b1', 't5'), open('b2', null)]
    const summaries = new Map([
      ['b1', { billId: 'b1', totalSen: 7035, itemCount: 1, paidSen: 2345 }],
      ['b2', { billId: 'b2', totalSen: 3000, itemCount: 1, paidSen: 1000 }],
    ])
    render(<HomeScreen tables={[table]} bills={bills} summaries={summaries} newBillIds={new Set()} banners={null}
      onRefresh={() => {}} onPickTable={() => {}} onPickBill={() => {}} onNewTakeaway={() => {}} />)
    expect(screen.getByText('Part paid · RM 23.45')).toBeTruthy()
    expect(screen.getByText('Part paid · RM 10.00')).toBeTruthy()
  })
  it('no tag without a part', () => {
    render(<HomeScreen tables={[table]} bills={[open('b1', 't5')]} summaries={new Map([['b1', { billId: 'b1', totalSen: 7035, itemCount: 1, paidSen: 0 }]])}
      newBillIds={new Set()} banners={null} onRefresh={() => {}} onPickTable={() => {}} onPickBill={() => {}} onNewTakeaway={() => {}} />)
    expect(screen.queryByText(/Part paid/)).toBeNull()
  })
})
```

Append to `src/features/pos/order/BillColumn.test.tsx`:

```tsx
describe('BillColumn part payments', () => {
  it('the header says what the parts paid', () => {
    render(<BillColumn {...props} billNo="261117-001" catalogName={null} onCatalog={null} partPaidSen={2345} />)
    expect(screen.getByText('Part paid · RM 23.45')).toBeTruthy()
  })
  it('nothing without a part', () => {
    render(<BillColumn {...props} billNo="261117-001" catalogName={null} onCatalog={null} partPaidSen={0} />)
    expect(screen.queryByText(/Part paid/)).toBeNull()
  })
})
```

Run: `npx vitest run src/features/pos/order/billSummaries.test.ts src/features/pos/order/HomeScreen.test.tsx src/features/pos/order/BillColumn.test.tsx`
Expected: FAIL.

- [ ] **Step 2: `billSummaries.ts`**

```ts
export interface BillSummary { billId: string; totalSen: number; itemCount: number; paidSen?: number }
```

and in `parseBillSummaries`:

```ts
    const { bill_id, total_sen, item_count, paid_sen } = row as Record<string, unknown>
    if (typeof bill_id !== 'string' || typeof total_sen !== 'number' || typeof item_count !== 'number'
        || (paid_sen !== undefined && typeof paid_sen !== 'number')) return unexpected()
    out.set(bill_id, { billId: bill_id, totalSen: total_sen, itemCount: item_count, paidSen: typeof paid_sen === 'number' ? paid_sen : 0 })
```

(Doc comment: add "and what its parts paid (paid_sen, split spec §4.6)".)

- [ ] **Step 3: `HomeScreen.tsx`**

Add `import { partPaidTag } from '../checkout/partSplit'`. In the takeaway list, under the `Takeaway · …` line:

```tsx
                  {(s?.paidSen ?? 0) > 0 && <span className="block text-xs font-semibold text-green-800">{partPaidTag(s?.paidSen ?? 0)}</span>}
```

In `TableTile`, after the line with the total and minutes (inside the `card.bill ?` branch's span, as a sibling under it):

```tsx
        {(summary?.paidSen ?? 0) > 0 && <span className="block text-xs font-semibold">{partPaidTag(summary?.paidSen ?? 0)}</span>}
```

(place it right before `{card.state === 'new' && …}`).

- [ ] **Step 4: `BillColumn.tsx`**

Add `import { partPaidTag } from '../checkout/partSplit'`, the prop

```tsx
  partPaidSen?: number                 // what the bill's parts paid (split spec §3.5)
```

and in the header's `Bill …` span, after the catalog tag:

```tsx
            {(p.partPaidSen ?? 0) > 0 && <span className="ml-2 rounded bg-green-100 px-1.5 py-0.5 font-medium text-green-800">{partPaidTag(p.partPaidSen ?? 0)}</span>}
```

- [ ] **Step 5: `OrderScreen.tsx`**

Before `const title = targetTitle(target, bill, tables)` add:

```tsx
  const partPaid = bill ? summaries.get(bill.id)?.paidSen ?? 0 : 0       // split spec §3.5
```

On `<BillColumn …>` add `partPaidSen={partPaid}` and change the pay label to the balance:

```tsx
        payLabel={view.totals ? `Payment ${formatSen(view.totals.totalSen - partPaid)}` : 'Payment'}
```

- [ ] **Step 6: Run the tests, type check**

Run: `npx vitest run src/features/pos/order` → PASS.
Run: `npx tsc -b` → no errors.

- [ ] **Step 7: Commit**

```bash
git add src/features/pos/order/billSummaries.ts src/features/pos/order/billSummaries.test.ts src/features/pos/order/HomeScreen.tsx \
  src/features/pos/order/HomeScreen.test.tsx src/features/pos/order/BillColumn.tsx src/features/pos/order/BillColumn.test.tsx \
  src/features/pos/order/OrderScreen.tsx
git commit -m "$(cat <<'EOF'
feat(pos): Part paid tag on the home tile and the bill header

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task Final: Full checks and the browser check list

**Files:** none changed (fixes found here go back to the task they belong to).

- [ ] **Step 1: Whole test suite**

Run: `npx vitest run`
Expected: every test file passes.

- [ ] **Step 2: Type check and both builds**

Run: `npx tsc -b` → no errors.
Run: `npm run build` → succeeds.
Run: `npm run build:pos` → succeeds.

- [ ] **Step 3: SQL, once more, in order, on dev**

Apply `supabase/migration-2026-11-16-pos-split-bill.sql`, then `supabase/migration-2026-11-17-pos-bill-parts.sql` (Part B after Part A, always). Run the verify files: `migration-2026-11-16-pos-split-bill-verify.sql` → `VERIFY OK`; `migration-2026-11-17-pos-bill-parts-verify.sql` → `VERIFY OK`; `migration-2026-10-30-pos-discounts-verify.sql`, `migration-2026-10-29-pos-device-till-verify.sql`, `migration-2026-10-24-pos-checkout-verify.sql` and `migration-2026-10-25-pos-hardening-verify.sql` → same as the baseline taken before Task A1.

- [ ] **Step 4: Browser checks on dev (the controller runs these on the craft-pos dev server)**

Use the Demo outlet on dev with the office test printer; two tablets = two browser tabs signed in on two devices.

Part A — split by item and move:
1. Table with 3 lattes + 1 cake (+ a 0% item): Bill actions shows **Split / Move items**; a table with a single unit does not.
2. Picker: lattes show a stepper `0 of 3`; the cake a tick box; **Pay selected** / **Move to table** off until something is picked; the footer shows `…` then the server's total ~300 ms after the last tap.
3. Pick 1 latte + the cake → **Pay selected** → Payment titled `Table T5 · Split`, only those units on the left, totals of the part → pay cash → change screen, receipt prints with `Split from <bill> - T5` under the invoice no → **Done** returns to the table, which now shows 2 lattes; the home tile total is the rest.
4. Cancel payment from split mode returns to the picker with the same selection.
5. **Select all** → Pay selected opens the normal Payment (no `· Split`).
6. Move 2 items to a free table → toast `Moved 2 items to T7`; T7 shows the items at once on the other tab; no kitchen ticket printed. Move 1 item to a table that has a bill → it joins that bill.
7. A bill with a bill discount: Move to table is off with `Remove the bill discount before moving items`; Pay selected still works and the part's receipt shows its share of the discount.
8. Two tabs: open the picker on tab A, void an item on tab B (or pay the bill) → tab A's footer shows `The bill changed. Check the items again.` (or the picker says the bill is no longer open).
9. Offline (DevTools → Network offline on the POS app tab): Split / Move items shows disabled with `Split needs a connection`.
10. Today's bills lists the paid part as its own paid bill; it refunds like any bill. Close the shift: the Z report counts the part once, covers unchanged.

Part B — equally / by amount:
11. A bill of RM 70.35: Payment → **Equally** → `Split into 2` → **+** → `Split into 3`, `Share 1 of 3 · RM 23.45` → pay cash → the part receipt prints (`Part 1 of 3`, `Paid before`, `Balance due`, the part footer) → the screen stays: `Paid 1 of 3 · RM 23.45 (Cash)`, **Balance due RM 46.90**; the N is now fixed.
12. Share 2, then the last share is paid normally (checkout_bill): the final receipt lists `Part 1 - Cash`, `Part 2 - …` then the last payment.
13. **By amount**: the 25% / 33% / 50% chips fill the amount; an amount above the balance shows `The amount is more than the balance`; an amount equal to the balance closes the bill.
14. While a part is paid: the home tile and the bill header show `Part paid · RM 23.45`; void item, void bill, discounts, Split / Move items and merging it away all refuse with `This bill has a part payment. Pay the rest first.`; adding items, moving the whole bill and merging another bill into it work.
15. Add an item on tab B after share 1 on tab A: tab A re-quotes the next share; an old share sent anyway is refused with `The bill changed. Check the split again.`
16. Pull the network during a part payment → `Try again` resends the same part (one part recorded); `Check bill` after it landed shows the part as paid.

- [ ] **Step 5: Report**

Report the results of Steps 1–4 to the controller (failures with the step number and what was seen). No commit in this task.
