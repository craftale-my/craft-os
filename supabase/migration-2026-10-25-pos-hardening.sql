-- ============================================================================
-- Craft OS — POS pre-pilot hardening (2026-10-25): schema and functions.
-- Run on craft-os-dev after every earlier POS migration (shifts 4a included).
-- Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-25-pos-hardening.md
-- Design: docs/superpowers/specs/2026-10-25-pos-hardening-design.md
-- Lines marked H1–H7 are the changes, numbered as the design's sections.
--
-- New: bills.updated_at (H3); order_items.order_type and the trigger that sets it from
-- the bill (H4); pos_pin_attempts, wrong PINs per approver and caller (H6);
-- pos_checkout_state, what the checkout sheet re-reads (H1); the internal
-- pos_checkout_same_payments (H2).
-- Canonical from here on, each re-created from its live text with only the marked lines
-- changed: pos_compute_bill and pos_bill_totals (from migration-2026-10-24-pos-checkout-fn.sql),
-- checkout_bill and pos_shift_report (from migration-2026-10-24-pos-shifts-fn.sql),
-- void_order_item and set_my_pos_pin (from migration-2026-10-24-pos-bill-actions-fn.sql);
-- pos_pin_attempt (bill-actions-fn) and claim_print_job, finish_print_job, requeue_print_job
-- (migration-2026-10-23-pos-ordering-fn.sql) are rewritten. Re-running shifts-fn,
-- bill-actions-fn or checkout-fixes brings an old body back — re-run this file afterwards
-- (the hardening verify's A section fails until then).
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regclass('public.pos_shifts') is null
     or to_regprocedure('close_shift(uuid,integer,text,uuid,text,integer)') is null
     or to_regprocedure('pos_shift_report(uuid)') is null then
    raise exception 'STOP: run migration-2026-10-24-pos-shifts.sql and migration-2026-10-24-pos-shifts-fn.sql first (the shift functions are missing)';
  end if;
end $$;

-- ── H3. Bills: a touch column, so an item void is a bills event ─────────────
alter table bills add column if not exists updated_at timestamptz not null default now();

-- ── H4. Every item keeps the order type it was ordered under ────────────────
-- Set from the bill on insert (pos_insert_order is not re-created); merge_bills moves
-- items to another bill and leaves it unchanged, so a takeaway merged into a table
-- keeps its packaging fee, the fee's SST and its service-charge rule.
alter table order_items add column if not exists order_type text;

create or replace function order_items_order_type() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  select b.order_type into new.order_type from bills b where b.id = new.bill_id;
  return new;
end $$;
revoke all on function order_items_order_type() from public, anon, authenticated;
drop trigger if exists order_items_order_type on order_items;
create trigger order_items_order_type before insert on order_items
  for each row execute function order_items_order_type();

-- existing rows: their bill's type; an item with a packaging fee was ordered on a takeaway
-- bill (pos_insert_order snapshots the fee on takeaway bills only), even if merged since —
-- so an OPEN bill merged before this migration gains that fee (and its SST) right here
update order_items oi
   set order_type = case when oi.takeaway_fee_sen > 0 then 'takeaway' else b.order_type end
  from bills b
 where b.id = oi.bill_id and oi.order_type is null;
alter table order_items alter column order_type set not null;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'order_items_order_type_check') then
    alter table order_items add constraint order_items_order_type_check check (order_type in ('dine_in', 'takeaway'));
  end if;
end $$;

-- ── H6. Wrong PINs count per approver and caller ────────────────────────────
-- Five wrong tries by one caller lock that caller out of that approver for 10 minutes;
-- the approver and every other caller are unaffected. staff_pos_pins.failed_attempts and
-- locked_until are no longer read or written. RLS on, no policy, no privilege: only
-- pos_pin_attempt (security definer) reads and writes it.
create table if not exists pos_pin_attempts (
  approver_id      uuid not null references staff(id) on delete cascade,
  caller_id        uuid not null references staff(id) on delete cascade,
  failed_attempts  integer not null default 0,
  locked_until     timestamptz,
  updated_at       timestamptz not null default now(),        -- stamped on every try: a day idle forgets the count
  primary key (approver_id, caller_id)
);
alter table pos_pin_attempts enable row level security;
revoke all on pos_pin_attempts from public, anon, authenticated;

