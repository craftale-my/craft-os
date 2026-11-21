-- ============================================================================
-- Craft OS — POS receipt template, call numbers and cash drawer, W4 (2026-11-22). Run on craft-os-dev
-- after migration-2026-11-18-pos-reports.sql. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-11-22-pos-receipt-numbers.md
-- Design: docs/superpowers/specs/2026-11-22-pos-receipt-numbers-design.md
--
-- C1  Call numbers: pos_call_counters and pos_next_call_no (TA001–TA999 per outlet, channel and business
--     day, then TA001 again). bills.call_no is set by the trigger bills_call_no on every new bill — a part
--     split off by item takes its source's, a takeaway bill a new number, a dine-in bill none — so every
--     path that makes a bill (pos_insert_order, open_table, checkout_items, move_items) follows without
--     being re-created. A kitchen / bar ticket carries its bill's number (trigger print_jobs_call_no).
--     print_jobs.seq: the order jobs were queued in (one transaction shares created_at).
-- C2  Receipt template: branch_pos_settings.receipt_logo / receipt_footer_qr / receipt_font_size /
--     receipt_hide_free_mods, saved by save_receipt_settings (the logo checked: a 1-bit raster at most
--     384 × 240 dots); pos_receipt_payload and pos_part_receipt_payload carry callNo, fontSize, header.logo
--     and footerQr and leave free add-ons off when the switch is on.
-- C3  Drawer kicks: payment_methods.opens_drawer; a drawer job ({ kind: 'drawer', route, reason } on the
--     receipt route) queued before the receipt of a payment, a part and a refund with such a method, and on
--     every pay in / pay out (pos_pay_and_close, pay_bill_part, refund_bill, record_cash_move).
-- C4  Open drawer: reason action open_drawer, pos_drawer_opens, pos_open_drawer (needs an open shift).
-- C5  The Z report's cash.noSaleOpens (pos_shift_report) and Reports → Cash drawer's noSaleOpens
--     (pos_report_drawer).
-- Re-run hazards: re-running migration-2026-10-29-pos-outlets.sql puts back save_receipt_settings without
-- the C2 keys; migration-2026-10-29-pos-device-till.sql refund_bill and record_cash_move without the kick;
-- migration-2026-11-16-pos-split-bill.sql pos_pay_and_close without the kick; migration-2026-11-17-pos-bill-parts.sql
-- pay_bill_part, both receipt payloads and pos_shift_report; migration-2026-11-18-pos-reports.sql
-- pos_report_drawer — re-run this file after any of them.
-- Every DELETE / UPDATE has a WHERE: Supabase's API role runs pg-safeupdate
-- (src/features/pos/sqlSafeUpdate.test.ts scans this file).
-- ============================================================================

do $$ begin
  if to_regprocedure('pos_report_drawer(uuid[],date,date)') is null or to_regprocedure('pos_business_day(timestamptz)') is null
     or to_regprocedure('pay_bill_part(uuid,uuid,integer,integer,jsonb,integer)') is null then
    raise exception 'STOP: run migration-2026-11-18-pos-reports.sql first (pos_report_drawer, pos_business_day or pay_bill_part is missing)';
  end if;
end $$;

-- ── C1. Call numbers (spec §2) ──────────────────────────────────────────────
-- One counter per outlet, channel and business day; next_no is the number the next bill gets.
create table if not exists pos_call_counters (
  branch_id     uuid not null references branches(id),
  channel       text not null,
  business_day  date not null,
  next_no       integer not null default 1 check (next_no between 1 and 999),
  primary key (branch_id, channel, business_day)
);
alter table pos_call_counters enable row level security;
revoke all on pos_call_counters from public, anon, authenticated;

alter table bills add column if not exists call_no text;                                         -- C1

-- The next call number of an outlet's channel on the business day of p_at: TA001 … TA999, then TA001.
-- Atomic: the upsert takes the row lock, so two bills at once get two numbers. Internal.
create or replace function pos_next_call_no(p_branch_id uuid, p_channel text, p_at timestamptz default now())
returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_prefix text := case p_channel when 'takeaway' then 'TA' end;
  v_next   integer;
begin
  if v_prefix is null then raise exception 'Unknown call number channel %', p_channel; end if;
  insert into pos_call_counters(branch_id, channel, business_day, next_no)
  values (p_branch_id, p_channel, pos_business_day(p_at), 2)
  on conflict (branch_id, channel, business_day) do update set next_no = pos_call_counters.next_no % 999 + 1
  returning next_no into v_next;
  -- v_next is the number after the one given: 2 → 1, 1 (after 999) → 999
  return v_prefix || lpad(((v_next + 997) % 999 + 1)::text, 3, '0');
