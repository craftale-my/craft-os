# POS Phase 1 · Sub-plan 2 — Ordering (tables, bills, counter + QR orders, tickets) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Staff take counter orders on the iPad and customers order from a table QR code; every order lands in one open bill per table, is priced on the server from the real menu, and prints one ticket per print route on the shop's LAN printer through the Phase 0 print agent.

**Architecture:** Real tables replace the Phase 0 `spike_*` tables: `dining_tables`, `bills`, `orders`, `order_items` (with name/price/SST/modifier snapshots), `print_jobs`, `print_routes` (route name → printer per branch) and `branch_menu_status` (per-branch sold-out). All writes to bills/orders/items go through `security definer` RPCs that re-price every line from `menu_variants` and `modifier_options`; the client only sends ids, quantities and notes. The staff POS is a full-screen route `/pos` (tables grid, bill view, order pad, print host); a second Vite entry `qr/` is the customer page (own tiny Supabase client, anon, RPC-only). Counter orders are written to IndexedDB first and sent second (Phase 0 queue), QR orders are sent directly. The Node print agent is re-pointed from `spike_*` to the real tables. Checkout, void, table moves, refunds, supervisor PIN and receipts are **Sub-plan 3**; shifts, Z report and e-Invoice export are **Sub-plan 4**.

**Tech Stack:** React 19 + Vite 6 + TypeScript, Supabase (Postgres, RLS, plpgsql RPC, Realtime), Vitest (`fake-indexeddb` for the queue), Node 22 print agent, `qrcode` (QR images for table cards).

**Spec:** `docs/superpowers/specs/2026-10-22-pos-demo-design.md` (数据模型 · 桌位与账单, 主要流程 · QR 点单 / 柜台点单 / POS 主画面 / 打印 / 断网). Sub-plan 1 (menu): `docs/superpowers/plans/2026-10-22-pos-phase1-menu.md`. Phase 0 results: `docs/superpowers/spikes/2026-10-22-pos-phase0-results.md`.

## Spec deltas (decided while planning, 2026-10-23)

