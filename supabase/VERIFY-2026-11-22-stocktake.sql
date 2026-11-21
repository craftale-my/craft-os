-- ============================================================================
-- VERIFY — Stocktake (2026-11-22). DEV ONLY (craft-os-dev).
--
-- Creates four [TEST] key items (three costed, one with no cost anywhere),
-- acts as the [TEST] Cheras supervisor login, and always ends by
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
  v_d    uuid;   -- item D: no cost anywhere, 0 on hand, counted 2 -> gain at no cost
  v_loc1 uuid;
  v_loc2 uuid;
  v_loc3 uuid;   -- deactivated mid-count
  v_num  numeric;
  v_cost numeric;
  v_val  numeric;
  v_def  text;
  v_count stock_counts%rowtype;
  v_n    int;
  v_avg_before numeric;
  v_avg_after  numeric;
  v_bal  numeric;
begin
  -- Fixture (as postgres): no key items and no open count at Cheras yet.
  update items set count_weekly = false where count_weekly;
  delete from stock_counts where branch_id = c_cheras and status = 'in_progress';

  perform set_config('request.jwt.claims', json_build_object('sub', c_sup_cheras, 'role', 'authenticated')::text, true);

  -- 0. Weekly count refused while there are no key items ----------------------
  execute 'set local role authenticated';
  begin
    perform start_stock_count(c_cheras, 'weekly');
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%No key items yet%';
  end;
  execute 'reset role';
  v_out := v_out || format(E'%s  weekly start refused with no key items\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- Fixture (as postgres): three key items with costed stock at Cheras, and one
  -- key item with no cost anywhere (no stock_in, latest_price null).
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price, count_weekly)
  values ('[TEST] VERIFY Stocktake A', 'raw', 'pack', 'g', 1000, 500, true) returning id into v_a;
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price, count_weekly)
  values ('[TEST] VERIFY Stocktake B', 'raw', 'box', 'pcs', 10, 20, true) returning id into v_b;
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price, count_weekly)
  values ('[TEST] VERIFY Stocktake C', 'raw', 'pcs', 'pcs', 1, 1, true) returning id into v_c;
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price, count_weekly)
  values ('[TEST] VERIFY Stocktake D', 'raw', 'pcs', 'pcs', 1, null, true) returning id into v_d;
  insert into inventory_transactions (item_id, branch_id, transaction_type, quantity, unit_cost, reference_type)
  values (v_a, c_cheras, 'stock_in', 10, 0.5, 'manual'),
         (v_b, c_cheras, 'stock_in', 4, 2, 'manual'),
         (v_c, c_cheras, 'stock_in', 5, 1, 'manual');
  v_avg_before := inventory_avg_unit_cost(v_b, c_cheras, null);
  v_ok := inventory_avg_unit_cost(v_d, c_cheras, null) is null;
  v_out := v_out || format(E'%s  fixture: item D has no cost anywhere\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  execute 'set local role authenticated';

  -- 1. Supervisor cannot set up locations (manager only) ----------------------
  begin
    perform save_storage_location(null, c_cheras, '[TEST] Chiller', 0, true);
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%Not authorised to manage storage locations%';
  end;
  v_out := v_out || format(E'%s  supervisor cannot create locations\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 2. Supervisor cannot start a count at another branch ----------------------
  begin
    perform start_stock_count(c_puchong, 'weekly');
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%Not authorised to count stock at this branch%';
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
  insert into storage_locations (branch_id, name, sort_order) values (c_cheras, '[TEST] VERIFY Old', 2) returning id into v_loc3;
  execute 'set local role authenticated';
  perform save_count_entry(v_count.id, v_a, v_loc1, 4);
  perform save_count_entry(v_count.id, v_a, v_loc2, 3);   -- A total 7
  perform save_count_entry(v_count.id, v_a, v_loc3, 1);   -- cleared below once Old is removed
  perform save_count_entry(v_count.id, v_b, null, 6);
  perform save_count_entry(v_count.id, v_d, null, 2);     -- D: gain of 2 at no cost
  begin
    perform submit_stock_count(v_count.id);
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%not counted yet%';
  end;
  v_out := v_out || format(E'%s  submit refused while an item is uncounted\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 4a. Every linked location needs a number: item B linked to Front and Back,
  --     entry at Front only -> refused; 0 at Back -> allowed (checked via the
  --     message of the refusal, then the count is left as before).
  execute 'reset role';
  insert into item_locations (item_id, location_id) values (v_b, v_loc1), (v_b, v_loc2);
  delete from stock_count_entries where count_id = v_count.id and item_id = v_b;
  execute 'set local role authenticated';
  perform save_count_entry(v_count.id, v_b, v_loc1, 6);
  perform save_count_entry(v_count.id, v_c, null, 5);   -- so only B can be the blocker
  begin
    perform submit_stock_count(v_count.id);
    v_ok := false;
  exception when others then v_ok := sqlerrm like '1 spot(s) not counted yet%';
  end;
  v_out := v_out || format(E'%s  linked item with one of two locations counted is refused\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;
  perform save_count_entry(v_count.id, v_b, v_loc2, 0);
  -- A's removed-location entry (Old, 1 g) is still there; with B complete the
  -- only other thing that could block is nothing, so submit would now pass.
  -- Prove it without submitting: re-run the same check inside a savepoint-like block.
  begin
    perform submit_stock_count(v_count.id);
    raise exception 'SUBMIT_PASSED_ROLLBACK';
  exception when others then v_ok := sqlerrm = 'SUBMIT_PASSED_ROLLBACK';
  end;
  v_out := v_out || format(E'%s  entering 0 at the other linked location allows submit\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;
  -- Restore: unlink B, clear its entries and C's, so the later checks run as before.
  perform save_count_entry(v_count.id, v_b, v_loc1, null);
  perform save_count_entry(v_count.id, v_b, v_loc2, null);
  perform save_count_entry(v_count.id, v_c, null, null);
  execute 'reset role';
  delete from item_locations where item_id = v_b;
  execute 'set local role authenticated';
  perform save_count_entry(v_count.id, v_b, null, 6);

  -- 4b. A removed location takes no numbers; its old entry can still be cleared
  execute 'reset role';
  update storage_locations set is_active = false where id = v_loc3;
  execute 'set local role authenticated';
  begin
    perform save_count_entry(v_count.id, v_a, v_loc3, 2);
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%location has been removed%';
  end;
  perform save_count_entry(v_count.id, v_a, v_loc3, null);
  select count(*) into v_n from stock_count_entries where count_id = v_count.id and location_id = v_loc3;
  v_ok := v_ok and v_n = 0;
  v_out := v_out || format(E'%s  removed location refuses a number, clearing still works\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 4c. counted_base is stored rounded to 3 dp -------------------------------
  perform save_count_entry(v_count.id, v_c, null, 1.23456);
  select counted_base into v_num from stock_count_entries where count_id = v_count.id and item_id = v_c;
  v_ok := v_num = 1.235;
  v_out := v_out || format(E'%s  counted_base rounded to 3 dp (%s)\n', case when v_ok then 'PASS' else 'FAIL' end, v_num);
  v_fail := v_fail or not v_ok;

  -- 5. Negative count refused; null clears an entry --------------------------
  begin
    perform save_count_entry(v_count.id, v_c, null, -1);
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%cannot be negative%';
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
  select coalesce(sum(quantity), 0) into v_bal from inventory_transactions where item_id = v_c and branch_id = c_cheras;
  v_ok := v_ok and v_bal = 5;
  select count(*) into v_n from inventory_transactions where reference_id = v_count.id and transaction_type = 'stocktake';
  v_ok := v_ok and v_n = 3 and v_count.status = 'submitted' and v_count.item_count = 4;
  v_out := v_out || format(E'%s  submit sets balances, 3 ledger rows, zero variance writes none\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 6b. A gain with no cost anywhere: ledger unit_cost NULL, value 0 ----------
  select unit_cost, quantity into v_cost, v_bal from inventory_transactions
   where reference_id = v_count.id and item_id = v_d and transaction_type = 'stocktake';
  v_ok := found and v_cost is null and v_bal = 2;
  select unit_cost, variance_value into v_cost, v_val from stock_count_items
   where count_id = v_count.id and item_id = v_d;
  v_ok := v_ok and found and v_cost is null and v_val = 0;
  -- other items keep their costs
  select unit_cost into v_cost from stock_count_items where count_id = v_count.id and item_id = v_a;
  v_ok := v_ok and v_cost = 0.5;
  select unit_cost into v_cost from stock_count_items where count_id = v_count.id and item_id = v_b;
  v_ok := v_ok and v_cost = 2;
  v_out := v_out || format(E'%s  no-cost gain: ledger unit_cost NULL, value 0, others unchanged\n', case when v_ok then 'PASS' else 'FAIL' end);
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

  -- 11. The type constraint keeps every ledger type ---------------------------
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conname = 'inventory_transactions_transaction_type_check'
     and conrelid = 'inventory_transactions'::regclass;
  v_ok := v_def is not null
      and v_def like '%''stock_in''%' and v_def like '%''adjustment''%' and v_def like '%''wastage''%'
      and v_def like '%''transfer_out''%' and v_def like '%''transfer_in''%'
      and v_def like '%''production_out''%' and v_def like '%''production_in''%'
      and v_def like '%''stocktake''%';
  v_out := v_out || format(E'%s  transaction-type constraint keeps all eight types\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  v_out := v_out || case when v_fail then 'VERIFY FAILED' else 'VERIFY OK' end;
  raise exception E'\n%', v_out;
end
$verify$;
