-- Self-check for members (phone sign-in and points). Run on craft-os-dev after
-- migration-2026-11-23-members.sql. Everything is rolled back. Success = a result row "VERIFY OK".
-- Sections (one DO block each, ids in the temp table fixture): FIXTURE; M1 schema, grants, security definer;
-- M2 phone normalise / mask; M3 counter attach and earn; M4 refunds; M5 merge and split; M6 sign-in codes
-- (a live table, limits, tries by IP); M7 tokens and linking a table; M8 owner and back office; M9 real anon / authenticated callers.
-- Each section ends by ticking pg_temp.sections; the last DO block raises unless all 10 ticked, so an
-- error that a client skips over can never reach the final "VERIFY OK".
-- Outlet VERIFY MEM: no service charge, not SST registered, 5 sen rounding. Latte 10.50, Sugar 0.50,
-- Cake 8.00, no print route. A card and a cash method, a cashier and a supervisor with PINs, one tablet
-- signed in, a shift open. The earn rate is set to 1 for the run.
begin;

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
create function pg_temp.act(p_user uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
create function pg_temp.check(p_cond boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAIL %', p_label; end if;
end $$;
create temp table fixture (k text primary key, v uuid);
create temp table sections (name text primary key);
create function pg_temp.done(p_name text) returns void
language sql as $$ insert into pg_temp.sections(name) values (p_name) $$;
create function pg_temp.put(p_k text, p_v uuid) returns void
language sql as $$ insert into pg_temp.fixture(k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.id(p_k text) returns uuid
language sql as $$ select v from pg_temp.fixture where k = p_k $$;
create function pg_temp.pay(p_method text, p_sen integer) returns jsonb
language sql as $$
  select jsonb_build_array(jsonb_build_object('methodId', pg_temp.id(p_method), 'amountSen', p_sen))
$$;
-- one counter order: p_table null = takeaway; returns the bill id
create function pg_temp.bill(p_table text, p_keys text[]) returns uuid
language plpgsql as $$
declare
  v_order uuid;
begin
  v_order := place_counter_order(
           pg_temp.id(p_table), case when p_table is null then 'takeaway' else 'dine_in' end, null,
           (select jsonb_agg(jsonb_build_object('productId', pg_temp.id(k), 'variantId', pg_temp.id(k || '_v'), 'qty', 1)
                             order by o)
              from unnest(p_keys) with ordinality as x(k, o)),
           gen_random_uuid());
  return (select bill_id from orders where id = v_order);
end $$;
-- pay a whole bill by card at its total
create function pg_temp.pay_bill(p_bill uuid) returns jsonb
language sql as $$
  select checkout_bill(p_bill, pg_temp.pay('card', (pos_bill_totals(p_bill)->>'totalSen')::integer), gen_random_uuid())
$$;
create function pg_temp.hash(p_text text) returns text
language sql as $$ select encode(extensions.digest(p_text, 'sha256'), 'hex') $$;
create function pg_temp.bal(p_phone text) returns integer
language sql as $$ select points from members where phone = p_phone and deleted_at is null $$;
create function pg_temp.sum_ok(p_phone text) returns boolean
language sql as $$
  select m.points = coalesce((select sum(points) from member_points where member_id = m.id), 0)
    from members m where m.phone = p_phone and m.deleted_at is null
$$;

-- ── FIXTURE ──
do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-0000000009c1';
  v_sup   uuid := 'eeeeeeee-0000-0000-0000-0000000009c2';
  v_dev   uuid := 'eeeeeeee-0000-0000-0000-0000000009c3';
  v_a uuid; v_t uuid; v_cat uuid; v_catalog uuid; v_p uuid; v_v uuid; v_res jsonb; r record; i integer;
begin
  -- the role defaults decide (owner: every outlet and access_settings; staff: neither)
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;
  update member_settings set rate = 1, qr_enabled = true, sms_daily_cap = 300, dev_codes_allowed = true where id;
  delete from member_otps where created_at > now() - interval '2 days';   -- the limits start from nothing
  delete from member_verify_fails where at > now() - interval '2 days';
  insert into branches(name, address) values ('VERIFY MEM', 'm') returning id into v_a;
  perform pg_temp.put('branch', v_a);
  for i in 1..9 loop
    insert into dining_tables(branch_id, label, sort_order) values (v_a, 'M' || i, i) returning id into v_t;
    perform pg_temp.put('m' || i, v_t);
  end loop;
  insert into branch_pos_settings(branch_id) values (v_a);
  insert into menu_categories(name, sort_order) values ('VERIFY MEM DRINKS', 912) returning id into v_cat;
  insert into menu_catalogs(name, sort_order) values ('VERIFY MEM MENU', 912) returning id into v_catalog;
  for r in select * from (values ('latte', 'Verify Mem Latte', 1050), ('sugar', 'Verify Mem Sugar', 50),
                                 ('cake', 'Verify Mem Cake', 800)) as x(k, name, sen) loop
    insert into menu_products(name, category_id, sst_rate_bp) values (r.name, v_cat, 0) returning id into v_p;
    insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_p, '', 'Regular', r.sen) returning id into v_v;
    insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_p, 'all');
    insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_v, r.sen);
    perform pg_temp.put(r.k, v_p); perform pg_temp.put(r.k || '_v', v_v);
  end loop;
  insert into branch_catalogs(branch_id, role, catalog_id) values (v_a, 'dine_in', v_catalog), (v_a, 'takeaway', v_catalog), (v_a, 'qr', v_catalog);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_a, 'MEM Card', 'card', 1) returning id into v_t;
  perform pg_temp.put('card', v_t);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_a, 'MEM Cash', 'cash', 2) returning id into v_t;
  perform pg_temp.put('cash', v_t);
  update staff set branch_id = v_a where id = v_owner;
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_cash), (v_sup), (v_dev);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_cash, 'Verify Mem Cashier',    'trainee', true, current_date, 'staff', v_a),
    (v_sup,  'Verify Mem Supervisor', 'trainee', true, current_date, 'staff', v_a);
  update staff set system_role = 'supervisor' where id = v_sup;
  for r in select * from (values (v_cash, '1111'), (v_sup, '2222')) as x(id, pin) loop
    perform pg_temp.act(r.id);
    if not coalesce((set_my_pos_pin(r.pin, null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: PIN of %', r.id; end if;
  end loop;
  insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by) values (v_dev, v_a, 'pos', 'MEM Counter', 'ipad', true, v_owner);
  perform pg_temp.put('owner', v_owner); perform pg_temp.put('sup', v_sup); perform pg_temp.put('cashier', v_cash);
  perform pg_temp.put('dev', v_dev);
  perform pg_temp.act(v_dev);
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: cashier sign-in: %', v_res; end if;
  v_res := open_shift(10000);
  if v_res->'shift'->>'id' is null then raise exception 'FAIL fixture: no shift: %', v_res; end if;
  perform pg_temp.done('FIXTURE');
end $$;

-- ── M1. Schema and grants: RLS on, no table open to anon or staff; who may call what; security definer ──
do $$
declare
  t    text;
  role text;
  priv text;
  r    record;
  v_n  integer := 0;
begin
  foreach t in array array['members', 'member_points', 'member_tokens', 'member_otps', 'member_settings', 'member_bill_events',
                           'member_earn_failures', 'member_verify_fails'] loop
    perform pg_temp.check((select relrowsecurity from pg_class where oid = t::regclass), 'M1 RLS on ' || t);
    perform pg_temp.check(not exists (select 1 from pg_policies where tablename = t), 'M1 no policy on ' || t);
    foreach role in array array['anon', 'authenticated'] loop
      foreach priv in array array['select', 'insert', 'update', 'delete'] loop
        perform pg_temp.check(not has_table_privilege(role, t, priv), format('M1 %s has no %s on %s', role, priv, t));
      end loop;
    end loop;
  end loop;
  perform pg_temp.check(exists (select 1 from information_schema.columns where table_name = 'bills' and column_name = 'member_id'), 'M1 bills.member_id');
  perform pg_temp.check((select convalidated from pg_constraint where conname = 'bills_member_id_fkey' and conrelid = 'bills'::regclass),
                        'M1 bills.member_id foreign key, validated');
  perform pg_temp.check(to_regclass('member_points_bill') is not null, 'M1 index member_points(bill_id)');
  perform pg_temp.check(to_regprocedure('member_link_table(text,text)') is null, 'M1 the 2-argument member_link_table is gone');
  foreach t in array array['member_me(text)', 'member_sign_out(text)', 'member_link_table(text,uuid,text)', 'member_public_settings()'] loop
    perform pg_temp.check(has_function_privilege('anon', t, 'execute'), 'M1 anon runs ' || t);
  end loop;
  foreach t in array array['pos_bill_set_member(uuid,text)', 'pos_bill_clear_member(uuid)', 'member_search(text,integer,integer)',
                           'member_ledger(uuid)', 'member_adjust(uuid,integer,text)', 'member_delete(uuid)',
                           'member_settings_get()', 'member_settings_set(numeric,boolean,integer)', 'member_earn_failures_list()'] loop
    perform pg_temp.check(not has_function_privilege('anon', t, 'execute'), 'M1 anon cannot run ' || t);
    perform pg_temp.check(has_function_privilege('authenticated', t, 'execute'), 'M1 staff run ' || t);
  end loop;
  perform pg_temp.check(to_regprocedure('member_otp_request(text,text,text,text)') is null
                        and to_regprocedure('member_otp_verify(text,text,text,text)') is null, 'M1 the 4-argument code functions are gone');
  perform pg_temp.check(exists (select 1 from information_schema.columns where table_name = 'member_otps' and column_name = 'table_id'),
                        'M1 member_otps.table_id');
  foreach t in array array['member_otp_request(text,text,text,text,text)', 'member_otp_verify(text,text,text,text,text)',
                           'member_otp_void(text,text)'] loop
    perform pg_temp.check(not has_function_privilege('anon', t, 'execute'), 'M1 anon cannot run ' || t);
    perform pg_temp.check(not has_function_privilege('authenticated', t, 'execute'), 'M1 staff cannot run ' || t);
    perform pg_temp.check(has_function_privilege('service_role', t, 'execute'), 'M1 service_role runs ' || t);
  end loop;
  foreach t in array array['member_phone_normalise(text)', 'member_phone_mask(text)', 'member_by_token(text)',
                           'member_points_add(uuid,text,integer,uuid,uuid,numeric,text,uuid)', 'member_settings_json()',
                           'member_require_back_office()', 'member_require_owner()',
                           'bills_member_on_status()', 'bills_member_inherit()', 'refunds_member_points()'] loop
    perform pg_temp.check(not has_function_privilege('anon', t, 'execute') and not has_function_privilege('authenticated', t, 'execute'),
                          'M1 helper closed ' || t);
  end loop;
  -- every member function and trigger function: security definer with its own search_path
  for r in select p.oid::regprocedure::text as f, p.prosecdef,
                  exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%') as has_path
             from pg_proc p
            where p.pronamespace = 'public'::regnamespace
              and (p.proname like 'member\_%' or p.proname in ('pos_bill_set_member', 'pos_bill_clear_member',
                                                               'bills_member_on_status', 'bills_member_inherit', 'refunds_member_points')) loop
    v_n := v_n + 1;
    perform pg_temp.check(r.prosecdef, 'M1 security definer: ' || r.f);
    perform pg_temp.check(r.has_path, 'M1 search_path set: ' || r.f);
  end loop;
  perform pg_temp.check(v_n = 26, 'M1 the member functions counted: ' || v_n);
  perform pg_temp.check((select count(*) from member_settings) = 1, 'M1 one settings row');
  perform pg_temp.done('M1');
end $$;

-- ── M2. Phone numbers ──
do $$
declare
  r record;
begin
  for r in select * from (values
      ('0123456789', '+60123456789'), ('60123456789', '+60123456789'), ('+60123456789', '+60123456789'),
      ('012-345 6789', '+60123456789'), ('+60 12-345 6789', '+60123456789'), ('123456789', '+60123456789'),
      ('011-2345 6789', '+601123456789'), ('+601123456789', '+601123456789'),
      ('0312345678', null), ('+6531234567', null), ('01234567', null), ('012345678901', null),
      ('abc', null), ('', null),
      -- the review rules: +60 / 60 / 0060 then one optional 0; 011 has 8 more digits, other 01x 7
      ('+60 012-345 6789', '+60123456789'), ('+600123456789', '+60123456789'), ('0060123456789', '+60123456789'),
      ('00600123456789', '+60123456789'), ('01234567890', null), ('0112345678', null), ('011234567890', null),
      ('1123456789', '+601123456789'), ('+60 11-2345 6789', '+601123456789'), ('0060 11 2345 6789', '+601123456789'),
      ('+6000123456789', null), ('0123456789 ', '+60123456789'), ('+60', null), ('0', null)) as x(i, want) loop
    perform pg_temp.check(member_phone_normalise(r.i) is not distinct from r.want,
                          format('M2 normalise %s → %s (got %s)', r.i, r.want, member_phone_normalise(r.i)));
  end loop;
  perform pg_temp.check(member_phone_normalise(null) is null, 'M2 normalise null');
  perform pg_temp.check(member_phone_mask('+60123456789') = '+60 ••• ••6789', 'M2 mask');
  perform pg_temp.check(member_phone_mask('+601123456789') = '+60 ••• ••6789', 'M2 mask 011');
  perform pg_temp.check(member_phone_mask(null) is null, 'M2 mask null');
  perform pg_temp.done('M2');
end $$;

-- ── M3. The counter attaches a member; points on paid, once; 0 points; Staff Meal ──
do $$
declare
  v_b   uuid;
  v_res jsonb;
  v_n   integer;
begin
  perform pg_temp.act(pg_temp.id('dev'));
  -- takeaway Latte 10.50 → member A by a typed number
  v_b := pg_temp.bill(null, array['latte']);
  perform pg_temp.put('T1', v_b);
  v_res := pos_bill_set_member(v_b, '012-345 6789');
  perform pg_temp.check((v_res->>'isNew')::boolean and v_res->>'phone' = '+60123456789'
                        and v_res->>'phoneMasked' = '+60 ••• ••6789' and (v_res->>'points')::integer = 0, 'M3 a new member: ' || v_res::text);
  perform pg_temp.put('A', (v_res->>'memberId')::uuid);
  perform pg_temp.check((select member_id from bills where id = v_b) = pg_temp.id('A'), 'M3 the bill names the member');
  perform pg_temp.check(exists (select 1 from member_bill_events where bill_id = v_b and action = 'attach'
                                  and staff_id = pg_temp.id('cashier') and device_id = pg_temp.id('dev')), 'M3 attach logged with the staff id');
  perform pg_temp.expect_error(format('select pos_bill_set_member(%L, %L)', v_b, '0312345678'),
    'Enter a Malaysian mobile number, e.g. 012-345 6789.', 'M3 a landline');
  -- clear and attach again by another spelling: the same member, not new
  perform pos_bill_clear_member(v_b);
  perform pg_temp.check((select member_id from bills where id = v_b) is null, 'M3 cleared');
  v_res := pos_bill_set_member(v_b, '+60 12 345 6789');
  perform pg_temp.check(not (v_res->>'isNew')::boolean and (v_res->>'memberId')::uuid = pg_temp.id('A'), 'M3 the same member again');
  -- paid → one earn row floor(10.50) = 10
  v_res := pg_temp.pay_bill(v_b);
  perform pg_temp.check((select status from bills where id = v_b) = 'paid', 'M3 T1 paid: ' || v_res::text);
  perform pg_temp.check((select points from member_points where bill_id = v_b and kind = 'earn') = 10, 'M3 earn 10 for RM 10.50');
  perform pg_temp.check(pg_temp.bal('+60123456789') = 10, 'M3 balance 10');
  perform pg_temp.check((select last_visit_at from members where id = pg_temp.id('A')) is not null, 'M3 last visit set');
  -- the status written again: still one row
  update bills set status = 'paid' where id = v_b;
  update bills set status = 'paid', updated_at = now() where id = v_b;
  select count(*) into v_n from member_points where bill_id = v_b;
  perform pg_temp.check(v_n = 1 and pg_temp.bal('+60123456789') = 10, 'M3 a repeated close earns once');
  -- the member cannot change once paid
  perform pg_temp.expect_error(format('select pos_bill_set_member(%L, %L)', v_b, '0199999999'),
    'The member can only be changed on an open bill.', 'M3 set on a paid bill');
  perform pg_temp.expect_error(format('select pos_bill_clear_member(%L)', v_b),
    'The member can only be changed on an open bill.', 'M3 clear on a paid bill');
  -- a bill of another outlet / unknown
  perform pg_temp.expect_error(format('select pos_bill_set_member(%L, %L)', gen_random_uuid(), '0123456789'),
    'Bill not found', 'M3 unknown bill');
  -- 0 points: Sugar 0.50 writes no row
  v_b := pg_temp.bill(null, array['sugar']);
  perform pos_bill_set_member(v_b, '0123456789');
  perform pg_temp.pay_bill(v_b);
  perform pg_temp.check((select status from bills where id = v_b) = 'paid', 'M3 sugar bill paid');
  perform pg_temp.check(not exists (select 1 from member_points where bill_id = v_b), 'M3 a 0-point bill writes no row');
  perform pg_temp.check((select last_visit_at from members where id = pg_temp.id('A')) is not null, 'M3 last visit still set');
  -- Staff Meal: a live item ordered from a discounted catalog (its snapshot, as order_items_catalog_discount writes it)
  v_b := pg_temp.bill(null, array['latte', 'cake']);
  update order_items set catalog_discount_bp = 5000 where bill_id = v_b and product_id = pg_temp.id('cake');
  perform pos_bill_set_member(v_b, '0123456789');
  perform pg_temp.pay_bill(v_b);
  perform pg_temp.check((select status from bills where id = v_b) = 'paid', 'M3 staff meal bill paid');
  perform pg_temp.check(not exists (select 1 from member_points where bill_id = v_b), 'M3 a staff-meal bill earns nothing');
  -- a voided staff-meal line does not count: the rest earns
  v_b := pg_temp.bill(null, array['latte', 'cake']);
  update order_items set catalog_discount_bp = 5000, voided_at = now(), void_reason = 'verify'
   where bill_id = v_b and product_id = pg_temp.id('cake');
  perform pos_bill_set_member(v_b, '0123456789');
  perform pg_temp.pay_bill(v_b);
  perform pg_temp.check((select points from member_points where bill_id = v_b and kind = 'earn') = 10, 'M3 a voided staff-meal line does not block');
  perform pg_temp.check(pg_temp.bal('+60123456789') = 20 and pg_temp.sum_ok('+60123456789'), 'M3 balance 20 = the ledger');
  -- a bill without a member earns nothing, and a voided bill earns nothing
  v_b := pg_temp.bill(null, array['latte']);
  perform pg_temp.pay_bill(v_b);
  perform pg_temp.check(not exists (select 1 from member_points where bill_id = v_b), 'M3 no member, no row');
  -- earn only on the transition: a member put on an already paid bill and the status written again → nothing
  update bills set member_id = pg_temp.id('A') where id = v_b;
  update bills set status = 'paid', updated_at = now() where id = v_b;
  perform pg_temp.check(not exists (select 1 from member_points where bill_id = v_b), 'M3 no earn without the transition to paid');
  update bills set member_id = null where id = v_b;
  v_b := pg_temp.bill(null, array['latte']);
  perform pos_bill_set_member(v_b, '0123456789');
  v_res := void_bill(v_b, 'verify', pg_temp.id('sup'), '2222');
  perform pg_temp.check(coalesce((v_res->>'ok')::boolean, false) and (select status from bills where id = v_b) = 'voided', 'M3 voided: ' || v_res::text);
  perform pg_temp.check(not exists (select 1 from member_points where bill_id = v_b), 'M3 a voided bill earns nothing');
  perform pg_temp.check(pg_temp.bal('+60123456789') = 20, 'M3 balance still 20 after the void');
  -- the earn can fail without failing the payment: the bill closes, the failure is recorded, no points
  alter table member_points add constraint verify_mem_force_fail check (kind <> 'earn') not valid;
  v_b := pg_temp.bill(null, array['latte']);
  perform pos_bill_set_member(v_b, '0123456789');
  v_res := pg_temp.pay_bill(v_b);
  perform pg_temp.check((select status from bills where id = v_b) = 'paid', 'M3 a failed earn still closes the bill: ' || v_res::text);
  perform pg_temp.check(not exists (select 1 from member_points where bill_id = v_b), 'M3 the failed earn wrote no row');
  perform pg_temp.check(pg_temp.bal('+60123456789') = 20 and pg_temp.sum_ok('+60123456789'), 'M3 the failed earn left the balance');
  perform pg_temp.check(exists (select 1 from member_earn_failures where bill_id = v_b and error like '%verify_mem_force_fail%'),
                        'M3 the failure is recorded');
  perform pg_temp.put('FAILED', v_b);
  alter table member_points drop constraint verify_mem_force_fail;
  perform pg_temp.done('M3');
end $$;

-- ── M4. Refunds: floor(refunded RM × rate), the bill's net and the balance never below zero ──
do $$
declare
  v_t1  uuid := pg_temp.id('T1');
  v_b   uuid;
  i     integer;
begin
  perform pg_temp.act(pg_temp.id('dev'));
  -- T1 earned 10; refund 5.50 → -5
  perform pg_temp.check(coalesce((refund_bill(gen_random_uuid(), v_t1, 550, pg_temp.id('card'), 'Cold', pg_temp.id('sup'), '2222')->>'ok')::boolean, false), 'M4 refund 5.50');
  perform pg_temp.check((select points from member_points where bill_id = v_t1 and kind = 'refund') = -5, 'M4 refund row -5');
  perform pg_temp.check(pg_temp.bal('+60123456789') = 15 and pg_temp.sum_ok('+60123456789'), 'M4 balance 15');
  -- a refund row inserted for the rest and more than the bill earned: capped at the bill's net (5)
  insert into refunds(id, bill_id, branch_id, amount_sen, method_name, approved_by, created_by)
  values (gen_random_uuid(), v_t1, pg_temp.id('branch'), 900, 'MEM Card', pg_temp.id('sup'), pg_temp.id('cashier'));
  perform pg_temp.check((select sum(points) from member_points where bill_id = v_t1) = 0, 'M4 the bill''s net stops at zero');
  insert into refunds(id, bill_id, branch_id, amount_sen, method_name, approved_by, created_by)
  values (gen_random_uuid(), v_t1, pg_temp.id('branch'), 100, 'MEM Card', pg_temp.id('sup'), pg_temp.id('cashier'));
  perform pg_temp.check((select count(*) from member_points where bill_id = v_t1) = 3, 'M4 nothing more once the bill is at zero');
  perform pg_temp.check(pg_temp.bal('+60123456789') = 10 and pg_temp.sum_ok('+60123456789'), 'M4 balance 10');
  -- the balance floors at zero: a new member earns 10, the owner takes 7 away, a full refund takes only 3
  v_b := pg_temp.bill(null, array['latte']);
  perform pos_bill_set_member(v_b, '0177777777');
  perform pg_temp.pay_bill(v_b);
  perform pg_temp.act(pg_temp.id('owner'));
  perform member_adjust((select id from members where phone = '+60177777777'), -7, 'verify');
  perform pg_temp.act(pg_temp.id('dev'));
  perform pg_temp.check(coalesce((refund_bill(gen_random_uuid(), v_b, 1050, pg_temp.id('card'), 'Wrong', pg_temp.id('sup'), '2222')->>'ok')::boolean, false), 'M4 full refund');
  perform pg_temp.check((select points from member_points where bill_id = v_b and kind = 'refund') = -3, 'M4 refund capped at the balance');
  perform pg_temp.check(pg_temp.bal('+60177777777') = 0 and pg_temp.sum_ok('+60177777777'), 'M4 balance 0');
  -- a refund of a bill that earned nothing writes nothing
  v_b := (select id from bills where branch_id = pg_temp.id('branch') and member_id is null and status = 'paid' limit 1);
  perform pg_temp.check(coalesce((refund_bill(gen_random_uuid(), v_b, 100, pg_temp.id('card'), 'x', pg_temp.id('sup'), '2222')->>'ok')::boolean, false), 'M4 refund a member-less bill');
  perform pg_temp.check(not exists (select 1 from member_points where bill_id = v_b), 'M4 no row for a bill that did not earn');
  -- by running total: RM 10.50 earns 10; ten refunds of RM 0.99 and one of RM 0.60 (RM 10.50 in all) end at 0,
  -- where each refund alone (floor 0.99 = 0) would have taken nothing
  v_b := pg_temp.bill(null, array['latte']);
  perform pos_bill_set_member(v_b, '0166666666');
  perform pg_temp.pay_bill(v_b);
  perform pg_temp.check(pg_temp.bal('+60166666666') = 10, 'M4 running total: earned 10');
  for i in 1..10 loop
    perform pg_temp.check(coalesce((refund_bill(gen_random_uuid(), v_b, 99, pg_temp.id('card'), 'bit', pg_temp.id('sup'), '2222')->>'ok')::boolean, false),
                          'M4 small refund ' || i);
    -- what the bill holds = floor((1050 − 99·i) / 100)
    perform pg_temp.check((select sum(points) from member_points where bill_id = v_b) = floor((1050 - 99 * i) / 100.0)::integer,
                          'M4 after small refund ' || i || ': ' || (select sum(points) from member_points where bill_id = v_b));
  end loop;
  perform pg_temp.check(coalesce((refund_bill(gen_random_uuid(), v_b, 60, pg_temp.id('card'), 'bit', pg_temp.id('sup'), '2222')->>'ok')::boolean, false),
                        'M4 the last 0.60');
  perform pg_temp.check((select sum(points) from member_points where bill_id = v_b) = 0
                        and pg_temp.bal('+60166666666') = 0 and pg_temp.sum_ok('+60166666666'), 'M4 running total ends at 0');
  perform pg_temp.done('M4');
end $$;

-- ── M5. Merge hands the member over; a split part inherits and earns its own share ──
do $$
declare
  v_from uuid; v_into uuid; v_b uuid; v_res jsonb; v_part uuid; v_item uuid; v_b_id uuid;
begin
  perform pg_temp.act(pg_temp.id('dev'));
  -- a takeaway bill with member A merged into table M1's bill that has none → M1's bill takes A
  v_from := pg_temp.bill(null, array['latte']);
  perform pos_bill_set_member(v_from, '0123456789');
  v_into := pg_temp.bill('m1', array['cake']);
  perform merge_bills(v_from, v_into);
  perform pg_temp.check((select status from bills where id = v_from) = 'merged', 'M5 merged');
  perform pg_temp.check((select member_id from bills where id = v_into) = pg_temp.id('A'), 'M5 the surviving bill takes the member');
  -- a bill with member B merged into one that has A → it keeps A
  v_res := pos_bill_set_member(pg_temp.bill(null, array['latte']), '0188888888');
  v_b_id := (v_res->>'memberId')::uuid;
  v_from := (select id from bills where member_id = v_b_id and status = 'open');
  perform merge_bills(v_from, v_into);
  perform pg_temp.check((select member_id from bills where id = v_into) = pg_temp.id('A'), 'M5 the surviving bill keeps its own member');
  -- paying the merged bill: A earns its total (10.50 + 8.00 + 10.50 = 29.00 → 29), the merged bills nothing
  perform pg_temp.pay_bill(v_into);
  perform pg_temp.check((select points from member_points where bill_id = v_into and kind = 'earn') = 29, 'M5 the merged bill earns 29');
  perform pg_temp.check(not exists (select 1 from member_points where member_id = v_b_id), 'M5 B earns nothing');
  -- split: table M2 Latte + Cake with member A; the Cake paid on its own → the part has A and earns 8
  v_b := pg_temp.bill('m2', array['latte', 'cake']);
  perform pos_bill_set_member(v_b, '0123456789');
  v_item := (select id from order_items where bill_id = v_b and product_id = pg_temp.id('cake'));
  v_res := checkout_items(v_b, jsonb_build_array(jsonb_build_object('itemId', v_item, 'qty', 1)),
                          pg_temp.pay('card', (pos_split_totals(v_b, jsonb_build_array(jsonb_build_object('itemId', v_item, 'qty', 1)))->>'totalSen')::integer),
                          gen_random_uuid());
  v_part := (v_res->>'billId')::uuid;
  perform pg_temp.check(v_part is not null and (select split_from from bills where id = v_part) = v_b, 'M5 a part was paid: ' || v_res::text);
  perform pg_temp.check((select member_id from bills where id = v_part) = pg_temp.id('A'), 'M5 the part carries the parent''s member');
  perform pg_temp.check((select points from member_points where bill_id = v_part and kind = 'earn') = 8, 'M5 the part earns its 8');
  perform pg_temp.check((select member_id from bills where id = v_b) = pg_temp.id('A') and (select status from bills where id = v_b) = 'open', 'M5 the parent keeps its member');
  perform pg_temp.pay_bill(v_b);
  perform pg_temp.check((select points from member_points where bill_id = v_b and kind = 'earn') = 10, 'M5 the rest earns 10');
  perform pg_temp.check(pg_temp.sum_ok('+60123456789'), 'M5 A''s balance = the ledger');
  perform pg_temp.done('M5');
end $$;

-- ── M6. Sign-in codes: a live table, limits, tries by IP, expiry (the Edge Function's calls) ──
do $$
declare
  i      integer;
  v      text;
  v_t9   text := (select qr_token from dining_tables where id = pg_temp.id('m9'));
  v_ida  uuid; v_ta text; v_tb text; v_tc text;
  v_otp  uuid;
begin
  -- spare tables for the per-IP and per-table limits
  insert into dining_tables(branch_id, label, sort_order) values (pg_temp.id('branch'), 'MA', 21) returning id, qr_token into v_ida, v_ta;
  insert into dining_tables(branch_id, label, sort_order) values (pg_temp.id('branch'), 'MB', 22) returning qr_token into v_tb;
  insert into dining_tables(branch_id, label, sort_order) values (pg_temp.id('branch'), 'MC', 23) returning qr_token into v_tc;
  -- a code is asked from a live QR table: none, unknown, QR-paused or inactive → 'disabled', nothing stored
  perform pg_temp.check(member_otp_request('0129876543', '10.0.0.1', pg_temp.hash('1'), null, null) = 'disabled', 'M6 no table → disabled');
  perform pg_temp.check(member_otp_request('0129876543', '10.0.0.1', pg_temp.hash('1'), null, 'nope') = 'disabled', 'M6 unknown table → disabled');
  update dining_tables set qr_paused = true where id = pg_temp.id('m9');
  perform pg_temp.check(member_otp_request('0129876543', '10.0.0.1', pg_temp.hash('1'), null, v_t9) = 'disabled', 'M6 QR-paused table → disabled');
  perform pg_temp.act(pg_temp.id('owner'));   -- the table's status is a manager's change (dining_tables_guard)
  update dining_tables set qr_paused = false, is_active = false where id = pg_temp.id('m9');
  perform pg_temp.check(member_otp_request('0129876543', '10.0.0.1', pg_temp.hash('1'), null, v_t9) = 'disabled', 'M6 inactive table → disabled');
  update dining_tables set is_active = true where id = pg_temp.id('m9');
  perform pg_temp.act(pg_temp.id('dev'));
  perform pg_temp.check(not exists (select 1 from member_otps where phone = '+60129876543'), 'M6 a refused table stores nothing');
  -- per number: 3 in 15 minutes, the 4th is refused
  for i in 1..3 loop
    perform pg_temp.check(member_otp_request('0129876543', '10.0.0.1', pg_temp.hash('11111' || i), '11111' || i, v_t9) = 'ok', 'M6 request ' || i);
  end loop;
  perform pg_temp.check(member_otp_request('0129876543', '10.0.0.2', pg_temp.hash('999999'), '999999', v_t9) = 'rate_number', 'M6 the 4th in 15 min → rate_number');
  perform pg_temp.check((select count(*) from member_otps where phone = '+60129876543') = 3, 'M6 the refused one is not stored');
  perform pg_temp.check((select dev_code from member_otps where phone = '+60129876543' order by created_at desc, id limit 1) is not null, 'M6 dev code stored');
  perform pg_temp.check((select bool_and(table_id = pg_temp.id('m9')) from member_otps where phone = '+60129876543'), 'M6 the table is stored on the code');
  -- per number per day: 10 in 24 hours (older rows moved back past 15 minutes)
  update member_otps set created_at = now() - interval '1 hour' where phone = '+60129876543';
  insert into member_otps(phone, code_hash, expires_at, created_at)
  select '+60129876543', pg_temp.hash('x'), now(), now() - interval '2 hours' from generate_series(1, 7);
  perform pg_temp.check(member_otp_request('0129876543', '10.0.0.3', pg_temp.hash('1'), null, v_t9) = 'rate_number', 'M6 the 11th in a day → rate_number');
  delete from member_otps where phone = '+60129876543';
  -- tries: 5 wrong from one IP answer 'wrong', its 6th (even the right code) 'locked'
  perform pg_temp.check(member_otp_request('0129876543', '10.0.0.1', pg_temp.hash('123456'), '123456', v_t9) = 'ok', 'M6 a fresh code');
  for i in 1..5 loop
    perform pg_temp.check(member_otp_verify('0129876543', pg_temp.hash('000000'), pg_temp.hash('tok-x' || i), 'iPhone', '10.0.0.66') = 'wrong', 'M6 wrong try ' || i);
  end loop;
  perform pg_temp.check(member_otp_verify('0129876543', pg_temp.hash('123456'), pg_temp.hash('tok-x6'), 'iPhone', '10.0.0.66') = 'locked', 'M6 the 6th try → locked');
  perform pg_temp.check(not exists (select 1 from members where phone = '+60129876543'), 'M6 no member from a locked code');
  perform pg_temp.check((select count(*) from member_verify_fails where ip = '10.0.0.66') = 5, 'M6 five wrong tries recorded for the IP');
  -- ... but another address keeps its own 5: a stranger cannot lock the guest out
  perform pg_temp.check(member_otp_verify('0129876543', pg_temp.hash('000001'), pg_temp.hash('tok-x7'), 'iPhone', '10.0.0.1') = 'wrong', 'M6 another IP: its own wrong try');
  perform pg_temp.check(member_otp_verify('0129876543', pg_temp.hash('123456'), pg_temp.hash('tok-x8'), 'iPhone', '10.0.0.1') = 'ok', 'M6 another IP: the right code still works');
  delete from member_tokens where token_hash = pg_temp.hash('tok-x8');
  delete from members where phone = '+60129876543';
  -- per IP: more than 20 wrong codes in an hour → 'locked' before any code is read
  delete from member_otps where phone = '+60129876543';
  perform pg_temp.check(member_otp_request('0129876543', '10.0.0.1', pg_temp.hash('121212'), '121212', v_t9) = 'ok', 'M6 a code for the IP limit');
  insert into member_verify_fails(ip, otp_id) select '10.6.6.6', gen_random_uuid() from generate_series(1, 19);
  perform pg_temp.check(member_otp_verify('0129876543', pg_temp.hash('000000'), pg_temp.hash('tok-z1'), null, '10.6.6.6') = 'wrong', 'M6 the 20th wrong code from an IP');
  v_otp := (select id from member_otps where phone = '+60129876543');
  perform pg_temp.check(member_otp_verify('0129876543', pg_temp.hash('121212'), pg_temp.hash('tok-z2'), null, '10.6.6.6') = 'locked', 'M6 then that IP is locked, the right code included');
  perform pg_temp.check((select attempts from member_otps where id = v_otp) = 1
                        and (select count(*) from member_verify_fails where otp_id = v_otp) = 1, 'M6 the IP lock leaves the code row as it was');
  perform pg_temp.check(not exists (select 1 from members where phone = '+60129876543'), 'M6 no member from an IP lock');
  perform pg_temp.expect_error(format('select member_otp_verify(%L, %L, %L, null, null)', '0129876543', pg_temp.hash('121212'), pg_temp.hash('tok-z3')),
    'Client IP required', 'M6 verify without an IP');
  update member_verify_fails set at = now() - interval '61 minutes' where ip = '10.6.6.6';
  perform pg_temp.check(member_otp_verify('0129876543', pg_temp.hash('000000'), pg_temp.hash('tok-z4'), null, '10.6.6.6') = 'wrong', 'M6 an hour later the IP may try again');
  delete from member_otps where phone = '+60129876543';
  -- expired: past 5 minutes
  perform pg_temp.check(member_otp_request('0129876543', '10.0.0.1', pg_temp.hash('222222'), '222222', v_t9) = 'ok', 'M6 another code');
  update member_otps set expires_at = now() - interval '1 second' where phone = '+60129876543' and code_hash = pg_temp.hash('222222');
  perform pg_temp.check(member_otp_verify('0129876543', pg_temp.hash('222222'), pg_temp.hash('tok-y'), null, '10.0.0.1') = 'expired', 'M6 an expired code');
  perform pg_temp.check(member_otp_verify('0199990000', pg_temp.hash('222222'), pg_temp.hash('tok-y'), null, '10.0.0.1') = 'expired', 'M6 a number with no code');
  -- the right code: a new member and a token; the code cannot be used twice
  delete from member_otps where phone = '+60129876543';
  perform pg_temp.check(member_otp_request('+60 12-987 6543', '10.0.0.1', pg_temp.hash('333333'), '333333', v_t9) = 'ok', 'M6 code for sign-in');
  perform pg_temp.check(member_otp_verify('0129876543', pg_temp.hash('333333'), pg_temp.hash('verify-token-C-0001'), 'iPhone Safari', '10.0.0.1') = 'ok', 'M6 the right code');
  perform pg_temp.check(exists (select 1 from members where phone = '+60129876543' and deleted_at is null), 'M6 the member exists');
  perform pg_temp.check((select expires_at from member_tokens where token_hash = pg_temp.hash('verify-token-C-0001'))
                        between now() + interval '179 days' and now() + interval '181 days', 'M6 the token lasts 180 days');
  perform pg_temp.check(member_otp_verify('0129876543', pg_temp.hash('333333'), pg_temp.hash('verify-token-C-0002'), null, '10.0.0.1') = 'expired', 'M6 a used code is dead');
  -- a voided code (the SMS never left) cannot be confirmed
  delete from member_otps where phone = '+60129876543';
  perform pg_temp.check(member_otp_request('0129876543', '10.0.0.1', pg_temp.hash('555555'), '555555', v_t9) = 'ok', 'M6 code to void');
  perform pg_temp.check(member_otp_void('0129876543', pg_temp.hash('555555')), 'M6 void → true');
  perform pg_temp.check(not member_otp_void('0129876543', pg_temp.hash('555555')), 'M6 void twice → false');
  perform pg_temp.check((select dev_code from member_otps where phone = '+60129876543' and code_hash = pg_temp.hash('555555')) is null, 'M6 void clears the dev code');
  perform pg_temp.check(member_otp_verify('0129876543', pg_temp.hash('555555'), pg_temp.hash('verify-token-C-0003'), null, '10.0.0.1') = 'expired', 'M6 a voided code is dead');
  delete from member_otps where phone = '+60129876543';
  -- an older code still inside its 5 minutes fails once a newer one was asked for; the newer one works,
  -- and a successful sign-in clears every dev code of that number
  perform pg_temp.check(member_otp_request('0129876543', '10.0.0.1', pg_temp.hash('666661'), '666661', v_t9) = 'ok', 'M6 older code');
  -- (one transaction has one now(): the older code is moved a minute back, still inside its 5 minutes)
  update member_otps set created_at = now() - interval '1 minute' where phone = '+60129876543';
  perform pg_temp.check(member_otp_request('0129876543', '10.0.0.1', pg_temp.hash('666662'), '666662', v_t9) = 'ok', 'M6 newer code');
  perform pg_temp.check((select count(*) from member_otps where phone = '+60129876543' and dev_code is not null) = 2, 'M6 two dev codes stored');
  perform pg_temp.check(member_otp_verify('0129876543', pg_temp.hash('666661'), pg_temp.hash('verify-token-C-0004'), null, '10.0.0.1') = 'wrong', 'M6 the older code fails');
  perform pg_temp.check(member_otp_verify('0129876543', pg_temp.hash('666662'), pg_temp.hash('verify-token-C-0005'), null, '10.0.0.1') = 'ok', 'M6 the newer code works');
  perform pg_temp.check(not exists (select 1 from member_otps where phone = '+60129876543' and dev_code is not null), 'M6 sign-in clears all the number''s dev codes');
  delete from member_otps where phone = '+60129876543';
  -- no IP → an error; a dev code while dev codes are off → an error (nothing stored)
  perform pg_temp.expect_error(format('select member_otp_request(%L, null, %L, null, %L)', '0129876543', pg_temp.hash('5'), v_t9),
    'Client IP required', 'M6 no IP');
  perform pg_temp.expect_error(format('select member_otp_request(%L, %L, %L, null, %L)', '0129876543', '  ', pg_temp.hash('5'), v_t9),
    'Client IP required', 'M6 a blank IP');
  update member_settings set dev_codes_allowed = false where id;
  perform pg_temp.expect_error(format('select member_otp_request(%L, %L, %L, %L, %L)', '0129876543', '10.0.0.1', pg_temp.hash('777777'), '777777', v_t9),
    'Dev codes are not allowed on this project', 'M6 a dev code while off');
  perform pg_temp.check(not exists (select 1 from member_otps where phone = '+60129876543'), 'M6 the refused dev code is not stored');
  perform pg_temp.check(member_otp_request('0129876543', '10.0.0.1', pg_temp.hash('777777'), '', v_t9) = 'ok', 'M6 no dev code while off: ok');
  update member_settings set dev_codes_allowed = true where id;
  delete from member_otps where phone = '+60129876543';
  -- the same answers for a member and a non-member
  perform pg_temp.check(member_otp_request('0123456789', '10.0.0.9', pg_temp.hash('444444'), null, v_t9) = 'ok', 'M6 a member asks: ok');
  -- per IP: 30 per hour (spread over two tables, under their own limit)
  for i in 1..30 loop
    v := member_otp_request('01300000' || lpad(i::text, 2, '0'), '10.9.9.9', pg_temp.hash('5'), null, case when i <= 15 then v_ta else v_tb end);
    perform pg_temp.check(v = 'ok', 'M6 ip request ' || i || ': ' || v);
  end loop;
  perform pg_temp.check(member_otp_request('0130000099', '10.9.9.9', pg_temp.hash('5'), null, v_tc) = 'rate_ip', 'M6 the 31st from one IP in an hour → rate_ip');
  -- per IP per day: 100 in 24 hours (none of them in the last hour)
  insert into member_otps(phone, code_hash, expires_at, ip, created_at)
  select '+6014000' || lpad(g::text, 4, '0'), pg_temp.hash('x'), now(), '10.7.7.7', now() - interval '3 hours'
    from generate_series(1, 99) g;
  perform pg_temp.check(member_otp_request('0140009999', '10.7.7.7', pg_temp.hash('5'), null, v_tc) = 'ok', 'M6 the 100th from one IP in a day');
  update member_otps set created_at = now() - interval '2 hours' where ip = '10.7.7.7';
  perform pg_temp.check(member_otp_request('0140009998', '10.7.7.7', pg_temp.hash('5'), null, v_tc) = 'rate_ip', 'M6 the 101st from one IP in a day → rate_ip');
  -- per table: 20 in 24 hours, whatever the IP (table MA holds 15 from above)
  insert into member_otps(phone, code_hash, expires_at, ip, table_id, created_at)
  select '+6015000' || lpad(g::text, 4, '0'), pg_temp.hash('x'), now(), '10.4.4.' || g, v_ida, now() - interval '5 hours'
    from generate_series(1, 4) g;
  perform pg_temp.check(member_otp_request('0150009999', '10.5.5.5', pg_temp.hash('5'), null, v_ta) = 'ok', 'M6 the 20th from one table');
  perform pg_temp.check(member_otp_request('0150009998', '10.5.5.6', pg_temp.hash('5'), null, v_ta) = 'rate_table', 'M6 the 21st from one table → rate_table');
  update member_otps set created_at = now() - interval '25 hours' where table_id = v_ida;
  perform pg_temp.check(member_otp_request('0150009998', '10.5.5.6', pg_temp.hash('5'), null, v_ta) = 'ok', 'M6 a day later the table may ask again');
  -- the daily SMS cap (today's codes, Malaysia day) and the QR switch
  update member_settings set sms_daily_cap = (select count(*) from member_otps
       where created_at >= date_trunc('day', now() at time zone 'Asia/Kuala_Lumpur') at time zone 'Asia/Kuala_Lumpur') where id;
  perform pg_temp.check(member_otp_request('0130000098', '10.8.8.8', pg_temp.hash('5'), null, v_tc) = 'cap', 'M6 the daily cap → cap');
  update member_settings set sms_daily_cap = 300, qr_enabled = false where id;
  perform pg_temp.check(member_otp_request('0130000098', '10.8.8.8', pg_temp.hash('5'), null, v_tc) = 'disabled', 'M6 switched off → disabled');
  update member_settings set qr_enabled = true where id;
  perform pg_temp.expect_error(format('select member_otp_request(%L, null, %L, null, %L)', '0312345678', pg_temp.hash('5'), v_t9),
    'Invalid phone number', 'M6 a landline');
  perform pg_temp.done('M6');
end $$;

-- ── M7. Tokens: member_me, linking a table, expired and deleted tokens ──
do $$
declare
  c_tok constant text := 'verify-token-C-0001';
  v_me  jsonb;
  v_res jsonb;
  v_b   uuid;
  v_c   uuid := (select id from members where phone = '+60129876543' and deleted_at is null);
  c_none constant jsonb := jsonb_build_object('linked', false, 'phoneMasked', null);
  v_g1  uuid := gen_random_uuid();
  v_g2  uuid := gen_random_uuid();
  v_t3  text := (select qr_token from dining_tables where id = pg_temp.id('m3'));
  v_t4  text := (select qr_token from dining_tables where id = pg_temp.id('m4'));
  v_b3  uuid;
begin
  perform set_config('request.jwt.claims', '', true);   -- the QR page: no session
  v_me := member_me(c_tok);
  perform pg_temp.check(v_me->>'phoneMasked' = '+60 ••• ••6543' and (v_me->>'points')::integer = 0
                        and jsonb_array_length(v_me->'entries') = 0 and (v_me->>'rate')::numeric = 1, 'M7 member_me: ' || v_me::text);
  perform pg_temp.check((select last_used_at from member_tokens where token_hash = pg_temp.hash(c_tok)) is not null, 'M7 last_used_at stamped');
  perform pg_temp.check(member_me('no-such-token-0000') is null, 'M7 an unknown token');
  perform pg_temp.check(member_me(null) is null, 'M7 no token');
  perform pg_temp.check((member_public_settings()->>'qrEnabled')::boolean, 'M7 public settings');
  -- link: only a guest who has ordered on the table's open bill may link it (order_items.guest_id)
  perform pg_temp.act(pg_temp.id('dev'));
  v_b := pg_temp.bill('m3', array['latte']);
  perform pos_bill_set_member(v_b, '0123456789');
  v_b3 := v_b;
  v_b := pg_temp.bill('m4', array['latte']);
  perform set_config('request.jwt.claims', '', true);
  -- M3 has member A. A guest who has not ordered there learns nothing, not even whose number it is
  v_res := member_link_table(v_t3, v_g2, c_tok);
  perform pg_temp.check(v_res = c_none, 'M7 a guest with no order on the bill: ' || v_res::text);
  -- once that guest has ordered: told whose number earns, nothing changes
  update order_items set guest_id = v_g2, guest_label = 'Ann' where bill_id = v_b3;
  v_res := member_link_table(v_t3, v_g2, c_tok);
  perform pg_temp.check(v_res = jsonb_build_object('linked', false, 'phoneMasked', '+60 ••• ••6789'), 'M7 an existing member is not overwritten: ' || v_res::text);
  perform pg_temp.check((select member_id from bills where id = v_b3) = pg_temp.id('A'), 'M7 M3 keeps A');
  -- M4's bill has none. A cart line alone does not count
  insert into qr_cart_lines(table_id, guest_id, guest_name, guest_avatar, product_id, variant_id, qty)
  values (pg_temp.id('m4'), v_g1, 'Mei', 'a1', pg_temp.id('cake'), pg_temp.id('cake_v'), 1);
  v_res := member_link_table(v_t4, v_g1, c_tok);
  perform pg_temp.check(v_res = c_none and (select member_id from bills where id = v_b) is null, 'M7 a cart line alone links nothing: ' || v_res::text);
  perform pg_temp.check(member_link_table(v_t4, null, c_tok) = c_none, 'M7 no guest id');
  -- the guest ordered on it → C, and again → still linked
  update order_items set guest_id = v_g1, guest_label = 'Mei' where bill_id = v_b;
  -- a QR-paused table links nothing (as qr_cart_table refuses it)
  update dining_tables set qr_paused = true where id = pg_temp.id('m4');
  perform pg_temp.check(member_link_table(v_t4, v_g1, c_tok) = c_none and (select member_id from bills where id = v_b) is null, 'M7 a paused table links nothing');
  update dining_tables set qr_paused = false where id = pg_temp.id('m4');
  v_res := member_link_table(v_t4, v_g1, c_tok);
  perform pg_temp.check(v_res = jsonb_build_object('linked', true, 'phoneMasked', '+60 ••• ••6543'), 'M7 linked: ' || v_res::text);
  perform pg_temp.check((select member_id from bills where id = v_b) = v_c, 'M7 M4''s bill names C');
  perform pg_temp.check(exists (select 1 from member_bill_events where bill_id = v_b and action = 'link' and member_id = v_c), 'M7 the link is logged');
  perform pg_temp.check(member_link_table(v_t4, v_g1, c_tok)->>'linked' = 'true', 'M7 linking twice');
  -- a table with no open bill, an unknown table, an unknown token
  perform pg_temp.check(member_link_table((select qr_token from dining_tables where id = pg_temp.id('m5')), v_g1, c_tok) = c_none, 'M7 no open bill');
  perform pg_temp.check(member_link_table('nosuchtable', v_g1, c_tok) = c_none, 'M7 unknown table');
  perform pg_temp.check(member_link_table(v_t4, v_g1, 'no-such-token-0000') is null, 'M7 unknown token');
  -- the QR switch off: nothing is linked
  perform pg_temp.act(pg_temp.id('dev'));
  v_b := pg_temp.bill('m6', array['latte']);
  update order_items set guest_id = v_g1 where bill_id = v_b;
  perform set_config('request.jwt.claims', '', true);
  update member_settings set qr_enabled = false where id;
  perform pg_temp.check(member_link_table((select qr_token from dining_tables where id = pg_temp.id('m6')), v_g1, c_tok) = c_none,
                        'M7 switched off links nothing');
  perform pg_temp.check((select member_id from bills where id = v_b) is null, 'M7 M6''s bill has no member');
  update member_settings set qr_enabled = true where id;
  -- C earns at the counter and sees the entry with the outlet's name
  perform pg_temp.act(pg_temp.id('dev'));
  perform pg_temp.pay_bill((select id from bills where table_id = pg_temp.id('m4') and status = 'open'));
  perform set_config('request.jwt.claims', '', true);
  v_me := member_me(c_tok);
  perform pg_temp.check((v_me->>'points')::integer = 10 and v_me->'entries'->0->>'branchName' = 'VERIFY MEM'
                        and (v_me->'entries'->0->>'points')::integer = 10 and v_me->'entries'->0->>'kind' = 'earn', 'M7 C''s entry: ' || v_me::text);
  -- sign out: the token is gone
  insert into member_tokens(member_id, token_hash, expires_at) values (v_c, pg_temp.hash('verify-token-C-out'), now() + interval '1 day');
  perform member_sign_out('verify-token-C-out');
  perform pg_temp.check(member_me('verify-token-C-out') is null, 'M7 signed out');
  -- expired token
  update member_tokens set expires_at = now() - interval '1 second' where token_hash = pg_temp.hash(c_tok);
  perform pg_temp.check(member_me(c_tok) is null, 'M7 an expired token is refused');
  perform pg_temp.check(member_link_table(v_t4, v_g1, c_tok) is null, 'M7 an expired token cannot link');
  update member_tokens set expires_at = now() + interval '1 day' where token_hash = pg_temp.hash(c_tok);
  perform pg_temp.check(member_me(c_tok) is not null, 'M7 valid again');
  -- deleted member (owner, PDPA): the token is refused, the number gone, the ledger kept, open bills cleared
  perform pg_temp.act(pg_temp.id('dev'));
  v_b := pg_temp.bill('m7', array['latte']);
  perform pos_bill_set_member(v_b, '0129876543');
  perform pg_temp.act(pg_temp.id('owner'));
  perform member_delete(v_c);
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.check(member_me(c_tok) is null, 'M7 a deleted member''s token is refused');
  perform pg_temp.check((select phone is null and deleted_at is not null from members where id = v_c), 'M7 the number is gone');
  perform pg_temp.check(exists (select 1 from member_points where member_id = v_c), 'M7 the ledger rows stay');
  perform pg_temp.check((select member_id from bills where id = v_b) is null, 'M7 the open bill dropped the member');
  perform pg_temp.check(not exists (select 1 from member_tokens where member_id = v_c), 'M7 tokens removed');
  -- the same number can join again as a new member
  perform pg_temp.act(pg_temp.id('dev'));
  v_res := pos_bill_set_member(v_b, '0129876543');
  perform pg_temp.check((v_res->>'isNew')::boolean and (v_res->>'memberId')::uuid <> v_c, 'M7 the number joins again as new');
  perform pg_temp.done('M7');
end $$;

-- ── M8. Owner and back office: adjust, search, ledger, settings ──
do $$
declare
  v_a   uuid := pg_temp.id('A');
  v_bal integer;
  v_res jsonb;
begin
  -- not the owner
  perform pg_temp.act(pg_temp.id('cashier'));
  perform pg_temp.expect_error(format('select member_adjust(%L, 5, %L)', v_a, 'gift'), 'Only the owner can do this.', 'M8 a cashier adjusts');
  perform pg_temp.expect_error(format('select member_search(%L, 10, 0)', ''), 'You cannot see members.', 'M8 a cashier searches');
  perform pg_temp.expect_error(format('select member_settings_set(2, null, null)'), 'Only the owner can do this.', 'M8 a cashier changes settings');
  perform pg_temp.expect_error(format('select member_delete(%L)', v_a), 'Only the owner can do this.', 'M8 a cashier deletes');
  perform pg_temp.act(pg_temp.id('sup'));
  perform pg_temp.expect_error(format('select member_adjust(%L, 5, %L)', v_a, 'gift'), 'Only the owner can do this.', 'M8 a supervisor adjusts');
  perform pg_temp.act(pg_temp.id('dev'));
  perform pg_temp.expect_error(format('select member_adjust(%L, 5, %L)', v_a, 'gift'), 'Only the owner can do this.', 'M8 a tablet adjusts');
  perform set_config('request.jwt.claims', '', true);
  perform pg_temp.expect_error(format('select member_adjust(%L, 5, %L)', v_a, 'gift'), 'Sign in required', 'M8 no session');
  -- the owner
  perform pg_temp.act(pg_temp.id('owner'));
  v_bal := pg_temp.bal('+60123456789');
  perform pg_temp.expect_error(format('select member_adjust(%L, %s, %L)', v_a, -(v_bal + 1), 'too much'), 'Points cannot go below zero.', 'M8 below zero');
  perform pg_temp.expect_error(format('select member_adjust(%L, 5, %L)', v_a, '   '), 'A reason is required.', 'M8 no reason');
  perform pg_temp.expect_error(format('select member_adjust(%L, 0, %L)', v_a, 'x'), 'Enter a number of points between -100000 and 100000, not 0.', 'M8 zero');
  perform pg_temp.expect_error(format('select member_adjust(%L, 5, %L)', gen_random_uuid(), 'x'), 'Member not found', 'M8 unknown member');
  v_res := member_adjust(v_a, 5, '  Birthday  ');
  perform pg_temp.check((v_res->>'points')::integer = v_bal + 5 and pg_temp.sum_ok('+60123456789'), 'M8 adjust +5');
  perform pg_temp.check(exists (select 1 from member_points where member_id = v_a and kind = 'adjust' and reason = 'Birthday'
                                  and staff_id = pg_temp.id('owner')), 'M8 the adjust row');
  v_res := member_adjust(v_a, -(v_bal + 5), 'to zero');
  perform pg_temp.check((v_res->>'points')::integer = 0, 'M8 adjust down to exactly zero');
  -- search and ledger
  v_res := member_search('012-345 6789', 10, 0);
  perform pg_temp.check((v_res->>'total')::integer = 1 and v_res->'rows'->0->>'phone' = '+60123456789', 'M8 search by a typed number: ' || v_res::text);
  v_res := member_search('6789', 10, 0);
  perform pg_temp.check(exists (select 1 from jsonb_array_elements(v_res->'rows') r where r->>'id' = v_a::text), 'M8 search by the last digits');
  perform pg_temp.check((member_search('', 1, 0)->>'total')::integer >= 3 and jsonb_array_length(member_search('', 1, 0)->'rows') = 1, 'M8 an empty query lists, paged');
  perform pg_temp.check(not exists (select 1 from jsonb_array_elements(member_search('', 200, 0)->'rows') r where r->>'phone' is null), 'M8 deleted members are not listed');
  v_res := member_ledger(v_a);
  perform pg_temp.check(v_res->'member'->>'phone' = '+60123456789' and (v_res->'member'->>'points')::integer = 0, 'M8 ledger member');
  perform pg_temp.check(exists (select 1 from jsonb_array_elements(v_res->'entries') e where e->>'kind' = 'earn' and e->>'billNo' is not null
                                   and e->>'branchName' = 'VERIFY MEM'), 'M8 ledger earn rows name bill and outlet');
  perform pg_temp.check(exists (select 1 from jsonb_array_elements(v_res->'entries') e where e->>'kind' = 'adjust' and e->>'staffName' is not null), 'M8 ledger adjust rows name the owner');
  perform pg_temp.check(member_ledger(gen_random_uuid()) is null, 'M8 unknown member ledger');
  -- settings
  v_res := member_settings_set(2, null, 250);
  perform pg_temp.check((v_res->>'rate')::numeric = 2 and (v_res->>'qrEnabled')::boolean and (v_res->>'smsDailyCap')::integer = 250
                        and v_res ? 'smsSentToday', 'M8 settings set: ' || v_res::text);
  perform pg_temp.check(member_settings_get() = v_res, 'M8 settings get');
  perform pg_temp.expect_error('select member_settings_set(101, null, null)', 'The earn rate must be between 0 and 100 points per RM 1.', 'M8 rate 101');
  perform pg_temp.expect_error('select member_settings_set(null, null, -1)', 'The daily SMS cap must be between 0 and 100000.', 'M8 cap -1');
  -- rate 2: Latte 10.50 earns 21; after a refund of 5.25 the bill keeps floor(5.25 × 2) = 10, so it takes 11
  perform pg_temp.act(pg_temp.id('dev'));
  v_res := pos_bill_set_member(pg_temp.bill(null, array['latte']), '0123456789');
  perform pg_temp.pay_bill((select id from bills where member_id = v_a and status = 'open' and order_type = 'takeaway'));
  perform pg_temp.check(pg_temp.bal('+60123456789') = 21, 'M8 rate 2 earns 21');
  perform pg_temp.check(coalesce((refund_bill(gen_random_uuid(),
                          (select bill_id from member_points where member_id = v_a and kind = 'earn' and rate = 2),
                          525, pg_temp.id('card'), 'x', pg_temp.id('sup'), '2222')->>'ok')::boolean, false), 'M8 refund at rate 2');
  perform pg_temp.check(pg_temp.bal('+60123456789') = 10 and pg_temp.sum_ok('+60123456789'), 'M8 refund at rate 2 takes 11');
  -- the staff back office (a manager has access_settings) can search but not adjust
  perform pg_temp.act(pg_temp.id('owner'));
  update staff set system_role = 'manager' where id = pg_temp.id('sup');
  perform pg_temp.act(pg_temp.id('sup'));
  perform pg_temp.check((member_search('6789', 10, 0)->>'total')::integer >= 1, 'M8 a manager searches');
  perform pg_temp.check(member_settings_get() ? 'rate', 'M8 a manager reads settings');
  perform pg_temp.expect_error(format('select member_adjust(%L, 5, %L)', v_a, 'gift'), 'Only the owner can do this.', 'M8 a manager adjusts');
  perform pg_temp.expect_error('select member_earn_failures_list()', 'Only the owner can do this.', 'M8 a manager reads earn failures');
  -- the owner reads the earn that failed in M3
  perform pg_temp.act(pg_temp.id('owner'));
  v_res := member_earn_failures_list();
  perform pg_temp.check(exists (select 1 from jsonb_array_elements(v_res) e where (e->>'billId')::uuid = pg_temp.id('FAILED')
                                  and e->>'billNo' is not null and e->>'branchName' = 'VERIFY MEM' and e->>'error' <> ''),
                        'M8 the owner lists earn failures: ' || left(v_res::text, 300));
  -- an owner who is no longer active is not the owner
  update staff set is_active = false where id = pg_temp.id('owner');
  perform pg_temp.expect_error(format('select member_adjust(%L, 5, %L)', v_a, 'gift'), 'Only the owner can do this.', 'M8 an inactive owner');
  update staff set is_active = true, status = 'resigned' where id = pg_temp.id('owner');
  perform pg_temp.expect_error('select member_settings_set(1, null, null)', 'Only the owner can do this.', 'M8 a resigned owner');
  update staff set status = 'active' where id = pg_temp.id('owner');
  perform pg_temp.check((member_adjust(v_a, 1, 'active again')->>'points')::integer = 11, 'M8 an active owner again');
  perform pg_temp.done('M8');
end $$;

-- ── M9. Real callers: the guest RPCs as the anon role, staff RPCs as authenticated; the tables stay shut ──
-- (the other sections run as the migration owner with claims set; here the role itself is switched)
do $$
declare
  c_tok   constant text := 'verify-token-D-0001';
  v_d     uuid;
  v_g     uuid := gen_random_uuid();
  v_b     uuid;
  v_t8    text := (select qr_token from dining_tables where id = pg_temp.id('m8'));
  v_dev   uuid := pg_temp.id('dev');
  v_owner uuid := pg_temp.id('owner');
  v_hash  text := pg_temp.hash('5');
  v_pub   jsonb; v_me jsonb; v_link jsonb; v_set jsonb; v_search jsonb;
  v_errs  text[] := '{}';
  v_state text;
  t       text;
begin
  -- setup as the owner of the tables: member D with a token, table M8's open bill with an order by guest G
  insert into members(phone) values ('+60155555555') returning id into v_d;
  insert into member_tokens(member_id, token_hash, expires_at) values (v_d, pg_temp.hash(c_tok), now() + interval '1 day');
  perform pg_temp.act(v_dev);
  v_b := pg_temp.bill('m8', array['latte']);
  update order_items set guest_id = v_g where bill_id = v_b;

  -- the QR page: role anon, no session
  set local role anon;
  perform set_config('request.jwt.claims', '', true);
  v_pub  := member_public_settings();
  v_me   := member_me(c_tok);
  v_link := member_link_table(v_t8, v_g, c_tok);
  foreach t in array array['select 1 from members', 'select 1 from member_points', 'select 1 from member_tokens',
                           'select 1 from member_otps', 'select 1 from member_settings', 'select 1 from member_bill_events',
                           'select 1 from member_verify_fails',
                           'select 1 from member_earn_failures', 'update member_settings set rate = 50 where id',
                           'insert into member_points(member_id, kind, points, reason, staff_id) values (gen_random_uuid(), ''adjust'', 1, ''x'', gen_random_uuid())',
                           format('select member_otp_request(%L, %L, %L, null, %L)', '0155555555', '10.1.1.1', v_hash, v_t8),
                           format('select member_otp_verify(%L, %L, %L, null, %L)', '0155555555', v_hash, v_hash, '10.1.1.1'),
                           format('select member_otp_void(%L, %L)', '0155555555', v_hash),
                           format('select member_points_add(%L, ''adjust'', 5, null, null, null, ''x'', %L)', v_d, v_d),
                           format('select member_by_token(%L)', c_tok), 'select member_settings_json()',
                           format('select pos_bill_set_member(%L, %L)', v_b, '0155555555'),
                           'select member_search('''', 10, 0)', 'select member_earn_failures_list()'] loop
    begin
      execute t;
      v_errs := v_errs || ('anon ran: ' || t);
    exception when insufficient_privilege then
      null;
    end;
  end loop;
  reset role;
  perform pg_temp.check(v_pub ? 'qrEnabled' and v_pub ? 'rate', 'M9 anon: member_public_settings ' || coalesce(v_pub::text, 'null'));
  perform pg_temp.check(v_me->>'phoneMasked' = '+60 ••• ••5555', 'M9 anon: member_me ' || coalesce(v_me::text, 'null'));
  perform pg_temp.check(v_link = jsonb_build_object('linked', true, 'phoneMasked', '+60 ••• ••5555')
                        and (select member_id from bills where id = v_b) = v_d, 'M9 anon: member_link_table ' || coalesce(v_link::text, 'null'));
  perform pg_temp.check(cardinality(v_errs) = 0, 'M9 ' || array_to_string(v_errs, '; '));

  -- the till: role authenticated with the tablet's claims (the staff session of the FIXTURE)
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_dev, 'role', 'authenticated')::text, true);
  v_set := pos_bill_set_member(v_b, '011-5555 5555');
  -- the back office: the owner's claims
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  v_search := member_search('5555', 10, 0);
  foreach t in array array['select 1 from members', 'select 1 from member_otps', 'select 1 from member_earn_failures',
                           'delete from member_tokens where true',
                           format('select member_otp_request(%L, %L, %L, null, %L)', '0155555555', '10.1.1.1', v_hash, v_t8),
                           format('select member_otp_verify(%L, %L, %L, null, %L)', '0155555555', v_hash, v_hash, '10.1.1.1'),
                           format('select member_otp_void(%L, %L)', '0155555555', v_hash),
                           format('select member_points_add(%L, ''adjust'', 5, null, null, null, ''x'', %L)', v_d, v_d),
                           'select member_require_owner()', 'select member_settings_json()', 'select member_phone_normalise(''0123456789'')'] loop
    begin
      execute t;
      v_errs := v_errs || ('authenticated ran: ' || t);
    exception when insufficient_privilege then
      null;
    end;
  end loop;
  reset role;
  perform pg_temp.check((v_set->>'isNew')::boolean and v_set->>'phone' = '+601155555555'
                        and (select member_id from bills where id = v_b) = (v_set->>'memberId')::uuid,
                        'M9 authenticated: pos_bill_set_member ' || coalesce(v_set::text, 'null'));
  perform pg_temp.check((v_search->>'total')::integer >= 2, 'M9 authenticated: member_search ' || coalesce(v_search::text, 'null'));
  perform pg_temp.check(cardinality(v_errs) = 0, 'M9 ' || array_to_string(v_errs, '; '));
  perform pg_temp.check(current_user not in ('anon', 'authenticated'), 'M9 the role is back');
  perform pg_temp.done('M9');
end $$;

-- every section ran (an error a client skipped over would leave one out)
do $$
declare
  v_n integer := (select count(*) from pg_temp.sections);
begin
  if v_n <> 10 then
    raise exception 'FAIL: % of 10 sections ran (%)', v_n, (select string_agg(name, ', ' order by name) from pg_temp.sections);
  end if;
end $$;

rollback;
select 'VERIFY OK' as result;