-- ── H4. Totals: a line's own order type decides its packaging fee, the fee's SST
--    and its service-charge rule (the bill's when a line has none). Mirrored by
--    computeBill (src/features/pos/checkout/bill.ts); both pass billVectors.json ─
-- input lines may carry orderType ('dine_in' | 'takeaway'); a takeaway line matches no
-- table-limited rule (on its own bill it had no table), so a merged bill totals what the
-- two bills would have totalled apart, before the whole-bill rounding — except up to 1 sen
-- per service-charge or SST rate the two bills share (each rate is rounded on the whole bill).
create or replace function pos_compute_bill(p_input jsonb) returns jsonb
language sql immutable security invoker set search_path = public, pg_temp as $$
  with lines as (
    select (x.l->>'productId') as product_id,
           (x.l->>'unitPriceSen')::bigint * (x.l->>'qty')::bigint as amount,
           (x.l->>'sstRateBp')::integer as sst_bp,
           coalesce((x.l->>'takeawayFeeSen')::bigint, 0) * (x.l->>'qty')::bigint as fee,
           coalesce(x.l->>'orderType', p_input->>'orderType') as order_type          -- H4: the line's own order type
      from jsonb_array_elements(coalesce(p_input->'lines', '[]'::jsonb)) as x(l)
     where not coalesce((x.l->>'voided')::boolean, false)
  ),
  rated as (
    select ln.*,
           (select (rr.rule->>'rateBp')::integer
              from jsonb_array_elements(coalesce(p_input->'rules', '[]'::jsonb)) with ordinality as rr(rule, ord)
             where (rr.rule->'orderTypes') ? ln.order_type                                   -- H4
               and (jsonb_typeof(rr.rule->'tableIds') is distinct from 'array'
                    or (ln.order_type = 'dine_in'                                              -- H4: a takeaway line has no table
                        and p_input->>'tableId' is not null and (rr.rule->'tableIds') ? (p_input->>'tableId')))
               and (jsonb_typeof(rr.rule->'productIds') is distinct from 'array'
                    or (ln.product_id is not null and (rr.rule->'productIds') ? ln.product_id))
             order by rr.ord
             limit 1) as sc_bp
      from lines ln
  ),
  sc as (
    select sc_bp as rate_bp, sum(amount) as base, round(sum(amount) * sc_bp / 10000.0) as amt
      from rated where sc_bp > 0 group by sc_bp
  ),
  taxed as (
    select sst_bp, amount + case when order_type = 'takeaway' then fee else 0 end as base_part   -- H4
      from lines
  ),
  sst as (
    select sst_bp as rate_bp, sum(base_part) as base, round(sum(base_part) * sst_bp / 10000.0) as amt
      from taxed
     where sst_bp > 0 and coalesce((p_input->>'sstRegistered')::boolean, true)
     group by sst_bp
  ),
  t as (
    select coalesce((select sum(amount) from lines), 0) as subtotal,
           coalesce((select sum(amt) from sc), 0) as sc_total,
           coalesce((select sum(amt) from sst), 0) as sst_total,
           coalesce((select sum(fee) from lines where order_type = 'takeaway'), 0) as fee_total             -- H4
  ),
  b as (
    select t.*, t.subtotal + t.sc_total + t.sst_total + t.fee_total as before_rounding from t
  ),
  m as (
    -- remainder normalised to 0..4 so a negative amount rounds like roundingDeltaSen (bill.ts)
    select b.*, ((b.before_rounding % 5) + 5) % 5 as r5 from b
  ),
  fin as (
    select m.*,
           case when coalesce(p_input->>'cashRounding', 'nearest_5_sen') <> 'nearest_5_sen' then 0
                when m.r5 in (1, 2) then -m.r5         -- …1, …2 → down
                when m.r5 in (3, 4) then 5 - m.r5      -- …3, …4 → up
                else 0 end as rounding
      from m
  )
  select jsonb_build_object(
    'subtotalSen', fin.subtotal, 'serviceChargeSen', fin.sc_total, 'sstSen', fin.sst_total,
    'takeawayFeeSen', fin.fee_total, 'beforeRoundingSen', fin.before_rounding, 'roundingSen', fin.rounding,
    'totalSen', fin.before_rounding + fin.rounding,
    'sstGroups', coalesce((select jsonb_agg(jsonb_build_object('rateBp', rate_bp, 'baseSen', base, 'amountSen', amt) order by rate_bp) from sst), '[]'::jsonb),
    'serviceChargeGroups', coalesce((select jsonb_agg(jsonb_build_object('rateBp', rate_bp, 'baseSen', base, 'amountSen', amt) order by rate_bp) from sc), '[]'::jsonb))
  from fin
$$;
revoke all on function pos_compute_bill(jsonb) from public, anon;
grant execute on function pos_compute_bill(jsonb) to authenticated;

create or replace function pos_bill_totals(p_bill_id uuid) returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select pos_compute_bill(jsonb_build_object(
    'orderType', b.order_type,
    'tableId', b.table_id,
    'sstRegistered', coalesce(s.sst_registered, true),
    'cashRounding', coalesce(s.cash_rounding, 'nearest_5_sen'),
    'rules', coalesce((
      select jsonb_agg(jsonb_build_object('rateBp', r.rate_bp, 'orderTypes', to_jsonb(r.order_types),
                                          'tableIds', to_jsonb(r.table_ids), 'productIds', to_jsonb(r.product_ids))
                       order by r.sort_order, r.created_at, r.id)
        from service_charge_rules r where r.branch_id = b.branch_id and r.is_active), '[]'::jsonb),
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object('productId', oi.product_id, 'unitPriceSen', oi.unit_price_sen, 'qty', oi.qty,
                                          'sstRateBp', oi.sst_rate_bp, 'takeawayFeeSen', oi.takeaway_fee_sen,
                                          'voided', oi.voided_at is not null,
                                          'orderType', oi.order_type) order by oi.id)                -- H4
        from order_items oi where oi.bill_id = b.id), '[]'::jsonb)))
  from bills b
  left join branch_pos_settings s on s.branch_id = b.branch_id
  where b.id = p_bill_id
