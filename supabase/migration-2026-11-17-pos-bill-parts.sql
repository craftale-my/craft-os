-- ============================================================================
-- Craft OS — POS part payments: split equally / by amount (2026-11-17). Run on craft-os-dev after
-- migration-2026-11-16-pos-split-bill.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-11-17-pos-split-bill.md
-- Design: docs/superpowers/specs/2026-11-16-pos-split-bill-design.md (§3.5, §4.6, §6, Part B)
--
-- B1  bill_parts (one row per part paid on an open bill) and payments.part_id; pos_part_quote (the
--     equal share, a multiple of 5 sen; the last share takes the rest); pay_bill_part (one part,
--     replay-safe by its client id); the part receipt (not an official receipt).
-- B2  checkout_bill takes the balance (total − parts); its replay, pos_checkout_same_payments and
--     pos_checkout_result look at the final payments only. Guards: void item / bill, item / bill
--     discount, merge as the source, and every split path (pos_split_check) refuse a bill with a part.
--     pay_bill_part takes p_paid_sen, the paid parts the screen saw (a 6th argument, default null).
-- B3  The final receipt lists the parts' payments first, labelled; pos_checkout_state and
--     pos_open_bill_summaries carry paidSen.
-- Re-run hazards: re-running migration-2026-11-16-pos-split-bill.sql puts back the part-less
-- checkout_bill, pos_split_check, pos_receipt_payload and pos_checkout_state (its pos_insert_payments
-- writes part_id since B1f; an older text that does not makes pay_bill_part stop with "STOP: ...");
-- migration-2026-10-29-pos-device-till.sql the unguarded void_bill / void_order_item;
-- migration-2026-10-30-pos-discounts.sql the unguarded discounts and merge_bills;
-- migration-2026-10-26-pos-frontend.sql the old pos_open_bill_summaries (paid_sen gone) — re-run
-- this file after any of them.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('checkout_items(uuid,jsonb,jsonb,uuid)') is null then
    raise exception 'STOP: run migration-2026-11-16-pos-split-bill.sql first (checkout_items is missing)';
  end if;
end $$;

-- ── B1. Schema ──────────────────────────────────────────────────────────────
create table if not exists bill_parts (
  id             uuid primary key,                          -- client-generated: a resend is safe
  bill_id        uuid not null references bills(id),
  branch_id      uuid not null references branches(id),
  part_no        integer not null check (part_no between 1 and 20),
  ways           integer check (ways between 2 and 20),     -- an equal split's N; null = by amount
  amount_sen     integer not null check (amount_sen > 0),
  shift_id       uuid not null references pos_shifts(id),
  taken_by       uuid references staff(id),
  device_id      uuid references pos_devices(id) on delete set null,
  taken_at       timestamptz not null default now(),
  receipt_queued boolean not null default false,            -- a replay answers it too
  unique (bill_id, part_no)
);
alter table bill_parts enable row level security;
revoke all on bill_parts from public, anon, authenticated;
grant select on bill_parts to authenticated;
drop policy if exists pos_read on bill_parts;
create policy pos_read on bill_parts for select to authenticated
  using (branch_id in (select pos_readable_branches()));
alter table payments add column if not exists part_id uuid references bill_parts(id);
create index if not exists payments_part_idx on payments(part_id) where part_id is not null;

-- ── B1. Reads ───────────────────────────────────────────────────────────────
-- What the bill's parts have paid so far. Internal.
create or replace function pos_bill_paid_parts(p_bill_id uuid) returns integer
language sql stable set search_path = public, pg_temp as $$
  select coalesce(sum(amount_sen), 0)::integer from bill_parts where bill_id = p_bill_id
$$;
revoke all on function pos_bill_paid_parts(uuid) from public, anon, authenticated;

-- pos_insert_payments: the text of migration-2026-11-16-pos-split-bill.sql (S3) as it was before B1f,
-- with the lines marked B1 changed — p_part_id is written to payments.part_id (11-16's B1f text does
-- the same with an if, for a database without the column). Internal.
create or replace function pos_insert_payments(p_bill_id uuid, p_branch uuid, p_shift uuid, p_payments jsonb,
                                               p_part_id uuid default null) returns void
language plpgsql set search_path = public, pg_temp as $$
declare
  v_p        jsonb;
  v_m        payment_methods;
  v_amount   integer;
  v_tendered integer;
  v_n        integer := 0;
begin
  for v_p in select * from jsonb_array_elements(p_payments) loop
    v_n := v_n + 1;
    select * into v_m from payment_methods where id = (v_p->>'methodId')::uuid;
    v_amount   := (v_p->'amountSen')::numeric::integer;
    v_tendered := case when v_m.kind = 'cash' and jsonb_typeof(v_p->'tenderedSen') = 'number'
                       then (v_p->'tenderedSen')::numeric::integer end;
    insert into payments(bill_id, branch_id, method_id, method_name, kind, amount_sen, tendered_sen,
                         change_sen, reference, taken_by, line_no, shift_id, part_id)                    -- B1: part_id
    values (p_bill_id, p_branch, v_m.id, v_m.name, v_m.kind, v_amount, v_tendered,
            coalesce(v_tendered - v_amount, 0),
            nullif(trim(left(case when jsonb_typeof(v_p->'reference') = 'string' then v_p->>'reference' end, 60)), ''),
            pos_actor(), v_n, p_shift, p_part_id);                                                       -- B1: p_part_id
  end loop;
end $$;
revoke all on function pos_insert_payments(uuid, uuid, uuid, jsonb, uuid) from public, anon, authenticated;

