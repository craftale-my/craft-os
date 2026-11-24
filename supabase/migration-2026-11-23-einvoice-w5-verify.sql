-- Self-check for e-invoice W5. Run on craft-os-dev after migration-2026-11-23-einvoice-w5.sql. Everything is
-- rolled back. Success = a result row "VERIFY OK". Sections (one DO block each, ids in the temp table fixture):
-- FIXTURE; V1 the shared ledger lines; V2 the outlet start date; V3 bills over RM 10,000; V4 refunds due a credit
-- note; V5 job bookkeeping and access; V6 bill source and reconciliation source; V7 claiming a draft; V8 closed months
-- not reported yet, and a run written 'running' first.
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

-- ── V2. The start date: no start date, nothing reported; HQ only; later freely, earlier never once sent ──
do $$
declare
  v_a   uuid := pg_temp.id('a');
  v_b   uuid := pg_temp.id('b');
  v_got text;
  v_doc einvoice_documents;
  v_msg text := 'A bill in this document is not reported by us (another outlet, not paid, or before the outlet''s e-invoice start date)';
  v_locked text := 'E-invoices were already sent for this outlet: the start date can only move later.';
begin
  if exists (select 1 from einvoice_unlinked_paid_bills(v_a, '2026-10-01')) then
    raise exception 'FAIL V2 bills offered before the outlet has a start date';
  end if;
  perform pg_temp.act(pg_temp.id('cashier'));
  perform pg_temp.expect_error(format('select einvoice_set_outlet_start(%L, %L)', v_a, '2026-10-01'),
                               'Only HQ can change when an outlet''s e-invoices start.', 'V2 a cashier sets it');
  perform pg_temp.expect_error(format('update branches set einvoice_from = %L where id = %L', '2026-10-01', v_a),
                               'Only HQ can change when an outlet''s e-invoices start.', 'V2 a cashier writes it');
  perform pg_temp.act(pg_temp.id('owner'));
  if not (einvoice_set_outlet_start(v_a, '2026-10-01')->>'ok')::boolean then raise exception 'FAIL V2 set'; end if;
  perform set_config('request.jwt.claims', '', true);

  -- October by business day: EA1, EA2, EA3 (1 Nov 05:30); not EA6 (over RM 10,000), EA5 (September), EA4 (1 Nov 06:30)
  select string_agg(u.bill_no || '@' || to_char(u.day, 'YYYY-MM-DD'), ',' order by u.day, u.bill_no) into v_got
    from einvoice_unlinked_paid_bills(v_a, '2026-10-15') u;
  if v_got is distinct from 'EA1@2026-10-05,EA2@2026-10-31,EA3@2026-10-31' then raise exception 'FAIL V2 October: %', v_got; end if;
  if exists (select 1 from einvoice_unlinked_paid_bills(v_a, '2026-09-01')) then raise exception 'FAIL V2 September offered'; end if;
  select string_agg(u.bill_no, ',') into v_got from einvoice_unlinked_paid_bills(v_a, '2026-11-01') u;
  if v_got is distinct from 'EA4' then raise exception 'FAIL V2 November: %', v_got; end if;
  if exists (select 1 from einvoice_unlinked_paid_bills(v_b, '2026-10-01')) then raise exception 'FAIL V2 outlet B offered'; end if;

  -- consolidate October: its bills leave the list; claimed twice is refused
  v_doc := einvoice_create_document(
    jsonb_build_object('kind', 'consolidated_invoice', 'environment', 'sandbox', 'branchId', v_a,
                       'periodStart', '2026-10-01', 'periodEnd', '2026-10-31', 'totalSen', 2310 + 920 + 2130),
    array[pg_temp.id('A1'), pg_temp.id('A2'), pg_temp.id('A3')], '{}');
  perform pg_temp.put('con_oct', v_doc.id);
  if exists (select 1 from einvoice_unlinked_paid_bills(v_a, '2026-10-01')) then raise exception 'FAIL V2 linked bills offered'; end if;
  perform pg_temp.expect_error(
    format('select einvoice_create_document(%L::jsonb, array[%L]::uuid[], %L::uuid[])',
           jsonb_build_object('kind', 'invoice', 'environment', 'sandbox', 'branchId', v_a, 'billId', pg_temp.id('A1'), 'totalSen', 2310),
           pg_temp.id('A1'), '{}'),
    'A bill or refund in this document already has a live e-invoice', 'V2 a bill twice');

  -- a bill before the start date, a bill of an outlet without one, a bill of another outlet, a refund of a bill
  -- before the start date: refused
  perform pg_temp.expect_error(
    format('select einvoice_create_document(%L::jsonb, array[%L]::uuid[], %L::uuid[])',
           jsonb_build_object('kind', 'invoice', 'environment', 'sandbox', 'branchId', v_a, 'totalSen', 1160), pg_temp.id('A5'), '{}'),
    v_msg, 'V2 before the start date');
  perform pg_temp.expect_error(
    format('select einvoice_create_document(%L::jsonb, array[%L]::uuid[], %L::uuid[])',
           jsonb_build_object('kind', 'invoice', 'environment', 'sandbox', 'branchId', v_b, 'totalSen', 1060), pg_temp.id('B1'), '{}'),
    v_msg, 'V2 an outlet without a start date');
  perform pg_temp.expect_error(
    format('select einvoice_create_document(%L::jsonb, array[%L]::uuid[], %L::uuid[])',
           jsonb_build_object('kind', 'invoice', 'environment', 'sandbox', 'branchId', v_b, 'totalSen', 220), pg_temp.id('A4'), '{}'),
    v_msg, 'V2 another outlet''s bill');
  perform pg_temp.expect_error(
    format('select einvoice_create_document(%L::jsonb, %L::uuid[], array[%L]::uuid[])',
           jsonb_build_object('kind', 'credit_note', 'environment', 'sandbox', 'branchId', v_a, 'totalSen', 100), '{}', pg_temp.id('RA5')),
    v_msg, 'V2 a refund of a bill before the start date');

  -- with a live document: earlier or cleared is refused, later is fine
  perform pg_temp.act(pg_temp.id('owner'));
  perform pg_temp.expect_error(format('select einvoice_set_outlet_start(%L, %L)', v_a, '2026-09-01'), v_locked, 'V2 earlier');
  perform pg_temp.expect_error(format('select einvoice_set_outlet_start(%L, null)', v_a), v_locked, 'V2 cleared');
  perform einvoice_set_outlet_start(v_a, '2026-10-02');
  perform pg_temp.expect_error(format('select einvoice_set_outlet_start(%L, %L)', v_a, '2026-10-01'), v_locked, 'V2 back again');
  perform pg_temp.expect_error(format('select einvoice_set_outlet_start(%L, %L)', gen_random_uuid(), '2026-10-01'),
                               'Outlet not found', 'V2 unknown outlet');
  -- without a live document anything goes (outlet B has none)
  perform einvoice_set_outlet_start(v_b, '2026-12-01');
  perform einvoice_set_outlet_start(v_b, null);
  perform set_config('request.jwt.claims', '', true);
  if (select einvoice_from from branches where id = v_a) <> date '2026-10-02' then raise exception 'FAIL V2 A start date'; end if;
  if (select einvoice_from from branches where id = v_b) is not null then raise exception 'FAIL V2 B start date'; end if;
