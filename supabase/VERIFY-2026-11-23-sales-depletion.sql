-- ============================================================================
-- VERIFY — POS sales depletion + stock count usage (2026-11-23). DEV ONLY.
-- Builds a [TEST] item, menu variant, add-ons and bills at Cheras, then always
-- raises its report so every change rolls back. Last line: VERIFY OK/FAILED.
-- ============================================================================
do $verify$
declare
  c_cheras  uuid;   -- a dedicated [TEST] branch, so exact figures cannot be disturbed by dev data
  c_manager constant uuid := '193e1294-9c20-4425-b796-1cbff287e7a5';  -- test.manager.cheras (manager: every branch)
  c_sup_other constant uuid := 'd93522a5-218e-473c-8c4e-8e35a2bbd90a'; -- test.supervisor.puchong (other branch)
  c_staff   constant uuid := '406b1762-107b-42ea-b27b-71c38d15d1a4';  -- test.staff.cheras (no use_procurement)
  v_br2 uuid; v_d uuid; v_e uuid; v_c4 uuid; v_c5 uuid; v_c6 uuid; v_br3 uuid; v_b uuid; v_c uuid; v_c0 uuid; v_c3 uuid; v_msg text; v_ts timestamptz := now();
  v_out text := ''; v_fail boolean := false; v_ok boolean;
  v_a uuid; v_cat uuid; v_prod uuid; v_var uuid; v_var_norecipe uuid; v_grp uuid; v_opt_add uuid; v_opt_swap uuid;
  v_bill uuid; v_bill2 uuid; v_bill3 uuid; v_order uuid; v_n int; v_q numeric; v_row record;
  v_c1 uuid; v_c2 uuid; v_sum jsonb;