-- A part's payments compared with a resend's (pos_checkout_same_payments over payments.part_id). Internal.
create or replace function pos_part_same_payments(p_part_id uuid, p_payments jsonb) returns boolean
language sql stable set search_path = public, pg_temp as $$
  with given as (
    select case when jsonb_typeof(p_payments) = 'array' then p_payments else null end as arr
  )
  select given.arr is not null
     and jsonb_array_length(given.arr) = (select count(*) from payments p where p.part_id = p_part_id)
     and not exists (
       select 1
         from jsonb_array_elements(coalesce(given.arr, '[]'::jsonb)) with ordinality as x(v, n)
         left join payments p on p.part_id = p_part_id and p.line_no = x.n
        where p.id is null
           or lower(x.v->>'methodId') is distinct from p.method_id::text
           or (case when jsonb_typeof(x.v->'amountSen') = 'number' then (x.v->>'amountSen')::numeric end)
                is distinct from p.amount_sen::numeric
           or (case when jsonb_typeof(x.v->'tenderedSen') = 'number' then (x.v->>'tenderedSen')::numeric end)
                is distinct from p.tendered_sen::numeric)
  from given
$$;
revoke all on function pos_part_same_payments(uuid, jsonb) from public, anon, authenticated;

-- pay_bill_part's answer for a part (a replay gives it again). Internal.
create or replace function pos_part_result(p_part_id uuid) returns jsonb
language sql stable set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'partId', bp.id, 'partNo', bp.part_no, 'ways', bp.ways, 'amountSen', bp.amount_sen,
    'paidSen', pos_bill_paid_parts(bp.bill_id),
    'balanceSen', coalesce((pos_bill_totals(bp.bill_id)->>'totalSen')::integer, 0) - pos_bill_paid_parts(bp.bill_id),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.method_name, 'kind', p.kind, 'amountSen', p.amount_sen,
                                          'tenderedSen', p.tendered_sen, 'reference', p.reference)
                       order by p.line_no, p.id)
        from payments p where p.part_id = bp.id), '[]'::jsonb),
    'changeSen', (select coalesce(sum(p.change_sen), 0) from payments p where p.part_id = bp.id),
    'receiptQueued', bp.receipt_queued)
  from bill_parts bp where bp.id = p_part_id
$$;
revoke all on function pos_part_result(uuid) from public, anon, authenticated;

-- A part id seen before: the first answer for the same bill, amount and payments. Internal.
create or replace function pos_part_replay(p_part bill_parts, p_bill_id uuid, p_branch uuid, p_amount_sen integer,
                                           p_payments jsonb) returns jsonb
language plpgsql stable set search_path = public, pg_temp as $$
begin
  if p_part.bill_id <> p_bill_id or p_part.branch_id <> p_branch then
    raise exception 'This part id belongs to another bill';
  end if;
  if p_part.amount_sen is distinct from p_amount_sen or not pos_part_same_payments(p_part.id, p_payments) then
    raise exception 'This payment was already recorded with other amounts — check Today''s bills';
  end if;
  return pos_part_result(p_part.id);
end $$;
revoke all on function pos_part_replay(bill_parts, uuid, uuid, integer, jsonb) from public, anon, authenticated;

-- ── B1. The quote (spec §4.6) ────────────────────────────────────────────────
-- The caller branch's open bill: its total, what the parts paid, the balance, and for p_ways the
-- equal share — the bill's earlier N when an equal share was paid (p_ways is then ignored), else
-- p_ways (2…20); floor(balance / shares left / 5) × 5, the last share the whole balance. A share
-- is never 0: at least 5 sen, or the balance when it is under 5 (B1f). p_ways null: the by-amount
-- view, ways and shareSen null. sharesPaid counts equal shares only.
create or replace function pos_part_quote(p_bill_id uuid, p_ways integer) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_bill    bills;
  v_total   integer;
  v_paid    integer;
  v_parts   integer;
  v_shares  integer;
  v_fixed   integer;
  v_ways    integer;
  v_share   integer;
begin
  select * into v_bill from bills where id = p_bill_id and branch_id = pos_my_branch();
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.status <> 'open' then
    raise exception 'This bill is already %', case v_bill.status when 'paid' then 'paid'
                                                                 when 'voided' then 'voided'
                                                                 else 'merged into another bill' end;
  end if;
  v_total := coalesce((pos_bill_totals(v_bill.id)->>'totalSen')::integer, 0);
  v_paid  := pos_bill_paid_parts(v_bill.id);
  select count(*)::integer, (count(*) filter (where ways is not null))::integer into v_parts, v_shares
    from bill_parts where bill_id = v_bill.id;
  if p_ways is not null then
    select ways into v_fixed from bill_parts where bill_id = v_bill.id and ways is not null order by part_no desc limit 1;
    v_ways := coalesce(v_fixed, p_ways);
    if v_ways < 2 or v_ways > 20 then raise exception 'Invalid split'; end if;
    v_share := case when v_ways - v_shares <= 1 then v_total - v_paid
                    else greatest((floor((v_total - v_paid)::numeric / (v_ways - v_shares) / 5) * 5)::integer,
                                  least(5, v_total - v_paid)) end;                                 -- B1f: never 0
  end if;
  return jsonb_build_object('totalSen', v_total, 'paidSen', v_paid, 'balanceSen', v_total - v_paid,
                            'partsPaid', v_parts, 'sharesPaid', v_shares, 'ways', v_ways, 'shareSen', v_share);
end $$;
revoke all on function pos_part_quote(uuid, integer) from public, anon;
grant execute on function pos_part_quote(uuid, integer) to authenticated;

