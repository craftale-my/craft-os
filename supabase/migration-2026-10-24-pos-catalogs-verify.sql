-- Self-check for the POS menu catalogs M1 migrations. Run on craft-os-dev after
-- migration-2026-10-24-pos-catalogs.sql and -pos-catalogs-fn.sql.
-- Everything is rolled back. Success = a result row "VERIFY OK".
-- Every refusal is paired with the success it guards, and the writes that RLS
-- decides run as `authenticated` (the DO block's own role bypasses RLS).
begin;

do $$
declare
  v_owner   uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_mgr     uuid := 'eeeeeeee-0000-0000-0000-000000000001';   -- manager of VERIFY: access_settings, no manage_menu
  v_cashier uuid := 'eeeeeeee-0000-0000-0000-000000000002';   -- staff of VERIFY
  v_far     uuid := 'eeeeeeee-0000-0000-0000-000000000003';   -- manager of VERIFY2
  v_boss    uuid := 'eeeeeeee-0000-0000-0000-000000000004';   -- a second owner, resigned in H
  v_first   uuid := 'ffffffff-0000-0000-0000-000000000001';   -- client_order_id of E1
  v_branch uuid; v_branch2 uuid;
  v_t1 dining_tables; v_w1 dining_tables;
  v_catg uuid; v_latte uuid; v_hot uuid; v_cold uuid; v_large uuid; v_toast uuid; v_toast_var uuid;
  v_oat uuid; v_milk uuid; v_opt uuid;
  c_dine uuid; c_take uuid; c_qr uuid; c_staff uuid; c_grab uuid; c_old uuid; v_cafe uuid;
  v_order uuid; v_order2 uuid; v_menu jsonb; v_res jsonb; v_payload jsonb; v_text text;
  n integer; r record;
begin
  -- ── A. schema, RLS, grants, search_path ──────────────────────────────────
  for r in select t from unnest(array['menu_catalogs','catalog_products','catalog_variant_prices',
                                      'catalog_option_prices','branch_catalogs']) as t loop
    if not exists (select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
                    where ns.nspname = 'public' and c.relname = r.t and c.relrowsecurity) then
      raise exception 'FAIL schema: % missing or RLS off', r.t;
    end if;
    if not exists (select 1 from pg_policies where tablename = r.t and policyname = 'menu_read' and cmd = 'SELECT') then
      raise exception 'FAIL rls: % has no menu_read', r.t;
    end if;
  end loop;
  for r in select t from unnest(array['menu_catalogs','catalog_products','catalog_variant_prices','catalog_option_prices']) as t loop
    if exists (select 1 from pg_policies where tablename = r.t and cmd in ('DELETE', 'ALL')) then
      raise exception 'FAIL rls: rows of % can be deleted (nothing is hard-deleted)', r.t;
    end if;
    if not exists (select 1 from pg_policies where tablename = r.t and cmd = 'INSERT' and with_check like '%manage_menu%')
       or not exists (select 1 from pg_policies where tablename = r.t and cmd = 'UPDATE'
                       and qual like '%manage_menu%' and with_check like '%manage_menu%') then
      raise exception 'FAIL rls: writes to % are not gated on manage_menu', r.t;
    end if;
  end loop;
  for r in select t from unnest(array['menu_products','menu_variants']) as t loop
    if not exists (select 1 from pg_policies where tablename = r.t and policyname = r.t || '_edit' and cmd = 'UPDATE'
                    and qual like '%manage_menu%' and with_check like '%manage_menu%') then
      raise exception 'FAIL rls: %_edit is not gated on manage_menu', r.t;
    end if;
  end loop;
  if not exists (select 1 from pg_policies where tablename = 'branch_menu_status' and policyname = 'branch_menu_status_write'
                  and qual like '%pos_caller_branch()%' and with_check like '%pos_caller_branch()%') then
    raise exception 'FAIL rls: sold-out writes are not limited to the caller''s branch';
  end if;
  if not exists (select 1 from pg_policies where tablename = 'branch_catalogs' and policyname = 'branch_catalogs_manage'
                  and qual like '%pos_caller_branch()%' and qual like '%access_settings%'
                  and with_check like '%pos_caller_branch()%' and with_check like '%access_settings%') then
    raise exception 'FAIL rls: branch_catalogs writes are not limited to a manager of the branch';
  end if;
  if not exists (select 1 from pg_indexes where indexname = 'branch_catalogs_one_per_role') then
    raise exception 'FAIL schema: branch_catalogs_one_per_role is missing';
  end if;
  if not exists (select 1 from pg_constraint where conname = 'orders_catalog_id_fkey') then
    raise exception 'FAIL schema: orders.catalog_id has no foreign key';
  end if;
  for r in select f from unnest(array['place_counter_order(uuid,text,integer,jsonb,uuid,uuid)', 'save_branch_catalogs(jsonb)',
                                      'menu_import_catalogs(jsonb)', 'menu_set_catalog_product(uuid,uuid,text)',
                                      'menu_import(jsonb)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
    if not has_function_privilege('authenticated', r.f, 'execute') then raise exception 'FAIL grants: staff cannot call %', r.f; end if;
  end loop;
  for r in select f from unnest(array['pos_order_catalog(uuid,text,text,uuid)',
                                      'pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid,uuid)',
                                      'staff_has_cap(uuid,text)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') or has_function_privilege('authenticated', r.f, 'execute') then
      raise exception 'FAIL grants: % must be internal', r.f;
    end if;
  end loop;
  for r in select f from unnest(array['qr_menu(text)', 'place_table_order(text,integer,jsonb,uuid)']) as f loop
    if not has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon lost %', r.f; end if;
  end loop;
  if to_regprocedure('place_counter_order(uuid,text,integer,jsonb,uuid)') is not null
     or to_regprocedure('pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid)') is not null then
    raise exception 'FAIL: an old ordering signature still exists (re-run migration-2026-10-24-pos-catalogs-fn.sql)';
  end if;
  for r in select p.proname from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
            where ns.nspname = 'public' and p.proname = any (array['has_menu_cap','staff_has_cap','pos_order_catalog',
              'pos_insert_order','place_counter_order','place_table_order','qr_menu','save_branch_catalogs',
              'menu_import','menu_import_catalogs','menu_set_catalog_product'])
              and not coalesce(p.proconfig @> array['search_path=public, pg_temp'], false) loop
    raise exception 'FAIL search_path: % does not pin search_path = public, pg_temp', r.proname;
  end loop;

  -- ── B. backfill: Craft Cafe from the menu as it was ───────────────────────
  select id into v_cafe from menu_catalogs where feedme_catalog_name = 'Craft Cafe';
  if v_cafe is null then raise exception 'FAIL backfill: there is no Craft Cafe catalog'; end if;
  -- always true, also after an import: whatever Craft Cafe sells has a price for each active variant
  if exists (select 1 from catalog_products cp join menu_variants v on v.product_id = cp.product_id and v.is_active
              where cp.catalog_id = v_cafe and cp.availability <> 'hidden'
                and not exists (select 1 from catalog_variant_prices p where p.catalog_id = v_cafe and p.variant_id = v.id)) then
    raise exception 'FAIL backfill: a Craft Cafe product has a variant without a price';
  end if;
  -- before any import (only the backfilled catalog exists): exactly today's menu and prices, on every active branch
  if (select count(*) from menu_catalogs) = 1 then
    if (select count(*) from catalog_products where catalog_id = v_cafe and availability <> 'hidden')
       <> (select count(*) from menu_products where is_active and availability <> 'hidden') then
      raise exception 'FAIL backfill: Craft Cafe does not hold every product that is not hidden';
    end if;
    if exists (select 1 from catalog_products cp join menu_products p on p.id = cp.product_id
                where cp.catalog_id = v_cafe and cp.availability <> p.availability) then
      raise exception 'FAIL backfill: an availability differs from menu_products';
    end if;
    if exists (select 1 from catalog_variant_prices cvp join menu_variants v on v.id = cvp.variant_id
                where cvp.catalog_id = v_cafe and cvp.price_sen <> v.price_sen) then
      raise exception 'FAIL backfill: a Craft Cafe price differs from today''s price';
    end if;
    if exists (select 1 from branches b cross join (values ('dine_in'), ('takeaway'), ('qr')) as x(role)
                where coalesce(b.is_active, true)
                  and not exists (select 1 from branch_catalogs bc
                                   where bc.branch_id = b.id and bc.role = x.role and bc.catalog_id = v_cafe)) then
      raise exception 'FAIL backfill: an active branch does not use Craft Cafe for dine-in, takeaway and QR';
    end if;
  end if;

  -- ── C. fixture: two branches, staff, a latte with a milk add-on, a toast, six catalogs ─
  update system_role_permissions set permissions = permissions - 'manage_menu';   -- code defaults for this run
  insert into branches(name, address) values ('VERIFY', 'verify') returning id into v_branch;
  insert into branches(name, address) values ('VERIFY2', 'far away') returning id into v_branch2;
  insert into dining_tables(branch_id, label) values (v_branch, 'V1') returning * into v_t1;
  insert into dining_tables(branch_id, label) values (v_branch2, 'W1') returning * into v_w1;
  insert into menu_categories(name) values ('VERIFY M1 CAT') returning id into v_catg;
  insert into menu_products(name, category_id, print_route, sst_rate_bp) values ('Verify Latte', v_catg, 'Bar', 600)
    returning id into v_latte;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen, sort_order) values (v_latte, 'v/hot', 'HOT', 1200, 0)
    returning id into v_hot;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen, sort_order) values (v_latte, 'v/cold', 'COLD', 1300, 1)
    returning id into v_cold;
  insert into menu_products(name, category_id, sst_rate_bp) values ('Verify Toast', v_catg, 600) returning id into v_toast;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_toast, '', 'Regular', 800)
    returning id into v_toast_var;
  insert into menu_products(name, category_id, is_addon) values ('Verify Oat milk', v_catg, true) returning id into v_oat;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_oat, '', 'Regular', 200);
  insert into modifier_groups(name, min_select, max_select) values ('Milk', 0, 1) returning id into v_milk;
  insert into modifier_options(group_id, product_id, name, price_delta_sen) values (v_milk, v_oat, 'Oat milk', 200)
    returning id into v_opt;
  insert into product_modifier_groups(product_id, group_id) values (v_latte, v_milk);
  insert into menu_catalogs(name, sort_order) values ('VERIFY Dine', 901) returning id into c_dine;
  insert into menu_catalogs(name, sort_order) values ('VERIFY Take', 902) returning id into c_take;
  insert into menu_catalogs(name, sort_order) values ('VERIFY QR', 903) returning id into c_qr;
  insert into menu_catalogs(name, sort_order) values ('VERIFY Staff', 904) returning id into c_staff;
  insert into menu_catalogs(name, sort_order) values ('VERIFY Grab', 905) returning id into c_grab;
  insert into menu_catalogs(name, sort_order, is_active) values ('VERIFY Old', 906, false) returning id into c_old;
  insert into catalog_products(catalog_id, product_id, availability) values
    (c_dine, v_latte, 'all'), (c_dine, v_toast, 'counter_only'),
    (c_take, v_latte, 'all'),
    (c_qr, v_latte, 'all'), (c_qr, v_toast, 'counter_only'),
    (c_staff, v_latte, 'counter_only'), (c_staff, v_toast, 'all'),
    (c_grab, v_latte, 'all'), (c_old, v_latte, 'all');
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values
    (c_dine, v_hot, 1210), (c_dine, v_cold, 1310), (c_dine, v_toast_var, 810),
    (c_take, v_hot, 1100), (c_take, v_cold, 1250),
    (c_qr, v_hot, 1500), (c_qr, v_cold, 1600), (c_qr, v_toast_var, 900),
    (c_staff, v_hot, 600), (c_staff, v_cold, 650), (c_staff, v_toast_var, 400),
    (c_grab, v_hot, 1700), (c_grab, v_cold, 1800),
    (c_old, v_hot, 100), (c_old, v_cold, 100);
  insert into catalog_option_prices(catalog_id, option_id, price_delta_sen) values (c_qr, v_opt, 300), (c_staff, v_opt, 0);
  insert into branch_catalogs(branch_id, role, catalog_id) values
    (v_branch, 'dine_in', c_dine), (v_branch, 'takeaway', c_take), (v_branch, 'qr', c_qr),
    (v_branch, 'additional', c_staff), (v_branch, 'additional', c_old);
  -- staff are inserted as 'staff' and promoted by the owner (staff_guard refuses anything else)
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  insert into auth.users (id) values (v_mgr), (v_cashier), (v_far), (v_boss);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_mgr,     'Verify M1 Manager', 'trainee', true, current_date, 'staff', v_branch),
    (v_cashier, 'Verify M1 Cashier', 'trainee', true, current_date, 'staff', v_branch),
    (v_far,     'Verify M1 Far',     'trainee', true, current_date, 'staff', v_branch2),
    (v_boss,    'Verify M1 Boss',    'trainee', true, current_date, 'staff', v_branch);
  update staff set system_role = 'manager' where id in (v_mgr, v_far);
  update staff set system_role = 'owner' where id = v_boss;
  update staff set branch_id = v_branch where id = v_owner;
  if not staff_has_cap(v_owner, 'manage_menu') then raise exception 'FAIL fixture: the test login (owner) lacks manage_menu'; end if;

  -- ── D. manage_menu: owner and admin only; has_menu_cap and staff_has_cap agree; Owner override ─
  for r in select * from (values ('owner', true), ('admin', true), ('hr', false), ('manager', false),
                                 ('supervisor', false), ('staff', false)) as x(role, expected) loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
    update staff set system_role = r.role where id = v_cashier;
    perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
    if has_menu_cap('manage_menu') <> r.expected or staff_has_cap(v_cashier, 'manage_menu') <> r.expected then
      raise exception 'FAIL cap: % manage_menu should be %', r.role, r.expected;
    end if;
  end loop;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  update staff set system_role = 'staff' where id = v_cashier;
  insert into system_role_permissions(system_role, permissions) values ('manager', '{"manage_menu": true}')
  on conflict (system_role) do update set permissions = system_role_permissions.permissions || '{"manage_menu": true}';
  if not staff_has_cap(v_mgr, 'manage_menu') then raise exception 'FAIL cap: the Owner''s override is ignored'; end if;
  update system_role_permissions set permissions = permissions - 'manage_menu' where system_role = 'manager';
  if staff_has_cap(v_mgr, 'manage_menu') then raise exception 'FAIL cap: a manager holds manage_menu by default'; end if;

  -- ── E. counter orders: the catalog decides what sells and at what price ───
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  -- E1. no catalog asked for → the dine-in catalog: its prices, the add-on's default price (as a client: grants)
  set local role authenticated;
  v_order := place_counter_order(v_t1.id, 'dine_in', 2, jsonb_build_array(
    jsonb_build_object('productId', v_latte, 'variantId', v_cold, 'optionIds', jsonb_build_array(v_opt)),
    jsonb_build_object('productId', v_toast, 'variantId', v_toast_var)), v_first);
  reset role;
  if (select catalog_id from orders where id = v_order) is distinct from c_dine then
    raise exception 'FAIL E1: the order is not recorded with the dine-in catalog';
  end if;
  select string_agg(name_snapshot || '=' || unit_price_sen, ',' order by name_snapshot) into v_text
    from order_items where order_id = v_order;
  if v_text is distinct from 'Verify Latte (COLD)=1510,Verify Toast=810' then raise exception 'FAIL E1: prices %', v_text; end if;
  if (select modifiers_snapshot->0->>'priceDeltaSen' from order_items where order_id = v_order and product_id = v_latte) <> '200' then
    raise exception 'FAIL E1: the add-on snapshot must carry the price charged';
  end if;
  -- E2. a resend of E1 naming another catalog is still E1 (dedupe comes first)
  v_order2 := place_counter_order(v_t1.id, 'dine_in', 2, jsonb_build_array(
    jsonb_build_object('productId', v_latte, 'variantId', v_hot)), v_first, c_staff);
  if v_order2 <> v_order then raise exception 'FAIL E2: a resend created a second order'; end if;
  -- E3. takeaway → the takeaway catalog
  v_order := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid());
  if (select catalog_id from orders where id = v_order) is distinct from c_take
     or (select unit_price_sen from order_items where order_id = v_order) <> 1100 then
    raise exception 'FAIL E3: a takeaway is not priced from the takeaway catalog';
  end if;
  -- E4. a product the catalog does not sell is refused (the dine-in catalog sells it: E1)
  begin perform place_counter_order(null, 'takeaway', null,
          jsonb_build_array(jsonb_build_object('productId', v_toast, 'variantId', v_toast_var)), gen_random_uuid());
    raise exception 'FAIL E4: sold a product that is not in the takeaway catalog';
  exception when raise_exception then if sqlerrm <> 'Item is not available: Verify Toast' then raise; end if; end;
  -- E5. an additional catalog: counter_only is fine at the counter, its prices and its add-on price (0, not the default 200)
  v_order := place_counter_order(v_t1.id, 'dine_in', null, jsonb_build_array(
    jsonb_build_object('productId', v_latte, 'variantId', v_cold, 'optionIds', jsonb_build_array(v_opt))), gen_random_uuid(), c_staff);
  if (select catalog_id from orders where id = v_order) is distinct from c_staff
     or (select unit_price_sen from order_items where order_id = v_order) <> 650
     or (select modifiers_snapshot->0->>'priceDeltaSen' from order_items where order_id = v_order) <> '0' then
    raise exception 'FAIL E5: the additional catalog''s prices were not used';
  end if;
  -- E6. naming the default itself is fine; another order type's default, a catalog the
  --     branch does not have, or an inactive additional one is refused
  v_order := place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid(), c_dine);
  if (select unit_price_sen from order_items where order_id = v_order) <> 1210 then raise exception 'FAIL E6: default named'; end if;
  for r in select * from (values (c_take), (c_grab), (c_old)) as x(cat) loop
    begin perform place_counter_order(v_t1.id, 'dine_in', null,
            jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid(), r.cat);
      raise exception 'FAIL E6: catalog % was accepted for a dine-in order here', r.cat;
    exception when raise_exception then if sqlerrm <> 'This catalog is not available at this branch' then raise; end if; end;
  end loop;
  update menu_catalogs set is_active = true where id = c_old;                -- the same additional catalog, active: allowed
  perform place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid(), c_old);
  update menu_catalogs set is_active = false where id = c_old;
  -- E7. an inactive default refuses the order type until it is active again
  update menu_catalogs set is_active = false where id = c_dine;
  begin perform place_counter_order(v_t1.id, 'dine_in', null,
          jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid());
    raise exception 'FAIL E7: an inactive dine-in catalog still sold';
  exception when raise_exception then if sqlerrm <> 'This catalog is not available at this branch' then raise; end if; end;
  update menu_catalogs set is_active = true where id = c_dine;
  -- E8. a variant the catalog has no price for is not for sale; with a price it is
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen, sort_order) values (v_latte, 'v/large', 'LARGE', 1500, 2)
    returning id into v_large;
  begin perform place_counter_order(v_t1.id, 'dine_in', null,
          jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_large)), gen_random_uuid());
    raise exception 'FAIL E8: sold a variant without a catalog price';
  exception when raise_exception then if sqlerrm <> 'Item is not available: Verify Latte' then raise; end if; end;
  insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (c_dine, v_large, 1510);
  v_order := place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_large)), gen_random_uuid());
  if (select unit_price_sen from order_items where order_id = v_order) <> 1510 then raise exception 'FAIL E8: large price'; end if;
  -- E9. hidden in the catalog = not for sale (the master availability is not read any more)
  update catalog_products set availability = 'hidden' where catalog_id = c_dine and product_id = v_toast;
  update menu_products set availability = 'all' where id = v_toast;
  begin perform place_counter_order(v_t1.id, 'dine_in', null,
          jsonb_build_array(jsonb_build_object('productId', v_toast, 'variantId', v_toast_var)), gen_random_uuid());
    raise exception 'FAIL E9: sold a product hidden in the catalog';
  exception when raise_exception then if sqlerrm <> 'Item is not available: Verify Toast' then raise; end if; end;
  update catalog_products set availability = 'counter_only' where catalog_id = c_dine and product_id = v_toast;
  update menu_products set availability = 'hidden' where id = v_toast;
  perform place_counter_order(v_t1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_toast, 'variantId', v_toast_var)), gen_random_uuid());
  -- E10. a branch with no catalog for the order type says so; once set, it sells
  perform set_config('request.jwt.claims', json_build_object('sub', v_far, 'role', 'authenticated')::text, true);
  begin perform place_counter_order(v_w1.id, 'dine_in', null,
          jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid());
    raise exception 'FAIL E10: ordered at a branch with no dine-in catalog';
  exception when raise_exception then if sqlerrm <> 'No menu catalog is set for dine-in — set it in POS settings' then raise; end if; end;
  begin perform place_counter_order(null, 'takeaway', null,
          jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid());
    raise exception 'FAIL E10: ordered at a branch with no takeaway catalog';
  exception when raise_exception then if sqlerrm <> 'No menu catalog is set for takeaway — set it in POS settings' then raise; end if; end;
  insert into branch_catalogs(branch_id, role, catalog_id) values (v_branch2, 'dine_in', c_grab);
  v_order := place_counter_order(v_w1.id, 'dine_in', null,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid());
  if (select catalog_id from orders where id = v_order) is distinct from c_grab
     or (select unit_price_sen from order_items where order_id = v_order) <> 1700 then
    raise exception 'FAIL E10: VERIFY2''s dine-in catalog was not used';
  end if;

  -- ── F. QR: the branch's qr catalog, 'all' products only ────────────────────
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  set local role anon;
  v_menu := qr_menu(v_t1.qr_token);
  reset role;
  select string_agg(p->>'name', ',' order by p->>'name') into v_text
    from jsonb_array_elements(v_menu->'categories') c cross join lateral jsonb_array_elements(c->'products') p
   where c->>'name' = 'VERIFY M1 CAT';
  if v_text is distinct from 'Verify Latte' then raise exception 'FAIL F1: QR lists %, expected the QR catalog''s ''all'' products', v_text; end if;
  -- LARGE has no QR price, so it is not offered; the add-on shows the catalog's 300
  select string_agg((v->>'name') || '=' || (v->>'priceSen'), ',' order by v->>'name') into v_text
    from jsonb_array_elements(v_menu->'categories') c cross join lateral jsonb_array_elements(c->'products') p
    cross join lateral jsonb_array_elements(p->'variants') v
   where p->>'id' = v_latte::text;
  if v_text is distinct from 'COLD=1600,HOT=1500' then raise exception 'FAIL F1: QR variants %', v_text; end if;
  if (select p->'groups'->0->'options'->0->>'priceDeltaSen'
        from jsonb_array_elements(v_menu->'categories') c cross join lateral jsonb_array_elements(c->'products') p
       where p->>'id' = v_latte::text) <> '300' then
    raise exception 'FAIL F1: the QR add-on price is not the catalog''s';
  end if;
  -- F2. a QR order is priced from the qr catalog
  v_order := place_table_order(v_t1.qr_token, null, jsonb_build_array(jsonb_build_object(
    'productId', v_latte, 'variantId', v_hot, 'optionIds', jsonb_build_array(v_opt))), gen_random_uuid());
  if (select catalog_id from orders where id = v_order) is distinct from c_qr
     or (select unit_price_sen from order_items where order_id = v_order) <> 1800 then
    raise exception 'FAIL F2: the QR order was not priced from the qr catalog';
  end if;
  -- F3. QR cannot order counter_only; once the qr catalog says 'all', it can
  begin perform place_table_order(v_t1.qr_token, null,
          jsonb_build_array(jsonb_build_object('productId', v_toast, 'variantId', v_toast_var)), gen_random_uuid());
    raise exception 'FAIL F3: QR ordered a counter_only product';
  exception when raise_exception then if sqlerrm <> 'Item is not available: Verify Toast' then raise; end if; end;
  update catalog_products set availability = 'all' where catalog_id = c_qr and product_id = v_toast;
  v_order := place_table_order(v_t1.qr_token, null,
    jsonb_build_array(jsonb_build_object('productId', v_toast, 'variantId', v_toast_var)), gen_random_uuid());
  if (select unit_price_sen from order_items where order_id = v_order) <> 900 then raise exception 'FAIL F3: QR toast price'; end if;
  -- F4. hidden in the qr catalog: not on the QR menu and not orderable
  update catalog_products set availability = 'hidden' where catalog_id = c_qr and product_id = v_toast;
  if exists (select 1 from jsonb_array_elements(qr_menu(v_t1.qr_token)->'categories') c
               cross join lateral jsonb_array_elements(c->'products') p where p->>'id' = v_toast::text) then
    raise exception 'FAIL F4: a product hidden in the qr catalog is on the QR menu';
  end if;
  begin perform place_table_order(v_t1.qr_token, null,
          jsonb_build_array(jsonb_build_object('productId', v_toast, 'variantId', v_toast_var)), gen_random_uuid());
    raise exception 'FAIL F4: QR ordered a product hidden in the qr catalog';
  exception when raise_exception then if sqlerrm <> 'Item is not available: Verify Toast' then raise; end if; end;
  -- F5. an inactive qr catalog: an empty menu and a refusal; active again, it orders (F2)
  update menu_catalogs set is_active = false where id = c_qr;
  if jsonb_array_length(qr_menu(v_t1.qr_token)->'categories') <> 0 then raise exception 'FAIL F5: a menu from an inactive qr catalog'; end if;
  begin perform place_table_order(v_t1.qr_token, null,
          jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid());
    raise exception 'FAIL F5: QR ordered from an inactive qr catalog';
  exception when raise_exception then if sqlerrm <> 'This catalog is not available at this branch' then raise; end if; end;
  update menu_catalogs set is_active = true where id = c_qr;
  -- F6. no qr catalog: an empty menu and a clear refusal; back again, it orders
  delete from branch_catalogs where branch_id = v_branch and role = 'qr';
  if jsonb_array_length(qr_menu(v_t1.qr_token)->'categories') <> 0 then raise exception 'FAIL F6: a menu without a qr catalog'; end if;
  begin perform place_table_order(v_t1.qr_token, null,
          jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid());
    raise exception 'FAIL F6: QR ordered with no qr catalog';
  exception when raise_exception then if sqlerrm <> 'No menu catalog is set for QR — set it in POS settings' then raise; end if; end;
  insert into branch_catalogs(branch_id, role, catalog_id) values (v_branch, 'qr', c_qr);

  -- ── G. sold-out: own branch only, and it applies in every catalog ──────────
  insert into branch_menu_status(branch_id, product_id, is_sold_out) values (v_branch2, v_toast, false);   -- VERIFY2's row
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin
    insert into branch_menu_status(branch_id, product_id, is_sold_out) values (v_branch2, v_latte, true);
    raise exception 'FAIL G: a cashier marked another branch''s product sold out';
  exception when insufficient_privilege then if sqlerrm not like '%row-level security%' then raise; end if; end;
  update branch_menu_status set is_sold_out = true where branch_id = v_branch2 and product_id = v_toast;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL G: a cashier changed another branch''s sold-out'; end if;
  insert into branch_menu_status(branch_id, product_id, is_sold_out) values (v_branch, v_latte, true);   -- own branch: allowed
  reset role;
  begin perform place_counter_order(v_t1.id, 'dine_in', null,
          jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid(), c_staff);
    raise exception 'FAIL G: sold out ignored in an additional catalog';
  exception when raise_exception then if sqlerrm <> 'Sold out: Verify Latte' then raise; end if; end;
  delete from branch_menu_status where branch_id = v_branch and product_id = v_latte;

  -- ── H. every menu write needs manage_menu: manager refused, owner allowed, resigned owner refused ─
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  update staff set status = 'resigned' where id = v_boss;                    -- is_active stays true, as in real life
  for r in select * from (values (v_mgr, false, 'manager'), (v_owner, true, 'owner'), (v_boss, false, 'resigned owner'))
                          as x(who, allowed, label) loop
    perform set_config('request.jwt.claims', json_build_object('sub', r.who, 'role', 'authenticated')::text, true);
    set local role authenticated;
    update menu_products set sst_rate_bp = 0 where id = v_toast;
    get diagnostics n = row_count;
    if (n = 1) <> r.allowed then raise exception 'FAIL H %: menu_products update gave % rows', r.label, n; end if;
    update menu_variants set name = 'Regular' where id = v_toast_var;
    get diagnostics n = row_count;
    if (n = 1) <> r.allowed then raise exception 'FAIL H %: menu_variants update gave % rows', r.label, n; end if;
    update menu_catalogs set sort_order = 950 where id = c_grab;
    get diagnostics n = row_count;
    if (n = 1) <> r.allowed then raise exception 'FAIL H %: menu_catalogs update gave % rows', r.label, n; end if;
    update catalog_products set sort_order = 5 where catalog_id = c_dine and product_id = v_toast;
    get diagnostics n = row_count;
    if (n = 1) <> r.allowed then raise exception 'FAIL H %: catalog_products update gave % rows', r.label, n; end if;
    update catalog_variant_prices set price_sen = 811 where catalog_id = c_dine and variant_id = v_toast_var;
    get diagnostics n = row_count;
    if (n = 1) <> r.allowed then raise exception 'FAIL H %: catalog_variant_prices update gave % rows', r.label, n; end if;
    update catalog_option_prices set price_delta_sen = 300 where catalog_id = c_qr and option_id = v_opt;
    get diagnostics n = row_count;
    if (n = 1) <> r.allowed then raise exception 'FAIL H %: catalog_option_prices update gave % rows', r.label, n; end if;
    begin
      insert into menu_catalogs(name) values ('VERIFY by ' || r.label);
      insert into catalog_products(catalog_id, product_id, availability) values (c_take, v_toast, 'all');
      insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (c_take, v_toast_var, 800);
      insert into catalog_option_prices(catalog_id, option_id, price_delta_sen) values (c_take, v_opt, 150);
      if not r.allowed then raise exception 'FAIL H %: inserted catalog rows', r.label; end if;
    exception when insufficient_privilege then
      if r.allowed or sqlerrm not like '%row-level security%' then raise; end if;
    end;
    begin
      perform menu_set_catalog_product(c_grab, v_toast, 'counter_only');
      if not r.allowed then raise exception 'FAIL H %: menu_set_catalog_product was allowed', r.label; end if;
    exception when raise_exception then
      if r.allowed or sqlerrm <> 'Not allowed to edit the menu' then raise; end if;
    end;
    begin
      perform menu_import_catalogs('{"categories": [], "products": [], "groups": [], "links": [], "catalogs": []}'::jsonb);
      if not r.allowed then raise exception 'FAIL H %: menu_import_catalogs was allowed', r.label; end if;
    exception when raise_exception then
      if r.allowed or sqlerrm <> 'Not allowed to import the menu' then raise; end if;
    end;
    begin
      perform menu_import('{"categories": [], "products": [], "groups": [], "links": []}'::jsonb);
      if not r.allowed then raise exception 'FAIL H %: menu_import was allowed', r.label; end if;
    exception when raise_exception then
      if r.allowed or sqlerrm <> 'Not allowed to import the menu' then raise; end if;
    end;
    reset role;
  end loop;
  -- H2. putting a product in a catalog pre-fills the default price; taking it out keeps the row as hidden
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  if (select availability from catalog_products where catalog_id = c_grab and product_id = v_toast) is distinct from 'counter_only'
     or (select price_sen from catalog_variant_prices where catalog_id = c_grab and variant_id = v_toast_var) is distinct from 800 then
    raise exception 'FAIL H2: including a product did not pre-fill its default price';
  end if;
  perform menu_set_catalog_product(c_grab, v_toast, 'hidden');
  if (select availability from catalog_products where catalog_id = c_grab and product_id = v_toast) is distinct from 'hidden'
     or not exists (select 1 from catalog_variant_prices where catalog_id = c_grab and variant_id = v_toast_var) then
    raise exception 'FAIL H2: taking a product out must keep its row (hidden) and its price';
  end if;
  begin perform menu_set_catalog_product(c_grab, v_toast, 'sometimes'); raise exception 'FAIL H2: bad availability accepted';
  exception when raise_exception then if sqlerrm <> 'Invalid availability' then raise; end if; end;
  begin perform menu_set_catalog_product(gen_random_uuid(), v_toast, 'all'); raise exception 'FAIL H2: unknown catalog accepted';
  exception when raise_exception then if sqlerrm <> 'Catalog not found' then raise; end if; end;
  begin perform menu_set_catalog_product(c_grab, gen_random_uuid(), 'all'); raise exception 'FAIL H2: unknown product accepted';
  exception when raise_exception then if sqlerrm <> 'Product not found' then raise; end if; end;

  -- ── I. branch catalogs: a manager of the branch only ──────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  begin perform save_branch_catalogs(jsonb_build_object('dineIn', c_dine, 'takeaway', c_take, 'qr', c_qr, 'additional', '[]'::jsonb));
    raise exception 'FAIL I: a cashier saved the branch catalogs';
  exception when raise_exception then if sqlerrm <> 'Only a manager can change the menu catalogs' then raise; end if; end;
  perform set_config('request.jwt.claims', json_build_object('sub', v_mgr, 'role', 'authenticated')::text, true);
  begin perform save_branch_catalogs(jsonb_build_object('dineIn', c_dine, 'takeaway', c_take, 'qr', null, 'additional', '[]'::jsonb));
    raise exception 'FAIL I: saved without a QR catalog';
  exception when raise_exception then if sqlerrm <> 'Choose the QR catalog' then raise; end if; end;
  begin perform save_branch_catalogs(jsonb_build_object('dineIn', c_dine, 'takeaway', c_take, 'qr', c_qr, 'additional', jsonb_build_array(c_old)));
    raise exception 'FAIL I: saved an inactive catalog';
  exception when raise_exception then if sqlerrm <> 'This catalog is not available — refresh and try again' then raise; end if; end;
  begin perform save_branch_catalogs(jsonb_build_object('dineIn', 'nope', 'takeaway', c_take, 'qr', c_qr, 'additional', '[]'::jsonb));
    raise exception 'FAIL I: saved a malformed id';
  exception when raise_exception then if sqlerrm <> 'Invalid catalog settings' then raise; end if; end;
  set local role authenticated;
  perform save_branch_catalogs(jsonb_build_object('dineIn', c_dine, 'takeaway', c_dine, 'qr', c_qr,
                                                  'additional', jsonb_build_array(c_staff, c_grab, c_staff)));
  reset role;
  select string_agg(role || ':' || (select name from menu_catalogs m where m.id = catalog_id), ',' order by role, catalog_id::text)
    into v_text from branch_catalogs where branch_id = v_branch;
  if (select count(*) from branch_catalogs where branch_id = v_branch) <> 5
     or (select catalog_id from branch_catalogs where branch_id = v_branch and role = 'takeaway') <> c_dine
     or exists (select 1 from branch_catalogs where branch_id = v_branch and catalog_id = c_old)
     or (select count(*) from branch_catalogs where branch_id = v_branch2) <> 1 then
    raise exception 'FAIL I: saved rows %', v_text;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  v_order := place_counter_order(null, 'takeaway', null,
    jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid());
  if (select catalog_id from orders where id = v_order) is distinct from c_dine then
    raise exception 'FAIL I: a takeaway did not follow the new takeaway catalog';
  end if;
  -- direct writes: a manager of another branch and a cashier are refused; a manager's own branch is fine
  perform set_config('request.jwt.claims', json_build_object('sub', v_far, 'role', 'authenticated')::text, true);
  set local role authenticated;
  begin insert into branch_catalogs(branch_id, role, catalog_id) values (v_branch, 'additional', c_take);
    raise exception 'FAIL I: a manager of another branch changed this branch''s catalogs';
  exception when insufficient_privilege then if sqlerrm not like '%row-level security%' then raise; end if; end;
  insert into branch_catalogs(branch_id, role, catalog_id) values (v_branch2, 'additional', c_staff);
  perform set_config('request.jwt.claims', json_build_object('sub', v_cashier, 'role', 'authenticated')::text, true);
  begin insert into branch_catalogs(branch_id, role, catalog_id) values (v_branch, 'additional', c_take);
    raise exception 'FAIL I: a cashier changed the branch catalogs';
  exception when insufficient_privilege then if sqlerrm not like '%row-level security%' then raise; end if; end;
  reset role;
  begin insert into branch_catalogs(branch_id, role, catalog_id) values (v_branch, 'dine_in', c_grab);
    raise exception 'FAIL I: a branch got two dine-in catalogs';
  exception when unique_violation then null; end;

  -- ── J. the multi-catalog import ───────────────────────────────────────────
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_payload := $j${
    "categories": [{"name": "VERIFY M1 IMP", "sortOrder": 0}],
    "products": [
      {"feedmeId": "verify-m1-latte", "name": "Imp Latte", "internalName": null, "description": null, "category": "VERIFY M1 IMP",
       "availability": "all", "isAddon": false, "takeawayFeeSen": 0, "sortOrder": 0,
       "variants": [{"key": "k/hot", "name": "HOT", "priceSen": 1000, "sortOrder": 0},
                    {"key": "k/cold", "name": "COLD", "priceSen": 1100, "sortOrder": 1}]},
      {"feedmeId": "verify-m1-toast", "name": "Imp Toast", "internalName": null, "description": null, "category": "VERIFY M1 IMP",
       "availability": "all", "isAddon": false, "takeawayFeeSen": 0, "sortOrder": 1,
       "variants": [{"key": "", "name": "Regular", "priceSen": 700, "sortOrder": 0}]},
      {"feedmeId": "verify-m1-oat", "name": "Imp Oat", "internalName": null, "description": null, "category": "VERIFY M1 IMP",
       "availability": "all", "isAddon": true, "takeawayFeeSen": 0, "sortOrder": 2,
       "variants": [{"key": "", "name": "Regular", "priceSen": 200, "sortOrder": 0}]}
    ],
    "groups": [{"feedmeId": "verify-m1-milk", "name": "Imp Milk", "min": 0, "max": 1, "stackable": false, "sortOrder": 0,
                "options": [{"productFeedmeId": "verify-m1-oat", "variantKey": "", "name": "Imp Oat", "priceSen": 200,
                             "isDefault": false, "availability": "all", "sortOrder": 0}]}],
    "links": [{"productFeedmeId": "verify-m1-latte", "groupFeedmeId": "verify-m1-milk", "sortOrder": 0}],
    "catalogs": [
      {"name": "VERIFY Feedme A", "sortOrder": 0,
       "products": [{"feedmeId": "verify-m1-latte", "availability": "all", "sortOrder": 0,
                     "prices": [{"key": "k/hot", "priceSen": 1000}, {"key": "k/cold", "priceSen": 1150}]}],
       "optionPrices": [{"groupFeedmeId": "verify-m1-milk", "productFeedmeId": "verify-m1-oat", "variantKey": "", "priceSen": 250}]},
      {"name": "VERIFY Feedme B", "sortOrder": 1,
       "products": [{"feedmeId": "verify-m1-latte", "availability": "counter_only", "sortOrder": 1,
                     "prices": [{"key": "k/hot", "priceSen": 900}, {"key": "k/cold", "priceSen": 950}]},
                    {"feedmeId": "verify-m1-toast", "availability": "all", "sortOrder": 0,
                     "prices": [{"key": "", "priceSen": 650}]}],
       "optionPrices": []}
    ]
  }$j$;
  set local role authenticated;
  v_res := menu_import_catalogs(v_payload);
  reset role;
  if (v_res->>'products')::int <> 3
     or v_res->'catalogs' is distinct from '[{"name": "VERIFY Feedme A", "products": 1, "prices": 2, "optionPrices": 1},
                                             {"name": "VERIFY Feedme B", "products": 2, "prices": 3, "optionPrices": 0}]'::jsonb then
    raise exception 'FAIL J1: import report %', v_res;
  end if;
  select string_agg(c.name || '/' || p.name || '/' || cp.availability || '/' ||
                    (select string_agg(v.name || '=' || cvp.price_sen, '+' order by v.name)
                       from catalog_variant_prices cvp join menu_variants v on v.id = cvp.variant_id
                      where cvp.catalog_id = c.id and v.product_id = p.id), ',' order by c.name, p.name)
    into v_text
    from catalog_products cp join menu_catalogs c on c.id = cp.catalog_id join menu_products p on p.id = cp.product_id
   where c.feedme_catalog_name like 'VERIFY Feedme %';
  if v_text is distinct from 'VERIFY Feedme A/Imp Latte/all/COLD=1150+HOT=1000,'
                             'VERIFY Feedme B/Imp Latte/counter_only/COLD=950+HOT=900,VERIFY Feedme B/Imp Toast/all/Regular=650' then
    raise exception 'FAIL J1: catalogs after import %', v_text;
  end if;
  if (select cop.price_delta_sen from catalog_option_prices cop join menu_catalogs c on c.id = cop.catalog_id
       where c.name = 'VERIFY Feedme A') is distinct from 250 then
    raise exception 'FAIL J1: the add-on price of catalog A';
  end if;
  if exists (select 1 from branch_catalogs bc join menu_catalogs c on c.id = bc.catalog_id where c.name like 'VERIFY Feedme %') then
    raise exception 'FAIL J1: the import assigned a catalog to a branch';
  end if;
  -- J2. importing again: what the file drops from a catalog is hidden, never deleted; nothing doubles
  v_payload := jsonb_set(v_payload, '{catalogs,0,products}',
    '[{"feedmeId": "verify-m1-toast", "availability": "all", "sortOrder": 0, "prices": [{"key": "", "priceSen": 600}]}]'::jsonb);
  perform menu_import_catalogs(v_payload);
  select string_agg(p.name || '/' || cp.availability, ',' order by p.name) into v_text
    from catalog_products cp join menu_catalogs c on c.id = cp.catalog_id join menu_products p on p.id = cp.product_id
   where c.name = 'VERIFY Feedme A';
  if v_text is distinct from 'Imp Latte/hidden,Imp Toast/all'
     or (select count(*) from menu_catalogs where name like 'VERIFY Feedme %') <> 2
     or (select cop.price_delta_sen from catalog_option_prices cop join menu_catalogs c on c.id = cop.catalog_id
          where c.name = 'VERIFY Feedme A') is distinct from 250 then
    raise exception 'FAIL J2: re-import gave %', v_text;
  end if;
  -- J3. a catalog missing a variant price is refused and leaves nothing behind
  begin
    perform menu_import_catalogs(jsonb_set(v_payload, '{catalogs}', (v_payload->'catalogs') ||
      '[{"name": "VERIFY Feedme C", "sortOrder": 2, "optionPrices": [],
         "products": [{"feedmeId": "verify-m1-latte", "availability": "all", "sortOrder": 0,
                       "prices": [{"key": "k/hot", "priceSen": 1000}]}]}]'::jsonb));
    raise exception 'FAIL J3: a catalog without every variant price was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Catalog VERIFY Feedme C: Imp Latte / COLD has no price' then raise; end if;
  end;
  if exists (select 1 from menu_catalogs where name = 'VERIFY Feedme C') then raise exception 'FAIL J3: a refused import left a catalog'; end if;
  -- J4. malformed catalogs
  begin
    perform menu_import_catalogs(jsonb_set(v_payload, '{catalogs,0,products,0,availability}', '"hidden"'::jsonb));
    raise exception 'FAIL J4: availability hidden accepted in the file';
  exception when raise_exception then
    if sqlerrm <> 'Invalid import file: a catalog product has no availability or prices' then raise; end if;
  end;
  begin
    perform menu_import_catalogs(jsonb_set(v_payload, '{catalogs,1,name}', '"VERIFY Feedme A"'::jsonb));
    raise exception 'FAIL J4: a catalog listed twice was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Invalid import file: a catalog appears twice' then raise; end if;
  end;
  begin
    perform menu_import_catalogs(jsonb_set(v_payload, '{catalogs,1,products,0,prices,0,priceSen}', '-1'::jsonb));
    raise exception 'FAIL J4: a negative price was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Invalid import file: a catalog price is not a whole number of sen' then raise; end if;
  end;
  begin
    perform menu_import_catalogs(jsonb_set(v_payload, '{catalogs,1,products}',
      (v_payload #> '{catalogs,1,products}') || (v_payload #> '{catalogs,1,products,0}')));
    raise exception 'FAIL J4: a product listed twice in one catalog was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Invalid import file: a catalog lists a product twice' then raise; end if;
  end;
  -- J5. a Craft OS catalog of the same name that stands for another Feedme sheet is refused in plain words
  insert into menu_catalogs(name, feedme_catalog_name) values ('VERIFY Feedme D', 'VERIFY Elsewhere');
  begin
    perform menu_import_catalogs(jsonb_set(v_payload, '{catalogs,1,name}', '"VERIFY Feedme D"'::jsonb));
    raise exception 'FAIL J5: a catalog name clash was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Catalog VERIFY Feedme D already exists under another Feedme name' then raise; end if;
  end;

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