$$;
revoke all on function pos_bill_totals(uuid) from public, anon;
grant execute on function pos_bill_totals(uuid) to authenticated;

-- ── H1. What the checkout sheet re-reads on every bill event and sweep ──────
-- p_checkout_ids: every checkout id the sheet has used — a first attempt that timed out can
-- still commit after Check bill gave the sheet a new id, and it is still the sheet's own payment.
-- { status: 'open'|'paid'|'voided'|'merged', billNo, mergedIntoBillNo: text|null,
--   totals: pos_bill_totals (open bills only, else null),
--   result: the checkout result when one of p_checkout_ids paid this bill (else null) }
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
                   then pos_checkout_result(v_bill.id) end);
end $$;
revoke all on function pos_checkout_state(uuid, uuid[]) from public, anon;
grant execute on function pos_checkout_state(uuid, uuid[]) to authenticated;

-- ── H2. A replayed checkout id must carry the very same payments ────────────
-- Same count, and line by line (line_no order) the same method, amount and cash received.
-- Internal.
create or replace function pos_checkout_same_payments(p_bill_id uuid, p_payments jsonb) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  with given as (
    select case when jsonb_typeof(p_payments) = 'array' then p_payments else null end as arr
  )
  select given.arr is not null
     and jsonb_array_length(given.arr) = (select count(*) from payments p where p.bill_id = p_bill_id)
     and not exists (
       select 1
         from jsonb_array_elements(coalesce(given.arr, '[]'::jsonb)) with ordinality as x(v, n)
         left join payments p on p.bill_id = p_bill_id and p.line_no = x.n
        where p.id is null
           or lower(x.v->>'methodId') is distinct from p.method_id::text
           or (case when jsonb_typeof(x.v->'amountSen') = 'number' then (x.v->>'amountSen')::numeric end)
                is distinct from p.amount_sen::numeric
           or (case when jsonb_typeof(x.v->'tenderedSen') = 'number' then (x.v->>'tenderedSen')::numeric end)
                is distinct from p.tendered_sen::numeric)
  from given