-- ── B1. The part receipt (spec §6): the bill as on a pre-bill, then this part. Not an official
--    receipt. Exactly PartReceiptPayload (src/features/pos/print/receipt.ts). Internal. ─
create or replace function pos_part_receipt_payload(p_part_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'kind', 'part',
    'route', s.receipt_route,
    'reprint', false,
    'header', jsonb_build_object(
      'title', coalesce(nullif(trim(br.receipt_title), ''), br.name),
      'legalName', nullif(trim(br.legal_name), ''),
      'registrationNo', nullif(trim(br.registration_no), ''),
      'sstNo', nullif(trim(br.sst_no), ''),
      'address', nullif(trim(br.address), ''),
      'phone', nullif(trim(br.phone), ''),
      'email', nullif(trim(br.email), '')),
    'billNo', b.bill_no,
    'closedAt', to_char(bp.taken_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'cashier', (select st.name from staff st where st.id = bp.taken_by),
    'tableLabel', t.label,
    'pax', b.pax,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'qty', oi.qty, 'name', oi.name_snapshot, 'unitSen', oi.unit_price_sen,
               'amountSen', oi.unit_price_sen * oi.qty,
               'mods', (select coalesce(jsonb_agg(m->>'name' order by ord), '[]'::jsonb)
                          from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)),
               'discounts', (select coalesce(jsonb_agg(d.j order by d.k), '[]'::jsonb) from (
                   select 1 as k, jsonb_build_object(
                            'label', coalesce(oi.catalog_discount_name, 'Catalog') || ' ' || (oi.catalog_discount_bp / 100) || '%',
                            'amountSen', (ln.l->>'catalogDiscountSen')::integer) as j
                    where coalesce((ln.l->>'catalogDiscountSen')::integer, 0) > 0
                   union all
                   select 2, jsonb_build_object(
                            'label', case when oi.discount_kind = 'percent' then 'Discount ' || (oi.discount_value / 100) || '%'
                                          else 'Discount' end,
                            'amountSen', (ln.l->>'itemDiscountSen')::integer)
                    where coalesce((ln.l->>'itemDiscountSen')::integer, 0) > 0) d))
             order by o.placed_at, oi.name_snapshot, oi.id)
        from order_items oi join orders o on o.id = oi.order_id
        left join lateral (select x.l from jsonb_array_elements(coalesce(tot.t->'lines', '[]'::jsonb)) as x(l)
                            where x.l->>'id' = oi.id::text) ln on true
       where oi.bill_id = b.id and oi.voided_at is null), '[]'::jsonb),
    'itemCount', (select coalesce(sum(oi.qty), 0) from order_items oi where oi.bill_id = b.id and oi.voided_at is null),
    'subtotalSen', (tot.t->>'subtotalSen')::integer,
    'billDiscountSen', coalesce((tot.t->>'billDiscountSen')::integer, 0),
    'sstGroups', coalesce(tot.t->'sstGroups', '[]'::jsonb),
    'serviceChargeGroups', coalesce(tot.t->'serviceChargeGroups', '[]'::jsonb),
    'takeawayFeeSen', (tot.t->>'takeawayFeeSen')::integer,
    'roundingSen', (tot.t->>'roundingSen')::integer,
    'totalSen', (tot.t->>'totalSen')::integer,
    'partNo', bp.part_no,
    'ways', bp.ways,
    'amountSen', bp.amount_sen,
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.method_name, 'kind', p.kind, 'amountSen', p.amount_sen,
                                          'tenderedSen', p.tendered_sen, 'reference', p.reference)
                       order by p.line_no, p.id)
        from payments p where p.part_id = bp.id), '[]'::jsonb),
    'changeSen', (select coalesce(sum(p.change_sen), 0) from payments p where p.part_id = bp.id),
    'paidBeforeSen', (select coalesce(sum(x.amount_sen), 0) from bill_parts x where x.bill_id = b.id and x.part_no < bp.part_no),
    'balanceSen', (tot.t->>'totalSen')::integer
                  - (select coalesce(sum(x.amount_sen), 0) from bill_parts x where x.bill_id = b.id and x.part_no <= bp.part_no),
    'footer', 'Part payment — the official receipt prints when the bill is paid in full.')
  from bill_parts bp
  join bills b on b.id = bp.bill_id
  join branches br on br.id = b.branch_id
  left join branch_pos_settings s on s.branch_id = b.branch_id
  left join dining_tables t on t.id = b.table_id
  cross join lateral (select pos_bill_totals(b.id) as t) tot
  where bp.id = p_part_id
$$;
revoke all on function pos_part_receipt_payload(uuid) from public, anon, authenticated;

-- The part receipt on the outlet's receipt route (pos_queue_receipt's way). Internal.
create or replace function pos_queue_part_receipt(p_part_id uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid;
  v_route  text;
begin
  select bp.branch_id, s.receipt_route into v_branch, v_route
    from bill_parts bp left join branch_pos_settings s on s.branch_id = bp.branch_id
   where bp.id = p_part_id;
  if v_route is null then return false; end if;
  insert into print_jobs(branch_id, route, kind, payload)
  values (v_branch, v_route, 'receipt', pos_part_receipt_payload(p_part_id));
  update bill_parts set receipt_queued = true where id = p_part_id;
  return true;
end $$;
revoke all on function pos_queue_part_receipt(uuid) from public, anon, authenticated;

-- ── B1. Pay one part (spec §4.6) ─────────────────────────────────────────────
-- A resend of the same part id (same bill, amount and payments) answers again: the part's own fields
-- (partId, partNo, ways, amountSen, payments, changeSen, receiptQueued) are the first answer;
-- paidSen and balanceSen are the bill's current values, not frozen at the first call.
-- B2: p_paid_sen, the paid parts the screen saw (null: not checked), must still be the bill's (under the
-- lock). A part whose reply was lost and that commits late (Check bill had said "not recorded") then
-- cannot let the same guest's next Pay — a new part id, the old paidSen — through: no paying twice.
-- A 6th argument would be an overload: the 5-argument function is dropped first (same grants after).
drop function if exists pay_bill_part(uuid, uuid, integer, integer, jsonb);                     -- B2
create or replace function pay_bill_part(p_bill_id uuid, p_part_id uuid, p_amount_sen integer, p_ways integer,
                                         p_payments jsonb, p_paid_sen integer default null) returns jsonb  -- B2
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
  v_part   bill_parts;
  v_shift  uuid;
  v_total  integer;
  v_paid   integer;
  v_fixed  integer;
  v_no     integer;
  v_con    text;                                                                                -- B1f
