-- ============================================================================
-- VERIFY — POS sales depletion + stock count usage (2026-11-23). DEV ONLY.
-- Builds a [TEST] item, menu variant, add-ons and bills at Cheras, then always
-- raises its report so every change rolls back. Last line: VERIFY OK/FAILED.
-- ============================================================================
do $verify$
declare
  c_cheras  constant uuid := '75bb97bb-dedb-4aee-b326-373fd883780e';
  c_manager constant uuid := '193e1294-9c20-4425-b796-1cbff287e7a5';  -- test.manager.cheras
  v_out text := ''; v_fail boolean := false; v_ok boolean;
  v_a uuid; v_cat uuid; v_prod uuid; v_var uuid; v_var_norecipe uuid; v_grp uuid; v_opt_add uuid; v_opt_swap uuid;
  v_bill uuid; v_bill2 uuid; v_bill3 uuid; v_order uuid; v_n int; v_q numeric; v_row record;
  v_c1 uuid; v_c2 uuid; v_sum jsonb;
begin
  -- Fixture (as postgres) -------------------------------------------------------
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
  -- Previous count a day ago, current count a minute from now; between them:
  -- the -380 g sale (bill 1) and a 30 g wastage; the current count found 40 g less than book.
  insert into stock_counts (branch_id, kind, status, started_at, submitted_at, item_count, gain_value, loss_value, net_value)
  values (c_cheras, 'full', 'submitted', now() - interval '1 day', now() - interval '1 day', 0, 0, 0, 0) returning id into v_c1;
  insert into inventory_transactions (item_id, branch_id, transaction_type, quantity, unit_cost, reference_type)
  values (v_a, c_cheras, 'wastage', -30, 0.05, 'manual');
  insert into stock_counts (branch_id, kind, status, started_at, submitted_at, item_count, gain_value, loss_value, net_value)
  values (c_cheras, 'full', 'submitted', now(), now() + interval '1 minute', 1, 0, 2, -2) returning id into v_c2;
  insert into stock_count_items (count_id, item_id, counted_base, expected_base, variance_base, unit_cost, variance_value)
  values (v_c2, v_a, 4550, 4590, -40, 0.05, -2);

  perform set_config('request.jwt.claims', json_build_object('sub', c_manager, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  -- B1. Per-item usage ------------------------------------------------------------------
  select * into v_row from stock_count_usage(v_c2) where item_id = v_a;
  v_ok := v_row.sold_base = 380 and round(v_row.sold_value, 2) = 19.00
      and v_row.wasted_base = 30 and round(v_row.wasted_value, 2) = 1.50
      and v_row.unexplained_base = -40 and round(v_row.unexplained_value, 2) = -2.00
      and round(v_row.unexplained_pct, 2) = 10.53;
  v_out := v_out || format(E'%s  usage: sold 380 g RM 19.00, wasted 30 g RM 1.50, unexplained -40 g RM -2.00 = 10.53%% (got %s / %s / %s / %s)\n',
                           case when v_ok is true then 'PASS' else 'FAIL' end, v_row.sold_base, v_row.wasted_base, v_row.unexplained_base, v_row.unexplained_pct);
  v_fail := v_fail or v_ok is not true;

  -- B2. Summary -----------------------------------------------------------------------
  v_sum := stock_count_usage_summary(v_c2);
  v_ok := (v_sum->>'from_previous')::boolean = true
      and (v_sum->>'lines_without_recipe')::int >= 1
      and (v_sum->>'depletion_errors')::int >= 1
      and (v_sum->>'bills_paid')::int >= 2
      and round((v_sum->>'sold_value')::numeric, 2) >= 19.00;
  v_out := v_out || format(E'%s  summary: previous count found, paid bills, lines without recipe, errors (%s)\n',
                           case when v_ok is true then 'PASS' else 'FAIL' end, v_sum);
  v_fail := v_fail or v_ok is not true;

  -- B3. Sold without recipe -------------------------------------------------------------
  select exists (select 1 from stock_count_unrecipe_sales(v_c2) where variant_name = 'No recipe' and qty_sold = 1)
    into v_ok;
  v_out := v_out || format(E'%s  sold-without-recipe lists the no-recipe variant\n', case when v_ok is true then 'PASS' else 'FAIL' end);
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
