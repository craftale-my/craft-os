do $$
begin
  if to_regclass('public.staff') is not null then
    raise exception 'STOP: public.staff exists, so this is the Craft OS production database. Run the POS spike only in the craft-os-dev project.';
  end if;
end $$;

-- ============================================================================
-- POS Phase 0 spike schema — DEV SUPABASE ONLY.
-- NEVER run this in the prod project (yfsoesxzurzjdwstszru).
-- Everything here is prefixed spike_ and is removed by
-- spike-2026-10-22-pos-phase0-drop.sql once the spike results are recorded.
-- ============================================================================

create extension if not exists pgcrypto;

create table if not exists spike_tables (
  id         uuid primary key default gen_random_uuid(),
  label      text not null unique,
  qr_token   text not null unique default encode(gen_random_bytes(12), 'hex'),
  qr_paused  boolean not null default false,
  is_active  boolean not null default true
);

create table if not exists spike_menu_items (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  price_sen     integer not null check (price_sen >= 0),
  route         text not null,
  is_available  boolean not null default true
);

-- route → which printer prints it. kind 'agent' = printed by tools/print-agent
create table if not exists spike_print_routes (
  route    text primary key,
  kind     text not null check (kind in ('epson-epos', 'star-webprnt', 'agent')),
  address  text not null
);

create table if not exists spike_bills (
  id         uuid primary key default gen_random_uuid(),
  table_id   uuid references spike_tables(id),
  status     text not null default 'open' check (status in ('open', 'paid')),
  opened_at  timestamptz not null default now()
);
create unique index if not exists spike_bills_one_open_per_table
  on spike_bills(table_id) where status = 'open' and table_id is not null;

create table if not exists spike_orders (
  id               uuid primary key default gen_random_uuid(),
  bill_id          uuid not null references spike_bills(id),
  source           text not null check (source in ('qr', 'counter')),
  placed_by        uuid,
  client_order_id  uuid not null unique,
  placed_at        timestamptz not null default now()
);

create table if not exists spike_order_items (
  id              uuid primary key default gen_random_uuid(),
  order_id        uuid not null references spike_orders(id) on delete cascade,
  menu_item_id    uuid not null references spike_menu_items(id),
  name_snapshot   text not null,
  unit_price_sen  integer not null,
  qty             integer not null check (qty between 1 and 20),
  note            text,
  route           text not null
);

create table if not exists spike_print_jobs (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid references spike_orders(id) on delete cascade,  -- null = test print
  route       text not null,
  payload     jsonb not null,
  status      text not null default 'pending'
              check (status in ('pending', 'printing', 'printed', 'failed')),
  attempts    integer not null default 0,
  last_error  text,
  created_at  timestamptz not null default now(),
  printed_at  timestamptz
);

