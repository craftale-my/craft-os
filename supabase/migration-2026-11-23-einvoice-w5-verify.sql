-- Self-check for e-invoice W5. Run on craft-os-dev after migration-2026-11-23-einvoice-w5.sql. Everything is
-- rolled back. Success = a result row "VERIFY OK". Sections (one DO block each, ids in the temp table fixture):
-- FIXTURE; V1 the shared ledger lines; V2 the outlet start date; V3 bills over RM 10,000; V4 refunds due a credit
-- note; V5 job bookkeeping and access; V6 bill source and reconciliation source.
-- Bills are written straight into the tables (no till) and priced by pos_bill_totals, as checkout freezes them.
-- Outlet VERIFY E A: SST registered (the default), 10% service charge on dine-in lines, 5 sen rounding; VERIFY E B:
-- no service charge, no start date. Malaysia time:
--   EA1 dine-in E1  2 x Latte 10.00 (6%), Water 2.00 (0%); RM 2.00 off the bill    23.10   5 Oct 12:00
--   EA2 takeaway    Cake 8.00 (8%), packaging 0.50                                  9.20   31 Oct 23:00
--   EA3 dine-in E2  Latte 10.00 (6%); Cake 8.00 (8%) as a takeaway line, pkg 1.00  21.30   1 Nov 05:30 = 31 Oct
--   EA4 dine-in E1  Water 2.00 (0%); a Latte voided                                 2.20   1 Nov 06:30 = 1 Nov
--   EA5 dine-in E1  Latte 10.00 (6%)                                               11.60   30 Sep 12:00 (before the start date)
--   EA6 takeaway    Catering 11,000.00 (0%)                                    11,000.00   10 Oct 15:00 (over RM 10,000)
--   EB1 takeaway    Latte 10.00 (6%) at VERIFY E B                                 10.60   6 Oct 12:00
-- Refunds: RA1 3.00 of EA1 on 6 Oct 12:00; RA5 1.00 of EA5 on 1 Oct 12:00; RA2 all of EA2 on 2 Nov 12:00.
begin;

create function pg_temp.expect_error(p_sql text, p_message text, p_label text) returns void
language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm is distinct from p_message then
      raise exception 'FAIL %: got "%" (expected "%")', p_label, sqlerrm, p_message;
    end if;
    return;
  end;
  raise exception 'FAIL %: no error (expected "%")', p_label, p_message;
end $$;
create function pg_temp.act(p_user uuid) returns void
language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
create temp table fixture (k text primary key, v uuid);
create function pg_temp.put(p_k text, p_v uuid) returns void
language sql as $$ insert into pg_temp.fixture(k, v) values (p_k, p_v) on conflict (k) do update set v = excluded.v $$;
create function pg_temp.id(p_k text) returns uuid
language sql as $$ select v from pg_temp.fixture where k = p_k $$;

-- A paid bill priced as checkout prices it. p_items: [{name, sen, bp, qty?, fee?, type?, voided?}];
-- p_table null = takeaway; p_closed is Malaysia time.
create function pg_temp.paid_bill(p_key text, p_branch text, p_no text, p_table text, p_closed text, p_items jsonb,
                                  p_bill_off integer default null) returns uuid
language plpgsql as $$
declare
  v_at   timestamptz := p_closed::timestamp at time zone 'Asia/Kuala_Lumpur';
  v_b    uuid;
  v_o    uuid;
  v_item uuid;
  v_t    jsonb;
  it     jsonb;
begin
  insert into bills(branch_id, bill_no, table_id, order_type, pax, opened_at)
  values (pg_temp.id(p_branch), p_no, pg_temp.id(p_table), case when p_table is null then 'takeaway' else 'dine_in' end,
          case when p_table is null then null else 2 end, v_at - interval '30 minutes')
  returning id into v_b;
  insert into orders(bill_id, branch_id, order_no, source, client_order_id)
  values (v_b, pg_temp.id(p_branch), p_no || '/1', 'counter', gen_random_uuid())
  returning id into v_o;
  for it in select x.v from jsonb_array_elements(p_items) as x(v) loop
    insert into order_items(order_id, bill_id, name_snapshot, unit_price_sen, sst_rate_bp, qty, takeaway_fee_sen, order_type)
    values (v_o, v_b, it->>'name', (it->>'sen')::integer, (it->>'bp')::integer, coalesce((it->>'qty')::integer, 1),
            coalesce((it->>'fee')::integer, 0), it->>'type')
    returning id into v_item;
    if coalesce((it->>'voided')::boolean, false) then
      update order_items set voided_at = v_at - interval '10 minutes' where id = v_item;
    end if;
  end loop;
  if p_bill_off is not null then
    update bills set discount_kind = 'amount', discount_value = p_bill_off, discount_approved_by = pg_temp.id('owner'),
                     discount_by = pg_temp.id('owner'), discount_at = v_at - interval '5 minutes'
     where id = v_b;
  end if;
  v_t := pos_bill_totals(v_b);
  update bills set status = 'paid', closed_at = v_at, totals = v_t,
                   subtotal_sen = (v_t->>'subtotalSen')::integer, service_charge_sen = (v_t->>'serviceChargeSen')::integer,
                   sst_sen = (v_t->>'sstSen')::integer, takeaway_fee_sen = (v_t->>'takeawayFeeSen')::integer,
                   rounding_sen = (v_t->>'roundingSen')::integer, total_sen = (v_t->>'totalSen')::integer
   where id = v_b;
  perform pg_temp.put(p_key, v_b);
  return v_b;