end $$;

-- ── V3. Bills over RM 10,000: never consolidated (V2), listed for access_settings until issued individually ──
do $$
declare
  v_a   uuid := pg_temp.id('a');
  v_got text;
begin
  perform pg_temp.act(pg_temp.id('owner'));
  select string_agg(l.bill_no, ',') into v_got from einvoice_large_bills() l where l.branch_id in (v_a, pg_temp.id('b'));
  if v_got is distinct from 'EA6' then raise exception 'FAIL V3 large bills: %', v_got; end if;
  if (select l.day from einvoice_large_bills() l where l.id = pg_temp.id('A6')) <> date '2026-10-10' then
    raise exception 'FAIL V3 business day';
  end if;
  perform pg_temp.act(pg_temp.id('cashier'));
  if exists (select 1 from einvoice_large_bills()) then raise exception 'FAIL V3 a cashier sees large bills'; end if;
  perform set_config('request.jwt.claims', '', true);
  perform einvoice_create_document(
    jsonb_build_object('kind', 'invoice', 'environment', 'sandbox', 'branchId', v_a, 'billId', pg_temp.id('A6'),
                       'totalSen', 1100000, 'buyer', jsonb_build_object('name', 'Verify Caterer Sdn Bhd')),
    array[pg_temp.id('A6')], '{}');
  perform pg_temp.act(pg_temp.id('owner'));
  if exists (select 1 from einvoice_large_bills() l where l.branch_id = v_a) then raise exception 'FAIL V3 issued bill still listed'; end if;
  perform set_config('request.jwt.claims', '', true);
  if has_function_privilege('anon', 'einvoice_large_bills()', 'execute') then raise exception 'FAIL V3 anon may call it'; end if;