$$;
revoke all on function pos_checkout_same_payments(uuid, jsonb) from public, anon, authenticated;

-- ── Checkout, re-created: the live text of migration-2026-10-24-pos-shifts-fn.sql with
--    only the lines marked H2 added (a replay with other payments is refused) ─
-- p_payments: [{ methodId: uuid, amountSen: int > 0, tenderedSen: int|null (cash only), reference: text|null }]
create or replace function checkout_bill(p_bill_id uuid, p_payments jsonb, p_checkout_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch    uuid := pos_my_branch();
  v_bill      bills;
  v_totals    jsonb;
  v_total     integer;
  v_sum       integer := 0;
  v_p         jsonb;
  v_m         payment_methods;
  v_amount    integer;
  v_tendered  integer;
  v_n         integer := 0;
  v_queued    boolean;
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
  if p_payments is null or jsonb_typeof(p_payments) <> 'array' then raise exception 'Invalid payments'; end if;
  if jsonb_array_length(p_payments) > 10 then raise exception 'Too many payments on one bill'; end if;

  v_totals := pos_bill_totals(v_bill.id);
  v_total  := (v_totals->>'totalSen')::integer;

  -- validate every payment before writing anything
  for v_p in select * from jsonb_array_elements(p_payments) loop
    if jsonb_typeof(v_p) <> 'object' or jsonb_typeof(v_p->'methodId') is distinct from 'string'
       or (v_p->>'methodId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Invalid payment';
    end if;
    if jsonb_typeof(v_p->'amountSen') is distinct from 'number'
       or (v_p->'amountSen')::numeric <> trunc((v_p->'amountSen')::numeric)
       or (v_p->'amountSen')::numeric <= 0 or (v_p->'amountSen')::numeric > 10000000 then
      raise exception 'Invalid payment amount';
    end if;
    select * into v_m from payment_methods
     where id = (v_p->>'methodId')::uuid and branch_id = v_branch and is_active;
    if not found then raise exception 'Payment method is not available at this branch'; end if;
    if jsonb_typeof(v_p->'tenderedSen') = 'number' then
      if (v_p->'tenderedSen')::numeric <> trunc((v_p->'tenderedSen')::numeric)
         or (v_p->'tenderedSen')::numeric > 10000000 then
        raise exception 'Invalid cash received';
      end if;
      if v_m.kind <> 'cash' then raise exception 'Only cash can be tendered above the amount'; end if;
      if (v_p->'tenderedSen')::numeric < (v_p->'amountSen')::numeric then
        raise exception 'Cash received is less than the amount';
      end if;
    elsif v_p->'tenderedSen' is not null and jsonb_typeof(v_p->'tenderedSen') <> 'null' then
      raise exception 'Invalid cash received';
    end if;
    if v_m.needs_reference
       and nullif(trim(case when jsonb_typeof(v_p->'reference') = 'string' then v_p->>'reference' end), '') is null then
      raise exception 'Enter the reference for %', v_m.name;
    end if;
    v_sum := v_sum + (v_p->'amountSen')::numeric::integer;
  end loop;
  if v_sum <> v_total then
    raise exception 'Payments (RM %) do not match the total (RM %)',
      to_char(v_sum / 100.0, 'FM999999990.00'), to_char(v_total / 100.0, 'FM999999990.00');
  end if;

  for v_p in select * from jsonb_array_elements(p_payments) loop
    v_n := v_n + 1;
    select * into v_m from payment_methods where id = (v_p->>'methodId')::uuid;
    v_amount   := (v_p->'amountSen')::numeric::integer;
    v_tendered := case when v_m.kind = 'cash' and jsonb_typeof(v_p->'tenderedSen') = 'number'
                       then (v_p->'tenderedSen')::numeric::integer end;
    insert into payments(bill_id, branch_id, method_id, method_name, kind, amount_sen, tendered_sen,
                         change_sen, reference, taken_by, line_no, shift_id)            -- 4a: shift_id
    values (v_bill.id, v_branch, v_m.id, v_m.name, v_m.kind, v_amount, v_tendered,
            coalesce(v_tendered - v_amount, 0),
            nullif(trim(left(case when jsonb_typeof(v_p->'reference') = 'string' then v_p->>'reference' end, 60)), ''),
            auth.uid(), v_n, v_shift);                                          -- 4a: v_shift
  end loop;

  update bills
     set status = 'paid', closed_at = now(), closed_by = auth.uid(), checkout_id = p_checkout_id,
         shift_id = v_shift,                                                     -- 4a: the bill's shift
         totals = v_totals,
         subtotal_sen       = (v_totals->>'subtotalSen')::integer,
         service_charge_sen = (v_totals->>'serviceChargeSen')::integer,
         sst_sen            = (v_totals->>'sstSen')::integer,
         takeaway_fee_sen   = (v_totals->>'takeawayFeeSen')::integer,
         rounding_sen       = (v_totals->>'roundingSen')::integer,
         total_sen          = v_total
   where id = v_bill.id;
  v_queued := pos_queue_receipt(v_bill.id, false);
  update bills set receipt_queued = v_queued where id = v_bill.id;
  return pos_checkout_result(v_bill.id);
end $$;
revoke all on function checkout_bill(uuid, jsonb, uuid) from public, anon;
grant execute on function checkout_bill(uuid, jsonb, uuid) to authenticated;

-- ── Void one item, re-created: the live text of migration-2026-10-24-pos-bill-actions-fn.sql
--    with only the H3 line added ─
create or replace function void_order_item(p_item_id uuid, p_reason text, p_approver_id uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
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
  if v_bill.status <> 'open' then
    raise exception 'Only items on an open bill can be voided — refund a paid bill instead';
  end if;
  v_reason := pos_check_reason(v_branch, 'void_item', p_reason);
  v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  update order_items
     set voided_at = now(), voided_by = auth.uid(), void_reason = v_reason, void_approved_by = p_approver_id
   where id = p_item_id;
  update bills set updated_at = now() where id = v_bill.id;   -- H3: a bills event, so other iPads hear of it at once
  perform pos_queue_void_tickets(array[p_item_id]);
  return jsonb_build_object('ok', true);
end $$;
revoke all on function void_order_item(uuid, text, uuid, text) from public, anon;
grant execute on function void_order_item(uuid, text, uuid, text) to authenticated;

-- ── The Z report, re-created: the live text of migration-2026-10-24-pos-shifts-fn.sql with
--    only the H5 lines changed. Voids are listed from the close of the branch's previous
--    shift (made while no shift was open too) to this shift's close; that close itself
--    belongs to the previous shift. With no previous shift: from this shift's open.
--    Exactly ZReport in src/features/pos/print/zreport.ts. Internal. ─
create or replace function pos_shift_report(p_shift_id uuid) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  with s as (
    select sh.*, coalesce(sh.closed_at, now()) as until,
           -- H5: the close of the branch's shift before this one (null when there is none)
           (select max(p.closed_at) from pos_shifts p
             where p.branch_id = sh.branch_id and p.status = 'closed' and p.opened_at < sh.opened_at) as prev_close
      from pos_shifts sh where sh.id = p_shift_id
  ),
  sb as (                                                                -- the shift's bills
    select b.* from bills b where b.shift_id = p_shift_id
  ),
  t as (
    select count(*)::integer as bill_count, coalesce(sum(sb.pax), 0)::integer as pax,
           coalesce(sum(sb.subtotal_sen), 0)::integer as gross, coalesce(sum(sb.takeaway_fee_sen), 0)::integer as fee,
           coalesce(sum(sb.service_charge_sen), 0)::integer as sc, coalesce(sum(sb.sst_sen), 0)::integer as sst,
           coalesce(sum(sb.rounding_sen), 0)::integer as rounding, coalesce(sum(sb.total_sen), 0)::integer as nett
      from sb
  ),
  vi as (                                                                -- items voided since the last close
    select oi.*, b.bill_no from order_items oi join bills b on b.id = oi.bill_id, s
     where b.branch_id = s.branch_id and oi.voided_at <= s.until
       and (oi.voided_at > s.prev_close or (s.prev_close is null and oi.voided_at >= s.opened_at))   -- H5
  ),
  vb as (                                                                -- bills voided since the last close
    select b.* from bills b, s
     where b.branch_id = s.branch_id and b.status = 'voided' and b.closed_at <= s.until
       and (b.closed_at > s.prev_close or (s.prev_close is null and b.closed_at >= s.opened_at))     -- H5
  ),
  rf as (select r.* from refunds r where r.shift_id = p_shift_id),
  mv as (select m.* from pos_cash_moves m where m.shift_id = p_shift_id),
  pm as (
    select p.method_id, min(p.method_name) as name, min(p.kind) as kind, count(*)::integer as n, sum(p.amount_sen)::integer as amt
      from payments p where p.shift_id = p_shift_id group by p.method_id
  ),
  rm as (
    select r.method_id, min(r.method_name) as name, min(coalesce(r.kind, 'other')) as kind, count(*)::integer as n,
           sum(r.amount_sen)::integer as amt
      from rf r group by r.method_id
  )
  select jsonb_build_object(
    'branch', (select coalesce(nullif(trim(br.receipt_title), ''), br.name) from branches br where br.id = s.branch_id),
    'openedAt', to_char(s.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'openedBy', (select st.name from staff st where st.id = s.opened_by),
    'closedAt', to_char(s.until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'closedBy', (select st.name from staff st where st.id = s.closed_by),
    'summary', jsonb_build_object(
      'billCount', t.bill_count, 'pax', t.pax, 'nettSen', t.nett,
      'avgPerBillSen', case when t.bill_count > 0 then round(t.nett::numeric / t.bill_count)::integer else 0 end,
      'avgPerPaxSen', case when t.pax > 0 then round(t.nett::numeric / t.pax)::integer else 0 end,
      'voidBillCount', (select count(*)::integer from vb),
      'voidSen', (select coalesce(sum(vi.unit_price_sen * vi.qty), 0)::integer from vi),
      'refundSen', (select coalesce(sum(rf.amount_sen), 0)::integer from rf)),
    'sales', jsonb_build_object(
      'grossSen', t.gross, 'takeawayFeeSen', t.fee, 'serviceChargeSen', t.sc, 'sstSen', t.sst,
      'roundingSen', t.rounding, 'nettSen', t.nett),
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', coalesce(pm.name, rm.name), 'kind', coalesce(pm.kind, rm.kind),
               'count', coalesce(pm.n, 0), 'amountSen', coalesce(pm.amt, 0),
               'refundCount', coalesce(rm.n, 0), 'refundSen', coalesce(rm.amt, 0),
               'netSen', coalesce(pm.amt, 0) - coalesce(rm.amt, 0))
             order by coalesce(pm.name, rm.name))
        from pm full join rm on rm.method_id = pm.method_id), '[]'::jsonb),
    'orderTypes', (
      select jsonb_agg(jsonb_build_object(
               'orderType', x.ot,
               'bills', (select count(*)::integer from sb where sb.order_type = x.ot),
               'nettSen', (select coalesce(sum(sb.total_sen), 0)::integer from sb where sb.order_type = x.ot))
             order by x.ord)
        from (values ('dine_in', 1), ('takeaway', 2)) as x(ot, ord)),
    'sources', (
      select jsonb_agg(jsonb_build_object(
               'source', x.src,
               'orders', (select count(*)::integer from orders o where o.bill_id in (select sb.id from sb) and o.source = x.src),
               'itemSen', (select coalesce(sum(oi.unit_price_sen * oi.qty), 0)::integer
                             from order_items oi join orders o on o.id = oi.order_id
                            where o.bill_id in (select sb.id from sb) and o.source = x.src and oi.voided_at is null))
             order by x.ord)
        from (values ('counter', 1), ('qr', 2)) as x(src, ord)),
    'cash', jsonb_build_object(
      'openingFloatSen', s.opening_float_sen,
      'cashSalesSen', coalesce((select sum(p.amount_sen) from payments p where p.shift_id = s.id and p.kind = 'cash'), 0)::integer,
      'cashRefundSen', coalesce((select sum(rf.amount_sen) from rf where rf.kind = 'cash'), 0)::integer,
      'moves', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'kind', mv.kind, 'amountSen', mv.amount_sen, 'reason', mv.reason,
                 'by', (select st.name from staff st where st.id = mv.created_by),
                 'approvedBy', (select st.name from staff st where st.id = mv.approved_by),
                 'at', to_char(mv.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
               order by mv.created_at, mv.id)
          from mv), '[]'::jsonb),
      'payInSen', coalesce((select sum(mv.amount_sen) from mv where mv.kind = 'pay_in'), 0)::integer,
      'payOutSen', coalesce((select sum(mv.amount_sen) from mv where mv.kind = 'pay_out'), 0)::integer,
      'expectedSen', coalesce(s.expected_cash_sen, pos_shift_expected_cash(s.id)),
      'firstCountSen', s.first_count_sen,
      'firstVarianceSen', s.first_variance_sen,
      'countedSen', s.counted_cash_sen,
      'varianceSen', s.variance_sen,
      'varianceReason', s.variance_reason,
      'varianceApprovedBy', (select st.name from staff st where st.id = s.variance_approved_by)),
    'voids', jsonb_build_object(
      'items', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'at', to_char(vi.voided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                 'billNo', vi.bill_no, 'name', vi.name_snapshot, 'qty', vi.qty,
                 'valueSen', vi.unit_price_sen * vi.qty, 'reason', vi.void_reason,
                 'by', (select st.name from staff st where st.id = vi.voided_by),
                 'approvedBy', (select st.name from staff st where st.id = vi.void_approved_by))
               order by vi.voided_at, vi.id)
          from vi), '[]'::jsonb),
      'bills', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'at', to_char(vb.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
                 'billNo', vb.bill_no, 'reason', vb.void_reason,
                 'by', (select st.name from staff st where st.id = vb.closed_by),
                 'approvedBy', (select st.name from staff st where st.id = vb.void_approved_by))
               order by vb.closed_at, vb.id)
          from vb), '[]'::jsonb)),
    'refunds', coalesce((
      select jsonb_agg(jsonb_build_object(
               'at', to_char(rf.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'billNo', (select b.bill_no from bills b where b.id = rf.bill_id),
               'amountSen', rf.amount_sen, 'method', rf.method_name, 'reason', rf.reason,
               'approvedBy', (select st.name from staff st where st.id = rf.approved_by))
             order by rf.created_at, rf.id)
        from rf), '[]'::jsonb),
    'products', coalesce((
      select jsonb_agg(jsonb_build_object('name', x.name, 'qty', x.qty, 'valueSen', x.value)
                       order by x.qty desc, x.value desc, x.name)
        from (select oi.name_snapshot as name, sum(oi.qty)::integer as qty, sum(oi.unit_price_sen * oi.qty)::integer as value
                from order_items oi
               where oi.bill_id in (select sb.id from sb) and oi.voided_at is null
               group by oi.name_snapshot) x), '[]'::jsonb))
  from s, t