begin
  if p_part_id is null then raise exception 'Part id is missing'; end if;
  -- 1. a resend of a part that went through gets the part's first answer (paidSen / balanceSen current)
  select * into v_part from bill_parts where id = p_part_id;
  if found then return pos_part_replay(v_part, p_bill_id, v_branch, p_amount_sen, p_payments); end if;
  -- 2. the bill locked, the id once more (a resend that waited), the shift, an open bill with items
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  select * into v_part from bill_parts where id = p_part_id;
  if found then return pos_part_replay(v_part, p_bill_id, v_branch, p_amount_sen, p_payments); end if;
  select id into v_shift from pos_shifts where branch_id = v_branch and status = 'open' for share;
  if not found then raise exception 'Open the shift first'; end if;
  if v_bill.status <> 'open' then
    raise exception 'This bill is already %', case v_bill.status when 'paid' then 'paid'
                                                                 when 'voided' then 'voided'
                                                                 else 'merged into another bill' end;
  end if;
  if not exists (select 1 from order_items where bill_id = v_bill.id and voided_at is null) then
    raise exception 'This bill has no items to pay for';
  end if;
  -- 3. a part is less than the balance; the balance itself is paid with checkout_bill
  v_total := (pos_bill_totals(v_bill.id)->>'totalSen')::integer;
  v_paid  := pos_bill_paid_parts(v_bill.id);
  if p_paid_sen is not null and p_paid_sen <> v_paid then                                       -- B2
    raise exception 'The bill changed. Check the split again.';                                 -- B2
  end if;                                                                                       -- B2
  if p_amount_sen is null or p_amount_sen < 1 then raise exception 'Invalid payment amount'; end if;
  if p_amount_sen = v_total - v_paid then raise exception 'Pay the rest with Pay, not as a part'; end if;
  if p_amount_sen > v_total - v_paid then raise exception 'The amount is more than the balance'; end if;
  -- 4. an equal share is the share quoted now (same N; no item added since the quote)
  if p_ways is not null then
    select ways into v_fixed from bill_parts where bill_id = v_bill.id and ways is not null order by part_no desc limit 1;
    if v_fixed is not null and v_fixed <> p_ways then raise exception 'The bill changed. Check the split again.'; end if;
    if p_ways < 2 or p_ways > 20 then raise exception 'Invalid split'; end if;
    if p_amount_sen is distinct from (pos_part_quote(v_bill.id, p_ways)->>'shareSen')::integer then
      raise exception 'The bill changed. Check the split again.';
    end if;
  end if;
  -- 5. the payments, checkout_bill's rules, against the part
  perform pos_check_payments(v_branch, p_payments, p_amount_sen);
  -- 6. the part, its payments (in this shift), a bills event, the part receipt
  select coalesce(max(part_no), 0) + 1 into v_no from bill_parts where bill_id = v_bill.id;
  if v_no > 20 then raise exception 'Too many parts on one bill'; end if;
  begin                                                                                         -- B1f
    insert into bill_parts(id, bill_id, branch_id, part_no, ways, amount_sen, shift_id, taken_by, device_id)
    values (p_part_id, v_bill.id, v_branch, v_no, p_ways, p_amount_sen, v_shift, pos_actor(), pos_current_device());
  exception when unique_violation then                                                          -- B1f
    -- the same id taken at the same moment on another bill (this bill is locked, so not this one)
    get stacked diagnostics v_con = constraint_name;                                            -- B1f
    if v_con = 'bill_parts_pkey' then raise exception 'This part id belongs to another bill'; end if; -- B1f
    raise;                                                                                      -- B1f
  end;                                                                                          -- B1f
  perform pos_insert_payments(v_bill.id, v_branch, v_shift, p_payments, p_part_id);
  -- a pos_insert_payments that does not write part_id (11-16's text before B1f) would leave the part
  -- without its payments: stop instead of recording it
  if (select count(*) from payments where part_id = p_part_id) <> jsonb_array_length(p_payments) then  -- B1f
    raise exception 'STOP: pos_insert_payments is stale — re-run migration-2026-11-17-pos-bill-parts.sql'; -- B1f
  end if;                                                                                       -- B1f
  update bills set updated_at = now() where id = v_bill.id;
  perform pos_queue_part_receipt(p_part_id);
  return pos_part_result(p_part_id);
end $$;
revoke all on function pay_bill_part(uuid, uuid, integer, integer, jsonb, integer) from public, anon;   -- B2
grant execute on function pay_bill_part(uuid, uuid, integer, integer, jsonb, integer) to authenticated;   -- B2

-- ── B2. The guard ───────────────────────────────────────────────────────────
-- A paid part never exceeds the bill: nothing that lowers it, splits it or merges it away while it has parts. Internal.
create or replace function pos_no_parts(p_bill_id uuid) returns void
language plpgsql stable set search_path = public, pg_temp as $$
begin
  if exists (select 1 from bill_parts where bill_id = p_bill_id) then
    raise exception 'This bill has a part payment. Pay the rest first.';
  end if;
end $$;
revoke all on function pos_no_parts(uuid) from public, anon, authenticated;

-- ── B2. checkout_bill: the text of migration-2026-11-16-pos-split-bill.sql (S3) with the lines marked
--    B2 changed — the payments add up to the balance (total − parts). No parts: exactly as before. ─
CREATE OR REPLACE FUNCTION checkout_bill(p_bill_id uuid, p_payments jsonb, p_checkout_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch    uuid := pos_my_branch();
  v_bill      bills;
  v_totals    jsonb;
  v_shift     uuid;                                                -- 4a
begin
  if p_checkout_id is null then raise exception 'Checkout id is missing'; end if;
  -- a resend of a checkout that already went through gets the first answer —
  -- but only for the same bill of the caller's branch
  select * into v_bill from bills where checkout_id = p_checkout_id;
  if found then
    if v_bill.id <> p_bill_id or v_bill.branch_id <> v_branch then
      raise exception 'This checkout id belongs to another bill';
    end if;
    -- H2: the first result is replayed only for the very same payments
    if not pos_checkout_same_payments(v_bill.id, p_payments) then
      raise exception 'This payment was already recorded with other amounts — check Today''s bills';
    end if;
    return pos_checkout_result(v_bill.id);
  end if;

  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.checkout_id is not distinct from p_checkout_id then  -- won by the same checkout while we waited
    if not pos_checkout_same_payments(v_bill.id, p_payments) then                                   -- H2
      raise exception 'This payment was already recorded with other amounts — check Today''s bills';  -- H2
    end if;                                                                                          -- H2
    return pos_checkout_result(v_bill.id);
  end if;
  -- 4a: money moves only inside the branch's open shift. FOR SHARE lets checkouts run
  -- side by side, while close_shift (FOR UPDATE) waits for one in flight and then counts it.
  select id into v_shift from pos_shifts where branch_id = v_branch and status = 'open' for share;
  if not found then raise exception 'Open the shift first'; end if;
  if v_bill.status <> 'open' then
    raise exception 'This bill is already %', case v_bill.status when 'paid' then 'paid'
                                                                 when 'voided' then 'voided'
                                                                 else 'merged into another bill' end;
  end if;
  if not exists (select 1 from order_items where bill_id = v_bill.id and voided_at is null) then
    raise exception 'This bill has no items to pay for';
  end if;

  v_totals := pos_bill_totals(v_bill.id);
  perform pos_check_payments(v_branch, p_payments,
                             (v_totals->>'totalSen')::integer - pos_bill_paid_parts(v_bill.id));    -- B2: the balance
  return pos_pay_and_close(v_bill.id, v_branch, v_shift, p_payments, v_totals, p_checkout_id); -- S3: payments, paid, receipt
end $function$;

-- pos_checkout_same_payments: the live text of migration-2026-10-25-pos-hardening.sql with the lines
-- marked B2 changed — only the final checkout's payments (part_id null) are compared.
create or replace function pos_checkout_same_payments(p_bill_id uuid, p_payments jsonb) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  with given as (
    select case when jsonb_typeof(p_payments) = 'array' then p_payments else null end as arr
  )
  select given.arr is not null
     and jsonb_array_length(given.arr) = (select count(*) from payments p where p.bill_id = p_bill_id and p.part_id is null)   -- B2
     and not exists (
       select 1
         from jsonb_array_elements(coalesce(given.arr, '[]'::jsonb)) with ordinality as x(v, n)
         left join payments p on p.bill_id = p_bill_id and p.part_id is null and p.line_no = x.n                                 -- B2
        where p.id is null
           or lower(x.v->>'methodId') is distinct from p.method_id::text
           or (case when jsonb_typeof(x.v->'amountSen') = 'number' then (x.v->>'amountSen')::numeric end)
                is distinct from p.amount_sen::numeric
           or (case when jsonb_typeof(x.v->'tenderedSen') = 'number' then (x.v->>'tenderedSen')::numeric end)
                is distinct from p.tendered_sen::numeric)
  from given
$$;
revoke all on function pos_checkout_same_payments(uuid, jsonb) from public, anon, authenticated;

-- pos_checkout_result: the live text of migration-2026-10-24-pos-checkout-fn.sql with the line marked
-- B2 changed — the change of the final checkout only (each part's change was given with its part).
create or replace function pos_checkout_result(p_bill_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'billId', b.id, 'billNo', b.bill_no, 'totalSen', b.total_sen,
    'changeSen', (select coalesce(sum(p.change_sen), 0) from payments p where p.bill_id = b.id and p.part_id is null),   -- B2
    'receiptQueued', coalesce(b.receipt_queued, false))
  from bills b where b.id = p_bill_id
$$;
revoke all on function pos_checkout_result(uuid) from public, anon, authenticated;

-- ── B2. Guards: each re-created from its live text with only the line marked B2 added ─────────
-- pos_split_check: migration-2026-11-16-pos-split-bill.sql (SF, with lineQty). Covers pos_split_totals,
-- checkout_items, move_items.
create or replace function pos_split_check(p_bill bills, p_items jsonb) returns integer
language plpgsql stable set search_path = public, pg_temp as $$
declare
  v_e     jsonb;
  v_id    uuid;
  v_qty   integer;
  v_line  order_items;
  v_seen  uuid[] := '{}';
  v_units integer := 0;
  v_live  integer;
begin
  perform pos_no_parts(p_bill.id);                                                                      -- B2
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 or jsonb_array_length(p_items) > 100 then
    raise exception 'Invalid selection';
  end if;
  for v_e in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_e) <> 'object' or jsonb_typeof(v_e->'itemId') is distinct from 'string'
       or (v_e->>'itemId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or jsonb_typeof(v_e->'qty') is distinct from 'number'
       or (v_e->'qty')::numeric <> trunc((v_e->'qty')::numeric)
       or (v_e->'qty')::numeric < 1 or (v_e->'qty')::numeric > 100 then
      raise exception 'Invalid selection';
    end if;
    if v_e ? 'lineQty' and (jsonb_typeof(v_e->'lineQty') is distinct from 'number'                     -- SF
       or (v_e->'lineQty')::numeric <> trunc((v_e->'lineQty')::numeric)                                   -- SF
       or (v_e->'lineQty')::numeric < 1 or (v_e->'lineQty')::numeric > 100) then                          -- SF
      raise exception 'Invalid selection';                                                                -- SF
    end if;                                                                                               -- SF
    v_id  := (v_e->>'itemId')::uuid;
    v_qty := (v_e->'qty')::numeric::integer;
    if v_id = any (v_seen) then raise exception 'Invalid selection'; end if;
    v_seen := v_seen || v_id;
    select * into v_line from order_items where id = v_id;
    if not found or v_line.bill_id <> p_bill.id or v_line.voided_at is not null or v_line.qty < v_qty
       or (v_e ? 'lineQty' and v_line.qty <> (v_e->'lineQty')::numeric) then                             -- SF
      raise exception 'The bill changed. Check the items again.';
    end if;
    v_units := v_units + v_qty;
  end loop;
  select coalesce(sum(qty), 0)::integer into v_live from order_items where bill_id = p_bill.id and voided_at is null;
  if v_units >= v_live then raise exception 'Select fewer items, or pay the whole bill'; end if;
  return v_units;
end $$;
revoke all on function pos_split_check(bills, jsonb) from public, anon, authenticated;

-- void_order_item: migration-2026-10-29-pos-device-till.sql
CREATE OR REPLACE FUNCTION void_order_item(p_item_id uuid, p_reason text, p_approver_id uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_my_branch();
  v_item   order_items;
  v_bill   bills;
  v_reason text;
  v_err    text;
begin
  select * into v_item from order_items where id = p_item_id;
  if not found then raise exception 'Item not found'; end if;
  select * into v_bill from bills where id = v_item.bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Item not found'; end if;
  select * into v_item from order_items where id = p_item_id;            -- again, under the bill lock
  if v_item.bill_id <> v_bill.id then raise exception 'The bill just changed — please try again'; end if;
  if v_item.voided_at is not null then return jsonb_build_object('ok', true); end if;   -- a retry
  perform pos_no_parts(v_bill.id);                                                                       -- B2
  if v_bill.status <> 'open' then
    raise exception 'Only items on an open bill can be voided — refund a paid bill instead';
  end if;
  v_reason := pos_check_reason(v_branch, 'void_item', p_reason);
  v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  update order_items
     set voided_at = now(), voided_by = pos_actor(), voided_device_id = pos_current_device(), void_reason = v_reason, void_approved_by = p_approver_id
   where id = p_item_id;
  update bills set updated_at = now() where id = v_bill.id;   -- H3: a bills event, so other iPads hear of it at once
  perform pos_queue_void_tickets(array[p_item_id]);
  return jsonb_build_object('ok', true);
end $function$;

-- void_bill: migration-2026-10-29-pos-device-till.sql
CREATE OR REPLACE FUNCTION void_bill(p_bill_id uuid, p_reason text, p_approver_id uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
  v_reason text;
  v_err    text;
  v_ids    uuid[];
begin
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  if v_bill.status = 'voided' then return jsonb_build_object('ok', true); end if;      -- a retry
  perform pos_no_parts(v_bill.id);                                                                       -- B2
  if v_bill.status = 'paid' then raise exception 'This bill is paid — refund it instead'; end if;
  if v_bill.status <> 'open' then raise exception 'This bill was merged into another bill'; end if;
  select coalesce(array_agg(id), '{}') into v_ids from order_items where bill_id = v_bill.id and voided_at is null;
  if cardinality(v_ids) > 0 then
    v_reason := pos_check_reason(v_branch, 'void_bill', p_reason);
    v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
    if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
    update order_items
       set voided_at = now(), voided_by = pos_actor(), voided_device_id = pos_current_device(), void_reason = v_reason, void_approved_by = p_approver_id
     where id = any (v_ids);
  else
    v_reason := nullif(trim(left(p_reason, 200)), '');
  end if;
  update bills
     set status = 'voided', closed_at = now(), closed_by = pos_actor(), closed_device_id = pos_current_device(), void_reason = v_reason,
         void_approved_by = case when cardinality(v_ids) > 0 then p_approver_id end
   where id = v_bill.id;
  perform pos_queue_void_tickets(v_ids);
  return jsonb_build_object('ok', true);
end $function$;

-- set_item_discount: migration-2026-10-30-pos-discounts.sql
create or replace function set_item_discount(p_item_id uuid, p_kind text, p_value integer, p_reason text,
                                             p_approver_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_item   order_items;
  v_bill   bills;
  v_reason text;
  v_err    text;
begin
  perform pos_check_discount(p_kind, p_value);
  select * into v_item from order_items where id = p_item_id;
  if not found then raise exception 'Item not found'; end if;
  select * into v_bill from bills where id = v_item.bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Item not found'; end if;
  select * into v_item from order_items where id = p_item_id;            -- again, under the bill lock
  if v_item.bill_id <> v_bill.id then raise exception 'The bill just changed — please try again'; end if;
  perform pos_no_parts(v_bill.id);                                                                       -- B2
  if v_bill.status <> 'open' then raise exception 'Only an open bill can be discounted'; end if;
  if v_item.voided_at is not null then raise exception 'A voided item cannot be discounted'; end if;
  v_reason := pos_check_reason(v_branch, 'discount', p_reason);
  v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  update order_items
     set discount_kind = p_kind, discount_value = p_value, discount_reason = v_reason,
         discount_approved_by = p_approver_id, discount_by = pos_actor(), discount_at = now()
   where id = p_item_id;
  insert into pos_discount_log(branch_id, bill_id, order_item_id, action, kind, value, reason, approved_by, actor)
  values (v_branch, v_bill.id, p_item_id, 'set', p_kind, p_value, v_reason, p_approver_id, pos_actor());
  update bills set updated_at = now() where id = v_bill.id;
  return jsonb_build_object('ok', true);
end $$;
revoke all on function set_item_discount(uuid, text, integer, text, uuid, text) from public, anon;
grant execute on function set_item_discount(uuid, text, integer, text, uuid, text) to authenticated;

-- set_bill_discount: migration-2026-10-30-pos-discounts.sql
create or replace function set_bill_discount(p_bill_id uuid, p_kind text, p_value integer, p_reason text,
                                             p_approver_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
  v_reason text;
  v_err    text;
begin
  perform pos_check_discount(p_kind, p_value);
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  perform pos_no_parts(v_bill.id);                                                                       -- B2
  if v_bill.status <> 'open' then raise exception 'Only an open bill can be discounted'; end if;
  v_reason := pos_check_reason(v_branch, 'discount', p_reason);
  v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  update bills
     set discount_kind = p_kind, discount_value = p_value, discount_reason = v_reason,
         discount_approved_by = p_approver_id, discount_by = pos_actor(), discount_at = now(), updated_at = now()
   where id = p_bill_id;
  insert into pos_discount_log(branch_id, bill_id, action, kind, value, reason, approved_by, actor)
  values (v_branch, p_bill_id, 'set', p_kind, p_value, v_reason, p_approver_id, pos_actor());
  return jsonb_build_object('ok', true);
end $$;
revoke all on function set_bill_discount(uuid, text, integer, text, uuid, text) from public, anon;
grant execute on function set_bill_discount(uuid, text, integer, text, uuid, text) to authenticated;

-- merge_bills: migration-2026-10-30-pos-discounts.sql — the source must have no part (the target may)
CREATE OR REPLACE FUNCTION merge_bills(p_from_bill uuid, p_into_bill uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch uuid := pos_my_branch();
  v_from   bills;
  v_into   bills;
begin
  if p_from_bill is null or p_into_bill is null or p_from_bill = p_into_bill then
    raise exception 'Choose two different bills';
  end if;
  -- lock both in one fixed order, so two iPads merging the same pair cannot deadlock
  perform 1 from bills where id in (p_from_bill, p_into_bill) order by id for update;
  select * into v_from from bills where id = p_from_bill and branch_id = v_branch;
  select * into v_into from bills where id = p_into_bill and branch_id = v_branch;
  if v_from.id is null or v_into.id is null then raise exception 'Bill not found'; end if;
  perform pos_no_parts(v_from.id);                                                                       -- B2
  if v_from.status <> 'open' or v_into.status <> 'open' then raise exception 'Only open bills can be merged'; end if;
  if v_from.discount_kind is not null then raise exception 'Remove the bill discount before merging'; end if;   -- D
  if v_from.order_type = 'dine_in' and v_into.order_type = 'takeaway' then
    raise exception 'Merge the takeaway bill into the table''s bill, not the other way round';
  end if;
  update orders set bill_id = v_into.id where bill_id = v_from.id;
  update order_items set bill_id = v_into.id where bill_id = v_from.id;
  update bills
     set pax = case when v_into.pax is null and v_from.pax is null then null
                    else least(99, coalesce(v_into.pax, 0) + coalesce(v_from.pax, 0)) end
   where id = v_into.id;
  update bills
     set status = 'merged', merged_into = v_into.id, closed_at = now(), closed_by = pos_actor(), closed_device_id = pos_current_device()
   where id = v_from.id;
end $function$;

-- ── B3. Receipt: the text of migration-2026-11-16-pos-split-bill.sql (S5) with the lines marked B3
--    changed — the parts' payments come first, labelled with their part, a part's cash at its amount
--    (its change was given with its part receipt); the change is the final payments'. ─
create or replace function pos_receipt_payload(p_bill_id uuid, p_reprint boolean) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'kind', 'receipt',
    'route', s.receipt_route,
    'reprint', p_reprint,
    'header', jsonb_build_object(
      'title', coalesce(nullif(trim(br.receipt_title), ''), br.name),
      'legalName', nullif(trim(br.legal_name), ''),
      'registrationNo', nullif(trim(br.registration_no), ''),
      'sstNo', nullif(trim(br.sst_no), ''),
      'address', nullif(trim(br.address), ''),
      'phone', nullif(trim(br.phone), ''),
      'email', nullif(trim(br.email), '')),
    'billNo', b.bill_no,
    'splitFrom', (select jsonb_build_object('billNo', sf.bill_no, 'table', t.label)                   -- S5: the part's own table, frozen at the split
                    from bills sf where sf.id = b.split_from),                                        -- S5
    'closedAt', to_char(b.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'cashier', (select st.name from staff st where st.id = b.closed_by),
    'tableLabel', t.label,
    'pax', b.pax,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'qty', oi.qty, 'name', oi.name_snapshot, 'unitSen', oi.unit_price_sen,
               'amountSen', oi.unit_price_sen * oi.qty,
               'mods', (select coalesce(jsonb_agg(m->>'name' order by ord), '[]'::jsonb)
                          from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)),
               'discounts', (select coalesce(jsonb_agg(d.j order by d.k), '[]'::jsonb) from (                  -- D
                   select 1 as k, jsonb_build_object(
                            'label', coalesce(oi.catalog_discount_name, 'Catalog') || ' ' || (oi.catalog_discount_bp / 100) || '%',
                            'amountSen', (ln.l->>'catalogDiscountSen')::integer) as j
                    where coalesce((ln.l->>'catalogDiscountSen')::integer, 0) > 0
                   union all
                   select 2, jsonb_build_object(
                            'label', case when oi.discount_kind = 'percent' then 'Discount ' || (oi.discount_value / 100) || '%'
                                          else 'Discount' end,
                            'amountSen', (ln.l->>'itemDiscountSen')::integer)
                    where coalesce((ln.l->>'itemDiscountSen')::integer, 0) > 0) d))
             order by o.placed_at, oi.name_snapshot, oi.id)
        from order_items oi join orders o on o.id = oi.order_id
        left join lateral (select x.l from jsonb_array_elements(coalesce(b.totals->'lines', '[]'::jsonb)) as x(l)-- D
                            where x.l->>'id' = oi.id::text) ln on true
       where oi.bill_id = b.id and oi.voided_at is null), '[]'::jsonb),
    'itemCount', (select coalesce(sum(oi.qty), 0) from order_items oi where oi.bill_id = b.id and oi.voided_at is null),
    'subtotalSen', b.subtotal_sen,
    'billDiscountSen', coalesce((b.totals->>'billDiscountSen')::integer, 0),                                   -- D
    'sstGroups', coalesce(b.totals->'sstGroups', '[]'::jsonb),
    'serviceChargeGroups', coalesce(b.totals->'serviceChargeGroups', '[]'::jsonb),
    'takeawayFeeSen', b.takeaway_fee_sen,
    'roundingSen', b.rounding_sen,
    'totalSen', b.total_sen,
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.method_name, 'kind', p.kind, 'amountSen', p.amount_sen,
                                          'tenderedSen', case when p.part_id is null then p.tendered_sen end,      -- B3
                                          'reference', p.reference,
                                          'part', bp.part_no)                                                       -- B3
                       order by bp.part_no nulls last, p.line_no, p.id)                                            -- B3
        from payments p left join bill_parts bp on bp.id = p.part_id                                               -- B3
       where p.bill_id = b.id), '[]'::jsonb),
    'changeSen', (select coalesce(sum(p.change_sen), 0) from payments p where p.bill_id = b.id and p.part_id is null),   -- B3
    'footer', coalesce(s.receipt_footer, 'This is an official receipt. Thank you for visiting us.'))
  from bills b
  join branches br on br.id = b.branch_id
  left join branch_pos_settings s on s.branch_id = b.branch_id
  left join dining_tables t on t.id = b.table_id
  where b.id = p_bill_id
