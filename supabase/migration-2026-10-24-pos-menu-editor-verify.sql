-- Self-check for the POS menu editor (M2). Run on craft-os-dev after
-- migration-2026-10-24-pos-menu-editor-fn.sql. Everything is rolled back.
-- Success = a result row "VERIFY OK". Every refusal is paired with the success it
-- guards; the manage_menu checks call each function as `authenticated` (grants too).
begin;

-- expect_error(sql, message, label): runs sql and insists it raises exactly message.
-- A temporary function: it disappears with the rollback below.
create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message;
exception when raise_exception then
  if sqlerrm <> p_message then
    raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
  end if;
end $$;

do $$
declare
  v_owner   uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_mgr     uuid := 'dddddddd-0000-0000-0000-000000000001';   -- manager of VERIFY M2: no manage_menu
  v_cashier uuid := 'dddddddd-0000-0000-0000-000000000002';   -- staff of VERIFY M2
  v_boss    uuid := 'dddddddd-0000-0000-0000-000000000003';   -- a second owner, resigned in K
  v_branch uuid; v_t1 dining_tables;
  v_drinks uuid; v_food uuid; v_newcat uuid;
  c_dine uuid; c_take uuid; c_qr uuid; c_grab uuid; c_new uuid; c_copy uuid;
  v_oat uuid; v_syrup uuid;
  v_milk uuid; v_opt_oat uuid; v_opt_soy uuid; v_other_group uuid; v_other_opt uuid;
  v_latte uuid; v_hot uuid; v_cold uuid; v_toast uuid; v_reg uuid; v_large uuid;
  v_order uuid; v_order2 uuid; v_old_order uuid;
  v_p jsonb; v_p2 jsonb; v_g jsonb; v_res jsonb; v_text text; v_id uuid; n integer; r record;
  v_ids uuid[];
  v_bun uuid; v_bun_reg uuid;
