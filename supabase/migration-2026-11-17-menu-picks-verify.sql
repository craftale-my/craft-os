-- Self-check for menu picks. Run on craft-os-dev after migration-2026-11-17-menu-picks.sql.
-- Everything is rolled back. Success = a result row "VERIFY OK".
-- Sections: A schema and grants; B the rules; C cold start (recommended only) and the editor
-- switch; D picks from sales; E the cache and the three entry points.
--
-- The seed: outlet VERIFY P (tables P1 open, P2 paused, P3 switched off), products coded by one letter:
--   COFFEE  L Latte · M Mocha · A Americano · T Tea (recommended) · X Matcha (recommended, never sold)
--           H Shot (an add-on product)
--   CAKE    C Cheesecake · B Brownie
--   BREAD   R Croissant · G Bagel (recommended) · S Scone
--   groups  MILK (oat, dairy, soy) · SUGAR (less, normal) · TOPPING (berry, choco, plain, caramel)
-- A line is 'CODE[*qty][:opt[+opt]][!]' — '!' = voided. One inner array = one order; one call = one bill.
--
-- Expected, worked by hand (paid bills of VERIFY P, items not voided, add-ons left out):
--   units, last 30 days: L 40 · C 15 · M 12 · R 9 · A 7 · B 6 · T 4 · G 3 · S 3 · X 0
--   Popular: the recommended by units T G X, then the top 6 sellers L C M R A B, cut at 8
--            → T G X L C M R A   (S out by the top 6, B out by the 8)
--   orders (one guest's basket), last 60 days: L 32 · C 15 · R 9 · M 8 · B 7 · A 5 · G 3 · S 3 · T 2
--   pairs:  L → C R    (C 10, R 6; M is the same category; B 2 shared < 3; S 3/32 < 10 %)
--           A → C B G  (C 5, B 4, R 3, G 3: top 3, the tie goes by name — Bagel before Croissant)
--           C → L A G  · B → A G R · R → L A B · G → A B C · S → L (3/3 >= 10 %)
--           M, T, X → G C R (no pair of their own: Popular without COFFEE, first 3)
--   Most picked, last 60 days: L MILK oat 18/40 = 45 %, ahead of dairy 14 → oat
--           L SUGAR 6 units answered (< 10) → none · M MILK oat 6, dairy 6 (a tie) → none
--           C TOPPING berry 5/15 = 33 % (< 40 %) → none
--   Noise that must not count: a voided L*5:dairy and B*20, an add-on H*20, an open bill (C*20 C*20),
--   a voided bill (T*10), a merged bill (S*20), a paid bill 45 days ago (B*10 — in the 60-day windows
--   only), one 90 days ago (M*20:dairy C), and outlet VERIFY P2 (29 bills of R, 1 of S*2).
--   Orders of one bill must not pair: bills hold M with C orders (m1|c1 …) — a bill grain would give M → C.
begin;

-- expect_error(sql, message, label): runs sql and insists it raises exactly message.
create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  execute p_sql;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message using errcode = 'assert_failure';
exception when raise_exception then
  if sqlerrm is distinct from p_message then
    raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
  end if;
end $$;

-- act(user id): the next calls run as this signed-in user
create function pg_temp.act(p_user uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

create temp table vp_codes (code text primary key, product_id uuid not null);
create temp table vp_opts  (code text primary key, option_id uuid not null);

-- ids('T G X') → those products' ids as a jsonb array of text, in that order
create function pg_temp.ids(p_codes text) returns jsonb language sql as $$
  select coalesce(jsonb_agg(c.product_id::text order by x.ord), '[]'::jsonb)
    from unnest(string_to_array(p_codes, ' ')) with ordinality as x(code, ord)
    join vp_codes c on c.code = x.code
$$;
-- codes(array) → 'T G X' (a product outside the seed shows as ?), for the failure messages
create function pg_temp.codes(p jsonb) returns text language sql as $$
  select coalesce(string_agg(coalesce(c.code, '?'), ' ' order by x.ord), '')
    from jsonb_array_elements_text(coalesce(p, '[]'::jsonb)) with ordinality as x(id, ord)
    left join vp_codes c on c.product_id::text = x.id
$$;
create function pg_temp.pid(p_code text) returns text language sql as $$
  select product_id::text from vp_codes where code = p_code
$$;
-- list(label, got, 'T G X'): got must be exactly those products, in that order
create function pg_temp.list(p_label text, p_got jsonb, p_want text) returns void language plpgsql as $$
begin
  if p_got is distinct from pg_temp.ids(p_want) then
    raise exception 'FAIL %: got [%] (expected [%])', p_label, pg_temp.codes(p_got), p_want;
  end if;
end $$;

-- sell(outlet, status, days ago, orders): one bill closed p_days ago (open bills: not closed), one
-- order per inner array, one item per line 'CODE[*qty][:opt[+opt]][!]'
create function pg_temp.sell(p_branch uuid, p_status text, p_days integer, p_orders jsonb) returns uuid
language plpgsql as $$
declare
  v_bill uuid; v_order uuid; o jsonb; l text; m text[]; v_k integer := 0;
  v_at timestamptz := now() - make_interval(days => p_days);
begin
  insert into bills(branch_id, bill_no, order_type, status, opened_at, closed_at)
  values (p_branch, 'VP-' || substr(md5(random()::text), 1, 10), 'takeaway', p_status, v_at,
          case when p_status = 'open' then null else v_at end)
  returning id into v_bill;
  for o in select * from jsonb_array_elements(p_orders) loop
    v_k := v_k + 1;
    insert into orders(bill_id, branch_id, order_no, source, client_order_id, placed_at)
    values (v_bill, p_branch, v_k::text, 'counter', gen_random_uuid(), v_at)
    returning id into v_order;
    for l in select * from jsonb_array_elements_text(o) loop
      m := regexp_match(l, '^([A-Z])(?:\*(\d+))?(?::([a-z+]+))?(!)?$');
      if m is null then raise exception 'seed: bad line %', l; end if;
      if m[3] is not null and exists (select 1 from unnest(string_to_array(m[3], '+')) n(code)
                                       where not exists (select 1 from vp_opts vo where vo.code = n.code)) then
        raise exception 'seed: unknown option in %', l;
      end if;
      insert into order_items(order_id, bill_id, product_id, name_snapshot, unit_price_sen, sst_rate_bp, qty,
                              modifiers_snapshot, voided_at)
      select v_order, v_bill, c.product_id, c.code, 1000, 0, coalesce(m[2]::integer, 1),
             coalesce((select jsonb_agg(jsonb_build_object('optionId', vo.option_id, 'group', 'seed', 'name', vo.code,
                                                           'priceDeltaSen', 0, 'route', null) order by n.ord)
                         from unnest(string_to_array(m[3], '+')) with ordinality as n(code, ord)
                         join vp_opts vo on vo.code = n.code), '[]'::jsonb),
             case when m[4] = '!' then now() end
        from vp_codes c where c.code = m[1];
      if not found then raise exception 'seed: unknown product %', m[1]; end if;
    end loop;
  end loop;
  return v_bill;
end $$;

do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_staff uuid := 'eeeeeeee-0000-0000-0000-0000000000b1';   -- a staff login of VERIFY P, without Edit menu
  v_v uuid; v_p2 uuid; v_tok1 text; v_tok2 text; v_tok3 text;
  v_coffee uuid; v_cake uuid; v_bread uuid; v_milk uuid; v_sugar uuid; v_top uuid; v_id uuid;
  k record; r record; v jsonb; i integer;
begin
  -- ── A. schema and grants ──────────────────────────────────────────────────
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'menu_products' and column_name = 'is_recommended'
                    and data_type = 'boolean' and is_nullable = 'NO' and column_default = 'false') then
    raise exception 'FAIL schema: menu_products.is_recommended (boolean not null default false) is missing';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.menu_picks_cache'::regclass)
     or exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'menu_picks_cache')
     or has_table_privilege('anon', 'public.menu_picks_cache', 'select')
     or has_table_privilege('authenticated', 'public.menu_picks_cache', 'select')
     or has_table_privilege('authenticated', 'public.menu_picks_cache', 'insert') then
    raise exception 'FAIL rls: menu_picks_cache must have RLS on, no policy and no client privilege';
  end if;
  for r in select * from (values
      ('pos_picks_rules()', false, false),
      ('pos_compute_picks(uuid)', false, false),
      ('pos_menu_picks_for(uuid)', false, false),
      ('qr_picks(text)', true, true),
      ('pos_menu_picks()', false, true),
      ('set_product_recommended(uuid,boolean)', false, true),
      ('menu_product_extras(uuid)', false, true)) as x(fn, anon_ok, auth_ok) loop
    if has_function_privilege('anon', r.fn, 'execute') <> r.anon_ok
       or has_function_privilege('authenticated', r.fn, 'execute') <> r.auth_ok then
      raise exception 'FAIL grants: % (anon %, authenticated %)', r.fn,
        has_function_privilege('anon', r.fn, 'execute'), has_function_privilege('authenticated', r.fn, 'execute');
    end if;
  end loop;
  if (select count(*) from pg_proc p
       where p.pronamespace = 'public'::regnamespace
         and p.proname in ('pos_picks_rules', 'pos_compute_picks', 'pos_menu_picks_for', 'qr_picks', 'pos_menu_picks', 'set_product_recommended')
         and p.prosecdef and p.proconfig @> array['search_path=public, pg_temp']) <> 6 then
    raise exception 'FAIL functions: each picks function must exist once, security definer, search_path = public, pg_temp';
  end if;
  if (select provolatile from pg_proc where oid = 'qr_picks(text)'::regprocedure) <> 'v'
     or (select provolatile from pg_proc where oid = 'pos_menu_picks()'::regprocedure) <> 'v' then
    raise exception 'FAIL volatility: qr_picks and pos_menu_picks write the cache, so they must be volatile';
  end if;

  -- ── B. the rules (spec §2) ────────────────────────────────────────────────
  select * into k from pos_picks_rules();
  if (k.popular_days, k.popular_min_bills, k.popular_top, k.popular_min_units, k.popular_max,
      k.pair_days, k.pair_min_shared, k.pair_min_share, k.pair_top,
      k.picked_days, k.picked_min_units, k.picked_min_share, k.cache_minutes)
     is distinct from (30, 30, 6, 3, 8, 60, 3, 0.10, 3, 60, 10, 0.40, 30) then
    raise exception 'FAIL rules: %', row_to_json(k);
  end if;

  -- ── fixture ───────────────────────────────────────────────────────────────
  update system_role_permissions set permissions = permissions - 'manage_menu' where true;   -- code defaults: owner yes, staff no
  update menu_products set is_recommended = false where is_recommended;                     -- dev's own ticks would join Popular
  insert into branches(name, address) values ('VERIFY P', 'p') returning id into v_v;
  insert into branches(name, address) values ('VERIFY P2', 'p2') returning id into v_p2;
  insert into dining_tables(branch_id, label) values (v_v, 'P1') returning qr_token into v_tok1;
  insert into dining_tables(branch_id, label, qr_paused) values (v_v, 'P2', true) returning qr_token into v_tok2;
  insert into dining_tables(branch_id, label, is_active) values (v_v, 'P3', false) returning qr_token into v_tok3;
  insert into menu_categories(name, sort_order) values ('VP COFFEE', 901) returning id into v_coffee;
  insert into menu_categories(name, sort_order) values ('VP CAKE', 902) returning id into v_cake;
  insert into menu_categories(name, sort_order) values ('VP BREAD', 903) returning id into v_bread;
  for r in select * from (values
      ('L', 'VP Latte', 'coffee', false), ('M', 'VP Mocha', 'coffee', false), ('A', 'VP Americano', 'coffee', false),
      ('T', 'VP Tea', 'coffee', false), ('X', 'VP Matcha', 'coffee', false), ('H', 'VP Shot', 'coffee', true),
      ('C', 'VP Cheesecake', 'cake', false), ('B', 'VP Brownie', 'cake', false),
      ('R', 'VP Croissant', 'bread', false), ('G', 'VP Bagel', 'bread', false), ('S', 'VP Scone', 'bread', false)
    ) as x(code, name, cat, addon) loop
    insert into menu_products(name, category_id, is_addon)
    values (r.name, case r.cat when 'coffee' then v_coffee when 'cake' then v_cake else v_bread end, r.addon)
    returning id into v_id;
    insert into vp_codes values (r.code, v_id);
  end loop;
  insert into modifier_groups(name, min_select, max_select) values ('VP MILK', 1, 1) returning id into v_milk;
  insert into modifier_groups(name, min_select, max_select) values ('VP SUGAR', 0, 1) returning id into v_sugar;
  insert into modifier_groups(name, min_select, max_select) values ('VP TOPPING', 0, 1) returning id into v_top;
  for r in select * from (values ('oat', 'milk'), ('dairy', 'milk'), ('soy', 'milk'), ('less', 'sugar'), ('normal', 'sugar'),
                                  ('berry', 'top'), ('choco', 'top'), ('plain', 'top'), ('caramel', 'top')) as x(code, grp) loop
    insert into modifier_options(group_id, name)
    values (case r.grp when 'milk' then v_milk when 'sugar' then v_sugar else v_top end, r.code)
    returning id into v_id;
    insert into vp_opts values (r.code, v_id);
  end loop;
  update staff set branch_id = v_v where id = v_owner;
  insert into auth.users (id) values (v_staff);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id)
  values (v_staff, 'Verify P Staff', 'trainee', true, current_date, 'staff', v_v);

  -- ── C. cold start: only what a manager recommends; the switch ─────────────
  delete from menu_picks_cache where true;
  insert into menu_picks_cache(branch_id, computed_at, payload) values (v_p2, now(), '{"marker": "P2"}');
  perform pg_temp.act(v_staff);
  perform pg_temp.expect_error(format('select set_product_recommended(%L, true)', pg_temp.pid('T')),
    'Not allowed to edit the menu', 'C staff without Edit menu');
  perform pg_temp.act(v_owner);
  perform pg_temp.expect_error(format('select set_product_recommended(%L, true)', gen_random_uuid()),
    'Product not found', 'C unknown product');
  perform set_product_recommended(pg_temp.pid('T')::uuid, true);
  perform set_product_recommended(pg_temp.pid('G')::uuid, true);
  perform set_product_recommended(pg_temp.pid('X')::uuid, true);
  if exists (select 1 from menu_picks_cache) then
    raise exception 'FAIL C: set_product_recommended must clear every outlet''s cache row';
  end if;
  if (menu_product_extras(pg_temp.pid('G')::uuid)->>'isRecommended') is distinct from 'true'
     or (menu_product_extras(pg_temp.pid('L')::uuid)->>'isRecommended') is distinct from 'false' then
    raise exception 'FAIL C: menu_product_extras must return isRecommended';
  end if;
  v := pos_compute_picks(v_v);
  if (v->'fromSales') is distinct from 'false'::jsonb then raise exception 'FAIL C fromSales: %', v->'fromSales'; end if;
  perform pg_temp.list('C popular (no sales: the recommended, by name)', v->'popular', 'G X T');
  perform pg_temp.list('C pairs of L (COFFEE): fallback', (v->'pairs')->pg_temp.pid('L'), 'G');
  perform pg_temp.list('C pairs of C (CAKE): fallback', (v->'pairs')->pg_temp.pid('C'), 'G X T');
  perform pg_temp.list('C pairs of G (BREAD): fallback', (v->'pairs')->pg_temp.pid('G'), 'X T');
  if (v->'pairs') ? pg_temp.pid('H') then raise exception 'FAIL C: an add-on product gets no pairs'; end if;
  if (v->'mostPicked') is distinct from '{}'::jsonb then raise exception 'FAIL C mostPicked: %', v->'mostPicked'; end if;

  -- ── D. picks from sales ───────────────────────────────────────────────────
  -- noise first: none of it may count anywhere (see the header)
  perform pg_temp.sell(v_v, 'open',    1, '[["C*20","C*20"]]');
  perform pg_temp.sell(v_v, 'voided',  1, '[["T*10"]]');
  perform pg_temp.sell(v_v, 'merged',  1, '[["S*20"]]');
  perform pg_temp.sell(v_v, 'paid',   45, '[["B*10"]]');
  perform pg_temp.sell(v_v, 'paid',   90, '[["M*20:dairy","C"]]');
  for i in 1..29 loop perform pg_temp.sell(v_p2, 'paid', 1, '[["R"]]'); end loop;
  perform pg_temp.sell(v_p2, 'paid', 1, '[["S*2"]]');
  -- the five A bills
  perform pg_temp.sell(v_v, 'paid', 1, '[["A*2","C:berry","B","R","G"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["A*2","C:berry","B","R","G"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["A","C:berry","B","R","G"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["A","C:choco","B"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["A","C:choco"]]');
  -- nine bills of two orders each (the second order never pairs with the first)
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:oat","M*2:oat"],["L*2:oat","C:berry"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:oat","M*2:oat"],["L*2:oat","C:berry"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:oat","M:oat"],["L*2:oat","C:choco"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:dairy","M:oat"],["L*2:dairy","R"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:dairy","M*2:dairy"],["L*2:dairy","R"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:dairy","M*2:dairy"],["L*2:dairy","B"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["T*2"],["L*2:soy","S"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["T*2"],["L:dairy+less"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:soy","M:dairy"],["L:oat+normal","C:choco"]]');
  -- fifteen bills of one order
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:soy","M:dairy"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:oat+normal","C:plain"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:oat","C:plain"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:dairy","C:plain"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:dairy","C:caramel"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:dairy","C:caramel"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:soy","C:caramel"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:oat","R"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:oat","R"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:soy","R"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:soy","R"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:oat","B"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:dairy","S"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:oat","S"]]');
  perform pg_temp.sell(v_v, 'paid', 1, '[["L*2:oat+less","L*5:dairy!","H*20","B*20!"]]');
  -- 29 paid bills in the last 30 days (the 45- and 90-day ones are older): Popular is still the recommended only
  v := pos_compute_picks(v_v);
  if (v->'fromSales') is distinct from 'false'::jsonb then raise exception 'FAIL D: 29 paid bills are not enough: %', v->'fromSales'; end if;
  perform pg_temp.list('D popular at 29 bills (the recommended, by units)', v->'popular', 'T G X');
  -- the 30th
  perform pg_temp.sell(v_v, 'paid', 1, '[["L:soy+less"]]');
  v := pos_compute_picks(v_v);
  if (v->'fromSales') is distinct from 'true'::jsonb then raise exception 'FAIL D: 30 paid bills are enough: %', v->'fromSales'; end if;
  perform pg_temp.list('D popular', v->'popular', 'T G X L C M R A');
  perform pg_temp.list('D pairs of L', (v->'pairs')->pg_temp.pid('L'), 'C R');
  perform pg_temp.list('D pairs of A', (v->'pairs')->pg_temp.pid('A'), 'C B G');
  perform pg_temp.list('D pairs of C', (v->'pairs')->pg_temp.pid('C'), 'L A G');
  perform pg_temp.list('D pairs of B', (v->'pairs')->pg_temp.pid('B'), 'A G R');
  perform pg_temp.list('D pairs of R', (v->'pairs')->pg_temp.pid('R'), 'L A B');
  perform pg_temp.list('D pairs of G', (v->'pairs')->pg_temp.pid('G'), 'A B C');
  perform pg_temp.list('D pairs of S', (v->'pairs')->pg_temp.pid('S'), 'L');
  perform pg_temp.list('D pairs of M (fallback)', (v->'pairs')->pg_temp.pid('M'), 'G C R');
  perform pg_temp.list('D pairs of T (fallback)', (v->'pairs')->pg_temp.pid('T'), 'G C R');
  perform pg_temp.list('D pairs of X (fallback)', (v->'pairs')->pg_temp.pid('X'), 'G C R');
  if (v->'pairs') ? pg_temp.pid('H') then raise exception 'FAIL D: an add-on product gets no pairs'; end if;
  if (v->'mostPicked') is distinct from jsonb_build_object(pg_temp.pid('L'),
       jsonb_build_object(v_milk::text, (select option_id::text from vp_opts where code = 'oat'))) then
    raise exception 'FAIL D mostPicked: % (expected only L MILK → oat)', v->'mostPicked';
  end if;
  v := pos_compute_picks(v_p2);
  if (v->'fromSales') is distinct from 'true'::jsonb then raise exception 'FAIL D: VERIFY P2 has 30 paid bills'; end if;
  perform pg_temp.list('D popular of VERIFY P2 (S has 2 units < 3)', v->'popular', 'G X T R');

  -- ── E. the cache and the three entry points ───────────────────────────────
  delete from menu_picks_cache where true;
  v := qr_picks(v_tok1);
  if v is distinct from pos_compute_picks(v_v) then raise exception 'FAIL E: qr_picks must return the table''s outlet''s picks'; end if;
  if not exists (select 1 from menu_picks_cache where branch_id = v_v and computed_at = now() and payload = v) then
    raise exception 'FAIL E: the first read must store the cache';
  end if;
  update menu_picks_cache set payload = '{"marker": "cached"}' where branch_id = v_v;
  if qr_picks(v_tok1) is distinct from '{"marker": "cached"}'::jsonb then
    raise exception 'FAIL E: a cache younger than 30 minutes must be reused';
  end if;
  perform pg_temp.act(v_owner);
  if pos_menu_picks() is distinct from '{"marker": "cached"}'::jsonb then
    raise exception 'FAIL E: pos_menu_picks must read the caller''s outlet (VERIFY P) through the cache';
  end if;
  update menu_picks_cache set computed_at = now() - interval '31 minutes' where branch_id = v_v;
  v := qr_picks(v_tok1);                       -- its own statement: a sub-select in the same statement would not see the cache row the call just wrote
  if v is distinct from pos_compute_picks(v_v)
     or (select payload from menu_picks_cache where branch_id = v_v) is distinct from pos_compute_picks(v_v) then
    raise exception 'FAIL E: a cache older than 30 minutes must be computed again and stored';
  end if;
  update menu_picks_cache set payload = '{"marker": "cached"}' where branch_id = v_v;
  perform set_product_recommended(pg_temp.pid('S')::uuid, true);
  v := pos_menu_picks();
  perform pg_temp.list('E popular after recommending S (recomputed)', v->'popular', 'T G S X L C M R');
  if qr_picks('no-such-token') is not null then raise exception 'FAIL E: an unknown token gives null'; end if;
  if qr_picks(v_tok2) is not null then raise exception 'FAIL E: a paused table gives null'; end if;
  if qr_picks(v_tok3) is not null then raise exception 'FAIL E: a switched-off table gives null'; end if;
  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