end $$;
revoke all on function pos_next_call_no(uuid, text, timestamptz) from public, anon, authenticated;

-- Every new bill: a part split off by item keeps its source's number, a takeaway bill gets the next one,
-- a dine-in bill none (the table is its number). A number given by the caller is kept. Internal.
create or replace function bills_call_no() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.call_no is not null then return new; end if;
  if new.split_from is not null then
    new.call_no := (select b.call_no from bills b where b.id = new.split_from);
  elsif new.order_type = 'takeaway' then
    new.call_no := pos_next_call_no(new.branch_id, 'takeaway', new.opened_at);
  end if;
  return new;
end $$;
revoke all on function bills_call_no() from public, anon, authenticated;
drop trigger if exists bills_call_no on bills;
create trigger bills_call_no before insert on bills for each row execute function bills_call_no();

-- The order print jobs were queued in: a drawer job and its receipt share created_at (one transaction);
-- the hosts read pending jobs by created_at, then seq.
alter table print_jobs add column if not exists seq bigint generated by default as identity;

-- A kitchen / bar ticket (new order or void) carries its bill's call number. Internal.
create or replace function print_jobs_call_no() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_call text;
begin
  if new.order_id is null or new.payload->>'kind' is distinct from 'ticket' or new.payload ? 'callNo' then
    return new;
  end if;
  select b.call_no into v_call from orders o join bills b on b.id = o.bill_id where o.id = new.order_id;
  if v_call is not null then
    new.payload := new.payload || jsonb_build_object('callNo', v_call);
  end if;
  return new;
end $$;
revoke all on function print_jobs_call_no() from public, anon, authenticated;
drop trigger if exists print_jobs_call_no on print_jobs;
create trigger print_jobs_call_no before insert on print_jobs for each row execute function print_jobs_call_no();

-- ── C2. Receipt template (spec §3) ──────────────────────────────────────────
alter table branch_pos_settings add column if not exists receipt_logo jsonb;                     -- { width, height, data }
alter table branch_pos_settings add column if not exists receipt_footer_qr text;
alter table branch_pos_settings add column if not exists receipt_font_size text not null default 'normal';
alter table branch_pos_settings add column if not exists receipt_hide_free_mods boolean not null default false;
alter table branch_pos_settings drop constraint if exists branch_pos_settings_receipt_font_size_check;
alter table branch_pos_settings add constraint branch_pos_settings_receipt_font_size_check
  check (receipt_font_size in ('small', 'normal', 'large'));
alter table branch_pos_settings drop constraint if exists branch_pos_settings_receipt_footer_qr_check;
alter table branch_pos_settings add constraint branch_pos_settings_receipt_footer_qr_check
  check (receipt_footer_qr is null or length(receipt_footer_qr) <= 300);

