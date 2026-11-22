-- Self-check for migration-2026-11-23-members-pos.sql (members at the counter). Run on craft-os-dev after it.
-- Everything is rolled back. Success = a result row "VERIFY OK".
-- Sections: FIXTURE; P1 grants, security definer, trigger; P2 pos_bill_member; P3 the receipt's member lines;
-- P4 real callers (anon refused, the till's authenticated session works); P5 net points after refunds, part
-- and unpaid receipts, a staff login without a till. The last DO block raises unless all 6 ticked.
-- Outlet VERIFY MEMPOS: no service charge, not SST registered, 5 sen rounding, a receipt route.
-- Latte 10.50, Sugar 0.50. A card method, a cashier and a supervisor with PINs, one tablet signed in, a shift
-- open, rate 1.
begin;

create function pg_temp.check(p_cond boolean, p_label text) returns void
language plpgsql as $$
begin
  if p_cond is not true then raise exception 'FAIL %', p_label; end if;
end $$;
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
create temp table fixture (k text primary key, v uuid);
create temp table sections (name text primary key);
create function pg_temp.done(p_name text) returns void
language sql as $$ insert into pg_temp.sections(name) values (p_name) $$;
create function pg_temp.put(p_k text, p_v uuid) returns void
language sql as $$ insert into pg_temp.fixture(k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.id(p_k text) returns uuid
language sql as $$ select v from pg_temp.fixture where k = p_k $$;
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
create function pg_temp.pay_bill(p_bill uuid) returns jsonb
language sql as $$
  select checkout_bill(p_bill, jsonb_build_array(jsonb_build_object('methodId', pg_temp.id('card'),
                       'amountSen', (pos_bill_totals(p_bill)->>'totalSen')::integer)), gen_random_uuid())
$$;
-- the newest receipt job of a bill (by bill no at the fixture outlet)
create function pg_temp.receipt(p_bill uuid) returns jsonb
language sql as $$
  select payload from print_jobs
   where branch_id = pg_temp.id('branch') and kind = 'receipt' and payload->>'kind' = 'receipt'
     and payload->>'billNo' = (select bill_no from bills where id = p_bill)
   order by seq desc limit 1
$$;

-- ── FIXTURE ──
do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-0000000009d1';
  v_dev   uuid := 'eeeeeeee-0000-0000-0000-0000000009d3';
  v_sup   uuid := 'eeeeeeee-0000-0000-0000-0000000009d2';
  v_a uuid; v_t uuid; v_cat uuid; v_catalog uuid; v_p uuid; v_v uuid; v_res jsonb; r record; i integer;
begin
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;
  update member_settings set rate = 1, qr_enabled = true where id;
  insert into branches(name, address) values ('VERIFY MEMPOS', 'm') returning id into v_a;
  perform pg_temp.put('branch', v_a);
  for i in 1..4 loop
    insert into dining_tables(branch_id, label, sort_order) values (v_a, 'P' || i, i) returning id into v_t;
    perform pg_temp.put('p' || i, v_t);
  end loop;
  insert into print_routes(branch_id, name, kind, address) values (v_a, 'MemReceipt', 'agent', '127.0.0.1:9100');
  insert into branch_pos_settings(branch_id, receipt_route) values (v_a, 'MemReceipt');
  insert into menu_categories(name, sort_order) values ('VERIFY MEMPOS DRINKS', 913) returning id into v_cat;
  insert into menu_catalogs(name, sort_order) values ('VERIFY MEMPOS MENU', 913) returning id into v_catalog;
  for r in select * from (values ('latte', 'Verify MemPos Latte', 1050), ('sugar', 'Verify MemPos Sugar', 50)) as x(k, name, sen) loop
    insert into menu_products(name, category_id, sst_rate_bp) values (r.name, v_cat, 0) returning id into v_p;
    insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_p, '', 'Regular', r.sen) returning id into v_v;
    insert into catalog_products(catalog_id, product_id, availability) values (v_catalog, v_p, 'all');
    insert into catalog_variant_prices(catalog_id, variant_id, price_sen) values (v_catalog, v_v, r.sen);
    perform pg_temp.put(r.k, v_p); perform pg_temp.put(r.k || '_v', v_v);
  end loop;
  insert into branch_catalogs(branch_id, role, catalog_id) values (v_a, 'dine_in', v_catalog), (v_a, 'takeaway', v_catalog), (v_a, 'qr', v_catalog);
  insert into payment_methods(branch_id, name, kind, sort_order) values (v_a, 'MEMPOS Card', 'card', 1) returning id into v_t;
  perform pg_temp.put('card', v_t);
  update staff set branch_id = v_a where id = v_owner;
  perform pg_temp.act(v_owner);
  insert into auth.users (id) values (v_cash), (v_dev), (v_sup);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_cash, 'Verify MemPos Cashier', 'trainee', true, current_date, 'staff', v_a),
    (v_sup,  'Verify MemPos Supervisor', 'trainee', true, current_date, 'staff', v_a);
  update staff set system_role = 'supervisor' where id = v_sup;
  perform pg_temp.act(v_cash);
  if not coalesce((set_my_pos_pin('1111', null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: PIN'; end if;
  perform pg_temp.act(v_sup);
  if not coalesce((set_my_pos_pin('2222', null)->>'ok')::boolean, false) then raise exception 'FAIL fixture: supervisor PIN'; end if;
  perform pg_temp.put('sup', v_sup);
  insert into pos_devices(id, branch_id, kind, name, platform, prints, approved_by) values (v_dev, v_a, 'pos', 'MEMPOS Counter', 'ipad', true, v_owner);
  perform pg_temp.put('owner', v_owner); perform pg_temp.put('cashier', v_cash); perform pg_temp.put('dev', v_dev);
  perform pg_temp.act(v_dev);
  v_res := pos_start_session(v_cash, '1111');
  if not coalesce((v_res->>'ok')::boolean, false) then raise exception 'FAIL fixture: cashier sign-in: %', v_res; end if;
  v_res := open_shift(10000);
  if v_res->'shift'->>'id' is null then raise exception 'FAIL fixture: no shift: %', v_res; end if;
  perform pg_temp.done('FIXTURE');
end $$;

-- ── P1. Grants, security definer, the trigger ──
do $$
begin
  perform pg_temp.check(has_function_privilege('authenticated', 'pos_bill_member(uuid)', 'execute'), 'P1 staff may call pos_bill_member');
  perform pg_temp.check(not has_function_privilege('anon', 'pos_bill_member(uuid)', 'execute'), 'P1 anon may not call pos_bill_member');
  perform pg_temp.check(not has_function_privilege('anon', 'print_jobs_member_line()', 'execute')
                        and not has_function_privilege('authenticated', 'print_jobs_member_line()', 'execute'), 'P1 trigger function not callable');
  perform pg_temp.check((select bool_and(prosecdef and proconfig::text like '%search_path%') from pg_proc
                          where proname in ('pos_bill_member', 'print_jobs_member_line') and pronamespace = 'public'::regnamespace)
                        and (select count(*) from pg_proc where proname in ('pos_bill_member', 'print_jobs_member_line')
                                and pronamespace = 'public'::regnamespace) = 2, 'P1 security definer with a search_path');
  perform pg_temp.check(exists (select 1 from pg_trigger where tgname = 'print_jobs_member_line' and tgrelid = 'print_jobs'::regclass
                                  and not tgisinternal), 'P1 trigger on print_jobs');
  perform pg_temp.done('P1');
end $$;

-- ── P2. pos_bill_member: null without a member; the member's numbers; earned after the payment ──
do $$
declare
  v_b   uuid;
  v_r   jsonb;
  v_set jsonb;
begin
  perform pg_temp.act(pg_temp.id('dev'));
  v_b := pg_temp.bill('p1', array['latte']);
  perform pg_temp.check(pos_bill_member(v_b) is null, 'P2 no member: null');
  v_set := pos_bill_set_member(v_b, '011-0000 0291');
  v_r := pos_bill_member(v_b);
  perform pg_temp.check(v_r->>'memberId' = v_set->>'memberId' and v_r->>'phone' = '+601100000291'
                        and v_r->>'phoneMasked' = '+60 ••• ••0291' and (v_r->>'points')::integer = 0
                        and v_r ? 'earned' and v_r->'earned' = 'null'::jsonb, 'P2 open bill ' || coalesce(v_r::text, 'null'));
  perform pg_temp.pay_bill(v_b);
  v_r := pos_bill_member(v_b);
  perform pg_temp.check((v_r->>'earned')::integer = 10 and (v_r->>'points')::integer = 10, 'P2 paid bill earned 10 ' || coalesce(v_r::text, 'null'));
  perform pg_temp.expect_error(format('select pos_bill_member(%L)', gen_random_uuid()), 'Bill not found', 'P2 unknown bill');
  -- another outlet's bill is not found
  update bills set branch_id = (select id from branches where id <> pg_temp.id('branch') order by name limit 1) where id = v_b;
  perform pg_temp.expect_error(format('select pos_bill_member(%L)', v_b), 'Bill not found', 'P2 other outlet');
  update bills set branch_id = pg_temp.id('branch') where id = v_b;
  -- a deleted member: null
  perform pg_temp.put('bill_p2', v_b);
  perform pg_temp.done('P2');
end $$;

-- ── P3. The receipt: member lines only for a paid bill with a member and at least 1 point ──
do $$
declare
  v_b  uuid;
  v_n  uuid;
  v_z  uuid;
  v_p  jsonb;
begin
  perform pg_temp.act(pg_temp.id('dev'));
  -- P2's bill: paid with a member, 10 points
  v_b := pg_temp.id('bill_p2');
  v_p := pg_temp.receipt(v_b);
  perform pg_temp.check(v_p is not null, 'P3 a receipt was queued');
  perform pg_temp.check(v_p->'member' = jsonb_build_object('last4', '0291', 'pointsEarned', 10), 'P3 member lines ' || coalesce(v_p->>'member', 'none'));
  perform pg_temp.check(v_p->>'totalSen' = '1050' and v_p->>'billNo' is not null, 'P3 the rest of the payload is untouched');
  -- a reprint carries them too
  perform reprint_receipt(v_b);
  v_p := pg_temp.receipt(v_b);
  perform pg_temp.check((v_p->>'reprint')::boolean and v_p->'member'->>'pointsEarned' = '10', 'P3 reprint ' || coalesce(v_p::text, 'null'));
  -- no member: no lines
  v_n := pg_temp.bill('p2', array['latte']);
  perform pg_temp.pay_bill(v_n);
  v_p := pg_temp.receipt(v_n);
  perform pg_temp.check(v_p is not null and not v_p ? 'member', 'P3 no member, no lines');
  -- a member but 0 points (RM 0.50): no lines
  v_z := pg_temp.bill('p3', array['sugar']);
  perform pos_bill_set_member(v_z, '011-0000 0292');
  perform pg_temp.pay_bill(v_z);
  v_p := pg_temp.receipt(v_z);
  perform pg_temp.check(v_p is not null and not v_p ? 'member', 'P3 0 points, no lines');
  -- a ticket or another kind of job is left alone
  insert into print_jobs(branch_id, route, kind, payload)
  values (pg_temp.id('branch'), 'MemReceipt', 'receipt', jsonb_build_object('kind', 'refund', 'billNo', (select bill_no from bills where id = v_b)));
  perform pg_temp.check(not (select payload from print_jobs where branch_id = pg_temp.id('branch') order by seq desc limit 1) ? 'member',
                        'P3 a refund slip gets no lines');
  -- a deleted member: no lines, and pos_bill_member answers null
  perform pg_temp.act(pg_temp.id('owner'));
  perform member_delete((select member_id from bills where id = v_b));
  perform pg_temp.act(pg_temp.id('dev'));
  perform reprint_receipt(v_b);
  perform pg_temp.check(not pg_temp.receipt(v_b) ? 'member', 'P3 deleted member, no lines');
  perform pg_temp.check(pos_bill_member(v_b) is null, 'P3 deleted member: pos_bill_member null');
  perform pg_temp.done('P3');
end $$;

-- ── P4. Real callers: anon is refused; the till's authenticated session reads the member ──
do $$
declare
  v_b    uuid;
  v_r    jsonb;
  v_dev  uuid := pg_temp.id('dev');
  v_anon boolean := false;
begin
  perform pg_temp.act(v_dev);
  v_b := pg_temp.bill('p4', array['latte']);
  perform pos_bill_set_member(v_b, '011-0000 0293');
  set local role anon;
  perform set_config('request.jwt.claims', '', true);
  begin
    perform pos_bill_member(v_b);
    v_anon := true;
  exception when insufficient_privilege then
    null;
  end;
  reset role;
  perform pg_temp.check(not v_anon, 'P4 anon ran pos_bill_member');
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', v_dev, 'role', 'authenticated')::text, true);
  v_r := pos_bill_member(v_b);
  reset role;
  perform pg_temp.check(v_r->>'phone' = '+601100000293', 'P4 authenticated till ' || coalesce(v_r::text, 'null'));
  perform pg_temp.check(current_user not in ('anon', 'authenticated'), 'P4 the role is back');
  perform pg_temp.done('P4');
end $$;

-- ── P5. Net points on reprints; part and unpaid receipts; a staff login without a till ──
do $$
declare
  v_b   uuid;
  v_o   uuid;
  v_k   uuid;
  v_p   jsonb;
  v_res jsonb;
begin
  perform pg_temp.act(pg_temp.id('dev'));
  -- Latte 10.50 at rate 1 earns 10; a RM 3.00 refund leaves floor(7.50) = 7
  v_b := pg_temp.bill('p1', array['latte']);
  perform pos_bill_set_member(v_b, '011-0000 0294');
  perform pg_temp.pay_bill(v_b);
  perform pg_temp.check(pg_temp.receipt(v_b)->'member'->>'pointsEarned' = '10', 'P5 paid: 10');
  v_res := refund_bill(gen_random_uuid(), v_b, 300, pg_temp.id('card'), 'verify partial', pg_temp.id('sup'), '2222');
  perform pg_temp.check(coalesce((v_res->>'ok')::boolean, false), 'P5 partial refund ' || coalesce(v_res::text, 'null'));
  perform reprint_receipt(v_b);
  v_p := pg_temp.receipt(v_b);
  perform pg_temp.check((v_p->>'reprint')::boolean and v_p->'member' = jsonb_build_object('last4', '0294', 'pointsEarned', 7),
                        'P5 reprint after a partial refund shows the net 7: ' || coalesce(v_p->>'member', 'none'));
  -- the rest refunded: the bill holds 0 points, a reprint has no member lines
  v_res := refund_bill(gen_random_uuid(), v_b, 750, pg_temp.id('card'), 'verify rest', pg_temp.id('sup'), '2222');
  perform pg_temp.check(coalesce((v_res->>'ok')::boolean, false), 'P5 full refund ' || coalesce(v_res::text, 'null'));
  perform reprint_receipt(v_b);
  v_p := pg_temp.receipt(v_b);
  perform pg_temp.check((v_p->>'reprint')::boolean and not v_p ? 'member', 'P5 reprint after a full refund: no lines ' || coalesce(v_p::text, 'null'));
  -- an open bill with a member: a receipt printed before payment gets no lines, nor does a part receipt
  v_o := pg_temp.bill('p2', array['latte']);
  perform pos_bill_set_member(v_o, '011-0000 0295');
  insert into print_jobs(branch_id, route, kind, payload)
  values (pg_temp.id('branch'), 'MemReceipt', 'receipt', jsonb_build_object('kind', 'receipt', 'billNo', (select bill_no from bills where id = v_o)));
  perform pg_temp.check(not pg_temp.receipt(v_o) ? 'member', 'P5 a receipt before payment: no lines');
  v_k := gen_random_uuid();
  v_res := pay_bill_part(v_o, v_k, 300, null, jsonb_build_array(jsonb_build_object('methodId', pg_temp.id('card'), 'amountSen', 300)));
  perform pg_temp.check(v_res ? 'partNo', 'P5 a part paid ' || coalesce(v_res::text, 'null'));
  v_p := (select payload from print_jobs where branch_id = pg_temp.id('branch') and payload->>'kind' = 'part' order by seq desc limit 1);
  perform pg_temp.check(v_p is not null and not v_p ? 'member', 'P5 a part receipt: no lines ' || coalesce(v_p::text, 'null'));
  -- a staff login without a till (the owner's own session) is refused
  perform pg_temp.act(pg_temp.id('owner'));
  perform pg_temp.expect_error(format('select pos_bill_member(%L)', v_o), 'device_unpaired', 'P5 a staff login without a till');
  perform pg_temp.done('P5');
end $$;

do $$
declare
  v_n integer := (select count(*) from pg_temp.sections);
begin
  if v_n <> 6 then
    raise exception 'FAIL: % of 6 sections ran (%)', v_n, (select string_agg(name, ', ' order by name) from pg_temp.sections);
  end if;
end $$;

rollback;
select 'VERIFY OK' as result;