- **Order line shape.** A line is `{ productId, variantId, qty, note, optionIds }`. Sets are products with modifier groups (Sub-plan 1 delta), so there is no `parent_item_id`; a set's choices are the line's modifiers. Each modifier is snapshotted with the add-on product's `print_route`, so a set's cake line can go to Kitchen while the set itself goes to Bar.
- **Ticket lines.** An item prints on its product's `print_route` with its modifiers as `+` sub-lines. A modifier whose add-on product has its own `print_route` that differs from the item's also prints as its own line on that route (`1 x Oat milk` / `for Coffee Latte (COLD)`). Items with no route are not printed.
- **Bill numbers.** `bills.bill_no` is `YYMMDD-NNN` in Malaysia time, counted per branch per day from `bill_counters`. An order's `order_no` is `bill_no/k` (k-th order on the bill) and is what the ticket shows.
- **Takeaway** is a bill with `table_id null`, one bill per counter order. QR orders are always `dine_in`.
- **Availability.** QR shows products with `availability = 'all'`; the counter shows `all` and `counter_only`; `hidden` and add-on items never appear as products. Sold-out is per branch (`branch_menu_status.is_sold_out`) and is toggled from the POS by any staff member.
- **Modifier rules.** Every option sent must belong to a group linked to the product; per group the count must be within `min_select..max_select`; an option can be chosen once (Feedme's `stackable` is ignored for the demo). Option `availability` follows the same QR/counter rule as products.
- **QR entry.** The customer page is a second Vite entry (`qr/index.html`) built with the main app and served at `/t/<token>` by a Vercel rewrite; a separate Vercel project (spec) can come at Phase 2. In the dev server it is `/qr/?t=<token>`. It has its own Supabase client with `persistSession: false` and imports nothing from `src/features` except `src/features/pos/order/cart.ts` (pure).
- **Branch.** The POS uses `staff.branch_id`. A `Demo` branch row is seeded on dev (Task 3) with tables `T1`–`T10` and routes `Bar`/`Kitchen` → agent `192.168.0.8:9100` (the ZY301). No branch UUID is hard-coded anywhere.
- **Print host.** Both the iPad page and the agent subscribe to `print_jobs`; the iPad prints only `epson-epos`/`star-webprnt` routes, the agent only `agent` routes (Phase 0 found the ZY301 only works through the agent). A job stuck in `printing` for more than 2 minutes can be reprinted.
- **Spike removal.** `src/features/pos/spike/`, `spike/pos.html`, `spike/qr.html` and the spike tests are deleted in Task 12; the spike SQL files stay as Phase 0 history and the drop script is run on dev. `assertDevDatabase` moves to `src/features/pos/guard.ts` and keeps refusing prod until Phase 2 decides otherwise.
- **Not in this sub-plan:** checkout, `computeBill` totals (only line totals and a subtotal are shown), void, change table, merge, refund, supervisor PIN, receipts, `branch_pos_settings`, shifts.

## Global Constraints

- **Dev database first.** Every SQL file in this plan is run on `craft-os-dev` (ref `egznnbjmicebbhwasloy`) and verified there; running it on prod (`yfsoesxzurzjdwstszru`) is a separate, later step the user decides. The worktree's `.env.local` points at dev. Menu migrations from Sub-plan 1 are already applied on dev (409 products).
- All UI copy, field names and error messages in English (`english-product-copy` rule); comments may be Chinese or English, matching surrounding files.
- Money is integer sen; SST is basis points (600 = 6%). **Prices are computed on the server**; the client never sends a price.
- `client_order_id` is unique: sending the same order twice creates one order and returns the same id.
- Permission helper is `has_menu_cap(p_cap)` from Sub-plan 1 (mirrors `buildRoleCaps`; `access_settings` = owner/admin/manager unless the Owner overrides). Any signed-in staff member with a `branch_id` may use the POS; tables and printers are managed by `access_settings` holders.
- Every write whose success is shown to a user goes through `writeOutcome` (`src/shared/lib/db-write.ts`) with `.select()`, or is an RPC whose error is thrown.
- Ticket payloads built in SQL must have exactly the shape of `TicketPayload` in `src/features/pos/print/ticket.ts` (Task 5 extends it with `mods`).
- Realtime subscriptions use a unique channel name per subscription (`crypto.randomUUID()`), filter by `branch_id`, and re-sweep on `SUBSCRIBED` and every 15 s (Phase 0 lesson).
- The repo has no ESLint config (pre-existing) — lint steps are skipped; `npx tsc -b` and `npx vitest run` are the gates. `tools/` is not type-checked by `tsc -b`; the agent is checked by running it.
- Every commit ends with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Work in the worktree `/Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo`, branch `feature/pos-demo`.

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migration-2026-10-23-pos-ordering.sql` | Tables `dining_tables`, `print_routes`, `branch_menu_status`, `bill_counters`, `bills`, `orders`, `order_items`, `print_jobs`; RLS; Realtime publication |
| `supabase/migration-2026-10-23-pos-ordering-fn.sql` | RPCs: `pos_insert_order` (internal), `place_counter_order`, `place_table_order`, `qr_menu`, `qr_table_state`, `claim_print_job`, `finish_print_job`, `requeue_print_job`, `insert_test_print` |
| `supabase/migration-2026-10-23-pos-ordering-verify.sql` | Self-check for both files (rolled back) |
| `supabase/seed-2026-10-23-pos-demo-branch.sql` | Dev-only: `Demo` branch, tables T1–T10, routes Bar/Kitchen, test staff → Demo |
| `src/features/pos/guard.ts` | `assertDevDatabase` (moved from `spike/guard.ts`) |
| `src/features/pos/order/cart.ts` | Pure: `OrderLine`, `PosMenu` types, `buildPosMenu`, `linePriceSen`, `validateLine`, `lineLabel`, `cartKey` |
| `src/features/pos/order/posApi.ts` | Supabase calls for the staff POS (menu, tables, bills, orders, print jobs, routes, sold-out, pause) |
| `src/features/pos/order/usePosRealtime.ts` | Hook: subscribe to `orders` / `print_jobs` inserts for the branch, with re-sweep |
| `src/features/pos/order/tableStatus.ts` | Pure: table grid status from bills + new-order marks |
| `src/features/pos/order/PosPage.tsx` | `/pos` shell (full screen): tables grid + bill panel + order pad + print host |
| `src/features/pos/order/TablesGrid.tsx`, `BillPanel.tsx`, `OrderPad.tsx`, `LineSheet.tsx` | POS components |
| `src/features/pos/order/PrintHostPanel.tsx` | Browser print host + failed/stuck jobs banner with reprint (from the spike, re-pointed) |
| `src/features/pos/order/PosSettingsPage.tsx` | `/pos/settings`: tables (add, rename, pause, regenerate QR, QR card), print routes (kind + address), test print |
| `src/features/pos/offline/orderQueue.ts` (+test), `idbStore.ts` | Queue generalised to `OrderLine[]` + `orderType`; db name `craft-pos-v2` |
| `src/features/pos/print/ticket.ts` (+test) | `TicketLine.mods?: string[]` rendered as `  + name` |
| `qr/index.html`, `src/qr/main.tsx`, `src/qr/qrClient.ts`, `src/qr/QrApp.tsx`, `src/qr/qrState.ts` (+test) | Customer page |
| `vite.config.ts`, `vercel.json` | Second entry + `/t/*` rewrite |
| `tools/print-agent/agent.ts`, `.env.example` | Re-pointed to `print_routes` / `print_jobs` / real RPCs |
| `src/App.tsx`, `src/shared/lib/nav.ts`, `src/shared/lib/nav.test.ts` | Routes `/pos`, `/pos/settings`; nav leaf `POS` |
| `package.json` | `qrcode` dependency |

---

### Task 1: Ordering schema, RLS and Realtime

**Files:**
- Create: `supabase/migration-2026-10-23-pos-ordering.sql`

**Interfaces:**
- Consumes: `branches`, `staff`, `menu_products`, `menu_variants`, `has_menu_cap(text)` (Sub-plan 1).
- Produces: the eight tables below with these exact columns; later tasks' SQL and TS select by these names.

- [ ] **Step 1: Write the migration**

```sql
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
  placed_at        timestamptz not null default now(),
  unique (bill_id, order_no)
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

-- ...and the trigger keeps that "any staff" update to label and qr_paused: changing
-- the QR token, branch, active flag or order needs access_settings (Task 10's page)
create or replace function dining_tables_guard() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if (new.qr_token, new.branch_id, new.is_active, new.sort_order)
     is distinct from (old.qr_token, old.branch_id, old.is_active, old.sort_order)
     and not has_menu_cap('access_settings') then
    raise exception 'Only a manager can change this table''s QR code, branch or status';
  end if;
  return new;
end $$;
drop trigger if exists dining_tables_guard on dining_tables;
create trigger dining_tables_guard before update on dining_tables
  for each row execute function dining_tables_guard();
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

-- print jobs: status changes go through the security-invoker RPCs, which need UPDATE —
-- but only of the lifecycle columns, so a client can never rewrite a ticket's content
drop policy if exists print_jobs_update on print_jobs;
create policy print_jobs_update on print_jobs for update to authenticated using (true) with check (true);
revoke update on print_jobs from authenticated;
grant update (status, attempts, last_error, claimed_at, printed_at) on print_jobs to authenticated;

-- ── Realtime ────────────────────────────────────────────────────────────────
do $$ begin alter publication supabase_realtime add table orders;
exception when duplicate_object then null; end $$;
do $$ begin alter publication supabase_realtime add table print_jobs;
exception when duplicate_object then null; end $$;
```

- [ ] **Step 2: Syntax check locally (no database).** Run: `grep -c "create table if not exists" supabase/migration-2026-10-23-pos-ordering.sql` — Expected: `8`. Run: `grep -n "security definer" supabase/migration-2026-10-23-pos-ordering.sql` — Expected: no output (this file has no functions).

- [ ] **Step 3: Commit**

```bash
git add supabase/migration-2026-10-23-pos-ordering.sql
git commit -m "feat(pos-order): dining tables, bills, orders, items, print jobs and routes with RLS

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

The migration is applied to dev by the controller in Task 3 together with the functions.

---

### Task 2: Ordering RPCs — server-side pricing, tickets, QR menu, print-job lifecycle

**Files:**
- Create: `supabase/migration-2026-10-23-pos-ordering-fn.sql`

**Interfaces:**
- Consumes: Task 1 tables; `menu_products`, `menu_variants`, `modifier_groups`, `modifier_options`, `product_modifier_groups`, `menu_categories`, `branch_menu_status`; `has_menu_cap(text)`.
- Produces (called by Tasks 6, 9, 11, 12):
  - `place_counter_order(p_table_id uuid, p_order_type text, p_pax int, p_items jsonb, p_client_order_id uuid) returns uuid` — staff
  - `place_table_order(p_token text, p_pax int, p_items jsonb, p_client_order_id uuid) returns uuid` — anon
  - `qr_menu(p_token text) returns jsonb`, `qr_table_state(p_token text) returns jsonb` — anon
  - `claim_print_job(p_id uuid) returns boolean`, `finish_print_job(p_id uuid, p_ok boolean, p_error text) returns void`, `requeue_print_job(p_id uuid) returns void`, `insert_test_print(p_route text) returns uuid` — staff
  - Item payload (one line): `{ "productId": uuid, "variantId": uuid, "qty": 1..20, "note": string|null, "optionIds": uuid[] }`
  - Ticket payload written to `print_jobs.payload`: `{ kind:'ticket', route, tableLabel, orderNo, source, placedAt, lines:[{ qty, name, note, mods:string[] }] }`

- [ ] **Step 1: Write the functions**

```sql
-- ============================================================================
-- Craft OS — POS Phase 1 · Ordering RPCs (2026-10-23). Run after
-- migration-2026-10-23-pos-ordering.sql. Idempotent.
-- Every price on an order is computed here from the menu; clients send ids only.
-- ============================================================================

-- ── Bill numbers: YYMMDD-NNN per branch per Malaysia day ────────────────────
create or replace function pos_next_bill_no(p_branch_id uuid) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_day date := (now() at time zone 'Asia/Kuala_Lumpur')::date;
  v_n   integer;
begin
  insert into bill_counters(branch_id, day, next_no) values (p_branch_id, v_day, 2)
  on conflict (branch_id, day) do update set next_no = bill_counters.next_no + 1
  returning next_no - 1 into v_n;
  return to_char(v_day, 'YYMMDD') || '-' || lpad(v_n::text, 3, '0');
end $$;
revoke all on function pos_next_bill_no(uuid) from public, anon, authenticated;

-- ── Core: validate, price, write bill/order/items, queue tickets ────────────
create or replace function pos_insert_order(
  p_branch_id uuid, p_table_id uuid, p_order_type text, p_pax integer,
  p_source text, p_placed_by uuid, p_items jsonb, p_client_order_id uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_existing   uuid;
  v_bill_id    uuid;
  v_bill_no    text;
  v_order_id   uuid;
  v_order_no   text;
  v_label      text;
  v_item       jsonb;
  v_opt        text;
  v_prod       menu_products;
  v_var        menu_variants;
  v_opt_row    record;
  v_grp        record;
  v_qty        numeric;
  v_n          integer;
  v_price      integer;
  v_mods       jsonb;
  v_allowed    text[] := case when p_source = 'qr' then array['all'] else array['all', 'counter_only'] end;
begin
  if p_client_order_id is null then
    raise exception 'Order id is missing';
  end if;
  select id into v_existing from orders where client_order_id = p_client_order_id;
  if v_existing is not null then
    return v_existing;                         -- resend: already in
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Order has no items';
  end if;
  if p_order_type not in ('dine_in', 'takeaway') then
    raise exception 'Invalid order type';
  end if;
  if (p_order_type = 'dine_in') <> (p_table_id is not null) then
    raise exception 'Dine-in orders need a table; takeaway orders have none';
  end if;
  if p_pax is not null and (p_pax < 1 or p_pax > 99) then
    raise exception 'Invalid number of guests';
  end if;

  -- ── validate every line before writing anything (bad input is always P0001 = final) ──
  for v_item in select * from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) <> 'object'
       or jsonb_typeof(v_item->'productId') is distinct from 'string'
       or jsonb_typeof(v_item->'variantId') is distinct from 'string'
       or (v_item->>'productId') !~* '^[0-9a-f-]{36}$' or (v_item->>'variantId') !~* '^[0-9a-f-]{36}$' then
      raise exception 'Invalid item';
    end if;
    select * into v_prod from menu_products
     where id = (v_item->>'productId')::uuid and is_active and not is_addon;
    if not found or not (v_prod.availability = any (v_allowed)) then
      raise exception 'Item is not available: %', coalesce(v_prod.name, v_item->>'productId');
    end if;
    if exists (select 1 from branch_menu_status s
                where s.branch_id = p_branch_id and s.product_id = v_prod.id and s.is_sold_out) then
      raise exception 'Sold out: %', v_prod.name;
    end if;
    select * into v_var from menu_variants
     where id = (v_item->>'variantId')::uuid and product_id = v_prod.id and is_active;
    if not found then
      raise exception 'Item is not available: %', v_prod.name;
    end if;
    if v_item->'qty' is not null then
      if jsonb_typeof(v_item->'qty') <> 'number' then raise exception 'Invalid quantity'; end if;
      v_qty := (v_item->'qty')::numeric;
      if v_qty < 1 or v_qty > 20 or v_qty <> trunc(v_qty) then raise exception 'Invalid quantity'; end if;
    end if;
    if v_item->'optionIds' is not null and jsonb_typeof(v_item->'optionIds') <> 'array' then
      raise exception 'Invalid add-ons';
    end if;
    -- each option must belong to a group linked to this product, be orderable here, and appear once
    select count(*), count(distinct x.v) into v_n, v_qty
      from jsonb_array_elements_text(coalesce(v_item->'optionIds', '[]'::jsonb)) as x(v);
    if v_n <> v_qty then raise exception 'Invalid add-ons'; end if;
    for v_opt in select * from jsonb_array_elements_text(coalesce(v_item->'optionIds', '[]'::jsonb)) loop
      if v_opt !~* '^[0-9a-f-]{36}$' then raise exception 'Invalid add-ons'; end if;
      select o.id, o.name, o.availability, o.product_id, g.name as group_name into v_opt_row
        from modifier_options o
        join modifier_groups g on g.id = o.group_id and g.is_active
        join product_modifier_groups pmg on pmg.group_id = g.id and pmg.product_id = v_prod.id
       where o.id = v_opt::uuid;
      if not found then
        raise exception 'Add-on is not available for %', v_prod.name;
      end if;
      if not (v_opt_row.availability = any (v_allowed))
         or exists (select 1 from branch_menu_status s
                     where s.branch_id = p_branch_id and s.product_id = v_opt_row.product_id and s.is_sold_out) then
        raise exception 'Sold out: %', v_opt_row.name;
      end if;
    end loop;
    -- per linked group: min..max
    for v_grp in
      select g.name, g.min_select, g.max_select,
             (select count(*) from modifier_options o
               where o.group_id = g.id
                 and o.id::text in (select * from jsonb_array_elements_text(coalesce(v_item->'optionIds', '[]'::jsonb)))) as chosen
        from product_modifier_groups pmg join modifier_groups g on g.id = pmg.group_id and g.is_active
       where pmg.product_id = v_prod.id
    loop
      if v_grp.chosen < v_grp.min_select then
        raise exception 'Choose at least % for %: %', v_grp.min_select, v_prod.name, v_grp.name;
      end if;
      if v_grp.chosen > v_grp.max_select then
        raise exception 'Choose at most % for %: %', v_grp.max_select, v_prod.name, v_grp.name;
      end if;
    end loop;
  end loop;

  -- ── bill + order share one savepoint: a concurrent resend that wins the
  --    client_order_id race rolls both back, so no orphan bill is left ──
  begin
    if p_table_id is not null then
      select label into v_label from dining_tables
       where id = p_table_id and branch_id = p_branch_id and is_active;
      if not found then raise exception 'Invalid table'; end if;
      select id, bill_no into v_bill_id, v_bill_no from bills
       where table_id = p_table_id and status = 'open';
      if v_bill_id is null then
        v_bill_no := pos_next_bill_no(p_branch_id);
        insert into bills(branch_id, bill_no, table_id, order_type, pax)
        values (p_branch_id, v_bill_no, p_table_id, 'dine_in', p_pax)
        on conflict (table_id) where status = 'open' and table_id is not null do nothing
        returning id into v_bill_id;
        if v_bill_id is null then                 -- lost the race: use the winner's bill
          select id, bill_no into v_bill_id, v_bill_no from bills
           where table_id = p_table_id and status = 'open';
        end if;
      elsif p_pax is not null then
        update bills set pax = p_pax where id = v_bill_id and pax is null;
      end if;
    else
      v_bill_no := pos_next_bill_no(p_branch_id);
      insert into bills(branch_id, bill_no, table_id, order_type, pax)
      values (p_branch_id, v_bill_no, null, 'takeaway', p_pax)
      returning id into v_bill_id;
    end if;

    perform 1 from bills where id = v_bill_id for update;   -- serialise order numbering on this bill
    select count(*) + 1 into v_n from orders where bill_id = v_bill_id;
    v_order_no := v_bill_no || '/' || v_n;
    insert into orders(bill_id, branch_id, order_no, source, placed_by, client_order_id)
    values (v_bill_id, p_branch_id, v_order_no, p_source, p_placed_by, p_client_order_id)
    returning id into v_order_id;
  exception when unique_violation then
    select id into v_order_id from orders where client_order_id = p_client_order_id;
    if v_order_id is not null then return v_order_id; end if;
    raise;
  end;

  -- ── items: snapshot name, price, SST and modifiers from the menu ──
  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from menu_products where id = (v_item->>'productId')::uuid;
    select * into v_var  from menu_variants where id = (v_item->>'variantId')::uuid;
    select coalesce(jsonb_agg(jsonb_build_object(
             'optionId', o.id, 'group', g.name, 'name', o.name,
             'priceDeltaSen', o.price_delta_sen, 'route', ap.print_route)
             order by pmg.sort_order, g.name, o.sort_order, o.name), '[]'::jsonb),
           coalesce(sum(o.price_delta_sen), 0)
      into v_mods, v_price
      from jsonb_array_elements_text(coalesce(v_item->'optionIds', '[]'::jsonb)) as x(v)
      join modifier_options o on o.id = x.v::uuid
      join modifier_groups g on g.id = o.group_id
      join product_modifier_groups pmg on pmg.group_id = g.id and pmg.product_id = v_prod.id
      left join menu_products ap on ap.id = o.product_id;
    insert into order_items(order_id, bill_id, product_id, variant_id, name_snapshot, unit_price_sen,
                            sst_rate_bp, modifiers_snapshot, print_route, qty, note)
    values (v_order_id, v_bill_id, v_prod.id, v_var.id,
            v_prod.name || case when v_var.feedme_variant_key <> '' then ' (' || v_var.name || ')' else '' end,
            v_var.price_sen + v_price, v_prod.sst_rate_bp, v_mods, v_prod.print_route,
            coalesce((v_item->'qty')::numeric::integer, 1), nullif(trim(v_item->>'note'), ''));
  end loop;

  -- ── tickets: one job per route, shaped exactly like TicketPayload (ticket.ts) ──
  insert into print_jobs(branch_id, order_id, route, kind, payload)
  select p_branch_id, v_order_id, l.route, 'ticket', jsonb_build_object(
           'kind', 'ticket', 'route', l.route, 'tableLabel', v_label, 'orderNo', v_order_no,
           'source', p_source,
           'placedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'lines', jsonb_agg(jsonb_build_object('qty', l.qty, 'name', l.name, 'note', l.note, 'mods', l.mods)
                              order by l.kind_order, l.name))
    from (
      -- the item on its own route, modifiers as sub-lines
      select oi.print_route as route, 1 as kind_order, oi.name_snapshot as name, oi.qty, oi.note,
             coalesce((select jsonb_agg(m->>'name' order by ord)
                         from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)), '[]'::jsonb) as mods
        from order_items oi
       where oi.order_id = v_order_id and oi.print_route is not null
      union all
      -- a modifier whose add-on product prints somewhere else gets its own line there
      select m->>'route', 2, m->>'name', oi.qty, 'for ' || oi.name_snapshot, '[]'::jsonb
        from order_items oi cross join jsonb_array_elements(oi.modifiers_snapshot) m
       where oi.order_id = v_order_id and m->>'route' is not null
         and m->>'route' is distinct from oi.print_route
    ) l
   group by l.route;

  return v_order_id;
end $$;
revoke all on function pos_insert_order(uuid, uuid, text, integer, text, uuid, jsonb, uuid) from public, anon, authenticated;

-- ── Staff: counter order ─────────────────────────────────────────────────────
create or replace function place_counter_order(
  p_table_id uuid, p_order_type text, p_pax integer, p_items jsonb, p_client_order_id uuid
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select branch_id into v_branch from staff where id = auth.uid() and is_active;
  if v_branch is null then
    raise exception 'Your account has no branch — ask a manager to set it in Team';
  end if;
  return pos_insert_order(v_branch, p_table_id, p_order_type, p_pax, 'counter', auth.uid(), p_items, p_client_order_id);
end $$;
revoke all on function place_counter_order(uuid, text, integer, jsonb, uuid) from public, anon;
grant execute on function place_counter_order(uuid, text, integer, jsonb, uuid) to authenticated;

-- ── Customer: table QR order (anon) ─────────────────────────────────────────
create or replace function place_table_order(p_token text, p_pax integer, p_items jsonb, p_client_order_id uuid)
returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_table   dining_tables;
  v_recent  integer;
  v_existing uuid;
begin
  select * into v_table from dining_tables where qr_token = p_token;
  if not found then raise exception 'Invalid table code'; end if;
  -- resend of an order that already went in: return it even if the table was paused since
  select id into v_existing from orders where client_order_id = p_client_order_id;
  if v_existing is not null then return v_existing; end if;
  if not v_table.is_active then raise exception 'Invalid table code'; end if;
  if v_table.qr_paused then
    raise exception 'Ordering is paused for this table. Please order at the counter.';
  end if;
  select count(*) into v_recent
    from orders o join bills b on b.id = o.bill_id
   where b.table_id = v_table.id and o.source = 'qr' and o.placed_at > now() - interval '1 minute';
  if v_recent >= 5 then
    raise exception 'Too many orders from this table. Please wait a minute.';
  end if;
  return pos_insert_order(v_table.branch_id, v_table.id, 'dine_in', p_pax, 'qr', null, p_items, p_client_order_id);
end $$;
revoke all on function place_table_order(text, integer, jsonb, uuid) from public;
grant execute on function place_table_order(text, integer, jsonb, uuid) to anon, authenticated;

-- ── Customer: menu for a table (anon). null = invalid token ─────────────────
create or replace function qr_menu(p_token text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'tableLabel', t.label,
    'paused', t.qr_paused,
    'needsPax', not exists (select 1 from bills b where b.table_id = t.id and b.status = 'open' and b.pax is not null),
    'categories', coalesce((
      select jsonb_agg(jsonb_build_object('name', c.name, 'products', c.products) order by c.sort_order, c.name)
      from (
        select mc.name, mc.sort_order,
          jsonb_agg(jsonb_build_object(
            'id', p.id, 'name', p.name, 'description', p.description,
            'soldOut', coalesce(bms.is_sold_out, false),
            'variants', (select jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'priceSen', v.price_sen)
                                          order by v.sort_order, v.name)
                           from menu_variants v where v.product_id = p.id and v.is_active),
            'groups', coalesce((
              select jsonb_agg(jsonb_build_object(
                       'id', g.id, 'name', g.name, 'min', g.min_select, 'max', g.max_select,
                       'options', coalesce((
                         select jsonb_agg(jsonb_build_object(
                                  'id', o.id, 'name', o.name, 'priceDeltaSen', o.price_delta_sen,
                                  'isDefault', o.is_default,
                                  'available', o.availability = 'all' and not coalesce(obs.is_sold_out, false))
                                order by o.sort_order, o.name)
                           from modifier_options o
                           left join branch_menu_status obs on obs.branch_id = t.branch_id and obs.product_id = o.product_id
                          where o.group_id = g.id and o.availability <> 'hidden'), '[]'::jsonb))
                     order by pmg.sort_order, g.name)
                from product_modifier_groups pmg
                join modifier_groups g on g.id = pmg.group_id and g.is_active
               where pmg.product_id = p.id), '[]'::jsonb)
          ) order by p.sort_order, p.name) as products
          from menu_products p
          join menu_categories mc on mc.id = p.category_id and mc.is_active
          left join branch_menu_status bms on bms.branch_id = t.branch_id and bms.product_id = p.id
         where p.is_active and not p.is_addon and p.availability = 'all'
           and exists (select 1 from menu_variants v where v.product_id = p.id and v.is_active)
         group by mc.name, mc.sort_order
      ) c), '[]'::jsonb))
  from dining_tables t
  where t.qr_token = p_token and t.is_active
$$;
revoke all on function qr_menu(text) from public;
grant execute on function qr_menu(text) to anon, authenticated;

-- ── Customer: what this table has ordered so far (anon). null = invalid token ─
create or replace function qr_table_state(p_token text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'tableLabel', t.label,
    'billNo', b.bill_no,
    'pax', b.pax,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'name', oi.name_snapshot, 'qty', oi.qty, 'unitPriceSen', oi.unit_price_sen,
               'mods', (select coalesce(jsonb_agg(m->>'name' order by ord), '[]'::jsonb)
                          from jsonb_array_elements(oi.modifiers_snapshot) with ordinality as x(m, ord)),
               'note', oi.note, 'voided', oi.voided_at is not null, 'placedAt', o.placed_at)
             order by o.placed_at, oi.name_snapshot)
        from order_items oi join orders o on o.id = oi.order_id
       where oi.bill_id = b.id), '[]'::jsonb),
    'subtotalSen', coalesce((select sum(oi.unit_price_sen * oi.qty) from order_items oi
                              where oi.bill_id = b.id and oi.voided_at is null), 0))
  from dining_tables t
  left join bills b on b.table_id = t.id and b.status = 'open'
  where t.qr_token = p_token and t.is_active
$$;
revoke all on function qr_table_state(text) from public;
grant execute on function qr_table_state(text) to anon, authenticated;

-- ── Print job lifecycle (staff; security invoker → needs the print_jobs_update policy) ─
create or replace function claim_print_job(p_id uuid) returns boolean
language plpgsql security invoker as $$
begin
  update print_jobs set status = 'printing', attempts = attempts + 1, claimed_at = now()
   where id = p_id and status = 'pending';
  return found;
end $$;

create or replace function finish_print_job(p_id uuid, p_ok boolean, p_error text) returns void
language plpgsql security invoker as $$
begin
  update print_jobs
     set status     = case when p_ok then 'printed' else 'failed' end,
         printed_at = case when p_ok then now() else null end,
         last_error = case when p_ok then null else p_error end
   where id = p_id and status = 'printing';
end $$;

-- failed jobs, and jobs a host claimed but never finished (crashed mid-print)
create or replace function requeue_print_job(p_id uuid) returns void
language plpgsql security invoker as $$
begin
  update print_jobs set status = 'pending'
   where id = p_id
     and (status = 'failed' or (status = 'printing' and claimed_at < now() - interval '2 minutes'));
end $$;

-- a test ticket for one route of the caller's branch
create or replace function insert_test_print(p_route text) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_branch uuid; v_id uuid;
begin
  if auth.uid() is null then raise exception 'Sign in required'; end if;
  select branch_id into v_branch from staff where id = auth.uid() and is_active;
  if v_branch is null then raise exception 'Your account has no branch'; end if;
  if not exists (select 1 from print_routes where branch_id = v_branch and name = p_route) then
    raise exception 'No printer is set for route %', p_route;
  end if;
  insert into print_jobs(branch_id, route, kind, payload)
  values (v_branch, p_route, 'ticket', jsonb_build_object(
    'kind', 'ticket', 'route', p_route, 'tableLabel', 'TEST', 'orderNo', 'TEST01', 'source', 'test',
    'placedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'lines', jsonb_build_array(jsonb_build_object('qty', 1, 'name', 'Test print — ' || p_route, 'note', null, 'mods', '[]'::jsonb))))
  returning id into v_id;
  return v_id;
end $$;

revoke all on function claim_print_job(uuid), finish_print_job(uuid, boolean, text),
                       requeue_print_job(uuid), insert_test_print(text) from public, anon;
grant execute on function claim_print_job(uuid), finish_print_job(uuid, boolean, text),
                          requeue_print_job(uuid), insert_test_print(text) to authenticated;
```

- [ ] **Step 2: Local sanity checks.** Run: `grep -c "create or replace function" supabase/migration-2026-10-23-pos-ordering-fn.sql` — Expected: `10`. Run: `grep -n "grant execute" supabase/migration-2026-10-23-pos-ordering-fn.sql | grep -c anon` — Expected: `3` (place_table_order, qr_menu, qr_table_state are the only anon-callable functions).

- [ ] **Step 3: Commit**

```bash
git add supabase/migration-2026-10-23-pos-ordering-fn.sql
git commit -m "feat(pos-order): order RPCs price every line on the server and queue one ticket per route

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Verify script, dev seed, and applying everything on craft-os-dev (implementer + controller)

**Files:**
- Create: `supabase/migration-2026-10-23-pos-ordering-verify.sql`
- Create: `supabase/seed-2026-10-23-pos-demo-branch.sql`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces: on dev, a `Demo` branch, tables `T1`–`T10`, routes `Bar` and `Kitchen` (agent, `192.168.0.8:9100`), and the test staff row pointing at the Demo branch. The verify script's expected error messages are the ones Tasks 6 and 11 show to users.

- [ ] **Step 1: Write the verify script** (everything inside `begin … rollback`; success = a result row `VERIFY OK`):

```sql
-- Self-check for the POS ordering migrations. Run on craft-os-dev after both
-- migration files AND the seed. Everything is rolled back. Success = result row "VERIFY OK".
begin;

do $$
declare
  v_owner   uuid := '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';   -- dev test login (owner)
  v_branch  uuid;
  v_table   dining_tables;
  v_cat     uuid;
  v_latte   uuid; v_hot uuid; v_cold uuid;
  v_oat     uuid; v_oat_var uuid;
  v_milk    uuid; v_opt uuid;
  v_order   uuid; v_order2 uuid;
  v_bill    bills;
  v_items   jsonb;
  n         integer;
  r         record;
begin
  -- A1. schema + RLS + policies
  for r in select t from unnest(array['dining_tables','print_routes','branch_menu_status','bill_counters',
                                      'bills','orders','order_items','print_jobs']) as t loop
    if not exists (select 1 from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
                    where ns.nspname = 'public' and c.relname = r.t and c.relrowsecurity) then
      raise exception 'FAIL schema: % missing or RLS off', r.t;
    end if;
    if not exists (select 1 from pg_policies where tablename = r.t and policyname = 'pos_read' and cmd = 'SELECT') then
      raise exception 'FAIL rls: % has no pos_read', r.t;
    end if;
  end loop;
  if exists (select 1 from pg_policies where tablename in ('bills','orders','order_items')
              and cmd in ('INSERT','UPDATE','DELETE','ALL')) then
    raise exception 'FAIL rls: bills/orders/items must be written only by RPCs';
  end if;
  for r in select f from unnest(array['place_table_order(text,integer,jsonb,uuid)','qr_menu(text)','qr_table_state(text)']) as f loop
    if not has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon cannot call %', r.f; end if;
  end loop;
  for r in select f from unnest(array['place_counter_order(uuid,text,integer,jsonb,uuid)','claim_print_job(uuid)',
                                      'pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid)']) as f loop
    if has_function_privilege('anon', r.f, 'execute') then raise exception 'FAIL grants: anon can call %', r.f; end if;
  end loop;
  if has_function_privilege('authenticated', 'pos_insert_order(uuid,uuid,text,integer,text,uuid,jsonb,uuid)', 'execute') then
    raise exception 'FAIL grants: pos_insert_order must be internal';
  end if;
  if has_column_privilege('authenticated', 'print_jobs', 'payload', 'UPDATE')
     or not has_column_privilege('authenticated', 'print_jobs', 'status', 'UPDATE') then
    raise exception 'FAIL grants: print_jobs must be updatable only in its lifecycle columns';
  end if;

  -- A2. fixture: a branch with one table, a product with two variants and a milk group
  insert into branches(name, address) values ('VERIFY', 'verify') returning id into v_branch;
  insert into dining_tables(branch_id, label) values (v_branch, 'V1') returning * into v_table;
  insert into print_routes(branch_id, name, kind, address) values (v_branch, 'Bar', 'agent', '127.0.0.1:9100'), (v_branch, 'Kitchen', 'agent', '127.0.0.1:9101');
  insert into menu_categories(name) values ('VERIFY CAT') returning id into v_cat;
  insert into menu_products(name, category_id, feedme_product_id, print_route, sst_rate_bp)
    values ('Verify Latte', v_cat, 'verify-o-latte', 'Bar', 600) returning id into v_latte;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen, sort_order) values
    (v_latte, 'v/hot', 'HOT', 1200, 0) returning id into v_hot;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen, sort_order) values
    (v_latte, 'v/cold', 'COLD', 1300, 1) returning id into v_cold;
  insert into menu_products(name, category_id, feedme_product_id, is_addon, print_route)
    values ('Verify Oat milk', v_cat, 'verify-o-oat', true, 'Kitchen') returning id into v_oat;
  insert into menu_variants(product_id, feedme_variant_key, name, price_sen) values (v_oat, '', 'Regular', 200) returning id into v_oat_var;
  insert into modifier_groups(feedme_group_id, name, min_select, max_select) values ('verify-o-milk', 'Milk', 0, 1) returning id into v_milk;
  insert into modifier_options(group_id, product_id, name, price_delta_sen) values (v_milk, v_oat, 'Oat milk', 200) returning id into v_opt;
  insert into product_modifier_groups(product_id, group_id) values (v_latte, v_milk);
  update staff set branch_id = v_branch where id = v_owner;

  -- A3. any staff may pause a table, only a settings holder may change its QR token
  insert into auth.users (id) values ('99999999-9999-9999-9999-999999999999');
  insert into staff (id, name, rank, onboarding_completed, joined_at, system_role, branch_id)
  values ('99999999-9999-9999-9999-999999999999', 'verify staff', 'trainee', true, current_date, 'staff', v_branch);
  perform set_config('request.jwt.claims', json_build_object('sub', '99999999-9999-9999-9999-999999999999', 'role', 'authenticated')::text, true);
  update dining_tables set qr_paused = true, label = 'V1' where id = v_table.id;
  begin update dining_tables set qr_token = 'forged' where id = v_table.id; raise exception 'FAIL: staff changed a QR token';
  exception when raise_exception then if sqlerrm not like 'Only a manager%' then raise; end if; end;
  update dining_tables set qr_paused = false where id = v_table.id;

  -- B1. QR menu: table found, product listed with 2 variants and the milk group
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  if qr_menu('no-such-token') is not null then raise exception 'FAIL qr_menu: bad token must be null'; end if;
  if (qr_menu(v_table.qr_token)->>'tableLabel') <> 'V1' then raise exception 'FAIL qr_menu: label'; end if;
  if jsonb_array_length(qr_menu(v_table.qr_token)->'categories'->0->'products'->0->'variants') <> 2 then
    raise exception 'FAIL qr_menu: variants';
  end if;
  if (qr_menu(v_table.qr_token)->>'needsPax')::boolean is not true then raise exception 'FAIL qr_menu: needsPax'; end if;

  -- B2. QR order with a modifier: priced on the server (1300 + 200), tickets on Bar (item) and Kitchen (oat)
  v_items := jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_cold, 'qty', 2,
                                                  'note', ' extra hot ', 'optionIds', jsonb_build_array(v_opt)));
  v_order := place_table_order(v_table.qr_token, 3, v_items, '11111111-1111-1111-1111-111111111111');
  select * into v_bill from bills where table_id = v_table.id and status = 'open';
  if v_bill.pax <> 3 or v_bill.order_type <> 'dine_in' or v_bill.bill_no !~ '^\d{6}-001$' then
    raise exception 'FAIL bill: %', row_to_json(v_bill);
  end if;
  select count(*) into n from order_items where order_id = v_order
     and name_snapshot = 'Verify Latte (COLD)' and unit_price_sen = 1500 and sst_rate_bp = 600
     and qty = 2 and note = 'extra hot' and print_route = 'Bar'
     and modifiers_snapshot->0->>'name' = 'Oat milk' and modifiers_snapshot->0->>'route' = 'Kitchen';
  if n <> 1 then raise exception 'FAIL item snapshot'; end if;
  if (select order_no from orders where id = v_order) <> v_bill.bill_no || '/1' then raise exception 'FAIL order_no'; end if;
  select count(*) into n from print_jobs where order_id = v_order and route = 'Bar'
     and payload->'lines'->0->>'name' = 'Verify Latte (COLD)' and payload->'lines'->0->'mods'->>0 = 'Oat milk'
     and payload->>'orderNo' = v_bill.bill_no || '/1' and payload->>'tableLabel' = 'V1' and payload->>'source' = 'qr';
  if n <> 1 then raise exception 'FAIL bar ticket'; end if;
  select count(*) into n from print_jobs where order_id = v_order and route = 'Kitchen'
     and payload->'lines'->0->>'name' = 'Oat milk' and payload->'lines'->0->>'note' = 'for Verify Latte (COLD)';
  if n <> 1 then raise exception 'FAIL kitchen ticket'; end if;

  -- B3. resend = same order, nothing new
  v_order2 := place_table_order(v_table.qr_token, 3, v_items, '11111111-1111-1111-1111-111111111111');
  if v_order2 <> v_order then raise exception 'FAIL idempotent'; end if;
  select count(*) into n from orders where bill_id = v_bill.id; if n <> 1 then raise exception 'FAIL idempotent: % orders', n; end if;

  -- B4. second order joins the same bill, order_no /2, pax kept
  v_order2 := place_table_order(v_table.qr_token, null, jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), '22222222-2222-2222-2222-222222222222');
  if (select order_no from orders where id = v_order2) <> v_bill.bill_no || '/2' then raise exception 'FAIL second order_no'; end if;
  if (select pax from bills where id = v_bill.id) <> 3 then raise exception 'FAIL pax overwritten'; end if;
  if (qr_table_state(v_table.qr_token)->>'subtotalSen')::int <> 3000 + 1200 then raise exception 'FAIL qr_table_state subtotal'; end if;

  -- B5. rejections
  begin perform place_table_order('nope', null, v_items, gen_random_uuid()); raise exception 'FAIL: bad token accepted';
  exception when raise_exception then if sqlerrm <> 'Invalid table code' then raise; end if; end;
  update dining_tables set qr_paused = true where id = v_table.id;
  begin perform place_table_order(v_table.qr_token, null, v_items, gen_random_uuid()); raise exception 'FAIL: paused accepted';
  exception when raise_exception then if sqlerrm not like 'Ordering is paused%' then raise; end if; end;
  update dining_tables set qr_paused = false where id = v_table.id;
  insert into branch_menu_status(branch_id, product_id, is_sold_out) values (v_branch, v_latte, true);
  begin perform place_table_order(v_table.qr_token, null, v_items, gen_random_uuid()); raise exception 'FAIL: sold out accepted';
  exception when raise_exception then if sqlerrm <> 'Sold out: Verify Latte' then raise; end if; end;
  delete from branch_menu_status where branch_id = v_branch;
  begin perform place_table_order(v_table.qr_token, null, jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_oat_var)), gen_random_uuid()); raise exception 'FAIL: foreign variant accepted';
  exception when raise_exception then if sqlerrm <> 'Item is not available: Verify Latte' then raise; end if; end;
  begin perform place_table_order(v_table.qr_token, null, jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot, 'optionIds', jsonb_build_array(v_opt, v_opt))), gen_random_uuid()); raise exception 'FAIL: duplicate option accepted';
  exception when raise_exception then if sqlerrm <> 'Invalid add-ons' then raise; end if; end;
  update modifier_groups set min_select = 1 where id = v_milk;
  begin perform place_table_order(v_table.qr_token, null, jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid()); raise exception 'FAIL: min_select ignored';
  exception when raise_exception then if sqlerrm <> 'Choose at least 1 for Verify Latte: Milk' then raise; end if; end;
  update modifier_groups set min_select = 0 where id = v_milk;
  update menu_products set availability = 'counter_only' where id = v_latte;
  begin perform place_table_order(v_table.qr_token, null, jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), gen_random_uuid()); raise exception 'FAIL: counter_only sold by QR';
  exception when raise_exception then if sqlerrm <> 'Item is not available: Verify Latte' then raise; end if; end;
  update menu_products set availability = 'all' where id = v_latte;
  begin perform place_table_order(v_table.qr_token, null, '[]'::jsonb, gen_random_uuid()); raise exception 'FAIL: empty accepted';
  exception when raise_exception then if sqlerrm <> 'Order has no items' then raise; end if; end;

  -- B6. rate limit: 5 per minute per table (two are in already)
  for n in 1..3 loop
    perform place_table_order(v_table.qr_token, null, jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot, 'optionIds', jsonb_build_array(v_opt))), gen_random_uuid());
  end loop;
  begin perform place_table_order(v_table.qr_token, null, jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot, 'optionIds', jsonb_build_array(v_opt))), gen_random_uuid()); raise exception 'FAIL: rate limit';
  exception when raise_exception then if sqlerrm not like 'Too many orders%' then raise; end if; end;

  -- C1. counter: takeaway bill, counter_only allowed, placed_by set; no branch → refused
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);
  update menu_products set availability = 'counter_only' where id = v_latte;
  v_order := place_counter_order(null, 'takeaway', null, jsonb_build_array(jsonb_build_object('productId', v_latte, 'variantId', v_hot)), '33333333-3333-3333-3333-333333333333');
  select b.* into v_bill from bills b join orders o on o.bill_id = b.id where o.id = v_order;
  if v_bill.order_type <> 'takeaway' or v_bill.table_id is not null or v_bill.bill_no !~ '^\d{6}-002$' then raise exception 'FAIL takeaway bill: %', row_to_json(v_bill); end if;
  if (select placed_by from orders where id = v_order) <> v_owner then raise exception 'FAIL placed_by'; end if;
  if (select payload->>'tableLabel' from print_jobs where order_id = v_order) is not null then raise exception 'FAIL takeaway ticket label'; end if;
  begin perform place_counter_order(v_table.id, 'takeaway', null, v_items, gen_random_uuid()); raise exception 'FAIL: takeaway with table';
  exception when raise_exception then if sqlerrm not like 'Dine-in orders need a table%' then raise; end if; end;
  update staff set branch_id = null where id = v_owner;
  begin perform place_counter_order(null, 'takeaway', null, v_items, gen_random_uuid()); raise exception 'FAIL: no-branch accepted';
  exception when raise_exception then if sqlerrm not like 'Your account has no branch%' then raise; end if; end;
  update staff set branch_id = v_branch where id = v_owner;

  -- D1. print jobs: claim once, finish, requeue failed and stuck
  select id into v_order from print_jobs where branch_id = v_branch and status = 'pending' limit 1;
  if not claim_print_job(v_order) then raise exception 'FAIL claim'; end if;
  if claim_print_job(v_order) then raise exception 'FAIL double claim'; end if;
  perform finish_print_job(v_order, false, 'Not sent: paper out');
  if (select status from print_jobs where id = v_order) <> 'failed' then raise exception 'FAIL finish'; end if;
  perform requeue_print_job(v_order);
  if (select status from print_jobs where id = v_order) <> 'pending' then raise exception 'FAIL requeue failed'; end if;
  perform claim_print_job(v_order);
  perform requeue_print_job(v_order);
  if (select status from print_jobs where id = v_order) <> 'printing' then raise exception 'FAIL requeue must not touch a fresh claim'; end if;
  update print_jobs set claimed_at = now() - interval '3 minutes' where id = v_order;
  perform requeue_print_job(v_order);
  if (select status from print_jobs where id = v_order) <> 'pending' then raise exception 'FAIL requeue stuck'; end if;
  v_order := insert_test_print('Bar');
  if (select payload->>'orderNo' from print_jobs where id = v_order) <> 'TEST01' then raise exception 'FAIL test print'; end if;
  begin perform insert_test_print('Nowhere'); raise exception 'FAIL: unknown route accepted';
  exception when raise_exception then if sqlerrm not like 'No printer is set%' then raise; end if; end;

  raise notice 'VERIFY OK';
end $$;

select 'VERIFY OK' as result;
rollback;
```

- [ ] **Step 2: Write the dev seed** (dev only — it is not a migration and must never run on prod):

```sql
-- Dev-only seed for the POS demo (craft-os-dev). Re-runnable.
-- Creates the Demo branch, ten tables, the two print routes and points the test login at it.
do $$
declare v_branch uuid;
begin
  select id into v_branch from branches where name = 'Demo';
  if v_branch is null then
    insert into branches(name, address, is_active) values ('Demo', 'Demo outlet (POS pilot)', true) returning id into v_branch;
  end if;
  insert into dining_tables(branch_id, label, sort_order)
  select v_branch, 'T' || n, n from generate_series(1, 10) n
  on conflict (branch_id, label) do nothing;
  insert into print_routes(branch_id, name, kind, address) values
    (v_branch, 'Bar', 'agent', '192.168.0.8:9100'),
    (v_branch, 'Kitchen', 'agent', '192.168.0.8:9100')
  on conflict (branch_id, name) do update set kind = excluded.kind, address = excluded.address;
  update staff set branch_id = v_branch where id = '76cbcf9f-905e-450d-9f5e-1c9e72a9373d';
  raise notice 'Demo branch % ready', v_branch;
end $$;
select b.name, (select count(*) from dining_tables t where t.branch_id = b.id) as tables,
       (select count(*) from print_routes r where r.branch_id = b.id) as routes
  from branches b where b.name = 'Demo';
```

- [ ] **Step 3: Commit the two files**

```bash
git add supabase/migration-2026-10-23-pos-ordering-verify.sql supabase/seed-2026-10-23-pos-demo-branch.sql
git commit -m "test(pos-order): verify script for ordering RPCs; dev seed for the Demo branch

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4 (controller, dashboard of craft-os-dev):** confirm the top bar reads **craft-os-dev** (`egznnbjmicebbhwasloy`), then run in order, each with `cmd+Return` after loading it into the editor via `window.monaco.editor.getModels()[0].setValue(...)`: (1) `migration-2026-10-23-pos-ordering.sql` → "Success. No rows returned"; (2) `migration-2026-10-23-pos-ordering-fn.sql` → same (accept the "Potential issue" dialog: it contains `revoke`); (3) `seed-2026-10-23-pos-demo-branch.sql` → one row `Demo | 10 | 2`; (4) `migration-2026-10-23-pos-ordering-verify.sql` → result row `VERIFY OK`. If (4) fails, fix the function file, re-run (2), re-run (4). Record the outcome in the ledger.

---

### Task 4: Pure order model — `cart.ts`

**Files:**
- Create: `src/features/pos/order/cart.ts`
- Test: `src/features/pos/order/cart.test.ts`

**Interfaces:**
- Consumes: nothing (pure). Mirrors the SQL rules of Task 2 so the client can refuse a bad line before sending it, with the same words.
- Produces (used by Tasks 6, 8, 11):

```ts
export type Availability = 'all' | 'counter_only' | 'hidden'
export type OrderMode = 'counter' | 'qr'
export interface OrderLine { productId: string; variantId: string; qty: number; note: string | null; optionIds: string[] }
export interface PosVariant { id: string; name: string; priceSen: number; isBase: boolean }
export interface PosOption { id: string; name: string; priceDeltaSen: number; isDefault: boolean; available: boolean }
export interface PosGroup { id: string; name: string; min: number; max: number; options: PosOption[] }
export interface PosProduct { id: string; name: string; description: string | null; soldOut: boolean; variants: PosVariant[]; groups: PosGroup[] }
export interface PosCategory { name: string; products: PosProduct[] }
export interface PosMenu { categories: PosCategory[] }
// flat rows (staff POS) → PosMenu
export function buildPosMenu(products: ProductRow[], groups: GroupRow[], links: LinkRow[], soldOut: SoldOutRow[], mode: OrderMode): PosMenu
// qr_menu jsonb → PosMenu
export function posMenuFromQr(json: QrMenuJson): PosMenu
export function findProduct(menu: PosMenu, productId: string): PosProduct | undefined
export function defaultLine(p: PosProduct): OrderLine
export function linePriceSen(p: PosProduct, line: OrderLine): number | null   // null = variant unknown
export function validateLine(p: PosProduct, line: OrderLine): string | null   // null = ok; else the server's message
export function lineLabel(p: PosProduct, line: OrderLine): { name: string; mods: string[] }
export function cartSubtotalSen(menu: PosMenu, lines: OrderLine[]): number
export function cartKey(lines: OrderLine[]): string
export function formatSen(sen: number): string   // 1250 → "RM 12.50"
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/features/pos/order/cart.test.ts
import { describe, it, expect } from 'vitest'
import {
  buildPosMenu, posMenuFromQr, defaultLine, linePriceSen, validateLine, lineLabel, cartSubtotalSen, cartKey, formatSen,
  type ProductRow, type GroupRow, type LinkRow,
} from './cart'

const latte: ProductRow = {
  id: 'p-latte', name: 'Coffee Latte ', description: null, availability: 'all', is_addon: false, is_active: true, sort_order: 2,
  category: { name: 'MILK COFFEE', sort_order: 1 },
  menu_variants: [
    { id: 'v-cold', name: 'COLD', price_sen: 1400, is_active: true, sort_order: 1, feedme_variant_key: 'v/cold' },
    { id: 'v-hot', name: 'HOT', price_sen: 1200, is_active: true, sort_order: 0, feedme_variant_key: 'v/hot' },
    { id: 'v-old', name: 'OLD', price_sen: 1, is_active: false, sort_order: 9, feedme_variant_key: 'v/old' },
  ],
}
const water: ProductRow = {
  id: 'p-water', name: 'Sky Juice', description: null, availability: 'counter_only', is_addon: false, is_active: true, sort_order: 0,
  category: { name: 'TEA', sort_order: 2 },
  menu_variants: [{ id: 'v-water', name: 'Sky Juice', price_sen: 100, is_active: true, sort_order: 0, feedme_variant_key: '' }],
}
const oat: ProductRow = { ...water, id: 'p-oat', name: 'Oat milk', is_addon: true, availability: 'all', menu_variants: [] }
const hidden: ProductRow = { ...water, id: 'p-hidden', name: 'Secret', availability: 'hidden' }
const milk: GroupRow = {
  id: 'g-milk', name: 'Milk', min_select: 0, max_select: 1, is_active: true, sort_order: 0,
  modifier_options: [
    { id: 'o-oat', name: 'Oat milk', price_delta_sen: 200, is_default: false, availability: 'all', sort_order: 1, product_id: 'p-oat' },
    { id: 'o-full', name: 'Full cream', price_delta_sen: 0, is_default: true, availability: 'all', sort_order: 0, product_id: null },
    { id: 'o-secret', name: 'Hidden', price_delta_sen: 0, is_default: false, availability: 'hidden', sort_order: 2, product_id: null },
  ],
}
const links: LinkRow[] = [{ product_id: 'p-latte', group_id: 'g-milk', sort_order: 0 }]

describe('buildPosMenu', () => {
  it('groups by category in sort order, hides add-ons, hidden and variant-less products', () => {
    const m = buildPosMenu([water, latte, oat, hidden], [milk], links, [], 'counter')
    expect(m.categories.map((c) => c.name)).toEqual(['MILK COFFEE', 'TEA'])
    expect(m.categories[1].products.map((p) => p.name)).toEqual(['Sky Juice'])
    const p = m.categories[0].products[0]
    expect(p.name).toBe('Coffee Latte')                       // trimmed
    expect(p.variants.map((v) => v.name)).toEqual(['HOT', 'COLD'])  // active only, by sort_order
    expect(p.groups[0].options.map((o) => o.name)).toEqual(['Full cream', 'Oat milk'])  // hidden option dropped
  })

  it('qr mode drops counter_only products and marks sold-out products and options', () => {
    const m = buildPosMenu([water, latte, oat], [milk], links, [{ product_id: 'p-oat', is_sold_out: true }], 'qr')
    expect(m.categories.map((c) => c.name)).toEqual(['MILK COFFEE'])
    const p = m.categories[0].products[0]
    expect(p.soldOut).toBe(false)
    expect(p.groups[0].options.find((o) => o.id === 'o-oat')?.available).toBe(false)
  })
})

describe('lines', () => {
  const menu = buildPosMenu([latte], [milk], links, [], 'counter')
  const p = menu.categories[0].products[0]

  it('defaultLine picks the first variant and the default options', () => {
    expect(defaultLine(p)).toEqual({ productId: 'p-latte', variantId: 'v-hot', qty: 1, note: null, optionIds: ['o-full'] })
  })

  it('prices variant + modifiers', () => {
    expect(linePriceSen(p, { ...defaultLine(p), variantId: 'v-cold', optionIds: ['o-oat'] })).toBe(1600)
    expect(linePriceSen(p, { ...defaultLine(p), variantId: 'v-nope' })).toBeNull()
  })

  it('validates with the server’s words', () => {
    const ok = defaultLine(p)
    expect(validateLine(p, ok)).toBeNull()
    expect(validateLine(p, { ...ok, optionIds: ['o-oat', 'o-oat'] })).toBe('Invalid add-ons')
    expect(validateLine(p, { ...ok, optionIds: ['o-oat', 'o-full'] })).toBe('Choose at most 1 for Coffee Latte: Milk')
    expect(validateLine({ ...p, groups: [{ ...p.groups[0], min: 1 }] }, { ...ok, optionIds: [] })).toBe('Choose at least 1 for Coffee Latte: Milk')
    expect(validateLine(p, { ...ok, optionIds: ['o-nope'] })).toBe('Add-on is not available for Coffee Latte')
    expect(validateLine(p, { ...ok, qty: 21 })).toBe('Invalid quantity')
    expect(validateLine({ ...p, soldOut: true }, ok)).toBe('Sold out: Coffee Latte')
  })

  it('labels like the server snapshot', () => {
    expect(lineLabel(p, { ...defaultLine(p), variantId: 'v-cold', optionIds: ['o-oat'] })).toEqual({ name: 'Coffee Latte (COLD)', mods: ['Oat milk'] })
    const single = buildPosMenu([water], [], [], [], 'counter').categories[0].products[0]
    expect(lineLabel(single, defaultLine(single)).name).toBe('Sky Juice')   // base variant: no suffix
  })

  it('subtotal and a stable key', () => {
    const lines = [{ ...defaultLine(p), qty: 2 }, { ...defaultLine(p), variantId: 'v-cold', optionIds: ['o-oat'] }]
    expect(cartSubtotalSen(menu, lines)).toBe(2400 + 1600)
    expect(cartKey(lines)).toBe(cartKey([...lines].map((l) => ({ ...l, optionIds: [...l.optionIds] }))))
    expect(cartKey(lines)).not.toBe(cartKey(lines.slice(1)))
  })

  it('formats sen as ringgit', () => {
    expect(formatSen(1250)).toBe('RM 12.50')
    expect(formatSen(0)).toBe('RM 0.00')
  })
})

describe('posMenuFromQr', () => {
  it('maps the qr_menu json', () => {
    const m = posMenuFromQr({
      tableLabel: 'T1', paused: false, needsPax: true,
      categories: [{ name: 'TEA', products: [{ id: 'p', name: 'Tea', description: null, soldOut: true,
        variants: [{ id: 'v', name: 'HOT', priceSen: 1000 }],
        groups: [{ id: 'g', name: 'Sugar', min: 1, max: 1, options: [{ id: 'o', name: 'Less', priceDeltaSen: 0, isDefault: true, available: true }] }] }] }],
    })
    const p = m.categories[0].products[0]
    expect(p.soldOut).toBe(true)
    expect(p.variants[0].isBase).toBe(true)      // single variant = base
    expect(defaultLine(p).optionIds).toEqual(['o'])
  })
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run src/features/pos/order/cart.test.ts` — Expected: FAIL, "Failed to resolve import './cart'".

- [ ] **Step 3: Write `cart.ts`**

```ts
// src/features/pos/order/cart.ts
/** Pure order model shared by the staff POS and the customer QR page. The
 *  rules here mirror pos_insert_order (migration-2026-10-23-pos-ordering-fn.sql)
 *  so a line the client accepts is one the server accepts, with the same words.
 *  Prices here are a preview only — the server re-prices every line. */

export type Availability = 'all' | 'counter_only' | 'hidden'
export type OrderMode = 'counter' | 'qr'

export interface OrderLine {
  productId: string
  variantId: string
  qty: number
  note: string | null
  optionIds: string[]
}

export interface PosVariant { id: string; name: string; priceSen: number; isBase: boolean }
export interface PosOption { id: string; name: string; priceDeltaSen: number; isDefault: boolean; available: boolean }
export interface PosGroup { id: string; name: string; min: number; max: number; options: PosOption[] }
export interface PosProduct {
  id: string
  name: string
  description: string | null
  soldOut: boolean
  variants: PosVariant[]
  groups: PosGroup[]
}
export interface PosCategory { name: string; products: PosProduct[] }
export interface PosMenu { categories: PosCategory[] }

// ── flat rows as posApi.fetchPosMenu returns them ──────────────────────────
export interface ProductRow {
  id: string
  name: string
  description: string | null
  availability: Availability
  is_addon: boolean
  is_active: boolean
  sort_order: number
  category: { name: string; sort_order: number } | null
  menu_variants: { id: string; name: string; price_sen: number; is_active: boolean; sort_order: number; feedme_variant_key: string }[]
}
export interface GroupRow {
  id: string
  name: string
  min_select: number
  max_select: number
  is_active: boolean
  sort_order: number
  modifier_options: { id: string; name: string; price_delta_sen: number; is_default: boolean; availability: Availability; sort_order: number; product_id: string | null }[]
}
export interface LinkRow { product_id: string; group_id: string; sort_order: number }
export interface SoldOutRow { product_id: string; is_sold_out: boolean }

const allowed = (mode: OrderMode, a: Availability) => a === 'all' || (mode === 'counter' && a === 'counter_only')
const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name)
const bySort = <T extends { sort_order: number; name: string }>(a: T, b: T) => a.sort_order - b.sort_order || byName(a, b)