$$;
revoke all on function pos_shift_report(uuid) from public, anon, authenticated;

-- ── H6. One PIN attempt by the signed-in caller: null = right; otherwise the words to show.
--    The count is per (approver, caller); a day without a try forgets it ─
create or replace function pos_pin_attempt(p_staff_id uuid, p_pin text) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_caller uuid := auth.uid();
  v_hash   text;
  v_try    pos_pin_attempts;
  v_n      integer;
begin
  if v_caller is null then raise exception 'Sign in required'; end if;
  select pin_hash into v_hash from staff_pos_pins where staff_id = p_staff_id;
  if not found then
    return 'No POS PIN is set for this person yet — they set one under My PIN';
  end if;
  insert into pos_pin_attempts(approver_id, caller_id) values (p_staff_id, v_caller)
  on conflict (approver_id, caller_id) do nothing;
  select * into v_try from pos_pin_attempts where approver_id = p_staff_id and caller_id = v_caller for update;
  if v_try.locked_until is not null and v_try.locked_until > now() then
    return 'Too many wrong PINs — try again after ' || to_char(v_try.locked_until at time zone 'Asia/Kuala_Lumpur', 'HH24:MI');
  end if;
  if p_pin is not null and p_pin ~ '^\d{4,6}$' and v_hash = extensions.crypt(p_pin, v_hash) then
    update pos_pin_attempts set failed_attempts = 0, locked_until = null, updated_at = now()
     where approver_id = p_staff_id and caller_id = v_caller;
    return null;
  end if;
  v_n := case when v_try.updated_at < now() - interval '1 day' then 0 else v_try.failed_attempts end + 1;
  if v_n >= 5 then
    update pos_pin_attempts set failed_attempts = 0, locked_until = now() + interval '10 minutes', updated_at = now()
     where approver_id = p_staff_id and caller_id = v_caller;
    return 'Wrong PIN — locked for 10 minutes after 5 wrong tries';
  end if;
  update pos_pin_attempts set failed_attempts = v_n, locked_until = null, updated_at = now()
   where approver_id = p_staff_id and caller_id = v_caller;
  return format('Wrong PIN — %s %s left', 5 - v_n, case when 5 - v_n = 1 then 'try' else 'tries' end);