end $$;

-- A refund of p_sen (null = the whole bill) taken at p_at (Malaysia time), as refund_bill books it.
create function pg_temp.refund(p_key text, p_bill text, p_sen integer, p_at text) returns uuid
language plpgsql as $$
declare
  v_id  uuid := gen_random_uuid();
  v_sen integer;
begin
  select coalesce(p_sen, b.total_sen) into v_sen from bills b where b.id = pg_temp.id(p_bill);
  insert into refunds(id, bill_id, branch_id, amount_sen, method_name, approved_by, created_by, created_at)
  select v_id, b.id, b.branch_id, v_sen, 'Cash', pg_temp.id('owner'), pg_temp.id('owner'),
         p_at::timestamp at time zone 'Asia/Kuala_Lumpur'
    from bills b where b.id = pg_temp.id(p_bill);
  update bills set refunded_sen = refunded_sen + v_sen where id = pg_temp.id(p_bill);
  perform pg_temp.put(p_key, v_id);
  return v_id;
end $$;

-- ── FIXTURE: outlets VERIFY E A and VERIFY E B, tables E1 / E2, the service charge rule, a cashier; the bills
--    and refunds of the header ──
do $$
declare
  v_owner uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_cash  uuid := 'eeeeeeee-0000-0000-0000-00000000e5c1';
  v_a uuid; v_b uuid; v_t uuid;
  r record;
begin
  -- the role defaults decide (owner: every outlet, access_settings; staff: neither)
  update system_role_permissions set permissions = permissions - 'pos_login' - 'all_branches' - 'access_settings' - 'pos_supervise'
   where true;
  insert into branches(name, address) values ('VERIFY E A', 'a') returning id into v_a;
  insert into branches(name, address) values ('VERIFY E B', 'b') returning id into v_b;
  perform pg_temp.put('a', v_a); perform pg_temp.put('b', v_b); perform pg_temp.put('owner', v_owner);
  insert into dining_tables(branch_id, label, sort_order) values (v_a, 'E1', 1) returning id into v_t;
  perform pg_temp.put('e1', v_t);
  insert into dining_tables(branch_id, label, sort_order) values (v_a, 'E2', 2) returning id into v_t;
  perform pg_temp.put('e2', v_t);
  insert into service_charge_rules(branch_id, rate_bp, order_types) values (v_a, 1000, array['dine_in']);
  insert into auth.users (id) values (v_cash);
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id) values
    (v_cash, 'Verify E Cashier', 'trainee', true, current_date, 'staff', v_a);
  perform pg_temp.put('cashier', v_cash);

  perform pg_temp.paid_bill('A1', 'a', 'EA1', 'e1', '2026-10-05 12:00',
    '[{"name": "Verify E Latte", "sen": 1000, "bp": 600, "qty": 2}, {"name": "Verify E Water", "sen": 200, "bp": 0}]', 200);
  perform pg_temp.paid_bill('A2', 'a', 'EA2', null, '2026-10-31 23:00',
    '[{"name": "Verify E Cake", "sen": 800, "bp": 800, "fee": 50}]');
  perform pg_temp.paid_bill('A3', 'a', 'EA3', 'e2', '2026-11-01 05:30',
    '[{"name": "Verify E Latte", "sen": 1000, "bp": 600}, {"name": "Verify E Cake", "sen": 800, "bp": 800, "fee": 100, "type": "takeaway"}]');
  perform pg_temp.paid_bill('A4', 'a', 'EA4', 'e1', '2026-11-01 06:30',
    '[{"name": "Verify E Water", "sen": 200, "bp": 0}, {"name": "Verify E Latte", "sen": 1000, "bp": 600, "voided": true}]');
  perform pg_temp.paid_bill('A5', 'a', 'EA5', 'e1', '2026-09-30 12:00',
    '[{"name": "Verify E Latte", "sen": 1000, "bp": 600}]');
  perform pg_temp.paid_bill('A6', 'a', 'EA6', null, '2026-10-10 15:00',
    '[{"name": "Verify E Catering", "sen": 1100000, "bp": 0}]');
  perform pg_temp.paid_bill('B1', 'b', 'EB1', null, '2026-10-06 12:00',
    '[{"name": "Verify E Latte", "sen": 1000, "bp": 600}]');
  for r in select * from (values ('A1', 2310), ('A2', 920), ('A3', 2130), ('A4', 220), ('A5', 1160), ('A6', 1100000), ('B1', 1060))
                    as x(k, total) loop
    if (select total_sen from bills where id = pg_temp.id(r.k)) is distinct from r.total then
      raise exception 'FAIL fixture: % totals % sen (expected %)', r.k, (select total_sen from bills where id = pg_temp.id(r.k)), r.total;
    end if;
  end loop;

  perform pg_temp.refund('RA1', 'A1', 300, '2026-10-06 12:00');
  perform pg_temp.refund('RA5', 'A5', 100, '2026-10-01 12:00');
  perform pg_temp.refund('RA2', 'A2', null, '2026-11-02 12:00');
