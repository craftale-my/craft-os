-- Self-check for the GrabFood skeleton. Run on craft-os-dev after
-- migration-2026-11-01-pos-grab.sql. Everything is rolled back. Success = "VERIFY OK".
begin;

do $$
declare
  v_branch uuid;
  v_cat uuid; v_cat_other uuid; v_mc uuid;
  v_latte uuid; v_hot uuid; v_cold uuid; v_tea uuid; v_tea_v uuid; v_cake uuid; v_cake_v uuid; v_noprice uuid;
  v_grp uuid; v_oat uuid; v_soy uuid; v_secret uuid; v_oat_item uuid;
  v_src jsonb; v_names jsonb; v_latte_row jsonb;
begin
  -- G1–G3: RLS on, no anon access, the menu source for the function only
  if exists (select 1 from pg_class where relname in ('grab_stores', 'grab_orders', 'grab_events') and not relrowsecurity) then
    raise exception 'FAIL grants: RLS is off on a grab table';
  end if;
  if has_table_privilege('anon', 'grab_orders', 'select') or has_table_privilege('anon', 'grab_stores', 'select') then
    raise exception 'FAIL grants: anon can read grab tables';
  end if;
  if has_function_privilege('anon', 'grab_menu_source(text)', 'execute')
     or has_function_privilege('authenticated', 'grab_menu_source(text)', 'execute') then
    raise exception 'FAIL grants: grab_menu_source is for the service role only';
  end if;

  -- fixture: a Grab catalog and the menu it draws from
  select id into v_branch from branches order by name limit 1;
  insert into menu_categories(name, sort_order) values ('VERIFY Grab Coffee', 990) returning id into v_mc;
  insert into menu_catalogs(name, sort_order) values ('VERIFY Grab', 990) returning id into v_cat;
  insert into menu_catalogs(name, sort_order) values ('VERIFY Grab other', 991) returning id into v_cat_other;

  insert into menu_products(category_id, name, sort_order) values (v_mc, 'VERIFY Latte', 1) returning id into v_latte;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen, sort_order)
    values (v_latte, 'hot', 'HOT', 1000, 1) returning id into v_hot;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen, sort_order)
    values (v_latte, 'cold', 'COLD', 1100, 2) returning id into v_cold;
  insert into menu_products(category_id, name, sort_order) values (v_mc, 'VERIFY Tea', 2) returning id into v_tea;
  insert into menu_variants(product_id, name, price_sen) values (v_tea, 'VERIFY Tea', 800) returning id into v_tea_v;
  insert into menu_products(category_id, name, sort_order) values (v_mc, 'VERIFY Cake', 3) returning id into v_cake;
  insert into menu_variants(product_id, name, price_sen) values (v_cake, 'VERIFY Cake', 900) returning id into v_cake_v;
  insert into menu_products(category_id, name, sort_order) values (v_mc, 'VERIFY No price', 4) returning id into v_noprice;
  insert into menu_variants(product_id, name, price_sen) values (v_noprice, 'VERIFY No price', 500);
  insert into menu_products(category_id, name, is_addon) values (v_mc, 'VERIFY Oat milk', true) returning id into v_oat_item;

  insert into modifier_groups(name, min_select, max_select) values ('VERIFY Milk', 0, 1) returning id into v_grp;
  insert into modifier_options(group_id, product_id, name, price_delta_sen, sort_order)
    values (v_grp, v_oat_item, 'Oat', 200, 1) returning id into v_oat;
  insert into modifier_options(group_id, name, price_delta_sen, sort_order) values (v_grp, 'Soy', 150, 2) returning id into v_soy;
  insert into modifier_options(group_id, name, availability, sort_order)
    values (v_grp, 'Staff only', 'counter_only', 3) returning id into v_secret;
  insert into product_modifier_groups(product_id, group_id) values (v_latte, v_grp);

  insert into catalog_products(catalog_id, product_id, availability, sort_order) values
    (v_cat, v_latte, 'all', 1), (v_cat, v_tea, 'all', 2), (v_cat, v_cake, 'counter_only', 3), (v_cat, v_noprice, 'all', 4),
    (v_cat_other, v_latte, 'all', 1);
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values
    (v_cat, v_hot, 1200), (v_cat, v_cold, 1300), (v_cat, v_tea_v, 950), (v_cat, v_cake_v, 1000),
    (v_cat_other, v_hot, 1);
  insert into catalog_option_prices(catalog_id, option_id, price_delta_sen) values (v_cat, v_oat, 250);
  insert into branch_menu_status(branch_id, product_id, is_sold_out) values (v_branch, v_tea, true), (v_branch, v_oat_item, true)
    on conflict (branch_id, product_id) do update set is_sold_out = true;

  insert into grab_stores(branch_id, merchant_id, catalog_id) values (v_branch, 'VERIFY-1-ABC', v_cat)
    on conflict (branch_id) do update set merchant_id = excluded.merchant_id, catalog_id = excluded.catalog_id;

  -- G4 the store's Grab catalog, with its prices, order and sold-out marks
  v_src := grab_menu_source('VERIFY-1-ABC');
  if (v_src->>'branchId')::uuid is distinct from v_branch or (v_src->>'catalogId')::uuid is distinct from v_cat then
    raise exception 'FAIL G4 store: %', v_src;
  end if;
  select jsonb_agg(p->>'name' order by ord) into v_names
    from jsonb_array_elements(v_src->'products') with ordinality as x(p, ord) where p->>'name' like 'VERIFY%';
  if v_names is distinct from '["VERIFY Latte", "VERIFY Tea"]'::jsonb then
    raise exception 'FAIL G4 products (counter_only, add-ons and unpriced left out): %', v_names;
  end if;
  select p into v_latte_row from jsonb_array_elements(v_src->'products') p where (p->>'id')::uuid = v_latte;
  if v_latte_row->'variants' is distinct from jsonb_build_array(
       jsonb_build_object('id', v_hot, 'name', 'HOT', 'priceSen', 1200, 'isBase', false),
       jsonb_build_object('id', v_cold, 'name', 'COLD', 'priceSen', 1300, 'isBase', false)) then
    raise exception 'FAIL G4 variant prices come from the Grab catalog: %', v_latte_row->'variants';
  end if;
  if v_latte_row->'groups'->0->'options' is distinct from jsonb_build_array(
       jsonb_build_object('id', v_oat, 'name', 'Oat', 'priceDeltaSen', 250, 'available', false),
       jsonb_build_object('id', v_soy, 'name', 'Soy', 'priceDeltaSen', 150, 'available', true)) then
    raise exception 'FAIL G4 options (catalog price, sold-out add-on, counter_only left out): %', v_latte_row->'groups';
  end if;
  if (select (p->>'soldOut')::boolean from jsonb_array_elements(v_src->'products') p where (p->>'id')::uuid = v_tea) is distinct from true then
    raise exception 'FAIL G4 sold-out product is marked';
  end if;

  -- an unknown merchant has no menu; a store without a catalog has an empty one
  if grab_menu_source('VERIFY-nobody') is not null then raise exception 'FAIL G4 unknown merchant'; end if;
  update grab_stores set catalog_id = null where branch_id = v_branch;
  if grab_menu_source('VERIFY-1-ABC')->'products' is distinct from '[]'::jsonb then
    raise exception 'FAIL G4 no catalog = empty menu';
  end if;

  -- G2 one row per Grab orderID
  insert into grab_orders(grab_order_id, merchant_id, branch_id, short_order_number, order_type, accepted_type,
                          payment_type, subtotal_sen, order_time, payload)
    values ('VERIFY-ORDER-1', 'VERIFY-1-ABC', v_branch, 'GF-101', 'DeliveredByGrab', 'MANUAL', 'CASHLESS', 2500, now(), '{}');
  begin
    insert into grab_orders(grab_order_id, merchant_id, short_order_number, order_type, accepted_type,
                            payment_type, subtotal_sen, order_time, payload)
      values ('VERIFY-ORDER-1', 'VERIFY-1-ABC', 'GF-101', 'DeliveredByGrab', 'MANUAL', 'CASHLESS', 2500, now(), '{}');
    raise exception 'FAIL G2 a second row for the same orderID was accepted' using errcode = 'assert_failure';
  exception when unique_violation then null;
  end;

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
