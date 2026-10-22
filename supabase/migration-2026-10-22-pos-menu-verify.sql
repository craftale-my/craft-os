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

  -- A2. nobody but RPCs inserts or deletes
  if exists (select 1 from pg_policies where schemaname = 'public'
              and tablename like any (array['menu_%','modifier_%','product_modifier_groups'])
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

select 'VERIFY OK' as result;

rollback;