end $$;

-- ── V1. pos_ledger_lines: the ledger's figures and SST split; pos_report_ledger reads exactly these ──
do $$
declare
  v_bills  uuid[] := array(select v from pg_temp.fixture where k in ('A1', 'A2', 'A3', 'A4', 'A5', 'A6'));
  v_got    jsonb;
  v_want   jsonb;
  v_ledger jsonb;
  r        record;
begin
  -- every bill: line SST adds up to the bill's SST and, per rate, the bases to its group; base = net + packaging
  for r in select b.id, b.bill_no, b.totals from bills b where b.id = any (v_bills) loop
    if (select coalesce(sum(x.sst_sen), 0) from pos_ledger_lines(array[r.id]) x) <> (r.totals->>'sstSen')::integer then
      raise exception 'FAIL V1 % line SST does not add up to the bill''s', r.bill_no;
    end if;
    if exists (select 1 from pos_ledger_lines(array[r.id]) x where x.sst_base_sen <> x.net_sen + x.takeaway_fee_sen) then
      raise exception 'FAIL V1 % an SST base is not net + packaging', r.bill_no;
    end if;
    if exists (select 1 from jsonb_array_elements(r.totals->'sstGroups') as g(v)
                where (g.v->>'baseSen')::integer
                      <> (select coalesce(sum(x.sst_base_sen), 0) from pos_ledger_lines(array[r.id]) x
                           where x.sst_rate_bp = (g.v->>'rateBp')::integer)) then
      raise exception 'FAIL V1 % a group base differs from its lines', r.bill_no;
    end if;
  end loop;

  -- name, gross, bill share, net, packaging, SST base, taxed rate, SST
  for r in select * from (values
      ('A1', '[["Verify E Latte", 2000, 182, 1818, 0, 1818, 600, 109], ["Verify E Water", 200, 18, 182, 0, 182, 0, 0]]'),
      ('A2', '[["Verify E Cake", 800, 0, 800, 50, 850, 800, 68]]'),
      ('A3', '[["Verify E Cake", 800, 0, 800, 100, 900, 800, 72], ["Verify E Latte", 1000, 0, 1000, 0, 1000, 600, 60]]'),
      ('A4', '[["Verify E Water", 200, 0, 200, 0, 200, 0, 0]]')) as x(k, want) loop
    select jsonb_agg(jsonb_build_array(x.name, x.gross_sen, x.bill_share_sen, x.net_sen, x.takeaway_fee_sen,
                                       x.sst_base_sen, x.tax_rate_bp, x.sst_sen) order by x.name)
      into v_got from pos_ledger_lines(array[pg_temp.id(r.k)]) x;
    if v_got is distinct from r.want::jsonb then raise exception 'FAIL V1 % lines: %', r.k, v_got; end if;
  end loop;
  if (select bday from pos_ledger_lines(array[pg_temp.id('A3')]) limit 1) <> date '2026-10-31' then
    raise exception 'FAIL V1 EA3 is not on business day 31 Oct';
  end if;

  -- an open bill gives nothing
  update bills set status = 'open' where id = pg_temp.id('A4');
  if exists (select 1 from pos_ledger_lines(array[pg_temp.id('A4')])) then raise exception 'FAIL V1 an open bill has lines'; end if;
  update bills set status = 'paid' where id = pg_temp.id('A4');

  -- Reports → Ledger export lines are pos_ledger_lines, in the same order
  perform pg_temp.act(pg_temp.id('owner'));
  v_ledger := pos_report_ledger(array[pg_temp.id('a')], '2026-09-30', '2026-11-01');
  select jsonb_agg(jsonb_build_array(t.l->>'billNo', t.l->>'item', (t.l->>'netSen')::integer, (t.l->>'sstSen')::integer)
                   order by t.ord)
    into v_got from jsonb_array_elements(v_ledger->'lines') with ordinality as t(l, ord);
  select jsonb_agg(jsonb_build_array(b.bill_no, x.name, x.net_sen, x.sst_sen) order by b.closed_at, x.bill_id, x.item_id)
    into v_want from pos_ledger_lines(v_bills) x join bills b on b.id = x.bill_id;
  if jsonb_array_length(v_got) <> 8 or v_got is distinct from v_want then
    raise exception 'FAIL V1 the ledger lines differ: % vs %', v_got, v_want;
  end if;
  perform set_config('request.jwt.claims', '', true);

  -- internal
  if has_function_privilege('authenticated', 'pos_ledger_lines(uuid[])', 'execute')
     or has_function_privilege('anon', 'pos_ledger_lines(uuid[])', 'execute') then
    raise exception 'FAIL V1 pos_ledger_lines is callable by a client';
  end if;
end $$;

select 'VERIFY OK' as result;
rollback;