-- ── RLS: anon may do nothing directly; staff read orders, all writes go via RPCs ──
do $$
declare t text;
begin
  foreach t in array array['spike_tables','spike_menu_items','spike_print_routes',
                           'spike_bills','spike_orders','spike_order_items','spike_print_jobs']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists spike_staff_all on %I', t);
    execute format('drop policy if exists spike_staff_read on %I', t);
    -- bills/orders/items are read-only to staff (writes only via the security-definer RPCs, so prices can't be forged); admin tables and print jobs stay writable
    if t in ('spike_bills', 'spike_orders', 'spike_order_items') then
      execute format('create policy spike_staff_read on %I for select to authenticated using (true)', t);
    else
      execute format('create policy spike_staff_all on %I for all to authenticated using (true) with check (true)', t);
    end if;
  end loop;
end $$;

-- ── Realtime ─────────────────────────────────────────────────────────────────
do $$ begin alter publication supabase_realtime add table spike_orders;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table spike_print_jobs;
exception when duplicate_object then null; end $$;

-- ── Server clock, for latency measurement ────────────────────────────────────
create or replace function spike_server_now() returns timestamptz
language sql stable as $$ select now() $$;
grant execute on function spike_server_now() to anon, authenticated;

-- ── Shared order writer (not callable by clients) ────────────────────────────
-- Prices, names and routes come from spike_menu_items, never from the client.
-- Idempotent on client_order_id: a resend returns the original order id.
create or replace function spike_insert_order(
  p_table_id uuid, p_source text, p_placed_by uuid, p_items jsonb, p_client_order_id uuid
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_existing  uuid;
  v_bill_id   uuid;
  v_order_id  uuid;
  v_label     text;
  v_item      jsonb;
  v_menu      spike_menu_items;
  v_qty       numeric;
begin
  if p_client_order_id is null then
    raise exception 'Order id is missing';
  end if;

  select id into v_existing from spike_orders where client_order_id = p_client_order_id;
  if v_existing is not null then
    return v_existing;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Order has no items';
  end if;

  -- validate every line before writing anything, so bad input is always a P0001 (final) error
  for v_item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'Invalid item';
    end if;
    if jsonb_typeof(v_item->'menuItemId') is distinct from 'string'
       or (v_item->>'menuItemId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Item is not available: %', coalesce(v_item->>'menuItemId', '?');
    end if;
    if v_item->'qty' is not null then
      if jsonb_typeof(v_item->'qty') <> 'number' then
        raise exception 'Invalid quantity';
      end if;
      v_qty := (v_item->'qty')::numeric;
      if v_qty < 1 or v_qty > 20 or v_qty <> trunc(v_qty) then
        raise exception 'Invalid quantity';
      end if;
    end if;
  end loop;

  -- bill and order inserts share one savepoint: if a concurrent resend wins the race
  -- on client_order_id, both are rolled back, so no orphan bill is left behind
  begin
    if p_table_id is null then
      insert into spike_bills(table_id) values (null) returning id into v_bill_id;
    else
      insert into spike_bills(table_id) values (p_table_id)
        on conflict (table_id) where status = 'open' and table_id is not null do nothing
        returning id into v_bill_id;
      if v_bill_id is null then
        select id into v_bill_id from spike_bills where table_id = p_table_id and status = 'open';
      end if;
      select label into v_label from spike_tables where id = p_table_id;
    end if;

    insert into spike_orders(bill_id, source, placed_by, client_order_id)
    values (v_bill_id, p_source, p_placed_by, p_client_order_id)
    returning id into v_order_id;
  exception when unique_violation then
    -- a concurrent resend of the same order won the race
    select id into v_order_id from spike_orders where client_order_id = p_client_order_id;
    return v_order_id;
  end;

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_menu from spike_menu_items where id = (v_item->>'menuItemId')::uuid;
    if not found or not v_menu.is_available then
      raise exception 'Item is not available: %', coalesce(v_item->>'menuItemId', '?');
    end if;
    insert into spike_order_items(order_id, menu_item_id, name_snapshot, unit_price_sen, qty, note, route)
    values (v_order_id, v_menu.id, v_menu.name, v_menu.price_sen,
            coalesce((v_item->'qty')::numeric::integer, 1), nullif(v_item->>'note', ''), v_menu.route);
  end loop;

  -- one ticket per route, shaped exactly like TicketPayload (ticket.ts)
  insert into spike_print_jobs(order_id, route, payload)
  select v_order_id, oi.route, jsonb_build_object(
           'kind', 'ticket',
           'route', oi.route,
           'tableLabel', v_label,
           'orderNo', upper(left(v_order_id::text, 6)),
           'source', p_source,
           'placedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'lines', jsonb_agg(jsonb_build_object('qty', oi.qty, 'name', oi.name_snapshot, 'note', oi.note)
                              order by oi.name_snapshot))
    from spike_order_items oi
   where oi.order_id = v_order_id
   group by oi.route;

  return v_order_id;
end $$;
revoke all on function spike_insert_order(uuid, text, uuid, jsonb, uuid) from public, anon, authenticated;

-- ── Customer QR ordering (anon) ──────────────────────────────────────────────
create or replace function spike_place_table_order(p_token text, p_items jsonb, p_client_order_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_table   spike_tables;
  v_recent  integer;
  v_existing uuid;
begin
  select * into v_table from spike_tables where qr_token = p_token;
  if not found then
    raise exception 'Invalid table code';
  end if;

  -- resend of an order that already went in: return it even if the table was paused/deactivated since
  select id into v_existing from spike_orders where client_order_id = p_client_order_id;
  if v_existing is not null then
    return v_existing;
  end if;

  if not v_table.is_active then
    raise exception 'Invalid table code';
  end if;
  if v_table.qr_paused then
    raise exception 'Ordering is paused for this table. Please order at the counter.';
  end if;

  select count(*) into v_recent
    from spike_orders o join spike_bills b on b.id = o.bill_id
   where b.table_id = v_table.id and o.source = 'qr' and o.placed_at > now() - interval '1 minute';
  if v_recent >= 5 then
    raise exception 'Too many orders from this table. Please wait a minute.';
  end if;

  return spike_insert_order(v_table.id, 'qr', null, p_items, p_client_order_id);
end $$;
revoke all on function spike_place_table_order(text, jsonb, uuid) from public;
grant execute on function spike_place_table_order(text, jsonb, uuid) to anon, authenticated;

create or replace function spike_qr_menu(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
           'tableLabel', t.label,
           'paused', t.qr_paused,
           'items', coalesce((select jsonb_agg(jsonb_build_object(
                                 'id', m.id, 'name', m.name,
                                 'priceSen', m.price_sen, 'available', m.is_available)
                               order by m.name)
                              from spike_menu_items m), '[]'::jsonb))
    from spike_tables t
   where t.qr_token = p_token and t.is_active
$$;
revoke all on function spike_qr_menu(text) from public;
grant execute on function spike_qr_menu(text) to anon, authenticated;

-- ── Counter ordering (staff) ─────────────────────────────────────────────────
create or replace function spike_place_counter_order(p_table_id uuid, p_items jsonb, p_client_order_id uuid)
returns uuid
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in required';
  end if;
  return spike_insert_order(p_table_id, 'counter', auth.uid(), p_items, p_client_order_id);
end $$;
revoke all on function spike_place_counter_order(uuid, jsonb, uuid) from public, anon;
grant execute on function spike_place_counter_order(uuid, jsonb, uuid) to authenticated;

-- ── Print job lifecycle: pending → printing → printed | failed ───────────────
-- claim is atomic, so the iPad and the print agent can never print one job twice.
create or replace function spike_claim_print_job(p_id uuid) returns boolean
language plpgsql security invoker as $$
begin
  update spike_print_jobs set status = 'printing', attempts = attempts + 1
   where id = p_id and status = 'pending';
  return found;
end $$;

create or replace function spike_finish_print_job(p_id uuid, p_ok boolean, p_error text) returns void
language plpgsql security invoker as $$
begin
  update spike_print_jobs
     set status     = case when p_ok then 'printed' else 'failed' end,
         printed_at = case when p_ok then now() else null end,
         last_error = case when p_ok then null else p_error end
   where id = p_id and status = 'printing';
end $$;

create or replace function spike_requeue_print_job(p_id uuid) returns void
language plpgsql security invoker as $$
begin
  update spike_print_jobs set status = 'pending' where id = p_id and status = 'failed';
end $$;

revoke all on function spike_claim_print_job(uuid), spike_finish_print_job(uuid, boolean, text),
                       spike_requeue_print_job(uuid) from public, anon;
grant execute on function spike_claim_print_job(uuid), spike_finish_print_job(uuid, boolean, text),
                          spike_requeue_print_job(uuid) to authenticated;

-- ── Seed ────────────────────────────────────────────────────────────────────
insert into spike_tables(label) values ('A1'), ('A2'), ('B5') on conflict (label) do nothing;

insert into spike_menu_items(name, price_sen, route)
select n, p, r from (values
  ('Coffee Latte (COLD)',         1300, 'Bar'),
  ('Lychee Rose',                 1800, 'Bar'),
  ('Smoked Duck DON',             2400, 'Kitchen'),
  ('Fried Chicken Curry DON',     2500, 'Kitchen'),
  ('Salted Egg 咸蛋酱 (CJK test)',   0, 'Kitchen')
) as v(n, p, r)
where not exists (select 1 from spike_menu_items);
