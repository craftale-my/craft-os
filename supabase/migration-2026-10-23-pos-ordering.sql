-- ============================================================================
-- Craft OS — POS Phase 1 · Ordering (2026-10-23)
-- Run on craft-os-dev first, after the menu migrations. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-23-pos-phase1-ordering.md
-- ============================================================================
create extension if not exists pgcrypto;

-- ── Tables (dining) ─────────────────────────────────────────────────────────
create table if not exists dining_tables (
  id          uuid primary key default gen_random_uuid(),
  branch_id   uuid not null references branches(id),
  label       text not null,
  qr_token    text not null unique default encode(gen_random_bytes(12), 'hex'),
  qr_paused   boolean not null default false,
  is_active   boolean not null default true,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  unique (branch_id, label)
);

-- route name (menu_products.print_route) → printer, per branch
create table if not exists print_routes (
  branch_id  uuid not null references branches(id),
  name       text not null,
  kind       text not null check (kind in ('agent', 'epson-epos', 'star-webprnt')),
  address    text not null,   -- agent: host[:port]; epson/star: http://host
  primary key (branch_id, name)
);

create table if not exists branch_menu_status (
  branch_id    uuid not null references branches(id),
  product_id   uuid not null references menu_products(id) on delete cascade,
  is_sold_out  boolean not null default false,
  updated_at   timestamptz not null default now(),
  primary key (branch_id, product_id)
);

-- per-branch, per-day running number for bill_no (YYMMDD-NNN, Malaysia time)
create table if not exists bill_counters (
  branch_id  uuid not null references branches(id),
  day        date not null,
  next_no    integer not null default 1,
  primary key (branch_id, day)
);

create table if not exists bills (
  id                  uuid primary key default gen_random_uuid(),
  branch_id           uuid not null references branches(id),
  bill_no             text not null,
  table_id            uuid references dining_tables(id),            -- null = takeaway
  order_type          text not null check (order_type in ('dine_in', 'takeaway')),
  pax                 integer check (pax between 1 and 99),
  status              text not null default 'open' check (status in ('open', 'paid', 'voided')),
  opened_at           timestamptz not null default now(),
  closed_at           timestamptz,
  closed_by           uuid references staff(id),
  -- fixed at checkout (Sub-plan 3); null while open
  subtotal_sen        integer,
  service_charge_sen  integer,
  sst_sen             integer,
  takeaway_fee_sen    integer,
  rounding_sen        integer,
  total_sen           integer,
  unique (branch_id, bill_no)
);
create unique index if not exists bills_one_open_per_table
  on bills(table_id) where status = 'open' and table_id is not null;
create index if not exists bills_branch_open_idx on bills(branch_id) where status = 'open';

create table if not exists orders (
  id               uuid primary key default gen_random_uuid(),
  bill_id          uuid not null references bills(id),
  branch_id        uuid not null references branches(id),          -- denormalised for Realtime filters
  order_no         text not null,                                    -- "<bill_no>/<k>"
  source           text not null check (source in ('counter', 'qr')),
  placed_by        uuid references staff(id),                        -- null for qr
  client_order_id  uuid not null unique,
  placed_at        timestamptz not null default now()
);
create index if not exists orders_bill_idx on orders(bill_id);

create table if not exists order_items (
  id                  uuid primary key default gen_random_uuid(),
  order_id            uuid not null references orders(id) on delete cascade,
  bill_id             uuid not null references bills(id),
  product_id          uuid references menu_products(id) on delete set null,
  variant_id          uuid references menu_variants(id) on delete set null,
  name_snapshot       text not null,                                -- "Coffee Latte (COLD)"
  unit_price_sen      integer not null check (unit_price_sen >= 0), -- variant + modifiers
  sst_rate_bp         integer not null,
  modifiers_snapshot  jsonb not null default '[]',                   -- [{optionId, group, name, priceDeltaSen, route}]
  print_route         text,                                         -- product's route at order time; null = not printed
  qty                 integer not null check (qty between 1 and 20),
  note                text,
  voided_at           timestamptz,
  voided_by           uuid references staff(id),
  void_reason         text
);
create index if not exists order_items_bill_idx on order_items(bill_id);

create table if not exists print_jobs (
  id          uuid primary key default gen_random_uuid(),
  branch_id   uuid not null references branches(id),
  order_id    uuid references orders(id) on delete set null,        -- null = test print / receipt
  route       text not null,
  kind        text not null default 'ticket' check (kind in ('ticket', 'receipt')),
  payload     jsonb not null,
  status      text not null default 'pending' check (status in ('pending', 'printing', 'printed', 'failed')),
  attempts    integer not null default 0,
  last_error  text,
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,
  printed_at  timestamptz
);
create index if not exists print_jobs_pending_idx on print_jobs(branch_id, created_at) where status in ('pending', 'printing', 'failed');

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Every signed-in staff member reads all of these (one shop). Bills, orders and
-- items are written only by the security-definer RPCs. anon has no policy on any
-- table: the customer page only calls qr_menu / qr_table_state / place_table_order.
do $$
declare t text;
begin
  foreach t in array array['dining_tables','print_routes','branch_menu_status','bill_counters',
                           'bills','orders','order_items','print_jobs']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists pos_read on %I', t);
    execute format('create policy pos_read on %I for select to authenticated using (true)', t);
  end loop;
end $$;

-- tables: any staff may pause/unpause or rename; only settings holders add or remove
drop policy if exists dining_tables_update on dining_tables;
create policy dining_tables_update on dining_tables for update to authenticated using (true) with check (true);
drop policy if exists dining_tables_insert on dining_tables;
create policy dining_tables_insert on dining_tables for insert to authenticated with check (has_menu_cap('access_settings'));
drop policy if exists dining_tables_delete on dining_tables;
create policy dining_tables_delete on dining_tables for delete to authenticated using (has_menu_cap('access_settings'));

-- printers: settings holders only
drop policy if exists print_routes_manage on print_routes;
create policy print_routes_manage on print_routes for all to authenticated
  using (has_menu_cap('access_settings')) with check (has_menu_cap('access_settings'));

-- sold-out: any staff
drop policy if exists branch_menu_status_write on branch_menu_status;
create policy branch_menu_status_write on branch_menu_status for all to authenticated using (true) with check (true);

-- print jobs: status changes go through the security-invoker RPCs, which need UPDATE
drop policy if exists print_jobs_update on print_jobs;
create policy print_jobs_update on print_jobs for update to authenticated using (true) with check (true);

-- ── Realtime ────────────────────────────────────────────────────────────────
do $$ begin alter publication supabase_realtime add table orders;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table print_jobs;
exception when duplicate_object then null; end $$;