export function buildPosMenu(
  products: ProductRow[], groups: GroupRow[], links: LinkRow[], soldOut: SoldOutRow[], mode: OrderMode,
): PosMenu {
  const soldOutIds = new Set(soldOut.filter((s) => s.is_sold_out).map((s) => s.product_id))
  const groupById = new Map(groups.filter((g) => g.is_active).map((g) => [g.id, g]))
  const linksByProduct = new Map<string, LinkRow[]>()
  for (const l of links) linksByProduct.set(l.product_id, [...(linksByProduct.get(l.product_id) ?? []), l])

  const cats = new Map<string, { sort: number; products: PosProduct[] }>()
  for (const row of products) {
    if (!row.is_active || row.is_addon || !allowed(mode, row.availability)) continue
    const variants = row.menu_variants.filter((v) => v.is_active).sort(bySort)
    if (variants.length === 0) continue
    const posGroups: PosGroup[] = (linksByProduct.get(row.id) ?? [])
      .sort((a, b) => a.sort_order - b.sort_order)
      .flatMap((l) => {
        const g = groupById.get(l.group_id)
        if (!g) return []
        return [{
          id: g.id, name: g.name, min: g.min_select, max: g.max_select,
          options: g.modifier_options
            .filter((o) => o.availability !== 'hidden')
            .sort(bySort)
            .map((o) => ({
              id: o.id, name: o.name.trim(), priceDeltaSen: o.price_delta_sen, isDefault: o.is_default,
              available: allowed(mode, o.availability) && !(o.product_id !== null && soldOutIds.has(o.product_id)),
            })),
        }]
      })
    const product: PosProduct = {
      id: row.id, name: row.name.trim(), description: row.description, soldOut: soldOutIds.has(row.id),
      variants: variants.map((v) => ({ id: v.id, name: v.name.trim(), priceSen: v.price_sen, isBase: v.feedme_variant_key === '' })),
      groups: posGroups,
    }
    const catName = row.category?.name ?? 'Uncategorised'
    const cat = cats.get(catName) ?? { sort: row.category?.sort_order ?? 9999, products: [] }
    cat.products.push(product)
    cats.set(catName, cat)
  }
  // keep the row order inside a category (products come sorted from posApi), categories by sort then name
  return {
    categories: [...cats.entries()]
      .sort((a, b) => a[1].sort - b[1].sort || a[0].localeCompare(b[0]))
      .map(([name, c]) => ({ name, products: c.products })),
  }
}