end $$;

-- ── V4. Refunds due a credit note: only once the original is valid; by the refund's business month; once ──
do $$
declare
  v_a   uuid := pg_temp.id('a');
  v_got text;
  v_doc einvoice_documents;
  r     record;
begin
  -- the October consolidated invoice (V2) is still a draft: nothing is due
  if exists (select 1 from einvoice_consolidated_refund_months('2027-01-01') m where m.branch_id = v_a) then
    raise exception 'FAIL V4 refunds due before the invoice is valid';
  end if;
  update einvoice_documents set status = 'valid', lhdn_uuid = 'VERIFY-E-CON-OCT' where id = pg_temp.id('con_oct');

  -- RA1 (6 Oct, of EA1) → October; RA2 (2 Nov, of EA2) → November; RA5 (of EA5, never reported) never
  select string_agg(to_char(m.month, 'YYYY-MM'), ',' order by m.month) into v_got
    from einvoice_consolidated_refund_months('2027-01-01') m where m.branch_id = v_a;
  if v_got is distinct from '2026-10,2026-11' then raise exception 'FAIL V4 months: %', v_got; end if;
  select string_agg(to_char(m.month, 'YYYY-MM'), ',') into v_got
    from einvoice_consolidated_refund_months('2026-11-01') m where m.branch_id = v_a;
  if v_got is distinct from '2026-10' then raise exception 'FAIL V4 months before November: %', v_got; end if;

  select * into r from einvoice_pending_consolidated_refunds(v_a, '2026-10-20');
  if r.refund_id is distinct from pg_temp.id('RA1') or r.amount_sen <> 300 or r.refund_day <> date '2026-10-06'
     or r.invoice_uuid is distinct from 'VERIFY-E-CON-OCT' or r.bill_no <> 'EA1' or r.branch_id <> v_a
     or (r.totals->>'totalSen')::integer <> 2310
     or r.invoice_code is distinct from (select code_number from einvoice_documents where id = pg_temp.id('con_oct')) then
    raise exception 'FAIL V4 October refund: %', row_to_json(r);
  end if;
  select string_agg(p.refund_id::text, ',') into v_got from einvoice_pending_consolidated_refunds(v_a, '2026-11-01') p;
  if v_got is distinct from pg_temp.id('RA2')::text then raise exception 'FAIL V4 November refunds: %', v_got; end if;
  if (select p.refunded_before_sen from einvoice_pending_consolidated_refunds(v_a, '2026-11-01') p) is distinct from 0
     or (select p.refunded_before_sen from einvoice_pending_consolidated_refunds(v_a, '2026-10-20') p) is distinct from 0 then
    raise exception 'FAIL V4 consolidated refunds carry refunded_before_sen';
  end if;
  if (select amount_sen from einvoice_pending_consolidated_refunds(v_a, '2026-11-01')) <> 920 then
    raise exception 'FAIL V4 RA2 is the whole bill';
  end if;

  -- single: EA4 individually invoiced and valid; its refund is due once, with the invoice's buyer
  v_doc := einvoice_create_document(
    jsonb_build_object('kind', 'invoice', 'environment', 'sandbox', 'branchId', v_a, 'billId', pg_temp.id('A4'),
                       'totalSen', 220, 'buyer', jsonb_build_object('name', 'Verify Buyer')),
    array[pg_temp.id('A4')], '{}');
  update einvoice_documents set status = 'valid', lhdn_uuid = 'VERIFY-E-INV-A4' where id = v_doc.id;
  perform pg_temp.refund('RA4', 'A4', 100, '2026-11-02 13:00');
  select string_agg(p.refund_id::text || '/' || p.invoice_uuid || '/' || (p.invoice_buyer->>'name'), ',') into v_got
    from einvoice_pending_single_refunds() p where p.branch_id = v_a;
  if v_got is distinct from pg_temp.id('RA4')::text || '/VERIFY-E-INV-A4/Verify Buyer' then
    raise exception 'FAIL V4 single refunds: %', v_got;
  end if;
  if (select p.refunded_before_sen from einvoice_pending_single_refunds() p where p.refund_id = pg_temp.id('RA4')) is distinct from 0 then
    raise exception 'FAIL V4 the first refund of a bill has refunded_before_sen 0';
  end if;
  perform einvoice_create_document(
    jsonb_build_object('kind', 'credit_note', 'environment', 'sandbox', 'branchId', v_a, 'billId', pg_temp.id('A4'), 'totalSen', 100),
    '{}', array[pg_temp.id('RA4')]);
  if exists (select 1 from einvoice_pending_single_refunds() p where p.branch_id = v_a) then
    raise exception 'FAIL V4 a credited refund is still due';
  end if;
  -- a second refund of the same bill carries what was refunded before it (the credit notes split cumulatively)
  perform pg_temp.refund('RA4b', 'A4', 20, '2026-11-02 14:00');
  if (select p.refunded_before_sen from einvoice_pending_single_refunds() p where p.refund_id = pg_temp.id('RA4b')) is distinct from 100 then
    raise exception 'FAIL V4 the second refund of a bill has refunded_before_sen = the first refund';
  end if;
  perform einvoice_create_document(
    jsonb_build_object('kind', 'credit_note', 'environment', 'sandbox', 'branchId', v_a, 'billId', pg_temp.id('A4'), 'totalSen', 20),
    '{}', array[pg_temp.id('RA4b')]);
  perform pg_temp.expect_error(
    format('select einvoice_create_document(%L::jsonb, %L::uuid[], array[%L]::uuid[])',
           jsonb_build_object('kind', 'credit_note', 'environment', 'sandbox', 'branchId', v_a, 'totalSen', 100), '{}', pg_temp.id('RA4')),
    'A bill or refund in this document already has a live e-invoice', 'V4 a refund twice');

  -- October's consolidated credit note takes RA1: only November is left
  perform einvoice_create_document(
    jsonb_build_object('kind', 'consolidated_credit_note', 'environment', 'sandbox', 'branchId', v_a,
                       'periodStart', '2026-10-01', 'periodEnd', '2026-10-31', 'totalSen', 300),
    '{}', array[pg_temp.id('RA1')]);
  select string_agg(to_char(m.month, 'YYYY-MM'), ',') into v_got
    from einvoice_consolidated_refund_months('2027-01-01') m where m.branch_id = v_a;
  if v_got is distinct from '2026-11' then raise exception 'FAIL V4 months after the credit note: %', v_got; end if;