begin
  -- ── A. grants, internal helpers, search_path ──────────────────────────────
  for r in select f from unnest(array[
             'menu_editor_lookups()', 'menu_product_list()', 'menu_product_detail(uuid)', 'menu_save_product(jsonb)',
             'menu_group_detail(uuid)', 'menu_save_group(jsonb)', 'menu_save_catalog(uuid,text)',
             'menu_duplicate_catalog(uuid,text)', 'menu_reorder_catalogs(uuid[])', 'menu_set_catalog_active(uuid,boolean)',
             'menu_catalog_grid(uuid)', 'menu_save_catalog_row(jsonb)', 'menu_save_category(uuid,text)',
             'menu_reorder_categories(uuid[])', 'menu_set_category_active(uuid,boolean)', 'pos_menu_rows(uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
    if not has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL grants: staff cannot call %', r.f; end if;
  end loop;
  for r in select f from unnest(array[
             'menu_require_editor()', 'menu_clean_name(text,text,integer)', 'menu_sen(jsonb)', 'menu_uuid(jsonb)',
             'menu_new_variant_key()', 'menu_check_catalog_prices(uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') or has_function_privilege('authenticated', r.f, 'execute') then
      raise exception 'FAIL grants: % must be internal', r.f;
    end if;
  end loop;
  for r in select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public' and p.proname = any (array[
              'menu_require_editor','menu_clean_name','menu_sen','menu_uuid','menu_new_variant_key','menu_check_catalog_prices',
              'menu_editor_lookups','menu_product_list','menu_product_detail','menu_save_product','menu_group_detail',
              'menu_save_group','menu_save_catalog','menu_duplicate_catalog','menu_reorder_catalogs','menu_set_catalog_active',
              'menu_catalog_grid','menu_save_catalog_row','menu_save_category','menu_reorder_categories',
              'menu_set_category_active','pos_menu_rows'])
              and not coalesce(p.proconfig @> array['search_path=public, pg_temp'], false) loop
    raise exception 'FAIL search_path: % does not pin search_path = public, pg_temp', r.proname;
  end loop;
  -- M2 adds no policy: menu writes still go through RPCs only (the menu verify's A2 stays true)
  if exists (select 1 from pg_policies where schemaname = 'public'
              and tablename in ('menu_categories','menu_products','menu_variants','modifier_groups','modifier_options',
                                'product_modifier_groups')
              and cmd in ('INSERT','DELETE','ALL')) then
    raise exception 'FAIL rls: a master menu table can be inserted into or deleted from directly';
  end if;

  -- ── B. fixture: a branch with four catalogs, two add-on items, staff ──────
  update system_role_permissions set permissions = permissions - 'manage_menu';   -- code defaults for this run
  insert into branches(name, address) values ('VERIFY M2', 'verify') returning id into v_branch;
  insert into dining_tables(branch_id, label) values (v_branch, 'M2') returning * into v_t1;
  insert into menu_categories(name, sort_order) values ('VERIFY M2 DRINKS', 900) returning id into v_drinks;
  insert into menu_categories(name, sort_order) values ('VERIFY M2 FOOD', 901) returning id into v_food;
  insert into menu_products(name, category_id, is_addon) values ('Verify M2 Oat milk', v_drinks, true) returning id into v_oat;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_oat, '', 'Regular', 200);
  insert into menu_products(name, category_id, is_addon) values ('Verify M2 Syrup', v_drinks, true) returning id into v_syrup;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_syrup, '', 'Regular', 100);
  insert into modifier_groups(name, min_select, max_select) values ('Verify M2 Other', 0, 1) returning id into v_other_group;
  insert into modifier_options(group_id, name, price_delta_sen) values (v_other_group, 'Other', 0) returning id into v_other_opt;
  insert into menu_catalogs(name, sort_order) values ('VERIFY M2 Dine', 900) returning id into c_dine;
  insert into menu_catalogs(name, sort_order) values ('VERIFY M2 Take', 901) returning id into c_take;
  insert into menu_catalogs(name, sort_order) values ('VERIFY M2 QR', 902) returning id into c_qr;
  insert into menu_catalogs(name, sort_order, feedme_catalog_name) values ('VERIFY M2 Grab', 903, 'VERIFY M2 Feedme Grab')
    returning id into c_grab;
  insert into branch_catalogs(branch_id, role, catalog_id) values
    (v_branch, 'dine_in', c_dine), (v_branch, 'takeaway', c_take), (v_branch, 'qr', c_qr), (v_branch, 'additional', c_grab);
  -- staff are inserted as 'staff' and promoted by the owner (the staff guard refuses anything else)
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  insert into auth.users (id) values (v_mgr), (v_cashier), (v_boss);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_mgr,     'Verify M2 Manager', 'trainee', true, current_date, 'staff', v_branch),
    (v_cashier, 'Verify M2 Cashier', 'trainee', true, current_date, 'staff', v_branch),
    (v_boss,    'Verify M2 Boss',    'trainee', true, current_date, 'staff', v_branch);
  update staff set system_role = 'manager' where id = v_mgr;
  update staff set system_role = 'owner' where id = v_boss;
  update staff set branch_id = v_branch where id = v_owner;
  if not staff_has_cap(v_owner, 'manage_menu') then raise exception 'FAIL fixture: the test login (owner) lacks manage_menu'; end if;

  -- ── C. menu_save_product: a new product with two variants in three catalogs ─
  v_p := jsonb_build_object(
    'id', null, 'name', '  Verify   M2 Latte ', 'internalName', ' latte ', 'description', null,
    'categoryId', v_drinks, 'sstRateBp', 600, 'printRoute', 'Bar', 'takeawayFeeSen', 50, 'isActive', true, 'isAddon', false,
    'variants', jsonb_build_array(
      jsonb_build_object('ref', 'h', 'id', null, 'name', 'Hot', 'priceSen', 1200, 'isActive', true),
      jsonb_build_object('ref', 'c', 'id', null, 'name', 'Cold', 'priceSen', 1300, 'isActive', true)),
    'groupIds', '[]'::jsonb,
    'catalogs', jsonb_build_array(
      jsonb_build_object('catalogId', c_dine, 'availability', 'all', 'prices', jsonb_build_array(
        jsonb_build_object('ref', 'h', 'priceSen', 1210), jsonb_build_object('ref', 'c', 'priceSen', 1310))),
      jsonb_build_object('catalogId', c_grab, 'availability', 'counter_only', 'prices', jsonb_build_array(
        jsonb_build_object('ref', 'h', 'priceSen', 1700), jsonb_build_object('ref', 'c', 'priceSen', 1800))),
      jsonb_build_object('catalogId', c_qr, 'availability', 'all', 'prices', jsonb_build_array(
        jsonb_build_object('ref', 'h', 'priceSen', 1500), jsonb_build_object('ref', 'c', 'priceSen', 1600))),
      jsonb_build_object('catalogId', c_take, 'availability', 'hidden', 'prices', '[]'::jsonb)));
  -- C1. every refusal leaves nothing behind, and says why in the editor's words
  select count(*) into n from menu_products;
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', '[]'), 'Invalid product', 'C1 not an object');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{name}', '"   "')),
    'Product name is required', 'C1 blank name');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{name}', to_jsonb(repeat('x', 121)))),
    'Product name is too long (at most 120 characters)', 'C1 long name');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{categoryId}', 'null')),
    'Choose a category', 'C1 no category');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{categoryId}', to_jsonb(gen_random_uuid()))),
    'Choose a category', 'C1 unknown category');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{sstRateBp}', '10001')),
    'Invalid SST rate', 'C1 SST');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{isActive}', '"yes"')),
    'Invalid product', 'C1 on/off not a boolean');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{takeawayFeeSen}', '-1')),
    'Invalid takeaway fee', 'C1 takeaway fee');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)',
      jsonb_set(jsonb_set(v_p, '{variants,0,isActive}', 'false'), '{variants,1,isActive}', 'false')),
    'A product needs at least one active variant', 'C1 no active variant');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{variants}', '[]')),
    'A product needs at least one active variant', 'C1 no variant');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{variants,1,name}', '" hot"')),
    'Two variants are called Hot', 'C1 twin variants');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{variants,0,name}', '""')),
    'Variant name is required', 'C1 blank variant');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{variants,0,priceSen}', '12.5')),
    'Invalid default price for Hot', 'C1 fractional sen');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{variants,0,priceSen}', '-100')),
    'Invalid default price for Hot', 'C1 negative price');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{variants,0,priceSen}', '"12"')),
    'Invalid default price for Hot', 'C1 price as text');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{variants,1,ref}', '"h"')),
    'Invalid product', 'C1 ref twice');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{variants,0,id}', to_jsonb(v_other_opt))),
    'Variant not found — refresh and try again', 'C1 variant id on a new product');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)',
      jsonb_set(v_p, '{catalogs,0,prices}', '[{"ref": "h", "priceSen": 1210}]')),
    'VERIFY M2 Dine: enter a price for Cold', 'C1 missing catalog price');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{catalogs,0,prices,0,priceSen}', '-5')),
    'VERIFY M2 Dine: invalid price for Hot', 'C1 negative catalog price');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{catalogs,0,prices,1,ref}', '"h"')),
    'Invalid product', 'C1 a variant priced twice');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{catalogs,0,prices,1,ref}', '"zz"')),
    'Invalid product', 'C1 a price for no variant');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{catalogs,0,catalogId}', to_jsonb(gen_random_uuid()))),
    'Catalog not found — refresh and try again', 'C1 unknown catalog');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{catalogs,1,catalogId}', to_jsonb(c_dine))),
    'Invalid product', 'C1 a catalog twice');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{catalogs,0,availability}', '"sometimes"')),
    'Invalid availability', 'C1 availability');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{groupIds}', jsonb_build_array(gen_random_uuid()))),
    'Add-on group not found — refresh and try again', 'C1 unknown group');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{groupIds}', jsonb_build_array(v_other_group, v_other_group))),
    'An add-on group is linked twice', 'C1 group twice');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p, '{id}', to_jsonb(gen_random_uuid()))),
    'Product not found — refresh and try again', 'C1 unknown product');
  if (select count(*) from menu_products) <> n then raise exception 'FAIL C1: a refused save left a product behind'; end if;

  -- C2. the save: one product, two keyed variants in order, three catalogs (the hidden one gets no row)
  v_latte := menu_save_product(v_p);
  if (select name || '|' || internal_name || '|' || print_route || '|' || takeaway_fee_sen || '|' || sst_rate_bp
        from menu_products where id = v_latte) is distinct from 'Verify M2 Latte|latte|Bar|50|600' then
    raise exception 'FAIL C2: the product was not saved as given (names are trimmed)';
  end if;
  select id into v_hot from menu_variants where product_id = v_latte and name = 'Hot';
  select id into v_cold from menu_variants where product_id = v_latte and name = 'Cold';
  if (select string_agg(name || ':' || price_sen || ':' || sort_order, ',' order by sort_order) from menu_variants where product_id = v_latte)
     is distinct from 'Hot:1200:0,Cold:1300:1' then
    raise exception 'FAIL C2: variants not saved in order with their default prices';
  end if;
  if exists (select 1 from menu_variants where product_id = v_latte and feedme_variant_key not like 'cos-%')
     or (select count(distinct feedme_variant_key) from menu_variants where product_id = v_latte) <> 2 then
    raise exception 'FAIL C2: a product sold in two variants must key both cos-… (tickets name each)';
  end if;
  if (select string_agg(m.name || '=' || cp.availability, ',' order by m.sort_order)
        from catalog_products cp join menu_catalogs m on m.id = cp.catalog_id where cp.product_id = v_latte)
     is distinct from 'VERIFY M2 Dine=all,VERIFY M2 QR=all,VERIFY M2 Grab=counter_only' then
    raise exception 'FAIL C2: catalog rows %', (select string_agg(catalog_id::text, ',') from catalog_products where product_id = v_latte);
  end if;
  if (select price_sen from catalog_variant_prices where catalog_id = c_dine and variant_id = v_hot) <> 1210
     or (select price_sen from catalog_variant_prices where catalog_id = c_grab and variant_id = v_cold) <> 1800 then
    raise exception 'FAIL C2: catalog prices not saved';
  end if;
  -- C3. the editor reads it back: every catalog listed, hidden where it does not sell it
  v_res := menu_product_detail(v_latte);
  if jsonb_array_length(v_res->'catalogs') <> (select count(*) from menu_catalogs)
     or (select c->>'availability' from jsonb_array_elements(v_res->'catalogs') c where c->>'catalogId' = c_take::text) <> 'hidden'
     or (select (c->'prices'->>v_hot::text)::int from jsonb_array_elements(v_res->'catalogs') c where c->>'catalogId' = c_dine::text) <> 1210
     or v_res->'variants'->0->>'name' <> 'Hot' or v_res->>'categoryId' <> v_drinks::text then
    raise exception 'FAIL C3: menu_product_detail %', v_res;
  end if;
  perform pg_temp.expect_error(format('select menu_product_detail(%L)', gen_random_uuid()), 'Product not found', 'C3 unknown product');

  -- C4. one variant → the base ('') key; a second one later → both keyed, the base too
  v_toast := menu_save_product(jsonb_build_object(
    'id', null, 'name', 'Verify M2 Toast', 'categoryId', v_food, 'sstRateBp', 0, 'printRoute', null, 'takeawayFeeSen', 0,
    'isActive', true, 'isAddon', false, 'groupIds', '[]'::jsonb,
    'variants', jsonb_build_array(jsonb_build_object('ref', 'r', 'name', 'Regular', 'priceSen', 800, 'isActive', true)),
    'catalogs', jsonb_build_array(jsonb_build_object('catalogId', c_dine, 'availability', 'all',
                                                     'prices', '[{"ref": "r", "priceSen": 810}]'::jsonb))));
  select id into v_reg from menu_variants where product_id = v_toast;
  if (select feedme_variant_key from menu_variants where id = v_reg) <> '' then
    raise exception 'FAIL C4: a new single-variant product must use the base key';
  end if;
  v_p2 := jsonb_build_object(
    'id', v_toast, 'name', 'Verify M2 Toast', 'categoryId', v_food, 'sstRateBp', 0, 'printRoute', null, 'takeawayFeeSen', 0,
    'isActive', true, 'isAddon', false, 'groupIds', '[]'::jsonb,
    'variants', jsonb_build_array(
      jsonb_build_object('ref', v_reg, 'id', v_reg, 'name', 'Regular', 'priceSen', 800, 'isActive', true),
      jsonb_build_object('ref', 'l', 'id', null, 'name', 'Large', 'priceSen', 1000, 'isActive', true)),
    'catalogs', '[]'::jsonb);
  -- a catalog left out of the payload still needs the new variant's price (it already sells the toast)
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', v_p2),
    'VERIFY M2 Dine: enter a price for Large', 'C4 a catalog not in the payload');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p2, '{variants}', v_p2->'variants'->1 || '[]'::jsonb)),
    'The product changed since you opened it — refresh and try again', 'C4 a variant left out');
  perform pg_temp.expect_error(format('select menu_save_product(%L::jsonb)', jsonb_set(v_p2, '{variants,1,id}', to_jsonb(v_hot))),
    'Variant not found — refresh and try again', 'C4 another product''s variant');
  perform menu_save_product(jsonb_set(v_p2, '{catalogs}', jsonb_build_array(jsonb_build_object('catalogId', c_dine, 'availability', 'all',
    'prices', jsonb_build_array(jsonb_build_object('ref', v_reg, 'priceSen', 810), jsonb_build_object('ref', 'l', 'priceSen', 1050))))));
  select id into v_large from menu_variants where product_id = v_toast and name = 'Large';
  if exists (select 1 from menu_variants where product_id = v_toast and feedme_variant_key = '') then
    raise exception 'FAIL C4: a product with two active variants still has a base variant';
  end if;
  if (select price_sen from catalog_variant_prices where catalog_id = c_dine and variant_id = v_large) <> 1050 then
    raise exception 'FAIL C4: the new variant''s catalog price was not saved';
  end if;

  -- ── D. an edit prices the next order; orders already placed keep their snapshot ─
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  v_old_order := place_counter_order(v_t1.id, 'dine_in', 2,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid());
  v_order := place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid(), c_grab);
  if (select unit_price_sen from order_items where order_id = v_old_order) <> 1210
     or (select unit_price_sen from order_items where order_id = v_order) <> 1700
     or (select name_snapshot from order_items where order_id = v_order) <> 'Verify M2 Latte (Hot)' then
    raise exception 'FAIL D: Dine and Grab prices of the new product (1210 / 1700)';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_p := jsonb_set(jsonb_set(v_p, '{id}', to_jsonb(v_latte)), '{variants}', jsonb_build_array(
    jsonb_build_object('ref', v_hot, 'id', v_hot, 'name', 'Hot', 'priceSen', 1200, 'isActive', true),
    jsonb_build_object('ref', v_cold, 'id', v_cold, 'name', 'Cold', 'priceSen', 1300, 'isActive', true)));
  v_p := jsonb_set(v_p, '{catalogs}', jsonb_build_array(
    jsonb_build_object('catalogId', c_dine, 'availability', 'all', 'prices', jsonb_build_array(
      jsonb_build_object('ref', v_hot, 'priceSen', 1250), jsonb_build_object('ref', v_cold, 'priceSen', 1310))),
    jsonb_build_object('catalogId', c_grab, 'availability', 'counter_only', 'prices', jsonb_build_array(
      jsonb_build_object('ref', v_hot, 'priceSen', 1700), jsonb_build_object('ref', v_cold, 'priceSen', 1800))),
    jsonb_build_object('catalogId', c_qr, 'availability', 'all', 'prices', jsonb_build_array(
      jsonb_build_object('ref', v_hot, 'priceSen', 1500), jsonb_build_object('ref', v_cold, 'priceSen', 1600)))));
  perform menu_save_product(v_p);
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  v_order := place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid());
  if (select unit_price_sen from order_items where order_id = v_order) <> 1250 then
    raise exception 'FAIL D: an order after the edit is not at the new price';
  end if;
  if (select unit_price_sen from order_items where order_id = v_old_order) <> 1210 then
    raise exception 'FAIL D: an order placed before the edit changed price';
  end if;
  -- D2. a switched-off variant stops selling; its row and catalog price stay
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform menu_save_product(jsonb_set(v_p, '{variants,1,isActive}', 'false'));
  if not exists (select 1 from menu_variants where id = v_cold and not is_active)
     or not exists (select 1 from catalog_variant_prices where catalog_id = c_dine and variant_id = v_cold) then
    raise exception 'FAIL D2: switching a variant off must keep it and its prices';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  perform pg_temp.expect_error(format('select place_counter_order(%L, %L, null, %L::jsonb, %L)', v_t1.id, 'dine_in',
      jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_cold)), gen_random_uuid()),
    'Item is not available: Verify M2 Latte', 'D2 a switched-off variant');
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform menu_save_product(v_p);                                             -- Cold back on

  -- ── E. add-on groups ──────────────────────────────────────────────────────
  v_g := jsonb_build_object('id', null, 'name', ' Verify M2 Milk ', 'min', 0, 'max', 1, 'stackable', false, 'isActive', true,
    'options', jsonb_build_array(
      jsonb_build_object('ref', 'o', 'id', null, 'name', 'Oat', 'priceDeltaSen', 200, 'productId', v_oat, 'isDefault', false, 'availability', 'all'),
      jsonb_build_object('ref', 's', 'id', null, 'name', 'Soy', 'priceDeltaSen', 150, 'productId', null, 'isDefault', false, 'availability', 'all')),
    'catalogPrices', jsonb_build_array(jsonb_build_object('catalogId', c_grab, 'ref', 'o', 'priceDeltaSen', 300)));
  -- E1. refusals
  select count(*) into n from modifier_groups;
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', '"x"'), 'Invalid add-on group', 'E1 not an object');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{name}', '""')),
    'Add-on group name is required', 'E1 blank name');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(jsonb_set(v_g, '{min}', '2'), '{max}', '1')),
    'Min cannot be more than max', 'E1 min > max');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{max}', '0')),
    'Max must be a whole number from 1 to 99', 'E1 max 0');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{min}', '-1')),
    'Min must be a whole number from 0 to 99', 'E1 min -1');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(jsonb_set(v_g, '{min}', '100'), '{max}', '100')),
    'Min must be a whole number from 0 to 99', 'E1 min 100');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{min}', '0.5')),
    'Min must be a whole number from 0 to 99', 'E1 min 0.5');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(jsonb_set(v_g, '{min}', '3'), '{max}', '3')),
    'Min is 3 but only 2 options are on', 'E1 min above the options that are on');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)',
      jsonb_set(jsonb_set(jsonb_set(v_g, '{min}', '2'), '{max}', '2'), '{options,1,availability}', '"hidden"')),
    'Min is 2 but only 1 option is on', 'E1 min above the one option that is on');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)',
      jsonb_set(jsonb_set(v_g, '{options,1,availability}', '"hidden"'), '{options,1,isDefault}', 'true')),
    'A switched-off option cannot be the default: Soy', 'E1 hidden default');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)',
      jsonb_set(jsonb_set(v_g, '{options,0,isDefault}', 'true'), '{options,1,isDefault}', 'true')),
    'At most 1 option can be the default', 'E1 two defaults, max 1');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{options,1,name}', '"  "')),
    'Option name is required', 'E1 blank option');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{options,1,priceDeltaSen}', '1.5')),
    'Invalid price for Soy', 'E1 option price');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{options,1,productId}', to_jsonb(v_oat))),
    'Two options use the same add-on item: Verify M2 Oat milk', 'E1 one add-on item twice');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{options,1,productId}', to_jsonb(gen_random_uuid()))),
    'Add-on item not found — refresh and try again', 'E1 unknown add-on item');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{options,1,availability}', '"never"')),
    'Invalid availability', 'E1 availability');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{options,1,id}', to_jsonb(v_other_opt))),
    'Option not found — refresh and try again', 'E1 option id on a new group');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{catalogPrices,0,catalogId}', to_jsonb(gen_random_uuid()))),
    'Catalog not found — refresh and try again', 'E1 unknown catalog');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{catalogPrices,0,priceDeltaSen}', '-1')),
    'VERIFY M2 Grab: invalid price for Oat', 'E1 negative catalog price');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{catalogPrices,0,ref}', '"zz"')),
    'Invalid add-on group', 'E1 a price for no option');
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{id}', to_jsonb(gen_random_uuid()))),
    'Add-on group not found — refresh and try again', 'E1 unknown group');
  if (select count(*) from modifier_groups) <> n then raise exception 'FAIL E1: a refused save left a group behind'; end if;
  -- E2. the save, linked to the latte, and an override that only Grab charges
  v_milk := menu_save_group(v_g);
  select id into v_opt_oat from modifier_options where group_id = v_milk and name = 'Oat';
  select id into v_opt_soy from modifier_options where group_id = v_milk and name = 'Soy';
  if (select name from modifier_groups where id = v_milk) <> 'Verify M2 Milk'
     or (select string_agg(name || ':' || sort_order, ',' order by sort_order) from modifier_options where group_id = v_milk) <> 'Oat:0,Soy:1'
     or (select price_delta_sen from catalog_option_prices where catalog_id = c_grab and option_id = v_opt_oat) <> 300 then
    raise exception 'FAIL E2: group, options or override not saved';
  end if;
  perform menu_save_product(jsonb_set(v_p, '{groupIds}', jsonb_build_array(v_milk)));
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  v_order := place_counter_order(v_t1.id, 'dine_in', null, jsonb_build_array(jsonb_build_object(
    'productId', v_latte, 'variantId', v_hot, 'optionIds', jsonb_build_array(v_opt_oat))), gen_random_uuid(), c_grab);
  v_order2 := place_counter_order(v_t1.id, 'dine_in', null, jsonb_build_array(jsonb_build_object(
    'productId', v_latte, 'variantId', v_hot, 'optionIds', jsonb_build_array(v_opt_soy))), gen_random_uuid());
  if (select unit_price_sen from order_items where order_id = v_order) <> 2000
     or (select unit_price_sen from order_items where order_id = v_order2) <> 1400 then
    raise exception 'FAIL E2: Grab charges its Oat override (1700 + 300), Dine the default Soy (1250 + 150)';
  end if;
  -- E3. Soy switched off: the row stays, the pad and QR stop offering it, an old order still shows it
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_g := jsonb_build_object('id', v_milk, 'name', 'Verify M2 Milk', 'min', 0, 'max', 1, 'stackable', false, 'isActive', true,
    'options', jsonb_build_array(
      jsonb_build_object('ref', v_opt_oat, 'id', v_opt_oat, 'name', 'Oat', 'priceDeltaSen', 200, 'productId', v_oat, 'isDefault', false, 'availability', 'all'),
      jsonb_build_object('ref', v_opt_soy, 'id', v_opt_soy, 'name', 'Soy', 'priceDeltaSen', 150, 'productId', null, 'isDefault', false, 'availability', 'hidden')),
    'catalogPrices', jsonb_build_array(jsonb_build_object('catalogId', c_grab, 'ref', v_opt_oat, 'priceDeltaSen', 300)));
  perform pg_temp.expect_error(format('select menu_save_group(%L::jsonb)', jsonb_set(v_g, '{options}', v_g->'options'->0 || '[]'::jsonb)),
    'The add-on group changed since you opened it — refresh and try again', 'E3 an option left out');
  perform menu_save_group(v_g);
  if not exists (select 1 from modifier_options where id = v_opt_soy and availability = 'hidden') then
    raise exception 'FAIL E3: switching an option off must keep it';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  perform pg_temp.expect_error(format('select place_counter_order(%L, %L, null, %L::jsonb, %L)', v_t1.id, 'dine_in',
      jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot, 'optionIds', jsonb_build_array(v_opt_soy))),
      gen_random_uuid()),
    'Sold out: Soy', 'E3 ordering a switched-off option');
  if (select modifiers_snapshot->0->>'name' from order_items where order_id = v_order2) <> 'Soy' then
    raise exception 'FAIL E3: the old order lost its add-on snapshot';
  end if;
  if exists (select 1 from jsonb_array_elements(qr_menu(v_t1.qr_token)->'categories') c
               cross join jsonb_array_elements(c->'products') pr cross join jsonb_array_elements(pr->'groups') g
               cross join jsonb_array_elements(g->'options') o
              where o->>'id' = v_opt_soy::text) then
    raise exception 'FAIL E3: QR still offers a switched-off option';
  end if;
  if (select o->>'availability' from jsonb_array_elements(pos_menu_rows(c_dine)->'groups') g
        cross join jsonb_array_elements(g->'modifier_options') o where o->>'id' = v_opt_soy::text) <> 'hidden' then
    raise exception 'FAIL E3: the pad''s rows must carry the option as hidden (buildPosMenu drops it)';
  end if;
  -- E4. an override no longer listed is removed: Grab charges Oat's own price again
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform menu_save_group(jsonb_set(v_g, '{catalogPrices}', '[]'));
  if exists (select 1 from catalog_option_prices where option_id = v_opt_oat) then
    raise exception 'FAIL E4: a removed override is still there';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  v_order := place_counter_order(v_t1.id, 'dine_in', null, jsonb_build_array(jsonb_build_object(
    'productId', v_latte, 'variantId', v_hot, 'optionIds', jsonb_build_array(v_opt_oat))), gen_random_uuid(), c_grab);
  if (select unit_price_sen from order_items where order_id = v_order) <> 1900 then
    raise exception 'FAIL E4: Grab must charge the default Oat price once its override is gone';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  -- E5. the editor reads it back
  v_res := menu_group_detail(v_milk);
  if v_res->'options'->1->>'availability' <> 'hidden' or v_res->'options'->0->>'productId' <> v_oat::text
     or not exists (select 1 from jsonb_array_elements(v_res->'usedBy') u where u->>'id' = v_latte::text) then
    raise exception 'FAIL E5: menu_group_detail %', v_res;
  end if;
  perform pg_temp.expect_error(format('select menu_group_detail(%L)', gen_random_uuid()), 'Add-on group not found', 'E5 unknown group');

  -- ── F. catalogs ───────────────────────────────────────────────────────────
  c_new := menu_save_catalog(null, ' VERIFY M2  New ');
  if (select name from menu_catalogs where id = c_new) <> 'VERIFY M2 New'
     or (select sort_order from menu_catalogs where id = c_new) <> (select max(sort_order) from menu_catalogs) then
    raise exception 'FAIL F1: a new catalog is named as typed (trimmed) and goes last';
  end if;
  perform pg_temp.expect_error(format('select menu_save_catalog(null, %L)', 'verify m2 new'),
    'A catalog called verify m2 new already exists', 'F1 duplicate name');
  perform pg_temp.expect_error(format('select menu_save_catalog(null, %L)', '  '), 'Catalog name is required', 'F1 blank');
  -- a pasted no-break space or tab is a space like any other: it cannot hide a duplicate or survive at the ends
  perform pg_temp.expect_error(format('select menu_save_catalog(null, %L)', E'\u00a0verify\tm2\u00a0\u00a0new\t'),
    'A catalog called verify m2 new already exists', 'F1 duplicate with NBSP and tab');
  perform pg_temp.expect_error(format('select menu_save_catalog(null, %L)', E'\u00a0\t\u3000'), 'Catalog name is required', 'F1 blank NBSP');
  if menu_clean_name(E'\u00a0\tVERIFY\u00a0 M2\t\tNew\n', 'Catalog', 60) <> 'VERIFY M2 New' then
    raise exception 'FAIL F1: menu_clean_name must turn NBSP, tab and newline into single spaces and trim them';
  end if;
  perform pg_temp.expect_error(format('select menu_save_catalog(null, %L)', repeat('x', 61)),
    'Catalog name is too long (at most 60 characters)', 'F1 long');
  perform menu_save_catalog(c_new, 'VERIFY M2 Renamed');
  perform menu_save_catalog(c_new, 'verify m2 renamed');                     -- its own name in other letters is fine
  perform pg_temp.expect_error(format('select menu_save_catalog(%L, %L)', gen_random_uuid(), 'VERIFY M2 Ghost'),
    'Catalog not found — refresh and try again', 'F1 rename unknown');
  -- F2. duplicate: products (hidden ones too), prices and add-on overrides; no Feedme name, no branch
  insert into catalog_option_prices(catalog_id, option_id, price_delta_sen) values (c_grab, v_opt_oat, 250);
  c_copy := menu_duplicate_catalog(c_grab, 'VERIFY M2 Grab copy');
  if (select count(*) from catalog_products where catalog_id = c_copy) <> (select count(*) from catalog_products where catalog_id = c_grab)
     or (select count(*) from catalog_variant_prices where catalog_id = c_copy) <> (select count(*) from catalog_variant_prices where catalog_id = c_grab)
     or (select price_delta_sen from catalog_option_prices where catalog_id = c_copy and option_id = v_opt_oat) <> 250
     or (select availability from catalog_products where catalog_id = c_copy and product_id = v_latte) <> 'counter_only'
     or (select feedme_catalog_name from menu_catalogs where id = c_copy) is not null
     or not (select is_active from menu_catalogs where id = c_copy)
     or exists (select 1 from branch_catalogs where catalog_id = c_copy) then
    raise exception 'FAIL F2: the duplicate is not a full, unassigned copy';
  end if;
  perform pg_temp.expect_error(format('select menu_duplicate_catalog(%L, %L)', gen_random_uuid(), 'VERIFY M2 X'),
    'Catalog not found — refresh and try again', 'F2 unknown source');
  perform pg_temp.expect_error(format('select menu_duplicate_catalog(%L, %L)', c_grab, 'VERIFY M2 Dine'),
    'A catalog called VERIFY M2 Dine already exists', 'F2 name taken');
  -- F3. reorder: every catalog exactly once
  select array_agg(id order by sort_order desc, name desc) into v_ids from menu_catalogs;
  perform menu_reorder_catalogs(v_ids);
  if exists (select 1 from unnest(v_ids) with ordinality x(id, ord) join menu_catalogs m on m.id = x.id where m.sort_order <> x.ord - 1) then
    raise exception 'FAIL F3: catalogs not in the new order';
  end if;
  perform pg_temp.expect_error(format('select menu_reorder_catalogs(%L::uuid[])', v_ids[2:]),
    'The catalog list changed — refresh and try again', 'F3 one missing');
  perform pg_temp.expect_error(format('select menu_reorder_catalogs(%L::uuid[])', v_ids[2:] || v_ids[2]),
    'The catalog list changed — refresh and try again', 'F3 one twice');
  -- F4. switching off: not a branch's default; an additional one stops selling at the counter
  perform pg_temp.expect_error(format('select menu_set_catalog_active(%L, false)', c_dine),
    'VERIFY M2 Dine is the dine-in catalog of VERIFY M2 — choose another in POS settings first', 'F4 a default');
  perform menu_set_catalog_active(c_grab, false);
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  perform pg_temp.expect_error(format('select place_counter_order(null, %L, null, %L::jsonb, %L, %L)', 'takeaway',
      jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid(), c_grab),
    'This catalog is not available at this branch', 'F4 a switched-off catalog');
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  perform menu_set_catalog_active(c_grab, true);
  perform pg_temp.expect_error(format('select menu_set_catalog_active(%L, true)', gen_random_uuid()),
    'Catalog not found — refresh and try again', 'F4 unknown');
  -- F5. the catalog page: every active non-add-on product, with its availability and both prices
  v_res := menu_catalog_grid(c_grab);
  if (select pr->>'availability' from jsonb_array_elements(v_res->'products') pr where pr->>'id' = v_latte::text) <> 'counter_only'
     or (select (v->>'priceSen')::int from jsonb_array_elements(v_res->'products') pr cross join jsonb_array_elements(pr->'variants') v
          where v->>'id' = v_hot::text) <> 1700
     or (select (v->>'defaultSen')::int from jsonb_array_elements(v_res->'products') pr cross join jsonb_array_elements(pr->'variants') v
          where v->>'id' = v_hot::text) <> 1200
     or (select pr->>'availability' from jsonb_array_elements(v_res->'products') pr where pr->>'id' = v_toast::text) <> 'hidden'
     or (select v->>'priceSen' from jsonb_array_elements(v_res->'products') pr cross join jsonb_array_elements(pr->'variants') v
          where v->>'id' = v_large::text) is not null
     or exists (select 1 from jsonb_array_elements(v_res->'products') pr where pr->>'id' = v_oat::text) then
    raise exception 'FAIL F5: menu_catalog_grid %', v_res;
  end if;
  -- F6. one row saved: in with a price for every active variant, out keeps the row
  v_p2 := jsonb_build_object('catalogId', c_grab, 'productId', v_toast, 'availability', 'all', 'prices', jsonb_build_array(
    jsonb_build_object('variantId', v_reg, 'priceSen', 900), jsonb_build_object('variantId', v_large, 'priceSen', 1100)));
  perform pg_temp.expect_error(format('select menu_save_catalog_row(%L::jsonb)', jsonb_set(v_p2, '{prices}', v_p2->'prices'->0 || '[]'::jsonb)),
    'VERIFY M2 Grab: enter a price for Large', 'F6 a missing price');
  perform pg_temp.expect_error(format('select menu_save_catalog_row(%L::jsonb)', jsonb_set(v_p2, '{prices,0,priceSen}', '9.5')),
    'VERIFY M2 Grab: invalid price for Regular', 'F6 a bad price');
  perform pg_temp.expect_error(format('select menu_save_catalog_row(%L::jsonb)', jsonb_set(v_p2, '{prices,0,variantId}', to_jsonb(v_hot))),
    'Variant not found — refresh and try again', 'F6 another product''s variant');
  perform pg_temp.expect_error(format('select menu_save_catalog_row(%L::jsonb)', jsonb_set(v_p2, '{prices,1,variantId}', to_jsonb(v_reg))),
    'Invalid catalog row', 'F6 a variant twice');
  perform pg_temp.expect_error(format('select menu_save_catalog_row(%L::jsonb)', jsonb_set(v_p2, '{catalogId}', to_jsonb(gen_random_uuid()))),
    'Catalog not found — refresh and try again', 'F6 unknown catalog');
  perform pg_temp.expect_error(format('select menu_save_catalog_row(%L::jsonb)', jsonb_set(v_p2, '{productId}', to_jsonb(v_oat))),
    'Variant not found — refresh and try again', 'F6 prices of another product');
  perform pg_temp.expect_error(format('select menu_save_catalog_row(%L::jsonb)', jsonb_set(v_p2, '{productId}', to_jsonb(gen_random_uuid()))),
    'Product not found — refresh and try again', 'F6 unknown product');
  perform pg_temp.expect_error(format('select menu_save_catalog_row(%L::jsonb)', jsonb_set(v_p2, '{availability}', '"soon"')),
    'Invalid availability', 'F6 availability');
  perform menu_save_catalog_row(v_p2);
  if (select availability from catalog_products where catalog_id = c_grab and product_id = v_toast) <> 'all'
     or (select price_sen from catalog_variant_prices where catalog_id = c_grab and variant_id = v_large) <> 1100 then
    raise exception 'FAIL F6: the row was not saved';
  end if;
  perform menu_save_catalog_row(jsonb_set(jsonb_set(v_p2, '{availability}', '"hidden"'), '{prices}', '[]'));
  if (select availability from catalog_products where catalog_id = c_grab and product_id = v_toast) <> 'hidden'
     or not exists (select 1 from catalog_variant_prices where catalog_id = c_grab and variant_id = v_large) then
    raise exception 'FAIL F6: taking a product out must keep its row (hidden) and prices';
  end if;

  -- ── G. categories ─────────────────────────────────────────────────────────
  v_newcat := menu_save_category(null, 'VERIFY M2 NEW');
  if (select sort_order from menu_categories where id = v_newcat) <> (select max(sort_order) from menu_categories) then
    raise exception 'FAIL G1: a new category goes last';
  end if;
  perform pg_temp.expect_error(format('select menu_save_category(null, %L)', 'verify m2 drinks'),
    'A category called verify m2 drinks already exists', 'G1 duplicate');
  perform pg_temp.expect_error(format('select menu_save_category(null, %L)', ''), 'Category name is required', 'G1 blank');
  perform pg_temp.expect_error(format('select menu_save_category(null, %L)', E'\u00a0verify\tm2 drinks\u00a0'),
    'A category called verify m2 drinks already exists', 'G1 duplicate with NBSP and tab');
  perform menu_save_category(v_newcat, 'VERIFY M2 RENAMED');
  perform pg_temp.expect_error(format('select menu_save_category(%L, %L)', gen_random_uuid(), 'VERIFY M2 GHOST'),
    'Category not found — refresh and try again', 'G1 rename unknown');
  -- G2. reorder reaches the pad: FOOD before DRINKS
  select array_agg(id order by case id when v_food then 0 when v_drinks then 1 else 2 end, sort_order, name) into v_ids from menu_categories;
  perform menu_reorder_categories(v_ids);
  if (select sort_order from menu_categories where id = v_food) >= (select sort_order from menu_categories where id = v_drinks)
     or (select (pr->'category'->>'sort_order')::int from jsonb_array_elements(pos_menu_rows(c_dine)->'products') pr where pr->>'id' = v_toast::text)
        >= (select (pr->'category'->>'sort_order')::int from jsonb_array_elements(pos_menu_rows(c_dine)->'products') pr where pr->>'id' = v_latte::text) then
    raise exception 'FAIL G2: the new category order does not reach the pad''s rows';
  end if;
  perform pg_temp.expect_error(format('select menu_reorder_categories(%L::uuid[])', v_ids[2:]),
    'The category list changed — refresh and try again', 'G2 one missing');
  -- G3. switched off: its products leave the pad and QR, and come back
  perform menu_set_category_active(v_drinks, false);
  if exists (select 1 from jsonb_array_elements(pos_menu_rows(c_dine)->'products') pr where pr->>'id' = v_latte::text)
     or exists (select 1 from jsonb_array_elements(qr_menu(v_t1.qr_token)->'categories') c
                  cross join jsonb_array_elements(c->'products') pr where pr->>'id' = v_latte::text) then
    raise exception 'FAIL G3: a switched-off category''s product is still offered';
  end if;
  perform menu_set_category_active(v_drinks, true);
  if not exists (select 1 from jsonb_array_elements(pos_menu_rows(c_dine)->'products') pr where pr->>'id' = v_latte::text)
     or not exists (select 1 from jsonb_array_elements(qr_menu(v_t1.qr_token)->'categories') c
                      cross join jsonb_array_elements(c->'products') pr where pr->>'id' = v_latte::text) then
    raise exception 'FAIL G3: switching the category back on did not bring the product back';
  end if;
  perform pg_temp.expect_error(format('select menu_set_category_active(%L, false)', gen_random_uuid()),
    'Category not found — refresh and try again', 'G3 unknown');

  -- ── H. the pad's rows ─────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  insert into branch_menu_status(branch_id, product_id, is_sold_out) values (v_branch, v_toast, true);
  set local role authenticated;
  v_res := pos_menu_rows(c_dine);
  reset role;
  if not exists (select 1 from jsonb_array_elements(v_res->'links') l where l->>'product_id' = v_latte::text and l->>'group_id' = v_milk::text)
     or (select (x->>'price_sen')::int from jsonb_array_elements(v_res->'catalog'->'prices') x where x->>'variant_id' = v_hot::text) <> 1250
     or not exists (select 1 from jsonb_array_elements(v_res->'soldOut') s where s->>'product_id' = v_toast::text)
     or exists (select 1 from jsonb_array_elements(v_res->'products') pr where pr->>'id' = v_oat::text)
     or not exists (select 1 from jsonb_array_elements(v_res->'catalog'->'products') x
                     where x->>'product_id' = v_latte::text and x->>'availability' = 'all') then
    raise exception 'FAIL H: pos_menu_rows %', v_res;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  perform pg_temp.expect_error(format('select pos_menu_rows(%L)', c_dine), 'Your account is not active', 'H not staff');

  -- ── I. what the list pages read ───────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_res := menu_editor_lookups();
  if not exists (select 1 from jsonb_array_elements(v_res->'catalogs') c, jsonb_array_elements(c->'uses') u
                  where c->>'id' = c_dine::text and u->>'branch' = 'VERIFY M2' and u->>'role' = 'dine_in')
     or (select (c->>'productCount')::int from jsonb_array_elements(v_res->'categories') c where c->>'id' = v_drinks::text) <> 1   -- the latte; add-on items are not counted
     or (select (g->>'optionCount')::int from jsonb_array_elements(v_res->'groups') g where g->>'id' = v_milk::text) <> 1
     or (select (g->>'productCount')::int from jsonb_array_elements(v_res->'groups') g where g->>'id' = v_milk::text) <> 1
     or not exists (select 1 from jsonb_array_elements(v_res->'addOns') a where a->>'id' = v_oat::text) then
    raise exception 'FAIL I: menu_editor_lookups %', v_res;
  end if;
  v_res := (select x from jsonb_array_elements(menu_product_list()) x where x->>'id' = v_latte::text);
  if v_res is null or not (v_res->'catalog_ids' @> jsonb_build_array(c_dine, c_grab, c_qr)) or v_res->'catalog_ids' @> jsonb_build_array(c_take)
     or v_res->>'category_id' <> v_drinks::text or jsonb_array_length(v_res->'menu_variants') <> 2 then
    raise exception 'FAIL I: menu_product_list %', v_res;
  end if;

  -- ── J. what the editor sends: only what changed, and what a re-import leaves behind ─
  -- J1. a save without detail keys keeps what the Products and catalog pages changed meanwhile
  update menu_products set sst_rate_bp = 0, print_route = 'Kitchen' where id = v_latte;   -- as the Products page does
  perform menu_save_catalog_row(jsonb_build_object('catalogId', c_grab, 'productId', v_latte, 'availability', 'counter_only',
    'prices', jsonb_build_array(jsonb_build_object('variantId', v_hot, 'priceSen', 1777), jsonb_build_object('variantId', v_cold, 'priceSen', 1800))));
  perform menu_save_product(jsonb_build_object('id', v_latte, 'name', 'Verify M2 Latte 2', 'variants', v_p->'variants',
    'groupIds', jsonb_build_array(v_milk), 'catalogs', '[]'::jsonb));
  if (select name || '|' || sst_rate_bp || '|' || print_route || '|' || category_id from menu_products where id = v_latte)
       is distinct from 'Verify M2 Latte 2|0|Kitchen|' || v_drinks
     or (select price_sen from catalog_variant_prices where catalog_id = c_grab and variant_id = v_hot) <> 1777 then
    raise exception 'FAIL J1: a save that left out details or a catalog changed them';
  end if;
  -- J2. a new product sold in one variant (another one off) gets the base key for it
  v_id := menu_save_product(jsonb_build_object(
    'id', null, 'name', 'Verify M2 Scone', 'categoryId', v_food, 'sstRateBp', 0, 'printRoute', null, 'takeawayFeeSen', 0,
    'isActive', true, 'isAddon', false, 'groupIds', '[]'::jsonb, 'catalogs', '[]'::jsonb,
    'variants', jsonb_build_array(jsonb_build_object('ref', 'r', 'name', 'Regular', 'priceSen', 600, 'isActive', true),
                                  jsonb_build_object('ref', 'x', 'name', 'Jumbo', 'priceSen', 900, 'isActive', false))));
  if (select feedme_variant_key from menu_variants where product_id = v_id and name = 'Regular') <> '' then
    raise exception 'FAIL J2: the one active variant of a new product must use the base key';
  end if;
  -- J3. a re-import can leave a catalog made here without a price: the lookups count it (Open point 7)
  insert into menu_products(name, category_id, feedme_product_id) values ('Verify M2 Bun', v_food, 'VERIFY-M2-FM-1') returning id into v_bun;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_bun, '', 'Regular', 500) returning id into v_bun_reg;
  perform menu_save_catalog_row(jsonb_build_object('catalogId', c_new, 'productId', v_bun, 'availability', 'all',
    'prices', jsonb_build_array(jsonb_build_object('variantId', v_bun_reg, 'priceSen', 550))));
  perform menu_save_product(jsonb_build_object('id', v_bun, 'groupIds', '[]'::jsonb,
    'variants', jsonb_build_array(jsonb_build_object('ref', v_bun_reg, 'id', v_bun_reg, 'name', 'Regular', 'priceSen', 500, 'isActive', true),
                                  jsonb_build_object('ref', 'l', 'name', 'Large', 'priceSen', 600, 'isActive', true)),
    'catalogs', jsonb_build_array(jsonb_build_object('catalogId', c_new, 'availability', 'all', 'prices', jsonb_build_array(
      jsonb_build_object('ref', v_bun_reg, 'priceSen', 550), jsonb_build_object('ref', 'l', 'priceSen', 650))))));
  if (select (c->>'unpricedCount')::int from jsonb_array_elements(menu_editor_lookups()->'catalogs') c where c->>'id' = c_new::text) <> 0 then
    raise exception 'FAIL J3: a fully priced catalog reports unpriced products';
  end if;
  perform menu_import_catalogs(jsonb_build_object(
    'categories', jsonb_build_array(jsonb_build_object('name', 'VERIFY M2 FOOD', 'sortOrder', 901)),
    'products', jsonb_build_array(jsonb_build_object('feedmeId', 'VERIFY-M2-FM-1', 'name', 'Verify M2 Bun', 'internalName', null,
      'description', null, 'category', 'VERIFY M2 FOOD', 'availability', 'all', 'isAddon', false, 'takeawayFeeSen', 0, 'sortOrder', 0,
      'variants', jsonb_build_array(jsonb_build_object('key', '', 'name', 'Regular', 'priceSen', 500, 'sortOrder', 0)))),
    'groups', '[]'::jsonb, 'links', '[]'::jsonb, 'catalogs', '[]'::jsonb));
  if (select count(*) from menu_variants where product_id = v_bun and is_active) <> 1
     or (select (c->>'unpricedCount')::int from jsonb_array_elements(menu_editor_lookups()->'catalogs') c where c->>'id' = c_new::text) <> 1 then
    raise exception 'FAIL J3: after a re-import the catalog made here should report one unpriced product';
  end if;

  -- ── K. Edit menu for every editor function: manager refused, owner allowed, resigned owner refused ─
  update staff set status = 'resigned' where id = v_boss;                    -- is_active stays true, as in real life
  select array_agg(id order by sort_order, name) into v_ids from menu_catalogs;
  for r in select * from (values (v_mgr, false, 'manager'), (v_owner, true, 'owner'), (v_boss, false, 'resigned owner'))
                          as x(who, allowed, label) loop
    perform set_config('request.jwt.claims', json_build_object('sub', r.who, 'role', 'authenticated')::text, true);
    set local role authenticated;
    begin perform menu_editor_lookups();
      if not r.allowed then raise exception 'FAIL K %: menu_editor_lookups', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_product_list();
      if not r.allowed then raise exception 'FAIL K %: menu_product_list', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_product_detail(v_latte);
      if not r.allowed then raise exception 'FAIL K %: menu_product_detail', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_save_product(v_p);
      if not r.allowed then raise exception 'FAIL K %: menu_save_product', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_group_detail(v_milk);
      if not r.allowed then raise exception 'FAIL K %: menu_group_detail', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_save_group(v_g);
      if not r.allowed then raise exception 'FAIL K %: menu_save_group', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_save_catalog(c_new, 'VERIFY M2 Renamed');
      if not r.allowed then raise exception 'FAIL K %: menu_save_catalog', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_duplicate_catalog(c_new, 'VERIFY M2 copy by ' || r.label);
      if not r.allowed then raise exception 'FAIL K %: menu_duplicate_catalog', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_reorder_catalogs(v_ids || (select array_agg(id) from menu_catalogs where name like 'VERIFY M2 copy by %'));
      if not r.allowed then raise exception 'FAIL K %: menu_reorder_catalogs', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_set_catalog_active(c_new, true);
      if not r.allowed then raise exception 'FAIL K %: menu_set_catalog_active', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_catalog_grid(c_grab);
      if not r.allowed then raise exception 'FAIL K %: menu_catalog_grid', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_save_catalog_row(v_p2);
      if not r.allowed then raise exception 'FAIL K %: menu_save_catalog_row', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_save_category(v_newcat, 'VERIFY M2 RENAMED');
      if not r.allowed then raise exception 'FAIL K %: menu_save_category', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_reorder_categories((select array_agg(id order by sort_order, name) from menu_categories));
      if not r.allowed then raise exception 'FAIL K %: menu_reorder_categories', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    begin perform menu_set_category_active(v_newcat, true);
      if not r.allowed then raise exception 'FAIL K %: menu_set_category_active', r.label; end if;
    exception when raise_exception then if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if; end;
    reset role;
  end loop;
  -- the Owner's override gives a manager Edit menu (has_menu_cap is the one rule)
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  insert into system_role_permissions(system_role, permissions) values ('manager', '{"manage_menu": true}')
  on conflict (system_role) do update set permissions = system_role_permissions.permissions || '{"manage_menu": true}';
  perform set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  perform menu_editor_lookups();

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
