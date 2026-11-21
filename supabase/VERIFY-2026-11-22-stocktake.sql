-- ============================================================================
-- VERIFY — Stocktake (2026-11-22). DEV ONLY (craft-os-dev).
--
-- Creates two [TEST] key items, acts as the [TEST] logins, and always ends by
-- raising its report as an error so every change is rolled back.
-- Last line: VERIFY OK or VERIFY FAILED.
-- ============================================================================
do $verify$
declare
  c_sup_cheras constant uuid := 'bfd13ca2-6282-42f3-ad85-5fbe1325516d';
  c_cheras     constant uuid := '75bb97bb-dedb-4aee-b326-373fd883780e';
  c_puchong    constant uuid := '13d1292f-e9ca-40ec-90d9-ed3086aa2396';
  v_out  text := '';
  v_fail boolean := false;
  v_ok   boolean;
  v_a    uuid;   -- item A: 10 on hand at RM 0.50, counted 7  -> loss 3
  v_b    uuid;   -- item B: 4 on hand at RM 2.00, counted 6   -> gain 2
  v_c    uuid;   -- item C: 5 on hand, counted 5              -> no ledger row
  v_loc1 uuid;
  v_loc2 uuid;
  v_count stock_counts%rowtype;
  v_n    int;
  v_avg_before numeric;
  v_avg_after  numeric;
  v_bal  numeric;
begin
  -- Fixture (as postgres): three key items with costed stock at Cheras.
  update items set count_weekly = false where count_weekly;
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price, count_weekly)
  values ('[TEST] VERIFY Stocktake A', 'raw', 'pack', 'g', 1000, 500, true) returning id into v_a;
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price, count_weekly)
  values ('[TEST] VERIFY Stocktake B', 'raw', 'box', 'pcs', 10, 20, true) returning id into v_b;
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price, count_weekly)
  values ('[TEST] VERIFY Stocktake C', 'raw', 'pcs', 'pcs', 1, 1, true) returning id into v_c;
  insert into inventory_transactions (item_id, branch_id, transaction_type, quantity, unit_cost, reference_type)
  values (v_a, c_cheras, 'stock_in', 10, 0.5, 'manual'),
         (v_b, c_cheras, 'stock_in', 4, 2, 'manual'),
         (v_c, c_cheras, 'stock_in', 5, 1, 'manual');
  delete from stock_counts where branch_id = c_cheras and status = 'in_progress';
  v_avg_before := inventory_avg_unit_cost(v_b, c_cheras, null);

  perform set_config('request.jwt.claims', json_build_object('sub', c_sup_cheras, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';

  -- 1. Supervisor cannot set up locations (manager only) ----------------------
  begin
    perform save_storage_location(null, c_cheras, '[TEST] Chiller', 0, true);
    v_ok := false;
  exception when others then v_ok := true;
  end;
  v_out := v_out || format(E'%s  supervisor cannot create locations\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 2. Supervisor cannot start a count at another branch ----------------------
  begin
    perform start_stock_count(c_puchong, 'weekly');
    v_ok := false;
  exception when others then v_ok := true;
  end;
  v_out := v_out || format(E'%s  supervisor cannot count another branch\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 3. Start, then a second start is refused ----------------------------------
  v_count := start_stock_count(c_cheras, 'weekly');
  begin
    perform start_stock_count(c_cheras, 'full');
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%already in progress%';
  end;
  v_out := v_out || format(E'%s  one in-progress count per branch\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 4. Submit refused while an item is not counted ---------------------------
  execute 'reset role';
  insert into storage_locations (branch_id, name, sort_order) values (c_cheras, '[TEST] VERIFY Front', 0) returning id into v_loc1;
  insert into storage_locations (branch_id, name, sort_order) values (c_cheras, '[TEST] VERIFY Back', 1) returning id into v_loc2;
  execute 'set local role authenticated';
  perform save_count_entry(v_count.id, v_a, v_loc1, 4);
  perform save_count_entry(v_count.id, v_a, v_loc2, 3);   -- A total 7
  perform save_count_entry(v_count.id, v_b, null, 6);
  begin
    perform submit_stock_count(v_count.id);
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%not counted yet%';
  end;
  v_out := v_out || format(E'%s  submit refused while an item is uncounted\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 5. Negative count refused; null clears an entry --------------------------
  begin
    perform save_count_entry(v_count.id, v_c, null, -1);
    v_ok := false;
  exception when others then v_ok := true;
  end;
  perform save_count_entry(v_count.id, v_c, null, 99);
  perform save_count_entry(v_count.id, v_c, null, null);
  select count(*) into v_n from stock_count_entries where count_id = v_count.id and item_id = v_c;
  v_ok := v_ok and v_n = 0;
  v_out := v_out || format(E'%s  negative refused, null clears the entry\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 6. Submit: balances equal counts, ledger rows only where different -------
  perform save_count_entry(v_count.id, v_c, null, 5);
  v_count := submit_stock_count(v_count.id);
  execute 'reset role';
  select coalesce(sum(quantity), 0) into v_bal from inventory_transactions where item_id = v_a and branch_id = c_cheras;
  v_ok := v_bal = 7;
  select coalesce(sum(quantity), 0) into v_bal from inventory_transactions where item_id = v_b and branch_id = c_cheras;
  v_ok := v_ok and v_bal = 6;
  select count(*) into v_n from inventory_transactions where reference_id = v_count.id and transaction_type = 'stocktake';
  v_ok := v_ok and v_n = 2 and v_count.status = 'submitted' and v_count.item_count = 3;
  v_out := v_out || format(E'%s  submit sets balances, 2 ledger rows, zero variance writes none\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 7. RM totals: loss 3 x 0.50 = 1.50, gain 2 x 2.00 = 4.00 -----------------
  v_ok := v_count.loss_value = 1.50 and v_count.gain_value = 4.00 and v_count.net_value = 2.50;
  v_out := v_out || format(E'%s  loss/gain/net values (%s / %s / %s)\n', case when v_ok then 'PASS' else 'FAIL' end,
                           v_count.loss_value, v_count.gain_value, v_count.net_value);
  v_fail := v_fail or not v_ok;

  -- 8. A gain does not move the moving average --------------------------------
  v_avg_after := inventory_avg_unit_cost(v_b, c_cheras, null);
  v_ok := round(v_avg_after, 6) = round(v_avg_before, 6);
  v_out := v_out || format(E'%s  moving average unchanged by a gain\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 9. Entries locked after submit -------------------------------------------
  execute 'set local role authenticated';
  begin
    perform save_count_entry(v_count.id, v_a, v_loc1, 1);
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%no longer open%';
  end;
  execute 'reset role';
  v_out := v_out || format(E'%s  entries refused after submit\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 10. anon cannot run any stocktake function -------------------------------
  select not bool_or(has_function_privilege('anon', p.oid, 'execute')) into v_ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('save_storage_location', 'set_location_items', 'set_item_count_weekly',
                       'start_stock_count', 'save_count_entry', 'cancel_stock_count', 'submit_stock_count');
  v_out := v_out || format(E'%s  anon cannot execute stocktake functions\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  v_out := v_out || case when v_fail then 'VERIFY FAILED' else 'VERIFY OK' end;
  raise exception E'\n%', v_out;
end
$verify$;