end $$;

-- ── V5. Job bookkeeping, the tables' access, the service-role functions closed ──
do $$
declare
  v_a  uuid := pg_temp.id('a');
  n    integer;
  m    integer;
  fn   text;
begin
  for n in 1..3 loop
    if einvoice_record_attempt('CON|verify|2026-10', 'consolidated_invoice', v_a, '2026-10-01', null, false, 'LHDN said no') <> n then
      raise exception 'FAIL V5 failure %', n;
    end if;
  end loop;
  -- (each read of the table is its own statement: a statement does not see the writes of a function it calls)
  if einvoice_record_attempt('CON|verify|2026-10', 'consolidated_invoice', v_a, '2026-10-01', null, true, null) <> 0 then
    raise exception 'FAIL V5 a success does not reset';
  end if;
  if (select last_error from einvoice_job_attempts where key = 'CON|verify|2026-10') is not null then
    raise exception 'FAIL V5 a success keeps the error';
  end if;
  if einvoice_record_attempt('CN|' || pg_temp.id('RA1'), 'credit_note', v_a, null, pg_temp.id('RA1'), false, repeat('x', 2000)) <> 1 then
    raise exception 'FAIL V5 a credit note attempt';
  end if;
  if length((select last_error from einvoice_job_attempts where key = 'CN|' || pg_temp.id('RA1'))) is distinct from 1000 then
    raise exception 'FAIL V5 the error is not cut at 1000 characters';
  end if;
  insert into einvoice_job_runs(environment, outcome, report) values ('sandbox', 'not_set_up', '{"notSetUp": "verify"}');
  begin
    insert into einvoice_job_runs(environment, outcome) values ('sandbox', 'maybe');
    raise exception 'FAIL V5 an unknown outcome was accepted';
  exception when check_violation then null;
  end;

  -- access_settings reads the bookkeeping; a cashier reads nothing
  perform pg_temp.act(pg_temp.id('owner'));
  set local role authenticated;
  select count(*) into n from einvoice_job_attempts where branch_id = v_a;
  select count(*) into m from einvoice_job_runs where report->>'notSetUp' = 'verify';
  reset role;
  if n <> 2 or m <> 1 then raise exception 'FAIL V5 the owner reads % attempts, % runs (expected 2, 1)', n, m; end if;
  perform pg_temp.act(pg_temp.id('cashier'));
  set local role authenticated;
  select count(*) into n from einvoice_job_attempts;
  select count(*) into m from einvoice_job_runs;
  reset role;
  if n <> 0 or m <> 0 then raise exception 'FAIL V5 a cashier reads % attempts, % runs', n, m; end if;
  perform set_config('request.jwt.claims', '', true);

  foreach fn in array array[
    'einvoice_bill_lines(uuid[])', 'einvoice_bill_source(uuid)', 'einvoice_unlinked_paid_bills(uuid, date)',
    'einvoice_create_document(jsonb, uuid[], uuid[])', 'einvoice_pending_single_refunds()',
    'einvoice_pending_consolidated_refunds(uuid, date)', 'einvoice_consolidated_refund_months(date)',
    'einvoice_record_attempt(text, text, uuid, date, uuid, boolean, text)', 'einvoice_reconcile_source(date, date)',
    'branches_einvoice_from_guard()'] loop
    if has_function_privilege('authenticated', fn, 'execute') or has_function_privilege('anon', fn, 'execute') then
      raise exception 'FAIL V5 % is callable by a client', fn;
    end if;
  end loop;
  if not has_function_privilege('authenticated', 'einvoice_set_outlet_start(uuid, date)', 'execute')
     or has_function_privilege('anon', 'einvoice_set_outlet_start(uuid, date)', 'execute') then
    raise exception 'FAIL V5 einvoice_set_outlet_start grants';
  end if;