// ── qr_menu jsonb (Task 2) → PosMenu ───────────────────────────────────────
export interface QrMenuJson {
  tableLabel: string
  paused: boolean
  needsPax: boolean
  categories: {
    name: string
    products: {
      id: string; name: string; description: string | null; soldOut: boolean
      variants: { id: string; name: string; priceSen: number }[]
      groups: { id: string; name: string; min: number; max: number
        options: { id: string; name: string; priceDeltaSen: number; isDefault: boolean; available: boolean }[] }[]
    }[]
  }[]
}

export function posMenuFromQr(json: QrMenuJson): PosMenu {
  return {
    categories: json.categories.map((c) => ({
      name: c.name,
      products: c.products.map((p) => ({
        id: p.id, name: p.name.trim(), description: p.description, soldOut: p.soldOut,
        variants: p.variants.map((v) => ({ id: v.id, name: v.name.trim(), priceSen: v.priceSen, isBase: p.variants.length === 1 })),
        groups: p.groups.map((g) => ({ id: g.id, name: g.name, min: g.min, max: g.max,
          options: g.options.map((o) => ({ ...o, name: o.name.trim() })) })),
      })),
    })),
  }
}

// ── lines ───────────────────────────────────────────────────────────────────
export function findProduct(menu: PosMenu, productId: string): PosProduct | undefined {
  for (const c of menu.categories) for (const p of c.products) if (p.id === productId) return p
  return undefined
}

export function defaultLine(p: PosProduct): OrderLine {
  return {
    productId: p.id,
    variantId: p.variants[0]?.id ?? '',
    qty: 1,
    note: null,
    optionIds: p.groups.flatMap((g) => g.options.filter((o) => o.isDefault && o.available).slice(0, g.max).map((o) => o.id)),
  }
}

function optionsOf(p: PosProduct): Map<string, { option: PosOption; group: PosGroup }> {
  const m = new Map<string, { option: PosOption; group: PosGroup }>()
  for (const group of p.groups) for (const option of group.options) m.set(option.id, { option, group })
  return m
}

export function linePriceSen(p: PosProduct, line: OrderLine): number | null {
  const variant = p.variants.find((v) => v.id === line.variantId)
  if (!variant) return null
  const opts = optionsOf(p)
  let delta = 0
  for (const id of line.optionIds) delta += opts.get(id)?.option.priceDeltaSen ?? 0
  return variant.priceSen + delta
}

/** Same checks and messages as pos_insert_order, so the user hears it before sending. */
export function validateLine(p: PosProduct, line: OrderLine): string | null {
  if (p.soldOut) return `Sold out: ${p.name}`
  if (!p.variants.some((v) => v.id === line.variantId)) return `Item is not available: ${p.name}`
  if (!Number.isInteger(line.qty) || line.qty < 1 || line.qty > 20) return 'Invalid quantity'
  if (new Set(line.optionIds).size !== line.optionIds.length) return 'Invalid add-ons'
  const opts = optionsOf(p)
  for (const id of line.optionIds) {
    const hit = opts.get(id)
    if (!hit) return `Add-on is not available for ${p.name}`
    if (!hit.option.available) return `Sold out: ${hit.option.name}`
  }
  for (const g of p.groups) {
    const chosen = line.optionIds.filter((id) => opts.get(id)?.group.id === g.id).length
    if (chosen < g.min) return `Choose at least ${g.min} for ${p.name}: ${g.name}`
    if (chosen > g.max) return `Choose at most ${g.max} for ${p.name}: ${g.name}`
  }
  return null
}

export function lineLabel(p: PosProduct, line: OrderLine): { name: string; mods: string[] } {
  const variant = p.variants.find((v) => v.id === line.variantId)
  const opts = optionsOf(p)
  return {
    name: variant && !variant.isBase ? `${p.name} (${variant.name})` : p.name,
    mods: line.optionIds.map((id) => opts.get(id)?.option.name).filter((n): n is string => !!n),
  }
}

export function cartSubtotalSen(menu: PosMenu, lines: OrderLine[]): number {
  let total = 0
  for (const line of lines) {
    const p = findProduct(menu, line.productId)
    const unit = p ? linePriceSen(p, line) : null
    if (unit !== null) total += unit * line.qty
  }
  return total
}

/** Stable identity of a cart: the same lines in the same order give the same key,
 *  which is what the QR page keys its client_order_id on. */
export function cartKey(lines: OrderLine[]): string {
  return JSON.stringify(lines.map((l) => [l.productId, l.variantId, l.qty, l.note ?? '', [...l.optionIds].sort()]))
}

export function formatSen(sen: number): string {
  return `RM ${(sen / 100).toFixed(2)}`
}
```

- [ ] **Step 4: Run the tests.** Run: `npx vitest run src/features/pos/order/cart.test.ts` — Expected: PASS (9 tests). Then `npx tsc -b` — Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/order/cart.ts src/features/pos/order/cart.test.ts
git commit -m "feat(pos-order): pure order model — menu shaping, line pricing preview and the server's validation words

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Tickets show modifiers

**Files:**
- Modify: `src/features/pos/print/ticket.ts:3-7` (interface), `:52-67` (render)
- Test: `src/features/pos/print/ticket.test.ts`

**Interfaces:**
- Produces: `TicketLine.mods?: string[]` (optional, so the Phase 0 payload shape and tests still pass). Rendered as `    + <mod>` lines right after the item line, before the note.

- [ ] **Step 1: Add the failing test** to the existing `describe('renderTicketLines', …)` block in `ticket.test.ts` (append inside it):

```ts
  it('prints modifiers as + lines under the item, before the note', () => {
    const t: TicketPayload = {
      kind: 'ticket', route: 'Bar', tableLabel: 'T3', orderNo: '261023-004/2', source: 'qr',
      placedAt: '2026-10-23T02:00:00.000Z',
      lines: [{ qty: 2, name: 'Coffee Latte (COLD)', note: 'less ice', mods: ['Oat milk', 'Extra shot'] }],
    }
    const out = renderTicketLines(t, 32)
    expect(out.slice(5, 9)).toEqual([
      '2 x Coffee Latte (COLD)',
      '    + Oat milk',
      '    + Extra shot',
      '    * less ice',
    ])
  })
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run src/features/pos/print/ticket.test.ts` — Expected: FAIL (the `+` lines are missing; also a type error on `mods`).

- [ ] **Step 3: Implement**

In `ticket.ts` change the interface:

```ts
export interface TicketLine {
  qty: number
  name: string
  note: string | null
  mods?: string[] // modifier names, e.g. ["Oat milk"]; absent on Phase 0 payloads
}
```

and the body in `renderTicketLines`:

```ts
  const body = t.lines.flatMap((l) => [
    ...wrap(`${l.qty} x ${l.name}`, cols, '    '),
    ...(l.mods ?? []).flatMap((m) => wrap(`+ ${m}`, cols - 4, '  ').map((s) => `    ${s}`)),
    ...(l.note ? wrap(`* ${l.note}`, cols - 4, '  ').map((s) => `    ${s}`) : []),
  ])
```

- [ ] **Step 4: Run the tests.** Run: `npx vitest run src/features/pos/print` — Expected: PASS (all print tests, including the old ones without `mods`).

- [ ] **Step 5: Commit**

```bash
git add src/features/pos/print/ticket.ts src/features/pos/print/ticket.test.ts
git commit -m "feat(pos-print): tickets list modifiers under the item

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Offline queue on real order lines, and the POS API

**Files:**
- Modify: `src/features/pos/offline/orderQueue.ts:6-45`, `src/features/pos/offline/orderQueue.test.ts`, `src/features/pos/offline/idbStore.ts:45`
- Create: `src/features/pos/order/posApi.ts`

**Interfaces:**
- Consumes: `OrderLine` (Task 4), RPC names (Task 2), `PrintJob`/`PrintRoute` (Phase 0).
- Produces:

```ts
// orderQueue.ts
export type OrderType = 'dine_in' | 'takeaway'
export interface QueuedOrder { clientOrderId: string; orderType: OrderType; tableId: string | null; pax: number | null; items: OrderLine[]; queuedAt: number; failedReason: string | null }
export function newQueuedOrder(orderType: OrderType, tableId: string | null, pax: number | null, items: OrderLine[], now?: number, id?: string): QueuedOrder
// idbStore.ts: createIdbStore(dbName = 'craft-pos-v2')
// posApi.ts
export interface TableRow { id: string; label: string; qr_token: string; qr_paused: boolean; is_active: boolean; sort_order: number }
export interface OpenBillRow { id: string; bill_no: string; table_id: string | null; order_type: OrderType; pax: number | null; opened_at: string }
export interface BillItemRow { id: string; order_id: string; name_snapshot: string; unit_price_sen: number; qty: number; note: string | null; modifiers_snapshot: { name: string }[]; voided_at: string | null; orders: { order_no: string; source: 'counter' | 'qr'; placed_at: string } }
export interface PrintJobRow extends PrintJob { branch_id: string; attempts: number; last_error: string | null; claimed_at: string | null; created_at: string }
export async function fetchPosMenu(branchId: string): Promise<PosMenu>
export async function fetchTables(branchId: string): Promise<TableRow[]>
export async function fetchOpenBills(branchId: string): Promise<OpenBillRow[]>
export async function fetchBillItems(billId: string): Promise<BillItemRow[]>
export async function sendCounterOrder(o: QueuedOrder): Promise<SendResult>
export async function setSoldOut(branchId: string, productId: string, soldOut: boolean): Promise<void>
export async function setTablePaused(tableId: string, paused: boolean): Promise<void>
export async function fetchRoutes(branchId: string): Promise<PrintRoute[]>
export async function fetchPrintJobs(branchId: string, statuses: string[]): Promise<PrintJobRow[]>
export async function claimJob(id: string): Promise<boolean>
export async function finishJob(id: string, ok: boolean, err: string | null): Promise<void>
export async function requeueJob(id: string): Promise<void>
export async function insertTestPrint(route: string): Promise<void>
```

- [ ] **Step 1: Update the queue tests.** In `orderQueue.test.ts` replace the line fixture and every `newQueuedOrder(null, [line], …)` call:

```ts
const line = { productId: 'p1', variantId: 'v1', qty: 1, note: null, optionIds: [] }
// every call becomes: newQueuedOrder('takeaway', null, null, [line], <now>, '<id>')
```

Add one test:

```ts
  it('carries order type, table and pax to the sender', async () => {
    const store = memoryStore()
    await enqueue(store, newQueuedOrder('dine_in', 't-5', 2, [line], 1, 'a'))
    const seen: QueuedOrder[] = []
    await flushQueue(store, async (o) => { seen.push(o); return { ok: true } })
    expect(seen[0]).toMatchObject({ orderType: 'dine_in', tableId: 't-5', pax: 2, items: [line] })
  })
```

(`memoryStore` is the in-memory `QueueStore` the file already defines for its tests; import `QueuedOrder` as a type.)

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run src/features/pos/offline` — Expected: FAIL (type errors / wrong arity).

- [ ] **Step 3: Generalise the queue.** In `orderQueue.ts` replace lines 6–45 with:

```ts
import type { OrderLine } from '../order/cart'

export type OrderType = 'dine_in' | 'takeaway'

export interface QueuedOrder {
  clientOrderId: string
  orderType: OrderType
  tableId: string | null // null = takeaway
  pax: number | null
  items: OrderLine[]
  queuedAt: number
  failedReason: string | null // set when the server rejected it; never resent automatically
}

export interface QueueStore {
  put(o: QueuedOrder): Promise<void>
  all(): Promise<QueuedOrder[]>
  remove(clientOrderId: string): Promise<void>
}

export type SendResult = { ok: true } | { ok: false; retryable: boolean; reason: string }
export type Sender = (o: QueuedOrder) => Promise<SendResult>

export interface FlushReport {
  sent: number
  pending: number
  stuck: number
  /** Reason of the retryable failure that stopped this flush; null if none did. */
  lastError: string | null
}

