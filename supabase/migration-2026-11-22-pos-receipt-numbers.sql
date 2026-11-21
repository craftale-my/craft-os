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

-- ── C3. Drawer kicks (spec §5) ──────────────────────────────────────────────
-- Which methods open the drawer: every cash method when the column is first added (a re-run leaves the
-- owner's later choices alone); the payment-method form sets it from then on (savePaymentMethod upserts
-- the row under payment_methods_manage).
do $$ begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'payment_methods' and column_name = 'opens_drawer') then
    alter table payment_methods add column opens_drawer boolean not null default false;
    update payment_methods set opens_drawer = true where kind = 'cash';
  end if;
end $$;

-- The reason action of Open drawer (C4). The client offers Give change, Check the cash, Swap a note when
-- the outlet has saved no template; with no row pos_check_reason takes any reason.
alter table reason_templates drop constraint if exists reason_templates_action_check;
alter table reason_templates add constraint reason_templates_action_check
  check (action in ('void_item', 'void_bill', 'refund', 'discount', 'open_drawer'));

-- Every Open drawer (a no-sale open). Read only through pos_shift_report and pos_report_drawer.
create table if not exists pos_drawer_opens (
  id          uuid primary key,                                     -- client-generated: a resend is safe
  branch_id   uuid not null references branches(id),
  shift_id    uuid not null references pos_shifts(id),
  opened_by   uuid not null references staff(id),
  reason      text check (reason is null or length(reason) between 1 and 200),
  created_at  timestamptz not null default now()
);
create index if not exists pos_drawer_opens_shift_idx on pos_drawer_opens(shift_id);
alter table pos_drawer_opens enable row level security;
revoke all on pos_drawer_opens from public, anon, authenticated;

-- A drawer kick on the outlet's receipt printer: prints nothing, pulses the drawer. print_jobs.kind stays
-- 'receipt' (its check allows ticket / receipt), the payload is DrawerPayload (src/features/pos/print/printJob.ts).
-- false = no receipt route, no kick. Queued in the caller's transaction before its receipt: print_jobs.seq
-- keeps that order. Internal.
create or replace function pos_queue_drawer(p_branch_id uuid, p_reason text) returns boolean
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_route text;
begin
  select s.receipt_route into v_route from branch_pos_settings s where s.branch_id = p_branch_id;
  if v_route is null then return false; end if;
  insert into print_jobs(branch_id, route, kind, payload)
  values (p_branch_id, v_route, 'receipt', jsonb_build_object('kind', 'drawer', 'route', v_route, 'reason', p_reason));
  return true;
end $$;
revoke all on function pos_queue_drawer(uuid, text) from public, anon, authenticated;