end $$;

-- ── V6. The bill source and the reconciliation source ──
do $$
declare
  v    jsonb;
  v_a  text := pg_temp.id('a')::text;
  r    record;
begin
  v := einvoice_bill_source(pg_temp.id('A3'));
  if v->'bill'->>'businessDay' <> '2026-10-31' or v->'bill'->>'einvoiceFrom' <> '2026-10-02'
     or (v->'bill'->>'totalSen')::integer <> 2130 or v->'bill'->>'status' <> 'paid'
     or jsonb_array_length(v->'lines') <> 2 or (v->'totals'->>'sstSen')::integer <> 132
     or (select sum((l->>'sstSen')::integer) from jsonb_array_elements(v->'lines') l) <> 132
     or (select (l->>'takeawayFeeSen')::integer from jsonb_array_elements(v->'lines') l where l->>'name' = 'Verify E Cake') <> 100
     or (select (l->>'taxRateBp')::integer from jsonb_array_elements(v->'lines') l where l->>'name' = 'Verify E Cake') <> 800 then
    raise exception 'FAIL V6 EA3 source: %', v;
  end if;
  if einvoice_bill_source(gen_random_uuid()) is not null then raise exception 'FAIL V6 an unknown bill has a source'; end if;

  v := einvoice_reconcile_source('2026-09-01', '2026-11-30');
  if (select count(*) from jsonb_array_elements(v->'bills') b where b->>'branchId' in (v_a, pg_temp.id('b')::text)) <> 7 then
    raise exception 'FAIL V6 reconcile bills';
  end if;
  if (select jsonb_array_length(b->'lines') from jsonb_array_elements(v->'bills') b where b->>'billNo' = 'EA1' and b->>'branchId' = v_a) <> 2 then
    raise exception 'FAIL V6 reconcile lines';
  end if;
  for r in select * from (values ('2026-09', 1160), ('2026-10', 2310 + 920 + 2130 + 1100000), ('2026-11', 220)) as x(month, nett) loop
    if (select (m->>'overviewSen')::integer from jsonb_array_elements(v->'months') m
         where m->>'branchId' = v_a and m->>'month' = r.month) is distinct from r.nett then
      raise exception 'FAIL V6 overview % for %', (select m from jsonb_array_elements(v->'months') m where m->>'branchId' = v_a and m->>'month' = r.month), r.month;
    end if;
  end loop;
