-- ============================================================================
-- VERIFY — Inventory v2 review fixes (2026-10-28). DEV ONLY (craft-os-dev).
--
-- Acts as the [TEST] logins from docs/dev-test-data.md inside one DO block
-- that always ends by raising its report as an error, so everything it
-- created is rolled back. Read the error text: one line per check, the last
-- line is VERIFY OK or VERIFY FAILED.
--
-- Needs on dev: the test logins, the HQ supplier row (Cheras), and Cheras
-- stock of the item below. Never run on production (the ids are dev-only).
-- ============================================================================
do $verify$
declare
  c_mgr_cheras  constant uuid := '193e1294-9c20-4425-b796-1cbff287e7a5';
  c_sup_cheras  constant uuid := 'bfd13ca2-6282-42f3-ad85-5fbe1325516d';
  c_sup_puchong constant uuid := 'd93522a5-218e-473c-8c4e-8e35a2bbd90a';
  c_sup_kepong  constant uuid := 'e111d11a-f5a1-4268-b7b7-56abb011ac2d';
  c_cheras      constant uuid := '75bb97bb-dedb-4aee-b326-373fd883780e';
  c_puchong     constant uuid := '13d1292f-e9ca-40ec-90d9-ed3086aa2396';
  c_kepong      constant uuid := 'f651a7d8-7da4-488b-b070-932b77ec1056';
  c_hq_supplier constant uuid := '6f3e19c0-cab2-43cc-98bd-d9e17c846f26';
  c_item        constant uuid := 'df0d4ada-d0a8-4aaf-9818-97296472c8a8';  -- 1000 base per purchase unit, stock at Cheras
  v_out   text := '';
  v_fail  boolean := false;
  v_po    uuid;
  v_line  uuid;
  v_ship1 uuid;
  v_ship2 uuid;
  v_cost2 numeric;
  v_in2   numeric;
  v_rec2  uuid;
  v_raw   uuid;
  v_semi  uuid;
  v_prev  jsonb;
  v_ok    boolean;
  v_msg   text;