-- pos_pay_and_close: the text of migration-2026-11-16-pos-split-bill.sql (S3) with the lines marked C3
-- added (and security definer, as every function here) — the final payments of checkout_bill and of a
-- part paid by item (checkout_items) kick the drawer before the receipt when a method opens it. Internal.
create or replace function pos_pay_and_close(p_bill_id uuid, p_branch uuid, p_shift uuid, p_payments jsonb,
                                             p_totals jsonb, p_checkout_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_queued boolean;
begin
  perform pos_insert_payments(p_bill_id, p_branch, p_shift, p_payments);
  update bills
     set status = 'paid', closed_at = now(), closed_by = pos_actor(), closed_device_id = pos_current_device(), checkout_id = p_checkout_id,
         shift_id = p_shift,
         totals = p_totals,
         subtotal_sen       = (p_totals->>'subtotalSen')::integer,
         service_charge_sen = (p_totals->>'serviceChargeSen')::integer,
         sst_sen            = (p_totals->>'sstSen')::integer,
         takeaway_fee_sen   = (p_totals->>'takeawayFeeSen')::integer,
         rounding_sen       = (p_totals->>'roundingSen')::integer,
         total_sen          = (p_totals->>'totalSen')::integer
   where id = p_bill_id;
  if exists (select 1 from payments p join payment_methods m on m.id = p.method_id                       -- C3
              where p.bill_id = p_bill_id and p.part_id is null and m.opens_drawer) then                -- C3
    perform pos_queue_drawer(p_branch, 'Payment');                                                        -- C3
  end if;                                                                                                 -- C3
  v_queued := pos_queue_receipt(p_bill_id, false);
  update bills set receipt_queued = v_queued where id = p_bill_id;
  return pos_checkout_result(p_bill_id);
end $$;
revoke all on function pos_pay_and_close(uuid, uuid, uuid, jsonb, jsonb, uuid) from public, anon, authenticated;

-- pay_bill_part: the text of migration-2026-11-17-pos-bill-parts.sql (B2) with the lines marked C3 added —
-- a part with a method that opens the drawer kicks it before the part receipt.
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
  if exists (select 1 from payments p join payment_methods m on m.id = p.method_id                       -- C3
              where p.part_id = p_part_id and m.opens_drawer) then                                      -- C3
    perform pos_queue_drawer(v_branch, 'Part payment');                                                   -- C3
  end if;                                                                                                 -- C3
  perform pos_queue_part_receipt(p_part_id);
  return pos_part_result(p_part_id);
end $$;
revoke all on function pay_bill_part(uuid, uuid, integer, integer, jsonb, integer) from public, anon;   -- B2
grant execute on function pay_bill_part(uuid, uuid, integer, integer, jsonb, integer) to authenticated;   -- B2

-- refund_bill: the text of migration-2026-10-29-pos-device-till.sql with the lines marked C3 added — money
-- paid back with a method that opens the drawer kicks it before the refund slip.
CREATE OR REPLACE FUNCTION refund_bill(p_refund_id uuid, p_bill_id uuid, p_amount_sen integer, p_method_id uuid, p_reason text, p_approver_id uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch      uuid := pos_my_branch();
  v_bill        bills;
  v_existing    refunds;
  v_method_name text;
  v_paid        integer;
  v_back        integer;
  v_reason      text;
  v_err         text;
  v_route       text;
  v_kind        text;                                              -- 4a
  v_shift       uuid;                                              -- 4a
begin
  if p_refund_id is null then raise exception 'Refund id is missing'; end if;
  -- a resend of a refund that already went through gets the same reply as the first time
  select * into v_existing from refunds where id = p_refund_id;
  if found then
    if v_existing.branch_id <> v_branch then
      raise exception 'This refund id belongs to another bill';
    end if;
    if v_existing.bill_id <> p_bill_id or v_existing.amount_sen is distinct from p_amount_sen
       or v_existing.method_id is distinct from p_method_id then
      return jsonb_build_object('ok', false, 'error',
        format('This refund was already recorded as RM %s by %s — close and reopen to refund more',
               to_char(v_existing.amount_sen / 100.0, 'FM999999990.00'), v_existing.method_name));
    end if;
    return jsonb_build_object('ok', true, 'amountSen', v_existing.amount_sen,
                              'refundedSen', (select refunded_sen from bills where id = p_bill_id),
                              'slipQueued', v_existing.slip_queued);
  end if;
  select * into v_bill from bills where id = p_bill_id and branch_id = v_branch for update;
  if not found then raise exception 'Bill not found'; end if;
  select * into v_existing from refunds where id = p_refund_id;        -- the same refund won while we waited
  if found then
    if v_existing.bill_id <> p_bill_id or v_existing.amount_sen is distinct from p_amount_sen
       or v_existing.method_id is distinct from p_method_id then
      return jsonb_build_object('ok', false, 'error',
        format('This refund was already recorded as RM %s by %s — close and reopen to refund more',
               to_char(v_existing.amount_sen / 100.0, 'FM999999990.00'), v_existing.method_name));
    end if;
    return jsonb_build_object('ok', true, 'amountSen', v_existing.amount_sen, 'refundedSen', v_bill.refunded_sen,
                              'slipQueued', v_existing.slip_queued);
  end if;
  -- 4a: a refund belongs to the shift open NOW (a refund of an old bill too); FOR SHARE as in checkout_bill
  select id into v_shift from pos_shifts where branch_id = v_branch and status = 'open' for share;
  if not found then raise exception 'Open the shift first'; end if;
  if v_bill.status <> 'paid' then raise exception 'Only a paid bill can be refunded'; end if;
  if p_amount_sen is null or p_amount_sen <= 0 then raise exception 'Invalid refund amount'; end if;
  if p_amount_sen > v_bill.total_sen - v_bill.refunded_sen then
    raise exception 'Refund is more than what is left on this bill (RM %)',
      to_char((v_bill.total_sen - v_bill.refunded_sen) / 100.0, 'FM999999990.00');
  end if;
  -- the original route: a method this bill was paid with, up to what it has left
  -- (the bill row is locked above, so two refunds of one bill cannot both pass)
  select p.method_name, p.kind into v_method_name, v_kind                 -- 4a: the kind too
    from payments p where p.bill_id = v_bill.id and p.method_id = p_method_id
   order by p.line_no limit 1;
  if not found then
    raise exception 'Refunds go back the way the bill was paid — choose one of its payment methods';
  end if;
  select coalesce(sum(p.amount_sen), 0)::integer into v_paid
    from payments p where p.bill_id = v_bill.id and p.method_id = p_method_id;
  select coalesce(sum(r.amount_sen), 0)::integer into v_back
    from refunds r where r.bill_id = v_bill.id and r.method_id = p_method_id;
  if p_amount_sen > v_paid - v_back then
    raise exception 'Refund is more than was paid by % on this bill (RM % left)',
      v_method_name, to_char(greatest(v_paid - v_back, 0) / 100.0, 'FM999999990.00');
  end if;
  v_reason := pos_check_reason(v_branch, 'refund', p_reason);
  v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
  if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  insert into refunds(id, bill_id, branch_id, amount_sen, method_id, method_name, reason, approved_by, created_by,
                      shift_id, kind)                                                   -- 4a
  values (p_refund_id, v_bill.id, v_branch, p_amount_sen, p_method_id, v_method_name, v_reason, p_approver_id, pos_actor(),
          v_shift, v_kind);                                                             -- 4a
  update bills set refunded_sen = refunded_sen + p_amount_sen where id = v_bill.id;
  if (select m.opens_drawer from payment_methods m where m.id = p_method_id) then                         -- C3
    perform pos_queue_drawer(v_branch, 'Refund');                                                         -- C3
  end if;                                                                                                 -- C3
  select s.receipt_route into v_route from branch_pos_settings s where s.branch_id = v_branch;
  if v_route is not null then
    insert into print_jobs(branch_id, route, kind, payload)
    values (v_branch, v_route, 'receipt', pos_refund_slip_payload(p_refund_id));
    update refunds set slip_queued = true where id = p_refund_id;
  end if;
  return jsonb_build_object('ok', true, 'amountSen', p_amount_sen, 'refundedSen', v_bill.refunded_sen + p_amount_sen,
                            'slipQueued', v_route is not null);
end $function$;
revoke all on function refund_bill(uuid, uuid, integer, uuid, text, uuid, text) from public, anon;
grant execute on function refund_bill(uuid, uuid, integer, uuid, text, uuid, text) to authenticated;

-- record_cash_move: the text of migration-2026-10-29-pos-device-till.sql with the line marked C3 added —
-- a pay in or pay out is cash: the drawer opens (a resend of the same id answers without a second kick).
CREATE OR REPLACE FUNCTION record_cash_move(p_id uuid, p_kind text, p_amount_sen integer, p_reason text, p_approver_id uuid, p_pin text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_branch   uuid := pos_my_branch();
  v_existing pos_cash_moves;
  v_shift    uuid;
  v_reason   text := nullif(trim(p_reason), '');
  v_err      text;
begin
  if p_id is null then raise exception 'Cash move id is missing'; end if;
  select * into v_existing from pos_cash_moves where id = p_id;
  if found then
    if v_existing.branch_id <> v_branch then raise exception 'This cash move id belongs to another branch'; end if;
    if v_existing.kind is distinct from p_kind or v_existing.amount_sen is distinct from p_amount_sen then
      return jsonb_build_object('ok', false, 'error',
        format('This was already recorded as %s RM %s — close and reopen to record another',
               case v_existing.kind when 'pay_in' then 'Pay in' else 'Pay out' end,
               to_char(v_existing.amount_sen / 100.0, 'FM999999990.00')));
    end if;
    return jsonb_build_object('ok', true, 'id', v_existing.id, 'kind', v_existing.kind, 'amountSen', v_existing.amount_sen);
  end if;
  if p_kind is null or p_kind not in ('pay_in', 'pay_out') then raise exception 'Choose Pay in or Pay out'; end if;
  if p_amount_sen is null or p_amount_sen <= 0 or p_amount_sen > 10000000 then
    raise exception 'Enter the amount (RM 0.01 to RM 100000.00)';
  end if;
  if v_reason is null then raise exception 'Enter a reason'; end if;
  if length(v_reason) > 200 then raise exception 'Reason is too long'; end if;
  select id into v_shift from pos_shifts where branch_id = v_branch and status = 'open' for share;
  if not found then raise exception 'Open the shift first'; end if;
  if p_kind = 'pay_out' then
    v_err := pos_check_approver(v_branch, p_approver_id, p_pin);
    if v_err is not null then return jsonb_build_object('ok', false, 'error', v_err); end if;
  end if;
  insert into pos_cash_moves(id, shift_id, branch_id, kind, amount_sen, reason, created_by, approved_by)
  values (p_id, v_shift, v_branch, p_kind, p_amount_sen, v_reason, pos_actor(),
          case when p_kind = 'pay_out' then p_approver_id end)
  on conflict (id) do nothing;
  if not found then                                                       -- the same id won meanwhile
    return record_cash_move(p_id, p_kind, p_amount_sen, p_reason, p_approver_id, p_pin);
  end if;
  perform pos_queue_drawer(v_branch, case p_kind when 'pay_in' then 'Pay in' else 'Pay out' end);        -- C3
  return jsonb_build_object('ok', true, 'id', p_id, 'kind', p_kind, 'amountSen', p_amount_sen);
end $function$;
revoke all on function record_cash_move(uuid, text, integer, text, uuid, text) from public, anon;
grant execute on function record_cash_move(uuid, text, integer, text, uuid, text) to authenticated;

-- ── C4. Open drawer (spec §5) ───────────────────────────────────────────────
-- A no-sale open: the caller's outlet (pos_my_branch) needs an open shift; the reason follows the outlet's
-- open_drawer template (pos_check_reason); no supervisor PIN. Logged in pos_drawer_opens, then kicked on
-- the receipt printer. With no receipt printer nothing is logged: an open that cannot happen is not counted.
-- p_id is the client's: a resend of the same id answers again without a second kick.
create or replace function pos_open_drawer(p_id uuid, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_branch   uuid := pos_my_branch();
  v_existing pos_drawer_opens;
  v_shift    uuid;
  v_reason   text;
  v_route    text;
begin
  if p_id is null then raise exception 'Drawer open id is missing'; end if;
  select * into v_existing from pos_drawer_opens where id = p_id;
  if found then
    if v_existing.branch_id <> v_branch then raise exception 'This drawer open id belongs to another outlet'; end if;
    return jsonb_build_object('ok', true, 'id', v_existing.id);
  end if;
  select id into v_shift from pos_shifts where branch_id = v_branch and status = 'open' for share;
  if not found then raise exception 'Open a shift first.'; end if;
  v_reason := pos_check_reason(v_branch, 'open_drawer', p_reason);
  select s.receipt_route into v_route from branch_pos_settings s where s.branch_id = v_branch;
  if v_route is null then raise exception 'No receipt printer is set — choose one in POS settings'; end if;
  insert into pos_drawer_opens(id, branch_id, shift_id, opened_by, reason)
  values (p_id, v_branch, v_shift, pos_actor(), v_reason)
  on conflict (id) do nothing;
  if not found then                                                       -- the same id won meanwhile
    return pos_open_drawer(p_id, p_reason);
  end if;
  perform pos_queue_drawer(v_branch, coalesce(v_reason, 'Open drawer'));
  return jsonb_build_object('ok', true, 'id', p_id);
end $$;
revoke all on function pos_open_drawer(uuid, text) from public, anon;
grant execute on function pos_open_drawer(uuid, text) to authenticated;

-- ── C5. The Z report: the live text of migration-2026-11-17-pos-bill-parts.sql (B6) with the line marked
--    C5 added — cash.noSaleOpens, the shift's Open drawer count. Internal. ─

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
           coalesce(sum(sb.subtotal_sen - coalesce((sb.totals->>'billDiscountSen')::integer, 0)), 0)::integer as gross,   -- D
           coalesce(sum(sb.takeaway_fee_sen), 0)::integer as fee,
           coalesce(sum(sb.service_charge_sen), 0)::integer as sc, coalesce(sum(sb.sst_sen), 0)::integer as sst,
           coalesce(sum(sb.rounding_sen), 0)::integer as rounding, coalesce(sum(sb.total_sen), 0)::integer as nett,
           coalesce(sum(coalesce((sb.totals->>'grossSen')::integer, sb.subtotal_sen)), 0)::integer as before_disc,           -- D
           coalesce(sum(coalesce((sb.totals->>'catalogDiscountSen')::integer, 0)), 0)::integer as cat_disc,                  -- D
           coalesce(sum(coalesce((sb.totals->>'itemDiscountSen')::integer, 0)), 0)::integer as item_disc,                    -- D
           coalesce(sum(coalesce((sb.totals->>'billDiscountSen')::integer, 0)), 0)::integer as bill_disc,                    -- D
           (count(*) filter (where coalesce((sb.totals->>'catalogDiscountSen')::integer, 0) > 0))::integer as cat_bills,      -- D
           (count(*) filter (where coalesce((sb.totals->>'billDiscountSen')::integer, 0) > 0))::integer as bill_disc_bills   -- D
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
      'roundingSen', t.rounding, 'nettSen', t.nett,
      'beforeDiscountsSen', t.before_disc, 'discountSen', t.cat_disc + t.item_disc + t.bill_disc),                       -- D
    'discounts', jsonb_build_object(                                                                                       -- D
      'catalogSen', t.cat_disc, 'catalogBills', t.cat_bills,
      'itemSen', t.item_disc,
      'itemCount', (select count(*)::integer from sb, jsonb_array_elements(coalesce(sb.totals->'lines', '[]'::jsonb)) as x(l)
                     where coalesce((x.l->>'itemDiscountSen')::integer, 0) > 0),
      'billSen', t.bill_disc, 'billCount', t.bill_disc_bills),
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
               'orders', (select count(distinct oi.order_id)::integer                                         -- S5
                            from order_items oi join orders o on o.id = oi.order_id                           -- S5
                           where oi.bill_id in (select sb.id from sb) and o.source = x.src),                  -- S5
               'itemSen', (select coalesce(sum(oi.unit_price_sen * oi.qty), 0)::integer
                             from order_items oi join orders o on o.id = oi.order_id
                            where oi.bill_id in (select sb.id from sb) and o.source = x.src and oi.voided_at is null))   -- S5
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
      'varianceApprovedBy', (select st.name from staff st where st.id = s.variance_approved_by),
      'noSaleOpens', (select count(*)::integer from pos_drawer_opens d where d.shift_id = s.id)),                            -- C5
    'parts', jsonb_build_object(                                                                                           -- B6
      -- taken in this shift on a bill that did not close in it: in PAYMENTS, its sale is in a later shift          -- B6
      'openSen', coalesce((select sum(p.amount_sen) from payments p join bills b on b.id = p.bill_id                       -- B6
                            where p.shift_id = s.id and p.part_id is not null and b.shift_id is distinct from s.id), 0)::integer,   -- B6
      'openCount', (select count(distinct p.part_id)::integer from payments p join bills b on b.id = p.bill_id             -- B6
                     where p.shift_id = s.id and p.part_id is not null and b.shift_id is distinct from s.id),                -- B6
      -- taken in an earlier shift on a bill that closed in this one: in its sales, not in this PAYMENTS             -- B6
      'earlierSen', coalesce((select sum(p.amount_sen) from payments p                                                    -- B6
                               where p.bill_id in (select sb.id from sb) and p.part_id is not null and p.shift_id <> s.id), 0)::integer,   -- B6
      'earlierCount', (select count(distinct p.part_id)::integer from payments p                                          -- B6
                        where p.bill_id in (select sb.id from sb) and p.part_id is not null and p.shift_id <> s.id)),      -- B6
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

-- ── C5. Reports → Cash drawer: the live text of migration-2026-11-18-pos-reports.sql (R4) with the line
--    marked C5 added — noSaleOpens per shift. ─
create or replace function pos_report_drawer(p_branch_ids uuid[], p_from date, p_to date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  s     record;
  v_out jsonb;
begin
  select * into s from pos_report_scope(p_branch_ids, p_from, p_to);
  select jsonb_build_object('shifts', coalesce((
    select jsonb_agg(jsonb_build_object(
             'outlet', br.name,
             'openedAt', to_char(sh.opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'closedAt', to_char(sh.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
             'openedBy', (select st.name from staff st where st.id = sh.opened_by),
             'closedBy', (select st.name from staff st where st.id = sh.closed_by),
             'floatSen', sh.opening_float_sen,
             'cashSalesSen', coalesce((select sum(p.amount_sen) from payments p where p.shift_id = sh.id and p.kind = 'cash'), 0),
             'cashRefundSen', coalesce((select sum(r.amount_sen) from refunds r where r.shift_id = sh.id and r.kind = 'cash'), 0),
             'payInSen', coalesce((select sum(m.amount_sen) from pos_cash_moves m where m.shift_id = sh.id and m.kind = 'pay_in'), 0),
             'payOutSen', coalesce((select sum(m.amount_sen) from pos_cash_moves m where m.shift_id = sh.id and m.kind = 'pay_out'), 0),
             'noSaleOpens', (select count(*)::integer from pos_drawer_opens d where d.shift_id = sh.id),                  -- C5
             'expectedSen', coalesce(sh.expected_cash_sen, pos_shift_expected_cash(sh.id)),
             'countedSen', sh.counted_cash_sen,
             'varianceSen', sh.variance_sen,
             'reason', sh.variance_reason)
           order by sh.opened_at, sh.id)
      from pos_shifts sh
      join branches br on br.id = sh.branch_id
     where sh.branch_id = any (p_branch_ids)
       and coalesce(sh.closed_at, sh.opened_at) >= s.start_at
       and coalesce(sh.closed_at, sh.opened_at) < s.end_at), '[]'::jsonb))
    into v_out;
  return v_out;
end $$;
revoke all on function pos_report_drawer(uuid[], date, date) from public, anon;
grant execute on function pos_report_drawer(uuid[], date, date) to authenticated;

notify pgrst, 'reload schema';
select 'pos receipt numbers applied' as result;