end $$;

-- ── V7. Claiming a draft for sending ──
do $$
declare
  v_a  uuid := pg_temp.id('a');
  v_id uuid := gen_random_uuid();
begin
  insert into einvoice_documents (id, kind, environment, branch_id, code_number, total_sen)
  values (v_id, 'consolidated_invoice', 'sandbox', v_a, 'CON-VERIFY-CLAIM', 100);
  if (select count(*) from einvoice_claim_send(v_id)) <> 1 then raise exception 'FAIL V7 first claim'; end if;
  if (select send_started_at from einvoice_documents where id = v_id) is null then raise exception 'FAIL V7 claim not stamped'; end if;
  if (select count(*) from einvoice_claim_send(v_id)) <> 0 then raise exception 'FAIL V7 second claim won'; end if;
  update einvoice_documents set send_started_at = null, needs_check = true where id = v_id;
  if (select count(*) from einvoice_claim_send(v_id)) <> 0 then raise exception 'FAIL V7 needs_check draft claimable'; end if;
  update einvoice_documents set needs_check = false, status = 'submitted' where id = v_id;
  if (select count(*) from einvoice_claim_send(v_id)) <> 0 then raise exception 'FAIL V7 submitted document claimable'; end if;
  update einvoice_documents set status = 'draft' where id = v_id;
  if (select count(*) from einvoice_claim_send(v_id)) <> 1 then raise exception 'FAIL V7 released draft not claimable'; end if;
  if has_function_privilege('authenticated', 'einvoice_claim_send(uuid)', 'execute')
     or has_function_privilege('anon', 'einvoice_claim_send(uuid)', 'execute') then
    raise exception 'FAIL V7 einvoice_claim_send grants';
  end if;
end $$;

-- ── V8. Closed months not reported yet (einvoice_unreported_months), and a run written 'running' first ──
-- Outlet B starts mid-month (15 Aug): EB0 (10 Aug) is before it, EB2 (20 Aug) counts; September holds only a bill
-- over RM 10,000 (EB3); October holds EB1 until it is consolidated; a bill of the current business month (EB4)
-- never counts. Outlet A's bills from its start date on all sit in documents (V2–V4).
do $$
declare
  v_a   uuid := pg_temp.id('a');
  v_b   uuid := pg_temp.id('b');
  v_got text;
  v_run uuid;