begin
  -- Fixture (as postgres) -------------------------------------------------------
  insert into branches (name) values ('[TEST] SD Branch') returning id into c_cheras;
  insert into branches (name) values ('[TEST] SD Branch 2') returning id into v_br2;
  insert into branches (name) values ('[TEST] SD Branch 3') returning id into v_br3;
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price)
  values ('[TEST] SD Beans', 'raw', 'pack', 'g', 1000, 50) returning id into v_a;           -- RM 0.05/g
  insert into inventory_transactions (item_id, branch_id, transaction_type, quantity, unit_cost, reference_type)
  values (v_a, c_cheras, 'stock_in', 5000, 0.05, 'manual');
  insert into menu_categories (name) values ('[TEST] SD Cat') returning id into v_cat;
  insert into menu_products (name, category_id) values ('[TEST] SD Latte', v_cat) returning id into v_prod;
  insert into menu_variants (product_id, feedme_variant_key, name, price_sen) values (v_prod, 'hot', 'Hot', 1000) returning id into v_var;
  insert into menu_variants (product_id, feedme_variant_key, name, price_sen) values (v_prod, 'none', 'No recipe', 1000) returning id into v_var_norecipe;
  insert into menu_variant_recipe_lines (variant_id, item_id, qty_base) values (v_var, v_a, 100);
  insert into modifier_groups (name) values ('[TEST] SD Extras') returning id into v_grp;
  insert into modifier_options (group_id, name) values (v_grp, 'Extra shot') returning id into v_opt_add;
  insert into modifier_options (group_id, name) values (v_grp, 'Decaf swap') returning id into v_opt_swap;
  insert into modifier_recipe_lines (option_id, item_id, qty_base) values (v_opt_add, v_a, 50), (v_opt_swap, v_a, -20);

  -- Bill 1: 2 x Hot + Extra shot (2*(100+50)=300), 1 x Hot + Decaf swap (100-20=80), 1 voided Hot (0),
  --         1 x No recipe (0, counted as without recipe)  => sale -380
  insert into bills (branch_id, bill_no, order_type) values (c_cheras, '[TEST]SD-1', 'dine_in') returning id into v_bill;
  insert into orders (bill_id, branch_id, order_no, source, client_order_id)
  values (v_bill, c_cheras, 1, 'counter', gen_random_uuid()) returning id into v_order;
  insert into order_items (order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen, sst_rate_bp, qty, order_type, modifiers_snapshot, voided_at)
  values
    (v_order, v_bill, v_prod, v_var, 'SD Latte', 1000, 600, 2, 'dine_in', jsonb_build_array(jsonb_build_object('optionId', v_opt_add, 'name', 'Extra shot')), null),
    (v_order, v_bill, v_prod, v_var, 'SD Latte', 1000, 600, 1, 'dine_in', jsonb_build_array(jsonb_build_object('optionId', v_opt_swap, 'name', 'Decaf swap')), null),
    (v_order, v_bill, v_prod, v_var, 'SD Latte', 1000, 600, 1, 'dine_in', '[]'::jsonb, now()),
    (v_order, v_bill, v_prod, v_var_norecipe, 'SD Other', 1000, 600, 1, 'dine_in', '[]'::jsonb, null);

  -- A1. Paying deducts once, variant + add-on + swap, voided excluded -----------
  update bills set status = 'paid', closed_at = now() where id = v_bill;
  select coalesce(sum(quantity), 0), count(*) into v_q, v_n
    from inventory_transactions where reference_id = v_bill and transaction_type = 'sale' and item_id = v_a;
  select * into v_row from bill_depletions where bill_id = v_bill;
  v_ok := v_q = -380 and v_n = 1 and v_row.status = 'done' and v_row.lines_without_recipe = 1;
  v_out := v_out || format(E'%s  paid bill deducts -380 g in one sale row, 1 line without recipe (got %s, %s rows)\n',
                           case when v_ok is true then 'PASS' else 'FAIL' end, v_q, v_n);
  v_fail := v_fail or v_ok is not true;

  -- A2. Unit cost stamped at the moving average ----------------------------------
  select round(unit_cost, 6) = 0.05 into v_ok from inventory_transactions where reference_id = v_bill and transaction_type = 'sale';
  v_out := v_out || format(E'%s  sale row costed at the moving average\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- A3. Paid -> open -> paid does not deduct again --------------------------------
  update bills set status = 'open' where id = v_bill;
  update bills set status = 'paid' where id = v_bill;
  select count(*) into v_n from inventory_transactions where reference_id = v_bill and transaction_type = 'sale';
  v_ok := v_n = 1;
  v_out := v_out || format(E'%s  a second paid transition does not deduct again\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- A4. Merged and voided bills deduct nothing ------------------------------------
  insert into bills (branch_id, bill_no, order_type) values (c_cheras, '[TEST]SD-2', 'dine_in') returning id into v_bill2;
  insert into orders (bill_id, branch_id, order_no, source, client_order_id)
  values (v_bill2, c_cheras, 1, 'counter', gen_random_uuid()) returning id into v_order;
  insert into order_items (order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen, sst_rate_bp, qty, order_type)
  values (v_order, v_bill2, v_prod, v_var, 'SD Latte', 1000, 600, 1, 'dine_in');
  update bills set status = 'merged' where id = v_bill2;
  update bills set status = 'voided' where id = v_bill2;
  select count(*) into v_n from inventory_transactions where reference_id = v_bill2;
  v_ok := v_n = 0 and not exists (select 1 from bill_depletions where bill_id = v_bill2);
  v_out := v_out || format(E'%s  merged / voided bills deduct nothing\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- A5. A depletion error never blocks payment, and is recorded --------------------
  execute $t$create or replace function pg_temp.sd_block_sale() returns trigger language plpgsql as $f$
    begin if new.transaction_type = 'sale' then raise exception 'boom'; end if; return new; end $f$$t$;
  execute 'create trigger sd_block_sale before insert on inventory_transactions for each row execute function pg_temp.sd_block_sale()';
  insert into bills (branch_id, bill_no, order_type) values (c_cheras, '[TEST]SD-3', 'dine_in') returning id into v_bill3;
  insert into orders (bill_id, branch_id, order_no, source, client_order_id)
  values (v_bill3, c_cheras, 1, 'counter', gen_random_uuid()) returning id into v_order;
  insert into order_items (order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen, sst_rate_bp, qty, order_type)
  values (v_order, v_bill3, v_prod, v_var, 'SD Latte', 1000, 600, 1, 'dine_in');
  begin
    update bills set status = 'paid', closed_at = now() where id = v_bill3;
    v_ok := true;
  exception when others then v_ok := false;
  end;
  execute 'drop trigger sd_block_sale on inventory_transactions';
  select v_ok and b.status = 'paid' and d.status = 'error' and d.error like '%boom%'
    into v_ok from bills b join bill_depletions d on d.bill_id = b.id where b.id = v_bill3;
  v_out := v_out || format(E'%s  a depletion error does not block payment and is recorded\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- A6. Ledger constraint keeps every type --------------------------------------------
  select pg_get_constraintdef(oid) like all (array['%stock_in%','%adjustment%','%wastage%','%transfer_out%','%transfer_in%',
           '%production_out%','%production_in%','%stocktake%','%''sale''%'])
    into v_ok from pg_constraint where conname = 'inventory_transactions_transaction_type_check';
  v_out := v_out || format(E'%s  ledger types keep all eight plus sale\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- A7. Internal functions closed; bill_depletions not writable by clients -------------
  select not bool_or(has_function_privilege(r.rolname, p.oid, 'execute'))
    into v_ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    cross join (values ('anon'), ('authenticated')) as r(rolname)
   where n.nspname = 'public' and p.proname in ('deplete_bill', 'bills_deplete_on_paid');
  v_ok := v_ok and not has_table_privilege('authenticated', 'public.bill_depletions', 'insert')
                and not has_table_privilege('anon', 'public.bill_depletions', 'select');
  v_out := v_out || format(E'%s  internal depletion functions and table writes closed to clients\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- PART B: usage report ---------------------------------------------------------------
  -- Timeline (T = now): C0 full T-10d [A, B]; wastage B 10 g T-5d; sale A 999 g T-3d (before C1);
  -- C1 weekly T-1d [A]; sale A 7 g exactly at C1 (excluded); sale C 50 g T-2h; bill 1 sale A 380 g
  -- and wastage A 30 g at T; sale A 3 g and the target's own stocktake row exactly at C2;
  -- C2 weekly T+1min [A -40 g, B 0] is the target. B was last counted in C0, so its window starts there.
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price)
  values ('[TEST] SD Sugar', 'raw', 'pack', 'g', 1000, 100) returning id into v_b;
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price)
  values ('[TEST] SD Milk', 'raw', 'pack', 'g', 1000, 20) returning id into v_c;

  insert into stock_counts (branch_id, kind, status, started_at, submitted_at, item_count, gain_value, loss_value, net_value)
  values (c_cheras, 'full', 'submitted', v_ts - interval '10 days', v_ts - interval '10 days', 2, 0, 0, 0) returning id into v_c0;
  insert into stock_count_items (count_id, item_id, counted_base, expected_base, variance_base, unit_cost, variance_value)
  values (v_c0, v_a, 5000, 5000, 0, 0.05, 0), (v_c0, v_b, 100, 100, 0, 0.1, 0);
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price)
  values ('[TEST] SD Tea', 'raw', 'pack', 'g', 1000, 20) returning id into v_d;
  insert into stock_count_items (count_id, item_id, counted_base, expected_base, variance_base, unit_cost, variance_value)
  values (v_c0, v_d, 100, 100, 0, 0.02, 0);
  insert into inventory_transactions (item_id, branch_id, transaction_type, quantity, unit_cost, reference_type, created_at) values
    (v_d, c_cheras, 'sale', -400, 0, 'manual', v_ts - interval '5 days'),
    (v_d, c_cheras, 'sale', -4, 0, 'manual', v_ts - interval '2 hours');
  insert into stock_counts (branch_id, kind, status, started_at, submitted_at, item_count, gain_value, loss_value, net_value)
  values (c_cheras, 'weekly', 'submitted', v_ts - interval '1 day', v_ts - interval '1 day', 1, 0, 0, 0) returning id into v_c1;
  insert into stock_count_items (count_id, item_id, counted_base, expected_base, variance_base, unit_cost, variance_value)
  values (v_c1, v_a, 5000, 5000, 0, 0.05, 0);

  insert into inventory_transactions (item_id, branch_id, transaction_type, quantity, unit_cost, reference_type, created_at) values
    (v_b, c_cheras, 'wastage', -10, 0, 'manual', v_ts - interval '5 days'),
    (v_a, c_cheras, 'sale', -999, 0, 'manual', v_ts - interval '3 days'),
    (v_a, c_cheras, 'sale', -7, 0, 'manual', v_ts - interval '1 day'),
    (v_c, c_cheras, 'sale', -50, 0, 'manual', v_ts - interval '2 hours'),
    (v_a, c_cheras, 'wastage', -30, 0.05, 'manual', v_ts),
    (v_a, c_cheras, 'sale', -3, 0, 'manual', v_ts + interval '1 minute'),
    (v_a, c_cheras, 'stocktake', -40, 0.05, 'manual', v_ts + interval '1 minute');

  insert into stock_counts (branch_id, kind, status, started_at, submitted_at, item_count, gain_value, loss_value, net_value)
  values (c_cheras, 'weekly', 'submitted', v_ts, v_ts + interval '1 minute', 2, 0, 2, -2) returning id into v_c2;
  insert into stock_count_items (count_id, item_id, counted_base, expected_base, variance_base, unit_cost, variance_value)
  values (v_c2, v_a, 4550, 4590, -40, 0.05, -2), (v_c2, v_b, 100, 100, 0, 0.1, 0);

  -- Another branch whose only count is the first ever (30-day fallback)
  insert into stock_counts (branch_id, kind, status, started_at, submitted_at, item_count, gain_value, loss_value, net_value)
  values (v_br2, 'full', 'submitted', v_ts, v_ts, 0, 0, 0, 0) returning id into v_c3;
  -- A count still in progress
  insert into stock_counts (branch_id, kind, status, started_at, item_count)
  values (c_cheras, 'weekly', 'in_progress', v_ts, 0) returning id into v_c1;

  -- 180-day cap: item E last counted 250 days before the target; a sale at 200 days is outside the cap
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price)
  values ('[TEST] SD Salt', 'raw', 'pack', 'g', 1000, 10) returning id into v_e;
  insert into stock_counts (branch_id, kind, status, started_at, submitted_at, item_count, gain_value, loss_value, net_value)
  values (v_br3, 'full', 'submitted', v_ts - interval '250 days', v_ts - interval '250 days', 1, 0, 0, 0) returning id into v_c4;
  insert into stock_count_items (count_id, item_id, counted_base, expected_base, variance_base, unit_cost, variance_value)
  values (v_c4, v_e, 10, 10, 0, 0.01, 0);
  insert into stock_counts (branch_id, kind, status, started_at, submitted_at, item_count, gain_value, loss_value, net_value)
  values (v_br3, 'weekly', 'submitted', v_ts + interval '1 hour', v_ts + interval '1 hour', 1, 0, 0, 0) returning id into v_c5;
  insert into stock_count_items (count_id, item_id, counted_base, expected_base, variance_base, unit_cost, variance_value)
  values (v_c5, v_e, 10, 10, 0, 0.01, 0);
  insert into inventory_transactions (item_id, branch_id, transaction_type, quantity, unit_cost, reference_type, created_at) values
    (v_e, v_br3, 'sale', -9, 0, 'manual', v_ts - interval '200 days'),
    (v_e, v_br3, 'sale', -2, 0, 'manual', v_ts - interval '100 days');

  perform set_config('request.jwt.claims', json_build_object('sub', c_manager, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  select * into v_row from stock_count_usage(v_c5) where item_id = v_e;
  v_ok := v_row.sold_base = 2 and v_row.period_start = v_ts + interval '1 hour' - interval '180 days';
  v_out := v_out || format(E'%s  180-day cap: item last counted 250 days ago is bounded at period_end - 180 days (sold %s, start %s)\n',
                           case when v_ok is true then 'PASS' else 'FAIL' end, v_row.sold_base, v_row.period_start);
  v_fail := v_fail or v_ok is not true;
  v_sum := stock_count_usage_summary(v_c5);
  v_ok := (v_sum->>'capped')::boolean = true and (v_sum->>'from_previous')::boolean = true
      and (v_sum->>'period_start')::timestamptz = v_ts + interval '1 hour' - interval '180 days';
  v_out := v_out || format(E'%s  summary window capped at 180 days (capped %s, start %s)\n',
                           case when v_ok is true then 'PASS' else 'FAIL' end, v_sum->>'capped', v_sum->>'period_start');
  v_fail := v_fail or v_ok is not true;

  -- B1. Item A: sold 380 + 3 (boundary at the end included, at the start excluded, older sale ignored),
  --     the target's own stocktake row is not sold/wasted ------------------------------------
  select * into v_row from stock_count_usage(v_c2) where item_id = v_a;
  v_ok := v_row.sold_base = 383 and round(v_row.sold_value, 2) = 19.00
      and v_row.wasted_base = 30 and round(v_row.wasted_value, 2) = 1.50
      and v_row.unexplained_base = -40 and round(v_row.unexplained_value, 2) = -2.00
      and round(v_row.unexplained_pct, 2) = round(40.0 / 383 * 100, 2)
      and v_row.counted is true and v_row.period_start = v_ts - interval '1 day';
  v_out := v_out || format(E'%s  item A: sold 383 g (sale at period start excluded, at period end included, own stocktake row ignored), wasted 30 g, unexplained -40 g = %s%%, window from C1 (got %s / %s / %s / %s / %s)\n',
                           case when v_ok is true then 'PASS' else 'FAIL' end, round(v_row.unexplained_pct, 2), v_row.sold_base, v_row.wasted_base, v_row.unexplained_base, v_row.counted, v_row.period_start);
  v_fail := v_fail or v_ok is not true;

  -- B1b. Item B was only in the older full count: its window starts there, so the 5-day-old wastage shows
  select * into v_row from stock_count_usage(v_c2) where item_id = v_b;
  v_ok := v_row.wasted_base = 10 and v_row.sold_base = 0 and v_row.counted is true
      and v_row.period_start = v_ts - interval '10 days' and v_row.unexplained_pct is null;
  v_out := v_out || format(E'%s  per-item start: item B window starts at the older full count (wasted %s g, start %s)\n',
                           case when v_ok is true then 'PASS' else 'FAIL' end, v_row.wasted_base, v_row.period_start);
  v_fail := v_fail or v_ok is not true;

  -- B1c. Item C sold but not in the target count: counted false, pct null, summary-level start
  select * into v_row from stock_count_usage(v_c2) where item_id = v_c;
  v_ok := v_row.sold_base = 50 and v_row.counted is false and v_row.unexplained_pct is null
      and v_row.unexplained_base = 0 and v_row.period_start = v_ts - interval '1 day';
  v_out := v_out || format(E'%s  item sold but not counted: counted false, pct null, summary-level start (got %s / %s / %s)\n',
                           case when v_ok is true then 'PASS' else 'FAIL' end, v_row.sold_base, v_row.counted, v_row.unexplained_pct);
  v_fail := v_fail or v_ok is not true;

  -- B1d. Item D was in an older count but is absent from the target: summary-level start, not the older one
  select * into v_row from stock_count_usage(v_c2) where item_id = v_d;
  v_ok := v_row.sold_base = 4 and v_row.counted is false and v_row.period_start = v_ts - interval '1 day';
  v_out := v_out || format(E'%s  item in an older count but not the target: summary-level start (sold %s, start %s)\n',
                           case when v_ok is true then 'PASS' else 'FAIL' end, v_row.sold_base, v_row.period_start);
  v_fail := v_fail or v_ok is not true;

  -- B2. Summary (exact; the branch holds only fixture rows) --------------------------------
  v_sum := stock_count_usage_summary(v_c2);
  v_ok := (v_sum->>'from_previous')::boolean = true
      and (v_sum->>'period_start')::timestamptz = v_ts - interval '1 day'
      and (v_sum->>'bills_paid')::int = 2
      and (v_sum->>'lines_without_recipe')::int = 1
      and (v_sum->>'depletion_errors')::int = 1
      and round((v_sum->>'sold_value')::numeric, 2) = 19.00
      and round((v_sum->>'wasted_value')::numeric, 2) = 1.50
      and round((v_sum->>'unexplained_value')::numeric, 2) = -2.00
      and (v_sum->>'rows_without_cost')::int = 0 and (v_sum->>'capped')::boolean = false;
  v_out := v_out || format(E'%s  summary exact: 2 bills, 1 line without recipe, 1 error, sold 19.00, wasted 1.50, unexplained -2.00, 0 rows without cost (%s)\n',
                           case when v_ok is true then 'PASS' else 'FAIL' end, v_sum);
  v_fail := v_fail or v_ok is not true;

  -- B2b. A sale row with no cost is counted in rows_without_cost (value stays unchanged)
  execute 'reset role';
  insert into inventory_transactions (item_id, branch_id, transaction_type, quantity, unit_cost, reference_type, created_at)
  values (v_c, c_cheras, 'sale', -1, 0, 'manual', v_ts - interval '1 hour');
  update inventory_transactions set unit_cost = null   -- an insert trigger stamps the cost, so blank it afterwards
   where item_id = v_c and branch_id = c_cheras and quantity = -1;
  perform set_config('request.jwt.claims', json_build_object('sub', c_manager, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_sum := stock_count_usage_summary(v_c2);
  v_ok := (v_sum->>'rows_without_cost')::int = 1 and round((v_sum->>'sold_value')::numeric, 2) = 19.00;
  v_out := v_out || format(E'%s  summary counts a ledger row with no unit cost (rows_without_cost %s)\n',
                           case when v_ok is true then 'PASS' else 'FAIL' end, v_sum->>'rows_without_cost');
  v_fail := v_fail or v_ok is not true;

  -- B2c. First count at a branch: from_previous false, window = 30 days
  v_sum := stock_count_usage_summary(v_c3);
  v_ok := (v_sum->>'from_previous')::boolean = false
      and (v_sum->>'period_end')::timestamptz - (v_sum->>'period_start')::timestamptz = interval '30 days';
  v_out := v_out || format(E'%s  first count at a branch: from_previous false, 30-day window (%s -> %s)\n',
                           case when v_ok is true then 'PASS' else 'FAIL' end, v_sum->>'period_start', v_sum->>'period_end');
  v_fail := v_fail or v_ok is not true;

  -- B3. Sold without recipe -------------------------------------------------------------
  select exists (select 1 from stock_count_unrecipe_sales(v_c2) where variant_name = 'No recipe' and qty_sold = 1)
    into v_ok;
  v_out := v_out || format(E'%s  sold-without-recipe lists the no-recipe variant\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- B3b. Refusals: unknown count, in-progress count, supervisor of another branch -> one generic message
  v_ok := true;
  begin perform stock_count_usage(gen_random_uuid()); v_ok := false;
  exception when others then v_ok := v_ok and sqlerrm = 'Not authorised or count not found'; end;
  begin perform stock_count_usage_summary(v_c1); v_ok := false;
  exception when others then v_ok := v_ok and sqlerrm = 'Not authorised or count not found'; end;
  perform set_config('request.jwt.claims', json_build_object('sub', c_sup_other, 'role', 'authenticated')::text, true);
  begin perform stock_count_usage(v_c2); v_ok := false;
  exception when others then v_ok := v_ok and sqlerrm = 'Not authorised or count not found'; end;
  begin perform stock_count_unrecipe_sales(v_c2); v_ok := false;
  exception when others then v_ok := v_ok and sqlerrm = 'Not authorised or count not found'; end;
  v_out := v_out || format(E'%s  unknown, unsubmitted and other-branch counts all give the generic refusal\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- B3c. A user without use_procurement keeps the capability message
  perform set_config('request.jwt.claims', json_build_object('sub', c_staff, 'role', 'authenticated')::text, true);
  v_msg := null;
  begin perform stock_count_usage_summary(v_c2); exception when others then v_msg := sqlerrm; end;
  v_ok := v_msg = 'Not authorised to see stock usage';
  v_out := v_out || format(E'%s  staff without use_procurement is refused (%s)\n', case when v_ok is true then 'PASS' else 'FAIL' end, v_msg);
  v_fail := v_fail or v_ok is not true;
  execute 'reset role';

  -- B4. anon refused; internal period function closed ------------------------------------
  select not bool_or(has_function_privilege('anon', p.oid, 'execute'))
     and not exists (select 1 from pg_proc p2 join pg_namespace n2 on n2.oid = p2.pronamespace
                      where n2.nspname = 'public' and p2.proname = 'stock_count_usage_period'
                        and has_function_privilege('authenticated', p2.oid, 'execute'))
    into v_ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('stock_count_usage', 'stock_count_usage_summary', 'stock_count_unrecipe_sales');
  v_out := v_out || format(E'%s  usage functions closed to anon; period helper internal\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  v_out := v_out || case when v_fail then 'VERIFY FAILED' else 'VERIFY OK' end;
  raise exception E'\n%', v_out;
end
$verify$;
