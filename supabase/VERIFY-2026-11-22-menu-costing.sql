-- ============================================================================
-- VERIFY — Menu costing (2026-11-22). DEV ONLY (craft-os-dev).
-- Builds [TEST] items, a prep recipe chain and a [TEST] menu product, acts as
-- the [TEST] manager and supervisor, and always ends by raising its report so
-- every change rolls back. Last line: VERIFY OK or VERIFY FAILED.
-- ============================================================================
do $verify$
declare
  c_manager    constant uuid := '193e1294-9c20-4425-b796-1cbff287e7a5';  -- test.manager.cheras
  c_supervisor constant uuid := 'bfd13ca2-6282-42f3-ad85-5fbe1325516d';  -- test.supervisor.cheras
  v_out text := ''; v_fail boolean := false; v_ok boolean;
  v_a uuid; v_b uuid; v_n uuid; v_p uuid; v_p2 uuid; v_r uuid;
  v_cat uuid; v_prod uuid; v_v1 uuid; v_v2 uuid; v_v3 uuid; v_v4 uuid; v_grp uuid; v_opt uuid;
  v_cost numeric; v_row record;
begin
  -- Fixture (as postgres) ---------------------------------------------------
  -- A: RM 20 per 1000 g = 0.02/g. B: RM 5 per 500 ml = 0.01/ml. N: no price.
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price)
  values ('[TEST] MC A', 'raw', 'pack', 'g', 1000, 20) returning id into v_a;
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price)
  values ('[TEST] MC B', 'raw', 'bottle', 'ml', 500, 5) returning id into v_b;
  insert into items (name, category, purchase_unit, base_unit, conversion_rate, latest_price)
  values ('[TEST] MC N', 'raw', 'pack', 'g', 1000, null) returning id into v_n;
  -- P: prep, yield 1000 g from 500 g A (10.00) + 500 ml B (5.00) = 0.015/g.
  insert into items (name, category, purchase_unit, base_unit, conversion_rate)
  values ('[TEST] MC Prep P', 'semi_finished', 'batch', 'g', 1000) returning id into v_p;
  insert into recipes (item_id, version, yield_qty, effective_from, status, verified_at)
  values (v_p, 1, 1000, current_date - 1, 'active', now()) returning id into v_r;
  insert into recipe_lines (recipe_id, item_id, qty_base) values (v_r, v_a, 500), (v_r, v_b, 500);
  -- P2: prep, yield 10 from 100 g P (1.50) = 0.15 each.
  insert into items (name, category, purchase_unit, base_unit, conversion_rate)
  values ('[TEST] MC Prep P2', 'semi_finished', 'batch', 'pcs', 10) returning id into v_p2;
  insert into recipes (item_id, version, yield_qty, effective_from, status, verified_at)
  values (v_p2, 1, 10, current_date - 1, 'active', now()) returning id into v_r;
  insert into recipe_lines (recipe_id, item_id, qty_base) values (v_r, v_p, 100);

  insert into menu_categories (name) values ('[TEST] MC Drinks') returning id into v_cat;
  insert into menu_products (name, category_id) values ('[TEST] MC Latte', v_cat) returning id into v_prod;
  insert into menu_variants (product_id, feedme_variant_key, name, price_sen) values (v_prod, 'hot', 'Hot', 1000) returning id into v_v1;
  insert into menu_variants (product_id, feedme_variant_key, name, price_sen) values (v_prod, 'cold', 'Cold', 1200) returning id into v_v2;
  insert into menu_variants (product_id, feedme_variant_key, name, price_sen) values (v_prod, 'free', 'Free', 0) returning id into v_v3;
  insert into modifier_groups (name) values ('[TEST] MC Milk') returning id into v_grp;
  insert into modifier_options (group_id, name) values (v_grp, 'Oat milk') returning id into v_opt;

  -- 1. Standard costs (manager) ---------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('sub', c_manager, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_ok := round(item_standard_cost(v_a), 6) = 0.02
      and round(item_standard_cost(v_p), 6) = 0.015
      and round(item_standard_cost(v_p2), 6) = 0.15
      and item_standard_cost(v_n) is null;
  v_out := v_out || format(E'%s  standard cost: raw, prep, nested prep, no price -> null\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- 2. Variant recipe, cost and food cost % ----------------------------------
  -- Hot: 100 g P (1.50) + 50 g A (1.00) = 2.50 on RM 10.00 -> 2500 bp.
  perform save_variant_recipe(v_v1, jsonb_build_array(
    jsonb_build_object('item_id', v_p, 'qty_base', 100),
    jsonb_build_object('item_id', v_a, 'qty_base', 50)));
  select * into v_row from menu_variant_costs where variant_id = v_v1;
  v_ok := v_row.line_count = 2 and round(v_row.cost_rm, 4) = 2.5 and v_row.food_cost_bp = 2500
      and v_row.missing_cost_items = 0 and v_row.over_target = false;
  v_out := v_out || format(E'%s  variant cost 2.50 and 2500 bp (got %s / %s)\n', case when v_ok is true then 'PASS' else 'FAIL' end, v_row.cost_rm, v_row.food_cost_bp);
  v_fail := v_fail or v_ok is not true;

  -- 3. Target and over-target ------------------------------------------------
  perform set_category_target(v_cat, 2000);
  select * into v_row from menu_variant_costs where variant_id = v_v1;
  v_ok := v_row.target_food_cost_bp = 2000 and v_row.over_target = true;
  perform set_category_target(v_cat, null);
  select * into v_row from menu_variant_costs where variant_id = v_v1;
  v_ok := v_ok and v_row.target_food_cost_bp is null and v_row.over_target = false;
  v_out := v_out || format(E'%s  category target flags over-target; null clears\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- 4. Missing cost propagates -------------------------------------------------
  perform save_variant_recipe(v_v2, jsonb_build_array(
    jsonb_build_object('item_id', v_a, 'qty_base', 50),
    jsonb_build_object('item_id', v_n, 'qty_base', 10)));
  select * into v_row from menu_variant_costs where variant_id = v_v2;
  v_ok := v_row.missing_cost_items = 1 and v_row.cost_rm is null and v_row.food_cost_bp is null;
  v_out := v_out || format(E'%s  an ingredient without a price makes cost and %% null\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- 5. Copy recipe Hot -> Cold overwrites -------------------------------------
  perform copy_variant_recipe(v_v1, v_v2);
  select * into v_row from menu_variant_costs where variant_id = v_v2;
  v_ok := v_row.line_count = 2 and round(v_row.cost_rm, 4) = 2.5 and v_row.food_cost_bp = 2083;
  v_out := v_out || format(E'%s  copy Hot -> Cold (2.50 on RM 12.00 = 2083 bp, got %s)\n', case when v_ok is true then 'PASS' else 'FAIL' end, v_row.food_cost_bp);
  v_fail := v_fail or v_ok is not true;

  -- 6. Zero price -> no food cost % ---------------------------------------------
  perform copy_variant_recipe(v_v1, v_v3);
  select * into v_row from menu_variant_costs where variant_id = v_v3;
  v_ok := round(v_row.cost_rm, 4) = 2.5 and v_row.food_cost_bp is null;
  v_out := v_out || format(E'%s  price 0 -> food cost %% null\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- 7. Swap add-on: +100 ml B (1.00) -100 g A (-2.00) = -1.00 -----------------
  perform save_modifier_recipe(v_opt, jsonb_build_array(
    jsonb_build_object('item_id', v_b, 'qty_base', 100),
    jsonb_build_object('item_id', v_a, 'qty_base', -100)));
  select * into v_row from modifier_option_costs where option_id = v_opt;
  v_ok := round(v_row.cost_delta_rm, 4) = -1 and v_row.line_count = 2;
  v_out := v_out || format(E'%s  swap add-on cost delta -1.00 (got %s)\n', case when v_ok is true then 'PASS' else 'FAIL' end, v_row.cost_delta_rm);
  v_fail := v_fail or v_ok is not true;

  -- 8. Validation ----------------------------------------------------------------
  begin
    perform save_variant_recipe(v_v1, jsonb_build_array(jsonb_build_object('item_id', v_a, 'qty_base', 0)));
    v_ok := false;
  exception when others then v_ok := sqlerrm like '%greater than zero%';
  end;
  begin
    perform save_modifier_recipe(v_opt, jsonb_build_array(jsonb_build_object('item_id', v_a, 'qty_base', 0)));
    v_ok := false;
  exception when others then v_ok := v_ok and sqlerrm like '%cannot be zero%';
  end;
  begin
    perform save_variant_recipe(v_v1, jsonb_build_array(
      jsonb_build_object('item_id', v_a, 'qty_base', 1), jsonb_build_object('item_id', v_a, 'qty_base', 2)));
    v_ok := false;
  exception when others then v_ok := v_ok and sqlerrm like '%more than once%';
  end;
  v_out := v_out || format(E'%s  zero / duplicate lines refused\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- 8b. Input hardening and cross-product copy ---------------------------------
  v_ok := true;
  begin perform save_variant_recipe(v_v1, '{}'::jsonb); v_ok := false;
  exception when others then v_ok := v_ok and sqlerrm like '%must be a list%'; end;
  begin perform save_modifier_recipe(v_opt, '"x"'::jsonb); v_ok := false;
  exception when others then v_ok := v_ok and sqlerrm like '%must be a list%'; end;
  begin perform save_variant_recipe(v_v1, jsonb_build_array(jsonb_build_object('item_id', 'not-a-uuid', 'qty_base', 1))); v_ok := false;
  exception when others then v_ok := v_ok and sqlerrm like '%needs an ingredient and a quantity%'; end;
  begin perform save_modifier_recipe(v_opt, jsonb_build_array(jsonb_build_object('item_id', v_a, 'qty_base', 'NaN'))); v_ok := false;
  exception when others then v_ok := v_ok and sqlerrm like '%needs an ingredient and a quantity%'; end;
  begin perform save_variant_recipe(v_v1, jsonb_build_array(jsonb_build_object('item_id', v_a, 'qty_base', to_jsonb('NaN'::numeric)))); v_ok := false;
  exception when others then v_ok := v_ok and sqlerrm like '%needs an ingredient and a quantity%'; end;
  begin perform save_variant_recipe(v_v1, jsonb_build_array(jsonb_build_object('item_id', v_a))); v_ok := false;
  exception when others then v_ok := v_ok and sqlerrm like '%needs an ingredient and a quantity%'; end;
  v_out := v_out || format(E'%s  non-array, bad uuid, NaN and missing qty refused\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  execute 'reset role';
  insert into menu_products (name, category_id) values ('[TEST] MC Other', v_cat) returning id into v_prod;
  insert into menu_variants (product_id, feedme_variant_key, name, price_sen) values (v_prod, 'x', 'X', 500) returning id into v_v4;
  perform set_config('request.jwt.claims', json_build_object('sub', c_manager, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  begin perform copy_variant_recipe(v_v1, v_v4); v_ok := false;
  exception when others then v_ok := sqlerrm like '%same menu item%'; end;
  v_out := v_out || format(E'%s  copy across different menu items refused\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- 9. item_standard_costs batch ------------------------------------------------
  select count(*) = 2 and bool_and(case when item_id = v_a then round(unit_cost, 6) = 0.02 else unit_cost is null end)
    into v_ok from item_standard_costs(array[v_a, v_n]);
  v_out := v_out || format(E'%s  item_standard_costs batch\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- 10. Supervisor (no manage_procurement) refused --------------------------------
  execute 'reset role';
  perform set_config('request.jwt.claims', json_build_object('sub', c_supervisor, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  v_ok := true;
  begin perform item_standard_cost(v_a); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%Not authorised%'; end;
  begin perform save_variant_recipe(v_v1, '[]'::jsonb); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%Not authorised%'; end;
  begin perform set_category_target(v_cat, 1000); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%Not authorised%'; end;
  begin perform save_modifier_recipe(v_opt, '[]'::jsonb); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%Not authorised%'; end;
  begin perform copy_variant_recipe(v_v1, v_v2); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%Not authorised%'; end;
  begin perform item_standard_costs(array[v_a]); v_ok := false; exception when others then v_ok := v_ok and sqlerrm like '%Not authorised%'; end;
  select v_ok and not exists (select 1 from menu_variant_recipe_lines) and not exists (select 1 from menu_category_targets)
         and not exists (select 1 from modifier_recipe_lines) and not exists (select 1 from menu_recipe_meta)
    into v_ok;
  v_ok := v_ok is true
    and not exists (select 1 from menu_variant_costs where variant_id in (v_v1, v_v2, v_v3)
                      and (cost_rm is not null or food_cost_bp is not null or target_food_cost_bp is not null))
    and not exists (select 1 from modifier_option_costs where option_id = v_opt and cost_delta_rm is not null);
  execute 'reset role';
  v_out := v_out || format(E'%s  supervisor refused on functions and sees no recipe rows\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  -- 11. anon cannot execute ---------------------------------------------------------
  select not bool_or(has_function_privilege('anon', p.oid, 'execute')) into v_ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname in ('item_standard_cost', 'item_standard_costs', 'item_standard_cost_at',
     'save_variant_recipe', 'save_modifier_recipe', 'copy_variant_recipe', 'set_category_target');
  v_out := v_out || format(E'%s  anon cannot execute menu costing functions\n', case when v_ok is true then 'PASS' else 'FAIL' end);
  v_fail := v_fail or v_ok is not true;

  v_out := v_out || case when v_fail then 'VERIFY FAILED' else 'VERIFY OK' end;
  raise exception E'\n%', v_out;
end
$verify$;