export function newQueuedOrder(
  orderType: OrderType,
  tableId: string | null,
  pax: number | null,
  items: OrderLine[],
  now: number = Date.now(),
  id: string = crypto.randomUUID(),
): QueuedOrder {
  return {
    clientOrderId: id, orderType, tableId, pax,
    items: items.map((l) => ({ ...l, optionIds: [...l.optionIds] })),
    queuedAt: now, failedReason: null,
  }
}
```

(`enqueue`, `flushQueue`, `FINAL_ERROR_CODES`, `toSendResult` stay as they are.) In `idbStore.ts` change the default: `export function createIdbStore(dbName = 'craft-pos-v2'): QueueStore {` — the Phase 0 `craft-pos` database holds spike-shaped orders and is left alone.

- [ ] **Step 4: Run the tests.** Run: `npx vitest run src/features/pos/offline` — Expected: PASS.

- [ ] **Step 5: Write `posApi.ts`**

```ts
// src/features/pos/order/posApi.ts
import { supabase } from '../../../shared/lib/supabase'
import { writeOutcome } from '../../../shared/lib/db-write'
import type { PrintJob } from '../print/printHost'
import type { PrintRoute } from '../print/adapter'
import { toSendResult, type QueuedOrder, type SendResult, type OrderType } from '../offline/orderQueue'
import { buildPosMenu, type GroupRow, type LinkRow, type PosMenu, type ProductRow, type SoldOutRow } from './cart'

const SEND_TIMEOUT_MS = 8000

function fail(error: { message: string } | null): never {
  throw new Error(error?.message ?? 'Unknown error')
}

export interface TableRow { id: string; label: string; qr_token: string; qr_paused: boolean; is_active: boolean; sort_order: number }
export interface OpenBillRow { id: string; bill_no: string; table_id: string | null; order_type: OrderType; pax: number | null; opened_at: string }
export interface BillItemRow {
  id: string
  order_id: string
  name_snapshot: string
  unit_price_sen: number
  qty: number
  note: string | null
  modifiers_snapshot: { name: string }[]
  voided_at: string | null
  orders: { order_no: string; source: 'counter' | 'qr'; placed_at: string }
}
export interface PrintJobRow extends PrintJob {
  branch_id: string
  attempts: number
  last_error: string | null
  claimed_at: string | null
  created_at: string
}

/** Three flat reads (RLS menu_read) shaped by the pure builder. */
export async function fetchPosMenu(branchId: string): Promise<PosMenu> {
  const [p, g, l, s] = await Promise.all([
    supabase.from('menu_products')
      .select('id, name, description, availability, is_addon, is_active, sort_order, category:menu_categories(name, sort_order), ' +
              'menu_variants(id, name, price_sen, is_active, sort_order, feedme_variant_key)')
      .eq('is_active', true).order('sort_order').order('name'),
    supabase.from('modifier_groups')
      .select('id, name, min_select, max_select, is_active, sort_order, ' +
              'modifier_options(id, name, price_delta_sen, is_default, availability, sort_order, product_id)'),
    supabase.from('product_modifier_groups').select('product_id, group_id, sort_order'),
    supabase.from('branch_menu_status').select('product_id, is_sold_out').eq('branch_id', branchId),
  ])
  if (p.error) fail(p.error)
  if (g.error) fail(g.error)
  if (l.error) fail(l.error)
  if (s.error) fail(s.error)
  return buildPosMenu(
    (p.data ?? []) as unknown as ProductRow[], (g.data ?? []) as unknown as GroupRow[],
    (l.data ?? []) as LinkRow[], (s.data ?? []) as SoldOutRow[], 'counter',
  )
}

export async function fetchTables(branchId: string): Promise<TableRow[]> {
  const { data, error } = await supabase.from('dining_tables')
    .select('id, label, qr_token, qr_paused, is_active, sort_order')
    .eq('branch_id', branchId).eq('is_active', true).order('sort_order').order('label')
  if (error) fail(error)
  return data ?? []
}

export async function fetchOpenBills(branchId: string): Promise<OpenBillRow[]> {
  const { data, error } = await supabase.from('bills')
    .select('id, bill_no, table_id, order_type, pax, opened_at')
    .eq('branch_id', branchId).eq('status', 'open').order('opened_at')
  if (error) fail(error)
  return (data ?? []) as OpenBillRow[]
}

export async function fetchBillItems(billId: string): Promise<BillItemRow[]> {
  const { data, error } = await supabase.from('order_items')
    .select('id, order_id, name_snapshot, unit_price_sen, qty, note, modifiers_snapshot, voided_at, orders!inner(order_no, source, placed_at)')
    .eq('bill_id', billId)
  if (error) fail(error)
  return ((data ?? []) as unknown as BillItemRow[])
    .sort((a, b) => a.orders.placed_at.localeCompare(b.orders.placed_at) || a.name_snapshot.localeCompare(b.name_snapshot))
}

/** The queue's sender: a thrown/timed-out call is retryable, a Postgres rejection is final. */
export async function sendCounterOrder(o: QueuedOrder): Promise<SendResult> {
  try {
    const { error } = await supabase
      .rpc('place_counter_order', {
        p_table_id: o.tableId, p_order_type: o.orderType, p_pax: o.pax, p_items: o.items, p_client_order_id: o.clientOrderId,
      })
      .abortSignal(AbortSignal.timeout(SEND_TIMEOUT_MS))
    return toSendResult(error)
  } catch (e) {
    return { ok: false, retryable: true, reason: e instanceof Error ? e.message : String(e) }
  }
}

export async function setSoldOut(branchId: string, productId: string, soldOut: boolean): Promise<void> {
  const res = await supabase.from('branch_menu_status')
    .upsert({ branch_id: branchId, product_id: productId, is_sold_out: soldOut, updated_at: new Date().toISOString() })
    .select('product_id')
  const out = writeOutcome(res)
  if (!out.ok) throw new Error(`Sold-out change failed: ${out.reason}`)
}

export async function setTablePaused(tableId: string, paused: boolean): Promise<void> {
  const res = await supabase.from('dining_tables').update({ qr_paused: paused }).eq('id', tableId).select('id')
  const out = writeOutcome(res)
  if (!out.ok) throw new Error(`Table change failed: ${out.reason}`)
}

export async function fetchRoutes(branchId: string): Promise<PrintRoute[]> {
  const { data, error } = await supabase.from('print_routes').select('name, kind, address').eq('branch_id', branchId).order('name')
  if (error) fail(error)
  return (data ?? []).map((r) => ({ route: r.name, kind: r.kind as PrintRoute['kind'], address: r.address }))
}

export async function fetchPrintJobs(branchId: string, statuses: string[]): Promise<PrintJobRow[]> {
  const { data, error } = await supabase.from('print_jobs')
    .select('id, branch_id, route, payload, status, attempts, last_error, claimed_at, created_at')
    .eq('branch_id', branchId).in('status', statuses).order('created_at')
  if (error) fail(error)
  return (data ?? []) as unknown as PrintJobRow[]
}

export async function claimJob(id: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('claim_print_job', { p_id: id })
  if (error) fail(error)
  return data === true
}

export async function finishJob(id: string, ok: boolean, err: string | null): Promise<void> {
  const { error } = await supabase.rpc('finish_print_job', { p_id: id, p_ok: ok, p_error: err })
  if (error) fail(error)
}

export async function requeueJob(id: string): Promise<void> {
  const { error } = await supabase.rpc('requeue_print_job', { p_id: id })
  if (error) fail(error)
}

export async function insertTestPrint(route: string): Promise<void> {
  const { error } = await supabase.rpc('insert_test_print', { p_route: route })
  if (error) fail(error)
}
```

- [ ] **Step 6: Type-check.** Run: `npx tsc -b` — Expected: errors only in `src/features/pos/spike/*` (they still use the old `newQueuedOrder` shape; they are deleted in Task 12). If `tsc -b` reports errors elsewhere, fix them. To keep the gate green now, update `src/features/pos/spike/CounterOrder.tsx` minimally: replace its `newQueuedOrder(tableId || null, cart)` call with `newQueuedOrder('takeaway', tableId || null, null, cart.map((l) => ({ productId: l.menuItemId, variantId: l.menuItemId, qty: l.qty, note: l.note, optionIds: [] })))` and change `spikeApi.sendCounterOrder` to send `o.items.map((l) => ({ menuItemId: l.productId, qty: l.qty, note: l.note }))`. Re-run `npx tsc -b` — Expected: no output. Run `npx vitest run` — Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/features/pos/offline src/features/pos/order/posApi.ts src/features/pos/spike/CounterOrder.tsx src/features/pos/spike/spikeApi.ts
git commit -m "feat(pos-order): offline queue carries real order lines; POS data layer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: `/pos` shell — tables grid, bill panel, Realtime

**Files:**
- Create: `src/features/pos/order/tableStatus.ts`, `src/features/pos/order/tableStatus.test.ts`
- Create: `src/features/pos/order/usePosRealtime.ts`
- Create: `src/features/pos/order/TablesGrid.tsx`, `src/features/pos/order/BillPanel.tsx`, `src/features/pos/order/PosPage.tsx`
- Modify: `src/App.tsx` (route `/pos`, **without** `AppLayout` — the POS is full-screen)

**Interfaces:**
- Consumes: `posApi` (Task 6), `useAuth().staff.branch_id`, `formatSen` (Task 4).
- Produces:

```ts
// tableStatus.ts
export type TableState = 'empty' | 'open' | 'new'
export interface TableCard { id: string; label: string; state: TableState; paused: boolean; bill: OpenBillRow | null }
export function tableCards(tables: TableRow[], bills: OpenBillRow[], newBillIds: ReadonlySet<string>): TableCard[]
export function takeawayBills(bills: OpenBillRow[]): OpenBillRow[]
// usePosRealtime.ts
export function usePosRealtime(branchId: string | null, handlers: { onOrder?: (row: OrderInsert) => void; onPrintJob?: (row: PrintJobRow) => void; onSweep?: () => void }): string  // returns channel status
export interface OrderInsert { id: string; bill_id: string; branch_id: string; order_no: string; source: 'counter' | 'qr'; placed_at: string }
// PosPage.tsx: export default function PosPage(); selection type `Selection = { kind: 'table'; tableId: string } | { kind: 'bill'; billId: string } | null`
```

- [ ] **Step 1: Write the failing test**

```ts
// src/features/pos/order/tableStatus.test.ts
import { describe, it, expect } from 'vitest'
import { tableCards, takeawayBills } from './tableStatus'

const t = (id: string, label: string, paused = false) => ({ id, label, qr_token: 'x', qr_paused: paused, is_active: true, sort_order: 0 })
const b = (id: string, table_id: string | null) => ({ id, bill_no: '261023-001', table_id, order_type: table_id ? 'dine_in' as const : 'takeaway' as const, pax: null, opened_at: '2026-10-23T02:00:00Z' })

describe('tableCards', () => {
  it('marks tables empty, open or new and keeps the bill', () => {
    const cards = tableCards([t('t1', 'T1'), t('t2', 'T2', true), t('t3', 'T3')], [b('b2', 't2'), b('b3', 't3'), b('b9', null)], new Set(['b3']))
    expect(cards.map((c) => [c.label, c.state, c.paused, c.bill?.id ?? null])).toEqual([
      ['T1', 'empty', false, null], ['T2', 'open', true, 'b2'], ['T3', 'new', false, 'b3'],
    ])
  })
  it('takeaway bills are the ones without a table', () => {
    expect(takeawayBills([b('b2', 't2'), b('b9', null)]).map((x) => x.id)).toEqual(['b9'])
  })
})
```

- [ ] **Step 2: Run to verify it fails.** Run: `npx vitest run src/features/pos/order/tableStatus.test.ts` — Expected: FAIL (module not found).

- [ ] **Step 3: Write `tableStatus.ts`**

```ts
// src/features/pos/order/tableStatus.ts
import type { OpenBillRow, TableRow } from './posApi'

export type TableState = 'empty' | 'open' | 'new'
export interface TableCard { id: string; label: string; state: TableState; paused: boolean; bill: OpenBillRow | null }

/** One card per active table. `newBillIds` = bills that received a QR order the
 *  cashier has not opened yet (PosPage marks them from Realtime inserts). */
export function tableCards(tables: TableRow[], bills: OpenBillRow[], newBillIds: ReadonlySet<string>): TableCard[] {
  const byTable = new Map(bills.filter((b) => b.table_id).map((b) => [b.table_id as string, b]))
  return tables.map((t) => {
    const bill = byTable.get(t.id) ?? null
    return { id: t.id, label: t.label, paused: t.qr_paused, bill, state: !bill ? 'empty' : newBillIds.has(bill.id) ? 'new' : 'open' }
  })
}

export function takeawayBills(bills: OpenBillRow[]): OpenBillRow[] {
  return bills.filter((b) => b.table_id === null)
}
```

- [ ] **Step 4: Run the test.** Run: `npx vitest run src/features/pos/order/tableStatus.test.ts` — Expected: PASS.

- [ ] **Step 5: Write the Realtime hook**

```ts
// src/features/pos/order/usePosRealtime.ts
import { useEffect, useRef, useState } from 'react'
import { supabase } from '../../../shared/lib/supabase'
import type { PrintJobRow } from './posApi'

export interface OrderInsert { id: string; bill_id: string; branch_id: string; order_no: string; source: 'counter' | 'qr'; placed_at: string }

interface Handlers {
  onOrder?: (row: OrderInsert) => void
  onPrintJob?: (row: PrintJobRow) => void
  /** Called on SUBSCRIBED and every 15 s: refetch whatever Realtime may have missed. */
  onSweep?: () => void
}

/** One channel per mount (unique name: supabase.channel() reuses a same-named
 *  channel that is still being torn down — Phase 0). Filtered to the branch. */
export function usePosRealtime(branchId: string | null, handlers: Handlers): string {
  const [status, setStatus] = useState('idle')
  const h = useRef(handlers)
  h.current = handlers
  useEffect(() => {
    if (!branchId) return
    const filter = `branch_id=eq.${branchId}`
    const channel = supabase
      .channel(`pos-${crypto.randomUUID()}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders', filter }, (p) => h.current.onOrder?.(p.new as OrderInsert))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'print_jobs', filter }, (p) => h.current.onPrintJob?.(p.new as PrintJobRow))
      .subscribe((s) => {
        setStatus(s)
        if (s === 'SUBSCRIBED') h.current.onSweep?.()
      })
    const timer = window.setInterval(() => h.current.onSweep?.(), 15_000)
    return () => {
      window.clearInterval(timer)
      void supabase.removeChannel(channel)
    }
  }, [branchId])
  return status
}
```

- [ ] **Step 6: Write the components**

```tsx
// src/features/pos/order/TablesGrid.tsx
import type { TableCard } from './tableStatus'
import type { OpenBillRow } from './posApi'

const TONE: Record<TableCard['state'], string> = {
  empty: 'bg-card border-border text-brown-muted',
  open: 'bg-amber-50 border-amber-300 text-brown-dark',
  new: 'bg-green-100 border-green-500 text-brown-dark ring-2 ring-green-400',
}

export default function TablesGrid({ cards, takeaway, selectedId, onPick, onTakeaway, onPickBill }: {
  cards: TableCard[]
  takeaway: OpenBillRow[]
  selectedId: string | null
  onPick: (tableId: string) => void
  onTakeaway: () => void
  onPickBill: (billId: string) => void
}) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-3">
        {cards.map((c) => (
          <button key={c.id} onClick={() => onPick(c.id)}
            className={`h-24 rounded-xl border-2 p-2 text-left ${TONE[c.state]} ${selectedId === c.id ? 'outline outline-2 outline-brown-btn' : ''}`}>
            <div className="text-xl font-semibold">{c.label}</div>
            <div className="text-xs">
              {c.state === 'empty' ? 'Empty' : c.state === 'new' ? 'New order' : `Bill ${c.bill?.bill_no}`}
              {c.paused && ' · QR paused'}
            </div>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button onClick={onTakeaway} className="rounded-xl bg-brown-btn px-4 py-3 text-white hover:bg-brown-btn-hover">+ Takeaway order</button>
        {takeaway.map((b) => (
          <button key={b.id} onClick={() => onPickBill(b.id)}
            className={`rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3 ${selectedId === b.id ? 'outline outline-2 outline-brown-btn' : ''}`}>
            Takeaway {b.bill_no}
          </button>
        ))}
      </div>
    </div>
  )
}
```

```tsx
// src/features/pos/order/BillPanel.tsx
import { useEffect, useState } from 'react'
import { fetchBillItems, setTablePaused, type BillItemRow, type OpenBillRow, type TableRow } from './posApi'
import { formatSen } from './cart'

export default function BillPanel({ table, bill, refreshKey, onAddItems }: {
  table: TableRow | null          // null = takeaway bill
  bill: OpenBillRow | null        // null = empty table
  refreshKey: number              // bump to refetch (a new order arrived)
  onAddItems: () => void
}) {
  const [items, setItems] = useState<BillItemRow[]>([])
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(table?.qr_paused ?? false)
  useEffect(() => { setPaused(table?.qr_paused ?? false) }, [table?.id, table?.qr_paused])
  useEffect(() => {
    if (!bill) { setItems([]); return }
    let alive = true
    fetchBillItems(bill.id).then((rows) => { if (alive) setItems(rows) }, (e) => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [bill?.id, refreshKey])

  const subtotal = items.filter((i) => !i.voided_at).reduce((n, i) => n + i.unit_price_sen * i.qty, 0)
  const orders = [...new Map(items.map((i) => [i.order_id, i.orders])).entries()]

  const togglePause = async () => {
    if (!table) return
    const next = !paused
    setPaused(next)
    try { await setTablePaused(table.id, next) } catch (e) { setPaused(!next); setError(e instanceof Error ? e.message : String(e)) }
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between border-b border-border p-3">
        <div>
          <div className="text-lg font-semibold">{table ? `Table ${table.label}` : 'Takeaway'}</div>
          <div className="text-xs text-brown-muted">
            {bill ? `Bill ${bill.bill_no}${bill.pax ? ` · ${bill.pax} pax` : ''}` : 'No open bill'}
          </div>
        </div>
        {table && (
          <button onClick={() => void togglePause()} className="rounded border border-border px-3 py-1 text-xs">
            {paused ? 'Resume QR' : 'Pause QR'}
          </button>
        )}
      </div>
      {error && <p className="m-3 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
      <div className="flex-1 overflow-y-auto p-3 text-sm">
        {orders.map(([orderId, o]) => (
          <div key={orderId} className="mb-3">
            <div className="text-xs text-brown-muted">{o.order_no} · {o.source.toUpperCase()} · {new Date(o.placed_at).toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit' })}</div>
            {items.filter((i) => i.order_id === orderId).map((i) => (
              <div key={i.id} className={`flex justify-between py-1 ${i.voided_at ? 'line-through opacity-50' : ''}`}>
                <div>
                  {i.qty} × {i.name_snapshot}
                  {i.modifiers_snapshot.map((m, k) => <div key={k} className="pl-4 text-xs text-brown-muted">+ {m.name}</div>)}
                  {i.note && <div className="pl-4 text-xs italic text-brown-muted">* {i.note}</div>}
                </div>
                <div>{formatSen(i.unit_price_sen * i.qty)}</div>
              </div>
            ))}
          </div>
        ))}
        {bill && items.length === 0 && !error && <p className="text-brown-muted">Loading…</p>}
      </div>
      <div className="border-t border-border p-3">
        <div className="flex justify-between text-sm"><span>Subtotal</span><b>{formatSen(subtotal)}</b></div>
        <p className="text-xs text-brown-muted">Service charge, SST and checkout come in the next step.</p>
        <button onClick={onAddItems} className="mt-2 w-full rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover">
          {bill ? 'Add items' : 'New order'}
        </button>
      </div>
    </div>
  )
}
```

```tsx
// src/features/pos/order/PosPage.tsx
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../../auth/AuthContext'
import { useCan } from '../../../shared/lib/permissions'
import { fetchOpenBills, fetchTables, type OpenBillRow, type TableRow } from './posApi'
import { tableCards, takeawayBills } from './tableStatus'
import { usePosRealtime, type OrderInsert } from './usePosRealtime'
import TablesGrid from './TablesGrid'
import BillPanel from './BillPanel'

export type Selection = { kind: 'table'; tableId: string } | { kind: 'bill'; billId: string } | null

export default function PosPage() {
  const { staff } = useAuth()
  const { can } = useCan()
  const branchId = staff?.branch_id ?? null
  const [tables, setTables] = useState<TableRow[]>([])
  const [bills, setBills] = useState<OpenBillRow[]>([])
  const [newBillIds, setNewBillIds] = useState<Set<string>>(new Set())
  const [selection, setSelection] = useState<Selection>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!branchId) return
    try {
      const [t, b] = await Promise.all([fetchTables(branchId), fetchOpenBills(branchId)])
      setTables(t); setBills(b); setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [branchId])
  useEffect(() => { void reload() }, [reload])

  const onOrder = useCallback((row: OrderInsert) => {
    if (row.source === 'qr') setNewBillIds((s) => new Set(s).add(row.bill_id))
    setRefreshKey((k) => k + 1)
    void reload()
  }, [reload])
  const rtStatus = usePosRealtime(branchId, { onOrder, onSweep: reload })

  const cards = useMemo(() => tableCards(tables, bills, newBillIds), [tables, bills, newBillIds])
  const selectedTable = selection?.kind === 'table' ? tables.find((t) => t.id === selection.tableId) ?? null : null
  const selectedBill = selection?.kind === 'table'
    ? bills.find((b) => b.table_id === selection.tableId) ?? null
    : selection?.kind === 'bill' ? bills.find((b) => b.id === selection.billId) ?? null : null
  const selectedId = selection?.kind === 'table' ? selection.tableId : selection?.kind === 'bill' ? selection.billId : null

  const pick = (tableId: string) => {
    setSelection({ kind: 'table', tableId })
    const bill = bills.find((b) => b.table_id === tableId)
    if (bill) setNewBillIds((s) => { const n = new Set(s); n.delete(bill.id); return n })
  }

  if (!staff) return null
  if (!branchId) {
    return <div className="p-8 text-center">Your account has no branch — ask a manager to set it in Team.</div>
  }
  return (
    <div className="flex h-screen flex-col bg-cream">
      <header className="flex items-center justify-between border-b border-border bg-card px-4 py-2">
        <div className="font-semibold">Craft POS · {staff.branch ?? 'Branch'}</div>
        <div className="flex items-center gap-3 text-xs text-brown-muted">
          <span>Live: {rtStatus}</span>
          {can('access_settings') && <Link to="/pos/settings" className="underline">Tables & printers</Link>}
          <Link to="/profile" className="underline">Exit</Link>
        </div>
      </header>
      {error && <p className="m-3 rounded bg-red-50 p-2 text-sm text-red-700">{error} <button className="underline" onClick={() => void reload()}>Retry</button></p>}
      <div className="grid flex-1 grid-cols-[1fr_380px] gap-4 overflow-hidden p-4">
        <div className="overflow-y-auto">
          <TablesGrid cards={cards} takeaway={takeawayBills(bills)} selectedId={selectedId}
            onPick={pick} onTakeaway={() => setSelection(null)} onPickBill={(billId) => setSelection({ kind: 'bill', billId })} />
        </div>
        {(selectedTable || selectedBill) && (
          <BillPanel table={selectedTable} bill={selectedBill} refreshKey={refreshKey} onAddItems={() => undefined} />
        )}
      </div>
    </div>
  )
}
```

`onAddItems` is wired in Task 8 (it opens the order pad); `onTakeaway` is also completed there (it opens the pad in takeaway mode). In this task they are inert on purpose so the shell compiles and renders.

- [ ] **Step 7: Route.** In `src/App.tsx` import `PosPage from './features/pos/order/PosPage'` and add, next to the `/menu` route:

```tsx
<Route path="/pos" element={<ProtectedRoute><PosPage /></ProtectedRoute>} />
```

(no `AppLayout`: the POS is full-screen on the iPad).

- [ ] **Step 8: Gates.** Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run src/features/pos` — Expected: PASS. Start the dev server (`pos-menu-dev`, port 5174) and open `http://localhost:5174/pos` signed in as the test login: the ten `T1`–`T10` cards render, `Live: SUBSCRIBED` shows in the header, tapping a card opens the bill panel with "No open bill".

- [ ] **Step 9: Commit**

```bash
git add src/features/pos/order/tableStatus.ts src/features/pos/order/tableStatus.test.ts src/features/pos/order/usePosRealtime.ts src/features/pos/order/TablesGrid.tsx src/features/pos/order/BillPanel.tsx src/features/pos/order/PosPage.tsx src/App.tsx
git commit -m "feat(pos): /pos shell — tables grid, open-bill panel, branch-filtered Realtime

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Order pad — pick items, modifiers, send through the offline queue

**Files:**
- Create: `src/features/pos/order/LineSheet.tsx`, `src/features/pos/order/OrderPad.tsx`, `src/features/pos/order/useOrderQueue.ts`
- Modify: `src/features/pos/order/PosPage.tsx`

**Interfaces:**
- Consumes: `cart.ts` (Task 4), `posApi` (Task 6), `orderQueue`/`idbStore`.
- Produces:

```ts
// LineSheet.tsx — shared with the QR page (Task 11); imports only cart.ts
export default function LineSheet(props: { product: PosProduct; initial?: OrderLine; onCancel: () => void; onDone: (line: OrderLine) => void }): JSX.Element
// useOrderQueue.ts
export function useOrderQueue(): { submit: (o: QueuedOrder) => Promise<void>; report: FlushReport | null; flush: () => Promise<void>; stuck: QueuedOrder[]; discard: (clientOrderId: string) => Promise<void> }
// OrderPad.tsx
export default function OrderPad(props: { branchId: string; mode: { orderType: 'dine_in'; tableId: string; needsPax: boolean } | { orderType: 'takeaway' }; onClose: () => void; onSent: () => void }): JSX.Element
```

- [ ] **Step 1: `LineSheet.tsx`** — variant, modifier groups (radio when `max === 1`, checkboxes otherwise), qty, note. It validates with `validateLine` and shows the message inline, so the server never sees a line the sheet would refuse.

```tsx
// src/features/pos/order/LineSheet.tsx
import { useState } from 'react'
import { defaultLine, formatSen, linePriceSen, validateLine, type OrderLine, type PosProduct } from './cart'

export default function LineSheet({ product, initial, onCancel, onDone }: {
  product: PosProduct
  initial?: OrderLine
  onCancel: () => void
  onDone: (line: OrderLine) => void
}) {
  const [line, setLine] = useState<OrderLine>(initial ?? defaultLine(product))
  const [touched, setTouched] = useState(false)
  const problem = validateLine(product, line)
  const price = linePriceSen(product, line)

  const toggle = (groupMax: number, groupOptionIds: string[], id: string) => {
    setTouched(true)
    setLine((l) => {
      const inGroup = l.optionIds.filter((x) => groupOptionIds.includes(x))
      const others = l.optionIds.filter((x) => !groupOptionIds.includes(x))
      if (groupMax === 1) return { ...l, optionIds: inGroup[0] === id ? others : [...others, id] }
      return { ...l, optionIds: inGroup.includes(id) ? [...others, ...inGroup.filter((x) => x !== id)] : [...others, ...inGroup, id] }
    })
  }

  return (
    <div className="fixed inset-0 z-20 flex items-end justify-center bg-black/40 sm:items-center" onClick={onCancel}>
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-card p-4 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold">{product.name}</h2>
        {product.description && <p className="text-sm text-brown-muted">{product.description}</p>}

        {product.variants.length > 1 && (
          <div className="mt-3">
            <div className="text-xs font-semibold uppercase text-brown-muted">Choose one</div>
            <div className="mt-1 flex flex-wrap gap-2">
              {product.variants.map((v) => (
                <button key={v.id} onClick={() => setLine({ ...line, variantId: v.id })}
                  className={`rounded-lg border px-3 py-2 text-sm ${line.variantId === v.id ? 'border-brown-btn bg-brown-btn text-white' : 'border-border'}`}>
                  {v.name} · {formatSen(v.priceSen)}
                </button>
              ))}
            </div>
          </div>
        )}

        {product.groups.map((g) => {
          const ids = g.options.map((o) => o.id)
          return (
            <div key={g.id} className="mt-3">
              <div className="text-xs font-semibold uppercase text-brown-muted">
                {g.name} · {g.min > 0 ? `choose ${g.min === g.max ? g.min : `${g.min}–${g.max}`}` : `up to ${g.max}`}
              </div>
              <div className="mt-1 flex flex-wrap gap-2">
                {g.options.map((o) => (
                  <button key={o.id} disabled={!o.available} onClick={() => toggle(g.max, ids, o.id)}
                    className={`rounded-lg border px-3 py-2 text-sm disabled:opacity-40 ${line.optionIds.includes(o.id) ? 'border-brown-btn bg-brown-btn text-white' : 'border-border'}`}>
                    {o.name}{o.priceDeltaSen > 0 && ` +${formatSen(o.priceDeltaSen)}`}{!o.available && ' (sold out)'}
                  </button>
                ))}
              </div>
            </div>
          )
        })}

        <div className="mt-3 flex items-center gap-3">
          <span className="text-sm">Qty</span>
          <button className="h-10 w-10 rounded-lg border border-border text-xl" onClick={() => setLine({ ...line, qty: Math.max(1, line.qty - 1) })}>−</button>
          <span className="w-8 text-center text-lg">{line.qty}</span>
          <button className="h-10 w-10 rounded-lg border border-border text-xl" onClick={() => setLine({ ...line, qty: Math.min(20, line.qty + 1) })}>+</button>
        </div>
        <input className="mt-3 w-full rounded-lg border border-border p-2 text-sm" placeholder="Note for the kitchen (optional)"
          value={line.note ?? ''} onChange={(e) => setLine({ ...line, note: e.target.value || null })} maxLength={120} />

        {touched && problem && <p className="mt-2 text-sm text-red-700">{problem}</p>}
        <div className="mt-4 flex gap-2">
          <button onClick={onCancel} className="flex-1 rounded-xl border border-border py-3">Cancel</button>
          <button disabled={!!problem} onClick={() => onDone(line)}
            className="flex-1 rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover disabled:opacity-40">
            Add · {price === null ? '—' : formatSen(price * line.qty)}
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: `useOrderQueue.ts`** — the Phase 0 flush mutex as a hook; one IndexedDB store per page.

```ts
// src/features/pos/order/useOrderQueue.ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { createIdbStore } from '../offline/idbStore'
import { enqueue, flushQueue, type FlushReport, type QueuedOrder } from '../offline/orderQueue'
import { sendCounterOrder } from './posApi'

const store = createIdbStore()

/** Enqueue-then-send: the order is on this iPad's disk before anything goes on
 *  the wire, and flush runs on mount, when the network comes back, every 15 s,
 *  and after every submit. One flush at a time; a request during a flush runs
 *  one more pass afterwards. */
export function useOrderQueue() {
  const [report, setReport] = useState<FlushReport | null>(null)
  const [stuck, setStuck] = useState<QueuedOrder[]>([])
  const inFlight = useRef<Promise<void> | null>(null)
  const again = useRef(false)

  const refreshStuck = useCallback(async () => {
    setStuck((await store.all()).filter((o) => o.failedReason !== null))
  }, [])

  const flush = useCallback(async (): Promise<void> => {
    if (inFlight.current) { again.current = true; return inFlight.current }
    inFlight.current = (async () => {
      try {
        do {
          again.current = false
          setReport(await flushQueue(store, sendCounterOrder))
        } while (again.current)
        await refreshStuck()
      } finally { inFlight.current = null }
    })()
    return inFlight.current
  }, [refreshStuck])

  useEffect(() => {
    void navigator.storage?.persist?.()
    void flush()
    const onOnline = () => void flush()
    window.addEventListener('online', onOnline)
    const timer = window.setInterval(() => void flush(), 15_000)
    return () => { window.removeEventListener('online', onOnline); window.clearInterval(timer) }
  }, [flush])

  const submit = useCallback(async (o: QueuedOrder) => {
    await enqueue(store, o)         // throws if the device refused to store it — caller keeps the cart
    await flush()
  }, [flush])

  const discard = useCallback(async (clientOrderId: string) => {
    await store.remove(clientOrderId)
    await refreshStuck()
  }, [refreshStuck])

  return { submit, report, flush, stuck, discard }
}
```

- [ ] **Step 3: `OrderPad.tsx`**

```tsx
// src/features/pos/order/OrderPad.tsx
import { useEffect, useMemo, useState } from 'react'
import { fetchPosMenu, setSoldOut } from './posApi'
import { cartSubtotalSen, findProduct, formatSen, lineLabel, linePriceSen, validateLine, defaultLine, type OrderLine, type PosMenu, type PosProduct } from './cart'
import { newQueuedOrder } from '../offline/orderQueue'
import { useOrderQueue } from './useOrderQueue'
import LineSheet from './LineSheet'

type Mode = { orderType: 'dine_in'; tableId: string; needsPax: boolean } | { orderType: 'takeaway' }

export default function OrderPad({ branchId, mode, onClose, onSent }: { branchId: string; mode: Mode; onClose: () => void; onSent: () => void }) {
  const [menu, setMenu] = useState<PosMenu | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [category, setCategory] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [lines, setLines] = useState<OrderLine[]>([])
  const [sheet, setSheet] = useState<{ product: PosProduct; index: number | null } | null>(null)
  const [pax, setPax] = useState<string>('')
  const [soldOutMode, setSoldOutMode] = useState(false)
  const [sending, setSending] = useState(false)
  const { submit, report, stuck, discard } = useOrderQueue()

  const load = async () => {
    try { setMenu(await fetchPosMenu(branchId)); setError(null) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  useEffect(() => { void load() }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps

  const products = useMemo(() => {
    if (!menu) return []
    const all = menu.categories.flatMap((c) => c.products.map((p) => ({ ...p, category: c.name })))
    const q = search.trim().toLowerCase()
    return all.filter((p) => (q ? p.name.toLowerCase().includes(q) : !category || p.category === category))
  }, [menu, category, search])

  const tap = async (p: PosProduct) => {
    if (soldOutMode) {
      try { await setSoldOut(branchId, p.id, !p.soldOut); await load() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
      return
    }
    if (p.soldOut) return
    if (p.variants.length === 1 && p.groups.length === 0) setLines((ls) => [...ls, defaultLine(p)])
    else setSheet({ product: p, index: null })
  }

  const send = async () => {
    if (!menu || lines.length === 0) return
    const needPax = mode.orderType === 'dine_in' && mode.needsPax
    const paxNum = needPax ? Number(pax) : null
    if (needPax && (!Number.isInteger(paxNum) || (paxNum as number) < 1 || (paxNum as number) > 99)) { setError('Enter the number of guests (1–99)'); return }
    for (const l of lines) {
      const p = findProduct(menu, l.productId)
      const problem = p ? validateLine(p, l) : 'Item is no longer on the menu'
      if (problem) { setError(problem); return }
    }
    setSending(true)
    try {
      await submit(newQueuedOrder(mode.orderType, mode.orderType === 'dine_in' ? mode.tableId : null, paxNum, lines))
      setLines([]); setError(null); onSent()
    } catch (e) {
      setError(`Order NOT saved on this iPad: ${e instanceof Error ? e.message : String(e)}`)
    } finally { setSending(false) }
  }

  const subtotal = menu ? cartSubtotalSen(menu, lines) : 0
  return (
    <div className="fixed inset-0 z-10 grid grid-cols-[1fr_360px] bg-cream">
      <div className="flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-border bg-card p-2">
          <button onClick={onClose} className="rounded-lg border border-border px-3 py-2">← Tables</button>
          <input className="flex-1 rounded-lg border border-border p-2 text-sm" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button onClick={() => setSoldOutMode((v) => !v)} className={`rounded-lg px-3 py-2 text-sm ${soldOutMode ? 'bg-red-600 text-white' : 'border border-border'}`}>
            {soldOutMode ? 'Tap items to mark sold out · Done' : 'Sold out…'}
          </button>
        </div>
        <div className="flex gap-1 overflow-x-auto border-b border-border bg-card p-2">
          {menu?.categories.map((c) => (
            <button key={c.name} onClick={() => { setCategory(c.name); setSearch('') }}
              className={`whitespace-nowrap rounded-full px-3 py-1 text-sm ${category === c.name && !search ? 'bg-brown-btn text-white' : 'border border-border'}`}>
              {c.name}
            </button>
          ))}
        </div>
        {error && <p className="m-2 rounded bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        <div className="grid flex-1 grid-cols-4 content-start gap-2 overflow-y-auto p-2">
          {!menu && !error && <p className="text-brown-muted">Loading menu…</p>}
          {products.map((p) => (
            <button key={p.id} onClick={() => void tap(p)}
              className={`min-h-20 rounded-xl border p-2 text-left text-sm ${p.soldOut ? 'border-red-300 bg-red-50 text-red-700' : 'border-border bg-card'}`}>
              <div className="font-medium">{p.name}</div>
              <div className="text-xs text-brown-muted">{p.variants.length > 1 ? `${formatSen(Math.min(...p.variants.map((v) => v.priceSen)))} –` : formatSen(p.variants[0].priceSen)}{p.soldOut && ' · SOLD OUT'}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col border-l border-border bg-card">
        <div className="border-b border-border p-3 font-semibold">{mode.orderType === 'takeaway' ? 'Takeaway' : 'Dine-in'} order</div>
        <div className="flex-1 overflow-y-auto p-3 text-sm">
          {lines.map((l, i) => {
            const p = menu ? findProduct(menu, l.productId) : undefined
            if (!p) return null
            const { name, mods } = lineLabel(p, l)
            const unit = linePriceSen(p, l) ?? 0
            return (
              <div key={i} className="mb-2 flex justify-between">
                <button className="text-left" onClick={() => setSheet({ product: p, index: i })}>
                  {l.qty} × {name}
                  {mods.map((m) => <div key={m} className="pl-4 text-xs text-brown-muted">+ {m}</div>)}
                  {l.note && <div className="pl-4 text-xs italic text-brown-muted">* {l.note}</div>}
                </button>
                <div className="text-right">
                  <div>{formatSen(unit * l.qty)}</div>
                  <button className="text-xs text-red-700 underline" onClick={() => setLines((ls) => ls.filter((_, k) => k !== i))}>remove</button>
                </div>
              </div>
            )
          })}
          {lines.length === 0 && <p className="text-brown-muted">Tap items to add them.</p>}
        </div>
        <div className="border-t border-border p-3">
          {mode.orderType === 'dine_in' && mode.needsPax && (
            <label className="mb-2 block text-sm">Guests
              <input inputMode="numeric" className="ml-2 w-16 rounded border border-border p-1" value={pax} onChange={(e) => setPax(e.target.value)} />
            </label>
          )}
          <div className="flex justify-between text-sm"><span>Subtotal</span><b>{formatSen(subtotal)}</b></div>
          <button disabled={sending || lines.length === 0} onClick={() => void send()}
            className="mt-2 w-full rounded-xl bg-brown-btn py-3 text-white hover:bg-brown-btn-hover disabled:opacity-40">
            {sending ? 'Saving…' : 'Send order'}
          </button>
          {report && (report.pending > 0 || report.lastError) && (
            <p className="mt-2 text-xs text-amber-700">
              {report.pending} order{report.pending === 1 ? '' : 's'} waiting to send{report.lastError ? ` — ${report.lastError}` : ''}
            </p>
          )}
          {stuck.map((o) => (
            <p key={o.clientOrderId} className="mt-1 text-xs text-red-700">
              Rejected: {o.failedReason} <button className="underline" onClick={() => void discard(o.clientOrderId)}>Discard</button>
            </p>
          ))}
        </div>
      </div>

      {sheet && (
        <LineSheet product={sheet.product} initial={sheet.index === null ? undefined : lines[sheet.index]}
          onCancel={() => setSheet(null)}
          onDone={(line) => { setLines((ls) => sheet.index === null ? [...ls, line] : ls.map((x, k) => (k === sheet.index ? line : x))); setSheet(null) }} />
      )}
    </div>
  )
}
```

- [ ] **Step 4: Wire the pad into `PosPage.tsx`.** Add state and render:

```tsx
// imports
import OrderPad from './OrderPad'
// state (next to selection)
const [pad, setPad] = useState<{ orderType: 'dine_in'; tableId: string; needsPax: boolean } | { orderType: 'takeaway' } | null>(null)
```

Replace the two inert props and add the pad:

```tsx
<TablesGrid … onTakeaway={() => setPad({ orderType: 'takeaway' })} … />
…
<BillPanel … onAddItems={() => {
  if (selectedTable) setPad({ orderType: 'dine_in', tableId: selectedTable.id, needsPax: !selectedBill?.pax })
  else setPad({ orderType: 'takeaway' })
}} />
…
{pad && (
  <OrderPad branchId={branchId} mode={pad} onClose={() => setPad(null)}
    onSent={() => { setPad(null); setRefreshKey((k) => k + 1); void reload() }} />
)}
```

(place the `{pad && …}` block as the last child of the outer `div`.)

- [ ] **Step 5: Gates.** Run: `npx tsc -b` — Expected: no output. Run: `npx vitest run src/features/pos` — Expected: PASS. In the browser on `/pos`: tap `T1` → **New order** → pick `Coffee Latte` → sheet shows HOT/COLD and the milk group → Add → Guests `2` → **Send order** → the pad closes, `T1` turns amber with a bill number, the bill panel lists the line with its modifier and `261023-001/1 · COUNTER`. In the dev DB `select count(*) from print_jobs where status = 'pending'` grows by the number of routes the line touched. Turn Wi-Fi off, send another order: the pad shows "1 order waiting to send"; turn it on: it clears within 15 s and the bill gains the order.

- [ ] **Step 6: Commit**

```bash
git add src/features/pos/order/LineSheet.tsx src/features/pos/order/OrderPad.tsx src/features/pos/order/useOrderQueue.ts src/features/pos/order/PosPage.tsx
git commit -m "feat(pos): order pad with variants and modifiers, sent through the offline queue

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Print host in the POS — browser routes, failed/stuck jobs, reprint, test print

**Files:**
- Create: `src/features/pos/order/PrintHostPanel.tsx`
- Modify: `src/features/pos/order/PosPage.tsx` (render the panel in the header area)

**Interfaces:**
- Consumes: `processJob` (`print/printHost.ts`), `printFromBrowser` (`print/adapter.ts`), `posApi` (`fetchRoutes`, `fetchPrintJobs`, `claimJob`, `finishJob`, `requeueJob`, `insertTestPrint`), `usePosRealtime`.
- Produces: `export default function PrintHostPanel({ branchId }: { branchId: string })`.

- [ ] **Step 1: Write the panel** (the Phase 0 `spike/PrintHostPanel.tsx` logic, re-pointed; the agent prints `agent` routes, this panel prints the rest and shows every failed or stuck job of the branch):

```tsx
// src/features/pos/order/PrintHostPanel.tsx
import { useCallback, useEffect, useRef, useState } from 'react'
import { processJob, type PrintJob } from '../print/printHost'
import { printFromBrowser, type PrintRoute } from '../print/adapter'
import { claimJob, fetchPrintJobs, fetchRoutes, finishJob, insertTestPrint, requeueJob, type PrintJobRow } from './posApi'
import { usePosRealtime } from './usePosRealtime'

const STUCK_MS = 2 * 60_000

export default function PrintHostPanel({ branchId }: { branchId: string }) {
  const [routes, setRoutes] = useState<PrintRoute[]>([])
  const [problems, setProblems] = useState<PrintJobRow[]>([])
  const [note, setNote] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const sweeping = useRef(false)
  const routesRef = useRef<PrintRoute[]>([])
  routesRef.current = routes

  useEffect(() => { fetchRoutes(branchId).then(setRoutes, (e) => setNote(e.message)) }, [branchId])

  const handle = useCallback(async (job: PrintJob) => {
    const route = routesRef.current.find((r) => r.route === job.route)
    if (!route || route.kind === 'agent') return            // the Node agent prints these
    try {
      await processJob(job, { claim: claimJob, finish: finishJob, print: (j) => printFromBrowser(route, j.payload) })
    } catch (e) {
      setNote(`${job.route}: printed but could not record it — ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [])

  const sweep = useCallback(async () => {
    if (sweeping.current) return
    sweeping.current = true
    try {
      const jobs = await fetchPrintJobs(branchId, ['pending', 'printing', 'failed'])
      const now = Date.now()
      setProblems(jobs.filter((j) => j.status === 'failed' || (j.status === 'printing' && j.claimed_at && now - Date.parse(j.claimed_at) > STUCK_MS)))
      for (const j of jobs) if (j.status === 'pending') await handle(j)
    } catch (e) { setNote(e instanceof Error ? e.message : String(e)) } finally { sweeping.current = false }
  }, [branchId, handle])

  usePosRealtime(branchId, { onPrintJob: (row) => void handle(row), onSweep: () => void sweep() })

  const reprint = async (job: PrintJobRow) => {
    await requeueJob(job.id)
    await handle({ ...job, status: 'pending' })
    await sweep()
  }

  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)}
        className={`rounded px-3 py-1 text-xs ${problems.length ? 'bg-red-600 text-white' : 'border border-border'}`}>
        Printers{problems.length ? ` · ${problems.length} failed` : ''}
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-96 rounded-xl border border-border bg-card p-3 text-sm shadow-lg">
          {note && <p className="mb-2 text-xs text-amber-700">{note}</p>}
          <div className="mb-2 flex flex-wrap gap-2">
            {routes.map((r) => (
              <button key={r.route} onClick={() => insertTestPrint(r.route).catch((e) => setNote(e.message))}
                className="rounded border border-border px-2 py-1 text-xs">Test {r.route} ({r.kind})</button>
            ))}
            {routes.length === 0 && <span className="text-xs text-brown-muted">No printers set — see Tables & printers.</span>}
          </div>
          {problems.length === 0 && <p className="text-xs text-brown-muted">All tickets printed.</p>}
          {problems.map((j) => (
            <div key={j.id} className="mb-2 rounded bg-red-50 p-2">
              <div className="font-medium">{j.route} · {j.payload.orderNo}{j.payload.tableLabel ? ` · ${j.payload.tableLabel}` : ' · takeaway'}</div>
              <div className="text-xs text-red-700">{j.status === 'printing' ? 'Stuck while printing' : j.last_error ?? 'Failed'} · {j.attempts} attempt{j.attempts === 1 ? '' : 's'}</div>
              <button onClick={() => void reprint(j)} className="mt-1 rounded bg-brown-btn px-2 py-1 text-xs text-white">Reprint</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Render it in `PosPage.tsx`** inside the header's right-hand `div`, before `Live:`:

```tsx
import PrintHostPanel from './PrintHostPanel'
…
<PrintHostPanel branchId={branchId} />
```

- [ ] **Step 3: Gates.** `npx tsc -b` — no output; `npx vitest run src/features/pos` — PASS. In the browser: **Printers → Test Bar (agent)** inserts a `print_jobs` row (`select route, status from print_jobs order by created_at desc limit 1` → `Bar | pending`); with the agent not running it stays pending and is not listed as failed; mark it failed in SQL (`update print_jobs set status = 'failed', last_error = 'verify' where …`) → the button turns red with `1 failed`, **Reprint** sets it back to `pending`.

- [ ] **Step 4: Commit**

```bash
git add src/features/pos/order/PrintHostPanel.tsx src/features/pos/order/PosPage.tsx
git commit -m "feat(pos): print host panel — browser routes, failed and stuck tickets with reprint, test print

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: `/pos/settings` — tables, QR cards and printers

**Files:**
- Create: `src/features/pos/order/qrLink.ts`, `src/features/pos/order/qrLink.test.ts`, `src/features/pos/order/PosSettingsPage.tsx`
- Modify: `src/App.tsx` (route), `package.json` (`qrcode` + `@types/qrcode`)

**Interfaces:**
- Consumes: `posApi.fetchTables/fetchRoutes/insertTestPrint`, `writeOutcome`, `has_menu_cap`-gated policies (Task 1).
- Produces: `qrLink(origin: string, token: string, dev: boolean): string` — `https://host/t/<token>` in production, `http://host/qr/?t=<token>` under the Vite dev server (Task 11 serves both). `newQrToken(): string` — 24 hex chars, like the SQL default.

- [ ] **Step 1: Install.** Run: `npm install qrcode@1.5.4 && npm install -D @types/qrcode@1.5.5` — Expected: `package.json` gains both; `npx tsc -b` still clean.

- [ ] **Step 2: Write the failing test**

```ts
// src/features/pos/order/qrLink.test.ts
import { describe, it, expect } from 'vitest'
import { qrLink, newQrToken } from './qrLink'

describe('qrLink', () => {
  it('uses the /t/ path in production and the dev entry under vite', () => {
    expect(qrLink('https://os.craftale.my', 'abc123', false)).toBe('https://os.craftale.my/t/abc123')
    expect(qrLink('http://192.168.0.20:5174', 'abc123', true)).toBe('http://192.168.0.20:5174/qr/?t=abc123')
  })
  it('makes 24-hex tokens', () => {
    expect(newQrToken()).toMatch(/^[0-9a-f]{24}$/)
    expect(newQrToken()).not.toBe(newQrToken())
  })
})
```

- [ ] **Step 3: Run to verify it fails.** `npx vitest run src/features/pos/order/qrLink.test.ts` — FAIL (module not found).

- [ ] **Step 4: Implement**

```ts
// src/features/pos/order/qrLink.ts
/** Where a table's QR code points. Production serves the customer page at /t/<token>
 *  (vercel.json rewrite → qr/index.html); the Vite dev server has no rewrite, so it
 *  is /qr/?t=<token> there. The page reads both. */
export function qrLink(origin: string, token: string, dev: boolean): string {
  return dev ? `${origin}/qr/?t=${token}` : `${origin}/t/${token}`
}

/** 12 random bytes as hex — the same shape as dining_tables.qr_token's default. */
export function newQrToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}
```

- [ ] **Step 5: Run the test.** PASS.

- [ ] **Step 6: Settings page**

```tsx
// src/features/pos/order/PosSettingsPage.tsx
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import QRCode from 'qrcode'
import { supabase } from '../../../shared/lib/supabase'
import { writeOutcome } from '../../../shared/lib/db-write'
import { useAuth } from '../../auth/AuthContext'
import { fetchRoutes, fetchTables, insertTestPrint, type TableRow } from './posApi'
import type { PrintRoute, PrinterKind } from '../print/adapter'
import { qrLink, newQrToken } from './qrLink'
import { PRINT_ROUTES } from '../menu/menuView'

const KINDS: PrinterKind[] = ['agent', 'epson-epos', 'star-webprnt']

function check(res: { data: unknown[] | null; error: { message: string } | null }, what: string) {
  const out = writeOutcome(res)
  if (!out.ok) throw new Error(`${what} failed: ${out.reason}`)
}

export default function PosSettingsPage() {
  const { staff } = useAuth()
  const branchId = staff?.branch_id ?? null
  const [tables, setTables] = useState<TableRow[]>([])
  const [routes, setRoutes] = useState<PrintRoute[]>([])
  const [error, setError] = useState<string | null>(null)
  const [newLabel, setNewLabel] = useState('')
  const [card, setCard] = useState<{ table: TableRow; url: string; png: string } | null>(null)
  const [draft, setDraft] = useState<Record<string, { kind: PrinterKind; address: string }>>({})

  const load = async () => {
    if (!branchId) return
    try {
      const [t, r] = await Promise.all([fetchTables(branchId), fetchRoutes(branchId)])
      setTables(t); setRoutes(r)
      setDraft(Object.fromEntries(r.map((x) => [x.route, { kind: x.kind, address: x.address }])))
      setError(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  useEffect(() => { void load() }, [branchId]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<void>) => {
    try { await fn(); await load() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }

  const addTable = () => run(async () => {
    const label = newLabel.trim()
    if (!label || !branchId) throw new Error('Enter a table label')
    check(await supabase.from('dining_tables').insert({ branch_id: branchId, label, sort_order: tables.length + 1 }).select('id'), 'Adding the table')
    setNewLabel('')
  })
  const rename = (t: TableRow) => {
    const label = window.prompt('Table label', t.label)?.trim()
    if (!label || label === t.label) return
    void run(async () => { check(await supabase.from('dining_tables').update({ label }).eq('id', t.id).select('id'), 'Renaming') })
  }
  const remove = (t: TableRow) => {
    if (!window.confirm(`Remove table ${t.label}? Its QR code stops working.`)) return
    void run(async () => { check(await supabase.from('dining_tables').update({ is_active: false }).eq('id', t.id).select('id'), 'Removing') })
  }
  const regenerate = (t: TableRow) => {
    if (!window.confirm(`New QR code for ${t.label}? The printed card for this table must be replaced.`)) return
    void run(async () => { check(await supabase.from('dining_tables').update({ qr_token: newQrToken() }).eq('id', t.id).select('id'), 'New QR code') })
  }
  const showCard = async (t: TableRow) => {
    const url = qrLink(window.location.origin, t.qr_token, import.meta.env.DEV)
    setCard({ table: t, url, png: await QRCode.toDataURL(url, { width: 320, margin: 1 }) })
  }

  const saveRoute = (name: string) => run(async () => {
    const d = draft[name]
    if (!branchId || !d || !d.address.trim()) throw new Error('Enter the printer address')
    check(await supabase.from('print_routes').upsert({ branch_id: branchId, name, kind: d.kind, address: d.address.trim() }).select('name'), 'Saving the printer')
  })
  const removeRoute = (name: string) => run(async () => {
    if (!branchId) return
    check(await supabase.from('print_routes').delete().eq('branch_id', branchId).eq('name', name).select('name'), 'Removing the printer')
  })

  if (!branchId) return <div className="p-6">Your account has no branch — set it in Team first.</div>
  const routeNames = [...new Set([...PRINT_ROUTES, ...routes.map((r) => r.route)])]
  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Tables & printers</h1>
        <Link to="/pos" className="text-sm underline">Open POS</Link>
      </div>
      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-700">{error}</p>}

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="font-semibold">Tables</h2>
        <div className="mt-2 flex gap-2">
          <input className="rounded border border-border p-2 text-sm" placeholder="New table label, e.g. T11" value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
          <button onClick={() => void addTable()} className="rounded bg-brown-btn px-3 py-2 text-sm text-white hover:bg-brown-btn-hover">Add table</button>
        </div>
        <table className="mt-3 w-full text-sm">
          <thead><tr className="text-left text-xs text-brown-muted"><th>Label</th><th>QR</th><th></th></tr></thead>
          <tbody>
            {tables.map((t) => (
              <tr key={t.id} className="border-t border-border">
                <td className="py-2 font-medium">{t.label}{t.qr_paused && <span className="ml-2 text-xs text-amber-700">paused</span>}</td>
                <td><button className="underline" onClick={() => void showCard(t)}>Show QR card</button></td>
                <td className="space-x-3 text-right text-xs">
                  <button className="underline" onClick={() => rename(t)}>Rename</button>
                  <button className="underline" onClick={() => regenerate(t)}>New QR code</button>
                  <button className="text-red-700 underline" onClick={() => remove(t)}>Remove</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="font-semibold">Printers by route</h2>
        <p className="text-xs text-brown-muted">A product's print route (set on Menu) is sent to the printer named here. `agent` = the Node print agent on the shop Mac (address `ip:9100`).</p>
        {routeNames.map((name) => {
          const d = draft[name] ?? { kind: 'agent' as PrinterKind, address: '' }
          const saved = routes.find((r) => r.route === name)
          return (
            <div key={name} className="mt-2 flex items-center gap-2 text-sm">
              <span className="w-28 font-medium">{name}</span>
              <select className="rounded border border-border p-1" value={d.kind} onChange={(e) => setDraft({ ...draft, [name]: { ...d, kind: e.target.value as PrinterKind } })}>
                {KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
              <input className="flex-1 rounded border border-border p-1" placeholder="192.168.0.8:9100" value={d.address} onChange={(e) => setDraft({ ...draft, [name]: { ...d, address: e.target.value } })} />
              <button onClick={() => void saveRoute(name)} className="rounded bg-brown-btn px-2 py-1 text-xs text-white">Save</button>
              {saved && <button onClick={() => insertTestPrint(name).catch((e) => setError(e.message))} className="rounded border border-border px-2 py-1 text-xs">Test print</button>}
              {saved && <button onClick={() => void removeRoute(name)} className="text-xs text-red-700 underline">Remove</button>}
            </div>
          )
        })}
      </section>

      {card && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40" onClick={() => setCard(null)}>
          <div className="rounded-2xl bg-white p-6 text-center" onClick={(e) => e.stopPropagation()}>
            <div className="text-3xl font-semibold">Table {card.table.label}</div>
            <img src={card.png} alt={`QR for ${card.table.label}`} className="mx-auto my-3 h-80 w-80" />
            <div className="text-xs text-brown-muted">Scan to order · {card.url}</div>
            <button className="mt-3 rounded border border-border px-3 py-1 text-sm" onClick={() => window.print()}>Print this card</button>
          </div>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 7: Route.** In `src/App.tsx` add, next to `/pos`:

```tsx
<Route path="/pos/settings" element={<ProtectedRoute requireCap="access_settings"><AppLayout><PosSettingsPage /></AppLayout></ProtectedRoute>} />
```

- [ ] **Step 8: Gates.** `npx tsc -b` — no output; `npx vitest run src/features/pos` — PASS. In the browser `/pos/settings`: ten tables listed; **Show QR card** for T1 shows a QR whose text is `http://localhost:5174/qr/?t=<token>`; **Add table** `T11` appears; **Remove** hides it (`is_active = false` in the DB); Bar and Kitchen show `agent · 192.168.0.8:9100`; changing Kitchen's address and **Save** updates the row.

- [ ] **Step 9: Commit**

```bash
git add package.json package-lock.json src/features/pos/order/qrLink.ts src/features/pos/order/qrLink.test.ts src/features/pos/order/PosSettingsPage.tsx src/App.tsx
git commit -m "feat(pos): tables & printers settings with QR cards

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Customer QR page — second Vite entry at `/t/<token>`

**Files:**
- Create: `qr/index.html`, `src/qr/main.tsx`, `src/qr/qrClient.ts`, `src/qr/qrState.ts`, `src/qr/qrState.test.ts`, `src/qr/QrApp.tsx`
- Modify: `vite.config.ts` (two inputs), `vercel.json` (rewrite), `tailwind.config.js` (content glob)

**Interfaces:**
- Consumes: RPCs `qr_menu`, `qr_table_state`, `place_table_order` (Task 2); `cart.ts` + `LineSheet.tsx` (Tasks 4, 8) — nothing else from `src/features`.
- Produces: the customer page. `qrState.ts`: `tokenFromLocation(pathname: string, search: string): string | null`; `QrState` reducer helpers `addLine`, `replaceLine`, `removeLine`.

- [ ] **Step 1: Failing test**

```ts
// src/qr/qrState.test.ts
import { describe, it, expect } from 'vitest'
import { tokenFromLocation, addLine, replaceLine, removeLine } from './qrState'

describe('tokenFromLocation', () => {
  it('reads /t/<token> in production and ?t= under the dev server', () => {
    expect(tokenFromLocation('/t/abc123', '')).toBe('abc123')
    expect(tokenFromLocation('/qr/', '?t=abc123')).toBe('abc123')
    expect(tokenFromLocation('/qr/', '')).toBeNull()
    expect(tokenFromLocation('/t/', '')).toBeNull()
  })
})

describe('cart helpers', () => {
  const a = { productId: 'p', variantId: 'v', qty: 1, note: null, optionIds: [] }
  it('append, replace by index, remove by index — never mutating', () => {
    const one = addLine([], a)
    const two = addLine(one, { ...a, qty: 2 })
    expect(one).toHaveLength(1)
    expect(replaceLine(two, 0, { ...a, qty: 5 })[0].qty).toBe(5)
    expect(removeLine(two, 0)).toEqual([{ ...a, qty: 2 }])
    expect(two).toHaveLength(2)
  })
})
```

- [ ] **Step 2: Run to verify it fails.** `npx vitest run src/qr` — FAIL.

- [ ] **Step 3: Implement the pure part**

```ts
// src/qr/qrState.ts
import type { OrderLine } from '../features/pos/order/cart'

/** /t/<token> is what the printed QR card carries (vercel rewrite); the Vite
 *  dev server has no rewrite, so there the page is /qr/?t=<token>. */
export function tokenFromLocation(pathname: string, search: string): string | null {
  const m = pathname.match(/^\/t\/([A-Za-z0-9]+)\/?$/)
  if (m) return m[1]
  const t = new URLSearchParams(search).get('t')
  return t && /^[A-Za-z0-9]+$/.test(t) ? t : null
}

export const addLine = (lines: OrderLine[], line: OrderLine): OrderLine[] => [...lines, line]
export const replaceLine = (lines: OrderLine[], i: number, line: OrderLine): OrderLine[] => lines.map((l, k) => (k === i ? line : l))
export const removeLine = (lines: OrderLine[], i: number): OrderLine[] => lines.filter((_, k) => k !== i)
```

- [ ] **Step 4: Run the test.** PASS.

- [ ] **Step 5: Client, entry and app**

```ts
// src/qr/qrClient.ts
import { createClient } from '@supabase/supabase-js'

/** The customer page is anonymous: no session is ever stored, so a phone that
 *  once signed in to the staff app cannot leak its JWT into these calls. */
export const qrClient = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string,
  { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } },
)
```

```html
<!-- qr/index.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0" />
    <title>Order — Craft Cafe</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/qr/main.tsx"></script>
  </body>
</html>
```

```tsx
// src/qr/main.tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import QrApp from './QrApp'

createRoot(document.getElementById('root')!).render(<StrictMode><QrApp /></StrictMode>)
```

```tsx
// src/qr/QrApp.tsx
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { qrClient } from './qrClient'
import { tokenFromLocation, addLine, replaceLine, removeLine } from './qrState'
import {
  cartKey, cartSubtotalSen, findProduct, formatSen, lineLabel, linePriceSen, posMenuFromQr,
  type OrderLine, type PosMenu, type PosProduct, type QrMenuJson,
} from '../features/pos/order/cart'
import LineSheet from '../features/pos/order/LineSheet'

interface TableState {
  tableLabel: string
  billNo: string | null
  pax: number | null
  items: { name: string; qty: number; unitPriceSen: number; mods: string[]; note: string | null; voided: boolean }[]
  subtotalSen: number
}
type Screen = { kind: 'loading' } | { kind: 'invalid' } | { kind: 'ready'; info: QrMenuJson; menu: PosMenu }

export default function QrApp() {
  const token = tokenFromLocation(window.location.pathname, window.location.search)
  const [screen, setScreen] = useState<Screen>({ kind: 'loading' })
  const [state, setState] = useState<TableState | null>(null)
  const [lines, setLines] = useState<OrderLine[]>([])
  const [sheet, setSheet] = useState<{ product: PosProduct; index: number | null } | null>(null)
  const [pax, setPax] = useState('')
  const [category, setCategory] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [placed, setPlaced] = useState(false)
  const pending = useRef<{ id: string; key: string } | null>(null)   // one client_order_id per distinct cart

  const loadState = async () => {
    const { data } = await qrClient.rpc('qr_table_state', { p_token: token })
    if (data) setState(data as TableState)
  }
  useEffect(() => {
    if (!token) { setScreen({ kind: 'invalid' }); return }
    qrClient.rpc('qr_menu', { p_token: token }).then(({ data, error }) => {
      if (error || !data) { setScreen({ kind: 'invalid' }); return }
      const info = data as QrMenuJson
      setScreen({ kind: 'ready', info, menu: posMenuFromQr(info) })
      setCategory(info.categories[0]?.name ?? null)
      void loadState()
    })
  }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  if (screen.kind === 'loading') return <Shell><p className="p-6 text-center text-brown-muted">Loading menu…</p></Shell>
  if (screen.kind === 'invalid') return <Shell><p className="p-6 text-center">This table code is not valid. Please order at the counter.</p></Shell>
  const { info, menu } = screen
  if (info.paused) return <Shell title={`Table ${info.tableLabel}`}><p className="p-6 text-center">Ordering from this table is paused. Please order at the counter.</p></Shell>

  const needsPax = info.needsPax && !state?.pax
  const subtotal = cartSubtotalSen(menu, lines)

  const place = async () => {
    if (lines.length === 0 || sending) return
    const paxNum = needsPax ? Number(pax) : null
    if (needsPax && (!Number.isInteger(paxNum) || (paxNum as number) < 1 || (paxNum as number) > 99)) { setError('How many people are at the table? (1–99)'); return }
    const key = cartKey(lines)
    if (!pending.current || pending.current.key !== key) pending.current = { id: crypto.randomUUID(), key }
    setSending(true); setError(null)
    try {
      const { error } = await qrClient.rpc('place_table_order', { p_token: token, p_pax: paxNum, p_items: lines, p_client_order_id: pending.current.id })
      if (error) throw new Error(error.message)
      pending.current = null
      setLines([]); setPlaced(true)
      await loadState()
    } catch (e) {
      setError(`Not sent: ${e instanceof Error ? e.message : String(e)} — tap Place order to try again.`)
    } finally { setSending(false) }
  }

  const products = menu.categories.find((c) => c.name === category)?.products ?? []
  return (
    <Shell title={`Table ${info.tableLabel}`}>
      {placed && (
        <div className="m-3 rounded-xl bg-green-50 p-3 text-sm text-green-800">
          Order placed — it is on its way. You can add more below.
        </div>
      )}
      {state && state.items.length > 0 && (
        <details className="m-3 rounded-xl border border-border bg-card p-3 text-sm">
          <summary>Ordered so far · {formatSen(state.subtotalSen)}</summary>
          {state.items.map((i, k) => (
            <div key={k} className={`flex justify-between py-1 ${i.voided ? 'line-through opacity-50' : ''}`}>
              <span>{i.qty} × {i.name}{i.mods.length > 0 && <span className="text-brown-muted"> · {i.mods.join(', ')}</span>}</span>
              <span>{formatSen(i.unitPriceSen * i.qty)}</span>
            </div>
          ))}
        </details>
      )}
      <div className="flex gap-1 overflow-x-auto px-3 py-2">
        {menu.categories.map((c) => (
          <button key={c.name} onClick={() => setCategory(c.name)}
            className={`whitespace-nowrap rounded-full px-3 py-1 text-sm ${category === c.name ? 'bg-brown-btn text-white' : 'border border-border bg-card'}`}>{c.name}</button>
        ))}
      </div>
      <div className="space-y-2 px-3 pb-40">
        {products.map((p) => (
          <button key={p.id} disabled={p.soldOut} onClick={() => setSheet({ product: p, index: null })}
            className="flex w-full items-start justify-between rounded-xl border border-border bg-card p-3 text-left disabled:opacity-50">
            <div>
              <div className="font-medium">{p.name}{p.soldOut && <span className="ml-2 text-xs text-red-700">Sold out</span>}</div>
              {p.description && <div className="text-xs text-brown-muted">{p.description}</div>}
            </div>
            <div className="text-sm">{p.variants.length > 1 ? `from ${formatSen(Math.min(...p.variants.map((v) => v.priceSen)))}` : formatSen(p.variants[0].priceSen)}</div>
          </button>
        ))}
      </div>

      <div className="fixed inset-x-0 bottom-0 border-t border-border bg-card p-3 text-sm shadow-lg">
        {lines.map((l, i) => {
          const p = findProduct(menu, l.productId)
          if (!p) return null
          const { name, mods } = lineLabel(p, l)
          return (
            <div key={i} className="flex justify-between py-1">
              <button className="text-left" onClick={() => setSheet({ product: p, index: i })}>
                {l.qty} × {name}{mods.length > 0 && <span className="text-brown-muted"> · {mods.join(', ')}</span>}
              </button>
              <span>{formatSen((linePriceSen(p, l) ?? 0) * l.qty)} <button className="ml-2 text-red-700" onClick={() => setLines(removeLine(lines, i))}>✕</button></span>
            </div>
          )
        })}
        {needsPax && lines.length > 0 && (
          <label className="my-1 block">How many people? <input inputMode="numeric" className="ml-2 w-16 rounded border border-border p-1" value={pax} onChange={(e) => setPax(e.target.value)} /></label>
        )}
        {error && <p className="my-1 text-red-700">{error}</p>}
        <button disabled={lines.length === 0 || sending} onClick={() => void place()}
          className="mt-1 w-full rounded-xl bg-brown-btn py-3 text-white disabled:opacity-40">
          {sending ? 'Sending…' : lines.length === 0 ? 'Tap an item to start' : `Place order · ${formatSen(subtotal)}`}
        </button>
      </div>

      {sheet && (
        <LineSheet product={sheet.product} initial={sheet.index === null ? undefined : lines[sheet.index]}
          onCancel={() => setSheet(null)}
          onDone={(line) => { setLines(sheet.index === null ? addLine(lines, line) : replaceLine(lines, sheet.index, line)); setSheet(null); setPlaced(false) }} />
      )}
    </Shell>
  )
}

function Shell({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="min-h-screen bg-cream">
      <header className="bg-brown-header px-4 py-3 text-white">
        <div className="text-xs opacity-80">Craft Cafe</div>
        <div className="text-lg font-semibold">{title ?? 'Order'}</div>
      </header>
      {children}
    </div>
  )
}
```

- [ ] **Step 6: Build config.** `vite.config.ts` — add a `build` key (keep the rest):

```ts
import { resolve } from 'node:path'
…
export default defineConfig({
  plugins: [react(), ...(process.env.HTTPS === '1' ? [basicSsl()] : [])],
  server: { port: Number(process.env.PORT) || 5173 },
  build: {
    rollupOptions: {
      input: { main: resolve(__dirname, 'index.html'), qr: resolve(__dirname, 'qr/index.html') },
    },
  },
})
```

`vercel.json` — the `/t/*` rewrite must come before the catch-all:

```json
{
  "rewrites": [
    { "source": "/t/(.*)", "destination": "/qr/index.html" },
    { "source": "/(.*)", "destination": "/" }
  ]
}
```

`tailwind.config.js` — `content: ['./index.html', './qr/index.html', './src/**/*.{js,ts,jsx,tsx}'],`.

- [ ] **Step 7: Gates.** `npx tsc -b` — no output. `npx vitest run src/qr src/features/pos` — PASS. `npm run build` — Expected: `dist/index.html` and `dist/qr/index.html` both exist (`ls dist/qr`). With the dev server running, open `http://localhost:5174/qr/?t=<T1's token>` (token from `select qr_token from dining_tables where label = 'T1'`): the header reads `Table T1`, categories and products render, tapping one opens the sheet, **Place order** asks for guests, then shows "Order placed" and the "Ordered so far" list; the POS `/pos` tab shows T1 as **New order** within 2 s. `http://localhost:5174/qr/?t=nope` → "This table code is not valid".

- [ ] **Step 8: Commit**

```bash
git add qr/index.html src/qr vite.config.ts vercel.json tailwind.config.js
git commit -m "feat(qr): customer ordering page at /t/<token> — anonymous client, server-priced orders

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 12: Print agent on the real tables, spike removal, navigation

**Files:**
- Modify: `tools/print-agent/agent.ts`, `tools/print-agent/.env.example`
- Move: `src/features/pos/spike/guard.ts` → `src/features/pos/guard.ts` (+ `guard.test.ts`)
- Delete: `src/features/pos/spike/` (all files), `spike/pos.html`, `spike/qr.html`
- Modify: `src/shared/lib/nav.ts`, `src/shared/lib/nav.test.ts`, `src/shared/components/Sidebar.tsx`

**Interfaces:**
- Consumes: Task 2 RPC names; `print_routes` / `print_jobs` columns (Task 1).
- Produces: an agent that prints every `agent`-kind route of every branch (one shop Mac per shop; the Demo has one).

- [ ] **Step 1: Re-point the agent.** In `tools/print-agent/agent.ts` make exactly these replacements:
  - header comment `// POS spike print agent` → `// Craft POS print agent — prints print_jobs for routes of kind 'agent'`
  - `import { assertDevDatabase } from '../../src/features/pos/spike/guard.ts'` → `'../../src/features/pos/guard.ts'`
  - route discovery: `.from('spike_print_routes').select('route, address').eq('kind', 'agent')` → `.from('print_routes').select('name, address').eq('kind', 'agent')`, and the map builder reads `r.name` instead of `r.route`
  - `.from('spike_print_jobs')` (both places) → `.from('print_jobs')`
  - `rpc('spike_claim_print_job', …)` → `rpc('claim_print_job', …)`; `rpc('spike_finish_print_job', …)` → `rpc('finish_print_job', …)`
  - `supabase.channel('print-agent')` → ``supabase.channel(`print-agent-${crypto.randomUUID()}`)``
  - the Realtime `table: 'spike_print_jobs'` → `table: 'print_jobs'`
  - In `.env.example`: `AGENT_EMAIL=pos-spike@craftale.test` → `AGENT_EMAIL=<a staff login of the shop, e.g. the dev test login>` and `TICKET_COLS=42` → `TICKET_COLS=48   # measured on the ZyWell ZY301`
- [ ] **Step 2: Move the guard.** `git mv src/features/pos/spike/guard.ts src/features/pos/guard.ts`. Create `src/features/pos/guard.test.ts` by moving the two `assertDevDatabase` cases out of `src/features/pos/spike/latency.test.ts` verbatim (import from `./guard`).
- [ ] **Step 3: Delete the spike.** `git rm -r src/features/pos/spike spike`. Run `grep -rn "pos/spike\|spike_" src tools --include=*.ts --include=*.tsx` — Expected: no output.
- [ ] **Step 4: Navigation.** In `nav.ts` insert before the `menu` leaf: `{ id: 'pos', label: 'POS', to: '/pos', activePaths: ['/pos'] },` (no cap: any staff member). In `Sidebar.tsx` add `Store` to the lucide import and `pos: Store,` to the icon map. In `nav.test.ts` update the three expectations: `['profile', 'time-pay']` → `['profile', 'time-pay', 'pos']` (two places) and `['profile', 'time-pay', 'menu', 'settings']` → `['profile', 'time-pay', 'pos', 'menu', 'settings']`.
- [ ] **Step 5: Gates.** `npx tsc -b` — no output. `npx vitest run` — all pass. Agent dry run with the printer off the network is not possible; instead `node --env-file=tools/print-agent/.env --check tools/print-agent/agent.ts` — Expected: exit 0 (syntax), and starting it (`node --env-file=tools/print-agent/.env tools/print-agent/agent.ts`) logs `routes: Bar, Kitchen` then `realtime: SUBSCRIBED` (the dev test login's branch is Demo; Ctrl-C after that).
- [ ] **Step 6 (controller, dev dashboard):** run the body of `supabase/spike-2026-10-22-pos-phase0-drop.sql` **without its guard block** (the guard refuses wherever `public.staff` exists, which dev now has): the eight `drop function if exists …` lines and the `drop table if exists … cascade` statement. Expected: Success. Then `select count(*) from pg_tables where tablename like 'spike_%'` → `0`.
- [ ] **Step 7: Commit**

```bash
git add -A tools/print-agent src/features/pos src/shared/lib/nav.ts src/shared/lib/nav.test.ts src/shared/components/Sidebar.tsx spike
git commit -m "feat(pos): print agent on the real print_jobs; remove the Phase 0 spike; POS in the sidebar

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 13: On-site run on dev — counter and QR orders print on the ZY301 (controller + user)

No code. Done with the user at the shop (or anywhere the ZY301 is reachable at `192.168.0.8`), the same way Phase 0 ran.

- [ ] **Step 1: Dev server on the LAN.** Add to the MAIN checkout's `.claude/launch.json` an entry `pos-dev-lan`: `sh -c "cd /Users/USER/Desktop/Craft_OS/.claude/worktrees/pos-demo && npx vite --host 0.0.0.0 --port 5174 --strictPort"`, port 5174. Start it; note the Mac's LAN IP (`ipconfig getifaddr en0`).
- [ ] **Step 2: Agent.** `node --env-file=tools/print-agent/.env tools/print-agent/agent.ts` in a terminal tab; expect `routes: Bar, Kitchen` and `realtime: SUBSCRIBED`.
- [ ] **Step 3: Settings.** User signs in on the iPad at `http://<mac-ip>:5174/login`, opens **POS → Tables & printers**, presses **Test print** for Bar → a `TEST01` ticket prints within 2 s.
- [ ] **Step 4: Counter order.** `/pos` → `T1` → **New order** → `Coffee Latte` COLD + Oat milk, qty 2, note `less ice` → Guests 2 → **Send order**. Expected: Bar ticket `Table: T1 / Order: <bill_no>/1 (COUNTER)` with `2 x Coffee Latte (COLD)`, `    + Oat milk`, `    * less ice`; if Oat milk's add-on product has route Kitchen, a Kitchen ticket `2 x Oat milk / * for Coffee Latte (COLD)` too. T1 turns amber.
- [ ] **Step 5: QR order.** On a phone on the shop Wi-Fi open T2's QR card link (`http://<mac-ip>:5174/qr/?t=…`), order one item, enter guests → "Order placed"; the iPad shows T2 as **New order** within 2 s and the ticket prints `(QR)`. Tap T2 → the mark clears, the bill lists the item. Order a second item from the phone → it joins the same bill (`/2`).
- [ ] **Step 6: Controls.** iPad: T2 → **Pause QR** → phone reload → "Ordering from this table is paused". Resume. Order pad → **Sold out…** → tap `Coffee Latte` → phone reload shows it greyed "Sold out"; un-mark it.
- [ ] **Step 7: Offline.** iPad Wi-Fi off → counter order for T3 → pad shows "1 order waiting to send" → Wi-Fi on → within 15 s the ticket prints once and T3 shows the bill. `select count(*) from orders where client_order_id = '<id from the pad's IndexedDB>'` is not needed: `select order_no, count(*) from orders group by 1 having count(*) > 1` → no rows.
- [ ] **Step 8: Record.** Ledger line with the date, what printed, timings, and anything that failed; failures become fix tasks before the final review.

---

## Execution notes for the controller

- Tasks 1–3 are SQL and land on dev together (Task 3 Step 4). Tasks 4–12 each end with `npx tsc -b` and the relevant `vitest` run. Task 13 needs the printer.
- Minor findings carried over from Sub-plan 1 (ledger `.superpowers/sdd/progress.md`) stay there; the final whole-branch review of this sub-plan triages both lists.
- When this sub-plan closes, the merge prerequisite from Sub-plan 1 grows: `migration-2026-10-23-pos-ordering.sql` and `-fn.sql` must run on prod before the first deploy from main that carries `/pos`, and the dev seed must **not**.