end $$;
revoke all on function pos_pin_attempt(uuid, text) from public, anon, authenticated;

-- ── My PIN, re-created: the live text of migration-2026-10-24-pos-bill-actions-fn.sql with
--    only the H6 lines changed (the caller is the approver: the same pos_pin_attempts row;
--    a new PIN clears every caller's wrong tries and lock against this approver) ─
create or replace function set_my_pos_pin(p_new_pin text, p_current_pin text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_err text;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  if not exists (select 1 from staff where id = auth.uid() and is_active and status = 'active') then
    raise exception 'Your account is not active';
  end if;
  if p_new_pin is null or p_new_pin !~ '^\d{4,6}$' then raise exception 'The PIN must be 4 to 6 digits'; end if;
  if exists (select 1 from staff_pos_pins where staff_id = auth.uid()) then
    v_err := pos_pin_attempt(auth.uid(), p_current_pin);
    if v_err is not null then return jsonb_build_object('ok', false, 'error', 'Current PIN: ' || v_err); end if;
  end if;
  insert into staff_pos_pins(staff_id, pin_hash)
  values (auth.uid(), extensions.crypt(p_new_pin, extensions.gen_salt('bf')))
  on conflict (staff_id) do update
     set pin_hash = excluded.pin_hash, updated_at = now();          -- H6: wrong tries live in pos_pin_attempts
  -- H6: a new PIN starts every (approver, caller) pair afresh, as the old reset of
  -- wrong-try counter and lock did (a cashier locked out of the old PIN is free again)
  delete from pos_pin_attempts where approver_id = auth.uid();
  return jsonb_build_object('ok', true);
end $$;
revoke all on function set_my_pos_pin(text, text) from public, anon;
grant execute on function set_my_pos_pin(text, text) to authenticated;

-- ── H7. Print jobs: security definer, and only jobs of the caller's branch ──
-- Another branch's job id is a no-op (false / nothing), like a job another host already
-- claimed. The print agent's login must be staff of the branch it prints for.
create or replace function claim_print_job(p_id uuid) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
begin
  update print_jobs set status = 'printing', attempts = attempts + 1, claimed_at = now()
   where id = p_id and status = 'pending' and branch_id = v_branch;
  return found;
end $$;

create or replace function finish_print_job(p_id uuid, p_ok boolean, p_error text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
begin
  update print_jobs
     set status     = case when p_ok then 'printed' else 'failed' end,
         printed_at = case when p_ok then now() else null end,
         last_error = case when p_ok then null else p_error end
   where id = p_id and status = 'printing' and branch_id = v_branch;
end $$;

-- failed jobs, and jobs a host claimed but never finished (crashed mid-print)
create or replace function requeue_print_job(p_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := pos_my_branch();
begin
  update print_jobs set status = 'pending'
   where id = p_id and branch_id = v_branch
     and (status = 'failed' or (status = 'printing' and claimed_at < now() - interval '2 minutes'));
end $$;
revoke all on function claim_print_job(uuid), finish_print_job(uuid, boolean, text), requeue_print_job(uuid) from public, anon;
grant execute on function claim_print_job(uuid), finish_print_job(uuid, boolean, text), requeue_print_job(uuid) to authenticated;

-- PostgREST picks up the new functions now, not at its next poll
notify pgrst, 'reload schema';

select 'pos hardening applied' as result;