begin
  update branches set einvoice_from = '2026-08-15' where id = v_b;
  perform pg_temp.paid_bill('B0', 'b', 'EB0', null, '2026-08-10 12:00', '[{"name": "Verify E Latte", "sen": 1000, "bp": 600}]');
  perform pg_temp.paid_bill('B2', 'b', 'EB2', null, '2026-08-20 12:00', '[{"name": "Verify E Latte", "sen": 1000, "bp": 600}]');
  perform pg_temp.paid_bill('B3', 'b', 'EB3', null, '2026-09-12 12:00', '[{"name": "Verify E Catering", "sen": 1100000, "bp": 0}]');
  perform pg_temp.paid_bill('B4', 'b', 'EB4', null, to_char(pos_business_day(now()), 'YYYY-MM-DD') || ' 12:00',
                            '[{"name": "Verify E Latte", "sen": 1000, "bp": 600}]');

  -- access_settings: B's August (1 bill, the mid-month start) and October, oldest first; nothing of A
  perform pg_temp.act(pg_temp.id('owner'));
  select string_agg(to_char(u.month, 'YYYY-MM') || '/' || u.bills || '/' || u.total_sen, ',') into v_got
    from einvoice_unreported_months() u where u.branch_id = v_b;
  if v_got is distinct from '2026-08/1/1060,2026-10/1/1060' then raise exception 'FAIL V8 outlet B: %', v_got; end if;
  if exists (select 1 from einvoice_unreported_months() u where u.branch_id = v_a) then
    raise exception 'FAIL V8 outlet A has unreported months: %', (select string_agg(u.month::text, ',') from einvoice_unreported_months() u where u.branch_id = v_a);
  end if;
  -- a caller without access_settings sees nothing; no signed-in user (the service role) sees everything
  perform pg_temp.act(pg_temp.id('cashier'));
  if exists (select 1 from einvoice_unreported_months()) then raise exception 'FAIL V8 a cashier sees unreported months'; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  if (select count(*) from einvoice_unreported_months() u where u.branch_id = v_b) <> 2 then
    raise exception 'FAIL V8 the service role does not see the unreported months';
  end if;
  perform set_config('request.jwt.claims', '', true);

  -- October consolidated: only August is left
  perform einvoice_create_document(
    jsonb_build_object('kind', 'consolidated_invoice', 'environment', 'sandbox', 'branchId', v_b,
                       'periodStart', '2026-10-01', 'periodEnd', '2026-10-31', 'totalSen', 1060),
    array[pg_temp.id('B1')], '{}');
  select string_agg(to_char(u.month, 'YYYY-MM'), ',') into v_got from einvoice_unreported_months() u where u.branch_id = v_b;
  if v_got is distinct from '2026-08' then raise exception 'FAIL V8 after consolidating October: %', v_got; end if;

  if not has_function_privilege('authenticated', 'einvoice_unreported_months()', 'execute')
     or not has_function_privilege('service_role', 'einvoice_unreported_months()', 'execute')
     or has_function_privilege('anon', 'einvoice_unreported_months()', 'execute') then
    raise exception 'FAIL V8 einvoice_unreported_months grants';
  end if;

  -- a run is written 'running' with no finish, then completed
  insert into einvoice_job_runs(environment, outcome, report) values ('sandbox', 'running', '{"verify": "running"}')
  returning id into v_run;
  if (select finished_at from einvoice_job_runs where id = v_run) is not null then raise exception 'FAIL V8 a running run has finished'; end if;
  update einvoice_job_runs set outcome = 'ok', finished_at = now() where id = v_run;
  if (select outcome from einvoice_job_runs where id = v_run) <> 'ok' then raise exception 'FAIL V8 the run was not completed'; end if;
end $$;

select 'VERIFY OK' as result;
rollback;
