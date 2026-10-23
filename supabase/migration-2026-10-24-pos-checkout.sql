-- ============================================================================
-- Craft OS — POS Phase 1 · Checkout, payments, receipts, voids, refunds (2026-10-24)
-- Run on craft-os-dev first, after the ordering migrations. Idempotent — safe to re-run.
-- Plan: docs/superpowers/plans/2026-10-24-pos-phase1-checkout.md
-- Design: docs/superpowers/specs/2026-10-23-pos-checkout-design.md §3
-- ============================================================================
create extension if not exists pgcrypto;

-- PINs are hashed with crypt()/gen_salt('bf'), called schema-qualified from
-- functions whose search_path is pinned to public — so pgcrypto must live in
-- the "extensions" schema (Supabase's default). Stop here if it does not.
do $$ begin
  if to_regprocedure('extensions.crypt(text,text)') is null then
    raise exception 'STOP: pgcrypto is not in schema "extensions" — the PIN functions call extensions.crypt()';
  end if;
end $$;

-- ── Receipt header per branch (managers edit on /pos/settings) ──────────────
alter table branches add column if not exists receipt_title    text;   -- e.g. "Craft Cafe - Cheras"; null = branches.name
alter table branches add column if not exists legal_name       text;
alter table branches add column if not exists registration_no  text;
alter table branches add column if not exists sst_no           text;
alter table branches add column if not exists phone            text;
alter table branches add column if not exists email            text;

-- ── POS settings, one row per branch (a missing row means the defaults) ─────
create table if not exists branch_pos_settings (
  branch_id              uuid primary key references branches(id),
  sst_registered         boolean not null default true,
  cash_rounding          text not null default 'nearest_5_sen' check (cash_rounding in ('none', 'nearest_5_sen')),
  receipt_route          text,                                          -- print route for receipts; null = none printed
  receipt_footer         text not null default 'This is an official receipt. Thank you for visiting us.',
  qr_requires_open_bill  boolean not null default false,
  updated_at             timestamptz not null default now()
);

-- ── Service charge: rules, first match per line in sort_order ──────────────
create table if not exists service_charge_rules (
  id           uuid primary key default gen_random_uuid(),
  branch_id    uuid not null references branches(id),
  rate_bp      integer not null check (rate_bp between 0 and 10000),
  order_types  text[] not null check (cardinality(order_types) > 0 and order_types <@ array['dine_in', 'takeaway']),
  table_ids    uuid[],                                                  -- null = every table
  product_ids  uuid[],                                                  -- null = every product
  sort_order   integer not null default 0,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);
create index if not exists service_charge_rules_branch_idx on service_charge_rules(branch_id, sort_order);

create table if not exists payment_methods (
  id               uuid primary key default gen_random_uuid(),
  branch_id        uuid not null references branches(id),
  name             text not null check (length(trim(name)) between 1 and 40),
  kind             text not null check (kind in ('cash', 'card', 'duitnow', 'ewallet', 'other')),
  needs_reference  boolean not null default false,
  sort_order       integer not null default 0,
  is_active        boolean not null default true,
  unique (branch_id, name)
);

create table if not exists reason_templates (
  branch_id    uuid not null references branches(id),
  action       text not null check (action in ('void_item', 'void_bill', 'refund')),
  reasons      text[] not null default '{}',
  compulsory   boolean not null default true,
  allow_other  boolean not null default true,
  primary key (branch_id, action)
);

-- ── Money in and out (written only by checkout_bill / refund_bill) ─────────
create table if not exists payments (
  id            uuid primary key default gen_random_uuid(),
  bill_id       uuid not null references bills(id),
  branch_id     uuid not null references branches(id),                 -- denormalised for day/shift reports
  method_id     uuid references payment_methods(id),
  method_name   text not null,                                          -- snapshot
  kind          text not null check (kind in ('cash', 'card', 'duitnow', 'ewallet', 'other')),
  amount_sen    integer not null check (amount_sen > 0),
  tendered_sen  integer,                                                -- cash only
  change_sen    integer not null default 0 check (change_sen >= 0),
  reference     text,
  taken_by      uuid references staff(id),
  taken_at      timestamptz not null default now(),
  line_no       integer not null default 1,                            -- order on the receipt (one checkout = one taken_at)
  check (tendered_sen is null or (kind = 'cash' and tendered_sen >= amount_sen)),
  check (change_sen = coalesce(tendered_sen - amount_sen, 0))
);
create index if not exists payments_bill_idx on payments(bill_id);
create index if not exists payments_branch_day_idx on payments(branch_id, taken_at);

create table if not exists refunds (
  id           uuid primary key,                                        -- client-generated: retries are safe
  bill_id      uuid not null references bills(id),
  branch_id    uuid not null references branches(id),
  amount_sen   integer not null check (amount_sen > 0),
  method_id    uuid references payment_methods(id),
  method_name  text not null,
  reason       text,
  approved_by  uuid not null references staff(id),
  created_by   uuid not null references staff(id),
  created_at   timestamptz not null default now(),
  slip_queued  boolean not null default false                          -- was a refund slip queued (repeated on a replay)
);
create index if not exists refunds_bill_idx on refunds(bill_id);

-- ── Bills: merged status, idempotent checkout, refunds, void audit ─────────
-- Bare columns first, constraints by name afterwards: a re-run adds nothing twice.
alter table bills drop constraint if exists bills_status_check;
alter table bills add constraint bills_status_check check (status in ('open', 'paid', 'voided', 'merged'));
alter table bills add column if not exists merged_into       uuid;
alter table bills add column if not exists checkout_id       uuid;
alter table bills add column if not exists refunded_sen      integer not null default 0;
alter table bills add column if not exists totals            jsonb;     -- pos_bill_totals() at checkout: groups for the receipt's charges summary
alter table bills add column if not exists receipt_queued    boolean;   -- set by checkout_bill: was a receipt job queued
alter table bills add column if not exists void_reason       text;
alter table bills add column if not exists void_approved_by  uuid;

-- ── Order items: takeaway fee snapshot, void approver ──────────────────────
alter table order_items add column if not exists takeaway_fee_sen  integer not null default 0;
alter table order_items add column if not exists void_approved_by  uuid;

create unique index if not exists bills_checkout_id_key on bills(checkout_id);
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'bills_merged_into_fkey') then
    alter table bills add constraint bills_merged_into_fkey foreign key (merged_into) references bills(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bills_void_approved_by_fkey') then
    alter table bills add constraint bills_void_approved_by_fkey foreign key (void_approved_by) references staff(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bills_refunded_sen_check') then
    alter table bills add constraint bills_refunded_sen_check check (refunded_sen >= 0);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'order_items_void_approved_by_fkey') then
    alter table order_items add constraint order_items_void_approved_by_fkey foreign key (void_approved_by) references staff(id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'order_items_takeaway_fee_sen_check') then
    alter table order_items add constraint order_items_takeaway_fee_sen_check check (takeaway_fee_sen >= 0);
  end if;
end $$;

-- ── Staff POS PINs: bcrypt hashes nobody can read ──────────────────────────
create table if not exists staff_pos_pins (
  staff_id         uuid primary key references staff(id) on delete cascade,
  pin_hash         text not null,                                       -- extensions.crypt(pin, extensions.gen_salt('bf'))
  failed_attempts  integer not null default 0,
  locked_until     timestamptz,
  updated_at       timestamptz not null default now()
);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Every signed-in staff member reads the checkout tables (one shop). Payments and
-- refunds are written only by the security-definer RPCs; settings tables by
-- access_settings holders; branch_pos_settings only through save_receipt_settings.
do $$
declare t text;
begin
  foreach t in array array['branch_pos_settings','service_charge_rules','payment_methods',
                           'reason_templates','payments','refunds']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists pos_read on %I', t);
    execute format('create policy pos_read on %I for select to authenticated using (true)', t);
  end loop;
end $$;

drop policy if exists service_charge_rules_manage on service_charge_rules;
create policy service_charge_rules_manage on service_charge_rules for all to authenticated
  using (has_menu_cap('access_settings')) with check (has_menu_cap('access_settings'));
drop policy if exists payment_methods_manage on payment_methods;
create policy payment_methods_manage on payment_methods for all to authenticated
  using (has_menu_cap('access_settings')) with check (has_menu_cap('access_settings'));
drop policy if exists reason_templates_manage on reason_templates;
create policy reason_templates_manage on reason_templates for all to authenticated
  using (has_menu_cap('access_settings')) with check (has_menu_cap('access_settings'));

-- PIN hashes: RLS on, no policy at all, and no table privilege either
alter table staff_pos_pins enable row level security;
revoke all on staff_pos_pins from public, anon, authenticated;

-- ── Realtime: every iPad sees a bill close, move or merge ──────────────────
do $$ begin alter publication supabase_realtime add table bills;
exception when duplicate_object then null; end $$;

select 'checkout schema applied' as result;