-- save_receipt_settings: the live text of migration-2026-10-29-pos-outlets.sql (O7) with the lines marked
-- C2 added — the logo ({ width, height, data }: width a multiple of 8 up to 384, height up to 240, data
-- the base64 of width / 8 × height bytes; null removes it), the footer QR (up to 300 characters), the
-- font size and the free add-ons switch. A key that is absent leaves its column as it is.
create or replace function save_receipt_settings(p_branch_id uuid, p jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch uuid := p_branch_id;                                                              -- O7
  v_route  text;
  v_round  text;
  v_footer constant text := 'This is an official receipt. Thank you for visiting us.';
  v_logo   jsonb;                                                                            -- C2
  v_w      numeric;                                                                          -- C2
  v_h      numeric;                                                                          -- C2
  v_bytes  bytea;                                                                            -- C2
  v_qr     text;                                                                             -- C2
begin
  if not has_menu_cap('access_settings') then
    raise exception 'Only a manager can change the receipt settings';
  end if;
  if not pos_manages_outlet(v_branch) then raise exception 'This outlet is not one of yours'; end if;   -- O7
  if jsonb_typeof(p) is distinct from 'object' then raise exception 'Invalid settings'; end if;
  if nullif(trim(p->>'receiptTitle'), '') is null then raise exception 'Enter the receipt title'; end if;
  v_route := nullif(trim(p->>'receiptRoute'), '');
  v_round := coalesce(p->>'cashRounding', 'nearest_5_sen');
  if v_round not in ('none', 'nearest_5_sen') then raise exception 'Invalid rounding setting'; end if;
  if v_route is not null and not exists (select 1 from print_routes where branch_id = v_branch and name = v_route) then
    raise exception 'No printer is set for route %', v_route;
  end if;
  if p ? 'receiptLogo' and jsonb_typeof(p->'receiptLogo') is distinct from 'null' then                  -- C2
    v_logo := p->'receiptLogo';                                                                         -- C2
    if jsonb_typeof(v_logo) is distinct from 'object' or jsonb_typeof(v_logo->'width') is distinct from 'number'   -- C2
       or jsonb_typeof(v_logo->'height') is distinct from 'number'                                       -- C2
       or jsonb_typeof(v_logo->'data') is distinct from 'string' then                                    -- C2
      raise exception 'The logo could not be read. Upload it again.';                                    -- C2
    end if;                                                                                              -- C2
    v_w := (v_logo->>'width')::numeric;                                                                  -- C2
    v_h := (v_logo->>'height')::numeric;                                                                 -- C2
    if v_w > 384 or v_h > 240 then raise exception 'The logo must be at most 384 × 240 dots.'; end if;   -- C2
    if v_w < 8 or v_h < 1 or v_w <> trunc(v_w) or v_h <> trunc(v_h) or mod(v_w, 8) <> 0 then           -- C2
      raise exception 'The logo could not be read. Upload it again.';                                    -- C2
    end if;                                                                                              -- C2
    begin                                                                                                -- C2
      v_bytes := decode(v_logo->>'data', 'base64');                                                      -- C2
    exception when others then                                                                           -- C2
      v_bytes := null;                                                                                   -- C2
    end;                                                                                                 -- C2
    if v_bytes is null or length(v_bytes) <> (v_w / 8 * v_h)::integer then                              -- C2
      raise exception 'The logo could not be read. Upload it again.';                                    -- C2
    end if;                                                                                              -- C2
    v_logo := jsonb_build_object('width', v_w::integer, 'height', v_h::integer, 'data', v_logo->>'data'); -- C2
  end if;                                                                                                -- C2
  if p ? 'fontSize' and coalesce(p->>'fontSize', '') not in ('small', 'normal', 'large') then           -- C2
    raise exception 'Choose a font size: small, normal or large.';                                       -- C2
  end if;                                                                                                -- C2
  v_qr := nullif(trim(p->>'footerQr'), '');                                                              -- C2
  if length(v_qr) > 300 then raise exception 'The QR text is too long (300 characters at most).'; end if; -- C2
  -- a key that is absent leaves its column as it is (branches.address is shown all over Craft OS)
  update branches
     set receipt_title   = trim(p->>'receiptTitle'),
         legal_name      = case when p ? 'legalName'      then nullif(trim(p->>'legalName'), '')      else legal_name end,
         registration_no = case when p ? 'registrationNo' then nullif(trim(p->>'registrationNo'), '') else registration_no end,
         sst_no          = case when p ? 'sstNo'          then nullif(trim(p->>'sstNo'), '')          else sst_no end,
         address         = case when p ? 'address'        then nullif(trim(p->>'address'), '')        else address end,
         phone           = case when p ? 'phone'          then nullif(trim(p->>'phone'), '')          else phone end,
         email           = case when p ? 'email'          then nullif(trim(p->>'email'), '')          else email end
   where id = v_branch;
  insert into branch_pos_settings(branch_id) values (v_branch) on conflict (branch_id) do nothing;
  update branch_pos_settings
     set sst_registered        = case when p ? 'sstRegistered' then coalesce((p->>'sstRegistered')::boolean, sst_registered) else sst_registered end,
         cash_rounding         = case when p ? 'cashRounding' then v_round else cash_rounding end,
         receipt_route         = case when p ? 'receiptRoute' then v_route else receipt_route end,
         receipt_footer        = case when p ? 'footer' then coalesce(nullif(trim(left(p->>'footer', 300)), ''), v_footer) else receipt_footer end,
         qr_requires_open_bill = case when p ? 'qrRequiresOpenBill' then coalesce((p->>'qrRequiresOpenBill')::boolean, qr_requires_open_bill) else qr_requires_open_bill end,
         receipt_logo          = case when p ? 'receiptLogo' then v_logo else receipt_logo end,                                 -- C2
         receipt_footer_qr     = case when p ? 'footerQr' then v_qr else receipt_footer_qr end,                                 -- C2
         receipt_font_size     = case when p ? 'fontSize' then p->>'fontSize' else receipt_font_size end,                       -- C2
         receipt_hide_free_mods = case when p ? 'hideFreeMods'                                                                  -- C2
                                       then coalesce((p->>'hideFreeMods')::boolean, receipt_hide_free_mods)                     -- C2
                                       else receipt_hide_free_mods end,                                                         -- C2
         updated_at            = now()
   where branch_id = v_branch;
end $$;
revoke all on function save_receipt_settings(uuid, jsonb) from public, anon;
grant execute on function save_receipt_settings(uuid, jsonb) to authenticated;

-- ── C2. Receipt: the text of migration-2026-11-17-pos-bill-parts.sql (B3) with the lines marked C2
--    changed — header.logo, callNo, fontSize and footerQr; with receipt_hide_free_mods on, an add-on whose
--    priceDeltaSen is the number 0 is left off its item's mods. Exactly ReceiptPayload
--    (src/features/pos/print/receipt.ts). Internal. ─
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
      'email', nullif(trim(br.email), ''),
      'logo', s.receipt_logo),                                                                          -- C2
    'callNo', b.call_no,                                                                                -- C2
    'fontSize', coalesce(s.receipt_font_size, 'normal'),                                               -- C2
    'footerQr', nullif(trim(s.receipt_footer_qr), ''),                                                 -- C2
    'billNo', b.bill_no,
    'splitFrom', (select jsonb_build_object('billNo', sf.bill_no, 'table', t.label)
                    from bills sf where sf.id = b.split_from),
    'closedAt', to_char(b.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'cashier', (select st.name from staff st where st.id = b.closed_by),
    'tableLabel', t.label,
    'pax', b.pax,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'qty', oi.qty, 'name', oi.name_snapshot, 'unitSen', oi.unit_price_sen,
               'amountSen', oi.unit_price_sen * oi.qty,
               'mods', (select coalesce(jsonb_agg(m->>'name' order by ord), '[]'::jsonb)
                          from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)
                         where not coalesce(s.receipt_hide_free_mods, false)                           -- C2
                            or jsonb_typeof(m->'priceDeltaSen') is distinct from 'number'              -- C2
                            or (m->>'priceDeltaSen')::numeric <> 0),                                   -- C2
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
        left join lateral (select x.l from jsonb_array_elements(coalesce(b.totals->'lines', '[]'::jsonb)) as x(l)
                            where x.l->>'id' = oi.id::text) ln on true
       where oi.bill_id = b.id and oi.voided_at is null), '[]'::jsonb),
    'itemCount', (select coalesce(sum(oi.qty), 0) from order_items oi where oi.bill_id = b.id and oi.voided_at is null),
    'subtotalSen', b.subtotal_sen,
    'billDiscountSen', coalesce((b.totals->>'billDiscountSen')::integer, 0),
    'sstGroups', coalesce(b.totals->'sstGroups', '[]'::jsonb),
    'serviceChargeGroups', coalesce(b.totals->'serviceChargeGroups', '[]'::jsonb),
    'takeawayFeeSen', b.takeaway_fee_sen,
    'roundingSen', b.rounding_sen,
    'totalSen', b.total_sen,
    'payments', coalesce((
      select jsonb_agg(jsonb_build_object('name', p.method_name, 'kind', p.kind, 'amountSen', p.amount_sen,
                                          'tenderedSen', case when p.part_id is null then p.tendered_sen end,
                                          'reference', p.reference,
                                          'part', bp.part_no)
                       order by bp.part_no nulls last, p.line_no, p.id)
        from payments p left join bill_parts bp on bp.id = p.part_id
       where p.bill_id = b.id), '[]'::jsonb),
    'changeSen', (select coalesce(sum(p.change_sen), 0) from payments p where p.bill_id = b.id and p.part_id is null),
    'footer', coalesce(s.receipt_footer, 'This is an official receipt. Thank you for visiting us.'))
  from bills b
  join branches br on br.id = b.branch_id
  left join branch_pos_settings s on s.branch_id = b.branch_id
  left join dining_tables t on t.id = b.table_id
  where b.id = p_bill_id
$$;
revoke all on function pos_receipt_payload(uuid, boolean) from public, anon, authenticated;

-- ── C2. The part receipt: the text of migration-2026-11-17-pos-bill-parts.sql (B1) with the lines marked
--    C2 changed, as pos_receipt_payload. Exactly PartReceiptPayload (src/features/pos/print/receipt.ts).
--    Internal. ─
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
      'email', nullif(trim(br.email), ''),
      'logo', s.receipt_logo),                                                                          -- C2
    'callNo', b.call_no,                                                                                -- C2
    'fontSize', coalesce(s.receipt_font_size, 'normal'),                                               -- C2
    'footerQr', nullif(trim(s.receipt_footer_qr), ''),                                                 -- C2
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
                          from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)
                         where not coalesce(s.receipt_hide_free_mods, false)                           -- C2
                            or jsonb_typeof(m->'priceDeltaSen') is distinct from 'number'              -- C2
                            or (m->>'priceDeltaSen')::numeric <> 0),                                   -- C2
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

notify pgrst, 'reload schema';
select 'pos receipt numbers applied' as result;