begin
  -- -- fixtures (as postgres) ------------------------------------------------
  insert into purchase_orders (supplier_id, branch_id, status, created_by)
  values (c_hq_supplier, c_puchong, 'sent', c_sup_puchong) returning id into v_po;
  insert into purchase_order_items (po_id, item_id, quantity_ordered, unit_price)
  values (v_po, c_item, 2, 0) returning id into v_line;

  -- act as a login
  -- (role switch + JWT sub, reset before each fixture step)
  -- 1. ship one unit from HQ ------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', c_sup_cheras, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_ship1 := ship_internal_po(v_po, jsonb_build_array(jsonb_build_object('po_item_id', v_line, 'quantity', 1)));
  execute 'reset role';

  -- 2. Puchong PATCHes the status to received / draft -> refused ------------
  perform set_config('request.jwt.claims', json_build_object('sub', c_sup_puchong, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    update purchase_orders set status = 'received' where id = v_po;
    v_ok := false;
  exception when others then v_ok := true; v_msg := sqlerrm;
  end;
  v_out := v_out || format(E'%s  F1 client cannot set an in-transit PO to received\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;
  begin
    update purchase_orders set status = 'draft' where id = v_po;
    v_ok := false;
  exception when others then v_ok := true;
  end;
  v_out := v_out || format(E'%s  F1 client cannot move a sent PO back to draft\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 3. Puchong edits received_quantity -> refused --------------------------
  begin
    update purchase_order_items set received_quantity = 1 where id = v_line;
    v_ok := false;
  exception when others then v_ok := true;
  end;
  v_out := v_out || format(E'%s  F2 client cannot edit received_quantity\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- receive shipment 1 in full (the RPC path still works)
  perform submit_receiving(v_po, 'test/delivery.jpg', null, null,
    jsonb_build_array(jsonb_build_object('po_item_id', v_line, 'actual_quantity', 1)));
  execute 'reset role';
  v_ok := (select status from purchase_orders where id = v_po) = 'partially_received';
  v_out := v_out || format(E'%s  F1/F2 receiving RPC still sets status and quantities\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 4. HQ average moves, ship unit 2, receive it: cost = shipment 2 only ----
  -- One transaction gives both shipments the same now(); age shipment 1 so
  -- the order is the real-world one.
  update po_shipments set shipped_at = shipped_at - interval '1 hour' where id = v_ship1;
  insert into inventory_transactions (item_id, branch_id, transaction_type, quantity, unit_cost, notes, reference_type)
  values (c_item, c_cheras, 'adjustment', 5000, 5, '[TEST] verify: move the average', 'adjustment');
  perform set_config('request.jwt.claims', json_build_object('sub', c_sup_cheras, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_ship2 := ship_internal_po(v_po, jsonb_build_array(jsonb_build_object('po_item_id', v_line, 'quantity', 1)));
  execute 'reset role';
  select unit_cost into v_cost2 from po_shipment_items where shipment_id = v_ship2;
  perform set_config('request.jwt.claims', json_build_object('sub', c_sup_puchong, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_rec2 := submit_receiving(v_po, 'test/delivery2.jpg', null, null,
    jsonb_build_array(jsonb_build_object('po_item_id', v_line, 'actual_quantity', 1)));
  execute 'reset role';
  select t.unit_cost into v_in2 from inventory_transactions t
   where t.transaction_type = 'transfer_in' and t.reference_id = v_rec2;
  v_ok := v_in2 is not null and abs(v_in2 - v_cost2) < 0.000001
          and v_cost2 <> (select unit_cost from po_shipment_items where shipment_id = v_ship1);
  v_out := v_out || format(E'%s  F4 transfer_in cost %s = shipment-2 cost %s\n',
    case when v_ok then 'PASS' else 'FAIL' end, round(v_in2, 6), round(v_cost2, 6));
  v_fail := v_fail or not v_ok;

  -- 5. Kepong cannot read a Puchong receiving photo via a forged wastage row --
  insert into wastage_logs (branch_id, item_id, quantity, reason, note, photo_path, business_date, created_by)
  values (c_kepong, c_item, 1, 'other', '[TEST] forged path', v_po::text || '/forged.jpg', current_date, c_sup_kepong);
  perform set_config('request.jwt.claims', json_build_object('sub', c_sup_kepong, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_ok := not receiving_photo_readable(v_po::text || '/forged.jpg')
          and not receiving_photo_readable('wastage/' || c_puchong::text || '/x.jpg');
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', c_sup_puchong, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_ok := v_ok and receiving_photo_readable(v_po::text || '/forged.jpg');
  execute 'reset role';
  v_out := v_out || format(E'%s  F3 photo read decided by the PO prefix, not a forged row\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 6. Manager cannot unmark or delete the HQ supplier ---------------------
  perform set_config('request.jwt.claims', json_build_object('sub', c_mgr_cheras, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin
    update suppliers set internal_branch_id = null where id = c_hq_supplier;
    v_ok := false;
  exception when others then v_ok := true;
  end;
  begin
    delete from suppliers where id = c_hq_supplier;
    v_ok := false;
  exception when others then v_ok := v_ok and true;
  end;
  v_out := v_out || format(E'%s  F7 HQ supplier marker cannot be changed or deleted from the app\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 7. Negative adjustment below zero -> refused; within stock -> fine ------
  begin
    insert into inventory_transactions (item_id, branch_id, transaction_type, quantity, notes)
    values (c_item, c_cheras, 'adjustment', -99999999, '[TEST] verify');
    v_ok := false;
  exception when others then v_ok := true;
  end;
  begin
    insert into inventory_transactions (item_id, branch_id, transaction_type, quantity, notes)
    values (c_item, c_cheras, 'adjustment', -1, '[TEST] verify');
  exception when others then v_ok := false;
  end;
  execute 'reset role';
  v_out := v_out || format(E'%s  F9 adjustment cannot take a branch below zero\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 8. Production with an uncosted ingredient -> blocked -------------------
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, status)
  values ('[TEST] verify uncosted raw', 'raw', 'g', 'g', 1, 'active') returning id into v_raw;
  insert into inventory_transactions (item_id, branch_id, transaction_type, quantity, notes)
  values (v_raw, c_cheras, 'adjustment', 100, '[TEST] verify');
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, status)
  values ('[TEST] verify semi', 'semi_finished', 'g', 'g', 1, 'active') returning id into v_semi;
  with r as (
    insert into recipes (item_id, version, yield_qty, effective_from, status, verified_at, verified_by, created_by)
    values (v_semi, 1, 50, current_date - 1, 'active', now(), c_mgr_cheras, c_mgr_cheras) returning id)
  insert into recipe_lines (recipe_id, item_id, qty_base) select r.id, v_raw, 10 from r;
  perform set_config('request.jwt.claims', json_build_object('sub', c_sup_cheras, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_prev := preview_production(v_semi, c_cheras, 1);
  v_ok := (v_prev->>'missing_cost')::boolean and not (v_prev->>'can_produce')::boolean;
  begin
    perform produce_batch(v_semi, c_cheras, 1, null);
    v_ok := false;
  exception when others then v_ok := v_ok and sqlerrm like '%no cost%';
  end;
  execute 'reset role';
  v_out := v_out || format(E'%s  F5 uncosted ingredient blocks preview and produce\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  -- 9. Older files refuse to re-run -----------------------------------------
  v_ok := to_regprocedure('public.guard_po_status_client()') is not null
          and to_regclass('public.po_shipments') is not null;
  v_out := v_out || format(E'%s  F8 re-run markers present\n', case when v_ok then 'PASS' else 'FAIL' end);
  v_fail := v_fail or not v_ok;

  v_out := v_out || case when v_fail then 'VERIFY FAILED' else 'VERIFY OK' end;
  -- Raising rolls back every fixture above.
  raise exception E'\n%', v_out;
end
$verify$;
