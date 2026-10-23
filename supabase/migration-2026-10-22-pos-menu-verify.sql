-- Self-check for the POS menu migrations. Run on craft-os-dev after both
-- migration files. Everything is rolled back. Success = result row "VERIFY OK".
begin;

do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';
  r record;
begin
  -- A1. tables exist with RLS on and a read policy
  for r in select t from unnest(array['menu_categories','menu_products','menu_variants',
                                      'modifier_groups','modifier_options','product_modifier_groups']) as t loop
    if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                    where n.nspname = 'public' and c.relname = r.t and c.relrowsecurity) then
      raise exception 'FAIL schema: % missing or RLS off', r.t;
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = r.t
                      and policyname = 'menu_read' and cmd = 'SELECT') then
      raise exception 'FAIL rls: % has no menu_read policy', r.t;
    end if;
  end loop;

  -- A2. nobody but RPCs inserts or deletes (the six master tables; M1's catalog tables have their own checks)
  if exists (select 1 from pg_policies where schemaname = 'public'
              and tablename in ('menu_categories','menu_products','menu_variants',
                                'modifier_groups','modifier_options','product_modifier_groups')
              and cmd in ('INSERT','DELETE','ALL')) then
    raise exception 'FAIL rls: an insert/delete policy exists on a menu table';
  end if;

  -- A3. has_menu_cap: owner yes, anonymous no
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  if not has_menu_cap('access_settings') then raise exception 'FAIL cap: owner lacks access_settings'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  if has_menu_cap('access_settings') then raise exception 'FAIL cap: unknown user has access_settings'; end if;

  -- A4. defaults
  insert into menu_products(name, feedme_product_id) values ('verify product', 'verify-1') returning sst_rate_bp, availability into r;
  if r.sst_rate_bp <> 600 or r.availability <> 'all' then raise exception 'FAIL defaults: %', r; end if;

  raise notice 'VERIFY OK';
end $$;

do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';
  v_payload jsonb := $j${
    "categories": [{"name": "VERIFY COFFEE", "sortOrder": 0}, {"name": "ADDON", "sortOrder": 1}],
    "products": [
      {"feedmeId": "verify-latte", "name": "Verify Latte", "internalName": null, "description": null,
       "category": "VERIFY COFFEE", "availability": "all", "isAddon": false, "takeawayFeeSen": 100, "sortOrder": 0,
       "variants": [{"key": "v/hot", "name": "HOT", "priceSen": 1200, "sortOrder": 0},
                    {"key": "v/cold", "name": "COLD", "priceSen": 1300, "sortOrder": 1}]},
      {"feedmeId": "verify-oat", "name": "Oat milk", "internalName": null, "description": null,
       "category": "ADDON", "availability": "all", "isAddon": true, "takeawayFeeSen": 0, "sortOrder": 1,
       "variants": [{"key": "", "name": "Regular", "priceSen": 200, "sortOrder": 0}]}
    ],
    "groups": [{"feedmeId": "verify-milk", "name": "Milk", "min": 0, "max": 1, "stackable": false, "sortOrder": 0,
                "options": [{"productFeedmeId": "verify-oat", "variantKey": "", "name": "Oat milk", "priceSen": 200,
                             "isDefault": false, "availability": "all", "sortOrder": 0}]}],
    "links": [{"productFeedmeId": "verify-latte", "groupFeedmeId": "verify-milk", "sortOrder": 0}]
  }$j$;
  v_counts jsonb;
  v_latte uuid;
  n int;
begin
  -- B1. refused without access_settings
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated')::text, true);
  begin
    perform menu_import(v_payload);
    raise exception 'FAIL import: allowed without access_settings';
  exception when raise_exception then
    if sqlerrm not like 'Not allowed%' then raise; end if;
  end;

  -- B2. first import as owner
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_counts := menu_import(v_payload);
  if (v_counts->>'products')::int <> 2 or (v_counts->>'variants')::int <> 3
     or (v_counts->>'options')::int <> 1 or (v_counts->>'links')::int <> 1 then
    raise exception 'FAIL import counts: %', v_counts;
  end if;
  select id into v_latte from menu_products where feedme_product_id = 'verify-latte';

  -- B3. manager settings survive a re-import; price changes land; dropped variant is switched off
  update menu_products set sst_rate_bp = 0, print_route = 'Bar' where id = v_latte;
  v_payload := jsonb_set(v_payload, '{products,0,variants}',
                 '[{"key": "v/hot", "name": "HOT", "priceSen": 1250, "sortOrder": 0}]'::jsonb);
  perform menu_import(v_payload);
  if (select sst_rate_bp from menu_products where id = v_latte) <> 0
     or (select print_route from menu_products where id = v_latte) is distinct from 'Bar' then
    raise exception 'FAIL re-import: overwrote sst_rate_bp or print_route';
  end if;
  if (select price_sen from menu_variants where product_id = v_latte and feedme_variant_key = 'v/hot') is distinct from 1250 then
    raise exception 'FAIL re-import: price not updated';
  end if;
  if (select is_active from menu_variants where product_id = v_latte and feedme_variant_key = 'v/cold') is distinct from false then
    raise exception 'FAIL re-import: removed variant should be kept but inactive';
  end if;

  -- B4. idempotent: same payload again → same row counts in the tables
  perform menu_import(v_payload);
  select count(*) into n from menu_products where feedme_product_id in ('verify-latte', 'verify-oat');
  if n <> 2 then raise exception 'FAIL idempotent: % verify products', n; end if;
  select count(*) into n from modifier_options mo join modifier_groups mg on mg.id = mo.group_id where mg.feedme_group_id = 'verify-milk';
  if n <> 1 then raise exception 'FAIL idempotent: % options', n; end if;

  -- B5. option points at the add-on product
  if not exists (select 1 from modifier_options mo join menu_products mp on mp.id = mo.product_id
                  where mp.feedme_product_id = 'verify-oat') then
    raise exception 'FAIL options: option not linked to its add-on product';
  end if;

  -- B6. malformed payload
  begin
    perform menu_import('{"products": "nope"}'::jsonb);
    raise exception 'FAIL import: malformed payload accepted';
  exception when raise_exception then
    if sqlerrm not like 'Invalid import file%' then raise; end if;
  end;

  -- B7. grants: anon cannot call it, authenticated can (the cap check is the second gate)
  if has_function_privilege('anon', 'menu_import(jsonb)', 'execute') then
    raise exception 'FAIL grants: anon can execute menu_import';
  end if;
  if not has_function_privilege('authenticated', 'menu_import(jsonb)', 'execute') then
    raise exception 'FAIL grants: authenticated cannot execute menu_import';
  end if;

  -- B8. atomic: a bad group (max 0) aborts the whole call, leaving no new category behind
  begin
    perform menu_import(jsonb_build_object(
      'categories', jsonb_build_array(jsonb_build_object('name', 'VERIFY ATOMIC', 'sortOrder', 9)),
      'products', '[]'::jsonb, 'links', '[]'::jsonb,
      'groups', jsonb_build_array(jsonb_build_object('feedmeId', 'verify-bad', 'name', 'Bad', 'min', 0, 'max', 0,
                                                      'stackable', false, 'sortOrder', 0, 'options', '[]'::jsonb))));
    raise exception 'FAIL atomic: max 0 group was accepted';
  exception when check_violation then
    null;
  end;
  if exists (select 1 from menu_categories where name = 'VERIFY ATOMIC') then
    raise exception 'FAIL atomic: category survived a failed import';
  end if;

  -- B9. blank Feedme id is refused before any write
  begin
    perform menu_import(jsonb_build_object('categories', '[]'::jsonb, 'groups', '[]'::jsonb, 'links', '[]'::jsonb,
      'products', jsonb_build_array(jsonb_build_object('feedmeId', '', 'name', 'No id', 'category', 'ADDON',
        'availability', 'all', 'isAddon', false, 'takeawayFeeSen', 0, 'sortOrder', 0, 'variants', '[]'::jsonb))));
    raise exception 'FAIL blank id: accepted';
  exception when raise_exception then
    if sqlerrm not like 'Invalid import file: an item has no Feedme id%' then raise; end if;
  end;

  raise notice 'VERIFY OK (import)';
end $$;

do $$
declare
  r record;
  v_id uuid;
begin
  -- C1. permission matrix on real staff rows (inserted here, rolled back with everything else)
  for r in select * from (values
      ('owner', 'trainee', true), ('admin', 'trainee', true), ('manager', 'trainee', true),
      ('hr', 'trainee', false), ('supervisor', 'trainee', false), ('staff', 'trainee', false),
      ('staff', 'manager', false)) as m(role, rank, expected) loop  -- rank is not consulted
    v_id := gen_random_uuid();
    insert into auth.users (id) values (v_id);  -- staff.id references auth.users
    insert into staff (id, name, rank, onboarding_completed, joined_at, system_role)
    values (v_id, 'verify ' || r.role || '/' || r.rank, r.rank, true, current_date, r.role);
    perform set_config('request.jwt.claims', json_build_object('sub', v_id, 'role', 'authenticated')::text, true);
    if has_menu_cap('access_settings') is distinct from r.expected then
      raise exception 'FAIL cap matrix: role % rank % expected %', r.role, r.rank, r.expected;
    end if;
  end loop;

  -- C1b. the Owner's setting overrides the default both ways (same merge as buildRoleCaps)
  insert into system_role_permissions (system_role, permissions)
  values ('manager', '{"access_settings": false}'), ('hr', '{"access_settings": true}')
  on conflict (system_role) do update set permissions = excluded.permissions;
  for r in select * from (values ('manager', false), ('hr', true)) as m(role, expected) loop
    v_id := gen_random_uuid();
    insert into auth.users (id) values (v_id);
    insert into staff (id, name, rank, onboarding_completed, joined_at, system_role)
    values (v_id, 'verify override ' || r.role, 'trainee', true, current_date, r.role);
    perform set_config('request.jwt.claims', json_build_object('sub', v_id, 'role', 'authenticated')::text, true);
    if has_menu_cap('access_settings') is distinct from r.expected then
      raise exception 'FAIL cap override: role % expected %', r.role, r.expected;
    end if;
  end loop;

  -- C2. the two edit policies exist, are UPDATE-only and gated on has_menu_cap
  for r in select t from unnest(array['menu_products','menu_variants']) as t loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = r.t
                      and policyname = r.t || '_edit' and cmd = 'UPDATE'
                      and qual like '%has_menu_cap%' and with_check like '%has_menu_cap%') then
      raise exception 'FAIL rls: %_edit policy missing or not gated on has_menu_cap', r.t;
    end if;
  end loop;

  raise notice 'VERIFY OK (permissions)';
end $$;

select 'VERIFY OK' as result;

rollback;