$$;
revoke all on function pos_receipt_payload(uuid, boolean) from public, anon, authenticated;

-- pos_checkout_state: the text of migration-2026-11-16-pos-split-bill.sql (SF, the newest part paid
-- under the screen's ids) with the lines marked B3 added — what the parts of an open bill paid, for
-- the Payment screen (paidSen; parts oldest first, with their ids: a part sent with no reply is
-- found by its id). A part id among p_checkout_ids is never a result: only bills.checkout_id is.
create or replace function pos_checkout_state(p_bill_id uuid, p_checkout_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
  v_bill   bills;
begin
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch;
  if not found then raise exception 'Bill not found'; end if;
  return jsonb_build_object(
    'status', v_bill.status,
    'billNo', v_bill.bill_no,
    'mergedIntoBillNo', (select m.bill_no from bills m where m.id = v_bill.merged_into),
    'totals', case when v_bill.status = 'open' then pos_bill_totals(v_bill.id) end,
    'result', case when v_bill.status = 'paid' and v_bill.checkout_id = any(coalesce(p_checkout_ids, '{}'::uuid[]))
                   then pos_checkout_result(v_bill.id)
                   else (select pos_checkout_result(p.id) from bills p                                    -- S3
                          where p.split_from = v_bill.id                                                  -- S3
                            and p.checkout_id = any(coalesce(p_checkout_ids, '{}'::uuid[]))               -- S3
                          order by p.closed_at desc limit 1) end,                                         -- SF  B3: , not );
    'paidSen', case when v_bill.status = 'open' then pos_bill_paid_parts(v_bill.id) else 0 end,           -- B3
    'parts', case when v_bill.status <> 'open' then '[]'::jsonb else coalesce((                            -- B3
      select jsonb_agg(jsonb_build_object(                                                                -- B3
               'id', bp.id, 'partNo', bp.part_no, 'ways', bp.ways, 'amountSen', bp.amount_sen,             -- B3
               'methods', (select coalesce(jsonb_agg(m.n order by m.first), '[]'::jsonb)                  -- B3
                             from (select p.method_name as n, min(p.line_no) as first                     -- B3
                                     from payments p where p.part_id = bp.id group by p.method_name) m))  -- B3
             order by bp.part_no)                                                                          -- B3
        from bill_parts bp where bp.bill_id = v_bill.id), '[]'::jsonb) end);                               -- B3
end $$;
revoke all on function pos_checkout_state(uuid, uuid[]) from public, anon;
grant execute on function pos_checkout_state(uuid, uuid[]) to authenticated;

-- pos_open_bill_summaries: the live text of migration-2026-10-26-pos-frontend.sql with the column
-- marked B3 added (paid_sen: the home tile's "Part paid"). A new result column needs a drop first.
drop function if exists pos_open_bill_summaries(uuid);
create or replace function pos_open_bill_summaries(p_branch_id uuid)
returns table (bill_id uuid, total_sen integer, item_count integer, paid_sen integer)                    -- B3: paid_sen
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if p_branch_id is distinct from pos_my_branch() then
    raise exception 'Not your branch';
  end if;
  return query
    select b.id,
           (pos_bill_totals(b.id)->>'totalSen')::integer,
           coalesce((select sum(oi.qty) from order_items oi
                      where oi.bill_id = b.id and oi.voided_at is null), 0)::integer,                       -- B3: ,
           pos_bill_paid_parts(b.id)                                                                       -- B3
      from bills b
     where b.branch_id = p_branch_id and b.status = 'open'
     order by b.opened_at, b.id;
end $$;
revoke all on function pos_open_bill_summaries(uuid) from public, anon;
grant execute on function pos_open_bill_summaries(uuid) to authenticated;

notify pgrst, 'reload schema';
select 'pos bill parts applied' as result;
